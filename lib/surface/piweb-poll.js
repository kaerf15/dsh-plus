// pi-web HTTP 轮询事实源（壳侧）：给「远端 / 未装 pi 插件的本机」pi-web 用。
// 轮询 `${baseUrl}/api/sessions`，按 runningSessionIds 的迁移推断会话状态：
//   - id 进入 runningSessionIds        → running（新一轮，completed 重新武装）
//   - id 离开 runningSessionIds        → idle + finishedAt + completed=true（结束即未看，看到即清）
//   - 从未 running 过的历史会话         → 不跟踪（/api/sessions 列全部历史，防气泡洪水）
//   - 从列表消失（会话被删）            → 清掉事实
// 对外与 DshBridge / FactsDirSource 同一鸭子类型：factsArray() / 'update' / markViewed / start / stop。
//
// 与分片目录源的分工：分片源（本机 + 装了 pi-dsh-plus-surface）事实更准（精确结束时刻、
// 会话命名事件、中断语义）；本源零依赖——只要 pi-web 的 HTTP 可达（含端口映射的远端）就能工作，
// 代价是 3s 轮询粒度、结束时刻=观测到迁移的时刻。
// 注意：runningSessionIds 里的 id 可能不在 sessions 列表里（新会话未落盘/分页），
// adopt 以两集并集为准，避免「正在跑」被误判成「已删除」。
'use strict'

const path = require('node:path')
const { FactTable } = require('./fact-table.js')
const { fetchJson } = require('./fetch-json.js')

/** 轮询间隔：与 bridge 降级轮询同节拍 */
const POLL_INTERVAL_MS = 3000

class PiWebPollSource extends FactTable {
  /**
   * @param {{ baseUrl: string, fetchFn?: Function, log?: (msg: string) => void }} opts
   *   baseUrl: pi-web origin（本机直连或映射端口均可）
   *   fetchFn: 注入 fetch（测试用）
   */
  constructor({ baseUrl, fetchFn = null, log = console.log } = {}) {
    super()
    this.baseUrl = baseUrl
    this.fetch = fetchFn || ((u, opts) => fetch(u, opts))
    this.inFlight = false
  }

  start() {
    return this.startPolling(POLL_INTERVAL_MS)
  }

  /** 基座 startPolling 的节拍钩子：一轮 = 一次 /api/sessions 轮询。 */
  tick() {
    return this.pollOnce()
  }

  async pollOnce() {
    if (this.inFlight) return // 慢端点下不叠发
    this.inFlight = true
    try {
      const body = await fetchJson(this.fetch, new URL('/api/sessions', this.baseUrl))
      if (!body || !Array.isArray(body.sessions) || !Array.isArray(body.runningSessionIds)) return
      this.adopt(body)
    } catch { /* pi-web 不可达/归并意外：静默，下轮再来（保留最后一帧事实，不制造假消失） */ } finally { this.inFlight = false }
  }

  /** 一轮响应 → 事实表迁移（纯函数式核心，测试直接喂）。 */
  adopt(body) {
    const now = Date.now()
    const running = new Set(body.runningSessionIds.map(String))

    // 候选 = 列表里的会话 ∪ 正在跑的 id：正在跑但尚未落盘/未入列表的会话也要跟踪，
    // 否则它会被下面的「消失」判定误清（角标闪烁）。元数据只有列表项能提供。
    const candidates = new Map() // id -> 列表项 | null
    for (const item of body.sessions) {
      if (!item || item.id === undefined || item.id === null) continue
      candidates.set(String(item.id), item)
    }
    for (const id of running) {
      if (!candidates.has(id)) candidates.set(id, null)
    }

    for (const [id, item] of candidates) {
      const isRunning = running.has(id)
      const prev = this.facts.get(id)
      // 历史洪水闸门：只跟踪「正在跑」或「已跟踪」的会话
      if (!prev && !isRunning) continue

      const entry = prev ?? {
        status: 'idle', runningSince: null, finishedAt: null, title: null, cwd: null, completed: false,
      }
      if (item) {
        if (typeof item.name === 'string' && item.name) entry.title = item.name
        if (typeof item.cwd === 'string' && item.cwd) entry.cwd = item.cwd
      }
      if (!entry.title) entry.title = entry.cwd ? path.basename(entry.cwd) : id.slice(0, 8)

      if (isRunning && entry.status !== 'running') {
        entry.status = 'running'
        entry.runningSince = now
        entry.finishedAt = null
        entry.completed = false // 新一轮：重新武装
        this.cleared.delete(id)
      } else if (!isRunning && entry.status === 'running') {
        // running → 非 running 迁移：一轮结束（结束即未看，直到点气泡 markViewed）
        entry.status = 'idle'
        entry.runningSince = null
        entry.finishedAt = now
        entry.completed = true
      }
      this.facts.set(id, entry)
    }

    this.clearVanished(candidates)
    this.capIdle()
    this.emitIfChanged()
  }
}

module.exports = { PiWebPollSource }
