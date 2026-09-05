// dsh web 生命周期管理（纯 Node，无 electron 依赖，可独立测试）
// 职责：解析 dsh web 地址（三级兜底）、后台拉起 / 停止 / 重启 dsh web 进程、退出清理。
// 壳对 dsh 的所有进程操作收敛在这里；窗口 / 托盘 / 视图 / 管理 UI 在 main.js。
'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const cp = require('node:child_process')
const detect = require('./detect-dsh.js')
const dshm = require('./dsh-manage.js')
const dshAuth = require('./dsh-auth.js')

const FALLBACK_URL = 'http://127.0.0.1:3080'

// 监听进程命令行判定（导出供测试）：本机真 dsh 的监听者命令行形如
// `node /opt/homebrew/bin/dsh web --port 3080 --no-open`；隧道（ssh -L / tailscale serve）不匹配。
function looksLikeDshCommand(cmd) {
  const c = String(cmd || '')
  if (/([/\\]|^)dsh(\.cmd|\.js)?(["'\s]|$)/.test(c) && /\bweb\b/.test(c)) return true
  return /dsh(\.cmd|\.js)?["'\s]+web\b/.test(c)
}

class DshService {
  constructor(opts = {}) {
    this.explicitUrl = opts.explicitUrl || ''
    this.autoSpawn = opts.autoSpawn !== false
    this.log = opts.log || console
    this.url = FALLBACK_URL
    /** 0.1.2+ 启动宣告里的带 token URL 与 launch token（复用/扫描来的实例拿不到，为空） */
    this.authUrl = ''
    this.launchToken = ''
    this.restarting = false
    this.managedPid = null
    this.managedPort = null
    this.logOffset = 0 // 本次托管拉起前日志文件的末尾位置（只扫新增内容）
  }

  get isManaged() { return Boolean(this.managedPort || this.managedPid) }

  // 三级兜底解析 dsh web 地址：显式 URL → 复用/拉起 3080 → 全局扫描。
  // 托管实例必须钉死 3080：用户会把低位端口留给端口映射（如 3081→远端），
  // 漫游会撞占映射位，把「远端 App」变成事实上的本机 dsh（真实事故）。
  async resolveUrl() {
    if (this.explicitUrl) {
      this.log.log(`[dsh-plus] 使用显式 DSH_URL: ${this.explicitUrl}`)
      return this.explicitUrl
    }
    const HOME = 3080
    // 3080 上已有 dsh（用户自起/上次实例未死）→ 直接复用
    if (await detect.isDshOnPort(HOME)) {
      this.log.log(`[dsh-plus] 复用已在 ${HOME} 的 dsh web`)
      // 复用已在跑的进程：宣告行早写进日志了，必须从头扫，不能只看本次托管增量
      await this.scanLogForAnnounce({ fromStart: true, retries: 3, intervalMs: 200 })
      return `http://127.0.0.1:${HOME}`
    }
    if (this.autoSpawn) {
      // 刚被杀的托管实例可能还没释放 3080：等它（最多 ~6s），宁等勿漫游
      for (let i = 0; i < 12; i++) {
        if (!(await detect.portOpen('127.0.0.1', HOME, 300))) break
        await new Promise((r) => setTimeout(r, 500))
      }
      // 仍被占且不是 dsh（比如别人的服务/映射）：漫游到高位段，避开低位映射区
      const spawnPort = (await detect.portOpen('127.0.0.1', HOME, 300))
        ? await detect.pickFreePort(13080)
        : HOME
      if (!spawnPort) {
        this.log.error('[dsh-plus] 找不到空闲端口，放弃自动拉起')
        return null
      }
      if (!(await this.spawn(spawnPort))) return null
      if (await detect.waitForHttpReady(spawnPort)) {
        this.managedPort = spawnPort
        const url = `http://127.0.0.1:${spawnPort}`
        this.log.log(`[dsh-plus] 已自动拉起 dsh web: ${url}`)
        await this.scanLogForAnnounce() // 0.1.2+：取 launch token（壳视图/降级轮询要 cookie）
        return url
      }
      this.log.error(`[dsh-plus] dsh web 已在端口 ${spawnPort} 拉起但未就绪，清理该实例`)
      const cleaned = this.killManaged(spawnPort)
      if (cleaned.length) this.log.log(`[dsh-plus] 已清理未就绪的 dsh web 实例（PID ${cleaned.join(', ')}）`)
      this.managedPid = null
      this.managedPort = null
    }
    // 最后手段：全局特征扫描（可能认到映射过来的远端 dsh，仅在没有其它出路时用）
    const port = await detect.findDshPort()
    if (port) {
      const url = `http://127.0.0.1:${port}`
      this.log.log(`[dsh-plus] 自动检测到 dsh web: ${url}`)
      return url
    }
    return null
  }

  // 后台拉起 dsh web 子进程（stdout/stderr 落日志文件）。
  // 用 resolveDshBin() 解析出的完整路径启动，不靠 PATH 运气（nvm/volta 环境也能拉起）。
  async spawn(port) {
    const dshBin = await dshm.resolveDshBin()
    if (!dshBin) {
      this.log.error('[dsh-plus] 找不到 dsh 可执行文件，无法拉起 dsh web')
      return false
    }
    return new Promise((resolve) => {
      const logPath = path.join(os.homedir(), '.dsh-plus-dsh.log')
      const isWin = process.platform === 'win32'
      let child
      let logFd = null
      try {
        // WriteStream 在 'open' 事件前 fd 未就绪，spawn 的 stdio 不接受；用 openSync 直接拿文件描述符
        logFd = fs.openSync(logPath, 'a')
        try { this.logOffset = fs.fstatSync(logFd).size } catch { this.logOffset = 0 }
        child = cp.spawn(isWin ? dshm.spawnArg0(dshBin) : dshBin, ['web', '--port', String(port), '--no-open'], {
          shell: isWin,
          detached: !isWin,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env },
        })
        fs.closeSync(logFd) // spawn 已把 fd 复制给子进程，父进程关掉自己的副本
        logFd = null
      } catch (err) {
        if (logFd !== null) { try { fs.closeSync(logFd) } catch { /* 忽略 */ } }
        this.log.error('[dsh-plus] 自动拉起 dsh web 失败:', err.message)
        return resolve(false)
      }
      // spawn 是异步的：命令不存在（ENOENT）不会 throw，而是走 'error' 事件；不监听会崩溃整个壳。
      child.once('error', (err) => {
        this.log.error(`[dsh-plus] 自动拉起 dsh web 失败: ${err.message}`)
        this.managedPid = null
        resolve(false)
      })
      child.once('spawn', () => {
        this.managedPid = child.pid || null
        if (!isWin) child.unref()
        this.log.log(`[dsh-plus] 后台拉起 dsh web --port ${port}（日志: ${logPath}，托管 PID ${this.managedPid}）`)
        resolve(true)
      })
    })
  }

  // 清理壳托管的 dsh：按监听端口杀（真正的 server）+ 按 PID 杀（wrapper），去重。
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

  // 同步杀掉监听指定 127.0.0.1 端口的进程（退出/重启流程里同步执行）
  killByPort(port) {
    const killed = []
    if (process.platform === 'win32') {
      const r = cp.spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return killed
      for (const line of r.stdout.split('\n')) {
        const pid = detect.winListenPid(line, port)
        if (pid) {
          try { process.kill(pid); killed.push(pid) } catch { /* 已退出 */ }
        }
      }
    } else {
      // -sTCP:LISTEN 只杀监听进程，避免误杀客户端（含壳自己的 keep-alive 连接）
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

  // 退出清理：停托管实例 + 当前连接端口上的所有实例（方案 B：连外部手动启动的 DSH 也一起停止）
  stop() {
    if (this.isManaged) {
      const killed = this.killManaged(this.managedPort)
      if (killed.length) this.log.log(`[dsh-plus] 已随壳停止托管的 dsh web (PID ${killed.join(', ')})`)
      this.managedPort = null
      this.managedPid = null
    }
    // 始终尝试停止当前连接端口上的 dsh web（外部手动启动的也杀）
    let port = 0
    try { port = Number(new URL(this.url).port || 80) } catch { /* 非法地址按 0 处理 */ }
    if (port) {
      const killed = this.killByPort(port)
      if (killed.length) this.log.log(`[dsh-plus] 已随壳停止端口 ${port} 上的 dsh web (PID ${killed.join(', ')})`)
    }
  }

  // 重启 dsh web：停掉当前连接实例，优先在原端口重启（端口稳定不漂移）。
  // 返回 { ok, message, url? , external? }；url 表示换新地址要加载，external 表示只需刷新页面。
  async restart() {
    if (this.restarting) return { ok: false, message: '正在重启中，请稍候' }
    this.restarting = true
    try {
      // 显式 DSH_URL 可能是远程服务，不碰本地进程，只刷新页面
      if (this.explicitUrl) {
        if (this.isManaged) {
          const killed = this.killManaged(this.managedPort)
          if (killed.length) this.log.log(`[dsh-plus] 已停止托管的 dsh web (PID ${killed.join(', ')})`)
          this.managedPort = null
          this.managedPid = null
        }
        return { ok: true, message: '已刷新 DSH 页面（显式 DSH_URL 实例，未托管）', external: true }
      }

      let curPort = 0
      try { curPort = Number(new URL(this.url).port || 80) } catch { /* 非法地址按 0 处理 */ }

      // 盯身份不盯端口：杀之前过两道——HTTP 特征（是 dsh）+ 监听进程命令行（是本机进程）。
      // 只看特征会误杀：记忆端口上可能是用户后来映射过来的远端 dsh（特征一样，杀的是隧道）。
      // 记忆位置失配则实时扫描本机找 DSH 当前位置（findLocalDsh 自带护栏），在发现位置原址重拉。
      // 顺带修复旧逻辑 isManaged 时盲杀：托管实例已死且端口被别的服务复用时，探特征能避免误杀。
      let killPort = 0
      if (curPort && (await detect.isDshOnPort(curPort, 1500)) && (await this.listenerLooksLocalDsh(curPort))) {
        killPort = curPort
      } else {
        killPort = await this.findLocalDsh()
        if (killPort && killPort !== curPort) {
          this.log.log(`[dsh-plus] DSH 不在记忆位置（端口 ${curPort || '未知'}），已在端口 ${killPort} 找到它`)
        }
      }
      if (killPort) {
        const killed = this.killByPort(killPort)
        if (!killed.length) {
          return { ok: false, message: `无法停止端口 ${killPort} 上的 dsh web 进程（权限不足？），已放弃重启` }
        }
        this.log.log(`[dsh-plus] 已停止 dsh web (PID ${killed.join(', ')}，端口 ${killPort})`)
        curPort = killPort // 在发现位置原址重拉，端口跟它走
      } else if (curPort) {
        this.log.log(`[dsh-plus] 端口 ${curPort} 上已无本机 dsh，按已停止处理`)
      }
      if (this.managedPid) { try { process.kill(this.managedPid, 'SIGTERM') } catch { /* 已退出 */ } }
      this.managedPort = null
      this.managedPid = null

      if (!this.autoSpawn) {
        return { ok: true, message: '已刷新 DSH 页面（DSH_SHELL_NO_SPAWN=1，未自动拉起）', external: true }
      }

      const prefer = curPort || 3080
      await this.waitPortFree(prefer, 3000)
      const spawnPort = (await detect.portOpen('127.0.0.1', prefer, 300)) ? await detect.pickFreePort(prefer) : prefer
      if (!spawnPort) return { ok: false, message: '找不到空闲端口，无法重启 dsh web' }
      if (!(await this.spawn(spawnPort))) return { ok: false, message: '自动拉起 dsh web 失败（请确认 dsh 已安装）' }
      if (!(await detect.waitForHttpReady(spawnPort))) {
        const c = this.killManaged(spawnPort)
        if (c.length) this.log.log(`[dsh-plus] 已清理未就绪实例 (PID ${c.join(', ')})`)
        this.managedPort = null
        this.managedPid = null
        return { ok: false, message: '新 dsh web 实例未就绪' }
      }
      this.managedPort = spawnPort
      this.url = `http://127.0.0.1:${spawnPort}`
      this.log.log(`[dsh-plus] 已重启 dsh web: ${this.url}`)
      await this.scanLogForAnnounce() // 新进程新 token：重新取
      return { ok: true, message: `dsh web 已就绪（${this.url}）`, url: this.url }
    } finally {
      this.restarting = false
    }
  }

  // 等端口释放（最多 timeoutMs），供重启前让旧进程完全退出
  async waitPortFree(port, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!(await detect.portOpen('127.0.0.1', port, 300))) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  // 端口监听者的命令行（尽力而为；拿不到返回空数组，调用方从严处理）
  async listenerCommands(port) {
    if (process.platform === 'win32') {
      const r = cp.spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return []
      const out = []
      for (const line of r.stdout.split('\n')) {
        const pid = detect.winListenPid(line, port)
        if (!pid) continue
        const ps = cp.spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`], { encoding: 'utf8' })
        out.push({ pid, command: String(ps.stdout || '').trim() })
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
      out.push({ pid, command: String(cmd.stdout || '').trim() })
    }
    return out
  }

  // 端口监听者里有没有「本机 dsh web」进程。
  // 有命令行的才参与判定；全拿不到（如 Windows 上 PowerShell 失败）时放行，退回信特征的旧行为——
  // 否则会连自己托管的 dsh 都拒杀，重启静默失效。
  async listenerLooksLocalDsh(port) {
    const listeners = await this.listenerCommands(port)
    const known = listeners.filter((l) => l.command)
    if (!known.length) return true
    return known.some((l) => looksLikeDshCommand(l.command))
  }

  // 盯身份：扫本机所有监听端口，找「特征是 dsh 且监听者是本机 dsh 进程」的那个。
  // 与 detect.findDshPort 的差别就在身份护栏——findDshPort 会认到映射过来的远端 dsh。
  async findLocalDsh() {
    let ports = []
    try { ports = await detect.listLocalListenPorts() } catch { return 0 }
    const matches = await Promise.all(ports.map(async (p) => ((await detect.isDshOnPort(p, 800)) ? p : 0)))
    for (const p of matches) {
      if (!p) continue
      const listeners = await this.listenerCommands(p)
      if (listeners.length && listeners.some((l) => looksLikeDshCommand(l.command))) return p
    }
    return 0
  }

  // 从托管实例的日志增量里扫「dsh web: <url>」宣告行，提取 launch token（0.1.2+）。
  // 宣告在 Loader 树就绪后才打印，可能晚于 HTTP 就绪一拍：找不到时短轮询几次。
  async scanLogForAnnounce({ retries = 10, intervalMs = 500, fromStart = false } = {}) {
    const logPath = path.join(os.homedir(), '.dsh-plus-dsh.log')
    for (let i = 0; i < retries; i++) {
      try {
        const fd = fs.openSync(logPath, 'r')
        try {
          const size = fs.fstatSync(fd).size
          const startAt = fromStart ? 0 : this.logOffset
          if (size > startAt) {
            const buf = Buffer.alloc(size - startAt)
            fs.readSync(fd, buf, 0, buf.length, startAt)
            const url = dshAuth.scanAnnounceUrl(buf.toString('utf8'))
            if (url) {
              this.authUrl = url
              this.launchToken = dshAuth.extractLaunchToken(url) || ''
              this.logOffset = size
              if (this.launchToken) this.log.log('[dsh-plus] 已从 dsh web 宣告取得 launch token（0.1.2+ 鉴权）')
              return url
            }
          }
        } finally {
          fs.closeSync(fd)
        }
      } catch { /* 日志不可读：下轮再试 */ }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return null
  }
}

module.exports = { DshService, FALLBACK_URL, looksLikeDshCommand }