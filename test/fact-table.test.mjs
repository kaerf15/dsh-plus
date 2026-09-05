// 跑法：cd dsh-plus && node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FactTable } = require('../lib/surface/fact-table.js')

test('capIdle：淘汰 idle 事实时连同 cleared 痕迹一起清（防慢漏 + 防陈年条目压新气泡）', () => {
  const t = new FactTable()
  // 5 条 idle + 1 条 running，cap 3 → 最老的 2 条 idle 被淘汰
  for (let i = 1; i <= 5; i++) {
    t.facts.set(`s${i}`, { status: 'idle', finishedAt: i, completed: true })
    t.cleared.add(`s${i}`) // 都点过
  }
  t.facts.set('run1', { status: 'running', runningSince: 99, completed: false })
  t.capIdle(3)
  assert.deepEqual([...t.facts.keys()].sort(), ['run1', 's3', 's4', 's5'])
  assert.deepEqual([...t.cleared].sort(), ['s3', 's4', 's5'], '被淘汰的 s1/s2 不应留下 cleared 痕迹')
  // running 永远不被淘汰
  assert.equal(t.facts.get('run1').status, 'running')
})

test('markViewed → factsArray 现算 completed=false；cleared 对未知 id 无副作用', () => {
  const t = new FactTable()
  t.facts.set('a', { status: 'idle', finishedAt: 1, completed: true })
  assert.equal(t.factsArray()[0].completed, true)
  t.markViewed('a')
  assert.equal(t.factsArray()[0].completed, false)
  t.markViewed('ghost')
  assert.equal(t.factsArray().length, 1)
})
