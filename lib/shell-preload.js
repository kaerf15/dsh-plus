// 功能区 preload：在 sandbox + contextIsolation 下向功能区 HTML 暴露最小 IPC 桥
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  platform: process.platform,
  getApps: () => ipcRenderer.invoke('shell:get-apps'),
  switchTo: (id) => ipcRenderer.send('shell:switch-app', id),
  reloadApp: (id) => ipcRenderer.send('shell:reload-app', id),
  addApp: (info) => ipcRenderer.invoke('shell:add-app', info),
  minimize: () => ipcRenderer.send('shell:minimize'),
  hide: () => ipcRenderer.send('shell:hide'),
  dragStart: () => ipcRenderer.send('shell:drag-start'),
  dragEnd: () => ipcRenderer.send('shell:drag-end'),
  setAddFormOpen: (open) => ipcRenderer.send('shell:set-add-form-open', open),
  appMenu: (id) => ipcRenderer.send('shell:app-menu', id),
  onOpenEdit: (cb) => ipcRenderer.on('shell:open-edit', (_e, app) => cb(app)),
  onAppsChanged: (cb) => ipcRenderer.on('shell:apps-changed', (_e, apps) => cb(apps)),
  reorderApps: (dragId, targetId) => ipcRenderer.send('shell:reorder-apps', dragId, targetId),
  getShortcuts: () => ipcRenderer.invoke('shell:get-shortcuts'),
  setShortcuts: (sc) => ipcRenderer.invoke('shell:set-shortcuts', sc),
  resetShortcuts: () => ipcRenderer.invoke('shell:reset-shortcuts'),
  setShortcutRecording: (on) => ipcRenderer.send('shell:shortcut-recording', on),
  onOpenShortcuts: (cb) => ipcRenderer.on('shell:open-shortcuts', () => cb()),
  getNotifications: () => ipcRenderer.invoke('shell:get-notifications'),
  setNotifications: (opts) => ipcRenderer.invoke('shell:set-notifications', opts),
  setNotificationsPanelOpen: (open) => ipcRenderer.send('shell:set-notifications-panel-open', open),
  onOpenNotifications: (cb) => ipcRenderer.on('shell:open-notifications', () => cb()),
  dsh: {
    getStatus: () => ipcRenderer.invoke('dsh:get-status'),
    listVersions: () => ipcRenderer.invoke('dsh:list-versions'),
    install: (version) => ipcRenderer.invoke('dsh:install', version),
    onInstallProgress: (cb) => ipcRenderer.on('dsh:install-progress', (_e, line) => cb(line)),
    onOpenInstallPanel: (cb) => ipcRenderer.on('dsh:open-install-panel', () => cb()),
    onStatusChanged: (cb) => ipcRenderer.on('dsh:status-changed', (_e, st) => cb(st)),
  },
  surface: {
    getState: () => ipcRenderer.invoke('surface:get-state'),
    dispatch: (id) => ipcRenderer.send('surface:dispatch', String(id)),
    onUpdate: (cb) => ipcRenderer.on('surface:update', (_e, state) => cb(state.items)),
    showTip: (info) => ipcRenderer.send('surface:tip-show', info),
    hideTip: () => ipcRenderer.send('surface:tip-hide'),
  },
  // 应用图标角标（Windows overlay 用）：主进程请功能区渲染计数图标，渲染完回传
  onRenderBadge: (cb) => ipcRenderer.on('shell:render-badge', (_e, n) => cb(n)),
  sendBadgeIcon: (dataUrl, count) => ipcRenderer.send('shell:badge-icon', { icon: dataUrl, count }),
})