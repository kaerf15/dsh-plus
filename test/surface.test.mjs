// 显示面（surface）层测试：Item 协议 + Hub 合并/排序/路由 + dsh-sessions adapter 投影。
// 跑法：cd dsh-plus && node --test test/surface.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { normalizeItem, countDoneBubbles, countDockBadge } from '../lib/surface/model.js'
import { SurfaceHub } from '../lib/surface/hub.js'
import { createDshSessionsAdapter } from '../lib/surface/adapters/dsh-sessions.js'

test('normalizeItem：补默认值，缺 id 返回 null', () => {
  assert.equal(normalizeItem(null), null)
  assert.equal(normalizeItem({}), null)
  const item = normalizeItem({ id: 'x' })
  assert.equal(item.id, 'x')
  assert.equal(item.kind, 'bubble') // 默认 kind
  assert.equal(item.semantic, null)
  assert.equal(item.action, null)
})

test('normalizeItem：动作只保留可序列化的 type/target（闭包被丢弃）', () => {
  const item = normalizeItem({ id: 'x', action: { type: 'jump', target: { id: 1 }, cb: () => {} } })
  assert.deepEqual(item.action, { type: 'jump', target: { id: 1 } })
  assert.equal(JSON.stringify(item.action).includes('cb'), false)
})

test('countDoneBubbles：只数 done 红气泡（跨应用求和），busy/warn/角标不计', () => {
  assert.equal(countDoneBubbles(null), 0)
  assert.equal(countDoneBubbles([]), 0)
  const items = [
    { id: 'a', kind: 'bubble', semantic: 'done' },
    { id: 'b', kind: 'bubble', semantic: 'done' },
    { id: 'c', kind: 'bubble', semantic: 'warn' }, // 待交互是琥珀色，不算红气泡
    { id: 'd', kind: 'badge', semantic: 'busy', badge: 3 }, // 角标不算
    { id: 'e', kind: 'text', semantic: 'done' }, // 非气泡不算
    null,
  ]
  assert.equal(countDoneBubbles(items), 2)
})

test('countDockBadge：done + warn 气泡都算（Dock 角标口径）', () => {
  assert.equal(countDockBadge([
    { id: 'a', kind: 'bubble', semantic: 'done' },
    { id: 'b', kind: 'bubble', semantic: 'warn' },
    { id: 'c', kind: 'bubble', semantic: 'busy' },
    { id: 'd', kind: 'badge', semantic: 'busy', badge: 2 },
  ]), 2)
})

test('Hub：合并 + 稳定排序（badge 最前，priority 大者在前）+ 无变化不重播', () => {
  const hub = new SurfaceHub()
  let updates = 0
  hub.on('update', () => updates++)

  const three = [
    { id: 'b2', kind: 'bubble', priority: 2 },
    { id: 'badge', kind: 'badge', badge: 1 },
    { id: 'b1', kind: 'bubble', priority: 1 },
  ]
  hub.setItems('a', three)
  assert.equal(updates, 1)
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['badge', 'b2', 'b1'])

  hub.setItems('a', three) // 完全相同：不重播
  assert.equal(updates, 1)

  hub.setItems('a', [{ id: 'badge', kind: 'badge', badge: 1 }]) // 变化：广播
  assert.equal(updates, 2)
  assert.deepEqual(hub.snapshot().map((i) => i.id), ['badge'])
})

test('Hub.dispatchById：先 bring-to-front，再按 type 路由给 executor', () => {
  const hub = new SurfaceHub()
  const calls = []
  hub.on('bring-to-front', (appId) => calls.push(['front', appId]))
  hub.registerExecutor('open-session', (action, item) => {
    calls.push(['exec', action.target.sessionId, item.id])
    return 'ok'
  })
  hub.setItems('a', [{ id: 'dsh:fin:s1', appId: 'dsh', kind: 'bubble', action: { type: 'open-session', target: { sessionId: 's1' } } }])
  const r = hub.dispatchById('dsh:fin:s1')
  assert.equal(r, 'ok')
  assert.deepEqual(calls, [['front', 'dsh'], ['exec', 's1', 'dsh:fin:s1']])
})

test('Hub 快照按 appId 可分组（工具栏：badge 上图标，其余 kind 进旁侧条目带）', () => {
  const hub = new SurfaceHub()
  hub.setItems('dsh-sessions', [
    { id: 'dsh:badge:running', appId: 'dsh', kind: 'badge', semantic: 'busy', badge: 2 },
    { id: 'dsh:fin:s1', appId: 'dsh', kind: 'bubble', semantic: 'done', title: 't' },
  ])
  hub.setItems('emit:piweb', [
    { id: 'pi:busy', appId: 'piweb', kind: 'badge', semantic: 'busy' },
    { id: 'pi:note', appId: 'piweb', kind: 'text', title: '跑完了' },
  ])
  const items = hub.snapshot()
  const of = (appId) => items.filter((i) => i.appId === appId)
  const strip = (appId) => of(appId).filter((i) => i.kind !== 'badge')
  assert.equal(of('dsh').find((i) => i.kind === 'badge').badge, 2)
  assert.equal(strip('dsh')[0].kind, 'bubble')
  assert.equal(of('piweb').find((i) => i.kind === 'badge').semantic, 'busy')
  assert.equal(strip('piweb')[0].title, '跑完了')
})

test('dsh-sessions adapter：事实模型 → Item，open-session 走共享 executor', async () => {
  class FakeBridge extends EventEmitter {
    factsArray() {
      return [
        { sessionId: 'r1', status: 'running', title: null, cwd: null, runningSince: 1000, finishedAt: null, completed: false },
        { sessionId: 's1', status: 'idle', title: 't', cwd: '/p', runningSince: null, finishedAt: 1000, completed: true },
      ]
    }
  }
  const bridge = new FakeBridge()
  const hub = new SurfaceHub()
  const jumped = []
  const adapter = createDshSessionsAdapter({ bridge, hub })
  adapter.start()
  // executor 从 adapter 上移到 main.js：多连接下共享一个，按 item.appId 路由。这里模拟该接线。
  hub.registerExecutor('open-session', (action, item) => { jumped.push(`${item.appId}/${action.target.sessionId}`); return { ok: true } })

  const items = hub.snapshot()
  assert.equal(items.length, 2)
  const badge = items.find((i) => i.kind === 'badge')
  const bubble = items.find((i) => i.kind === 'bubble')
  assert.equal(badge.badge, 1)
  assert.equal(bubble.title, 't')
  assert.equal(bubble.subtitle, '/p')
  assert.deepEqual(bubble.action, { type: 'open-session', target: { sessionId: 's1' } })

  hub.on('bring-to-front', (id) => jumped.push('front:' + id))
  await hub.dispatchById(bubble.id)
  assert.deepEqual(jumped, ['front:dsh', 'dsh/s1'])
})

test('dsh-sessions adapter：远端连接实例重写 id/appId，与本地条目互不碰撞', () => {
  class FakeBridge extends EventEmitter {
    factsArray() {
      return [{ sessionId: 's1', status: 'idle', title: 't', cwd: '/p', runningSince: null, finishedAt: 1000, completed: true }]
    }
  }
  const hub = new SurfaceHub()
  const local = createDshSessionsAdapter({ bridge: new FakeBridge(), hub })
  const remote = createDshSessionsAdapter({ bridge: new FakeBridge(), hub, appId: 'app-1' })
  local.start()
  remote.start()

  const items = hub.snapshot()
  const localBubble = items.find((i) => i.id === 'dsh:fin:s1')
  const remoteBubble = items.find((i) => i.id === 'app-1:dsh:fin:s1')
  assert.ok(localBubble && remoteBubble)
  assert.equal(localBubble.appId, 'dsh')
  assert.equal(remoteBubble.appId, 'app-1')
  assert.equal(remoteBubble.title, 't')

  // stop：摘掉本来源条目，不影响本地
  remote.stop()
  const after = hub.snapshot()
  assert.ok(!after.some((i) => i.id.startsWith('app-1:')))
  assert.ok(after.some((i) => i.id === 'dsh:fin:s1'))
  local.stop()
})
