// 壳侧「注意力」层：区分「后台页面里会话仍被选中」与「用户真的在看这个应用」。
// pi 系：只在 shellCanSeeApp 时才 markViewed（见 main.js noteViewedFromUrl）。
// dsh 插件：completed 由 host 依各 client 选中上报推导、pendingInteraction 绑页面选中态；
// 应用不在前台、窗口失焦 / 不可见时由壳按 host 真相或粘性缓存重投影。
'use strict'

/**
 * @param {{ isVisible: () => boolean, isMinimized: () => boolean, isFocused?: () => boolean, isDestroyed?: () => boolean }} win
 * @param {string} activeAppId
 * @param {boolean} toolbarOverlayOpen
 * @param {string} appId
 */
function shellCanSeeApp(win, activeAppId, toolbarOverlayOpen, appId) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return false
  if (!win.isVisible() || win.isMinimized()) return false
  // 切到别的 macOS 应用（窗口仍露在外面）也算「没看到」
  if (typeof win.isFocused === 'function' && !win.isFocused()) return false
  if (toolbarOverlayOpen) return false
  return appId === activeAppId
}

/** 待交互粘性：client 在「选中但看不见」时常清 pendingInteraction，后台时由壳补回 */
function createPendingSticky() {
  const bySession = new Map()
  return {
    /** 前台：信 client 清空；后台：只记不减（除非显式 clear） */
    noteFromFacts(canSee, facts) {
      for (const f of facts) {
        const id = String(f.sessionId)
        if (f.pendingInteraction) bySession.set(id, f.pendingInteraction)
        else if (canSee) bySession.delete(id)
      }
    },
    apply(canSee, facts) {
      this.noteFromFacts(canSee, facts)
      if (canSee) return facts
      return facts.map((f) => {
        const stuck = bySession.get(String(f.sessionId))
        if (stuck && !f.pendingInteraction) return { ...f, pendingInteraction: stuck }
        return f
      })
    },
    clear(sessionId) { bySession.delete(String(sessionId)) },
  }
}

/**
 * 记录 running→idle 且用户当时看不见 的会话；启动首轮只建基线，不把历史 idle 当成未看。
 */
function createFinishedUnseenTracker() {
  const prevStatus = new Map()
  const unseen = new Set()
  let primed = false

  return {
    observe(canSee, facts) {
      if (!primed) {
        for (const f of facts) prevStatus.set(String(f.sessionId), f.status)
        primed = true
        return
      }
      for (const f of facts) {
        const id = String(f.sessionId)
        const was = prevStatus.get(id)
        const now = f.status
        if (was === 'running' && now === 'idle' && !canSee) unseen.add(id)
        if (now === 'running') unseen.delete(id)
        prevStatus.set(id, now)
      }
      if (canSee) {
        for (const f of facts) {
          if (!f.completed) unseen.delete(String(f.sessionId))
        }
      }
    },
    has(id) { return unseen.has(String(id)) },
    clear(id) { unseen.delete(String(id)) },
  }
}

/**
 * dsh 插件事实：仅在「后台跑完」或 client 已报 completed 时出红泡，不把历史 idle 全扫成未看。
 */
function projectDshFactsWithAttention(canSee, cleared, pendingSticky, unseenTracker, facts) {
  unseenTracker.observe(canSee, facts)
  const withPending = pendingSticky.apply(canSee, facts)
  // 点气泡 = 看过的显式手势，前后台都生效：选中上报（选中即清）是主路，cleared 是兜底——
  // 会话已删（client 永远不会再回传）或同步丢失时，点过的气泡在前台也必须能消。
  // （后台分支不在这里预过滤：下方 map 的 done 判定已查 cleared，前置是双重检查。）
  // cleared 由 syncAttentionRunning 在下一个 running 沿摘除，不影响重新武装。
  if (canSee) {
    if (!cleared || !cleared.size) return withPending
    return withPending.map((f) => (f.completed && cleared.has(String(f.sessionId)) ? { ...f, completed: false } : f))
  }
  return withPending.map((f) => {
    if (f.status === 'running') return f
    if (f.bootstrapped) return { ...f, completed: false }
    const id = String(f.sessionId)
    const done = (f.completed === true || unseenTracker.has(id)) && !cleared.has(id)
    return { ...f, completed: done }
  })
}

/** running 沿：从粘性清除集摘掉，下一轮结束可再提醒 */
function syncAttentionRunning(cleared, facts) {
  if (!cleared || !cleared.size) return
  for (const f of facts) {
    if (f.status === 'running') cleared.delete(String(f.sessionId))
  }
}

module.exports = {
  shellCanSeeApp,
  createPendingSticky,
  createFinishedUnseenTracker,
  projectDshFactsWithAttention,
  syncAttentionRunning,
}
