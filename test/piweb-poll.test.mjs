// 跑法：cd dsh-plus && node --test test/*.test.mjs
// pi-web HTTP 轮询事实源：远端/未装插件的 pi-web，按 runningSessionIds 迁移推断。
import test from 'node:test'
import assert from 'node:assert/strict'
import { PiWebPollSource } from '../lib/surface/piweb-poll.js'

function makeSource() {
  return new PiWebPollSource({ baseUrl: 'http://127.0.0.1:3082', log: () => {}, fetchFn: async () => ({ ok: false }) })
}

function body(sessions, runningSessionIds) {
  return { sessions, runningSessionIds }
}

const S = (id, over = {}) => ({ id, name: `会话${id}`, cwd: `/p/${id}`, ...over })

test('running 迁移：进 runningSessionIds → running；离开 → idle + completed', () => {
  const src = makeSource()
  src.adopt(body([S('a'), S('b')], ['a']))
  let facts = src.factsArray()
  assert.equal(facts.length, 1) // b 没在跑且未跟踪过：不进表（历史洪水闸门）
  assert.equal(facts[0].sessionId, 'a')
  assert.equal(facts[0].status, 'running')

  src.adopt(body([S('a'), S('b')], ['b'])) // a 结束，b 开跑
  facts = src.factsArray()
  const a = facts.find((f) => f.sessionId === 'a')
  const b = facts.find((f) => f.sessionId === 'b')
  assert.equal(a.status, 'idle')
  assert.equal(a.completed, true)
  assert.ok(a.finishedAt)
  assert.equal(b.status, 'running')
  src.stop()
})

test('标题/cwd 取自会话列表；无名会话用 cwd 末段兜底', () => {
  const src = makeSource()
  src.adopt(body([S('a'), { id: 'b', cwd: '/home/user/proj' }], ['a', 'b']))
  const facts = src.factsArray()
  assert.equal(facts.find((f) => f.sessionId === 'a').title, '会话a')
  assert.equal(facts.find((f) => f.sessionId === 'b').title, 'proj')
  src.stop()
})

test('markViewed 粘性清除 + 新一轮 running 重新武装', () => {
  const src = makeSource()
  src.adopt(body([S('a')], ['a']))
  src.adopt(body([S('a')], [])) // 结束 → completed
  assert.equal(src.factsArray()[0].completed, true)
  src.markViewed('a')
  assert.equal(src.factsArray()[0].completed, false)
  src.adopt(body([S('a')], [])) // 再轮询：粘性不清除……
  assert.equal(src.factsArray()[0].completed, false)
  src.adopt(body([S('a')], ['a'])) // ……直到新一轮 running
  src.adopt(body([S('a')], []))
  assert.equal(src.factsArray()[0].completed, true)
  src.stop()
})

test('会话从列表消失（被删）→ 事实清掉', () => {
  const src = makeSource()
  src.adopt(body([S('a')], ['a']))
  src.adopt(body([], [])) // pi-web 里删了这个会话
  assert.equal(src.factsArray().length, 0)
  src.stop()
})

test('无变化不重播 update', () => {
  const src = makeSource()
  let n = 0
  src.on('update', () => n++)
  src.adopt(body([S('a')], ['a']))
  src.adopt(body([S('a')], ['a']))
  assert.equal(n, 1)
  src.stop()
})

test('正在跑但未入 sessions 列表（未落盘/分页）也要跟踪，且不被误判删除', () => {
  const src = makeSource()
  src.adopt(body([S('a')], ['a', 'ghost'])) // ghost 在跑但列表里没有
  let facts = src.factsArray()
  const ghost = facts.find((f) => f.sessionId === 'ghost')
  assert.ok(ghost)
  assert.equal(ghost.status, 'running')
  assert.equal(ghost.title, 'ghost') // 无元数据：id 兑底
  // 下一轮列表依然没有它，但还在跑：不能被「消失」判定清掉
  src.adopt(body([S('a')], ['a', 'ghost']))
  assert.ok(src.factsArray().some((f) => f.sessionId === 'ghost'))
  // 真正消失 = 列表与 running 双集合都不含
  src.adopt(body([S('a')], ['a']))
  assert.ok(!src.factsArray().some((f) => f.sessionId === 'ghost'))
  src.stop()
})

test('pollOnce：不可达/坏响应静默，保留最后一帧事实', async () => {
  let down = true
  const src = new PiWebPollSource({
    baseUrl: 'http://127.0.0.1:3082',
    log: () => {},
    fetchFn: async () => {
      if (down) throw new Error('tunnel down')
      return { ok: true, json: async () => body([S('a')], ['a']) }
    },
  })
  await src.pollOnce()
  assert.equal(src.factsArray().length, 0)
  down = false
  await src.pollOnce()
  assert.equal(src.factsArray()[0].status, 'running')
  src.stop()
})

test('start() 立即跑一轮（基座 startPolling 走子类 tick，别名 pollOnce）——回归：tick 缺失会让挂源即炸', async () => {
  let calls = 0
  const src = new PiWebPollSource({
    baseUrl: 'http://127.0.0.1:3082',
    log: () => {},
    fetchFn: async () => {
      calls++
      return { ok: true, json: async () => body([S('a')], ['a']) }
    },
  })
  src.start()
  await new Promise((r) => setTimeout(r, 30)) // 首轮 tick 是 async，让落地
  src.stop()
  assert.ok(calls >= 1, 'start() 必须立即触发一轮采集')
  assert.equal(src.factsArray()[0].sessionId, 'a')
})
