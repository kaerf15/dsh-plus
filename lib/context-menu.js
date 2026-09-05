// 应用视图原生右键菜单：编辑区剪切/粘贴、链接在新标签页打开、复制链接/图片地址、重载、开发者工具。
// 兜底逻辑：页面自己弹了菜单（role=menu 可见）就不抢，避免和网页右键菜单打架。
'use strict'

const { Menu, shell, clipboard } = require('electron')

function formatAccelerator(sc, fallback) {
  if (!sc || !sc.key) return fallback
  const parts = []
  if (sc.meta) parts.push('Cmd')
  if (sc.control) parts.push('Ctrl')
  if (sc.alt) parts.push('Alt')
  if (sc.shift) parts.push('Shift')
  const keyMap = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }
  parts.push(keyMap[sc.key] || sc.key)
  return parts.join('+')
}

function buildContextMenuTemplate(view, app, params, getShortcuts) {
  const t = []
  const isMac = process.platform === 'darwin'
  const sc = typeof getShortcuts === 'function' ? getShortcuts() : null
  const backAcc = formatAccelerator(sc && sc.back, isMac ? 'Cmd+[' : 'Alt+Left')
  const fwdAcc = formatAccelerator(sc && sc.forward, isMac ? 'Cmd+]' : 'Alt+Right')

  // 在普通网页空白处右键时，首屏展示标准的浏览器导航项（返回、前进）
  if (!params.isEditable && (!params.selectionText || !params.selectionText.trim()) && !params.linkURL && !params.imageURL) {
    const canBack = Boolean(view.webContents && !view.webContents.isDestroyed() && view.webContents.canGoBack())
    const canFwd = Boolean(view.webContents && !view.webContents.isDestroyed() && view.webContents.canGoForward())
    t.push({
      label: '返回',
      accelerator: backAcc,
      enabled: canBack,
      click: () => {
        try {
          if (view.webContents && !view.webContents.isDestroyed() && view.webContents.canGoBack()) {
            view.webContents.goBack()
          }
        } catch {}
      },
    })
    t.push({
      label: '前进',
      accelerator: fwdAcc,
      enabled: canFwd,
      click: () => {
        try {
          if (view.webContents && !view.webContents.isDestroyed() && view.webContents.canGoForward()) {
            view.webContents.goForward()
          }
        } catch {}
      },
    })
  }

  if (params.isEditable) {
    t.push({ role: 'cut', enabled: params.editFlags.canCut })
    t.push({ role: 'copy', enabled: params.editFlags.canCopy })
    t.push({ role: 'paste', enabled: params.editFlags.canPaste })
    t.push({ type: 'separator' })
    t.push({ role: 'selectAll', enabled: params.editFlags.canSelectAll })
  } else if (params.selectionText && params.selectionText.trim() !== '') {
    t.push({ role: 'copy' })
  }

  const targetUrl = app.url
  if (params.linkURL) {
    if (t.length) t.push({ type: 'separator' })
    t.push({
      label: '在新标签页中打开链接',
      click: () => {
        try {
          if (new URL(params.linkURL).origin === new URL(targetUrl).origin) view.webContents.loadURL(params.linkURL)
          else shell.openExternal(params.linkURL)
        } catch { shell.openExternal(params.linkURL) }
      },
    })
    t.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) })
  }
  if (params.imageURL) {
    if (t.length) t.push({ type: 'separator' })
    t.push({ label: '复制图片地址', click: () => clipboard.writeText(params.imageURL) })
    t.push({ label: '用浏览器打开图片', click: () => shell.openExternal(params.imageURL) })
  }
  if (t.length) t.push({ type: 'separator' })
  // 显式刷新/开发者工具：role 在 WebContentsView 下会作用到主窗口（功能区）而非当前应用视图，
  // 这里明确绑定 view.webContents，确保「加上的网页」右键刷新刷的是它自己。
  t.push({
    label: '刷新',
    click: () => {
      try {
        if (!view.webContents || view.webContents.isDestroyed()) return
        const u = view.webContents.getURL()
        // 加载失败后落定在离线页上，此时刷新应重试原始地址而非刷新离线页本身
        if (u && (u.startsWith('data:') || u.includes('offline.html'))) view.webContents.loadURL(app.url).catch(() => {})
        else view.webContents.reload()
      } catch {}
    },
  })
  t.push({
    label: '开发者工具',
    click: () => {
      try {
        if (view.webContents && !view.webContents.isDestroyed()) view.webContents.toggleDevTools()
      } catch {}
    },
  })
  return t
}

// getWindow: () => BrowserWindow（弹菜单时用于定位）
function setupContextMenu(view, app, getWindow, getShortcuts) {
  if (process.env.DSH_SHELL_NATIVE_MENU === '0') return
  const PAGE_MENU_PROBE = `Array.from(document.querySelectorAll('[role="menu"]'))
     .some(el => el.getClientRects().length > 0 && el.offsetParent !== null)`
  view.webContents.on('context-menu', (_event, params) => {
    if (!view.webContents || view.webContents.isDestroyed()) return
    const menu = Menu.buildFromTemplate(buildContextMenuTemplate(view, app, params, getShortcuts))
    // 立即探测，不设固定延时：页面自己的菜单若在 contextmenu 同步挂载，此刻已在 DOM 里。
    // 再 race 一道上限：页面忙/挂死时探测排不进主线程、可能永不返回——挂死的页面不可能有自己的菜单，
    // 超时照弹原生菜单。否则右键在慢页面上会迟迟不弹甚至永远不弹（刷新功能“不灵敏”的根因）。
    const probe = view.webContents.executeJavaScript(PAGE_MENU_PROBE, true).catch(() => false)
    const cap = new Promise((resolve) => setTimeout(() => resolve(false), 120))
    Promise.race([probe, cap]).then((hasPageMenu) => {
      if (!hasPageMenu && view.webContents && !view.webContents.isDestroyed()) {
        const parentWin = typeof getWindow === 'function' ? getWindow() : null
        if (parentWin && !parentWin.isDestroyed()) menu.popup({ window: parentWin })
        else menu.popup()
      }
    })
  })
}

module.exports = { setupContextMenu }