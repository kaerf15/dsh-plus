// http-poll adapter：把「HTTP 源」recipe（source.type === 'http'）接进显示面。
//
// 每个 http recipe 声明一个 JSON 端点 + 一组 items 规则；adapter 定期 GET，
// 把响应归一成事实，再跑同一套 recipe 求值器 → Item。这样「采集来源」和「怎么画」
// 依旧是声明式、可热更新，与 dsh-sessions 的 recipe 同一条管道，只是事实来源不同。
//
// URL 支持 {name} 占位符（如 "{dsh}/deepseek-balance/overview"）：轮询时才展开，
// 跟着壳当前解析到的服务地址走——dsh web 重启换端口不会让灯静默死掉。
// 未提供对应变量的占位符保持原样，该轮跳过（灯灭，不报错）。

'use strict'

const { EventEmitter } = require('node:events')
const { evaluateRecipe, isHttpSource } = require('../recipes.js')

/** 展开 URL 中的 {name} 占位符。vars 可以是对象或 () => 对象（轮询时取，跟着服务地址走）。 */
function expandUrl(url, vars) {
  const v = typeof vars === 'function' ? vars() : (vars || {})
  return String(url).replace(/\{(\w+)\}/g, (m, k) =>
    (v[k] != null && v[k] !== '' ? String(v[k]).replace(/\/+$/, '') : m))
}

/** JSON 响应 → 事实数组：对象 → [对象]；数组 → 逐个元素成事实（带 _index）。 */
function httpToFacts(json) {
  if (Array.isArray(json)) {
    return json.map((x, i) => (x && typeof x === 'object' ? { ...x, _index: i } : { _index: i, value: x }))
  }
  if (json && typeof json === 'object') return [json]
  return [{ value: json }]
}

/** 单端点轮询器：变化才发 'update'（传 items 数组）。fetch 可注入以便测试。 */
class HttpPoller extends EventEmitter {
  constructor({ url, intervalMs = 3000, fetchFn = null, toItems, vars = null }) {
    super()
    this.url = url
    this.vars = vars
    this.intervalMs = Math.max(1000, Number(intervalMs) || 3000) // 下限 1s：防 recipe 配 0 高频轰炸
    this.fetchFn = fetchFn || ((u, opts) => fetch(u, opts))
    this.toItems = toItems || (() => [])
    this.timer = null
    this.lastKey = ''
    this.inFlight = false
  }

  async pollOnce() {
    if (this.inFlight) return // 上一发没回来就别叠发（慢端点下 setInterval 会重叠）
    const url = expandUrl(this.url, this.vars)
    if (url.includes('{')) return // 占位符没解开（服务地址还没就绪）：本轮跳过
    this.inFlight = true
    try {
      const res = await this.fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })
      if (!res || !res.ok) return
      const json = await res.json()
      const items = (this.toItems(json) || []).filter(Boolean)
      const key = JSON.stringify(items)
      if (key === this.lastKey) return
      this.lastKey = key
      this.emit('update', items)
    } catch { /* 网络/解析失败：静默，下轮再来 */ } finally { this.inFlight = false }
  }

  start() {
    this.pollOnce()
    this.timer = setInterval(() => this.pollOnce(), this.intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

/**
 * adapter：从 recipe 集里挑出 http source，每个开一个轮询器，把结果喂给 Hub。
 * @param {object} deps
 * @param {object} deps.hub             SurfaceHub
 * @param {Function|Array} deps.recipes  () => recipe[]（动态）或 recipe[]（快照）
 * @param {Function} deps.resolveAppId   (url) => appId|null：按 URL 找到对应应用，绑定 item.appId
 * @param {Function} deps.fetchFn        （可选）注入 fetch，测试用
 * @param {number} deps.intervalMs       （可选）默认轮询间隔
 */
function createHttpPollAdapter({ hub, recipes, resolveAppId, fetchFn, intervalMs, vars }) {
  const pollers = new Map() // url -> { poller, key }（key 记录 recipe 快照，变了就重建）

  function sourceOf(recipe) {
    return `http-poll:${recipe.domain || recipe.source.url}`
  }

  function toItemsFor(recipe) {
    return (json) => {
      // 每次轮询都重新按 URL 解析 appId，晚加入的应用也能被绑定（不写死在 poller 创建时）
      const appId = resolveAppId ? resolveAppId(expandUrl(recipe.source.url, vars)) : null
      return evaluateRecipe(recipe, httpToFacts(json)).map((item) => {
        if (appId && !item.appId) item.appId = appId
        return item
      })
    }
  }

  function resync() {
    const list = typeof recipes === 'function' ? recipes() : (recipes || [])
    const wanted = new Set()
    for (const recipe of list) {
      if (!isHttpSource(recipe)) continue
      const url = recipe.source && recipe.source.url
      if (!url) continue
      wanted.add(url)
      // 同 URL 但 recipe 内容变了（items / intervalMs）也要重建：toItems 是闭包，
      // 旧 poller 不重建就会永久跑旧规则——这正是热更新要覆盖的坑。
      const key = JSON.stringify(recipe)
      const cur = pollers.get(url)
      if (cur && cur.key === key) continue
      if (cur) cur.poller.stop()
      const p = new HttpPoller({
        url,
        fetchFn,
        vars,
        intervalMs: (recipe.source && recipe.source.intervalMs) || intervalMs || 3000,
        toItems: toItemsFor(recipe),
      })
      p.on('update', (items) => hub.setItems(sourceOf(recipe), items))
      pollers.set(url, { poller: p, key })
      p.start()
    }
    for (const [url, ent] of pollers) {
      if (!wanted.has(url)) { ent.poller.stop(); pollers.delete(url) }
    }
  }

  function start() { resync() }
  function refresh() { resync() }
  function stop() {
    for (const [, ent] of pollers) ent.poller.stop()
    pollers.clear()
  }

  return { start, refresh, stop }
}

module.exports = { createHttpPollAdapter, HttpPoller, httpToFacts, expandUrl }