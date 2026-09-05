// dsh web 0.1.2+ 浏览器会话鉴权的壳侧适配（纯 Node，零 electron 依赖，可独立测试）。
//
// 平台行为（packages/client/connection/src/browser-auth.ts）：
//   - dsh web 启动后往 stdout 打一行宣告：`dsh web: <url>[?token=<launch token>] (LAN: …)`；
//     0.1.1 起有这行，0.1.2 起带一次性 launch token。
//   - 首次 GET /?token=<token> → 303 到干净 / 并落签名 cookie（HttpOnly, SameSite=Strict, Path=/）。
//   - 之后 index 页、/api/* 共享通道、Remote WS 都要这个 cookie；无 loopback 豁免。
// 壳的打法：主进程先拿 token 换 cookie，写进 defaultSession（视图直接加载干净 URL），
// 并把同一个 cookie 头交给 bridge 的降级轮询。token 不落盘、不进视图历史。
'use strict'

/** 一行日志 → 宣告的 URL（「dsh web: opening the default browser…」这类行安全返回 null）。 */
function parseAnnounceLine(line) {
  const m = String(line || '').match(/dsh web:\s*(\S+)/)
  if (!m) return null
  try {
    return new URL(m[1]).href
  } catch {
    return null
  }
}

/** 一段日志文本 → 最后一条宣告 URL（日志跨多次启动追加，取最新的一次）。 */
function scanAnnounceUrl(text) {
  let found = null
  for (const line of String(text || '').split('\n')) {
    const url = parseAnnounceLine(line)
    if (url) found = url
  }
  return found
}

/** 宣告 URL → launch token（0.1.1 的宣告没有 token，返回 null）。 */
function extractLaunchToken(url) {
  try {
    const t = new URL(url).searchParams.get('token')
    return t && t.trim() ? t : null
  } catch {
    return null
  }
}

/**
 * 用户粘贴的「整段宣告 URL」或裸 token → launch token。
 * 端口映射时对端打印的是 127.0.0.1:3080/?token=…，壳这边是 :3090，
 * 只取 token、按壳正在访问的 origin 换证，绝不跟贴进来的 host/port 走。
 */
function coerceLaunchToken(input) {
  const s = String(input || '').trim()
  if (!s) return null
  const fromUrl = extractLaunchToken(s)
  if (fromUrl) return fromUrl
  // 平台 token 是 32 字节 base64url（约 43 字符）；放宽到 20–128 以免实现微调时拒收
  return /^[A-Za-z0-9_-]{20,128}$/.test(s) ? s : null
}

/** 去掉 token 的干净 URL（注册表/展示/视图加载都用它，token 不外泄到历史记录）。 */
function stripToken(url) {
  try {
    const u = new URL(url)
    u.searchParams.delete('token')
    return u.href
  } catch {
    return String(url || '')
  }
}

/** set-cookie 响应头 → Cookie 请求头（取第一个分号前的 name=value）。 */
function setCookieToHeader(setCookie) {
  const first = String(setCookie || '').split(';')[0].trim()
  return first.includes('=') ? first : null
}

/**
 * 用 launch token 换签名 cookie：GET <origin>/?token=...（手动重定向），读 303 的 set-cookie。
 * 成功返回 'name=value' 字符串；没换到（旧版无 token 闸门/网络失败）返回 null。
 */
async function mintCookieHeader(origin, token, fetchFn) {
  if (!origin || !token) return null
  const fetcher = fetchFn || ((u, opts) => fetch(u, opts))
  try {
    const url = new URL('/', origin)
    url.searchParams.set('token', token)
    const res = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    const setCookie = res.headers.get('set-cookie')
    if (!setCookie) return null
    return setCookieToHeader(setCookie)
  } catch {
    return null
  }
}

/** 'name=value' → { name, value }（写 electron session 用）；非法输入返回 null。 */
function splitCookieHeader(header) {
  const s = String(header || '').trim()
  const eq = s.indexOf('=')
  if (eq <= 0) return null
  return { name: s.slice(0, eq), value: s.slice(eq + 1) }
}

/**
 * 向对端 dsh-plus-surface 取 launch token（GET /dsh-plus-surface/launch.json）。
 * 插件只对环回连接吐 token；没装插件 / 旧版 / 非环回 → null。
 * 端口映射的远端实例：隧道在对端本机落地，插件看到的是环回，壳就能自动换证，
 * 不用再去翻 dsh web 打印的 URL。
 */
async function fetchLaunchToken(origin, fetchFn) {
  if (!origin) return null
  const fetcher = fetchFn || ((u, opts) => fetch(u, opts))
  try {
    const url = new URL('/dsh-plus-surface/launch.json', origin)
    const res = await fetcher(url.href, { signal: AbortSignal.timeout(2500) })
    if (!res || !res.ok) return null
    const body = typeof res.json === 'function' ? await res.json() : null
    const token = body && typeof body.token === 'string' ? body.token.trim() : ''
    return token || null
  } catch {
    return null
  }
}

/** 经插件取 token 再换 cookie。两步都成功才返回 'name=value'。 */
async function mintCookieFromPlugin(origin, fetchFn) {
  const token = await fetchLaunchToken(origin, fetchFn)
  if (!token) return null
  return mintCookieHeader(origin, token, fetchFn)
}

module.exports = {
  parseAnnounceLine,
  scanAnnounceUrl,
  extractLaunchToken,
  coerceLaunchToken,
  stripToken,
  setCookieToHeader,
  mintCookieHeader,
  splitCookieHeader,
  fetchLaunchToken,
  mintCookieFromPlugin,
}
