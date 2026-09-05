// 系统通知中心：待交互（warn）+ 已完成未看（done）气泡，仅在用户看不见时提醒。
'use strict'

const { Notification } = require('electron')

function shouldNotifyItem(item, canSeeApp) {
  if (!item || item.kind !== 'bubble') return false
  if (item.semantic !== 'done' && item.semantic !== 'warn') return false
  const appId = item.appId || 'dsh'
  if (canSeeApp(appId)) return false
  return true
}

/** 从 hub 快照里挑出本次应新发通知的条目（已发过的不重复）。 */
function pickNewNotifiable(items, canSeeApp, notified) {
  const toNotify = []
  const active = new Set()
  for (const item of items || []) {
    if (!shouldNotifyItem(item, canSeeApp)) continue
    active.add(item.id)
    if (!notified.has(item.id)) toNotify.push(item)
  }
  for (const id of [...notified]) {
    if (!active.has(id)) notified.delete(id)
  }
  return toNotify
}

function notificationBody(item) {
  const title = item.title || ''
  const sub = item.subtitle || ''
  if (item.semantic === 'warn') {
    if (title && sub) return `${title} · ${sub}`
    return title || sub || '需要你的确认或回答'
  }
  if (title && sub) return `${title} · ${sub}`
  return title || sub || '点击查看对话结果'
}

function createSurfaceNotifications({
  getEnabled, getSuppress = () => false, canSeeApp, onClick, log = () => {},
  Notify = Notification,
}) {
  const notified = new Set()

  function clear() { notified.clear() }

  function sync(items) {
    if (!Notify.isSupported()) return
    const fresh = pickNewNotifiable(items, canSeeApp, notified)
    if (!getEnabled() || getSuppress()) return
    for (const item of fresh) {
      notified.add(item.id)
      const snap = {
        id: item.id,
        appId: item.appId,
        kind: item.kind,
        action: item.action
          ? { type: item.action.type, target: { ...(item.action.target || {}) } }
          : null,
      }
      try {
        const n = new Notify({
          title: item.semantic === 'warn' ? '待交互' : '对话已完成',
          body: notificationBody(item),
          silent: false,
        })
        n.on('failed', (_e, err) => {
          log(`[dsh-plus] 通知被系统拒绝: ${String(err && err.message ? err.message : err)}（macOS 需已签名的 .app）`)
          notified.delete(item.id)
        })
        n.on('click', () => onClick(snap))
        n.show()
      } catch (err) {
        log(`[dsh-plus] 通知发送失败: ${String(err && err.message ? err.message : err)}`)
        notified.delete(item.id)
      }
    }
  }

  return { sync, clear }
}

module.exports = { createSurfaceNotifications, shouldNotifyItem, pickNewNotifiable, notificationBody }
