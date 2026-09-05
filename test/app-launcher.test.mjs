// app-launcher 纯逻辑测试：只测不依赖 electron 的部分（hydrateGlyphs 的透传 + appicon: 识别）。
// electron 在纯 node 下 require 得到可执行文件路径字符串，app/shell 解构为 undefined，
// appicon: 取图会走进 try/catch 回退到 null，因此可稳定断言「取不到时不崩、退成纯文字」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { hydrateGlyphs, APPICON_PREFIX } from '../lib/app-launcher.js'

test('APPICON_PREFIX 常量', () => {
  assert.equal(APPICON_PREFIX, 'appicon:')
})

test('hydrateGlyphs：普通 glyph 完全透传（字段不动）', async () => {
  const item = { id: 'a', kind: 'bubble', glyph: 'bubble', title: 'x', action: { type: 'open-session', target: { sessionId: 's' } } }
  const out = await hydrateGlyphs([item])
  assert.deepEqual(out[0], item)
})

test('hydrateGlyphs：appicon: 前缀取不到图标时回退 null，其它字段保留', async () => {
  const out = await hydrateGlyphs([
    { id: 'b', glyph: 'appicon:/Applications/Safari.app', title: 'Safari' },
  ])
  assert.equal(out[0].glyph, null)
  assert.equal(out[0].title, 'Safari')
  assert.equal(out[0].id, 'b')
})

test('hydrateGlyphs：无 glyph / null 元素安全', async () => {
  const out = await hydrateGlyphs([{ id: 'c' }, null])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { id: 'c' })
  assert.equal(out[1], null)
})