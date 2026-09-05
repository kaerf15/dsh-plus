// DSH 会话桥（壳侧）：读取 dsh-plus-surface 插件写的事实（首选），
// 插件未装时降级为轮询 dsh web 的 session.list 自行推断。
//
// 原则：壳只收集事实，不派生视图。角标 / 气泡 / 看过即消失一律由 recipe 投影。
// 这里只做三件事：
//   ① 拿事实（本地文件 / HTTP 事实出口 / 降级轮询三条来源，归一成同一张事实表）
//   ② 把事实摊平给 recipe（cli 快照平铺 + host 核心字段兜底）
//   ③ 事实变化时发 'update'（adapter 再跑 recipe → Hub）
//
// 多连接：一个 dsh 类应用一个 DshBridge 实例（main.js 按 appId 持有 Map）。
//   - 本地 dsh：file 默认 ~/.dsh/dsh-plus/bridge.json（fs.watchFile，1s 感知）
//   - 远端 dsh（端口映射等）：file: null + factsUrl 指向插件的 HTTP 只读出口
//     （GET /dsh-plus-surface/bridge.json，1s 轮询）；插件缺席时自动退到 session.list 轮询
'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 事实文件 fs.watchFile 轮询间隔（watchFile 基于 stat，文件出现/消失都能感知） */
const WATCH_INTERVAL_MS = 1000
/** HTTP 事实出口（factsUrl）轮询间隔：与文件感知节拍对齐 */
const FACTS_INTERVAL_MS = 1000
/** 降级模式 session.list 轮询间隔 */
const POLL_INTERVAL_MS = 3000
/** 降级模式最多跟踪的结束会话数 */
const MAX_FINISHED_FALLBACK = 30

/** resolveDshHome 的零依赖镜像：$DSH_HOME > ~/.dsh（与插件侧保持一致） */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return path.resolve(fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.dsh'))
}

function bridgeFilePath() {
  return path.join(dshHome(), 'dsh-plus', 'bridge.json')
}

class DshBridge extends EventEmitter {
  /**
   * @param {{ baseUrl?: string, factsUrl?: string, file?: string|null,
   *   fetchFn?: Function, log?: (msg: string) => void }} opts
   *   baseUrl: dsh web 地址（降级轮询用；运行中可 setBaseUrl 更新）
   *   factsUrl: 插件 HTTP 事实出口（远端连接用；运行中可 setFactsUrl 更新）
   *   file: 事实文件路径；传 null 关闭文件来源（远端实例没有本地文件可读）
   *   fetchFn: 注入 fetch（测试用）
   */
  constructor({ baseUrl = '', factsUrl = '', file, fetchFn = null, log = console.log } = {}) {
    super()
    this.file = file === undefined ? bridgeFilePath() : file
    this.baseUrl = baseUrl
    this.factsUrl = factsUrl
    this.fetch = fetchFn || ((u, opts) => fetch(u, opts))
    this.log = log

    /** 归一事实表：id -> { status, runningSince, finishedAt, ...(cli 快照 或 降级平铺字段) } */
    this.facts = new Map()
    this.mode = 'off' // 'plugin' | 'polling' | 'off'
    /** 插件事实来自哪条通道：'file' | 'http'（失败回退时按通道判断要不要清空事实） */
    this.pluginVia = null
    this.lastEmitted = ''

    this.pollTimer = null
    this.factsTimer = null
    /** HTTP 事实拉取不重叠（慢端点下 setInterval 会叠发） */
    this.factsInFlight = false
    /** 0.1.2+ 鉴权 cookie 头（'name=value'）；空 = 不带。main.js 在拿到 launch token 后注入 */
    this.authHeader = ''
  }

  /** 注入鉴权 cookie（0.1.2+ 的 /api 降级轮询需要；事实出口不受闸门，带上也无害）。 */
  setAuthHeader(header) {
    const next = String(header || '')
    if (next === this.authHeader) return
    this.authHeader = next
    if (this.mode === 'polling') this.pollOnce() // 立即用新凭证补一次
  }

  start() {
    if (this.file) {
      this.readFile()
      fs.watchFile(this.file, { interval: WATCH_INTERVAL_MS }, () => this.readFile())
    }
    if (this.factsUrl) this.startFactsPolling()
    this.ensurePolling()
  }

  stop() {
    if (this.file) fs.unwatchFile(this.file)
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.factsTimer) { clearInterval(this.factsTimer); this.factsTimer = null }
  }

  setBaseUrl(url) {
    if (!url || url === this.baseUrl) return
    this.baseUrl = url
    if (this.mode === 'plugin') return // 插件在位，不用轮询
    if (!this.pollTimer) this.ensurePolling() // 尚未轮询（如 DSH 后装，start 时还没有 URL）：启动
    else this.pollOnce() // 已在轮询：立即用新地址补一次
  }

  /** 运行中接入/更新 HTTP 事实出口（探测到远端装了插件时由轮询升级为全保真）。 */
  setFactsUrl(url) {
    if (!url || url === this.factsUrl) return
    this.factsUrl = url
    if (!this.factsTimer) this.startFactsPolling()
    else this.pollFactsOnce() // 已在轮询：立即用新地址补一次
  }

  // ---------- 来源①：插件事实文件（本地） ----------
  readFile() {
    if (this.reading) return // 读盘不重叠；本次丢的更新下一个 watch 节拍（1s）自然补上
    this.reading = true
    fs.readFile(this.file, 'utf8', (err, raw) => {
      this.reading = false
      if (err) {
        if (this.mode === 'plugin' && this.pluginVia === 'file') {
          // 文件消失（插件被卸/DSH_HOME 变了）：清空事实，回到降级
          this.mode = 'off'
          this.pluginVia = null
          this.facts.clear()
          this.emitIfChanged()
        }
        this.ensurePolling()
        return
      }
      let body
      try { body = JSON.parse(raw) } catch { return } // 写盘中途的瞬时态，下轮再读
      if (!body || body.version !== 1 || typeof body.sessions !== 'object' || !body.sessions) return
      this.mode = 'plugin'
      this.pluginVia = 'file'
      this.stopPolling() // 插件在位就不轮询
      this.facts = new Map(Object.entries(body.sessions))
      if (process.env.DSH_BRIDGE_DEBUG === '1') {
        this.log(`[bridge] 读文件: ${this.facts.size} 条`)
      }
      this.emitIfChanged()
    })
  }

  // ---------- 来源②：插件 HTTP 事实出口（远端连接，如端口映射到另一台机器） ----------
  startFactsPolling() {
    if (this.factsTimer || !this.factsUrl) return
    this.pollFactsOnce()
    this.factsTimer = setInterval(() => this.pollFactsOnce(), FACTS_INTERVAL_MS)
    this.factsTimer.unref?.()
  }

  stopFactsPolling() {
    if (this.factsTimer) { clearInterval(this.factsTimer); this.factsTimer = null }
  }

  async pollFactsOnce() {
    // 不用 fetchJson 小件：这里的失败是两义的——连不上/非 2xx 要清事实退降级（插件被卸），
    // 而 200 但形状不对只是瞬时态要保事实。fetchJson 把两者合成 null，语义会变。
    if (!this.factsUrl || this.factsInFlight) return
    this.factsInFlight = true
    try {
      const res = await this.fetch(this.factsUrl, {
        headers: this.authHeader
          ? { accept: 'application/json', cookie: this.authHeader }
          : { accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      })
      if (!res || !res.ok) throw new Error(`http ${res && res.status}`)
      const body = await res.json()
      if (!body || body.version !== 1 || typeof body.sessions !== 'object' || !body.sessions) return
      this.mode = 'plugin'
      this.pluginVia = 'http'
      this.stopPolling() // 插件在位就不降级轮询
      this.facts = new Map(Object.entries(body.sessions))
      this.emitIfChanged()
    } catch {
      // 出口不可达（远端关机/隧道断开/插件被卸）：清空事实，回到降级
      if (this.mode === 'plugin' && this.pluginVia === 'http') {
        this.mode = 'off'
        this.pluginVia = null
        this.facts.clear()
        this.emitIfChanged()
      }
      this.ensurePolling()
    } finally {
      this.factsInFlight = false
    }
  }

  // ---------- 来源③：降级轮询 session.list ----------
  ensurePolling() {
    if (this.mode === 'plugin' || this.pollTimer || !this.baseUrl) return
    this.pollOnce()
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
  }

  async pollOnce() {
    if (this.mode === 'plugin' || !this.baseUrl) return
    let items
    try {
      const res = await this.fetch(new URL('/api/session.list', this.baseUrl), {
        method: 'POST',
        headers: this.authHeader
          ? { 'content-type': 'application/json', cookie: this.authHeader }
          : { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', method: 'session.list', rpcId: `bridge-${Date.now()}`, payload: {} }),
        signal: AbortSignal.timeout(2500),
      })
      const body = await res.json()
      if (!body?.result?.ok) return
      items = body.result.value.items
    } catch { return } // dsh web 不在：静默，下轮再来

    if (this.mode === 'plugin') return // 等待响应期间插件事实（文件/HTTP）已就位：降级结果必须让位

    this.mode = 'polling'
    const now = Date.now()
    const seenIds = new Set()

    for (const item of items) {
      const id = String(item.sessionId)
      seenIds.add(id)
      const prev = this.facts.get(id) ?? {
        status: 'idle', title: null, cwd: null, runningSince: null, finishedAt: null, completed: false,
      }
      const title = item.projections?.values?.title
      prev.title = typeof title === 'string' && title ? title : prev.title
      prev.cwd = typeof item.cwd === 'string' ? item.cwd : prev.cwd

      if (item.running) {
        prev.status = 'running'
        prev.runningSince = prev.runningSince ?? now
        prev.finishedAt = null
        prev.completed = false
      } else if (prev.status === 'running') {
        // running → 非 running 翻转：一轮对话结束（结束即未看，直到点气泡 markViewed）
        prev.status = 'idle'
        prev.runningSince = null
        prev.finishedAt = now
        prev.completed = true
      }
      this.facts.set(id, prev)
    }

    // 列表里消失的会话（被删除）：清掉事实
    for (const id of [...this.facts.keys()]) {
      if (!seenIds.has(id)) this.facts.delete(id)
    }
    // 降级表防膨胀
    const idle = [...this.facts.entries()].filter(([, s]) => s.status !== 'running')
    if (idle.length > MAX_FINISHED_FALLBACK) {
      idle.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      for (const [id] of idle.slice(0, idle.length - MAX_FINISHED_FALLBACK)) this.facts.delete(id)
    }
    this.emitIfChanged()
  }

  // ---------- 壳动作：点按钮 ----------
  /** 降级模式的「看过了」：点气泡跳转即消耗完成提醒；插件模式下 completed 由 host 依选中上报推导（点气泡会选中该会话），此处 no-op。 */
  markViewed(id) {
    if (this.mode === 'plugin') return
    const fact = this.facts.get(id)
    if (fact && fact.status !== 'running') {
      fact.completed = false
      this.emitIfChanged()
    }
  }

  // ---------- 摊平给 recipe ----------
  /** 事实表扁平化：host 核心字段（status/runningSince/finishedAt/completed）兜底，其余（cli 快照或降级平铺）原样展开。 */
  factsArray() {
    return [...this.facts.entries()].map(([id, s]) => ({
      sessionId: id,
      ...(s.cli && typeof s.cli === 'object' ? s.cli : s),
      status: s.status,
      runningSince: s.runningSince,
      finishedAt: s.finishedAt,
      // completed 自选中上报改造起是 host 推导的进程级真相，压过 cli 里可能的旧版本残留；
      // 降级轮询模式本来就是平铺字段（s.completed 即事实），这里只是同名重申。
      completed: s.completed === true,
      // host 标的「重启接续」会话：recipe 据此过滤，防止 client 重传残留 completed 复活气泡
      ...(s.bootstrapped ? { bootstrapped: true } : null),
    }))
  }

  emitIfChanged() {
    // 以整张事实表为口径：标题改了、看过了，recipe 都能跟上。
    // 视图有没有真变，由 Hub 按 Item 再 diff 一次，这里不二次过滤。
    const key = JSON.stringify({ mode: this.mode, facts: this.factsArray() })
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.emit('update')
  }
}

module.exports = { DshBridge, bridgeFilePath }
