import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shellCanSeeApp,
  createPendingSticky,
  createFinishedUnseenTracker,
  projectDshFactsWithAttention,
  syncAttentionRunning,
} from '../lib/surface/attention.js'

function mockWin({ visible = true, minimized = false, focused = true } = {}) {
  return {
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
    isDestroyed: () => false,
  }
}

function proj(canSee, cleared, sticky, tracker, facts) {
  return projectDshFactsWithAttention(canSee, cleared, sticky, tracker, facts)
}

test('shellCanSeeApp：获焦 + 前台可见且无浮层才为 true', () => {
  const win = mockWin()
  assert.equal(shellCanSeeApp(win, 'dsh', false, 'dsh'), true)
  assert.equal(shellCanSeeApp(mockWin({ focused: false }), 'dsh', false, 'dsh'), false)
})

test('启动首轮：历史 idle 不因 finishedAt 误出红泡', () => {
  const sticky = createPendingSticky()
  const tracker = createFinishedUnseenTracker()
  const facts = [{ sessionId: 's1', status: 'idle', finishedAt: 100, completed: false }]
  assert.equal(proj(false, new Set(), sticky, tracker, facts)[0].completed, false)
  // 第二轮仍是旧 idle，仍不出
  assert.equal(proj(false, new Set(), sticky, tracker, facts)[0].completed, false)
})

test('后台 running→idle 才出红泡（client completed=false 也补）', () => {
  const sticky = createPendingSticky()
  const tracker = createFinishedUnseenTracker()
  proj(true, new Set(), sticky, tracker, [{ sessionId: 's1', status: 'running' }])
  const out = proj(false, new Set(), sticky, tracker, [
    { sessionId: 's1', status: 'idle', finishedAt: 200, completed: false },
  ])
  assert.equal(out[0].completed, true)
})

test('点过气泡 / cleared 后不再 completed', () => {
  const sticky = createPendingSticky()
  const tracker = createFinishedUnseenTracker()
  proj(true, new Set(), sticky, tracker, [{ sessionId: 's1', status: 'running' }])
  proj(false, new Set(), sticky, tracker, [{ sessionId: 's1', status: 'idle', finishedAt: 1, completed: false }])
  const out = proj(false, new Set(['s1']), sticky, tracker, [
    { sessionId: 's1', status: 'idle', finishedAt: 1, completed: false },
  ])
  assert.equal(out[0].completed, false)
})

test('cleared 在前台（canSee=true）也生效：点气泡 = 显式看过', () => {
  const sticky = createPendingSticky()
  const tracker = createFinishedUnseenTracker()
  // 前台、client 仍报 completed:true（如会话已删无人回传 / 同步丢失）：点过的必须能消
  const facts = [{ sessionId: 's1', status: 'idle', finishedAt: 1, completed: true }]
  assert.equal(proj(true, new Set(), sticky, tracker, facts)[0].completed, true)
  assert.equal(proj(true, new Set(['s1']), sticky, tracker, facts)[0].completed, false)
  // 未点过的其它会话不受影响
  const two = [...facts, { sessionId: 's2', status: 'idle', finishedAt: 2, completed: true }]
  const out = proj(true, new Set(['s1']), sticky, tracker, two)
  assert.equal(out.find((f) => f.sessionId === 's1').completed, false)
  assert.equal(out.find((f) => f.sessionId === 's2').completed, true)
})

test('pendingSticky：后台补回 client 清掉的 pendingInteraction', () => {
  const sticky = createPendingSticky()
  const tracker = createFinishedUnseenTracker()
  proj(true, new Set(), sticky, tracker, [{ sessionId: 's1', status: 'running', pendingInteraction: 'approval' }])
  const out = proj(false, new Set(), sticky, tracker, [
    { sessionId: 's1', status: 'running', pendingInteraction: null },
  ])
  assert.equal(out[0].pendingInteraction, 'approval')
})

test('syncAttentionRunning：新一轮 running 清掉粘性集', () => {
  const cleared = new Set(['s1'])
  syncAttentionRunning(cleared, [{ sessionId: 's1', status: 'running' }])
  assert.equal(cleared.has('s1'), false)
})
