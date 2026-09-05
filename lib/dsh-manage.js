// DSH 安装 / 版本管理（纯 Node，无 electron 依赖，可独立测试）
// 背景：DSH（DeepSeek Harness）通过 npm 全局包 @deepseek-ai/dsh 安装，dsh CLI 暴露 --version。
// 本模块封装：检测是否安装、读当前版本、查最新版本、列全部版本、安装指定版本。
'use strict'

const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const detect = require('./detect-dsh.js')

const PACKAGE = '@deepseek-ai/dsh'
const isWin = process.platform === 'win32'
const NPM = isWin ? 'npm.cmd' : 'npm'
const DSH = isWin ? 'dsh.cmd' : 'dsh'
const USE_SHELL = isWin // Windows 上 .cmd 需要 shell 才能执行
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const MIRROR_REGISTRY = 'https://registry.npmmirror.com' // 国内镜像：网络失败时的自动救援

/** Windows + shell:true 时，路径含空格必须给 argv0 加引号，否则 cmd 会拆成两段。 */
function quoteWinCmd(cmd) {
  const s = String(cmd || '')
  if (!s) return s
  if (s.startsWith('"') && s.endsWith('"')) return s
  return /[\s&()<>^|!]/.test(s) ? `"${s}"` : s
}

function spawnArg0(cmd) {
  return USE_SHELL ? quoteWinCmd(cmd) : cmd
}

// 校验版本号：只允许 semver 或 'latest'，防止命令行注入
function isValidVersion(v) {
  const s = String(v || '').trim()
  return s === 'latest' || /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(s)
}

// ---------- npm registry 解析与网络失败判定 ----------
// 背景：国内直连 npmjs 慢/超时常见。优先尊重用户自己的 npm 配置（很多人已配镜像），
// 失败再自动切 npmmirror 救场。DSH_NPM_REGISTRY 环境变量可显式指定。
let npmRegistryCache = undefined
// 镜像一旦救场成功，进程内后续直连镜像：默认源大概率持续不通，不必每次先吃满超时再回退
let learnedMirror = false

async function getNpmRegistry() {
  if (npmRegistryCache !== undefined) return npmRegistryCache
  const envReg = String(process.env.DSH_NPM_REGISTRY || '').trim()
  if (/^https?:\/\//.test(envReg)) { npmRegistryCache = envReg; return npmRegistryCache }
  const r = await run(NPM, ['config', 'get', 'registry'], { timeoutMs: 10000 })
  const v = (r.stdout || '').trim().split('\n')[0].trim()
  npmRegistryCache = (r.code === 0 && /^https?:\/\//.test(v)) ? v : DEFAULT_REGISTRY
  return npmRegistryCache
}

function isMirrorRegistry(reg) {
  return String(reg || '').replace(/\/+$/, '') === MIRROR_REGISTRY
}

// 网络类失败判定：命中这些才值得换镜像重试（权限/版本不存在等错误重试无意义）
function isNetworkFailure(code, out, err) {
  if (code === 'timeout') return true
  const blob = `${err || ''}\n${out || ''}`
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPROTO|ECONNABORTED|socket hang up|network|timed? ?out|fetch failed/i.test(blob)
}

function run(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code, out, err) => {
      if (!settled) { settled = true; resolve({ code, stdout: out, stderr: err }) }
    }
    let child
    try {
      child = spawn(spawnArg0(cmd), args, { shell: USE_SHELL, windowsHide: true })
    } catch (err) {
      return finish(null, '', err.message)
    }
    const timer = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        finish('timeout', stdout, stderr)
      }
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); finish(null, stdout, err.message) })
    child.on('close', (code) => { clearTimeout(timer); finish(code, stdout, stderr) })
  })
}

// ---------- dsh 可执行文件解析（四层兜底，结果缓存） ----------
// 背景：Finder 启动的壳 PATH 很窄；dsh 可能装在 nvm/volta/asdf 等动态路径里。
// 解析顺序：PATH → 常见安装路径 → npm 全局前缀。找不到返回 null。
let dshBinCache = undefined

function candidateDshPaths() {
  const home = os.homedir()
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      path.join(appData, 'npm', 'dsh.cmd'),
      path.join(pf, 'nodejs', 'dsh.cmd'),
      path.join(pf86, 'nodejs', 'dsh.cmd'),
    ]
  }
  const list = [
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
    path.join(home, '.local', 'bin', 'dsh'),
    path.join(home, '.volta', 'bin', 'dsh'),
    path.join(home, '.asdf', 'shims', 'dsh'),
  ]
  // nvm：~/.nvm/versions/node/<vX>/bin/dsh（逐版本探测）
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node')
    for (const v of fs.readdirSync(nvmDir)) {
      list.push(path.join(nvmDir, v, 'bin', 'dsh'))
    }
  } catch { /* 无 nvm */ }
  return list
}

async function resolveDshBin() {
  if (dshBinCache !== undefined) return dshBinCache
  // 1. PATH 里的 dsh
  const r = await run(DSH, ['--version'], { timeoutMs: 10000 })
  if (r.code === 0 && (r.stdout || '').trim()) { dshBinCache = DSH; return dshBinCache }
  // 2. 常见安装路径逐个试
  for (const p of candidateDshPaths()) {
    if (!fs.existsSync(p)) continue
    const rr = await run(p, ['--version'], { timeoutMs: 10000 })
    if (rr.code === 0 && (rr.stdout || '').trim()) { dshBinCache = p; return p }
  }
  // 3. npm 全局前缀
  const pr = await run(NPM, ['prefix', '-g'], { timeoutMs: 15000 })
  const prefix = (pr.stdout || '').trim().split('\n')[0].trim()
  if (pr.code === 0 && prefix) {
    // Unix：prefix/bin/dsh；Windows：npm 全局 bin 就在 prefix 根下（%APPDATA%\npm\dsh.cmd），没有 bin 子目录
    const candidates = isWin
      ? [path.join(prefix, 'dsh.cmd'), path.join(prefix, 'bin', 'dsh.cmd')]
      : [path.join(prefix, 'bin', 'dsh')]
    for (const p of candidates) {
      if (fs.existsSync(p)) { dshBinCache = p; return p }
    }
  }
  dshBinCache = null
  return null
}

async function getInstalledVersion() {
  const bin = await resolveDshBin()
  if (bin) {
    const r = await run(bin, ['--version'], { timeoutMs: 15000 })
    const version = (r.stdout || '').trim().split('\n')[0].trim()
    if (r.code === 0 && version) return { installed: true, version }
  }
  // 4. CLI 找不到时兜底：已有 dsh web 在跑也算已安装（别的终端环境启动的）
  const port = await detect.findDshPort().catch(() => null)
  if (port) return { installed: true, version: null, running: true }
  return { installed: false, version: null }
}

// 版本 → 发布时间（ms）：唯一一次 npm view time --json，getLatestVersion / listVersions 共用。
// 「最新」锚在发布时间，不看 dist-tag：alpha 等预发布只挂非 latest tag，查 latest 会漏检（0.1.2-alpha.2 教训）。
// 网络失败且当前不是镜像源时，自动用国内镜像重试一次；救场成功后进程内直连镜像（learnedMirror）。
async function getVersionTimes() {
  const args = ['view', PACKAGE, 'time', '--json']
  if (learnedMirror) args.push('--registry', MIRROR_REGISTRY)
  let r = await run(NPM, args, { timeoutMs: 30000 })
  if (!learnedMirror && r.code !== 0 && isNetworkFailure(r.code, r.stdout, r.stderr) && !isMirrorRegistry(await getNpmRegistry())) {
    r = await run(NPM, [...args, '--registry', MIRROR_REGISTRY], { timeoutMs: 30000 })
    if (r.code === 0) learnedMirror = true
  }
  if (r.code !== 0) return null
  try {
    const t = JSON.parse(r.stdout)
    const out = {}
    for (const [v, ts] of Object.entries(t)) {
      if (v === 'created' || v === 'modified') continue // time 里混有两个包级字段
      if (!parseVersion(v)) continue
      const ms = Date.parse(ts)
      if (Number.isNaN(ms)) continue
      out[v] = ms
    }
    return out
  } catch { return null }
}

async function getLatestVersion() {
  const times = await getVersionTimes()
  if (!times) return null
  let best = null
  let bestMs = -Infinity
  for (const [v, ms] of Object.entries(times)) {
    if (ms > bestMs) { bestMs = ms; best = v }
  }
  return best
}

// 全部版本，发布时间降序（最新在前）
async function listVersions() {
  const times = await getVersionTimes()
  if (!times) return []
  return Object.entries(times).sort((a, b) => b[1] - a[1]).map(([v]) => v)
}

// 比较 semver 版本：返回 -1(a<b) / 0(相等) / 1(a>b) / null(无法解析)
// semver 规则：先比 major.minor.patch，再比预发布段；正式版 > 预发布版；rc.1 < rc.2
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  if (pa.pre === '' && pb.pre === '') return 0
  if (pa.pre === '') return 1 // 正式版 > 预发布
  if (pb.pre === '') return -1
  const sa = pa.pre.split('.')
  const sb = pb.pre.split('.')
  const len = Math.max(sa.length, sb.length)
  for (let i = 0; i < len; i++) {
    if (i >= sa.length) return -1
    if (i >= sb.length) return 1
    const x = sa[i]
    const y = sb[i]
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const n1 = Number(x)
      const n2 = Number(y)
      if (n1 !== n2) return n1 < n2 ? -1 : 1
    } else if (nx !== ny) {
      return nx ? -1 : 1 // 数字段 < 字母段
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function parseVersion(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

/** 安装失败信息归类：权限不足（EACCES/EPERM）给可操作的提示，其它给最后一行原始输出（stderr 优先）。 */
function installFailureMessage(code, out, err) {
  const blob = `${err || ''}\n${out || ''}`
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(blob)) {
    return isWin
      ? '权限不足：npm 全局目录不可写。请以管理员身份运行 DSH+ 后重试，或执行 npm config set prefix "%APPDATA%\\npm" 改用用户目录'
      : '权限不足：npm 全局目录不可写。建议改用 nvm/volta 管理的 Node，或 npm config set prefix ~/.npm-global（不推荐 sudo npm）'
  }
  const tailSrc = String(err || '').trim() || String(out || '').trim()
  return tailSrc.split('\n').filter(Boolean).slice(-1)[0] || `安装失败（退出码 ${code}）`
}

// 单次 npm install 尝试；registry 为 null 时用 npm 自身配置。返回 { code, lastOut, lastErr, mirror }
function npmInstallOnce(target, registry, onProgress, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['install', '-g', target, '--no-audit', '--no-fund']
    if (registry) args.push('--registry', registry)
    const push = (d) => { if (onProgress) onProgress(String(d)) }
    let lastOut = ''
    let lastErr = ''
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; resolve(r) } }
    let child
    try {
      child = spawn(spawnArg0(NPM), args, { shell: USE_SHELL, windowsHide: true })
    } catch (err) {
      return finish({ code: null, lastOut: '', lastErr: `无法执行 ${NPM}：${err.message}`, mirror: !!registry })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      finish({ code: 'timeout', lastOut, lastErr, mirror: !!registry })
    }, timeoutMs)
    child.stdout.on('data', (d) => { lastOut = String(d).trim(); push(d) })
    child.stderr.on('data', (d) => { lastErr = String(d).trim(); push(d) })
    child.on('error', (err) => { clearTimeout(timer); finish({ code: null, lastOut, lastErr: `无法执行 ${NPM}：${err.message}`, mirror: !!registry }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ code, lastOut, lastErr, mirror: !!registry }) })
  })
}

// 安装指定版本：默认源失败且像网络问题时，自动切国内镜像重试一次（国内直连 npmjs 常见超时/重置）。
// learnedMirror 时直接用镜像装；r.mirror 防止「已是镜像还再重试镜像」的空转。
async function installVersion(version, onProgress, timeoutMs = 600000) {
  const v = String(version || '').trim()
  if (!isValidVersion(v)) return { ok: false, message: `无效版本号：${v || '(空)'}` }
  const target = `${PACKAGE}@${v}`
  let r = await npmInstallOnce(target, learnedMirror ? MIRROR_REGISTRY : null, onProgress, timeoutMs)
  if (r.code !== 0 && !r.mirror && isNetworkFailure(r.code, r.lastOut, r.lastErr) && !isMirrorRegistry(await getNpmRegistry())) {
    if (onProgress) onProgress(`默认源网络异常，切换国内镜像 ${MIRROR_REGISTRY} 重试…`)
    r = await npmInstallOnce(target, MIRROR_REGISTRY, onProgress, timeoutMs)
    if (r.code === 0) learnedMirror = true
  }
  if (r.code === 0) {
    dshBinCache = undefined // 安装后环境可能变化，清缓存下次重新解析
    return { ok: true, message: `${PACKAGE}@${v} 安装完成${r.mirror ? '（经国内镜像）' : ''}` }
  }
  if (r.code === 'timeout') return { ok: false, message: '安装超时（10 分钟）已中止，请检查网络后重试' }
  if (r.code === null) return { ok: false, message: r.lastErr }
  return { ok: false, message: installFailureMessage(r.code, r.lastOut, r.lastErr) }
}

module.exports = {
  PACKAGE,
  MIRROR_REGISTRY,
  isValidVersion,
  compareVersions,
  quoteWinCmd,
  spawnArg0,
  installFailureMessage,
  getNpmRegistry,
  isNetworkFailure,
  resolveDshBin,
  getInstalledVersion,
  getVersionTimes,
  getLatestVersion,
  listVersions,
  installVersion,
}