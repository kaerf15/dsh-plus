// dsh web 自动检测（纯 Node，无 electron 依赖，可独立测试）
// 识别依据：dsh web 首页 HTML 命中下列任一特征（官方改掉单个也不影响认亲）
'use strict'

const http = require('node:http')
const net = require('node:net')
const { execFile } = require('node:child_process')

const DEFAULT_SIGNATURES = [
  '<title>DeepSeek Harness</title>',
  'deepseek-ai/dsh-api-gateway',
  'deepseek-ai/dsh-client-modules',
  'deepseek-ai/dsh-client-connection',
]

// 特征可配置：DSH_SHELL_SIGNATURES=逗号分隔覆盖默认（官方改了特征时用环境变量救场）
function getSignatures(env = process.env) {
  const raw = env.DSH_SHELL_SIGNATURES
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return [...DEFAULT_SIGNATURES]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- TCP 端口连通 ----------
function portOpen(host, portToCheck, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(portToCheck) })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

// ---------- HTTP 探测：取回 body（或 null） ----------
function probeHttpBody(port, timeoutMs = 1500) {
  return probeHttp(port, timeoutMs).then((r) => (r ? r.body : null))
}

/** 取回 { status, body }；网络失败返回 null。0.1.2 起未带 cookie 的 / 是 401，识别要看状态码。 */
function probeHttp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: Number(port),
      path: '/',
      timeout: timeoutMs,
      headers: { Accept: 'text/html' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 50000) { req.destroy(); resolve({ status: res.statusCode, body }) }
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

function isDshBody(body, signatures = getSignatures()) {
  return typeof body === 'string' && signatures.some((sig) => body.includes(sig))
}

/**
 * 0.1.2+ 的未认证应答：状态 401 + browser-auth 的固定文案。
 * 已知两种：早期构建的 "unauthorized"；alpha.2 起的
 * "dsh web authentication required; reopen the URL printed by dsh web."。
 * 不做宽泛的 401 即认，避免把别的 401 服务误认成 dsh。
 */
function isDshUnauthorized(status, body) {
  if (status !== 401 || typeof body !== 'string') return false
  const b = body.trim()
  return b === 'unauthorized' || b.startsWith('dsh web authentication required')
}

async function isDshOnPort(port, timeoutMs = 1500, signatures = getSignatures()) {
  const r = await probeHttp(port, timeoutMs)
  if (!r) return false
  return isDshBody(r.body, signatures) || isDshUnauthorized(r.status, r.body)
}

// ---------- 列出本机 127.0.0.1 上的监听端口（跨平台 netstat） ----------
function listLocalListenPorts() {
  const isWin = process.platform === 'win32'
  const args = isWin ? ['-ano'] : ['-an', '-p', 'tcp']
  return new Promise((resolve) => {
    execFile('netstat', args, { windowsHide: true }, (err, stdout) => {
      const ports = new Set()
      if (!err && stdout) {
        for (const line of stdout.split('\n')) {
          if (!/LISTEN/i.test(line)) continue
          // 匹配本地监听地址 + 端口：127.0.0.1（默认）/ 0.0.0.0 / *（通配 IPv4）；分隔符 . 或 :（跨平台）
          const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1\]|\[::\])[:.](\d{1,5})(?!\d)/)
          if (m) {
            const p = Number(m[1])
            if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p)
          }
        }
      }
      resolve([...ports])
    })
  })
}

// 带并发上限的 map，返回第一个非空结果（按 items 顺序）
function mapFindFirst(items, limit, fn) {
  return new Promise((resolve) => {
    let index = 0
    let active = 0
    let done = 0
    let settled = false
    const results = new Array(items.length)
    const next = () => {
      if (settled) return
      if (done === items.length) {
        settled = true
        const hit = results.find((r) => r !== null && r !== undefined)
        resolve(hit === undefined ? null : hit)
        return
      }
      while (active < limit && index < items.length) {
        const i = index++
        active++
        Promise.resolve()
          .then(() => fn(items[i]))
          .then((r) => { results[i] = r ?? null })
          .catch(() => { results[i] = null })
          .finally(() => { active--; done++; next() })
      }
    }
    next()
  })
}

// ---------- 核心：找 dsh web 端口 ----------
// 1) 先试默认端口；2) 再扫本机所有监听端口；找不到返回 null
async function findDshPort({ preferredPort = 3080, probeTimeoutMs = 1500, concurrency = 8, signatures = getSignatures(), listPorts = listLocalListenPorts } = {}) {
  const tried = new Set()
  if (await isDshOnPort(preferredPort, probeTimeoutMs, signatures)) return preferredPort
  tried.add(preferredPort)

  let ports
  try {
    ports = (await listPorts()).filter((p) => !tried.has(p))
  } catch {
    ports = []
  }
  if (ports.length === 0) return null

  const found = await mapFindFirst(ports, concurrency, (p) => isDshOnPort(p, probeTimeoutMs, signatures).then((ok) => (ok ? p : null)))
  return found || null
}

// ---------- 找一个空闲端口（从 start 往上） ----------
async function pickFreePort(start = 3080, maxTries = 200) {
  for (let p = start; p < start + maxTries; p++) {
    if (!(await portOpen('127.0.0.1', p, 300))) return p
  }
  return 0
}

// ---------- HTTP 就绪探测：端口上有 HTTP 响应（2xx/3xx/4xx 都算） ----------
// 供"壳自己拉起的实例"使用：端口是壳选的，不信特征，只等服务起来
function probeHttpStatus(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: Number(port),
      path: '/',
      timeout: timeoutMs,
    }, (res) => {
      res.resume()
      const ok = res.statusCode >= 200 && res.statusCode < 500
      req.destroy()
      resolve(ok)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

async function waitForHttpReady(port, deadlineMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (await probeHttpStatus(port, 700)) return true
    await sleep(500)
  }
  return false
}

/**
 * Windows netstat -ano 一行 → 若该行是「本机正在听 port」则返回 PID，否则 0。
 * 认 127.0.0.1 / 0.0.0.0 / [::1] / [::]，端口用 (?!\d) 避免 80 误配 8080。
 */
function winListenPid(line, port) {
  if (!line || !/LISTENING/i.test(line)) return 0
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0 || p >= 65536) return 0
  const re = new RegExp(String.raw`(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):${p}(?!\d)`)
  if (!re.test(line)) return 0
  const m = String(line).match(/(\d+)\s*$/)
  return m ? Number(m[1]) : 0
}

module.exports = {
  DEFAULT_SIGNATURES,
  getSignatures,
  portOpen,
  probeHttpBody,
  probeHttp,
  probeHttpStatus,
  isDshBody,
  isDshUnauthorized,
  isDshOnPort,
  listLocalListenPorts,
  findDshPort,
  pickFreePort,
  waitForHttpReady,
  winListenPid,
  mapFindFirst,
}