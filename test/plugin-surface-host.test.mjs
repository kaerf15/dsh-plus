// dsh-plus-surface host 半（plugins/dsh-plus-surface/index.js）的桥文件行为测试。
// mock cordis ctx：捕获 agent/* 事件处理器与 rpc handler，用临时 DSH_HOME 读真实桥文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../plugins/dsh-plus-surface/index.js')

const CHANNEL = '/dsh-plus-surface'

/** 起一套插件实例：返回事件发射器 / rpc 调用器 / 桥文件路径。 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plus-surface-test-'))
  process.env.DSH_HOME = home
  const handlers = new Map()
  let rpcHandler = null
  const connCtx = {
    on: (event, fn) => handlers.set(event, fn),
    connection: { rpc: { handle: (channel, fn) => { assert.equal(channel, CHANNEL); rpcHandler = fn } } },
    inject: () => {}, // webServer 段不在本测试范围
    logger: { info: () => {}, warn: () => {} },
  }
  const ctx = {
    skills: { registerProvider: () => {} },
    on: () => {},
    inject: (deps, fn) => { assert.deepEqual(deps, ['connection']); fn(connCtx) },
  }
  apply(ctx)
  const agent = (id) => ({ id, session: { header: {} } }) // 顶层会话（无 origin/parentSession）
  return {
    file: join(home, 'dsh-plus', 'bridge.json'),
    created: (id) => handlers.get('agent/created')({ agent: agent(id) }),
    status: (id, status) => handlers.get('agent/status')({ agent: agent(id), status }),
    disposed: (id) => handlers.get('agent/disposed')({ agent: agent(id) }),
    sync: (sessionId, fields, clientId = 'c1') => rpcHandler('sync', { sessionId, clientId, fields }),
  }
}

/** 写盘有 200ms 防抖：等它落盘。 */
function settle(ms = 300) {
  return new Promise((res) => setTimeout(res, ms))
}

function readBridge(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('completed 由 host 推导：结束瞬间无人选中 = 未看；有人选中 = 已看', async () => {
  const p = setup()
  p.created('s1')
  p.created('s2')
  await p.sync('s1', { title: '被看着的', cwd: '/tmp', selected: true }) // running 期选中上报
  p.status('s1', 'running')
  p.status('s2', 'running')
  p.status('s1', 'idle') // s1 结束时有 client 选中
  p.status('s2', 'idle') // s2 结束时无人选中
  await settle()
  const body = readBridge(p.file)
  assert.equal(body.sessions.s1.completed, false) // 被看着：不出泡
  assert.equal(body.sessions.s2.completed, true) // 没人看：出泡
})

test('选中即清：idle 期任一 client 选中后 completed 清除；迟到的 completed:true 一律不认', async () => {
  const p = setup()
  p.created('s1')
  p.status('s1', 'running')
  p.status('s1', 'idle')
  await settle()
  assert.equal(readBridge(p.file).sessions.s1.completed, true)

  // 用户在某 client 里打开该会话 → selected:true 上报 → 清
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: true }, 'c1')
  await settle()
  assert.equal(readBridge(p.file).sessions.s1.completed, false)

  // 另一 client（没选中它）的运行时内存仍揣着 completed:true → host 不认这个字段
  await p.sync('s1', { title: 't', cwd: '/tmp', completed: true }, 'c2')
  await settle()
  const entry = readBridge(p.file).sessions.s1
  assert.equal(entry.completed, false)
  assert.equal('completed' in entry.cli, false) // completed 不进 cli 快照（host 独写）
})

test('新一轮 running 沿重新武装：之后无人观看的结束照常出泡', async () => {
  const p = setup()
  p.created('s1')
  p.status('s1', 'running')
  p.status('s1', 'idle')
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: true }) // 看过了
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: false }) // 随后切走
  p.status('s1', 'running') // 新一轮
  p.status('s1', 'idle') // 这次没人看
  await settle()
  assert.equal(readBridge(p.file).sessions.s1.completed, true)
})

test('selected 不进 cli 快照；取消选中只摘自己那份', async () => {
  const p = setup()
  p.created('s1')
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: true }, 'c1')
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: true }, 'c2')
  p.status('s1', 'running')
  await p.sync('s1', { title: 't', cwd: '/tmp', selected: false }, 'c1') // c1 切走，c2 还在看
  p.status('s1', 'idle')
  await settle()
  const entry = readBridge(p.file).sessions.s1
  assert.equal(entry.completed, false) // c2 还看着 → 不出泡
  assert.equal('selected' in entry.cli, false) // 活信号不落 cli
})

test('disposed（idle）：清 completed 与 pendingInteraction 残留，保留 title/cwd 与 finishedAt', async () => {
  const p = setup()
  p.created('s1')
  p.status('s1', 'running')
  p.status('s1', 'idle') // 无人看 → completed=true
  await p.sync('s1', { title: '已完成会话', cwd: '/tmp', pendingInteraction: 'approval' })
  p.disposed('s1') // 会话被删：不会再有任何上报，残留不能留
  await settle()
  const entry = readBridge(p.file).sessions.s1
  assert.equal(entry.status, 'idle')
  assert.equal(typeof entry.finishedAt, 'number')
  assert.equal(entry.completed, false) // 未看标记回收
  assert.equal(entry.cli.title, '已完成会话') // 展示字段保留
  assert.equal('pendingInteraction' in entry.cli, false)
})

test('disposed（running）：记一笔结束，且不算未看', async () => {
  const p = setup()
  p.created('s1')
  p.status('s1', 'running')
  await p.sync('s1', { title: 't', cwd: '/tmp' })
  p.disposed('s1')
  await settle()
  const entry = readBridge(p.file).sessions.s1
  assert.equal(entry.status, 'idle')
  assert.equal(entry.runningSince, null)
  assert.equal(typeof entry.finishedAt, 'number')
  assert.equal(entry.completed, false)
})

test('sync：不认识的 id（subagent 等）一律忽略', async () => {
  const p = setup()
  const r = await p.sync('ghost', { selected: true })
  assert.equal(r.ok, true)
  assert.equal(r.value.accepted, false)
  await settle()
  if (existsSync(p.file)) assert.equal(readBridge(p.file).sessions.ghost, undefined)
})
