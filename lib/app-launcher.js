// 本地应用启动：recipe 里「启动本地应用」条目的执行器 + `appicon:` glyph 水合。
//
// 与显示目标无关、与来源无关：本地应用启动器不是 Touch Bar 专属，也不是工具栏硬编码图标，
// 而是走 recipe/Item 既有管道——recipe 写一条固定条目，action.type='launch-app'，target.path = .app 路径，
// glyph 写 `appicon:<绝对路径>` 让壳自动取应用原始图标。条目出现在哪个显示面（DSH 图标右侧条目带 / Touch Bar），
// 由渲染层按 appId/kind 决定，这里只提供两件壳本地能力：
//   1. launch(path)：启动本机应用（shell.openPath，macOS 失败回退 `open`）
//   2. hydrateGlyphs(items)：把 Item.glyph 里的 `appicon:<path>` 异步解析成 data URI（app.getFileIcon + 缓存），
//      供 surface:get-state / surface:update 发送给功能区前调用——NativeImage 无法序列化，先转 data URI。

'use strict'

const { app, shell } = require('electron')
const { execFile } = require('node:child_process')

const APPICON_PREFIX = 'appicon:'

/** 启动本地应用。 */
function launch(appPath) {
  return shell.openPath(appPath).then((err) => {
    if (!err) return { ok: true }
    if (process.platform !== 'darwin') return { ok: false, message: String(err) }
    return new Promise((resolve) => {
      execFile('open', [appPath], (err2) => {
        resolve(err2 ? { ok: false, message: String(err2) } : { ok: true })
      })
    })
  }).catch((err) => ({ ok: false, message: String(err && err.message ? err.message : err) }))
}

const iconCache = new Map() // appPath -> dataURI | null（null = 取不到，避免反复试）

/** appicon:<path> → data URI（取不到返回 null，渲染层会按无 glyph 兜底）。 */
async function iconDataUri(appPath) {
  let cached = iconCache.get(appPath)
  if (cached !== undefined) return cached
  let data = null
  try {
    const img = await app.getFileIcon(appPath, { size: 'normal' })
    if (img && !img.isEmpty()) data = img.toDataURL()
  } catch { /* 取不到图标 */ }
  iconCache.set(appPath, data)
  return data
}

/** 把 Item 列表里的 appicon: glyph 水合成 data URI（原样保留其它 glyph / 字段）。 */
async function hydrateGlyphs(items) {
  const out = []
  for (const it of items || []) {
    if (it && typeof it.glyph === 'string' && it.glyph.startsWith(APPICON_PREFIX)) {
      const p = it.glyph.slice(APPICON_PREFIX.length)
      const data = p ? await iconDataUri(p) : null
      out.push(data ? { ...it, glyph: data } : { ...it, glyph: null })
    } else {
      out.push(it)
    }
  }
  return out
}

module.exports = { launch, hydrateGlyphs, iconDataUri, APPICON_PREFIX }