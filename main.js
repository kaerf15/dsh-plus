// DSH+ → 多应用容器
// 顶部一条功能区（自绘 chrome）+ 下方 WebContentsView 应用区（默认 DSH，任何人都可加应用）。
// 设计：壳 = 容器，不内置具体应用、不绑定版本；DSH / 插件在 ~/.dsh 里独立更新。
// 模块：dsh-service（dsh 进程生命周期）、tray、context-menu、detect-dsh、dsh-manage。
'use strict'

const path = require('node:path')
const os = require('node:os')

// Finder / 资源管理器启动的 Electron 主进程 PATH 很窄。
// macOS：补 Homebrew；Windows：补 npm 全局 bin（%APPDATA%\npm），分隔符必须用 path.delimiter
// （旧代码用 ':' 拼接会把 Windows PATH 揉成一条无效路径）。
if (process.platform === 'win32') {
  const npmGlobal = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''
  process.env.PATH = [npmGlobal, process.env.PATH].filter(Boolean).join(path.delimiter)
} else {
  process.env.PATH = [
    process.env.PATH,
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
  ].filter(Boolean).join(path.delimiter)
}

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell, Notification } = require('electron')
const fs = require('node:fs')
const dshm = require('./lib/dsh-manage.js')
const dshAuth = require('./lib/dsh-auth.js')
const { DshService } = require('./lib/dsh-service.js')
const { PiWebService } = require('./lib/piweb-service.js')
const { DshBridge } = require('./lib/bridge.js')
const { FactsDirSource, defaultFactsDir } = require('./lib/surface/facts-dir.js')
const { PiWebPollSource } = require('./lib/surface/piweb-poll.js')
const { fetchJson } = require('./lib/surface/fetch-json.js')
const { SurfaceHub } = require('./lib/surface/hub.js')
const { countDockBadge } = require('./lib/surface/model.js')
const { createSurfaceNotifications } = require('./lib/notifications.js')
const { createDshSessionsAdapter } = require('./lib/surface/adapters/dsh-sessions.js')
const { shellCanSeeApp, createPendingSticky, createFinishedUnseenTracker, projectDshFactsWithAttention, syncAttentionRunning } = require('./lib/surface/attention.js')
const { createHttpPollAdapter } = require('./lib/surface/adapters/http-poll.js')
const { createEmitAdapter } = require('./lib/surface/adapters/emit.js')
const { buildTouchBar } = require('./lib/touchbar.js')
const appLauncher = require('./lib/app-launcher.js')
const { RecipeLoader } = require('./lib/surface/recipe-loader.js')
const { createTray } = require('./lib/tray.js')
const { setupContextMenu } = require('./lib/context-menu.js')

const TOOLBAR_HEIGHT = 44

function toolbarChrome() {
  const dark = nativeTheme.shouldUseDarkColors
  return { bg: dark ? '#151517' : '#f9fafb', fg: dark ? '#cfd3d6' : '#61666b' }
}

/** Windows 标题栏按钮色随系统明暗变；功能区 HTML 自己走 prefers-color-scheme。 */
function applyWindowChrome() {
  if (!win || win.isDestroyed()) return
  const { bg, fg } = toolbarChrome()
  win.setBackgroundColor(bg)
  if (process.platform !== 'darwin') {
    try { win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: TOOLBAR_HEIGHT }) } catch { /* 无 overlay 的构建 */ }
  }
}

const service = new DshService({
  explicitUrl: process.env.DSH_URL || '',
  autoSpawn: process.env.DSH_SHELL_NO_SPAWN !== '1',
})
// pi-web 线：与 DSH 线平行独立（lib/piweb-service.js），只管本机 pi-web 的拉起/停止/重启
const piwebService = new PiWebService({ log: console })

let win = null
let tray = null
let quitting = false
let installing = false // 主进程级：npm 安装与 DSH 重启互斥（UI 层同名锁只覆盖面板按钮）

// 手动窗口拖拽（替代 CSS -webkit-app-region: drag，规避 mac 上 no-drag 点击被吞的问题）
let windowDrag = { active: false, offsetX: 0, offsetY: 0 }
let windowDragTimer = null

// 应用注册表：默认 DSH；任何人都可以加应用 { id, name, url, icon }
// （无 favicon 时壳 UI 用中性地球图标兑底，不再用名字首字母）
let apps = []
let activeAppId = 'dsh'
let dshLatest = null // 静默检查到的新版本号；非 null 时鲸鱼图标显示红点、右键菜单出现「升级到 X」
const appViews = new Map() // id -> WebContentsView

// 会话桥（per-app）：每个 dsh 类应用一个 DshBridge + 一个 sessions adapter。
// 本地 dsh 读事实文件；远端连接（端口映射等）走插件 HTTP 事实出口，插件缺席退 session.list 轮询。
// pi-web 走分片目录源（FactsDirSource）：每个 pi 进程写一片，壳扫目录合并。
// 显示面：SurfaceHub 聚合各 adapter 产出的通用 Item，adapter 把事实投影成条目
const appFacts = new Map() // appId -> { kind: 'dsh'|'piweb', bridge, adapter }
const appProbe = new Map() // appId -> 'dsh-plugin' | 'dsh-web' | 'piweb'（运行时探测结果，不持久化）
/** dsh 插件模式：壳侧「看过」粘性集（client completed 绑选中态，后台时由壳补 completed） */
const attentionCleared = new Map() // appId -> Set<sessionId>
/** dsh 待交互粘性（选中但看不见时 client 常清 pendingInteraction） */
const attentionPending = new Map() // appId -> ReturnType<createPendingSticky>
/** dsh 后台跑完（running→idle 且当时看不见） */
const attentionUnseen = new Map() // appId -> ReturnType<createFinishedUnseenTracker>
const hub = new SurfaceHub()

hub.on('update', async (items) => { if (win) win.webContents.send('surface:update', { items: await appLauncher.hydrateGlyphs(items) }) })
hub.on('bring-to-front', (appId) => switchApp(appId))

ipcMain.handle('surface:get-state', async () => ({ items: await appLauncher.hydrateGlyphs(hub.snapshot()) }))
ipcMain.on('surface:dispatch', (_e, id) => hub.dispatchById(String(id)))

// launch-app：本地应用启动执行器（recipe 条目的 action.type='launch-app'，target.path 是 .app 路径）。
// 壳本地动作，不发回应用页——与 open-session 这类「页面内跳转」动作不同。
hub.registerExecutor('launch-app', (action) => {
  const p = action && action.target && action.target.path
  return typeof p === 'string' && p ? appLauncher.launch(p) : Promise.resolve({ ok: false })
})

// recipe：随包一份 + 用户一份（~/.dsh/dsh-plus/recipe.json，与 bridge.json 同目录）
const DSH_HOME_DIR = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? path.resolve(process.env.DSH_HOME)
  : path.join(os.homedir(), '.dsh')
const recipeLoader = new RecipeLoader({
  bundledDir: path.join(__dirname, 'recipes'),
  userDir: path.join(DSH_HOME_DIR, 'dsh-plus'),
  log: (m) => console.log(m),
})
recipeLoader.start()

// sessions adapter（per-app）：接事实 + 跑 recipe；open-session/open-pi-session 共享 executor 在下方注册。
// createDshSessionsAdapter 名字里有 dsh 但投影逻辑是通用的——靠 domain 参数认领各自的 recipe 域。
/** 用户此刻是否真的能看见某应用页（dsh+ 获焦 + 该 tab 前台 + 窗口可见 + 无浮层挡着） */
function canSeeApp(appId) {
  return shellCanSeeApp(win, activeAppId, toolbarOverlayOpen, appId)
}

function pendingStickyFor(appId) {
  let s = attentionPending.get(appId)
  if (!s) { s = createPendingSticky(); attentionPending.set(appId, s) }
  return s
}

function attentionClearedFor(appId) {
  let s = attentionCleared.get(appId)
  if (!s) { s = new Set(); attentionCleared.set(appId, s) }
  return s
}

function unseenTrackerFor(appId) {
  let t = attentionUnseen.get(appId)
  if (!t) { t = createFinishedUnseenTracker(); attentionUnseen.set(appId, t) }
  return t
}

function markAttentionViewed(appId, sessionId) {
  if (!sessionId) return
  attentionClearedFor(appId).add(String(sessionId))
  pendingStickyFor(appId).clear(sessionId)
  unseenTrackerFor(appId).clear(sessionId)
  appFacts.get(appId)?.adapter?.refresh?.()
}

/** 切应用 / 藏窗 / 最小化后重投影（dsh 后台 completed 依赖注意力，不一定会再收事实） */
function refreshAllAttention() {
  for (const [appId, entry] of appFacts) {
    entry.adapter?.refresh?.()
    if (entry.kind.startsWith('piweb')) checkViewingNow(appId)
  }
  renderAppBadge()
}

/** 接桥公共尾段：拆旧 → adapter → 登记 → 启动（新建/换源都走这里） */
function attachFacts(appId, kind, bridge, domain) {
  detachAppFacts(appId)
  const projectFacts = kind === 'dsh'
    ? (facts) => {
        syncAttentionRunning(attentionClearedFor(appId), facts)
        return projectDshFactsWithAttention(
          canSeeApp(appId), attentionClearedFor(appId), pendingStickyFor(appId), unseenTrackerFor(appId), facts)
      }
    : null
  const adapter = createDshSessionsAdapter({ bridge, hub, recipeLoader, appId, domain, projectFacts })
  appFacts.set(appId, { kind, bridge, adapter })
  bridge.start()
  adapter.start()
  return bridge
}

function attachDshSessions(appId, { baseUrl, factsUrl = '', file } = {}) {
  const existing = appFacts.get(appId)
  if (existing && existing.kind === 'dsh') {
    if (baseUrl) existing.bridge.setBaseUrl(baseUrl)
    if (factsUrl) existing.bridge.setFactsUrl(factsUrl) // 轮询模式 → 插件模式的热升级
    return existing.bridge
  }
  return attachFacts(appId, 'dsh', new DshBridge({ baseUrl, factsUrl, file, log: (m) => console.log(m) }), 'dsh.sessions')
}

// pi-web：两种事实源，按「是不是本机」选——
//   dir   分片目录源：本机 pi 插件（pi-dsh-plus-surface）写 ~/.pi/dsh-plus/facts，事实最准
//   http  HTTP 事实出口源：伴生出口 serve-facts.mjs 镜像分片目录（对应 dsh 侧 DshBridge 的
//         factsUrl HTTP 模式）——远端装了插件且出口可达时全保真（精确结束时刻/中断识别/命名）
//   poll  HTTP 轮询源：出口也缺席时的兑底，按 /api/sessions 的 running 迁移推断
// 判别靠分片重叠：远端会话列表里有 id 命中本地分片 → 同一台机器。地址无从区分（映射后都是环回）。
function attachPiSessions(appId, { mode, origin, exitUrl } = {}) {
  const kind = mode === 'dir' ? 'piweb-dir' : mode === 'http' ? 'piweb-http' : 'piweb-poll'
  const existing = appFacts.get(appId)
  if (existing && existing.kind === kind) {
    // 出口换址（主候选抖动、备候选接管）时热更 URL，不滞留死地址（同 DshBridge.setFactsUrl 口径）
    if (kind === 'piweb-http' && exitUrl) existing.bridge.setUrl(exitUrl)
    return existing.bridge
  }
  // 模式切换（如后来装了插件/出口就绪）：attachFacts 会先拆旧源再接新源
  const bridge = kind === 'piweb-dir'
    ? new FactsDirSource({ origin, log: (m) => console.log(m) })
    : kind === 'piweb-http'
      ? new FactsDirSource({ origin, url: exitUrl, log: (m) => console.log(m) })
      : new PiWebPollSource({ baseUrl: origin, log: (m) => console.log(m) })
  const attached = attachFacts(appId, kind, bridge, 'pi.sessions')
  // 「正看着的会话跑完」不该出气泡：事实一更新就核一次当前页面停在哪个会话上
  bridge.on('update', () => checkViewingNow(appId))
  return attached
}

/** 远端会话列表里有 id 命中本地分片 → 这台 pi-web 就是本机的（装了插件且在产事实） */
function hasLocalShardOverlap(sessionIds) {
  let files
  try { files = new Set(fs.readdirSync(defaultFactsDir())) } catch { return false }
  return (sessionIds || []).some((id) => files.has(`${encodeURIComponent(String(id))}.json`))
}

// pi 事实出口（对应 dsh 的 /dsh-plus-surface/bridge.json 探测步）：伴生出口 serve-facts.mjs
// 只读镜像分片目录。寻址两候选：app.factsUrl（独立映射端口，如 http://127.0.0.1:3082）优先，
// 其次同源路径（远端反代把出口挂进 pi-web 端口时零配置）——都缺席才退轮询，同 dsh「出口缺席退轮询」。
const FACTS_EXIT_PATH = '/pi-dsh-plus-surface/shards.json'

function factsExitUrls(app, origin) {
  const urls = []
  const raw = String(app.factsUrl || '').trim()
  if (raw) {
    try { urls.push(new URL(FACTS_EXIT_PATH, raw.endsWith('/') ? raw : raw + '/').href) } catch { /* 配错就跳过 */ }
  }
  try { urls.push(new URL(FACTS_EXIT_PATH, origin).href) } catch { /* origin 已验过，防御 */ }
  return urls
}

/** 探出口 → 返回可用的 shards.json 完整 URL；都不可达返回 null（壳自动退轮询） */
async function probeFactsExit(app, origin) {
  for (const url of factsExitUrls(app, origin)) {
    const body = await fetchJson(fetch, url)
    if (body && body.version === 1 && Array.isArray(body.shards)) return url
  }
  return null
}

function detachAppFacts(appId) {
  const entry = appFacts.get(appId)
  if (!entry) return
  entry.adapter.stop()
  entry.bridge.stop()
  appFacts.delete(appId)
  appProbe.delete(appId)
  attentionCleared.delete(appId)
  attentionPending.delete(appId)
  attentionUnseen.delete(appId)
}

// 探测一个用户添加的应用是什么：
//   ① dsh 插件事实出口在 → 全保真（factsUrl，含待交互气泡/completed 粘性语义）
//   ② 否则 session.list 通 → 裸 dsh web，降级轮询（基本角标/完成气泡）
//   ③ 否则 /api/sessions 带 runningSessionIds → pi-web：分片重叠选 dir（本机+插件）；
//      否则探事实出口（伴生 listener/反代同源路径）选 http；都缺席才退 poll（远端/无插件也能用）
//   ④ 都不通 → 普通网页，不接事实源
async function probeApp(app) {
  if (!app || !app.url || app.id === 'dsh') return
  // 探测是异步的：期间应用可能被删/改地址并拆过桥，接桥前必须确认它还是出发时的那个（同对象同 URL）
  const urlAtStart = app.url
  const alive = () => apps.includes(app) && app.url === urlAtStart
  let origin
  try { origin = new URL(urlAtStart).origin } catch { return }
  try {
    const body = await fetchJson(fetch, origin + '/dsh-plus-surface/bridge.json', { headers: authHeadersFor(origin, {}) })
    if (body && body.version === 1 && body.sessions && typeof body.sessions === 'object') {
      if (!alive()) return
      attachDshSessions(app.id, { baseUrl: origin, factsUrl: origin + '/dsh-plus-surface/bridge.json', file: null })
      await ensureOriginAuth(origin)
      appFacts.get(app.id)?.bridge.setAuthHeader(cookieHeaderFor(origin))
      appProbe.set(app.id, 'dsh-plugin')
      persistAppKind(app, 'dsh')
      console.log(`[dsh-plus] ${app.name} 识别为 dsh web（插件事实出口）`)
      return
    }
  } catch { /* 出口不可达：试下一种 */ }
  try {
    const res = await fetch(origin + '/api/session.list', {
      method: 'POST',
      headers: authHeadersFor(origin, { 'content-type': 'application/json' }),
      body: JSON.stringify({ type: 'client-request', method: 'session.list', rpcId: `probe-${Date.now()}`, payload: {} }),
      signal: AbortSignal.timeout(2500),
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body && body.result && body.result.ok) {
      if (!alive()) return
      attachDshSessions(app.id, { baseUrl: origin, file: null })
      await ensureOriginAuth(origin)
      appFacts.get(app.id)?.bridge.setAuthHeader(cookieHeaderFor(origin))
      if (appProbe.get(app.id) !== 'dsh-plugin') appProbe.set(app.id, 'dsh-web')
      persistAppKind(app, 'dsh')
      console.log(`[dsh-plus] ${app.name} 识别为 dsh web（session.list 轮询）`)
      return
    }
  } catch { /* 不是 dsh web：试 pi-web */ }
  try {
    const body = await fetchJson(fetch, origin + '/api/sessions', { headers: authHeadersFor(origin, {}) })
    if (body && Array.isArray(body.runningSessionIds)) {
      if (!alive()) return
      // 分片重叠 → 本机（插件在产事实）用分片源；否则探事实出口 → http；出口也缺席才退轮询
      const sessionIds = Array.isArray(body.sessions) ? body.sessions.map((s) => s && s.id) : []
      let mode = 'poll'
      let exitUrl = null
      if (hasLocalShardOverlap(sessionIds)) mode = 'dir'
      else {
        exitUrl = await probeFactsExit(app, origin)
        if (exitUrl) mode = 'http'
      }
      // 滞回：出口抖动不拆实例——http 源不可达时自会保留最后一帧（与 poll 源不可达同策略），
      // 换实例反而丢 cleared 粘性集与 bootstrap 闸门（已看过的气泡复活/未看的被吞）。
      // 升级（poll→http、dir→http、http→dir）不受限。appProbe 已是 piweb-http，无需重钉。
      if (appProbe.get(app.id) === 'piweb-http' && mode === 'poll') return
      attachPiSessions(app.id, { mode, origin, exitUrl })
      appProbe.set(app.id, mode === 'dir' ? 'piweb-dir' : mode === 'http' ? 'piweb-http' : 'piweb-poll')
      persistAppKind(app, 'piweb')
      console.log(`[dsh-plus] ${app.name} 识别为 pi-web（${mode === 'dir' ? '分片目录' : mode === 'http' ? 'HTTP 事实出口' : 'HTTP 轮询'}事实源）`)
    }
  } catch { /* 普通网页：静默 */ }
}

// ---------- 0.1.2+ 鉴权适配：launch token → 签名 cookie ----------
// dsh web 0.1.2 起 index 页与 /api/* 都要浏览器会话 cookie（无 loopback 豁免）。
// 壳的打法：主进程拿 token 换 cookie，写进 defaultSession（视图加载干净 URL 即通），
// 并按 origin 登记给各 bridge 的降级轮询。token 默认不落盘、不进视图历史；
// 唯一的例外是 adoptTokenUrl 换不到 cookie 时（对端暂不可达），原样保留带 token 的
// URL 交给视图首载跳转落 cookie——该 token 随远端进程死亡即失效。
// cookie 持久化：token 是一次性的（换完即弃），cookie 才是 30 天凭证。
// 签名密钥在对端 dsh 的 credential 仓里（跨其重启不变），所以 cookie 落盘后：
// 远端/外部实例换一次 token 就 30 天有效（含对端重启）；托管实例连 token 扫描竞态都免疫。
const authorityCookies = new Map() // origin -> { header, mintedAt }
const authTried = new Set() // app.id：这一轮 401 已经试过插件换证，避免死循环
const AUTH_COOKIE_FILE = path.join(app.getPath('userData'), 'auth-cookies.json')
const AUTH_COOKIE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000 // 平台 cookie 30 天，保守 29 天判过期

function persistAuthCookies() {
  try {
    fs.mkdirSync(path.dirname(AUTH_COOKIE_FILE), { recursive: true })
    fs.writeFileSync(AUTH_COOKIE_FILE, JSON.stringify(Object.fromEntries(authorityCookies)))
  } catch (err) { console.error('[dsh-plus] 保存鉴权 cookie 失败:', err.message) }
}

/** 启动时恢复上次换到的 cookie：写回 defaultSession + authorityCookies。过期的跳过（让服务端判 401）。 */
async function restoreAuthCookies() {
  let saved
  try { saved = JSON.parse(fs.readFileSync(AUTH_COOKIE_FILE, 'utf8')) } catch { return }
  if (!saved || typeof saved !== 'object') return
  const now = Date.now()
  for (const [origin, entry] of Object.entries(saved)) {
    if (!entry || typeof entry.header !== 'string' || !entry.header) continue
    if (typeof entry.mintedAt === 'number' && now - entry.mintedAt > AUTH_COOKIE_MAX_AGE_MS) continue // 已过期
    authorityCookies.set(origin, entry)
    await writeSessionCookie(origin, entry.header)
  }
  applyAuthHeaderToBridges()
}

/** 把 'name=value' 写进 defaultSession（视图共享）。 */
async function writeSessionCookie(origin, header) {
  const pair = dshAuth.splitCookieHeader(header)
  if (!pair) return
  try {
    await session.defaultSession.cookies.set({
      url: origin, name: pair.name, value: pair.value, path: '/',
      httpOnly: true, sameSite: 'strict',
      expirationDate: Math.floor((Date.now() + AUTH_COOKIE_MAX_AGE_MS) / 1000),
    })
  } catch { /* 写失败：视图 401 时由 did-finish-load 再换一次 */ }
}

function cookieHeaderFor(origin) {
  const c = authorityCookies.get(origin)
  return c && typeof c.header === 'string' ? c.header : ''
}

/** 已挂桥的应用按 origin 接上当前 cookie（restore / 新换证后都走这里）。 */
function applyAuthHeaderToBridges(origin) {
  const touch = (app) => {
    if (!app || !app.url) return
    try {
      const o = new URL(app.url).origin
      if (origin && o !== origin) return
      const header = cookieHeaderFor(o)
      if (header) appFacts.get(app.id)?.bridge.setAuthHeader(header)
    } catch { /* 坏 URL */ }
  }
  for (const app of apps) touch(app)
}

/** 把 cookie 头写进 defaultSession（视图共享），并登记到 authorityCookies + 落盘。 */
async function adoptCookieHeader(origin, header) {
  authorityCookies.set(origin, { header, mintedAt: Date.now() })
  persistAuthCookies()
  applyAuthHeaderToBridges(origin)
  await writeSessionCookie(origin, header)
}

/** 对端装了 dsh-plus-surface 0.2.3+ 时：向 launch.json 取 token 换 cookie。 */
async function adoptPluginLaunch(origin) {
  const header = await dshAuth.mintCookieFromPlugin(origin)
  if (!header) return false
  await adoptCookieHeader(origin, header)
  console.log(`[dsh-plus] 已从 ${origin} 的 dsh-plus-surface 自动换证`)
  return true
}

/** 这个 origin 还没有 cookie 时，试插件自动换证（端口映射/外部实例不用翻 stdout）。 */
async function ensureOriginAuth(origin) {
  if (!origin) return false
  if (cookieHeaderFor(origin)) return true
  return adoptPluginLaunch(origin)
}

/** 本地托管实例：优先用 service 扫到的 launch token；没有则走插件出口。 */
async function wireDshAuth() {
  let origin
  try { origin = new URL(service.url).origin } catch { return null }
  if (service.launchToken) {
    const header = await dshAuth.mintCookieHeader(origin, service.launchToken)
    if (header) {
      await adoptCookieHeader(origin, header)
      return header
    }
  }
  if (await ensureOriginAuth(origin)) return cookieHeaderFor(origin)
  return null
}

/** 用户添加的 URL 可能带 ?token=（远端 0.1.2+ 控制台打印的）：换 cookie 登记，返回干净 URL。
 *  换不到（旧版无闸门/对端暂不可达）时保留原 URL——视图首次加载仍可经 303 落 cookie。
 *  不带 token 时试插件自动换证（端口映射过来的 0.1.2+ 实例）。 */
async function adoptTokenUrl(rawUrl) {
  const token = dshAuth.extractLaunchToken(rawUrl)
  if (!token) {
    let origin
    try { origin = new URL(rawUrl).origin } catch { return rawUrl }
    await ensureOriginAuth(origin)
    return rawUrl
  }
  const bare = dshAuth.stripToken(rawUrl)
  let origin
  try { origin = new URL(bare).origin } catch { return rawUrl }
  const header = await dshAuth.mintCookieHeader(origin, token)
  if (!header) return rawUrl
  await adoptCookieHeader(origin, header)
  return bare
}

/** 探测/轮询 fetch 按 origin 附带已登记的 cookie。 */
function authHeadersFor(origin, base) {
  const header = cookieHeaderFor(origin)
  return header ? { ...base, cookie: header } : base
}

/** 官方要求「打开 dsh web 打印的带 token 地址」。有 token 就让视图自己走 303 落 cookie，不靠 cookies.set。 */
function tokenUrlFor(origin, token) {
  if (!origin || !token) return null
  try {
    const u = new URL('/', origin)
    u.searchParams.set('token', token)
    return u.href
  } catch { return null }
}

async function resolveViewUrl(app) {
  if (!app || !app.url) return app && app.url
  let origin
  try { origin = new URL(app.url).origin } catch { return app.url }
  let token = ''
  if (app.id === 'dsh') {
    if (!service.launchToken) {
      await service.scanLogForAnnounce({ fromStart: true, retries: 2, intervalMs: 200 })
    }
    token = service.launchToken || ''
  }
  if (!token) token = (await dshAuth.fetchLaunchToken(origin)) || ''
  return tokenUrlFor(origin, token) || app.url
}

// open-session 共享 executor：按 item.appId 路由到对应应用视图（本地 dsh / 远端连接通用）。
// 从 adapter 上移到这里：多连接下 executor 只能注册一次（Hub 按 action.type 索引）。
hub.registerExecutor('open-session', (action, item) => {
  const sid = action && action.target && action.target.sessionId
  if (typeof sid !== 'string' || !sid) return { ok: false }
  const appId = item && typeof item.appId === 'string' && item.appId ? item.appId : 'dsh'
  return jumpToDshSession(appId, sid)
})

// open-pi-session：pi 会话跳回（pi-web 深链 ?session=<id>，页面挂载时读取并选中）
hub.registerExecutor('open-pi-session', (action, item) => {
  const sid = action && action.target && action.target.sessionId
  if (typeof sid !== 'string' || !sid) return { ok: false }
  const appId = item && typeof item.appId === 'string' ? item.appId : null
  if (!appId) return { ok: false }
  return jumpToPiSession(appId, sid)
})

// http 源 adapter：source.type === 'http' 的 recipe 当轮询端点接进来（pi-web busy 等）
function resolveAppIdByUrl(url) {
  try {
    const origin = new URL(url).origin
    const app = apps.find((a) => a.url && new URL(a.url).origin === origin)
    return app ? app.id : null
  } catch { return null }
}
// vars：recipe URL 占位符的取值处。{dsh} = 壳当前解析到的本地 dsh web 地址——
// dsh 重启换端口后轮询跟着走，recipe 里不再需要硬编码端口。
const httpPoll = createHttpPollAdapter({
  hub,
  recipes: () => recipeLoader.recipes,
  resolveAppId: resolveAppIdByUrl,
  vars: () => ({ dsh: service.url }),
})
httpPoll.start()
recipeLoader.on('change', () => httpPoll.refresh())

// emit 管道（第三种内容源）：应用页 window.__shell.emit 直接推 Item
const emitAdapter = createEmitAdapter({ hub })

// Touch Bar 显示面（macOS）：把 Hub 里同一批 Item 映射到 Touch Bar——证明 Surface 与显示目标无关。
// 先水合 glyph（appicon:<路径> → data URI），Touch Bar 按钮才能带图标；水合是异步的，
// 期间窗口可能已销毁，写完前再核一次。
async function renderTouchBar() {
  if (process.platform !== 'darwin' || !win || win.isDestroyed()) return
  const items = await appLauncher.hydrateGlyphs(hub.snapshot())
  if (!win || win.isDestroyed()) return
  win.setTouchBar(buildTouchBar(items, (id) => hub.dispatchById(id)))
}

// ---------- 应用图标角标：待交互 + 已完成未看气泡总数（跨应用求和） ----------
// macOS/Linux：app.setBadgeCount 原生 Dock/任务栏计数（窗口藏托盘也在，应用活着就显示）。
// Windows 无原生计数 API：用任务栏 overlay 图标替代；主进程没有光栅字体，
// 图标位由功能区渲染（canvas → dataURL → IPC 回传）。窗口隐藏时 overlay 不可见，重开即恢复。
function renderAppBadge() {
  const n = countDockBadge(hub.snapshot())
  if (process.platform !== 'win32') {
    app.setBadgeCount(n)
    return
  }
  if (!win || win.isDestroyed()) return
  if (n === 0) {
    win.setOverlayIcon(null, '')
    return
  }
  // 功能区还没加载完时 send 会丢：跳过，did-finish-load 会补一次
  if (win.webContents.isLoading()) return
  win.webContents.send('shell:render-badge', n)
}

ipcMain.on('shell:badge-icon', (_e, { count, icon } = {}) => {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return
  try {
    const img = icon ? nativeImage.createFromDataURL(String(icon)) : null
    const ok = img && !img.isEmpty()
    win.setOverlayIcon(ok ? img : null, count > 0 ? `${count} 条待查看（完成或待交互）` : '')
  } catch { /* 坏 data URI 当清空 */ }
})
hub.on('update', renderAppBadge)
hub.on('update', renderTouchBar)

// ---------- 气泡悬停卡片：无边框 alwaysOnTop 子窗口 ----------
// 为什么不用 DOM tooltip：向下展示必然跨进应用区（native WebContentsView），
// 网页 z-index 对原生视图无效，只有独立窗口能真正浮在最上。
let tipWin = null
let tipReady = null
let tipSeq = 0 // 代次号：show 是异步的，hide 后过期 show 必须失效，否则孤卡片永远挂住

function ensureTipWindow() {
  if (tipWin && !tipWin.isDestroyed()) return { tw: tipWin, ready: tipReady }
  tipWin = new BrowserWindow({
    width: 380, height: 10,
    show: false, frame: false, transparent: true, resizable: false,
    movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, parent: win,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  tipWin.setIgnoreMouseEvents(true) // 纯展示，永不抢点击/焦点
  tipReady = new Promise((res) => tipWin.webContents.once('did-finish-load', res))
  tipWin.loadFile(path.join(__dirname, 'lib', 'tooltip.html'))
  tipWin.on('closed', () => { tipWin = null; tipReady = null })
  return { tw: tipWin, ready: tipReady }
}

function hideTip() { if (tipWin && !tipWin.isDestroyed()) tipWin.hide() }

ipcMain.on('surface:tip-show', async (_e, { x, y, title, subtitle, glyph } = {}) => {
  if (!win || typeof x !== 'number' || typeof y !== 'number') return
  const seq = ++tipSeq
  const { tw, ready } = ensureTipWindow()
  try {
    await ready // 首次悬停等内容页加载完
    const h = await tw.webContents.executeJavaScript(
      `setContent(${JSON.stringify(String(title || ''))}, ${JSON.stringify(String(subtitle || ''))}, ${JSON.stringify(String(glyph || ''))})`, true)
    if (seq !== tipSeq) return // 等待期间已被 hide：本次展示作废
    // x/y 是功能区视口坐标 → 换算屏幕坐标，向右越界时收回屏幕内
    const cb = win.getContentBounds()
    const W = 380
    const area = screen.getDisplayNearestPoint({ x: cb.x + x, y: cb.y + y }).workArea
    const px = Math.round(Math.min(Math.max(cb.x + x, area.x + 4), area.x + area.width - W - 4))
    tw.setBounds({ x: px, y: Math.round(cb.y + y), width: W, height: Math.min(Number(h) + 2, 200) })
    tw.showInactive()
  } catch { /* 内容页未就绪/已销毁：放弃本次，下次悬停重来 */ }
})
ipcMain.on('surface:tip-hide', () => { tipSeq++; hideTip() })

// jumpToDshSession：在某 dsh 类应用的页内跳转到某会话（点气泡的领域动作后半段）。
// Hub.dispatch 已通过 bring-to-front 把对应应用切到前台，这里只管聚焦 + 跳转。
// 消泡不靠这里：插件模式 completed 由 host 依选中上报推导（跳转即选中，client 上报即清）；
// markViewed 只服务降级模式。远端页没装插件 client 半时 jumped=false，气泡保留。
async function jumpToDshSession(appId, id) {
  if (typeof id !== 'string' || !id) return { ok: false }
  if (win) { win.show(); win.focus() }
  const bridge = appFacts.get(appId)?.bridge
  const markViewed = () => {
    if (bridge) bridge.markViewed(id)
    markAttentionViewed(appId, id)
  }
  const view = appViews.get(appId)
  if (!view) { markViewed(); return { ok: false } }
  try {
    // 新 client 半走通用 handle(action)；旧 client（未重启的 dsh）回退 .jump(id)
    const actionJson = JSON.stringify({ type: 'open-session', target: { sessionId: id } })
    const jumped = await view.webContents.executeJavaScript(
      `window.__dshPlus
        ? (window.__dshPlus.handle
            ? (window.__dshPlus.handle(${actionJson}), true)
            : window.__dshPlus.jump
                ? (window.__dshPlus.jump(${JSON.stringify(id)}), true)
                : false)
        : false`, true)
    // 点按钮 = 查看意图。插件模式 no-op（completed 由 host 依选中上报推导）；降级模式清 completed。
    markViewed()
    return { ok: Boolean(jumped) }
  } catch {
    markViewed()
    return { ok: false }
  }
}

// jumpToPiSession：点 pi 完成气泡 → pi-web 深链跳回该会话。
// pi-web 是单页应用，挂载时读 ?session=<id>（其自身选中会话时也 router.replace 同一参数），
// 所以整页 loadURL 即可命中；没有页面侧插件可借助。点按钮 = 看过：markViewed 消泡。
async function jumpToPiSession(appId, id) {
  const app = apps.find((a) => a.id === appId)
  const view = appViews.get(appId)
  const entry = appFacts.get(appId)
  if (entry) entry.bridge.markViewed(id)
  if (!app || !view) return { ok: false }
  if (win) { win.show(); win.focus() }
  try {
    const url = new URL('/', app.url)
    url.searchParams.set('session', id)
    await view.webContents.loadURL(url.toString())
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
let toolbarOverlayOpen = false // 功能区浮层（添加应用 / DSH 管理）打开时隐藏活动应用视图
let notificationsPanelOpen = false // 通知设置面板：仍挡视图，但暂停弹系统通知

const APPS_FILE = path.join(app.getPath('userData'), 'apps.json')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
const isMac = process.platform === 'darwin'

// 默认快捷键：mac 切换应用 Cmd+Option+←/→、网页后退/前进 Cmd+[/]；win 切换应用 Ctrl+(Shift+)Tab、网页后退/前进 Alt+←/→
const DEFAULT_SHORTCUTS = isMac
  ? {
      prev: { meta: true, alt: true, key: 'ArrowLeft' },
      next: { meta: true, alt: true, key: 'ArrowRight' },
      back: { meta: true, key: '[' },
      forward: { meta: true, key: ']' },
    }
  : {
      prev: { control: true, shift: true, key: 'Tab' },
      next: { control: true, key: 'Tab' },
      back: { alt: true, key: 'ArrowLeft' },
      forward: { alt: true, key: 'ArrowRight' },
    }

let shortcuts = loadShortcuts()
let notificationsEnabled = loadNotificationsEnabled()
let shortcutRecording = false // 设置面板录制组合键时，全局快捷键暂停响应
let shortcutRecordingTimer = null // 录制中焦点跑进应用 view（那里没有取消逻辑）会卡死标志，超时自动释放

function loadSettingsFile() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch { return {} }
}

function saveSettingsFile(patch) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    const next = { ...loadSettingsFile(), ...patch }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[dsh-plus] 保存设置失败:', err.message)
  }
}

function loadShortcuts() {
  const s = loadSettingsFile()
  const loaded = (s.shortcuts && typeof s.shortcuts === 'object') ? s.shortcuts : {}
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)),
    ...loaded,
  }
}

function loadNotificationsEnabled() {
  return loadSettingsFile().notificationsEnabled === true
}

function saveShortcuts() {
  saveSettingsFile({ shortcuts })
}

function saveNotificationsEnabled(enabled) {
  notificationsEnabled = Boolean(enabled)
  saveSettingsFile({ notificationsEnabled })
}

const surfaceNotifications = createSurfaceNotifications({
  getEnabled: () => notificationsEnabled,
  getSuppress: () => notificationsPanelOpen,
  canSeeApp,
  onClick: (item) => {
    void (async () => {
      if (process.platform === 'darwin') app.dock?.show()
      if (win) { win.show(); win.focus() }
      // 等窗口激活后再跳页（通知中心点击时 WebContentsView 可能尚未就绪）
      await new Promise((r) => setTimeout(r, 80))
      const target = hub.items.get(item.id) || item
      const r = hub.dispatch(target)
      if (r && typeof r.then === 'function') await r
      if (!target.action) {
        console.log(`[dsh-plus] 通知点击：条目无 action id=${item.id}`)
      }
    })()
  },
  log: (m) => console.log(m),
})
hub.on('update', (items) => surfaceNotifications.sync(items))

// 持久化用户添加的应用（DSH 内置不存）
function loadApps() {
  try {
    const data = fs.readFileSync(APPS_FILE, 'utf8')
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) {
      return parsed.filter((a) => a && typeof a === 'object' && a.id && a.url && a.id !== 'dsh')
    }
  } catch { /* 文件不存在或解析失败，返回空 */ }
  return []
}

function saveApps() {
  try {
    fs.mkdirSync(path.dirname(APPS_FILE), { recursive: true })
    const userApps = apps.filter((a) => a.id !== 'dsh').map((a) => {
      const { offline: _drop, ...persisted } = a // offline 是运行时态，不落盘
      return persisted
    })
    fs.writeFileSync(APPS_FILE, JSON.stringify(userApps, null, 2))
  } catch (err) {
    console.error('[dsh-plus] 保存应用列表失败:', err.message)
  }
}

// 探测出的应用身份（dsh / piweb）随应用列表落盘：壳重启后、服务尚未起来
// （探测必失败）之前，右键菜单仍能按记忆身份给「重启」，死实例也能一键拉起。
// 编辑 URL 时 delete app.kind 作废旧身份，重探后由这里重钉。
function persistAppKind(app, kind) {
  if (!app || app.id === 'dsh') return
  if (app.kind === kind) return // 30s 慢速重探每轮都会重钉：没变就不写盘
  app.kind = kind
  saveApps()
}

// ---------- 窗口位置/大小记忆 ----------
// 位置掉出所有屏幕可见区时只恢复尺寸（外接屏拔掉后窗口不能飞到不可见区）。
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8'))
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null
    const width = Math.max(480, Math.round(s.width))
    const height = Math.max(320, Math.round(s.height))
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return s.x >= a.x - 20 && s.y >= a.y - 20 && s.x + 80 <= a.x + a.width && s.y + 40 <= a.y + a.height
      })
      if (onScreen) return { x: Math.round(s.x), y: Math.round(s.y), width, height }
    }
    return { width, height }
  } catch { /* 无文件/损坏用默认 */ }
  return null
}

let winStateTimer = null
function saveWindowStateNow() {
  if (!win || win.isDestroyed() || win.isMinimized()) return // 最小化时 bounds 是哨兵值（win 上 -32000），不记
  try {
    fs.mkdirSync(path.dirname(WIN_STATE_FILE), { recursive: true })
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(win.getBounds()))
  } catch (err) {
    console.error('[dsh-plus] 保存窗口位置失败:', err.message)
  }
}
/** 拖拽/缩放期间 16ms 级连发，400ms 防抖落盘 */
function scheduleSaveWindowState() {
  if (winStateTimer) clearTimeout(winStateTimer)
  winStateTimer = setTimeout(() => { winStateTimer = null; saveWindowStateNow() }, 400)
  winStateTimer.unref?.()
}

// ---------- 应用视图：一个应用一个 WebContentsView ----------
function layoutViews() {
  if (!win) return
  const [w, h] = win.getContentSize()
  for (const [id, view] of appViews) {
    const visible = id === activeAppId && !toolbarOverlayOpen
    view.setVisible(visible)
    if (visible) view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) })
  }
}

function broadcastApps() {
  if (!win) return
  win.webContents.send('shell:apps-changed', apps.map((a) => ({
    ...a,
    active: a.id === activeAppId,
    hasUpdate: a.id === 'dsh' ? dshLatest : null,
  })))
}

// 装了吗 + 最新发布版 + 是否可升级，一次并发取齐（静默/手动检查共用）。
// inst.version 为 null 是「web 在跑但 CLI 不可达」的兜底态：无法比较，不算可升级。
async function computeUpdate() {
  const [inst, latest] = await Promise.all([dshm.getInstalledVersion(), dshm.getLatestVersion()])
  const hasUpdate = !!(inst.installed && inst.version && latest && dshm.compareVersions(latest, inst.version) === 1)
  return { inst, latest, hasUpdate }
}

// 静默检查 DSH 更新（启动 30s 后自动跑一次）：只查不装，有新版 → 红点 + 菜单升级项
async function checkUpdateSilently() {
  try {
    const { latest, hasUpdate } = await computeUpdate()
    dshLatest = hasUpdate ? latest : null
  } catch { dshLatest = null }
  broadcastApps()
}

function createAppView(app) {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'lib', 'app-preload.js') },
  })
  appViews.set(app.id, view)
  win.contentView.addChildView(view)

  view.webContents.setWindowOpenHandler(({ url }) => {
    let external = true
    try { external = new URL(url).origin !== new URL(app.url).origin } catch { /* 按外链处理 */ }
    if (external) { shell.openExternal(url); return { action: 'deny' } }
    view.webContents.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  setupContextMenu(view, app, () => win, () => shortcuts)
  // 快捷键由 app.on('web-contents-created') 全局挂钩（含本 view），此处不再单独挂，避免双重触发

  // 「看到即消泡」：pi-web 选中会话时会 router.replace('?session=<id>')，SPA 内跳转触发
  // did-navigate-in-page。读到 = 用户在页内看到了该会话（直接切换/深链跳入都算），清完成提醒。
  // 不依赖页面侧插件；dsh 的 completed 由插件 client 半回传，不走这条路。
  view.webContents.on('did-navigate-in-page', (_e, url) => noteViewedFromUrl(app.id, url))

  // 页面接入不绑插件：就当浏览器打开 app.url。有 cookie / 壳自己扫到的 token 会先换证；
  // 没有就让官方 401 留在视图里，不换成壳的引导页。插件 launch.json 是静默增强，不是门槛。
  view.webContents.on('did-finish-load', async () => {
    try {
      const text = await view.webContents.executeJavaScript(
        'document.body ? document.body.innerText.slice(0, 200) : ""', true)
      const t = String(text).trim()
      if (t === 'unauthorized' || t.startsWith('dsh web authentication required')) {
        let origin
        try { origin = new URL(app.url).origin } catch { origin = null }
        if (origin && !authTried.has(app.id)) {
          authTried.add(app.id)
          const next = await resolveViewUrl(app)
          if (next && next !== view.webContents.getURL() && dshAuth.extractLaunchToken(next)) {
            view.webContents.loadURL(next).catch(() => {})
          }
        }
      }
    } catch { /* 页面已销毁 */ }
  })

  // 抓网页自带 favicon 作为应用图标。两条路互补：
  // ① page-favicon-updated（对 ico/png 最稳）② did-finish-load 读 <link rel=icon>（能覆盖 SVG favicon，如 DSH 的鲸鱼 /favicon.svg）
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    const icon = favicons && favicons[0]
    if (icon && app.icon !== icon) {
      app.icon = icon
      broadcastApps()
    }
  })
  view.webContents.on('did-finish-load', async () => {
    // 连接状态纯运行时推导：停在离线页 = 未连接，任何真实页面加载成功 = 已连接。不持久化。
    const offline = view.webContents.getURL().includes('offline.html')
    if (!!app.offline !== offline) {
      if (offline) app.offline = true
      else delete app.offline
      broadcastApps()
    }
    try {
      const href = await view.webContents.executeJavaScript(
        `(() => {
           const links = document.querySelectorAll('link[rel~="icon"]');
           for (const l of links) {
             const h = l.getAttribute('href');
             if (h) return new URL(h, location.href).href;
           }
           return '';
         })()`,
        true,
      )
      if (href && app.icon !== href) {
        app.icon = href
        broadcastApps()
      }
    } catch { /* 读不到 favicon 就维持现状 */ }
  })

  // 加载失败 → 壳内离线页 lib/offline.html（自治状态机：乐观「正在连接」→ 离线态 +
  // 定时探活，服务恢复后自行 location.replace 回真实地址——壳不再维护重试循环）。
  // ERR_ABORTED(-3) 是主动中断（新导航顶掉旧导航），不算失败。
  // 离线页拿解析后的地址（dsh 会带 launch token）；给裸 app.url 的话恢复后必 401。
  const showOffline = () => {
    resolveViewUrl(app).catch(() => app.url).then((url) => {
      const search = new URLSearchParams({ url: url || app.url || '', name: app.name || app.id })
      view.webContents.loadFile(path.join(__dirname, 'lib', 'offline.html'), { search: search.toString() }).catch(() => {})
    })
  }
  view.webContents.on('did-fail-load', (_e, errorCode, _desc, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (view.webContents.getURL().includes('offline.html')) return // 离线页自治，不叠加
    showOffline()
  })
  // 首载：resolve 失败（网络抖动）退回原始地址；导航失败由 did-fail-load 接住落进离线页
  resolveViewUrl(app).then(
    (loadUrl) => view.webContents.loadURL(loadUrl).catch(() => {}),
    () => view.webContents.loadURL(app.url).catch(() => {}),
  )

  layoutViews()
  return view
}

function switchApp(id) {
  if (!appViews.has(id)) return
  activeAppId = id
  layoutViews()
  broadcastApps()
  refreshAllAttention() // 进出前台：dsh 后台 completed 投影切换；pi 回到可见才消泡
  checkViewingNow(id)
}

// ---------- 看到即消泡（pi 系事实源；dsh 由插件 client 半 + 注意力投影负责） ----------
// 正在查看 = 壳真的能看见该应用 且 页面 URL 带 ?session=<id>（pi-web 选中会话的官方深链）。
function noteViewedFromUrl(appId, url) {
  const entry = appFacts.get(appId)
  if (!entry || !entry.kind.startsWith('piweb')) return
  if (!canSeeApp(appId)) return // 切到别的应用 / 藏窗 / 最小化 = 没看到
  let sid
  try { sid = new URL(url).searchParams.get('session') } catch { return }
  if (sid) entry.bridge.markViewed(sid)
}

/** 主动核一次当前正在看的会话（切应用 / 事实更新 / 窗口恢复时调用） */
function checkViewingNow(appId) {
  if (!canSeeApp(appId)) return
  const view = appViews.get(appId)
  if (!view) return
  noteViewedFromUrl(appId, view.webContents.getURL())
}

// 刷新某个应用的视图：与右键菜单「刷新」同语义。
// 当前停在离线页（offline.html）时同样重试原始地址——resolveViewUrl 解析的本就是原地址。
function reloadAppView(id) {
  const app = apps.find((a) => a.id === id)
  const view = appViews.get(id)
  if (!app || !view) return
  authTried.delete(id)
  resolveViewUrl(app).then((url) => {
    view.webContents.loadURL(url).catch(() => {})
  }).catch(() => {
    view.webContents.loadURL(app.url).catch(() => {})
  })
}


// 匹配用户配置的组合键（input.meta/alt/... 与录入的修饰键完全一致 + key 匹配，方向键兼容旧值 Left/Right，中括号兼容 Bracket）
function matchShortcut(input, sc) {
  if (!sc || !sc.key) return false
  const keyOk = input.key === sc.key
    || (typeof input.key === 'string' && typeof sc.key === 'string' && input.key.toLowerCase() === sc.key.toLowerCase())
    || (sc.key === 'ArrowLeft' && input.key === 'Left')
    || (sc.key === 'ArrowRight' && input.key === 'Right')
    || (sc.key === '[' && (input.key === '[' || input.code === 'BracketLeft'))
    || (sc.key === ']' && (input.key === ']' || input.code === 'BracketRight'))
  return keyOk
    && Boolean(input.meta) === Boolean(sc.meta)
    && Boolean(input.control) === Boolean(sc.control)
    && Boolean(input.alt) === Boolean(sc.alt)
    && Boolean(input.shift) === Boolean(sc.shift)
}

/** 触发当前激活应用视图的历史前进/后退 */
function activeViewNav(dir) {
  const view = appViews.get(activeAppId)
  if (!view || !view.webContents || view.webContents.isDestroyed()) return false
  if (dir === 'back' && view.webContents.canGoBack()) {
    view.webContents.goBack()
    return true
  }
  if (dir === 'forward' && view.webContents.canGoForward()) {
    view.webContents.goForward()
    return true
  }
  return false
}

// 应用切换快捷键（浏览器范式），「上一个/下一个」组合键可在右键 DSH →「快捷键设置」里自定义：
// 默认 mac：Cmd+Option+←/→；win：Ctrl+Tab / Ctrl+Shift+Tab。位置切换 mac Cmd+1~9 / win Ctrl+1~9 固定。
// 网页后退/前进：默认 mac Cmd+[/]；win Alt+←/→。
// 注意：Option+←/→ 是文本「按词跳转」、Cmd+←/→ 是「行首/行尾」，均被输入框高频使用，绝不能占。
// before-input-event 在主进程拦截（keyDown + rawKeyDown 都要认，否则时灵时不灵）。
// 挂钩走 web-contents-created 全局注册：功能区、每个应用 view、DevTools（docked/独立窗口）全覆盖——
// DevTools 曾是漏网之鱼：焦点落在其中时按键不经过任何单独挂钩的 contents，切换快捷键静默失效。
app.on('web-contents-created', (_event, contents) => setupShortcuts(contents))

function setupShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return
    if (shortcutRecording) return // 录制中不响应快捷键
    if (matchShortcut(input, shortcuts.prev) || matchShortcut(input, shortcuts.next)) {
      const dir = matchShortcut(input, shortcuts.next) ? 1 : -1
      const idx = apps.findIndex((a) => a.id === activeAppId)
      if (idx !== -1 && apps.length >= 2) {
        switchApp(apps[(idx + dir + apps.length) % apps.length].id)
        event.preventDefault()
      }
      return
    }
    // 网页后退 / 前进
    if (matchShortcut(input, shortcuts.back)) {
      if (activeViewNav('back')) event.preventDefault()
      return
    }
    if (matchShortcut(input, shortcuts.forward)) {
      if (activeViewNav('forward')) event.preventDefault()
      return
    }
    // 位置切换 1~9
    const mod = isMac ? input.meta : input.control
    if (mod && !input.alt && !input.shift && /^[1-9]$/.test(input.key)) {
      const idx = Number(input.key) - 1
      if (idx < apps.length) {
        switchApp(apps[idx].id)
        event.preventDefault()
      }
    }
  })

  // 鼠标侧键（前进/后退）支持
  contents.on('app-command', (event, command) => {
    if (command === 'browser-backward') {
      if (activeViewNav('back')) event.preventDefault()
    } else if (command === 'browser-forward') {
      if (activeViewNav('forward')) event.preventDefault()
    }
  })

  // 触控板滑动导航（macOS 左右轻扫）
  contents.on('swipe', (_event, direction) => {
    if (direction === 'right') activeViewNav('back')
    else if (direction === 'left') activeViewNav('forward')
  })
}

// 删除应用（DSH 内置默认应用不可删）
function removeApp(id) {
  if (id === 'dsh') return
  const view = appViews.get(id)
  if (view) {
    win.contentView.removeChildView(view)
    view.webContents.close()
    appViews.delete(id)
  }
  const idx = apps.findIndex((a) => a.id === id)
  if (idx !== -1) apps.splice(idx, 1)
  emitAdapter.clear(id) // 清掉该应用通过 emit 推的条目
  detachAppFacts(id) // 拆掉该应用的事实源（若有）
  if (activeAppId === id) activeAppId = 'dsh'
  layoutViews()
  broadcastApps()
  saveApps()
}

// ---------- 窗口：功能区（主 webContents）+ 应用区（WebContentsView） ----------
function createWindow() {
  const isMac = process.platform === 'darwin'
  const { bg: toolbarBg, fg: toolbarFg } = toolbarChrome()
  const savedWin = loadWindowState()

  win = new BrowserWindow({
    width: savedWin ? savedWin.width : 1280,
    height: savedWin ? savedWin.height : 860,
    ...(savedWin && Number.isFinite(savedWin.x) ? { x: savedWin.x, y: savedWin.y } : {}),
    title: 'DSH+',
    backgroundColor: toolbarBg,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: toolbarBg, symbolColor: toolbarFg, height: TOOLBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'lib', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 功能区自身不打开任何新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.loadFile(path.join(__dirname, 'lib', 'shell-ui.html'))

  // 重建所有应用视图（窗口重开时 appViews 已清空）；同步 dsh URL 到最新。
  // 应用注册表在 whenReady 里初始化一次，不在这里重置，避免连同用户添加的应用一起丢掉。
  const dshApp = apps.find((a) => a.id === 'dsh')
  if (dshApp) dshApp.url = service.url
  for (const app of apps) {
    if (!appViews.has(app.id)) createAppView(app)
  }

  // 关键修复：窗口就绪/内容加载完成后补一次布局。
  // 打包/从 Finder 启动时 createAppView 在窗口 ready 前算出的 bounds 可能不对，
  // 导致应用区加载成功却不显示（npm start 时序不同不受影响）。
  win.once('ready-to-show', () => layoutViews())
  win.webContents.on('did-finish-load', () => {
    layoutViews()
    renderAppBadge() // 功能区就绪后补一次（Windows overlay 图标要功能区渲染，早前 send 可能丢）
  })

  // 空白修复②：hide→show（托盘切换）、最小化恢复（restore）时不触发 resize，
  // WebContentsView 的 GPU 内容可能已被回收，必须强制重设 bounds+visible 才会重绘。
  const relayoutOnShow = () => {
    if (!win) return
    const [w, h] = win.getContentSize()
    for (const [id, view] of appViews) {
      view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) })
      view.setVisible(id === activeAppId && !toolbarOverlayOpen)
    }
  }
  win.on('show', () => { relayoutOnShow(); refreshAllAttention() })
  win.on('restore', () => { relayoutOnShow(); refreshAllAttention() })
  win.on('hide', refreshAllAttention)
  win.on('minimize', refreshAllAttention)
  win.on('focus', refreshAllAttention)
  win.on('blur', refreshAllAttention)

  win.on('resize', () => layoutViews())
  win.on('resize', hideTip)
  win.on('resize', scheduleSaveWindowState)
  win.on('move', hideTip) // 窗口移动后卡片位置即失效
  win.on('move', scheduleSaveWindowState)
  win.on('blur', hideTip)
  // 点关闭 = 藏到托盘，不销毁窗口（Windows 点 X 否则会走 window-all-closed 直接退出；
  // mac 红灯也会拆掉所有 WebContentsView，下次要从零重建）。真正退出走托盘 / Cmd+Q。
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      hideTip()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
    appViews.clear()
    if (tipWin && !tipWin.isDestroyed()) tipWin.destroy()
  })
  // 窗口重建（activate）后 overlay 图标要重挂：按当前事实补一次
  renderAppBadge()
}

nativeTheme.on('updated', applyWindowChrome)

// ---------- 功能区 IPC ----------
ipcMain.handle('shell:get-apps', () => apps.map((a) => ({ ...a, active: a.id === activeAppId })))
ipcMain.on('shell:switch-app', (_e, id) => switchApp(id))
ipcMain.on('shell:reload-app', (_e, id) => reloadAppView(id))
// 应用页推 Item（window.__shell.emit）：按发件 webContents 反查应用，强制绑到自己的 appId
ipcMain.on('surface-emit', (e, rawItems) => {
  const app = apps.find((a) => appViews.get(a.id) && appViews.get(a.id).webContents === e.sender)
  if (app) emitAdapter.emit(app.id, rawItems)
})
ipcMain.handle('shell:add-app', async (_e, { id, name, url, factsUrl } = {}) => {
  // 没协议就补 http://（支持 www.baidu.com / 127.0.0.1:30141 这类裸地址）
  let raw = String(url || '').trim()
  if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw
  let parsed
  try {
    parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    return { ok: false }
  }
  const appName = String(name || '').trim()
  // 0.1.2+：URL 带 ?token= 时先换 cookie 再存干净地址（token 是远端进程级一次性凭证，不落盘）
  parsed = new URL(await adoptTokenUrl(parsed.href))

  // 带 id = 编辑已有应用；不带 = 新建
  if (id) {
    const app = apps.find((a) => a.id === id)
    if (!app) return { ok: false }
    app.name = appName || parsed.host
    app.url = parsed.href
    app.icon = null
    const factsRaw = String(factsUrl || '').trim()
    if (factsRaw) app.factsUrl = factsRaw
    else delete app.factsUrl
    authTried.delete(id)
    delete app.kind // 地址可能变了：旧身份作废（否则改了 URL 还按旧 kind 给「重启」），重探后重钉
    const view = appViews.get(id)
    if (view) resolveViewUrl(app).then((url) => view.webContents.loadURL(url).catch(() => {}))
    detachAppFacts(id) // 地址可能变了：拆旧桥（否则旧 origin 的轮询/事实残留），再按新地址重新探测
    probeApp(app)
    broadcastApps()
    saveApps()
    return { ok: true, id }
  }

  const newId = 'app-' + Date.now()
  const app = {
    id: newId,
    name: appName || parsed.host,
    url: parsed.href,
    icon: null,
  }
  const factsRaw = String(factsUrl || '').trim()
  if (factsRaw) app.factsUrl = factsRaw
  apps.push(app)
  createAppView(app)
  switchApp(newId)
  saveApps()
  probeApp(app) // 是 dsh web / pi-web（本地映射端口/局域网）就接上事实源
  return { ok: true, id: newId }
})
ipcMain.on('shell:minimize', () => { if (win) win.minimize() })
ipcMain.on('shell:hide', () => { if (win) win.hide() })

// 拖拽排序：非 DSH 应用换位（顺序即 apps 数组顺序，持久化到 apps.json）
ipcMain.on('shell:reorder-apps', (_e, dragId, targetId) => {
  if (dragId === 'dsh' || targetId === 'dsh') return
  const from = apps.findIndex((a) => a.id === dragId)
  const to = apps.findIndex((a) => a.id === targetId)
  if (from === -1 || to === -1 || from === to) return
  const [moved] = apps.splice(from, 1)
  apps.splice(to, 0, moved)
  saveApps()
  broadcastApps()
})

// 快捷键设置：读取 / 保存 / 恢复默认 / 录制暂停
ipcMain.handle('shell:get-shortcuts', () => JSON.parse(JSON.stringify(shortcuts)))
ipcMain.handle('shell:set-shortcuts', (_e, next) => {
  if (!next || !next.prev?.key || !next.next?.key || (next.back && !next.back.key) || (next.forward && !next.forward.key)) return { ok: false }
  shortcuts = {
    ...JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)),
    ...JSON.parse(JSON.stringify(next)),
  }
  saveShortcuts()
  return { ok: true }
})
ipcMain.handle('shell:reset-shortcuts', () => {
  shortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
  saveShortcuts()
  return JSON.parse(JSON.stringify(shortcuts))
})
ipcMain.on('shell:shortcut-recording', (_e, on) => {
  shortcutRecording = Boolean(on)
  if (shortcutRecordingTimer) { clearTimeout(shortcutRecordingTimer); shortcutRecordingTimer = null }
  if (shortcutRecording) {
    // 兑底：录制一个组合键 15s 绰绰有余；超时自动恢复切换，防止标志卡死后快捷键静默全灭
    shortcutRecordingTimer = setTimeout(() => { shortcutRecording = false }, 15000)
    shortcutRecordingTimer.unref?.()
  }
})

ipcMain.handle('shell:get-notifications', () => ({
  enabled: notificationsEnabled,
  supported: Notification.isSupported(),
}))
ipcMain.handle('shell:set-notifications', (_e, { enabled } = {}) => {
  saveNotificationsEnabled(Boolean(enabled))
  if (!notificationsEnabled) surfaceNotifications.clear()
  return { ok: true, enabled: notificationsEnabled }
})
ipcMain.on('shell:set-notifications-panel-open', (_e, open) => {
  notificationsPanelOpen = Boolean(open)
})

// 手动拖拽：按下时记录光标与窗口的偏移，窗口跟随光标移动（16ms 轮询）
ipcMain.on('shell:drag-start', () => {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  windowDrag = { active: true, offsetX: cursor.x - wx, offsetY: cursor.y - wy }
  if (!windowDragTimer) {
    windowDragTimer = setInterval(() => {
      if (!windowDrag.active || !win || win.isDestroyed()) return
      const c = screen.getCursorScreenPoint()
      win.setPosition(c.x - windowDrag.offsetX, c.y - windowDrag.offsetY)
    }, 16)
  }
})
ipcMain.on('shell:drag-end', () => {
  windowDrag.active = false
  if (windowDragTimer) { clearInterval(windowDragTimer); windowDragTimer = null }
})

// 添加应用表单是主 webContents 里的 DOM，弹在 toolbar 下方；应用 WebContentsView 是 native 层，会盖住它。
// 表单打开时隐藏活动应用视图，关闭时恢复。
ipcMain.on('shell:set-add-form-open', (_e, open) => {
  toolbarOverlayOpen = Boolean(open)
  const view = appViews.get(activeAppId)
  if (view) view.setVisible(!toolbarOverlayOpen)
  refreshAllAttention()
})

// 功能区应用图标右键菜单：普通应用给「编辑/删除」，DSH 给「检查更新/重启/安装」；
// 本机 pi-web（probe 认出 + 环回地址）加「重启」——远端/映射实例不给，重启够不着对端进程。
function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
  } catch { return false }
}

ipcMain.on('shell:app-menu', (_e, id) => {
  if (id === 'dsh') { showDshMenu(); return }
  const app = apps.find((a) => a.id === id)
  if (!app) return
  const piwebLocal = (String(appProbe.get(id) || '').startsWith('piweb') || app.kind === 'piweb') && isLoopbackUrl(app.url)
  const template = [
    { label: `切换到 ${app.name}`, enabled: id !== activeAppId, click: () => switchApp(id) },
    { type: 'separator' },
    { label: '刷新', click: () => reloadAppView(id) },
  ]
  if (piwebLocal) {
    template.push({ label: '重启', enabled: !piwebService.restarting, click: () => doRestartPiWeb(id) })
  }
  template.push(
    { type: 'separator' },
    { label: '编辑', click: () => { if (win) win.webContents.send('shell:open-edit', app) } },
    { label: '删除', click: () => removeApp(id) },
  )
  Menu.buildFromTemplate(template).popup({ window: win })
})

// ---------- DSH 状态 / 版本 / 服务控制 ----------
function getDshStatus() {
  return dshm.getInstalledVersion().then((inst) => {
    const dshApp = apps.find((a) => a.id === 'dsh')
    return {
      installed: inst.installed,
      version: inst.version,
      appUrl: dshApp ? dshApp.url : service.url,
      managed: service.isManaged,
      installing,
      restarting: service.restarting,
    }
  })
}

function broadcastDshStatus() {
  if (!win) return
  getDshStatus().then((s) => win.webContents.send('dsh:status-changed', s)).catch(() => {})
}

// 重启 DSH web：service 负责停/起进程，这里负责把新地址同步给视图与状态
// fromInstall：安装流程内部调用时传 true，跳过 installing 互斥锁（自己人不挡自己人）
async function restartDsh(fromInstall = false) {
  if ((installing && !fromInstall) || service.restarting) return { ok: false, message: '正在安装或重启中，请稍候' }
  const result = await service.restart()
  if (!result.ok) return result

  const view = appViews.get('dsh')
  if (result.url) {
    const localBridge = appFacts.get('dsh')?.bridge
    if (localBridge) localBridge.setBaseUrl(result.url)
    await wireDshAuth() // 新进程新 token：重换 cookie 再加载
    const dshApp = apps.find((a) => a.id === 'dsh')
    if (dshApp) dshApp.url = result.url
    if (view) view.webContents.loadURL(result.url).catch(() => {})
  } else if (view) {
    view.webContents.reload() // 显式 DSH_URL / no-spawn：进程没动，只刷新页面
  }
  broadcastDshStatus()
  return result
}

// DSH 右键菜单：状态 + （有新版时）升级项 + 检查更新 / 重启
async function showDshMenu() {
  const inst = await dshm.getInstalledVersion()
  const template = [
    { label: inst.installed
        ? (inst.version ? `DSH v${inst.version}${dshLatest ? ` → 可升级 ${dshLatest}` : ''}` : 'DSH — 运行中（版本未知）')
        : 'DSH — 未安装', enabled: false },
    { type: 'separator' },
  ]
  if (dshLatest && inst.installed) {
    template.push({ label: `升级到 ${dshLatest}`, click: () => doInstallVersion(dshLatest) })
  }
  template.push(
    { label: '检查更新…', click: () => checkForUpdate() },
    { label: '重启 DSH', enabled: inst.installed, click: () => doRestartDsh() },
    { type: 'separator' },
    { label: '快捷键设置…', click: () => { if (win) win.webContents.send('shell:open-shortcuts') } },
    { label: '通知设置…', click: () => { if (win) win.webContents.send('shell:open-notifications') } },
  )
  Menu.buildFromTemplate(template).popup({ window: win })
}

// 检查更新：对比本机版本与最新发布版，用系统对话框反馈
async function checkForUpdate() {
  const { inst, latest, hasUpdate } = await computeUpdate()
  if (!inst.installed) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      message: '未检测到 DSH',
      detail: '本机未安装 DSH（@deepseek-ai/dsh），是否现在安装？',
      buttons: ['安装', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (r.response === 0 && win) win.webContents.send('dsh:open-install-panel')
    return
  }
  if (!inst.version) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: '无法检查更新',
      detail: '本机 DSH 正在运行但 CLI 不可达，版本未知，无法比较。',
      buttons: ['好'],
    })
    return
  }
  if (!latest) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: '无法检查更新',
      detail: '获取最新版本失败，可能是网络不可用。',
      buttons: ['好'],
    })
    return
  }
  if (hasUpdate) {
    dshLatest = latest
    broadcastApps()
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      message: `发现新版本 ${latest}`,
      detail: `当前 ${inst.version} → 最新 ${latest}。升级会执行 npm install -g，可能需要一两分钟。`,
      buttons: [`升级到 ${latest}`, '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (r.response === 0) await doInstallVersion(latest)
  } else {
    dshLatest = null
    broadcastApps()
    await dialog.showMessageBox(win, {
      type: 'info',
      message: '已是最新版本',
      detail: `当前版本 ${inst.version}。`,
      buttons: ['好'],
    })
  }
}

// 重启 DSH：成功不弹窗（视图刷新本身就是反馈），失败才弹错误
async function doRestartDsh() {
  const r = await restartDsh()
  if (r.ok) return
  await dialog.showMessageBox(win, {
    type: 'error',
    message: '重启失败',
    detail: r.message,
    buttons: ['好'],
  })
}

// 重启本机 pi-web：service 负责认身份 + 停/起进程（端口跟它走），这里负责同步视图与状态。
// 端口可能漂到发现位置（r.url 与 app.url 不同）：更新注册表与持久化，再按新地址加载。
async function doRestartPiWeb(id) {
  const app = apps.find((a) => a.id === id)
  if (!app || piwebService.restarting) return
  let port = 0
  try { const u = new URL(app.url); port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80) } catch { /* 非法地址按 0 处理 */ }
  let r = await piwebService.restart(port)
  if (!r.ok && r.code === 'port-drift') {
    // 漂移接管闸门：扫到的本机实例未必属于这条应用条目（隧道断掉的映射条目会扫到不相干实例），让用户拍板
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'pi-web 不在记忆的端口上',
      detail: `${r.message}。\n\n「接管并重启」会重启那个实例，并把本应用地址改指到 ${r.foundUrl}；若它是不相干的实例（或这是端口映射的远端条目），请取消。`,
      buttons: ['取消', '接管并重启'],
      defaultId: 0,
      cancelId: 0,
    })
    if (choice.response !== 1) return
    r = await piwebService.restart(port, { allowPortFollow: true })
  }
  if (!r.ok) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: '重启 pi-web 失败',
      detail: r.message,
      buttons: ['好'],
    })
    return
  }
  const view = appViews.get(id)
  if (r.url && r.url !== app.url) {
    app.url = r.url
    saveApps()
    broadcastApps()
    if (view) view.webContents.loadURL(r.url).catch(() => {})
    detachAppFacts(id) // 端口漂了：旧事实源 origin 指着旧端口，拆掉让 probeApp 重接
  } else if (view) {
    // 同地址：直接拉回应用页（之前可能停在 offline.html 上，reload 只会重载离线页等它慢慢重试）
    view.webContents.loadURL(app.url).catch(() => {})
  }
  probeApp(app) // 重接事实源（dir/poll 源按新实况重选）
}

// 安装指定版本并自动重启 DSH（「检查更新」升级与安装面板共用）。装完自动 restart，面板同时收 npm 进度。
async function installAndRestart(version) {
  const res = await dshm.installVersion(version, (line) => {
    if (win) win.webContents.send('dsh:install-progress', String(line))
  })
  broadcastDshStatus()
  if (!res.ok) return res
  const restartRes = await restartDsh(true)
  dshLatest = null // 升级完成，红点消除
  broadcastApps()
  return { ok: true, message: `${res.message}。${restartRes.ok ? restartRes.message : '请右键 DSH 图标 →「重启 DSH」生效。'}` }
}

// 检查更新菜单路径：带「开始/完成/失败」对话框反馈
async function doInstallVersion(version) {
  if (installing || service.restarting) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: '操作冲突',
      detail: '已有安装或重启操作在进行中，请稍候再试。',
      buttons: ['好'],
    })
    return
  }
  installing = true
  broadcastDshStatus()
  // 进度可见：打开安装面板实时看 npm 输出（国内网络装包可能较慢，静默等待体验差）
  if (win && !win.isDestroyed()) {
    win.show()
    win.webContents.send('dsh:open-install-panel')
  }
  try {
    const res = await installAndRestart(version)
    await dialog.showMessageBox(win, res.ok
      ? { type: 'info', message: '安装完成', detail: res.message, buttons: ['好的'] }
      : { type: 'error', message: '安装失败', detail: res.message || '未知错误', buttons: ['好'] })
  } finally {
    installing = false
    broadcastDshStatus()
  }
}

// ---------- DSH 管理 IPC ----------
ipcMain.handle('dsh:get-status', () => getDshStatus())
ipcMain.handle('dsh:list-versions', async () => ({ versions: await dshm.listVersions() }))
ipcMain.handle('dsh:install', async (_e, version) => {
  if (installing || service.restarting) return { ok: false, message: '已有安装或重启操作在进行中' }

  // 降级防护：目标版本比当前旧时，先警告（旧版可能读不了新数据）
  if (version && version !== 'latest') {
    const inst = await dshm.getInstalledVersion()
    if (inst.installed && inst.version) {
      const cmp = dshm.compareVersions(version, inst.version)
      if (cmp === -1) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `将降级到 ${version}`,
          detail: `当前 ${inst.version} → ${version}。降级可能导致旧版无法读取现有数据（~/.dsh），建议先备份。确定继续？`,
          buttons: ['继续降级', '取消'],
          defaultId: 1,
          cancelId: 1,
        })
        if (r.response !== 0) return { ok: false, message: '已取消降级' }
      }
    }
  }

  installing = true
  broadcastDshStatus()
  try {
    return await installAndRestart(version)
  } finally {
    installing = false
    broadcastDshStatus()
  }
})

// ---------- 生命周期 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) createWindow()
    if (win) { win.show(); win.focus() }
  })

  app.whenReady().then(async () => {
    tray = createTray({
      assetsDir: path.join(__dirname, 'assets'),
      onShow: () => {
        if (!win) { createWindow(); return }
        win.show()
        win.focus()
      },
      onToggle: () => {
        if (!win) { createWindow(); return }
        win.isVisible() ? win.hide() : (win.show(), win.focus())
      },
      onQuit: () => { quitting = true; app.quit() },
    })

    // 1. 先检测 DSH 是否安装（即使 dsh web 没启动也要能发现）
    const inst = await dshm.getInstalledVersion()
    const needInstall = !inst.installed

    // 2. 解析/启动 dsh web URL（已安装时自动拉起；未安装时会失败但无害）
    const resolved = await service.resolveUrl()
    if (resolved) service.url = resolved

    // 3. 初始化应用注册表：DSH 内置 + 用户持久化应用
    const savedApps = loadApps()
    apps = [{ id: 'dsh', name: 'DSH', url: service.url, icon: null, builtin: 'dsh' }, ...savedApps]
    activeAppId = 'dsh'
    console.log(`[dsh-plus] 默认应用 DSH: ${service.url}`)

    // 4. 本地 dsh 会话桥（事实文件来源），用户添加的应用逐个探测是不是 dsh web
    attachDshSessions('dsh', { baseUrl: service.url })
    // 恢复上次换到的鉴权 cookie（30 天凭证，落盘跨壳重启有效；托管实例新 token 稍后覆盖）
    await restoreAuthCookies()
    // 0.1.2+：托管实例若在宣告里给了 launch token，先换 cookie 再开窗口（视图/轮询都要）
    await wireDshAuth()
    for (const app of savedApps) probeApp(app)
    // 慢速重探：远端服务可能后于壳启动；dsh-web 可能后来装上插件 → 升级全保真；
    // piweb-poll 可能后来装了 pi 插件 → 换分片源。只有 dsh-plugin / piweb-dir 两种稳态不重探
    // （保活归 bridge 内部心跳/重试管）。
    const probeTimer = setInterval(() => {
      for (const app of apps) {
        if (app.id === 'dsh') continue
        const kind = appProbe.get(app.id)
        if (kind === 'dsh-plugin' || kind === 'piweb-dir') continue
        probeApp(app)
      }
    }, 30000)
    probeTimer.unref?.()

    createWindow()
    renderTouchBar()

    // 启动 30s 后静默检查一次更新（不打断启动；有新版只亮红点，不弹窗）
    setTimeout(checkUpdateSilently, 30000)

    // 4. 首次启动且未安装 DSH：自动打开安装版本选择面板。
    // createWindow() 里的 loadFile 是异步的，此处渲染进程还没执行 shell-ui.html 的内联
    // 脚本、onOpenInstallPanel 监听尚未注册；立刻 send 会被丢弃。等 did-finish-load 再发。
    if (needInstall && win) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('dsh:open-install-panel')
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      if (win) { win.show(); win.focus() }
    })
  })

  app.on('window-all-closed', () => {
    // 关窗口不退出：托盘还在。Windows 以前这里会 app.quit()，与「点 X 进托盘」不一致。
    if (!quitting) return
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    saveApps()
    saveWindowStateNow()
    httpPoll.stop()
    recipeLoader.stop()
    for (const [, entry] of appFacts) {
      try { entry.adapter.stop() } catch { /* 退出路径：听不到也不挡 quit */ }
      try { entry.bridge.stop() } catch { /* 同上 */ }
    }
    service.stop()
    piwebService.stop() // 只杀壳托管拉起的 pi-web；用户终端自起的不动
  })
}