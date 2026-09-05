// http-poll adapter 测试：事实归一、nonEmpty 谓词、轮询变化检测、appId 绑定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { httpToFacts, HttpPoller, createHttpPollAdapter } from '../lib/surface/adapters/http-poll.js'
import { evaluateRecipe } from '../lib/surface/recipes.js'
import { SurfaceHub } from '../lib/surface/hub.js'

test('httpToFacts：对象→[对象]，数组→逐元素，标量→value', () => {
  assert.deepEqual(httpToFacts({ a: 1 }), [{ a: 1 }])
  assert.deepEqual(httpToFacts([{ a: 1 }]), [{ a: 1, _index: 0 }])
  assert.deepEqual(httpToFacts(42), [{ value: 42 }])
})

test('nonEmpty 谓词：pi-web busy 灯（runningSessionIds 非空 → 出 badge）', () => {
  const recipe = {
    items: [{ id: 'piweb:busy', kind: 'badge', semantic: 'busy', foreach: { where: { runningSessionIds: { nonEmpty: true } } } }],
  }
  assert.equal(evaluateRecipe(recipe, httpToFacts({ runningSessionIds: ['s'] })).length, 1) // busy
  assert.equal(evaluateRecipe(recipe, httpToFacts({ runningSessionIds: [] })).length, 0) // idle
  assert.equal(evaluateRecipe(recipe, httpToFacts({ runningSessionIds: null })).length, 0) // 无字段
})

test('HttpPoller：busy→idle 变化才发 update，无变化不重发，失败静默', async () => {
  let state = { runningSessionIds: ['a'] }
  const fetchFn = async () => ({ ok: true, json: async () => state })
  const poller = new HttpPoller({ url: 'http://x', fetchFn, toItems: (json) => (json.runningSessionIds.length ? [{ id: 'b' }] : []) })
  const events = []
  poller.on('update', (items) => events.push(items.length))

  await poller.pollOnce() // busy → 1
  await poller.pollOnce() // 无变化 → 不重发
  state = { runningSessionIds: [] }
  await poller.pollOnce() // idle → 0
  assert.deepEqual(events, [1, 0])

  const bad = new HttpPoller({ url: 'http://x', fetchFn: async () => { throw new Error('down') }, toItems: () => [] })
  let badEvents = 0
  bad.on('update', () => badEvents++)
  await bad.pollOnce() // 不抛
  assert.equal(badEvents, 0)
})

test('http-poll adapter：挑出 http recipe，按 URL 绑定 appId 并推 Item', async () => {
  const hub = new SurfaceHub()
  const recipes = [
    { domain: 'dsh.sessions', items: [{ id: 'ignored', kind: 'text' }] }, // 非 http，忽略
    {
      domain: 'piweb',
      source: { type: 'http', url: 'http://127.0.0.1:30141/api/sessions', intervalMs: 60000 },
      items: [{ id: 'piweb:busy', kind: 'badge', semantic: 'busy', foreach: { where: { runningSessionIds: { nonEmpty: true } } } }],
    },
  ]
  const fetchFn = async () => ({ ok: true, json: async () => ({ runningSessionIds: ['s'] }) })
  const adapter = createHttpPollAdapter({
    hub, recipes: () => recipes, resolveAppId: () => 'app-123', fetchFn,
  })
  adapter.start()
  await new Promise((r) => setTimeout(r, 30)) // 等首轮 pollOnce 落定
  const busy = hub.snapshot().find((i) => i.id === 'piweb:busy')
  assert.ok(busy)
  assert.equal(busy.appId, 'app-123')
  assert.equal(busy.kind, 'badge')
  assert.equal(busy.semantic, 'busy')
  adapter.stop()
})

test('http-poll adapter：同 URL recipe 内容变化 → 重建 poller（热更新生效）', async () => {
  const hub = new SurfaceHub()
  let recipe = {
    domain: 'piweb',
    source: { type: 'http', url: 'http://127.0.0.1:30141/api/sessions', intervalMs: 60000 },
    items: [{ id: 'piweb:a', kind: 'text', title: 'old', foreach: {} }],
  }
  const fetchFn = async () => ({ ok: true, json: async () => ({}) })
  const adapter = createHttpPollAdapter({ hub, recipes: () => [recipe], resolveAppId: () => null, fetchFn })
  adapter.start()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(hub.snapshot().find((i) => i.id === 'piweb:a'))

  // 同 URL 改 items（不换域名/地址）→ refresh 必须重建 poller，旧条目消失、新条目出现
  recipe = { ...recipe, items: [{ id: 'piweb:b', kind: 'text', title: 'new', foreach: {} }] }
  adapter.refresh()
  await new Promise((r) => setTimeout(r, 30))
  const ids = hub.snapshot().map((i) => i.id)
  assert.ok(ids.includes('piweb:b'))
  assert.ok(!ids.includes('piweb:a'))
  adapter.stop()
})
test('HttpPoller：URL 占位符按 vars 展开，未提供变量则跳过该轮', async () => {
  const seen = []
  let base = 'http://127.0.0.1:3080'
  const p = new HttpPoller({
    url: '{dsh}/api/x',
    vars: () => ({ dsh: base }),
    fetchFn: async (u) => { seen.push(u); return { ok: true, json: async () => ({}) } },
  })
  await p.pollOnce()
  assert.deepEqual(seen, ['http://127.0.0.1:3080/api/x'])
  base = 'http://127.0.0.1:13080' // 服务换了端口：下一轮跟着走
  await p.pollOnce()
  assert.deepEqual(seen, ['http://127.0.0.1:3080/api/x', 'http://127.0.0.1:13080/api/x'])
  // 变量缺失（服务未就绪）：不发请求、不报错
  const q = new HttpPoller({
    url: '{nope}/api/x',
    vars: () => ({}),
    fetchFn: async (u) => { seen.push(u); return { ok: true, json: async () => ({}) } },
  })
  await q.pollOnce()
  assert.equal(seen.length, 2)
})
