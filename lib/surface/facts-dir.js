// 分片目录事实源（壳侧）：读 ~/.pi/dsh-plus/facts/*.json 合并成事实表。
// 供多进程应用（pi-web：每会话一个 pi 进程）使用——每个进程写自己一片，
// 这里扫描目录归并，对外与 DshBridge 同一鸭子类型：factsArray() / 'update' / markViewed / start / stop。
//
// 传输有两种，归并语义同一套（merge()，一字不差）：
//   - fs（默认）：扫本地分片目录——本机装了 pi 插件
//   - http（传 url）：读 pi-dsh-plus-surface 伴生出口 serve-facts.mjs 的 shards.json 镜像
//     （远端壳经映射端口拉全保真事实，对应 dsh 侧 DshBridge 的 factsUrl HTTP 模式；
//     出口只搬语义不加工：折算/allowlist/bootstrap 仍全在这里）
//
// 归并口径（与 dsh 侧语义对齐）：
//   - running 且心跳新鲜（<=15s）        → 进行中
//   - running 但心跳过期（进程死了/隧道断） → 折算「中断结束」：idle + finishedAt=心跳时刻，completed=false
//   - idle                               → 原样（completed 由壳的 markViewed 消耗，见 cleared 集）
//   - 接入当刻已 idle+completed 的历史片 → 当成看过（防打开瞬间倒出红气泡；只提醒接入之后的结束）
//   - origin 绑定后只投影该 pi-web /api/sessions 里的 id（TUI / 其它实例的分片不串台）
// completed 粘性清除：「看到即清」——壳观测应用页 URL 的 ?session=<id>（pi-web 选中会话的
// 官方深链）+ 前台态，点气泡只是其中一种触发；下一轮 running 沿重新武装。
// 与 dsh 插件的「选中即清」同一语义，只是触发源从 client 选中上报换成壳的页面观测。
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FactTable } = require('./fact-table.js')
const { fetchJson } = require('./fetch-json.js')

/** 目录扫描间隔：与 bridge 的文件/HTTP 感知节拍对齐 */
const SCAN_INTERVAL_MS = 1000
/** 心跳存活窗口：超过即认为写方进程已死 */
const HEARTBEAT_TTL_MS = 15000

/** pi 主目录：$PI_CODING_AGENT_DIR 的父级 > ~/.pi（与 pi-dsh-plus-surface 插件侧保持一致） */
function piHome() {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  return path.resolve(agentDir && agentDir.trim() ? path.dirname(agentDir.trim()) : path.join(os.homedir(), '.pi'))
}

function defaultFactsDir() {
  return path.join(piHome(), 'dsh-plus', 'facts')
}

class FactsDirSource extends FactTable {
  /**
   * @param {{ dir?: string, url?: string, origin?: string, fetchFn?: Function, log?: (msg: string) => void }} opts
   *   dir: 分片目录（默认 ~/.pi/dsh-plus/facts；测试可指到临时目录）
   *   url: 事实出口完整 URL（serve-facts.mjs 的 shards.json）；传了就走 HTTP 传输，dir 不再读
   *   origin: 绑定的 pi-web origin。有则只投影该实例 /api/sessions 里的会话（防 TUI/其它实例串台）
   *   fetchFn: 注入 fetch（测试用）
   */
  constructor({ dir, url = '', origin = '', fetchFn = null, log = console.log } = {}) {
    super()
    this.dir = dir || defaultFactsDir()
    this.url = url && String(url).trim()
    this.origin = origin && String(origin).trim()
    this.fetch = fetchFn || ((u, opts) => fetch(u, opts))
    this.scanInFlight = false // 慢端点下不叠发（同 PiWebPollSource 口径）
    /** 第一次扫完前为 false：接入时磁盘上已 idle+completed 的片当成「早就看过」 */
    this.bootstrapped = false
    /** origin 绑定后：null=列表未到（先不投影）；Set=只认这些 id。无 origin 则不过滤。 */
    this.allowedIds = this.origin ? null : undefined
    this.allowInFlight = false
  }

  /** 运行中更新出口 URL（探测到出口换址时热更，同 DshBridge.setFactsUrl 口径）。 */
  setUrl(url) {
    const next = url && String(url).trim()
    if (!next || next === this.url) return
    this.url = next
    if (this.timer) this.scanHttp() // 已在节拍里：立即用新地址补一轮
  }

  start() {
    return this.startPolling(SCAN_INTERVAL_MS)
  }

  async tick() {
    await this.refreshAllowlist()
    if (this.url) await this.scanHttp()
    else this.scan()
  }

  /** origin 绑定后名单还没到：先不投影任何片（宁可空一拍，也不把 TUI 历史倒出来） */
  get waitingAllowlist() {
    return this.origin !== '' && this.allowedIds === null
  }

  /** 拉本实例会话名单（sessions ∪ runningSessionIds）。失败保留上次，避免闪空。 */
  async refreshAllowlist() {
    if (!this.origin || this.allowInFlight) return
    this.allowInFlight = true
    try {
      const body = await fetchJson(this.fetch, new URL('/api/sessions', this.origin))
      if (!body || !Array.isArray(body.sessions) || !Array.isArray(body.runningSessionIds)) return
      const ids = new Set()
      for (const item of body.sessions) {
        if (item && item.id !== undefined && item.id !== null) ids.add(String(item.id))
      }
      for (const id of body.runningSessionIds) ids.add(String(id))
      this.allowedIds = ids
    } catch { /* 保留上次 allowlist */ } finally { this.allowInFlight = false }
  }

  /** 扫一轮 HTTP 出口（serve-facts.mjs 的 shards.json 镜像）：不可达时保留最后一帧（同 piweb-poll 策略，不制造假消失）。 */
  async scanHttp() {
    if (this.scanInFlight || this.waitingAllowlist) return
    this.scanInFlight = true
    try {
      const body = await fetchJson(this.fetch, this.url)
      if (!body || body.version !== 1 || !Array.isArray(body.shards)) return
      this.merge(body.shards)
    } catch { /* 出口抖动/归并意外：保留最后一帧，不挡定时器循环 */ } finally { this.scanInFlight = false }
  }

  /** 扫一轮目录（同步 IO：目录很小、节拍 1s，与 fs.watchFile 的 stat 同量级）。 */
  scan() {
    if (this.waitingAllowlist) {
      this.emitIfChanged()
      return
    }
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      names = [] // 目录不存在（插件未装/未跑过）：空表
    }
    const shards = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue // 跳过 tmp 与非分片
      let body
      try {
        body = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'))
      } catch { continue } // 写盘中途的瞬时态，下轮再读
      shards.push({ name, body })
    }
    this.merge(shards)
  }

  /** 归并一轮分片（fs 与 HTTP 传输共用，语义一字不差）：shards = [{ name, body }]。 */
  merge(shards) {
    const now = Date.now()
    const seen = new Set()
    if (this.waitingAllowlist) {
      this.emitIfChanged()
      return
    }
    const allow = this.allowedIds

    for (const { name, body } of shards) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue // 跳过 tmp 与非分片
      let id
      try { id = decodeURIComponent(name.slice(0, -5)) } catch { continue } // 畸形文件名（如裸 %）不拖垮整轮扫描
      if (!id) continue
      if (allow instanceof Set && !allow.has(id)) continue // 其它实例 / TUI 专属会话：不认
      if (!body || body.version !== 1 || !body.session || typeof body.session !== 'object') continue
      const s = body.session
      const heartbeat = typeof body.heartbeat === 'number' ? body.heartbeat : 0

      let status = s.status === 'running' ? 'running' : 'idle'
      let runningSince = typeof s.runningSince === 'number' ? s.runningSince : null
      let finishedAt = typeof s.finishedAt === 'number' ? s.finishedAt : null
      if (status === 'running' && now - heartbeat > HEARTBEAT_TTL_MS) {
        // 写方进程死了：折算中断结束（同 dsh「进程重启 = 被打断」），不出完成气泡
        status = 'idle'
        runningSince = null
        finishedAt = heartbeat || now
      }

      if (status === 'running') this.cleared.delete(id) // 新一轮 running 沿：重新武装 completed
      seen.add(id)
      this.facts.set(id, {
        status,
        runningSince,
        finishedAt,
        title: typeof s.title === 'string' ? s.title : null,
        cwd: typeof s.cwd === 'string' ? s.cwd : null,
        completed: s.completed === true, // 粘性清除在 factsArray 现算（FactTable）
        updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : heartbeat,
      })
    }

    this.clearVanished(seen)
    this.capIdle()
    // 历史洪水闸门：与 PiWebPollSource「从未 running 过的不跟踪」同语义。
    // 分片文件会把过去所有 completed=true 留在磁盘上；cleared 又只在内存——
    // 壳一开就把历史结束会话全投影成红气泡。第一次真正读到片时，把当时已 idle
    // 的完成片记成看过；只提醒「接入之后」新发生的结束。
    // 目录还不存在时不算接入（空扫不置位），否则插件稍后写出的历史片会漏过闸门。
    if (!this.bootstrapped && this.facts.size > 0) {
      this.bootstrapped = true
      for (const [id, s] of this.facts) {
        if (s.status !== 'running' && s.completed === true) this.cleared.add(id)
      }
    }
    this.emitIfChanged()
  }
}

module.exports = { FactsDirSource, defaultFactsDir }
