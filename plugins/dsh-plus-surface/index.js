// dsh-plus-surface — host 半（dsh 进程内，Node）
//
// 职责：把会话事实写成一份小 JSON（$DSH_HOME/dsh-plus/bridge.json），供 DSH+ 壳消费。
// 事实分两层：
//   - host 独写的进程级真相：status / runningSince / finishedAt（来自 agent/created|status|disposed）
//     + completed（完成未看：依各 client 的选中上报推导，结束瞬间无人选中 = 未看，选中即清）
//   - client 透传的标量快照：pendingInteraction / title / cwd / …（client 半整体上报，这里只合并）
// 壳的 recipe 只做纯字段匹配，不再内建任何业务语义（含「已完成未看」）。
//
// 只认顶层会话（排除 subagent）：角标语义是「对话数」，不是「agent 数」。
//
// 私有面脆弱点登记（平台升级先核对这些）：
//   1. Cordis 事件 agent/created | agent/status | agent/disposed
//      （@deepseek-ai/dsh-agent runtime-types.ts 的 Events 声明）
//   2. agent.session.header.origin/parentSession（isTopLevel 判定用；@deepseek-ai/dsh-session）
//   3. ctx.connection.rpc.handle 自有通道 + ctx.webServer
//      （@deepseek-ai/dsh-client-connection HostConnectionService；
//      0.1.5 起 handle 内部经 owner.webServer.register 挂路由，调用当下 webServer
//      必须已在同一上下文可用——故 connection 与 webServer 必须同一个 inject 等待，
//      否则 TypeError 连坐拆除整个 inject 纤维，事件监听/路由全灭且无 stdout 报错）
//   4. ctx.webServer.register({ kind, path, handler })
//      （@deepseek-ai/dsh-host-webserver WebServer 服务；远端壳的 HTTP 事实出口用）
//   5. ctx.connection.authenticatedUrl(baseUrl)
//      （@deepseek-ai/dsh-client-connection HostConnectionHandle；0.1.2+ 公开 API，
//        GET /dsh-plus-surface/launch.json 只对环回吐 launch token，给壳自动换证）

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plus-surface'
export const inject = ['skills']

/** client 半上报通道（自有 prefix，不占共享 /api 的独占 interceptor） */
const CHANNEL = '/dsh-plus-surface'
/** idle 会话最多保留条数（running 永远全保留），防桥文件膨胀 */
const MAX_TRACKED_IDLE = 30
/** 写盘防抖：一轮对话的事件常成串到达 */
const WRITE_DEBOUNCE_MS = 200

/** resolveDshHome 的零依赖镜像：$DSH_HOME > ~/.dsh */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), '.dsh'))
}

/** 是否顶层会话（subagent 不算一条「对话」） */
function isTopLevel(agent) {
  const header = agent.session?.header
  return header != null && header.origin !== 'subagent' && header.parentSession === undefined
}

// ---------- Skill 发现：只注册这一个 bundled skill（rank 600）----------
// 用户覆盖不在这儿扫：内置 dsh-skill-filesystem 已经用 rank 400 扫 ~/.dsh/skills。
// 会话角标、HTTP 灯等场景全部写在这份 SKILL.md 里；机器模板是各目录 recipe.json，不是新 skill。
const PROVIDER_NAME = 'dsh-plus-bundled-skill'
const SKILL_DIR = new URL('./skills/dsh-plus-surface/', import.meta.url)
const SKILL_LOCATOR = new URL('./SKILL.md', SKILL_DIR)
const INVOCATION = { modelInvocable: true, userInvocable: true }
const BUNDLED_SKILL_RANK = 600

/** 去掉首部 frontmatter，正文原样给模型。 */
function stripFrontmatter(source) {
  if (!source.startsWith('---\n')) return source
  const end = source.indexOf('\n---\n', 4)
  return end === -1 ? source : source.slice(end + 5)
}

/** 从 SKILL.md 头取 name / description；没有就用目录名。支持 description: >- 折行。 */
function readHead(raw, fallbackName) {
  let name = fallbackName
  let description = ''
  if (!raw.startsWith('---\n')) return { name, description }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return { name, description }
  const lines = raw.slice(4, end).split('\n')
  for (let i = 0; i < lines.length; ) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/)
    i++
    if (!m) continue
    let v = m[2].trim()
    if (v === '>-' || v === '>' || v === '|' || v === '|-') {
      const parts = []
      while (i < lines.length && /^\s+/.test(lines[i])) {
        parts.push(lines[i].trim())
        i++
      }
      v = parts.filter(Boolean).join(' ')
    } else {
      v = v.replace(/^['"]|['"]$/g, '')
    }
    if (m[1] === 'name' && v) name = v
    if (m[1] === 'description' && v) description = v
  }
  return { name, description }
}

function bundledCandidates() {
  let raw
  try { raw = readFileSync(SKILL_LOCATOR, 'utf8') } catch { return [] }
  const { name, description } = readHead(raw, 'dsh-plus-surface')
  return [{
    name,
    description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_LOCATOR,
  }]
}

function createSkillProvider() {
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(bundledCandidates()),
    async get(selected) {
      const found = bundledCandidates().find((c) => c.name === selected?.name)
      if (!found) return undefined
      const source = readFileSync(found.locator, 'utf8')
      return {
        name: found.name,
        description: found.description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: found.resourceBase,
        path: fileURLToPath(found.locator),
        content: stripFrontmatter(source),
      }
    },
  }
}

/** 环回地址判定：端口映射在对端本机落地，插件看到的就是这类地址。不认 X-Forwarded-For。 */
export function isLoopbackAddress(addr) {
  const ip = String(addr || '').trim().toLowerCase()
  if (!ip) return false
  if (ip.startsWith('::ffff:')) return isLoopbackAddress(ip.slice(7))
  if (ip === '::1' || ip === 'localhost') return true
  return /^127(?:\.\d{1,3}){3}$/.test(ip)
}

/** connection.authenticatedUrl(...) → launch token；旧版无此方法或 URL 无 token → null。 */
export function tokenFromAuthenticatedUrl(href) {
  try {
    const t = new URL(href).searchParams.get('token')
    return t && t.trim() ? t : null
  } catch {
    return null
  }
}

export function apply(ctx) {
  // ① Skill 发现：只挂 dsh-plus-surface 这一份说明书，冷装即可见。
  // skills 用 inject 声明硬依赖（同 dsh-tabbit）；这个插件上下文里 get('skills') 拿不到。
  ctx.skills.registerProvider(() => createSkillProvider())
  // spawn 时 DSH 的 stdout 会被壳拼进 ~/.dsh-plus-dsh.log，用 console.log 让「provider 已注册」可观测
  const names = bundledCandidates().map((c) => c.name).join('、') || '（无）'
  console.log(`[dsh-plus-surface] skill provider 注册：${names}（rank ${BUNDLED_SKILL_RANK}）`)
  // 用户丢/改 ~/.dsh/skills 时，内置 skill-filesystem 的 chokidar 会发这个。
  // 壳侧 recipe-loader 有自己的 1s 轮询；这里留一个可观测钩子（诊断 / 后续接线用）。
  ctx.on('skills/change', () => {
    ctx.logger?.info?.('[dsh-plus-surface] skills/change：用户 skill 目录可能已变')
  })

  // 有 connection + webServer 服务 = 本进程是 dsh web 的 host；CLI 进程不产事实，
  // 避免 CLI / web 多进程写同一份桥文件。两者必须同一个 inject 等待：0.1.5 起
  // rpc.handle 内部立即经 owner.webServer.register 挂通道路由，webServer 后于
  // connection 就绪时，先触发的一半会在 handle 处抛 TypeError，cordis 连坐拆除
  // 整个纤维（已注册的事件监听同归于尽），且错误不进 stdout——曾致气泡全灭。
  ctx.inject(['connection', 'webServer'], (connCtx) => {
    const dir = join(dshHome(), 'dsh-plus')
    const file = join(dir, 'bridge.json')

    /** host 独写的进程级真相；client 透传的同名字段不允许覆盖。
     * completed 自选中上报改造后起由 host 推导（见 selectedBy），不再透传 client 的
     * 运行时实况——completedNotifications 是各 client 页面各自内存维护的，多客户端
     * （壳 webview + 浏览器 tab）下没选中的那个 client 会把 true 钉死在桥上。 */
    const HOST_CORE = new Set(['status', 'runningSince', 'finishedAt', 'bootstrapped', 'completed'])

    /** @type {Map<string, {status:'running'|'idle', runningSince:number|null, finishedAt:number|null,
     *   completed: boolean, cli: Record<string, string|number|boolean>}>} */
    const sessions = new Map()
    /** 各 client 的实时选中：sessionId -> Set<clientId>。completed 的唯一推导依据：
     * running→idle 沿那一刻没有任何 client 选中 = 完成未看（出红泡）；任一 client 之后
     * 在 idle 期选中即清。client 关页 best-effort 报 selected:false；没报成的残留最坏
     * 后果是下一轮完成漏一颗气泡（用户离开前正看着它），不会钉死。 */
    const selectedBy = new Map()
    let writeTimer = null

    // 启动时接续上一份桥文件：进程重启 = 当时 running 的会话被强制打断。
    // 「已完成未看」是 client 运行时实况（completed），重启后 client 会重新透传权威值；
    // 外力中断不该反复提醒，因此这里只保留进程级真相、丢弃 cli 快照（重启即清）：
    //   - running → idle（被打断）：finishedAt 记 now
    //   - 已结束：保留 finishedAt（供排序），cli 清空等 client 重传
    // 接续进来的会话统一标 bootstrapped：client 重连后可能把内存里残留的 completed:true
    // 再透传回来（气泡复活），recipe 侧按 bootstrapped 过滤，直到该会话下一轮 running 才解除。
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev && prev.version === 1 && typeof prev.sessions === 'object' && prev.sessions) {
        const now = Date.now()
        for (const [id, s] of Object.entries(prev.sessions)) {
          if (!s || typeof s !== 'object') continue
          if (s.status === 'running') {
            // 进程重启 = 当时 running 的会话被外力打断：记一次结束，不再出「已完成未看」
            sessions.set(id, { status: 'idle', runningSince: null, finishedAt: now, completed: false, bootstrapped: true, cli: {} })
          } else if (s.finishedAt) {
            // 保留结束时刻（供排序）；cli 实况丢弃，由 client 重新透传（重启不残留旧气泡）
            sessions.set(id, { status: 'idle', runningSince: null, finishedAt: s.finishedAt, completed: false, bootstrapped: true, cli: {} })
          }
        }
      }
    } catch { /* 无旧文件/解析失败：从空表开始 */ }

    function entryOf(agent) {
      const id = String(agent.id)
      let entry = sessions.get(id)
      if (!entry) {
        entry = { status: 'idle', runningSince: null, finishedAt: null, completed: false, bootstrapped: false, cli: {} }
        sessions.set(id, entry)
      }
      return entry
    }

    /** 当前事实表的可序列化形状：persist 写盘与 HTTP 出口共用同一份。 */
    function buildBody() {
      const all = [...sessions.entries()]
      const running = all.filter(([, s]) => s.status === 'running')
      const idle = all
        .filter(([, s]) => s.status !== 'running')
        .sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0))
        .slice(0, MAX_TRACKED_IDLE)
      return {
        version: 1,
        pid: process.pid,
        updatedAt: Date.now(),
        sessions: Object.fromEntries([...running, ...idle]),
      }
    }

    function persist() {
      if (writeTimer) return
      writeTimer = setTimeout(() => {
        writeTimer = null
        try {
          const body = buildBody()
          mkdirSync(dir, { recursive: true })
          // 原子写：tmp + rename。Windows 上 rename 不能覆盖已存在的目标。
          const tmp = join(dir, `.bridge.${process.pid}.tmp`)
          writeFileSync(tmp, JSON.stringify(body))
          try {
            renameSync(tmp, file)
          } catch {
            try { unlinkSync(file) } catch { /* dest 不存在 */ }
            renameSync(tmp, file)
          }
        } catch (err) {
          connCtx.logger.warn(`[dsh-plus-surface] 写桥文件失败: ${String(err)}`)
        }
      }, WRITE_DEBOUNCE_MS)
      writeTimer.unref?.() // 壳/CLI 常驻时不挡进程退出
    }

    connCtx.on('agent/created', ({ agent }) => {
      if (!isTopLevel(agent)) return
      entryOf(agent)
      persist()
    })

    persist() // 落盘启动接续的结果（被打断会话的 finishedAt）

    connCtx.on('agent/status', ({ agent, status }) => {
      if (!isTopLevel(agent)) return
      const entry = entryOf(agent)
      const now = Date.now()
      if (status === 'running') {
        // 开始/继续对话：清掉「已结束」事实——壳里的结束气泡随即提前消失
        entry.status = 'running'
        entry.runningSince = entry.runningSince ?? now
        entry.finishedAt = null
        entry.completed = false // 新一轮：重置未看标记
        entry.bootstrapped = false // 新一轮对话：解除「重启接续」标记，完成气泡恢复
      } else if (entry.status === 'running') {
        // 一轮对话结束（自然完成/取消/出错都算「不再进行」）
        entry.status = 'idle'
        entry.runningSince = null
        entry.finishedAt = now
        // 结束瞬间没有任何 client 选中 = 完成未看；有人正看着 = 已看（不出泡）
        entry.completed = !(selectedBy.get(String(agent.id))?.size > 0)
      }
      persist()
    })

    connCtx.on('agent/disposed', ({ agent }) => {
      if (!isTopLevel(agent)) return
      const id = String(agent.id)
      const entry = sessions.get(id)
      if (!entry) return
      selectedBy.delete(id)
      // 销毁后 client 半不会再透传该会话（行已从列表消失）：completed / pendingInteraction
      // 残留会让壳气泡永远点不掉——点开不了已删会话（sessions.open 抛错），也没人会再上报。
      // title/cwd 保留（正常结束气泡还要展示）；会话若只是「进程重排」稍后会由 client 重传补回。
      entry.completed = false
      delete entry.cli.pendingInteraction
      // 进行中就被销毁（会话被删/进程重排）：按结束记一笔，壳正常出按钮
      if (entry.status === 'running') {
        entry.status = 'idle'
        entry.runningSince = null
        entry.finishedAt = Date.now()
      }
      persist()
    })

    // client 半透传会话事实（整体替换 cli 快照；只收标量，字段消失即清）
    connCtx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
      if (endpoint !== 'sync') {
        return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${JSON.stringify(endpoint)}` } }
      }
      const id = typeof payload?.sessionId === 'string' ? payload.sessionId : null
      const entry = id ? sessions.get(id) : undefined
      // 只合并「已存在的顶层 entry」：不认识的 id（subagent 等）一律忽略，不写进桥
      if (!entry) return { ok: true, value: { accepted: false } }
      const clientId = typeof payload?.clientId === 'string' && payload.clientId ? payload.clientId : null
      const fields = payload?.fields
      // 选中态上报：completed 的唯一输入。idle 期被任一 client 选中 = 看过（清未看）。
      if (clientId && fields && typeof fields === 'object') {
        let set = selectedBy.get(id)
        if (fields.selected === true) {
          if (!set) { set = new Set(); selectedBy.set(id, set) }
          set.add(clientId)
          // idle 期被任一 client 选中 = 看过（清未看）；下方 cli 替换后的 persist 一并落盘
          if (entry.status === 'idle') entry.completed = false
        } else if (fields.selected === false && set) {
          // 显式 false = 该 client 取消选中（只摘自己那份，不清未看——看过就是看过）
          set.delete(clientId)
          if (!set.size) selectedBy.delete(id)
        }
      }
      const cli = {}
      if (fields && typeof fields === 'object') {
        for (const [k, v] of Object.entries(fields)) {
          if (HOST_CORE.has(k)) continue // 进程级真相只由 host 写
          if (k === 'selected') continue // 活信号，只喂 selectedBy，不进 cli 快照
          const t = typeof v
          if (t === 'string' || t === 'number' || t === 'boolean') cli[k] = v
        }
      }
      entry.cli = cli
      persist()
      return { ok: true, value: { accepted: true } }
    })

    connCtx.logger.info(`[dsh-plus-surface] 事实桥就绪 → ${file}`)

    // ② HTTP 只读事实出口（GET /dsh-plus-surface/bridge.json）：远端壳经端口映射拉取用，
    // 与 bridge.json 同一份内存事实（buildBody）。双出口常开、零配置——本地壳读文件、
    // 远端壳走 HTTP，选择权在壳不在插件。安全口径：只读、随 dsh web 的环回绑定，不开新端口。
    // webServer 服务不存在（非 web host）时此出口静默缺席，壳自动退到 session.list 轮询。
    // webServer 与 connection 同一 inject 等待就位（见上方注释），这里直接用，不再嵌套 inject。
    {
      // effect 绑插件生命周期：HMR/重载时路由随上下文自动摘除，避免重复注册抛错（同 dsh-client-connection 写法）
      connCtx.effect(() => connCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-plus-surface/bridge.json',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(buildBody()))
        },
      }), 'dsh-plus-surface: facts route')
      // 壳自动换证：0.1.2+ 无环回豁免，端口映射过来的实例壳拿不到 stdout 里的 token。
      // connection.authenticatedUrl 是公开 API；只对环回吐 token——能在对端本机连上
      // （含 SSH/端口映射在本机落地）≈ 本来就能读 stdout。LAN/WAN 仍走官方 token URL。
      connCtx.effect(() => connCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-plus-surface/launch.json',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          if (!isLoopbackAddress(req.socket?.remoteAddress)) {
            res.writeHead(404, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          const authUrl = typeof connCtx.connection.authenticatedUrl === 'function'
            ? connCtx.connection.authenticatedUrl('http://127.0.0.1/')
            : ''
          const token = tokenFromAuthenticatedUrl(authUrl)
          if (!token) {
            res.writeHead(404, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ token }))
        },
      }), 'dsh-plus-surface: launch route')
      connCtx.logger.info('[dsh-plus-surface] HTTP 事实出口就绪 → GET /dsh-plus-surface/bridge.json')
    }
  })
}
