import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotifyItem, pickNewNotifiable, createSurfaceNotifications } from '../lib/notifications.js'

const done = { id: 'dsh:fin:s1', appId: 'dsh', kind: 'bubble', semantic: 'done', title: 't' }
const warn = { id: 'dsh:pending:s1', appId: 'dsh', kind: 'bubble', semantic: 'warn', title: 't' }

test('shouldNotifyItem：done/warn 且看不见才通知', () => {
  const see = (id) => id === 'dsh'
  assert.equal(shouldNotifyItem(done, see), false)
  assert.equal(shouldNotifyItem(warn, () => false), true)
  assert.equal(shouldNotifyItem({ ...done, kind: 'badge' }, () => false), false)
})

test('pickNewNotifiable：同一 id 不重复通知，消失后清粘性', () => {
  const notified = new Set()
  const n1 = pickNewNotifiable([done], () => false, notified)
  assert.equal(n1.length, 1)
  notified.add(done.id)
  assert.equal(pickNewNotifiable([done], () => false, notified).length, 0)
  assert.equal(pickNewNotifiable([], () => false, notified).length, 0)
  assert.equal(notified.has(done.id), false)
})

test('sync：关闭时仍 prune；重开后可再提醒', () => {
  let shown = 0
  class MockNotify {
    static isSupported() { return true }
    constructor() { shown++ }
    on() {}
    show() {}
  }
  const enabled = { on: true }
  const svc = createSurfaceNotifications({
    getEnabled: () => enabled.on,
    canSeeApp: () => false,
    onClick: () => {},
    Notify: MockNotify,
  })
  svc.sync([done])
  assert.equal(shown, 1)
  svc.sync([done])
  assert.equal(shown, 1)
  enabled.on = false
  svc.sync([])
  enabled.on = true
  svc.sync([done])
  assert.equal(shown, 2)
})

test('sync：点击回调携带 action 快照（Hub 清空后仍可 dispatch）', () => {
  let clicked = null
  class MockNotify {
    static isSupported() { return true }
    constructor() { this._h = {} }
    on(evt, fn) { this._h[evt] = fn }
    show() { this._h.click?.() }
  }
  const item = {
    id: 'dsh:fin:s1',
    appId: 'dsh',
    kind: 'bubble',
    semantic: 'done',
    title: 't',
    action: { type: 'open-session', target: { sessionId: 's1' } },
  }
  const svc = createSurfaceNotifications({
    getEnabled: () => true,
    canSeeApp: () => false,
    onClick: (snap) => { clicked = snap },
    Notify: MockNotify,
  })
  svc.sync([item])
  assert.equal(clicked.id, 'dsh:fin:s1')
  assert.deepEqual(clicked.action, { type: 'open-session', target: { sessionId: 's1' } })
})

test('sync：getSuppress 为 true 时不发通知', () => {
  let shown = 0
  class MockNotify {
    static isSupported() { return true }
    constructor() { shown++ }
    on() {}
    show() {}
  }
  const svc = createSurfaceNotifications({
    getEnabled: () => true,
    getSuppress: () => true,
    canSeeApp: () => false,
    onClick: () => {},
    Notify: MockNotify,
  })
  svc.sync([done])
  assert.equal(shown, 0)
})
