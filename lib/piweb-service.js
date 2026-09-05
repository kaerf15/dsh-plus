// pi-web 生命周期管理（纯 Node，无 electron 依赖，可独立测试）
// 与 lib/dsh-service.js 平行、独立：两条线互不调用。只管本机 pi-web——
// 认身份（特征 + 监听进程命令行双重确认），端口跟它走（从 app.url 读，发现挪了就跟到挪后的位置）。
// 职责：定位本机 pi-web、拉起 / 停止 / 重启。隧道端口（ssh -L / tailscale serve）与
// dev 模式（next dev）一律不碰：前者杀的是映射进程，后者原地重拉会变成生产版。
'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const cp = require('node:child_process')
const detect = require('./detect-dsh.js')

const isWin = process.platform === 'win32'
const PIWEB = isWin ? 'pi-web.cmd' : 'pi-web'
const NPM = isWin ? 'npm.cmd' : 'npm'
const DEFAULT_PORT = 30141

// ---------- 监听进程命令行判定（导出供测试） ----------
// 本机实态：监听者是 next-server 子进程，父是 wrapper `node .../pi-web`；
// wrapper 有跟随退出逻辑（child exit → parent exit），杀监听者即整棵树干净倒掉。
// 'dev'：next dev 起的服务，重拉会变成生产版，拒绝。
// 'piweb'：生产 pi-web，可重启。'other'：隧道/别的服务，不碰。
const PIWEB_TOKEN = /([/\\\s]|^)pi-web(\.cmd|\.js)?(\s|$)/

function classifyPiWebCommand(cmd, parentCmd) {
  // 先剥引号：Windows WMI 的 CommandLine 常带引号（node "C:\...\pi-web.js" --port ...）
  const c = String(cmd || '').replace(/["']/g, '')
  const p = String(parentCmd || '').replace(/["']/g, '')
  if (/\bnext dev\b/.test(c) || /\bnext dev\b/.test(p)) return 'dev'
  if (/next-server/.test(c) && (PIWEB_TOKEN.test(p) || /\bnext start\b/.test(p))) return 'piweb'
  if (PIWEB_TOKEN.test(c) || /\bnext start\b/.test(c)) return 'piweb'
  return 'other'
}

// Windows + shell:true 时路径含空格必须加引号（同 dsh-manage 的 quoteWinCmd，独立实现不交叉）
function quoteWinCmd(cmd) {
  const s = String(cmd || '')
  if (!s) return s
  if (s.startsWith('"') && s.endsWith('"')) return s
  return /[\s&()<>^|!]/.test(s) ? `"${s}"` : s
}

function run(cmd, args, { timeoutMs = 10000, shell = isWin } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // shell 只为 .cmd 存在；powershell 等 .exe 直调（shell:true 会让 cmd.exe 搅烂脚本里的 $() 和引号）
      child = cp.spawn(shell ? quoteWinCmd(cmd) : cmd, args, { shell, windowsHide: true })
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) })
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } finish(-1) }, timeoutMs)
    timer.unref?.()
    child.on('error', (err) => { stderr += String(err && err.message || err); finish(-1) })
    child.on('close', (code) => finish(code ?? -1))
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
  })
}

// pi-web 无 --version（bin 只认 --port/--hostname/--no-open/--help）：用 --help 输出验明正身
async function verifyPiWebBin(bin) {
  const r = await run(bin, ['--help'], { timeoutMs: 10000 })
  return r.code === 0 && /Usage: pi-web/.test(r.stdout || '')
}

function candidatePiWebPaths() {
  const home = os.homedir()
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      path.join(appData, 'npm', 'pi-web.cmd'),
      path.join(pf, 'nodejs', 'pi-web.cmd'),
      path.join(pf86, 'nodejs', 'pi-web.cmd'),
    ]
  }
  return [
    '/opt/homebrew/bin/pi-web',
    '/usr/local/bin/pi-web',
    path.join(home, '.local', 'bin', 'pi-web'),
  ]
}

// 三段式解析 pi-web bin（结构对照 dsh-manage.resolveDshBin，独立实现）
let piwebBinCache = undefined
async function resolvePiWebBin() {
  if (piwebBinCache !== undefined) return piwebBinCache
  // 1. PATH 里的 pi-web
  if (await verifyPiWebBin(PIWEB)) { piwebBinCache = PIWEB; return piwebBinCache }
  // 2. 常见安装路径
  for (const p of candidatePiWebPaths()) {
    if (!fs.existsSync(p)) continue
    if (await verifyPiWebBin(p)) { piwebBinCache = p; return p }
  }
  // 3. npm 全局前缀
  const pr = await run(NPM, ['prefix', '-g'], { timeoutMs: 15000 })
  const prefix = (pr.stdout || '').trim().split('\n')[0].trim()
  if (pr.code === 0 && prefix) {
    const candidates = isWin
      ? [path.join(prefix, 'pi-web.cmd'), path.join(prefix, 'bin', 'pi-web.cmd')]
      : [path.join(prefix, 'bin', 'pi-web')]
    for (const p of candidates) {
      if (fs.existsSync(p)) { piwebBinCache = p; return p }
    }
  }
  piwebBinCache = null
  return null
}

class PiWebService {
  constructor(opts = {}) {
    this.log = opts.log || console
    this.restarting = false
    this.managedPid = null
    this.managedPort = null
  }

  get isManaged() { return Boolean(this.managedPort || this.managedPid) }

  // pi-web 特征探测：GET /api/sessions 200 且 runningSessionIds 是数组（同 main.js probeApp 的口径）
  async isPiWebOnPort(port, timeoutMs = 1500) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await res.json().catch(() => null)
      return Boolean(res.ok && body && Array.isArray(body.runningSessionIds))
    } catch { return false }
  }

  // 端口监听者及其父进程的命令行（尽力而为；拿不到返回空数组，调用方按 'other' 从严处理）
  async listenerCommands(port) {
    if (isWin) {
      const r = cp.spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return []
      const pids = []
      for (const line of r.stdout.split('\n')) {
        const pid = detect.winListenPid(line, port)
        if (pid && !pids.includes(pid)) pids.push(pid)
      }
      const out = []
      for (const pid of pids) {
        // 一次查询拿回自己与父进程的 CommandLine（pi-web 监听者是 next-server，身份要看父进程）
        const ps = await run('powershell', ['-NoProfile', '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; @{ command = $p.CommandLine; parentCommand = $pp.CommandLine } | ConvertTo-Json -Compress }`], { timeoutMs: 8000, shell: false })
        let parsed = null
        try { parsed = JSON.parse((ps.stdout || '').trim()) } catch { /* 进程已退出等 */ }
        out.push({ pid, command: String(parsed?.command || ''), parentCommand: String(parsed?.parentCommand || '') })
      }
      return out
    }
    const r = cp.spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (r.status !== 0 || !r.stdout) return []
    const out = []
    for (const pidText of r.stdout.trim().split('\n')) {
      const pid = Number(pidText.trim())
      if (!pid) continue
      const cmd = cp.spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      const ppidRaw = cp.spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
      const ppid = Number(String(ppidRaw.stdout || '').trim())
      let parentCommand = ''
      if (ppid > 1) {
        parentCommand = String(cp.spawnSync('ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8' }).stdout || '').trim()
      }
      out.push({ pid, command: String(cmd.stdout || '').trim(), parentCommand })
    }
    return out
  }

  // 端口上是不是「本地真 pi-web」：HTTP 特征 + 监听进程命令行双重确认（隧道特征像但命令行不像）
  // 与 dsh 线的放行式不同，这里从严：拿不到命令行也拒杀——宁不可用，不误杀隧道
  async classifyListener(port) {
    const listeners = await this.listenerCommands(port)
    if (!listeners.length) return 'other'
    let sawPiweb = false
    for (const l of listeners) {
      const cls = classifyPiWebCommand(l.command, l.parentCommand)
      if (cls === 'dev') return 'dev' // dev 一票否决
      if (cls === 'piweb') sawPiweb = true
    }
    return sawPiweb ? 'piweb' : 'other'
  }

  // 盯身份：扫本机所有监听端口，找「特征是 pi-web 且监听者是本机 pi-web 进程」的那个。
  // 并发上限与 findDshPort 对齐：无界并发会在监听端口多的机器上形成探测风暴。
  async findLocalPiWebPort() {
    let ports = []
    try { ports = await detect.listLocalListenPorts() } catch { return 0 }
    return (await detect.mapFindFirst(ports, 8, async (p) => {
      if (!(await this.isPiWebOnPort(p, 800))) return 0
      return (await this.classifyListener(p)) === 'piweb' ? p : 0
    })) || 0
  }

  // 同步杀掉监听指定 127.0.0.1 端口的进程（同 dsh-service 实现，独立不交叉）
  killByPort(port) {
    const killed = []
    if (isWin) {
      const r = cp.spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return killed
      for (const line of r.stdout.split('\n')) {
        const pid = detect.winListenPid(line, port)
        if (pid) {
          try { process.kill(pid); killed.push(pid) } catch { /* 已退出 */ }
        }
      }
    } else {
      // -sTCP:LISTEN 只杀监听进程；pi-web wrapper 会随 child exit 自动跟退
      const r = cp.spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return killed
      for (const pidText of r.stdout.trim().split('\n')) {
        const pid = Number(pidText.trim())
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); killed.push(pid) } catch { /* 已退出 */ }
        }
      }
    }
    return killed
  }

  killManaged(port) {
    const killed = port ? this.killByPort(port) : []
    if (this.managedPid) {
      try {
        process.kill(this.managedPid, 'SIGTERM')
        if (!killed.includes(this.managedPid)) killed.push(this.managedPid)
      } catch { /* 已退出 */ }
    }
    return killed
  }

  // 后台拉起 pi-web 子进程（stdout/stderr 落日志文件），结构对照 dsh-service.spawn
  async spawn(port) {
    const bin = await resolvePiWebBin()
    if (!bin) {
      this.log.error('[dsh-plus] 找不到 pi-web 可执行文件，无法拉起 pi-web')
      return false
    }
    return new Promise((resolve) => {
      const logPath = path.join(os.homedir(), '.dsh-plus-piweb.log')
      let child
      let logFd = null
      try {
        logFd = fs.openSync(logPath, 'a')
        child = cp.spawn(isWin ? quoteWinCmd(bin) : bin, ['--port', String(port), '--no-open'], {
          shell: isWin,
          detached: !isWin,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env },
        })
        fs.closeSync(logFd)
        logFd = null
      } catch (err) {
        if (logFd !== null) { try { fs.closeSync(logFd) } catch { /* 忽略 */ } }
        this.log.error('[dsh-plus] 拉起 pi-web 失败:', err.message)
        return resolve(false)
      }
      child.once('error', (err) => {
        this.log.error(`[dsh-plus] 拉起 pi-web 失败: ${err.message}`)
        this.managedPid = null
        resolve(false)
      })
      child.once('spawn', () => {
        this.managedPid = child.pid || null
        if (!isWin) child.unref()
        this.log.log(`[dsh-plus] 后台拉起 pi-web --port ${port}（日志: ${logPath}，托管 PID ${this.managedPid}）`)
        resolve(true)
      })
    })
  }

  async waitPortFree(port, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!(await detect.portOpen('127.0.0.1', port, 300))) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  // 退出清理：只杀壳托管拉起的实例。用户在终端自起的 pi-web 不随壳退出被杀（与 dsh 的有意差异）。
  stop() {
    if (!this.isManaged) return
    const killed = this.killManaged(this.managedPort)
    if (killed.length) this.log.log(`[dsh-plus] 已随壳停止托管的 pi-web (PID ${killed.join(', ')})`)
    this.managedPort = null
    this.managedPid = null
  }

  // 重启 pi-web：认身份、端口跟它走。preferredPort 来自 app.url（壳记忆的位置）。
  // 记忆位置失配时实时扫描本机找它；找到就在发现位置重拉（返回 url 可能换端口）。
  // allowPortFollow：允许「接管另一个本机实例」——记忆端口空了但扫到别的本机 pi-web 时
  // 默认拒绝（隧道/映射条目隧道一断就会扫到不相干的本机实例，直接杀+重拉就是误杀）；
  // 调用方拿到用户确认后重试才置 true。
  // 返回 { ok, message, url?, code?, foundUrl? }
  async restart(preferredPort, { allowPortFollow = false } = {}) {
    if (this.restarting) return { ok: false, message: '正在重启中，请稍候' }
    this.restarting = true
    try {
      let curPort = Number(preferredPort) || 0

      // ① 盯身份：先确认记忆端口上仍是 pi-web；失配则实时找它现在的位置
      let target = 0
      if (curPort && (await this.isPiWebOnPort(curPort))) {
        target = curPort
      } else {
        const found = await this.findLocalPiWebPort()
        if (found && curPort && found !== curPort && !allowPortFollow) {
          return {
            ok: false,
            code: 'port-drift',
            foundUrl: `http://127.0.0.1:${found}`,
            message: `记忆的端口 ${curPort} 上没有 pi-web，但发现本机 ${found} 端口有一个 pi-web 实例。它可能是同一实例换了端口，也可能是不相干的另一个实例`,
          }
        }
        if (found) {
          target = found
          this.log.log(`[dsh-plus] pi-web 不在记忆位置（端口 ${curPort || '未知'}），已在端口 ${found} 找到它`)
        }
      }

      // ② 动手前的身份护栏：dev 模式与隧道一律不杀
      if (target) {
        const cls = await this.classifyListener(target)
        if (cls === 'dev') {
          return { ok: false, message: '该 pi-web 是 dev 模式（next dev）启动的，重启会变成生产版，请在原终端重启' }
        }
        if (cls !== 'piweb') {
          return { ok: false, message: `端口 ${target} 的监听进程不是本机 pi-web（可能是端口映射的远端实例），已放弃重启` }
        }
        const killed = this.killByPort(target)
        if (!killed.length) {
          return { ok: false, message: `无法停止端口 ${target} 上的 pi-web 进程（权限不足或已退出），已放弃重启` }
        }
        this.log.log(`[dsh-plus] 已停止 pi-web (PID ${killed.join(', ')}，端口 ${target})`)
      } else if (curPort) {
        this.log.log(`[dsh-plus] 端口 ${curPort} 上已无 pi-web，按已停止处理`)
      }
      if (this.managedPid) { try { process.kill(this.managedPid, 'SIGTERM') } catch { /* 已退出 */ } }
      this.managedPort = null
      this.managedPid = null

      // ③ 在目标端口原址拉起（不漫游：占用即报错，避免 URL 失配）
      const prefer = target || curPort || DEFAULT_PORT
      if (target) await this.waitPortFree(prefer, 3000)
      if (await detect.portOpen('127.0.0.1', prefer, 300)) {
        return { ok: false, message: `端口 ${prefer} 被其他服务占用，无法在该端口重启 pi-web` }
      }
      if (!(await this.spawn(prefer))) return { ok: false, message: '拉起 pi-web 失败（请确认 pi-web 已安装）' }
      if (!(await detect.waitForHttpReady(prefer))) {
        const c = this.killManaged(prefer)
        if (c.length) this.log.log(`[dsh-plus] 已清理未就绪的 pi-web 实例 (PID ${c.join(', ')})`)
        this.managedPort = null
        this.managedPid = null
        return { ok: false, message: '新 pi-web 实例未就绪' }
      }
      this.managedPort = prefer
      const url = `http://127.0.0.1:${prefer}`
      this.log.log(`[dsh-plus] 已重启 pi-web: ${url}`)
      return { ok: true, message: `pi-web 已就绪（${url}）`, url }
    } finally {
      this.restarting = false
    }
  }
}

module.exports = { PiWebService, resolvePiWebBin, classifyPiWebCommand, DEFAULT_PORT }
