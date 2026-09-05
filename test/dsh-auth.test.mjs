// dsh-auth 模块测试：0.1.2+ launch token 宣告解析与 cookie 换取
// 跑法：cd dsh-plus && node --test test/dsh-auth.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const auth = require('../lib/dsh-auth.js')

test('parseAnnounceLine：0.1.1 裸 URL 与 0.1.2 带 token URL 都能解析', () => {
  assert.equal(
    auth.parseAnnounceLine('[dsh] dsh web: http://127.0.0.1:3080/'),
    'http://127.0.0.1:3080/',
  )
  assert.equal(
    auth.parseAnnounceLine('dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.5:3080/?token=abc123)'),
    'http://127.0.0.1:3080/?token=abc123',
  )
  // 「dsh web: opening the default browser…」这类行安全返回 null
  assert.equal(auth.parseAnnounceLine('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(auth.parseAnnounceLine('完全不相关的一行'), null)
  assert.equal(auth.parseAnnounceLine(null), null)
})

test('scanAnnounceUrl：跨多次启动的日志取最后一次宣告', () => {
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=old-token',
    'some other log',
    'dsh web: http://127.0.0.1:3081/?token=new-token (LAN: http://10.0.0.2:3081/?token=new-token)',
  ].join('\n')
  assert.equal(auth.scanAnnounceUrl(log), 'http://127.0.0.1:3081/?token=new-token')
  assert.equal(auth.scanAnnounceUrl(''), null)
})

test('extractLaunchToken / stripToken / coerceLaunchToken', () => {
  assert.equal(auth.extractLaunchToken('http://127.0.0.1:3080/?token=abc'), 'abc')
  assert.equal(auth.extractLaunchToken('http://127.0.0.1:3080/'), null)
  assert.equal(auth.extractLaunchToken('not a url'), null)
  assert.equal(auth.stripToken('http://127.0.0.1:3080/?token=abc'), 'http://127.0.0.1:3080/')
  assert.equal(auth.stripToken('http://127.0.0.1:3080/?a=1&token=abc&b=2'), 'http://127.0.0.1:3080/?a=1&b=2')
  // 端口映射：对端打印 :3080，壳访问 :3090——只取 token，不跟 host
  assert.equal(
    auth.coerceLaunchToken('http://127.0.0.1:3080/?token=abcdefghijklmnopqrstuv'),
    'abcdefghijklmnopqrstuv',
  )
  assert.equal(auth.coerceLaunchToken('abcdefghijklmnopqrstuv'), 'abcdefghijklmnopqrstuv')
  assert.equal(auth.coerceLaunchToken('short'), null)
  assert.equal(auth.coerceLaunchToken(''), null)
})

test('setCookieToHeader / splitCookieHeader', () => {
  const setCookie = 'dsh-auth-127_0_0_1_3080=v1.payload.sig; Max-Age=2592000; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict'
  assert.equal(auth.setCookieToHeader(setCookie), 'dsh-auth-127_0_0_1_3080=v1.payload.sig')
  assert.equal(auth.setCookieToHeader(''), null)
  assert.deepEqual(auth.splitCookieHeader('a=b'), { name: 'a', value: 'b' })
  assert.equal(auth.splitCookieHeader('novalue'), null)
})

test('mintCookieHeader：303 + set-cookie → cookie 头；无 set-cookie / 失败 → null', async () => {
  const header = await auth.mintCookieHeader('http://127.0.0.1:3080', 'tok', async (url, opts) => {
    assert.ok(String(url).startsWith('http://127.0.0.1:3080/?token=tok'))
    assert.equal(opts.redirect, 'manual')
    return { headers: { get: (k) => (k === 'set-cookie' ? 'dsh-auth-x=v1.a.b; Path=/; HttpOnly' : null) } }
  })
  assert.equal(header, 'dsh-auth-x=v1.a.b')

  // 旧版（无闸门）：303/200 但没有 set-cookie
  assert.equal(await auth.mintCookieHeader('http://127.0.0.1:3080', 'tok', async () => ({ headers: { get: () => null } })), null)
  // 网络失败
  assert.equal(await auth.mintCookieHeader('http://127.0.0.1:3080', 'tok', async () => { throw new Error('down') }), null)
  // 缺参数
  assert.equal(await auth.mintCookieHeader('', 'tok'), null)
  assert.equal(await auth.mintCookieHeader('http://x', ''), null)
})

test('fetchLaunchToken：插件 200 + token → 取出；404 / 坏 JSON / 失败 → null', async () => {
  assert.equal(
    await auth.fetchLaunchToken('http://127.0.0.1:3090', async (url) => {
      assert.equal(url, 'http://127.0.0.1:3090/dsh-plus-surface/launch.json')
      return { ok: true, json: async () => ({ token: 'launch-tok' }) }
    }),
    'launch-tok',
  )
  assert.equal(await auth.fetchLaunchToken('http://127.0.0.1:3090', async () => ({ ok: false })), null)
  assert.equal(await auth.fetchLaunchToken('http://127.0.0.1:3090', async () => ({ ok: true, json: async () => ({}) })), null)
  assert.equal(await auth.fetchLaunchToken('http://127.0.0.1:3090', async () => { throw new Error('down') }), null)
  assert.equal(await auth.fetchLaunchToken(''), null)
})

test('mintCookieFromPlugin：先取 token 再换 cookie', async () => {
  const calls = []
  const header = await auth.mintCookieFromPlugin('http://127.0.0.1:3090', async (url, opts) => {
    calls.push(String(url))
    if (String(url).includes('launch.json')) return { ok: true, json: async () => ({ token: 'tok-1' }) }
    assert.equal(opts.redirect, 'manual')
    return { headers: { get: (k) => (k === 'set-cookie' ? 'dsh-auth-x=v1.a.b; Path=/' : null) } }
  })
  assert.equal(header, 'dsh-auth-x=v1.a.b')
  assert.ok(calls[0].endsWith('/dsh-plus-surface/launch.json'))
  assert.ok(calls[1].includes('token=tok-1'))
})
