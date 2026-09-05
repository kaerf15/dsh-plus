// recipe 加载 & 热更新。
//
// 两级各一份 recipe.json（同 item.id 时后者覆盖）：
//   bundledDir/recipe.json  = 随包默认 —— dsh-plus/recipes/recipe.json
//   userDir/recipe.json     = 用户覆盖/追加 —— ~/.dsh/dsh-plus/recipe.json（与 bridge.json 同目录）
// 新内容写进这一份文件的 items（或顶层 recipes 数组并列不同 source），不要按场景新建目录。
// SKILL.md 只在插件 bundle 里。
//
// 热更新用 1s 轮询 + 变化比对（与 bridge.json 的 fs.watchFile 同一思路，跨平台稳）：
// 改/丢 recipe.json，1s 内重新读到 → 内容变化才发 'change'，没变化不吵。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const POLL_INTERVAL_MS = 1000

/** 图标文件扩展名 → MIME（用于把相对路径读成 data URI） */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** 只有「像图片文件相对路径」的 glyph 才转 data URI；命名图标 / 内联 SVG / data/URL 原样保留 */
function looksLikeImagePath(glyph) {
  if (typeof glyph !== 'string') return false
  const s = glyph.trim()
  if (!s) return false
  if (s.startsWith('<svg') || s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')) return false
  const lower = s.toLowerCase()
  return Object.keys(IMAGE_MIME).some((ext) => lower.endsWith(ext))
}

/** 把相对路径读成 data URI；读不到就原样返回（渲染层会降级），不阻断 recipe 生效 */
function toDataUri(dir, glyph) {
  const file = path.resolve(dir, glyph)
  try {
    const buf = fs.readFileSync(file)
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return glyph
  }
}

/** 事后遍历 recipe，把 items[].glyph 里的图片相对路径换成 data URI */
function resolveGlyphs(recipe, dir) {
  for (const item of recipe.items || []) {
    if (item && looksLikeImagePath(item.glyph)) item.glyph = toDataUri(dir, item.glyph)
  }
  return recipe
}

/** recipe.json 最小校验：顶层有 items，或 recipes 数组。语义错误由求值器容错。 */
function parseRecipe(raw) {
  let r
  try { r = JSON.parse(raw) } catch { return null }
  if (!r || typeof r !== 'object') return null
  if (Array.isArray(r.items) || Array.isArray(r.recipes)) return r
  return null
}

/** 一份文件 → 一条或多条 recipe。不同 source（会话桥 / HTTP）用顶层 recipes 数组并列。 */
function expandDoc(doc) {
  if (!doc) return []
  if (Array.isArray(doc.recipes)) {
    return doc.recipes.filter((r) => r && typeof r === 'object' && Array.isArray(r.items))
  }
  if (Array.isArray(doc.items)) return [doc]
  return []
}

class RecipeLoader extends EventEmitter {
  /**
   * @param {{ bundledDir?: string, userDir?: string, log?: (msg:string)=>void }} opts
   */
  constructor({ bundledDir = null, userDir = null, log = null } = {}) {
    super()
    this.bundledDir = bundledDir
    this.userDir = userDir
    this.log = log || (() => {})
    this.recipes = []
    this._lastKey = ''
    this._timer = null
  }

  /** 读目录下那一份 recipe.json（没有文件 = 空）。 */
  _readFile(dir) {
    if (!dir) return []
    const file = path.join(dir, 'recipe.json')
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
    const doc = parseRecipe(raw)
    if (!doc) {
      this.log(`[surface] 忽略无效 recipe: ${file}`)
      return []
    }
    const out = expandDoc(doc)
    for (const recipe of out) resolveGlyphs(recipe, dir)
    return out
  }

  _reload() {
    this.recipes = [...this._readFile(this.bundledDir), ...this._readFile(this.userDir)]
  }

  _maybeRefresh() {
    this._reload()
    const key = JSON.stringify(this.recipes)
    if (key === this._lastKey) return
    this._lastKey = key
    this.log(`[surface] recipe 集变化：${this.recipes.length} 条，热更新生效`)
    this.emit('change', this.recipes)
  }

  start() {
    this._reload()
    this._lastKey = JSON.stringify(this.recipes)
    this.log(`[surface] recipe 就绪：${this.recipes.length} 条`)
    if (this.userDir) {
      try { fs.mkdirSync(this.userDir, { recursive: true }) } catch {}
    }
    this._timer = setInterval(() => this._maybeRefresh(), POLL_INTERVAL_MS)
    this._timer.unref?.() // 不挡进程退出
    return this
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }
}

module.exports = { RecipeLoader, parseRecipe, expandDoc, looksLikeImagePath, toDataUri }