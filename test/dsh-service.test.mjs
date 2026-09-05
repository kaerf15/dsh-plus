// 跑法：cd dsh-plus && node --test test/dsh-service.test.mjs
// 只覆盖纯函数身份判定；进程/端口操作靠真机验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeDshCommand } from '../lib/dsh-service.js'

test('looksLikeDshCommand：本机 dsh web 监听者（macOS 实态）', () => {
  assert.equal(looksLikeDshCommand('node /opt/homebrew/bin/dsh web --port 3080 --no-open'), true)
  assert.equal(looksLikeDshCommand('node /Users/x/.local/bin/dsh web --port 13080 --no-open'), true)
})

test('looksLikeDshCommand：Windows shell 包装（dsh.cmd）', () => {
  assert.equal(looksLikeDshCommand('cmd.exe /c "dsh.cmd" web --port 3080 --no-open'), true)
})

test('looksLikeDshCommand：隧道与无关进程不匹配', () => {
  assert.equal(looksLikeDshCommand('ssh -L 3081:127.0.0.1:3080 user@home'), false)
  assert.equal(looksLikeDshCommand('tailscale serve --bg http://127.0.0.1:3080'), false)
  assert.equal(looksLikeDshCommand('node /app/server.js'), false)
  assert.equal(looksLikeDshCommand(''), false)
})

test('looksLikeDshCommand：dsh 但非 web 子命令不算（tui 等不接管端口）', () => {
  assert.equal(looksLikeDshCommand('node /opt/homebrew/bin/dsh tui'), false)
})
