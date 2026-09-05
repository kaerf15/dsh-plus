// dsh-plus-surface launch.json 辅助函数
// 跑法：cd dsh-plus && node --test test/surface-launch.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress, tokenFromAuthenticatedUrl } from '../plugins/dsh-plus-surface/index.js'

test('isLoopbackAddress：IPv4 / IPv6 / 映射 IPv4；不认空串和外网', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.2'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('localhost'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('10.0.0.2'), false)
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(null), false)
})

test('tokenFromAuthenticatedUrl：抽出 token；无 token / 坏 URL → null', () => {
  assert.equal(tokenFromAuthenticatedUrl('http://127.0.0.1/?token=abc'), 'abc')
  assert.equal(tokenFromAuthenticatedUrl('http://127.0.0.1/'), null)
  assert.equal(tokenFromAuthenticatedUrl('not a url'), null)
})
