// 应用页专用 preload：只暴露一个底座口——往自己的图标推 Item（窗口化显示面，无输入）。
// 与 shell-preload（工具栏专用：getApps/switchTo/surface 等壳管理能力）严格分开，
// 加载进来的第三方页面拿不到壳控制权，只有「给我的图标发条目」这一条受控通道。
//
// sandbox 下 contextBridge 可用；暴露面刻意缩小到单个方法。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__shell', {
  emit: (items) => ipcRenderer.send('surface-emit', items),
})