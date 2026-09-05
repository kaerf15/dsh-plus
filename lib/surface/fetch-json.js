// 壳侧事实源的公共小件：拉一个 JSON 端点（accept 头 + 超时 + res.ok 校验）。
// 机械本来长在 DshBridge / FactsDirSource / PiWebPollSource / probeApp 各一份，收拢到这里。
// 失败（网络错 / 非 2xx / 解析失败）统一返回 null，由调用方决定保留最后一帧还是清空——
// 两义性是有意的：需要区分「连不上」和「形状不对」的调用方（如 DshBridge.pollFactsOnce，
// 形状不对要保事实、连不上才退降级）不用本件，自带 fetch。
'use strict'

async function fetchJson(fetchImpl, url, { timeoutMs = 2500, headers } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res || !res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

module.exports = { fetchJson }
