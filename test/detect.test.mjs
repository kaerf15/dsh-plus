// detect-dsh 模块测试：验证「无论 dsh web 起在哪个端口都能被找到」
// 跑法：cd dsh-plus && node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const detect = require('../lib/detect-dsh.js')

const DSH_HTML = '<!doctype html><html><head><title>DeepSeek Harness</title></head><body>fake dsh</body></html>'

// 起一个特征与 dsh web 一致的假服务，端口由 OS 随机分配（模拟"任意端口"）
function startMockDsh() {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(DSH_HTML)
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

// netstat 反映新监听端口可能有微小延迟；等端口进入监听列表再扫描，避免时序偶发
async function waitPortListed(port, deadlineMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if ((await detect.listLocalListenPorts()).includes(port)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

test('isDshOnPort 能识别 dsh 特征页面，服务关闭后识别为 false', async () => {
  const { srv, port } = await startMockDsh()
  try {
    assert.equal(await detect.isDshOnPort(port), true, `端口 ${port} 应被识别为 dsh`)
  } finally {
    srv.close()
  }
  assert.equal(await detect.isDshOnPort(port), false, '关闭后不应再是 dsh')
})

test('listLocalListenPorts 能看到任意端口上的服务', async () => {
  const { srv, port } = await startMockDsh()
  try {
    // 轮询 netstat：磁盘/系统调度偶发让 netstat 快照晚于 listen 就绪
    assert.ok(await waitPortListed(port, 8000), `监听列表应包含随机端口 ${port}`)
  } finally {
    srv.close()
  }
})

test('findDshPort 在非默认端口也能找到 dsh 服务（关键用例）', async () => {
  const { srv, port } = await startMockDsh()
  try {
    // 注入固定端口列表走扫描分支，不依赖真实 netstat（消除快照竞态）
    const found = await detect.findDshPort({ preferredPort: 1, listPorts: async () => [port] })
    assert.equal(found, port, `扫描应找到 ${port}`)
    assert.equal(await detect.isDshOnPort(found), true, `找到的 ${found} 应真是 dsh`)
  } finally {
    srv.close()
  }
})

test('扫描无结果时的兜底行为（无服务则 null，或找到真实 dsh）', async () => {
  const found = await detect.findDshPort({ preferredPort: 65530, listPorts: async () => [] })
  assert.equal(found, null, '无监听端口时应返回 null')
})

// ---- 加固点测试 ----

test('多特征识别：只有脚本路径特征（无 title）也能认出来', async () => {
  const html = '<!doctype html><html><body><script src="/deepseek-ai/dsh-client-modules/client.js?rev=x"></script></body></html>'
  assert.equal(detect.isDshBody(html), true, '脚本路径特征应命中')
  assert.equal(detect.isDshBody('<title>DeepSeek Harness</title>'), true, 'title 特征应命中')
  assert.equal(detect.isDshBody('<html><body>hello world</body></html>'), false, '无关页面不应命中')
})

test('waitForHttpReady：壳自拉实例只等 HTTP 响应，不信特征', async () => {
  const { srv, port } = await startMockDsh()
  try {
    assert.equal(await detect.waitForHttpReady(port, 5000), true, `端口 ${port} 有 HTTP 响应应就绪`)
  } finally {
    srv.close()
  }
  assert.equal(await detect.waitForHttpReady(port, 1000), false, '服务关闭后不应就绪')
})

test('特征可配置：官方改掉默认特征时，用自定义签名仍能找到（救场路径）', async () => {
  // 模拟官方改版：新页面完全没有默认特征
  const newHtml = '<!doctype html><html><head><title>New DSH UI</title></head><body>v-next</body></html>'
  const srv = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(newHtml)
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = srv.address().port
  try {
    // 默认签名：认不出
    assert.equal(await detect.isDshOnPort(port, 1500, detect.getSignatures({})), false, '默认签名不应误认新版页面')
    // 自定义签名：认得出（等价 DSH_SHELL_SIGNATURES 环境变量）
    assert.equal(await detect.isDshOnPort(port, 1500, ['New DSH UI']), true, '自定义签名应认出新版页面')
    // 自定义签名还能让 findDshPort 直接找到它（preferred=1 强制走扫描）
    assert.equal(await detect.isDshOnPort(port, 1500, ['New DSH UI']), true, '自定义签名应认出新版页面')
    // 注入固定端口列表，走扫描分支但不依赖真实 netstat
    const found = await detect.findDshPort({ preferredPort: 1, signatures: ['New DSH UI'], listPorts: async () => [port] })
    assert.equal(found, port, `自定义签名扫描应找到 ${port}`)
  } finally {
    srv.close()
  }
})

test('winListenPid：127.0.0.1 / 0.0.0.0 / [::1] / [::] 都能取到 PID，80 不误配 8080', () => {
  assert.equal(detect.winListenPid('  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       1234', 3080), 1234)
  assert.equal(detect.winListenPid('  TCP    0.0.0.0:3080           0.0.0.0:0              LISTENING       5678', 3080), 5678)
  assert.equal(detect.winListenPid('  TCP    [::1]:3080             [::]:0                 LISTENING       9012', 3080), 9012)
  assert.equal(detect.winListenPid('  TCP    [::]:3080              [::]:0                 LISTENING       3456', 3080), 3456)
  assert.equal(detect.winListenPid('  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       111', 80), 0)
  assert.equal(detect.winListenPid('  TCP    10.0.0.1:3080          0.0.0.0:0              LISTENING       222', 3080), 0)
  assert.equal(detect.winListenPid('  TCP    127.0.0.1:3080         0.0.0.0:0              ESTABLISHED     333', 3080), 0)
})

test('0.1.2+ 未认证应答也认作 dsh：401 + 正文恰好 unauthorized', async () => {
  // 模拟 0.1.2 的 browser-auth：无 cookie 的 / 返回 401 "unauthorized"
  const srv = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = srv.address().port
  try {
    assert.equal(await detect.isDshOnPort(port), true, '0.1.2 的 401 应答应识别为 dsh')
  } finally {
    srv.close()
  }
  // 纯函数面：状态码不对或正文不含已知文案都不算
  assert.equal(detect.isDshUnauthorized(401, 'unauthorized'), true)
  assert.equal(detect.isDshUnauthorized(401, 'unauthorized\n'), true)
  // alpha.2 起 browser-auth 的实际 401 文案
  assert.equal(detect.isDshUnauthorized(401, 'dsh web authentication required; reopen the URL printed by dsh web.\n'), true)
  assert.equal(detect.isDshUnauthorized(200, 'unauthorized'), false)
  assert.equal(detect.isDshUnauthorized(401, 'unauthorized access denied'), false)
})