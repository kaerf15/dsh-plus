#!/usr/bin/env node
// pi-dsh-plus-surface 事实出口（远端壳用）：把分片目录原样镜像成一份 HTTP JSON。
//
// 对应 dsh 侧的「HTTP 只读事实出口」（plugins/dsh-plus-surface 里
// webServer.register('/dsh-plus-surface/bridge.json')）：pi-web 没有可挂载的
// webServer、pi 扩展也开不了同源端点，出口独立成一个小 listener，由插件在
// session_start 时确保拉起（端口被占 = 已有实例在听，静默退场）。
// 安全口径与 dsh 侧一致：只读、绑环回、不开新端口；经端口映射暴露时确认映射工具不对公网开放。
//
// 只做搬运不做语义：归并、心跳折算、allowlist、completed 粘性清除全部留在壳的
// FactsDirSource（与本地分片目录同一套逻辑，一字不差）。本文件坏一行也不该改变事实语义。
//
// 接口：GET /pi-dsh-plus-surface/shards.json
//   → { "version":1, "updatedAt":…, "shards":[{ "name":"<sessionId>.json", "body":{…分片信封…} }] }
// name 与分片文件名一一对应（壳按 name 解码 sessionId，与 fs 读法同径）。

import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const FACTS_DIR = resolve(
  (process.env.DSH_PLUS_FACTS_DIR || '').trim() || join(homedir(), '.pi', 'dsh-plus', 'facts'),
)
const PORT = Number(process.env.DSH_PLUS_FACTS_PORT || 3099)
const ROUTE = '/pi-dsh-plus-surface/shards.json'

function readShards() {
  const shards = []
  let names = []
  try { names = readdirSync(FACTS_DIR) } catch { /* 目录不存在（插件未装/未跑过）：空镜像 */ }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue // 跳过 tmp 与非分片（与壳侧 fs 读法同径）
    let body
    try { body = JSON.parse(readFileSync(join(FACTS_DIR, name), 'utf8')) } catch { continue } // 写盘中途的瞬时态，下轮再读
    shards.push({ name, body })
  }
  return { version: 1, updatedAt: Date.now(), shards }
}

createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  const pathname = (req.url || '').split('?')[0]
  if (pathname !== ROUTE) {
    res.writeHead(404, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(readShards()))
})
  .on('error', (err) => {
    // 端口被占 = 已有实例在听（插件每次 session_start 都会试图拉起）：静默退场，不算错
    if (err && err.code === 'EADDRINUSE') process.exit(0)
    console.error(`[pi-dsh-plus-surface] 事实出口启动失败: ${String(err && err.message ? err.message : err)}`)
    process.exit(1)
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[pi-dsh-plus-surface] 事实出口就绪 → GET http://127.0.0.1:${PORT}${ROUTE}（目录 ${FACTS_DIR}）`)
  })
