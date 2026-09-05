// 跑法：cd dsh-plus && node --test test/*.test.mjs
// 分片目录事实源：多进程应用（pi-web）每进程一片，壳按目录合并。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FactsDirSource } from '../lib/surface/facts-dir.js'

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'facts-dir-'))
}

function writeShard(dir, id, session, { heartbeat = Date.now(), pid = 123 } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${encodeURIComponent(id)}.json`), JSON.stringify({
    protocol: 'dsh-plus.fact', version: 1, domain: 'pi.sessions',
    sessionId: id, pid, heartbeat, updatedAt: heartbeat,
    session,
  }))
}

function makeSource(dir) {
  return new FactsDirSource({ dir, log: () => {} })
}

test('running 且心跳新鲜 → 进行中', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })
  const src = makeSource(dir)
  src.scan()
  const f = src.factsArray()[0]
  assert.equal(f.sessionId, 'p1')
  assert.equal(f.status, 'running')
  assert.equal(f.title, 't')
  src.stop()
})

test('running 但心跳过期 → 折算中断结束（idle + finishedAt=心跳，completed=false）', () => {
  const dir = makeDir()
  const stale = Date.now() - 60000
  writeShard(dir, 'p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false }, { heartbeat: stale })
  const src = makeSource(dir)
  src.scan()
  const f = src.factsArray()[0]
  assert.equal(f.status, 'idle')
  assert.equal(f.finishedAt, stale)
  assert.equal(f.completed, false) // 中断不出完成气泡
  src.stop()
})

test('接入时磁盘上已 idle+completed 的历史片不当成未看（防打开倒出红气泡）', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  writeShard(dir, 'p2', { status: 'idle', runningSince: null, finishedAt: 3000, title: 'u', cwd: '/q', completed: true })
  const src = makeSource(dir)
  src.scan()
  const facts = src.factsArray()
  assert.equal(facts.length, 2)
  assert.equal(facts.every((f) => f.completed === false), true) // 历史完成：接入即看过
  src.stop()
})

test('接入之后新结束的会话仍出完成气泡；markViewed 后重扫不复活', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })
  const src = makeSource(dir)
  src.scan() // 接入时正在跑：不进历史闸门
  assert.equal(src.factsArray()[0].completed, false)
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 4000, title: 't', cwd: '/p', completed: true })
  src.scan()
  assert.equal(src.factsArray()[0].completed, true)
  src.markViewed('p1')
  assert.equal(src.factsArray()[0].completed, false)
  src.scan() // 重扫：分片里还是 completed:true，但 cleared 集粘住
  assert.equal(src.factsArray()[0].completed, false)
  src.stop()
})

test('新一轮 running 沿重新武装 completed', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })
  const src = makeSource(dir)
  src.scan()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  src.scan()
  src.markViewed('p1')
  // 同一 session 又跑起来
  writeShard(dir, 'p1', { status: 'running', runningSince: 3000, finishedAt: null, title: 't', cwd: '/p', completed: false })
  src.scan()
  assert.equal(src.factsArray()[0].status, 'running')
  // 再次结束：completed 恢复 true
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 4000, title: 't', cwd: '/p', completed: true })
  src.scan()
  assert.equal(src.factsArray()[0].completed, true)
  src.stop()
})

test('分片消失 → 事实清掉；目录不存在 → 空表不报错', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  const src = makeSource(dir)
  src.scan()
  assert.equal(src.factsArray().length, 1)
  rmSync(join(dir, 'p1.json'))
  src.scan()
  assert.equal(src.factsArray().length, 0)
  const ghost = makeSource(join(dir, 'no-such-dir'))
  ghost.scan() // 不抛
  assert.equal(ghost.factsArray().length, 0)
  src.stop()
  ghost.stop()
})

test('tmp 文件与非 json 文件被跳过', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  writeFileSync(join(dir, '.123.p1.tmp'), '{"partial":')
  writeFileSync(join(dir, 'notes.txt'), 'hello')
  const src = makeSource(dir)
  src.scan()
  assert.equal(src.factsArray().length, 1)
  src.stop()
})

test('畸形文件名（非法转义序列）不拖垮整轮扫描', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  writeFileSync(join(dir, '100%.json'), '{}') // decodeURIComponent 会抛 URIError
  const src = makeSource(dir)
  src.scan() // 不抛
  assert.equal(src.factsArray().length, 1)
  src.stop()
})

test('事实变化才发 update', () => {
  const dir = makeDir()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  const src = makeSource(dir)
  let n = 0
  src.on('update', () => n++)
  src.scan()
  src.scan() // 文件未重写：updatedAt 不变，key 相同不重播（心跳重写会触发 update，但 Hub 按 Item 再 diff 一道，不吵到显示面）
  assert.equal(n, 1)
  src.stop()
})

test('目录晚出现：第一次读到片时才闸门，历史 completed 仍不出气泡', () => {
  const dir = makeDir()
  const src = makeSource(dir)
  src.scan() // 空目录：不算接入
  writeShard(dir, 'old', { status: 'idle', runningSince: null, finishedAt: 2000, title: 't', cwd: '/p', completed: true })
  src.scan()
  assert.equal(src.factsArray()[0].completed, false)
  src.stop()
})

test('接入时目录为空，之后新跑完的会话仍出气泡', () => {
  const dir = makeDir()
  const src = makeSource(dir)
  src.scan()
  writeShard(dir, 'p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })
  src.scan()
  writeShard(dir, 'p1', { status: 'idle', runningSince: null, finishedAt: 4000, title: 't', cwd: '/p', completed: true })
  src.scan()
  assert.equal(src.factsArray()[0].completed, true)
  src.stop()
})

test('origin 绑定后只投影该 pi-web 会话名单里的片（TUI 分片不串台）', async () => {
  const dir = makeDir()
  writeShard(dir, 'web1', { status: 'running', runningSince: 1000, finishedAt: null, title: 'web', cwd: '/w', completed: false })
  writeShard(dir, 'tui1', { status: 'running', runningSince: 1000, finishedAt: null, title: 'tui', cwd: '/t', completed: false })
  const src = new FactsDirSource({
    dir,
    origin: 'http://127.0.0.1:30141',
    log: () => {},
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ sessions: [{ id: 'web1', name: 'web' }], runningSessionIds: ['web1'] }),
    }),
  })
  src.scan()
  assert.equal(src.factsArray().length, 0) // 名单未到：先不投影
  await src.refreshAllowlist()
  src.scan()
  const facts = src.factsArray()
  assert.equal(facts.length, 1)
  assert.equal(facts[0].sessionId, 'web1')
  src.stop()
})

test('origin：runningSessionIds 里有、sessions 列表还没有的 id 也要认（未落盘）', async () => {
  const dir = makeDir()
  writeShard(dir, 'ghost', { status: 'running', runningSince: 1000, finishedAt: null, title: 'g', cwd: '/g', completed: false })
  const src = new FactsDirSource({
    dir,
    origin: 'http://127.0.0.1:30141',
    log: () => {},
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ sessions: [], runningSessionIds: ['ghost'] }),
    }),
  })
  await src.refreshAllowlist()
  src.scan()
  assert.equal(src.factsArray()[0].sessionId, 'ghost')
  src.stop()
})

// ---------- HTTP 出口模式（serve-facts.mjs 的 shards.json 镜像）：与 fs 同一套归并语义 ----------

function shardEntry(id, session, { heartbeat = Date.now(), pid = 123 } = {}) {
  return {
    name: `${encodeURIComponent(id)}.json`,
    body: {
      protocol: 'dsh-plus.fact', version: 1, domain: 'pi.sessions',
      sessionId: id, pid, heartbeat, updatedAt: heartbeat,
      session,
    },
  }
}

function makeHttpSource(payload, { origin = '', fetchFn = null } = {}) {
  return new FactsDirSource({
    url: 'http://127.0.0.1:3099/pi-dsh-plus-surface/shards.json',
    origin,
    log: () => {},
    fetchFn: fetchFn || (async () => ({ ok: true, json: async () => payload })),
  })
}

test('HTTP 出口：running 且心跳新鲜 → 进行中（与 fs 读法同语义）', async () => {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    shards: [shardEntry('p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })],
  }
  const src = makeHttpSource(payload)
  await src.scanHttp()
  const f = src.factsArray()[0]
  assert.equal(f.sessionId, 'p1')
  assert.equal(f.status, 'running')
  assert.equal(f.title, 't')
  src.stop()
})

test('HTTP 出口：心跳过期 → 折算中断结束；出口跳过坏片（与 fs 同径）', async () => {
  const heartbeat = Date.now() - 60_000
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    shards: [
      shardEntry('dead', { status: 'running', runningSince: 1000, finishedAt: null, title: 'd', cwd: '/d', completed: false }, { heartbeat }),
      shardEntry('done', { status: 'idle', runningSince: null, finishedAt: 4000, title: 'ok', cwd: '/o', completed: true }),
      { name: 'broken.json', body: null }, // 出口读盘失败跳过的片不会出现；壳侧再兜一层
    ],
  }
  const src = makeHttpSource(payload)
  await src.scanHttp()
  const facts = src.factsArray()
  assert.equal(facts.length, 2)
  const dead = facts.find((f) => f.sessionId === 'dead')
  assert.equal(dead.status, 'idle')
  assert.equal(dead.finishedAt, heartbeat) // finishedAt=心跳时刻
  assert.equal(dead.completed, false) // 中断结束不出完成气泡：completed=false
  assert.equal(facts.find((f) => f.sessionId === 'done').completed, false)
  src.stop()
})

test('HTTP 出口：不可达 → 保留最后一帧，不制造假消失', async () => {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    shards: [shardEntry('p1', { status: 'running', runningSince: 1000, finishedAt: null, title: 't', cwd: '/p', completed: false })],
  }
  let up = true
  const src = makeHttpSource(payload, {
    fetchFn: async () => {
      if (!up) throw new Error('refused')
      return { ok: true, json: async () => payload }
    },
  })
  await src.scanHttp()
  assert.equal(src.factsArray().length, 1)
  up = false
  await src.scanHttp()
  assert.equal(src.factsArray().length, 1) // 最后一帧还在
  src.stop()
})

test('HTTP 出口：origin 绑定后同样只投影该实例名单里的片', async () => {
  const shards = [
    shardEntry('web1', { status: 'running', runningSince: 1000, finishedAt: null, title: 'web', cwd: '/w', completed: false }),
    shardEntry('tui1', { status: 'running', runningSince: 1000, finishedAt: null, title: 'tui', cwd: '/t', completed: false }),
  ]
  const src = makeHttpSource(null, {
    origin: 'http://127.0.0.1:30141',
    fetchFn: async (u) => {
      if (String(u).includes('/api/sessions')) {
        return { ok: true, json: async () => ({ sessions: [{ id: 'web1', name: 'web' }], runningSessionIds: ['web1'] }) }
      }
      return { ok: true, json: async () => ({ version: 1, updatedAt: Date.now(), shards }) }
    },
  })
  await src.scanHttp()
  assert.equal(src.factsArray().length, 0) // 名单未到：先不投影
  await src.refreshAllowlist()
  await src.scanHttp()
  const facts = src.factsArray()
  assert.equal(facts.length, 1)
  assert.equal(facts[0].sessionId, 'web1')
  src.stop()
})

test('setUrl 热更出口地址：立即用新地址补一轮（同 DshBridge.setFactsUrl 口径）', async () => {
  const shard = (id) => ({
    name: `${id}.json`,
    body: {
      version: 1, sessionId: id, heartbeat: Date.now(), updatedAt: Date.now(),
      session: { status: 'idle', runningSince: null, finishedAt: 9, title: id.toUpperCase(), cwd: `/${id}`, completed: false },
    },
  })
  const hit = {}
  const src = new FactsDirSource({
    url: 'http://x:1/pi-dsh-plus-surface/shards.json',
    log: () => {},
    fetchFn: async (u) => {
      const key = String(u)
      hit[key] = (hit[key] || 0) + 1
      const id = key.includes(':1/') ? 'a' : 'b'
      return { ok: true, json: async () => ({ version: 1, updatedAt: Date.now(), shards: [shard(id)] }) }
    },
  })
  src.start()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(src.factsArray()[0].sessionId, 'a')
  src.setUrl('http://x:2/pi-dsh-plus-surface/shards.json')
  await new Promise((r) => setTimeout(r, 20))
  src.stop()
  assert.equal(src.factsArray()[0].sessionId, 'b') // 热更后读到新出口
  assert.ok(hit['http://x:2/pi-dsh-plus-surface/shards.json'] >= 1)
})
