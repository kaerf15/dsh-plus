// SurfaceHub：显示面的唯一事实源。
// 聚合各 content source 的 Item → 按 id 增量 diff → 向 surface 广播 → 把点击动作路由给 executor。
//
// 原则：Hub 不碰传输（事实怎么来）、不碰渲染（Item 怎么画）、
// 不碰领域（动作怎么执行）。它就是一根纯内存的「合并 + diff + 路由」总线。
'use strict'

const { EventEmitter } = require('node:events')
const { normalizeItem, KIND_ORDER } = require('./model.js') // KIND_ORDER：稳定渲染顺序（badge 最前）

class SurfaceHub extends EventEmitter {
  constructor() {
    super()
    this.items = new Map()      // 合并视图：id -> Item
    this.sources = new Map()    // source -> Map<id, Item>
    this.executors = new Map()  // action.type -> fn(action, item)
    this.lastKey = ''
  }

  /**
   * 注册某类动作的执行器：fn(action, item)。领域逻辑由 adapter 自己写，
   * Hub 只知道「点按钮 → 按 type 找执行器」。
   */
  registerExecutor(type, fn) {
    if (typeof type === 'string' && typeof fn === 'function') this.executors.set(type, fn)
  }

  /** 更新一个来源的整组 Item（全量快照，diff 由 Hub 做）。 */
  setItems(source, items) {
    const next = new Map()
    for (const raw of items || []) {
      const item = normalizeItem(raw)
      if (item) next.set(item.id, item)
    }
    this.sources.set(source, next)
    this._recompute()
  }

  /** 移除一个来源（来源出错/消失时清掉它贡献的条目）。 */
  clearSource(source) {
    this.sources.set(source, new Map())
    this._recompute()
  }

  _recompute() {
    const merged = new Map()
    for (const [, items] of this.sources) {
      for (const [id, item] of items) merged.set(id, item)
    }
    this.items = merged
    this._emitIfChanged()
  }

  /** 当前全量 Item 列表（稳定排序：badge 最前，同 kind 内 priority 大者在前）。 */
  snapshot() {
    const list = [...this.items.values()]
    list.sort((a, b) => {
      const ka = KIND_ORDER[a.kind] ?? 9
      const kb = KIND_ORDER[b.kind] ?? 9
      if (ka !== kb) return ka - kb
      const pa = a.priority ?? -Infinity
      const pb = b.priority ?? -Infinity
      if (pa !== pb) return pb - pa
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return list
  }

  _emitIfChanged() {
    const list = this.snapshot()
    const key = JSON.stringify(list)
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('update', list)
  }

  /** 点按钮的唯一入口：先把关联应用带到前台，再交给领域 executor。 */
  dispatch(item) {
    if (!item) return undefined
    const action = item.action
    if (!action) return undefined
    if (item.appId) this.emit('bring-to-front', item.appId)
    const fn = this.executors.get(action.type)
    if (fn) return fn(action, item)
    return undefined
  }

  /** 渲染层只传走 id，由 Hub 找回唯一事实源里的条目后分发（不信任渲染层 payload）。 */
  dispatchById(id) {
    return this.dispatch(this.items.get(id))
  }
}

module.exports = { SurfaceHub, normalizeItem }