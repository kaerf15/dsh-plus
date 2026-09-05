// 跑法：cd dsh-plus && node --test test/
// 桥只收集事实、不派生视图。角标/气泡口径在 recipe 测试里覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DshBridge } from '../lib/bridge.js'

function makeBridge() {
  return new DshBridge({ log: () => {} })
}

function seedFinished(bridge, id, { finishedAgo = 1000, completed = true, title = 't', cwd = '/p' } = {}) {
  bridge.mode = 'polling' // 降级模式：字段平铺
  bridge.facts.set(id, {
    status: 'idle', title, cwd,
    runningSince: null,
    finishedAt: Date.now() - finishedAgo,
    completed,
  })
}

test('factsArray：进行中会话原样保留', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', { status: 'running', runningSince: 1, finishedAt: null, cli: { title: 'a', cwd: '/x', completed: false } })
  const arr = b.factsArray()
  assert.equal(arr.length, 1)
  assert.equal(arr[0].sessionId, 's1')
  assert.equal(arr[0].status, 'running')
  assert.equal(arr[0].title, 'a')
  assert.equal(arr[0].cwd, '/x')
})

test('factsArray：结束会话带 finishedAt，未看则 completed=true', () => {
  const b = makeBridge()
  seedFinished(b, 's1')
  const f = b.factsArray()[0]
  assert.equal(f.status, 'idle')
  assert.ok(f.finishedAt)
  assert.equal(f.completed, true)
})

test('factsArray：降级模式 markViewed 消耗 completion 提醒', () => {
  const b = makeBridge()
  seedFinished(b, 's1', { completed: true })
  assert.equal(b.factsArray()[0].completed, true)
  b.markViewed('s1')
  assert.equal(b.factsArray()[0].completed, false)
})

test('factsArray：插件模式的 cli 快照平铺展开，host 核心字段兜底', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', {
    status: 'idle', runningSince: null, finishedAt: 1000, completed: true,
    cli: { title: 't', cwd: '/p', updatedAt: 500 },
  })
  const f = b.factsArray()[0]
  assert.equal(f.title, 't')
  assert.equal(f.completed, true) // host 推导的顶层字段
  assert.equal(f.updatedAt, 500)
  assert.equal(f.status, 'idle')
})

test('factsArray：cli 里的 completed 残留（旧版本桥文件）不被信，host 顶层字段压住它', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', {
    status: 'idle', runningSince: null, finishedAt: 1000, // 无顶层 completed → false
    cli: { title: 't', completed: true },
  })
  assert.equal(b.factsArray()[0].completed, false)
})

test('factsArray：cli 里混入 host 核心同名字段也不被信（host 兜底）', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', { status: 'idle', runningSince: null, finishedAt: 1000, cli: { status: 'running' } })
  assert.equal(b.factsArray()[0].status, 'idle')
})

test('factsArray：host 标的 bootstrapped 透传给 recipe（重启接续过滤用）', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', { status: 'idle', runningSince: null, finishedAt: 1000, bootstrapped: true, cli: {} })
  b.facts.set('s2', { status: 'idle', runningSince: null, finishedAt: 2000, cli: { completed: true } })
  const arr = b.factsArray()
  assert.equal(arr.find((f) => f.sessionId === 's1').bootstrapped, true)
  assert.equal(arr.find((f) => f.sessionId === 's2').bootstrapped, undefined)
})

test('标题变化也会发 update（不再被旧 derive 模型吞掉）', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', { status: 'running', runningSince: 1, finishedAt: null, cli: { title: 'a', cwd: '/x', completed: false } })
  const got = []
  b.on('update', () => got.push(b.factsArray()[0].title))
  b.emitIfChanged()
  assert.deepEqual(got, ['a'])
  b.facts.set('s1', { status: 'running', runningSince: 1, finishedAt: null, cli: { title: 'b', cwd: '/x', completed: false } })
  b.emitIfChanged()
  assert.deepEqual(got, ['a', 'b'])
})

test('相同事实不重播 update', () => {
  const b = makeBridge()
  b.mode = 'plugin'
  b.facts.set('s1', { status: 'running', runningSince: 1, finishedAt: null, cli: { title: 'a', cwd: '/x', completed: false } })
  let n = 0
  b.on('update', () => n++)
  b.emitIfChanged()
  b.emitIfChanged()
  assert.equal(n, 1)
})

test('setBaseUrl：start 之后才拿到 URL（DSH 后装）也能启动降级轮询', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { ok: true, value: { items: [] } } }) })
  try {
    const b = makeBridge() // baseUrl ''，没调用 start()（模拟后装前）
    b.mode = 'off'
    b.setBaseUrl('http://127.0.0.1:9')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(b.mode, 'polling')
    assert.ok(b.pollTimer)
    b.stop()
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------- 远端连接：factsUrl（插件 HTTP 事实出口） ----------

test('factsUrl：HTTP 事实出口接入，拿到与本地文件同形状的全保真事实', async () => {
  const body = {
    version: 1,
    sessions: { s1: { status: 'running', runningSince: 1, finishedAt: null, cli: { title: 'a', cwd: '/x', completed: false } } },
  }
  const b = new DshBridge({
    file: null, // 远端实例没有本地文件可读
    factsUrl: 'http://127.0.0.1:3081/dsh-plus-surface/bridge.json',
    log: () => {},
    fetchFn: async () => ({ ok: true, json: async () => body }),
  })
  b.start()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(b.mode, 'plugin')
  assert.equal(b.pluginVia, 'http')
  const f = b.factsArray()[0]
  assert.equal(f.sessionId, 's1')
  assert.equal(f.title, 'a')
  assert.equal(f.status, 'running')
  b.stop()
})

test('factsUrl：出口不可达 → 清空事实退到降级轮询；恢复后回到插件模式', async () => {
  let down = false
  const fetchFn = async (url) => {
    if (String(url).includes('bridge.json')) {
      if (down) throw new Error('tunnel down')
      return { ok: true, json: async () => ({ version: 1, sessions: { s1: { status: 'running', runningSince: 1, finishedAt: null, cli: {} } } }) }
    }
    // 降级轮询 session.list
    return { ok: true, json: async () => ({ result: { ok: true, value: { items: [] } } }) }
  }
  const b = new DshBridge({
    file: null,
    baseUrl: 'http://127.0.0.1:3081',
    factsUrl: 'http://127.0.0.1:3081/dsh-plus-surface/bridge.json',
    log: () => {},
    fetchFn,
  })
  b.start()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(b.mode, 'plugin')

  down = true
  await b.pollFactsOnce()
  await new Promise((r) => setTimeout(r, 30)) // ensurePolling 的 pollOnce 是异步的
  assert.equal(b.mode, 'polling')
  assert.equal(b.facts.size, 0) // 远端失联不残留假事实

  down = false
  await b.pollFactsOnce()
  assert.equal(b.mode, 'plugin')
  assert.equal(b.pluginVia, 'http')
  b.stop()
})

test('factsUrl：插件模式不并发降级轮询（与文件模式同约）', async () => {
  const b = new DshBridge({
    file: null,
    baseUrl: 'http://127.0.0.1:3081',
    factsUrl: 'http://127.0.0.1:3081/dsh-plus-surface/bridge.json',
    log: () => {},
    fetchFn: async () => ({ ok: true, json: async () => ({ version: 1, sessions: {} }) }),
  })
  b.start()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(b.mode, 'plugin')
  assert.equal(b.pollTimer, null)
  b.stop()
})

test('setAuthHeader：0.1.2+ 降级轮询与事实拉取都携带 cookie 头', async () => {
  const seen = []
  const b = new DshBridge({
    file: null,
    baseUrl: 'http://127.0.0.1:3081',
    factsUrl: 'http://127.0.0.1:3081/dsh-plus-surface/bridge.json',
    log: () => {},
    fetchFn: async (url, opts) => {
      seen.push({ url: String(url), cookie: opts?.headers?.cookie ?? null })
      return { ok: true, json: async () => ({ version: 1, sessions: {} }) }
    },
  })
  b.setAuthHeader('dsh-auth-x=v1.a.b')
  await b.pollFactsOnce()
  assert.equal(seen[0].cookie, 'dsh-auth-x=v1.a.b')
  b.stop()
})