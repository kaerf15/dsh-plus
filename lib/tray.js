// 托盘图标：assets/tray.png（DeepSeek 鲸鱼 template）+ @2x 自适应明暗
'use strict'

const { Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// opts: { assetsDir, tooltip, onShow, onToggle, onQuit }
function createTray({ assetsDir, tooltip = 'DSH+', onShow, onToggle, onQuit }) {
  const img = nativeImage.createFromPath(path.join(assetsDir, 'tray.png'))
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(assetsDir, 'tray@2x.png')) })
  // template image 是 macOS 菜单栏语义（随系统明暗反色）；Windows/Linux 当普通图标，
  // 设成 template 会变成看不清的剪影。
  if (process.platform === 'darwin') img.setTemplateImage(true)
  const tray = new Tray(img)
  tray.setToolTip(tooltip)
  tray.setContextMenu(Menu.buildFromTemplate([
    // 「打开主窗口」幂等 show+focus（窗口被毁则重建）；「显示 / 隐藏」是切换。
    // 分开两条：窗口意外消失时用户找的是「打开」，不是猜当前该切到哪边。
    { label: '打开主窗口', click: () => (onShow || onToggle)() },
    { label: '显示 / 隐藏窗口', click: () => onToggle() },
    { type: 'separator' },
    { label: '退出 Shell', click: () => onQuit() },
  ]))
  return tray
}

module.exports = { createTray }