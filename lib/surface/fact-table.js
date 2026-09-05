// 事实表基座：FactsDirSource 与 PiWebPollSource 共享的公共骨架。
// 两个源的事实都是平铺标量（无 dsh 的 cli 嵌套层），且共用同一套语义：
//   - completed 粘性清除：markViewed 加进 cleared 集，factsArray 现算（不改事实本体）
//   - running 沿重新武装：由各源的采集循环在见到 running 时 cleared.delete(id)
//   - 消失清理 + idle 防膨胀 + 无变化不重播
// DshBridge 不继承它：dsh 事实是 cli 快照嵌套形状，completed 语义在插件侧（host 依选中上报推导），
// 硬挤进同一个基座反而要多开洞。鸭子类型一致即可：factsArray() / 'update' / markViewed / start / stop。
'use strict'

const { EventEmitter } = require('node:events')

class FactTable extends EventEmitter {
  constructor() {
    super()
    /** 归一事实表：id -> { status, runningSince, finishedAt, ...平铺标量 } */
    this.facts = new Map()
    /** 看过的会话 id（completed 粘性清除） */
    this.cleared = new Set()
    this.lastEmitted = ''
    this.timer = null
    /** idle 防膨胀上限（capIdle 缺省用它；子类无需自定义时不必传参） */
    this.maxIdle = 30
  }

  /** 采集节拍（FactsDirSource / PiWebPollSource 同款机械，收拢在基座）：先跑一轮再起定时器。
   *  子类必须提供 tick()（FactsDirSource 的 tick 含 allowlist 前置，PiWebPollSource 直接别名 pollOnce）。 */
  startPolling(intervalMs) {
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** 点气泡 = 看过：加进粘性清除集（completed 在 factsArray 里现算）。 */
  markViewed(id) {
    this.cleared.add(id)
    this.emitIfChanged()
  }

  /** 采集循环调用：seen 之外的会话（分片消失/列表删除）清掉事实与粘性痕迹。 */
  clearVanished(seenIds) {
    for (const id of [...this.facts.keys()]) {
      if (!seenIds.has(id)) {
        this.facts.delete(id)
        this.cleared.delete(id) // 防 cleared 集慢漏
      }
    }
  }

  /** idle 防膨胀：只留最近 max 条（按 finishedAt 倒序）。淘汰连同 cleared 痕迹一起清——
   *  否则 cleared 无界慢漏，且被淘汰会话日后重开跑完时，陈年条目会错误压住新气泡。 */
  capIdle(max = this.maxIdle) {
    const idle = [...this.facts.entries()].filter(([, s]) => s.status !== 'running')
    if (idle.length > max) {
      idle.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      for (const [id] of idle.slice(0, idle.length - max)) {
        this.facts.delete(id)
        this.cleared.delete(id)
      }
    }
  }

  factsArray() {
    return [...this.facts.entries()].map(([id, s]) => ({
      sessionId: id,
      ...s,
      completed: s.completed === true && !this.cleared.has(id),
    }))
  }

  emitIfChanged() {
    const key = JSON.stringify({ facts: this.factsArray() })
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.emit('update')
  }
}

module.exports = { FactTable }
