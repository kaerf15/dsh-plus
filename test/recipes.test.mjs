// recipe 求值器 / 加载器测试：默认 recipe 精确复刻旧行为，且同 id 用户覆盖默认。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateRecipes, matchFact } from '../lib/surface/recipes.js'
import { RecipeLoader, parseRecipe, expandDoc, looksLikeImagePath, toDataUri } from '../lib/surface/recipe-loader.js'
import { SurfaceHub } from '../lib/surface/hub.js'

// bundled recipe.json 顶层是 recipes 数组（dsh.sessions + pi.sessions 两域并列）：先 expandDoc 拆出各域
const DEFAULT_RECIPES = expandDoc(JSON.parse(
  readFileSync(fileURLToPath(new URL('../recipes/recipe.json', import.meta.url)), 'utf8'),
))
const DEFAULT_RECIPE = DEFAULT_RECIPES.find((r) => r.domain === 'dsh.sessions')
const PI_RECIPE = DEFAULT_RECIPES.find((r) => r.domain === 'pi.sessions')

/** 造事实（与 bridge.factsArray() 同构） */
function F(sessionId, over = {}) {
  return { sessionId, status: 'idle', title: 't', cwd: '/p', runningSince: null, finishedAt: null, completed: false, ...over }
}

test('默认 recipe 复刻旧行为：running 角标 + 未看结束气泡按 finishedAt 倒序', () => {
  const facts = [
    F('s1', { status: 'running' }),
    F('s2', { status: 'idle', finishedAt: 1000, completed: true }),
    F('s3', { status: 'idle', finishedAt: 3000, completed: true }),
    F('s4', { status: 'idle', finishedAt: 2000, completed: false }), // 已看 → 不出
  ]
  const items = evaluateRecipes([DEFAULT_RECIPE], facts)
  assert.equal(items[0].id, 'dsh:badge:running')
  assert.equal(items[0].badge, 1) // 只有 s1 running
  // evaluateRecipes 不负责排序（排序在 Hub.snapshot 靠 priority），这里只断言出了哪些气泡
  assert.deepEqual(items.slice(1).map((i) => i.id).sort(), ['dsh:fin:s2', 'dsh:fin:s3'])
})

test('aggregate omitWhenZero：无 running 时不出角标', () => {
  const items = evaluateRecipes([DEFAULT_RECIPE], [F('s1', { status: 'idle', finishedAt: 1000 })])
  assert.equal(items.find((i) => i.kind === 'badge'), undefined)
})

test('默认 recipe：host 重启接续的会话（bootstrapped）不出完成气泡，防 client 重传复活', () => {
  const facts = [
    F('s1', { status: 'idle', finishedAt: 1000, completed: true, bootstrapped: true }), // 接续旧会话 → 不出
    F('s2', { status: 'idle', finishedAt: 2000, completed: true }), // 本进程新完成 → 出
  ]
  const items = evaluateRecipes([DEFAULT_RECIPE], facts)
  assert.deepEqual(items.filter((i) => i.kind === 'bubble').map((i) => i.id), ['dsh:fin:s2'])
})

test('foreach 插值：title/subtitle/action 从事实取值', () => {
  const items = evaluateRecipes([DEFAULT_RECIPE], [F('s9', { status: 'idle', finishedAt: 5, completed: true, title: '你好', cwd: '/x' })])
  const bubble = items.find((i) => i.kind === 'bubble')
  assert.equal(bubble.title, '你好')
  assert.equal(bubble.subtitle, '/x')
  assert.deepEqual(bubble.action, { type: 'open-session', target: { sessionId: 's9' } })
})

test('Hub 去重排序：默认 recipe 经 Hub 后仍是 badge 前、气泡倒序', () => {
  const hub = new SurfaceHub()
  hub.setItems('dsh-sessions', evaluateRecipes([DEFAULT_RECIPE], [
    F('a', { status: 'running' }),
    F('b', { status: 'idle', finishedAt: 100, completed: true }),
    F('c', { status: 'idle', finishedAt: 999, completed: true }),
  ]))
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['dsh:badge:running', 'dsh:fin:c', 'dsh:fin:b'])
})

test('pi.sessions 域：running 角标 + 完成气泡走 open-pi-session 动作', () => {
  const facts = [
    F('p1', { status: 'running' }),
    F('p2', { status: 'idle', finishedAt: 2000, completed: true }),
  ]
  const items = evaluateRecipes([PI_RECIPE], facts)
  const badge = items.find((i) => i.kind === 'badge')
  const bubble = items.find((i) => i.kind === 'bubble')
  assert.equal(badge.id, 'pi:badge:running')
  assert.equal(badge.badge, 1)
  assert.equal(bubble.id, 'pi:fin:p2')
  assert.deepEqual(bubble.action, { type: 'open-pi-session', target: { sessionId: 'p2' } })
})

test('pi.sessions 域：appId 留白，由 adapter adopt 绑到实际应用（normalizeItem 前）', () => {
  const items = evaluateRecipes([PI_RECIPE], [F('p1', { status: 'running' })])
  assert.equal(items[0].appId, null) // recipe 不写死 appId
})

test('matchFact：字段等值 + nonEmpty 通用谓词（无业务语义内建）', () => {
  assert.equal(matchFact({ completed: true }, { completed: true }), true)
  assert.equal(matchFact({ completed: false }, { completed: true }), false)
  assert.equal(matchFact({ completed: undefined }, { completed: true }), false)
  assert.equal(matchFact({ name: 'a' }, { name: 'a' }), true)
  assert.equal(matchFact({ name: 'a' }, { name: 'b' }), false)
  assert.equal(matchFact({ list: [1] }, { list: { nonEmpty: true } }), true)
  assert.equal(matchFact({ list: [] }, { list: { nonEmpty: true } }), false)
  assert.equal(matchFact({ x: null }, { x: { nonEmpty: false } }), true)
  assert.equal(matchFact({ x: 'v' }, { x: { nonEmpty: false } }), false)
})

test('RecipeLoader：bundled + user 各一份 recipe.json，同 id 后者覆盖', () => {
  const bundledDir = mkdtempSync(join(tmpdir(), 'bundled-'))
  const userDir = mkdtempSync(join(tmpdir(), 'user-'))
  writeFileSync(join(bundledDir, 'recipe.json'), JSON.stringify({ items: [{ id: 'x', kind: 'text', aggregate: { count: {}, as: 'badge' } }] }))
  writeFileSync(join(userDir, 'recipe.json'), JSON.stringify({ items: [{ id: 'x', kind: 'bubble', semantic: 'done', aggregate: { count: {}, as: 'badge' } }] }))

  const loader = new RecipeLoader({ bundledDir, userDir, log: () => {} })
  loader.start()
  const items = evaluateRecipes(loader.recipes, [])
  assert.equal(items.length, 1) // 同 id 后者覆盖，求值阶段就合并

  const hub = new SurfaceHub()
  hub.setItems('t', items)
  const x = hub.snapshot().find((i) => i.id === 'x')
  assert.equal(x.kind, 'bubble')
  assert.equal(x.semantic, 'done')
  loader.stop()
})

test('固定条目：无 aggregate/foreach 的 spec 一直出现在 bar 上', () => {
  const recipe = {
    items: [{ id: 'dsh:btn:new', appId: 'dsh', kind: 'text', title: '新对话', semantic: 'info' }],
  }
  const items = evaluateRecipes([recipe], [])
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'dsh:btn:new')
  assert.equal(items[0].kind, 'text')
  assert.equal(items[0].title, '新对话')
})

test('修改：后一个 recipe 同 id 覆盖前一个', () => {
  const a = { items: [{ id: 'x', kind: 'bubble', title: '旧' }] }
  const b = { items: [{ id: 'x', kind: 'text', title: '新' }] }
  const items = evaluateRecipes([a, b], [])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'text')
  assert.equal(items[0].title, '新')
})

test('删除：omit:true 去掉已有同 id（含 foreach 展开）', () => {
  const base = DEFAULT_RECIPE
  const dropBadge = { items: [{ id: 'dsh:badge:running', omit: true }] }
  const facts = [F('s1', { status: 'running' }), F('s2', { status: 'idle', finishedAt: 1, completed: true })]
  const withoutBadge = evaluateRecipes([base, dropBadge], facts)
  assert.equal(withoutBadge.find((i) => i.id === 'dsh:badge:running'), undefined)
  assert.ok(withoutBadge.find((i) => i.id === 'dsh:fin:s2'))

  const dropFins = { items: [{ id: 'dsh:fin:${sessionId}', omit: true, foreach: { where: { completed: true } } }] }
  const withoutFins = evaluateRecipes([base, dropFins], facts)
  assert.ok(withoutFins.find((i) => i.id === 'dsh:badge:running'))
  assert.equal(withoutFins.find((i) => i.kind === 'bubble'), undefined)
})

test('parseRecipe：非法 JSON / 既无 items 也无 recipes 返回 null', () => {
  assert.equal(parseRecipe('not json'), null)
  assert.equal(parseRecipe(JSON.stringify({ x: 1 })), null)
  assert.notEqual(parseRecipe(JSON.stringify({ items: [] })), null)
  assert.notEqual(parseRecipe(JSON.stringify({ recipes: [{ items: [] }] })), null)
})

test('expandDoc：顶层 recipes 数组拆成多条（不同 source 写进同一份文件）', () => {
  const doc = {
    recipes: [
      { items: [{ id: 'a' }] },
      { source: { type: 'http', url: 'http://x' }, items: [{ id: 'b' }] },
    ],
  }
  const list = expandDoc(doc)
  assert.equal(list.length, 2)
  assert.equal(list[0].items[0].id, 'a')
  assert.equal(list[1].source.type, 'http')
  assert.deepEqual(expandDoc({ items: [{ id: 'only' }] }).map((r) => r.items[0].id), ['only'])
})

test('glyph 图片路径识别与转换：命名/内联/data/URL 原样，文件 → data URI', () => {
  assert.equal(looksLikeImagePath('bubble'), false)
  assert.equal(looksLikeImagePath('<svg></svg>'), false)
  assert.equal(looksLikeImagePath('data:image/png;base64,x'), false)
  assert.equal(looksLikeImagePath('https://x/i.png'), false)
  assert.equal(looksLikeImagePath('icon.png'), true)
  assert.equal(looksLikeImagePath('a/b/icon.svg'), true)

  const dir = mkdtempSync(join(tmpdir(), 'glyph-'))
  writeFileSync(join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.ok(toDataUri(dir, 'icon.png').startsWith('data:image/png;base64,'))
  assert.equal(toDataUri(dir, 'missing.png'), 'missing.png') // 读不到原样返回
})

test('RecipeLoader 把 recipe 里的图片 glyph 转成 data URI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glyphloader-'))
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify({ items: [{ id: 'b', kind: 'bubble', glyph: 'icon.png' }] }))
  writeFileSync(join(dir, 'icon.png'), Buffer.from([1, 2, 3, 4]))

  const loader = new RecipeLoader({ bundledDir: null, userDir: dir, log: () => {} })
  loader.start()
  assert.equal(loader.recipes.length, 1)
  assert.ok(loader.recipes[0].items[0].glyph.startsWith('data:image/png;base64,'))
  loader.stop()
})