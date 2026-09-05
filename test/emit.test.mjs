// emit adapter 测试：快照覆盖、appId 强制绑定、非法条目丢弃、来源隔离、clear。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmitAdapter } from '../lib/surface/adapters/emit.js'
import { SurfaceHub } from '../lib/surface/hub.js'

test('emit adapter：快照替换 + appId 强制绑定 + 非法条目丢弃', () => {
  const hub = new SurfaceHub()
  const emitAdapter = createEmitAdapter({ hub })

  emitAdapter.emit('app-1', [
    { id: 'x:busy', kind: 'badge', semantic: 'busy' },
    { id: 'x:done', kind: 'bubble', title: 't', appId: 'spoof' }, // appId 欺骗无效
    { bad: true }, // 缺 id → 丢弃
    null, // 非对象 → 丢弃
  ])
  const items = hub.snapshot()
  assert.equal(items.length, 2)
  assert.equal(items.find((i) => i.id === 'x:busy').appId, 'app-1')
  assert.equal(items.find((i) => i.id === 'x:done').appId, 'app-1') // 不是 spoof
  assert.equal(items.find((i) => i.id === 'x:done').kind, 'bubble')

  // 快照语义：只重发一条 → 旧的没了
  emitAdapter.emit('app-1', [{ id: 'x:busy', kind: 'badge', semantic: 'busy' }])
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['x:busy'])

  // 空数组 = 清空
  emitAdapter.emit('app-1', [])
  assert.deepEqual(hub.snapshot().map((i) => i.id), [])

  // 不同 appId 各管各的
  emitAdapter.emit('app-2', [{ id: 'y:busy', kind: 'badge', semantic: 'busy' }])
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['y:busy'])

  // clear 只清那个应用的来源
  emitAdapter.clear('app-1')
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['y:busy'])
})

test('emit adapter：动作只保留可序列化描述符', () => {
  const hub = new SurfaceHub()
  hub.registerExecutor('open-x', () => 'opened')
  const emitAdapter = createEmitAdapter({ hub })

  emitAdapter.emit('app-1', [{ id: 'x', kind: 'bubble', title: 'goto', action: { type: 'open-x', target: { id: 7 }, fn: () => {} } }])
  const item = hub.snapshot()[0]
  assert.deepEqual(item.action, { type: 'open-x', target: { id: 7 } }) // fn 闭包被丢弃
  assert.equal(hub.dispatchById('x'), 'opened')
})