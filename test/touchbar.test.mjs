// Touch Bar 显示面映射测试：Item → 按钮描述符（纯逻辑，无 electron）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { itemsToTouchBarSpecs, SEMANTIC_COLORS } from '../lib/surface/touchbar.js'

test('itemsToTouchBarSpecs：badge 数值 / busy 圆点 / 气泡标题 / 兜底 / 跳过非显示形态', () => {
  const items = [
    { id: 'a', kind: 'badge', semantic: 'busy', badge: 3, appId: 'dsh' },
    { id: 'b', kind: 'badge', semantic: 'busy', appId: 'piweb' }, // 无数值 busy → ●
    { id: 'c', kind: 'bubble', title: '看结果', semantic: 'done', action: { type: 'open-session', target: { sessionId: 's' } } },
    { id: 'd', kind: 'text', semantic: 'warn' }, // 无标题 → 兜底 ·
    { id: 'e', kind: 'card', title: 'x', subtitle: 'y', semantic: null },
    { id: 'f', kind: 'unknown' }, // 非显示形态 → 跳过
  ]
  const specs = itemsToTouchBarSpecs(items)
  assert.equal(specs.length, 5)

  assert.deepEqual(specs[0], { id: 'a', label: '3', color: '#16a34a', hasAction: false, appId: 'dsh', glyph: null })
  assert.equal(specs[1].label, '●')
  assert.equal(specs[1].color, '#16a34a')
  assert.equal(specs[2].label, '看结果')
  assert.equal(specs[2].color, '#dc2626')
  assert.equal(specs[2].hasAction, true)
  assert.equal(specs[3].label, '·') // 空标题兜底
  assert.equal(specs[3].color, '#f59e0b')
  assert.equal(specs[4].label, 'x') // title 优先于 subtitle
  assert.equal(specs[4].color, null)
})

test('itemsToTouchBarSpecs：空/undefined 安全', () => {
  assert.deepEqual(itemsToTouchBarSpecs([]), [])
  assert.deepEqual(itemsToTouchBarSpecs(null), [])
  assert.deepEqual(itemsToTouchBarSpecs([null, { id: 'x' }, 42]), []) // 坏元素全跳过
})

test('itemsToTouchBarSpecs：glyph 只透传 data: URI（命名/SVG 无法光栅化，由 electron 侧跳过）', () => {
  const specs = itemsToTouchBarSpecs([
    { id: 'a', kind: 'bubble', title: 'x', glyph: 'data:image/png;base64,iVBORw0KGgo=' },
    { id: 'b', kind: 'bubble', title: 'y', glyph: 'bubble' },
    { id: 'c', kind: 'bubble', title: 'z', glyph: '<svg></svg>' },
    { id: 'd', kind: 'bubble', title: 'w' },
  ])
  assert.equal(specs[0].glyph, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(specs[1].glyph, null)
  assert.equal(specs[2].glyph, null)
  assert.equal(specs[3].glyph, null)
})

test('语义色表：通用显示面默认映射（canonical 定义在 model.js）', () => {
  assert.deepEqual(SEMANTIC_COLORS, { busy: '#16a34a', done: '#dc2626', info: '#61666b', warn: '#f59e0b' })
})