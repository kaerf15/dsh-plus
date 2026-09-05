// 跑法：cd dsh-plus && node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { quoteWinCmd, spawnArg0, isValidVersion, installFailureMessage, isNetworkFailure } = require('../lib/dsh-manage.js')

test('quoteWinCmd：空格路径加引号，已有引号不重复，干净路径不动', () => {
  assert.equal(quoteWinCmd('dsh.cmd'), 'dsh.cmd')
  assert.equal(quoteWinCmd('C:\\Users\\Foo Bar\\AppData\\Roaming\\npm\\dsh.cmd'), '"C:\\Users\\Foo Bar\\AppData\\Roaming\\npm\\dsh.cmd"')
  assert.equal(quoteWinCmd('"C:\\already\\quoted.cmd"'), '"C:\\already\\quoted.cmd"')
})

test('spawnArg0：非 Windows 原样返回（本机若是 win 则走 quote）', () => {
  const p = 'C:\\Users\\Foo Bar\\dsh.cmd'
  if (process.platform === 'win32') assert.equal(spawnArg0(p), `"${p}"`)
  else assert.equal(spawnArg0(p), p)
})

test('isValidVersion', () => {
  assert.equal(isValidVersion('latest'), true)
  assert.equal(isValidVersion('0.1.1-rc.2'), true)
  assert.equal(isValidVersion('rm -rf /'), false)
})

test('installFailureMessage：EACCES/EPERM 给权限提示，其它给最后一行原始输出', () => {
  const perm = installFailureMessage(1, '', 'npm ERR! Error: EACCES: permission denied, mkdir /usr/local/lib')
  assert.ok(perm.includes('权限不足'))
  assert.ok(perm.includes(process.platform === 'win32' ? '管理员身份' : 'nvm'))

  const ephem = installFailureMessage(1, '', 'npm ERR! code EPERM')
  assert.ok(ephem.includes('权限不足'))

  // 非权限错误：stderr 最后一行原样返回
  assert.equal(installFailureMessage(1, 'out line', 'npm ERR! 404\nnpm ERR! not found'), 'npm ERR! not found')
  // stderr 空时取 stdout；都空时给退出码兜底
  assert.equal(installFailureMessage(1, 'some out', ''), 'some out')
  assert.equal(installFailureMessage(7, '', ''), '安装失败（退出码 7）')
})

test('isNetworkFailure：超时/连接重置类才算网络问题，404/权限不算', () => {
  assert.equal(isNetworkFailure('timeout', '', ''), true)
  assert.equal(isNetworkFailure(1, '', 'npm ERR! network request to https://registry.npmjs.org/ failed, reason: connect ETIMEDOUT'), true)
  assert.equal(isNetworkFailure(1, '', 'npm ERR! code ECONNRESET'), true)
  assert.equal(isNetworkFailure(1, '', 'npm ERR! errno EAI_AGAIN'), true)
  assert.equal(isNetworkFailure(1, '', 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@deepseek-ai%2fdsh'), false)
  assert.equal(isNetworkFailure(1, '', 'npm ERR! code EACCES'), false)
})
