// pi-dsh-plus-surface — DSH+ 显示面的 pi 侧事实插件（TUI 与 pi-web RPC 模式通用）
//
// 职责：把当前会话的可序列化事实写成一个分片文件，供 DSH+ 壳读目录合并出
// 进行中角标 / 完成气泡 / 点击跳回。判断逻辑（什么时候出角标/气泡）在壳的 recipe 里，
// 本插件只产事实，不知道泡泡、角标、颜色。
//
// 为什么是分片而不是单文件：pi-web 每个会话一个 pi 进程，每个扩展实例只看得见
// 自己这条会话——一个进程写一片（<factsDir>/<sessionId>.json），壳按目录合并，
// 天然没有多写者冲突。dsh 侧的「单 host 独写 bridge.json」只是「只有一个分片」的特例。
//
// 语义对齐 dsh-plus-surface：
//   - agent_start      → running（新一轮对话重新武装 completed）
//   - agent_settled    → idle + finishedAt + completed=true（结束即未看，壳点气泡清）
//   - agent_end 宽限兜底 → 老版 pi（如 @mariozechner 0.73.x）没有 agent_settled：
//     end 后 3s 内没紧跟新 agent_start（重试/压缩/续跑）就视为结束。新 pi 上 settled
//     紧跟 end 即发，主路不受影响；兜底定时器只在 settled 缺失的版本上真正生效。
//   - session_shutdown 时仍在 running → idle + finishedAt，completed=false（中断不提醒）
//   - 进程崩溃/强杀：不再有心跳，壳把 running 且心跳过期的片折算成「中断结束」
//   - resume/new/fork 重进会话（session_start）→ completed 归零：「重新点开过」即看过，
//     气泡提前消失——与 dsh 侧「选中即清」同语义，只是触发点从页面选中移到会话重进
//
// 私有面脆弱点登记（pi 升级先核对这些）：
//   1. 事件名与时机：session_start / agent_start / agent_end / agent_settled /
//      session_info_changed / session_shutdown（docs/extensions.md Events 章）
//      注意：agent_settled 是较后引入的事件，老版 pi（@mariozechner 0.73.x）没有，
//      靠 agent_end 宽限兜底——去掉兜底，老 pi 的片会永远卡在 running（心跳续命）
//   2. ctx.sessionManager.getSessionId()、ctx.cwd、pi.getSessionName()
//   3. PI_CODING_AGENT_DIR（默认 ~/.pi/agent；事实目录取其父级 ~/.pi/dsh-plus/facts）
//   4. 伴生出口 serve-facts.mjs 的路由与端口约定（/pi-dsh-plus-surface/shards.json，
//      DSH_PLUS_FACTS_PORT 默认 3099）：pi-web 0.8.x 无扩展可挂载的 HTTP 面已核实，
//      pi-web 升级若提供挂载点，出口应迁回同源（对齐 dsh 侧 webServer.register）
//
// 明确不做：pendingInteraction（待交互）。pi 的确认/询问是各扩展自己的 ui 请求，
// 没有全局可观测的「等待用户」事件，v1 不采集。

import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 心跳间隔：壳把「running 且心跳过期」折算成中断结束 */
const HEARTBEAT_MS = 5000
/** 写盘防抖：一轮对话的事件常成串到达 */
const WRITE_DEBOUNCE_MS = 200
/** agent_end → 结束判定的宽限：等自动重试/压缩/续跑跟上新的 agent_start；老版 pi 无 agent_settled 时的唯一结束信号 */
const SETTLE_GRACE_MS = 3000
/** 事实出口端口（伴生 listener，serve-facts.mjs）：远端壳经映射端口拉全保真事实用 */
const EXIT_PORT = String(Number(process.env.DSH_PLUS_FACTS_PORT || 3099))

/** pi 主目录：$PI_CODING_AGENT_DIR 的父级 > ~/.pi（与壳侧 facts-dir 来源保持一致） */
function piHome() {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  return resolve(agentDir && agentDir.trim() ? dirname(agentDir.trim()) : join(homedir(), '.pi'))
}

const factsDir = join(piHome(), 'dsh-plus', 'facts')

// ---------- 事实出口（对应 dsh 侧 webServer.register 的 HTTP 只读出口） ----------
// dsh 插件的出口挂在 dsh web 的 webServer 上（同端口、零配置）；pi-web 没有可挂载的
// webServer、扩展也开不了同源端点，出口由本插件确保拉起的伴生 listener 提供
// （serve-facts.mjs：只读镜像分片目录，归并/折算/allowlist 全在壳，端口被占即静默退场）。
// 双出口常开、零配置的口径与 dsh 侧一致：文件给本机壳、HTTP 给远端壳，选择权在壳。
let exitStarted = false

function extensionDir() {
  try { if (typeof __dirname !== 'undefined' && __dirname) return __dirname } catch { /* ESM 下无 __dirname */ }
  try {
    const url = import.meta?.url
    if (url && url.startsWith('file:')) return dirname(fileURLToPath(url))
  } catch { /* 打包器内嵌等场景取不到：出口缺席，壳自动退回轮询 */ }
  return null
}

function ensureFactsExit() {
  if (exitStarted) return
  exitStarted = true
  const dir = extensionDir()
  if (!dir) return
  try {
    spawn(process.execPath, [join(dir, 'serve-facts.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DSH_PLUS_FACTS_DIR: factsDir, DSH_PLUS_FACTS_PORT: EXIT_PORT },
    }).unref?.() // 不挡 pi 进程退出；出口随分片目录常驻，服务其它 pi 进程与远端壳
  } catch { /* 拉不起来：出口缺席 → 壳自动退回轮询，不挡会话 */ }
}

/** sessionId 进文件名前的转码（id 理论上是 uuid，转码是防御性的）；壳侧 decodeURIComponent 还原 */
function shardFile(id) {
  return join(factsDir, `${encodeURIComponent(id)}.json`)
}

/** 原子写：tmp + rename。Windows 上 rename 不能覆盖已存在的目标，先 unlink 再 rename。 */
function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${process.pid}.${basename(file)}.tmp`)
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(file) } catch { /* dest 不存在 */ }
    renameSync(tmp, file)
  }
}

export default function piDshPlusSurface(pi) {
  /** 当前进程寄宿的会话 id；session_shutdown 后清空 */
  let sessionId = null
  /** 事实本体：全部可序列化标量 */
  let state = { status: 'idle', runningSince: null, finishedAt: null, title: '', cwd: '', completed: false }
  let writeTimer = null
  let heartbeatTimer = null
  let settleTimer = null

  function cancelSettle() {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  /** 一轮真结束：idle + finishedAt + completed=true（结束即未看，壳点气泡清） */
  function settle() {
    cancelSettle()
    if (!sessionId || state.status !== 'running') return
    state.status = 'idle'
    state.runningSince = null
    state.finishedAt = Date.now()
    state.completed = true // 结束即未看，壳 dispatch 跳转时清
    writeSoon()
  }

  function writeNow() {
    if (!sessionId) return
    const now = Date.now()
    const body = {
      protocol: 'dsh-plus.fact',
      version: 1,
      domain: 'pi.sessions',
      sessionId,
      pid: process.pid,
      heartbeat: now,
      updatedAt: now,
      session: {
        status: state.status,
        runningSince: state.runningSince,
        finishedAt: state.finishedAt,
        // 未命名会话用 cwd 末段兜底，保证气泡有可读标题
        title: state.title || (state.cwd ? basename(state.cwd) : '') || sessionId.slice(0, 8),
        cwd: state.cwd,
        completed: state.completed,
      },
    }
    try {
      atomicWrite(shardFile(sessionId), JSON.stringify(body))
    } catch { /* 写盘失败不挡对话：下一拍事件/心跳自然补上 */ }
  }

  function writeSoon() {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      writeNow()
    }, WRITE_DEBOUNCE_MS)
    writeTimer.unref?.()
  }

  function startHeartbeat() {
    if (heartbeatTimer) return
    // 只在 running 时写心跳：壳的过期折算只针对 running 片，idle 片不需要活心跳，
    // 空闲进程不白写盘（事件驱动的 writeSoon 已覆盖 idle 态变更）
    heartbeatTimer = setInterval(() => {
      if (state.status === 'running') writeNow()
    }, HEARTBEAT_MS)
    heartbeatTimer.unref?.() // 不挡进程退出
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    // new / resume / fork 都会重绑扩展实例状态：以新会话为准重建
    cancelSettle() // 上一个会话残留的结束兜底定时器不带进新会话
    ensureFactsExit() // 幂等：端口被占的子进程自己退场（对应 dsh 侧出口「注册即有」）
    sessionId = ctx.sessionManager?.getSessionId?.() ?? null
    state = {
      status: 'idle',
      runningSince: null,
      finishedAt: null,
      title: typeof pi.getSessionName === 'function' ? pi.getSessionName() ?? '' : '',
      cwd: ctx.cwd ?? '',
      completed: false,
    }
    startHeartbeat()
    writeSoon()
  })

  pi.on('agent_start', async (_event, ctx) => {
    // 新会话的 session 文件可能未落盘，session_start 时拿不到 id：运行沿再解析一次
    if (!sessionId) sessionId = ctx?.sessionManager?.getSessionId?.() ?? null
    cancelSettle() // end 后的重试/压缩/续跑跟上来了：不是结束
    if (!sessionId || state.status === 'running') return
    state.status = 'running'
    state.runningSince = Date.now()
    state.finishedAt = null
    state.completed = false // 新一轮：重新武装 completed
    writeSoon()
  })

  pi.on('agent_settled', async (_event, ctx) => {
    // agent_end 之后 pi 还可能自动重试/压缩/续跑；settled 才是「这轮真结束了」
    if (!sessionId) sessionId = ctx?.sessionManager?.getSessionId?.() ?? null
    settle()
  })

  pi.on('agent_end', async (_event, ctx) => {
    // 老版 pi（无 agent_settled）的结束兜底：宽限一拍，没紧跟新 agent_start 就视为结束。
    // 新版上 settled 会立刻触发 settle() 并取消本定时器，此路静默空转。
    if (!sessionId) sessionId = ctx?.sessionManager?.getSessionId?.() ?? null
    cancelSettle()
    settleTimer = setTimeout(settle, SETTLE_GRACE_MS)
    settleTimer.unref?.()
  })

  pi.on('session_info_changed', async (event) => {
    state.title = event?.name ?? ''
    writeSoon()
  })

  pi.on('session_shutdown', async () => {
    cancelSettle()
    if (sessionId && state.status === 'running') {
      // 会话被切走/进程收掉时仍在跑 = 中断：记一次结束，不出「已完成未看」
      state.status = 'idle'
      state.runningSince = null
      state.finishedAt = Date.now()
      state.completed = false
    }
    stopHeartbeat()
    writeNow() // 落最终态（防抖里可能还有未落的，直接同步写掉）
    sessionId = null
  })
}
