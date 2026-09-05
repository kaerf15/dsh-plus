// Touch Bar 显示面（纯逻辑，零 electron 依赖，可单测）。
//
// 这是 Surface「与显示目标无关」的直接证明：同一批 Item 既画进工具栏气泡带，
// 也映射成 Touch Bar 按钮。Item → 按钮描述符是纯函数，electron 侧只负责把它转成 TouchBar。
//
// 映射规则：
//  - badge：无数值（busy 圆点）→ '●'；有数值 → 数字
//  - bubble/text/card：label = title || subtitle；空 → '·' 兜底（TouchBarButton 不接受空 label）
//  - semantic → 背景色（与 shell-ui 语义色一致）；有 action → 可点

'use strict'

const { KINDS, SEMANTIC_COLORS } = require('./model.js')

/** Item[] → Touch Bar 按钮描述符（稳定顺序沿用 Hub.snapshot 的排序）。 */
function itemsToTouchBarSpecs(items) {
  const specs = []
  for (const item of items || []) {
    if (!item || !KINDS.has(item.kind)) continue
    let label = ''
    if (item.kind === 'badge') {
      label = item.badge && item.badge > 0 ? String(item.badge) : (item.semantic === 'busy' ? '●' : '·')
    } else {
      label = item.title || item.subtitle || ''
    }
    if (!label) label = '·'
    specs.push({
      id: item.id,
      label,
      color: SEMANTIC_COLORS[item.semantic] || null,
      hasAction: Boolean(item.action),
      appId: item.appId || null,
      // 图标只认可光栅化的（data: URI）；命名图标/SVG 标记由 electron 侧跳过
      glyph: typeof item.glyph === 'string' && item.glyph.startsWith('data:') ? item.glyph : null,
    })
  }
  return specs
}

module.exports = { itemsToTouchBarSpecs, SEMANTIC_COLORS }