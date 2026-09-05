// Surface 协议：Item（条目）+ Action（动作）。
// 纯数据、零依赖、可 JSON 序列化，能跨 IPC / Touch Bar / 网页边界。
//
// 设计底线：Item 与来源无关、与显示目标无关；动作是可序列化描述符，绝不存闭包。
// 任何「要显示的内容 / 可点的按钮」都收敛成同一种 Item，渲染层不再认识 DSH 等具体领域。

'use strict'

/** Item.kind 合法取值（视觉形态）：badge(角标) | bubble(气泡) | text(文本) | card(卡片)。
 *  注意：可点性不由 kind 决定，由 action 有无决定——任何形态都可以同时是「显示内容」和「按钮」。 */
const KINDS = new Set(['badge', 'bubble', 'text', 'card'])
/** Item.semantic 合法取值：语义提示，渲染层自行映射成颜色/图标 */
const SEMANTICS = new Set(['busy', 'done', 'info', 'warn'])
/** 稳定渲染顺序：badge 永远最前，其余靠 priority。Hub 与其它显示面共用（避免各写一份 kind 排序）。 */
const KIND_ORDER = { badge: 0, bubble: 1, text: 2, card: 3 }
/**
 * semantic → 颜色（「通用显示面」的默认映射，如 Touch Bar）。
 * done 与工具栏「已完成未看」红气泡同色（#dc2626），两端告警颜色统一。
 */
const SEMANTIC_COLORS = { busy: '#16a34a', done: '#dc2626', info: '#61666b', warn: '#f59e0b' }

/** 「已完成未看」红气泡计数（仅 semantic=done）。 */
function countDoneBubbles(items) {
  let n = 0
  for (const item of items || []) {
    if (item && item.kind === 'bubble' && item.semantic === 'done') n++
  }
  return n
}

/** Dock / 任务栏角标：待交互（warn）+ 已完成未看（done）气泡总数，跨应用求和。 */
function countDockBadge(items) {
  let n = 0
  for (const item of items || []) {
    if (!item || item.kind !== 'bubble') continue
    if (item.semantic === 'done' || item.semantic === 'warn') n++
  }
  return n
}

/**
 * 规范化一条 Item：补默认值、丢弃非法字段、保证 id/action 可序列化。
 * 非法（缺 id）返回 null。
 * @param {object} item 原始条目
 * @returns {object|null} 规范 Item
 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null
  const id = typeof item.id === 'string' && item.id ? item.id : null
  if (!id) return null

  let action = null
  if (item.action && typeof item.action === 'object' && typeof item.action.type === 'string' && item.action.type) {
    const target = item.action.target && typeof item.action.target === 'object' ? item.action.target : {}
    action = { type: item.action.type, target }
  }

  return {
    id,
    appId: typeof item.appId === 'string' && item.appId ? item.appId : null,
    kind: KINDS.has(item.kind) ? item.kind : 'bubble',
    semantic: SEMANTICS.has(item.semantic) ? item.semantic : null,
    glyph: typeof item.glyph === 'string' && item.glyph ? item.glyph : null,
    title: typeof item.title === 'string' && item.title ? item.title : null,
    subtitle: typeof item.subtitle === 'string' && item.subtitle ? item.subtitle : null,
    badge: typeof item.badge === 'number' && Number.isFinite(item.badge) ? item.badge : null,
    // 排序权重：同一 kind 内 priority 大者在前（气泡用 finishedAt，角标/按钮可不设）
    priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : null,
    action,
  }
}

module.exports = { normalizeItem, countDoneBubbles, countDockBadge, KINDS, SEMANTICS, KIND_ORDER, SEMANTIC_COLORS }