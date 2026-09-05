// emit adapter：网页 window.__shell.emit 推 Item（第三种内容源，与 bridge 事实 / http 轮询并列）。
//
// 快照语义：每次 emit 传该应用「当前完整 Item 列表」，传 [] 即清空；与其它 adapter 的
// 全量 setItems 保持一致。appId 由壳强制绑定（按发件 webContents 反查），页面想改也改不了——
// 一个页面只能给自己图标加条目，天然隔离。
//
// 页面用法（pi-web 忙闲灯）：
//   window.__shell.emit([{ id: 'piweb:busy', kind: 'badge', semantic: 'busy' }])  // 忙
//   window.__shell.emit([])                                                       // 闲

'use strict'

function createEmitAdapter({ hub }) {
  const sourceOf = (appId) => `emit:${appId}`
  return {
    /** 快照替换某应用的 emit 来源。raw 里的非法条目（缺 id 等）会被 normalizeItem 丢弃。 */
    emit(appId, rawItems) {
      const arr = Array.isArray(rawItems) ? rawItems : [rawItems]
      hub.setItems(sourceOf(appId), arr.map((r) => (r && typeof r === 'object' ? { ...r, appId } : null)))
    },
    /** 应用被删/卸载时清掉它贡献的条目。 */
    clear(appId) { hub.clearSource(sourceOf(appId)) },
  }
}

module.exports = { createEmitAdapter }