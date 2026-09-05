// 跑法：cd dsh-plus && node --test test/piweb-service.test.mjs
// 只覆盖纯函数身份判定；进程/端口操作靠真机验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPiWebCommand, PiWebService } from '../lib/piweb-service.js'
import detect from '../lib/detect-dsh.js'

test('classifyPiWebCommand：next-server 子进程 + pi-web wrapper 父进程 → piweb（本机实态）', () => {
  assert.equal(classifyPiWebCommand('next-server (v16.3.1)', 'node /opt/homebrew/bin/pi-web'), 'piweb')
})

test('classifyPiWebCommand：wrapper 本体 → piweb', () => {
  assert.equal(classifyPiWebCommand('node /opt/homebrew/bin/pi-web', ''), 'piweb')
  assert.equal(classifyPiWebCommand('node /Users/x/.local/bin/pi-web --port 30141', ''), 'piweb')
})

test('classifyPiWebCommand：直接 next start 拉起 → piweb', () => {
  assert.equal(classifyPiWebCommand('node /app/node_modules/next/dist/bin/next start -p 30141', ''), 'piweb')
  assert.equal(classifyPiWebCommand('next-server (v16.3.1)', 'node /app/node_modules/next/dist/bin/next start -p 30141'), 'piweb')
})

test('classifyPiWebCommand：dev 模式一票否决（重拉会变生产版）', () => {
  assert.equal(classifyPiWebCommand('node /repo/node_modules/next/dist/bin/next dev -p 30141', ''), 'dev')
  assert.equal(classifyPiWebCommand('next-server (v16.3.1)', 'node /repo/node_modules/next/dist/bin/next dev -p 30141'), 'dev')
})

test('classifyPiWebCommand：Windows 带引号的 CommandLine（WMI 实态）', () => {
  assert.equal(classifyPiWebCommand('node "C:\\Users\\x\\npm\\node_modules\\@agegr\\pi-web\\bin\\pi-web.js" --port 30141', ''), 'piweb')
  assert.equal(classifyPiWebCommand('C:\\Windows\\System32\\cmd.exe /c pi-web.cmd --port 30141', ''), 'piweb')
  assert.equal(classifyPiWebCommand('node.exe C:\\repo\\node_modules\\next\\dist\\bin\\next start -p 30141 -H 127.0.0.1', ''), 'piweb')
  assert.equal(classifyPiWebCommand('node "C:\\repo\\node_modules\\next\\dist\\bin\\next" dev -p 30141', ''), 'dev')
})

test('classifyPiWebCommand：隧道与无关进程 → other', () => {
  assert.equal(classifyPiWebCommand('ssh -L 30141:127.0.0.1:30141 user@home', ''), 'other')
  assert.equal(classifyPiWebCommand('tailscale serve --bg http://127.0.0.1:30141', ''), 'other')
  assert.equal(classifyPiWebCommand('node /app/server.js', ''), 'other')
})

test('classifyPiWebCommand：next-server 但父进程不明 → other（从严，不赌）', () => {
  assert.equal(classifyPiWebCommand('next-server (v16.3.1)', ''), 'other')
  assert.equal(classifyPiWebCommand('', ''), 'other')
})

// ---------- restart 漂移接管闸门：打实例方法桩，只验决策路径（进程操作仍靠真机验收） ----------

const silentLog = { log() {}, error() {} }

function stubbedService({ onPort, found }) {
  const svc = new PiWebService({ log: silentLog })
  svc.isPiWebOnPort = onPort
  svc.findLocalPiWebPort = found == null ? async () => 0 : async () => found
  // 杀掉后续 IO 路径的保险：漂移闸门必须在这些之前返回
  svc.killByPort = () => { throw new Error('不应走到杀进程') }
  svc.spawn = async () => { throw new Error('不应走到拉起') }
  return svc
}

test('restart：记忆端口无 pi-web、扫到别的本机实例 → 默认拒绝（port-drift），不动进程', async () => {
  const svc = stubbedService({ onPort: async () => false, found: 30141 })
  const r = await svc.restart(3090) // 3090 = 映射条目本地端口，30141 = 本机不相干实例
  assert.equal(r.ok, false)
  assert.equal(r.code, 'port-drift')
  assert.equal(r.foundUrl, 'http://127.0.0.1:30141')
  assert.match(r.message, /3090/)
})

test('restart：记忆端口健在且是 pi-web → 不走漂移闸门（target=记忆端口）', async () => {
  const svc = stubbedService({ onPort: async () => true, found: null })
  svc.classifyListener = async () => 'piweb'
  // 记忆端口是 pi-web：会走到 kill，把护栏换成记录器验证 target 未漂移
  let killedPort = 0
  svc.killByPort = (p) => { killedPort = p; throw new Error('到此为止') }
  await assert.rejects(svc.restart(30141), /到此为止/)
  assert.equal(killedPort, 30141)
})

test('restart：扫描一无所获 → 不触发闸门（按已停止处理，走原地拉起）', async () => {
  const svc = stubbedService({ onPort: async () => false, found: null })
  let spawned = 0
  svc.spawn = async (p) => { spawned = p; throw new Error('到此为止') }
  svc.killByPort = () => []
  const origPortOpen = detect.portOpen
  detect.portOpen = async () => false // 防真机 3090 恰好被占导致提前返回
  try {
    await assert.rejects(svc.restart(3090), /到此为止/)
    assert.equal(spawned, 3090)
  } finally {
    detect.portOpen = origPortOpen
  }
})
