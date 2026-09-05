// Touch Bar 显示面（electron 胶水层，薄薄一层）。
// 只做两件事：把纯逻辑产出的按钮描述符转成 TouchBar/TouchBarButton，返回给 main.js 挂到窗口。
// macOS 才有 TouchBar API；其它平台或无可上条内容时返回 null（main.js 调 setTouchBar(null) 清空）。
'use strict'

const electron = require('electron')
const { itemsToTouchBarSpecs } = require('./surface/touchbar.js')

/**
 * @param {object[]} items Hub.snapshot() 的 Item 列表
 * @param {(id:string)=>any} onTap 点击回调（main.js 传 hub.dispatchById）
 * @returns {import('electron').TouchBar|null}
 */
function buildTouchBar(items, onTap) {
  const { TouchBar, TouchBarButton, nativeImage } = electron
  if (!TouchBar || !TouchBarButton) return null
  const specs = itemsToTouchBarSpecs(items)
  if (specs.length === 0) return null
  const buttons = specs.map((s) => {
    const opts = { label: s.label }
    if (s.color) opts.backgroundColor = s.color
    if (s.hasAction) opts.click = () => onTap(s.id)
    // glyph（data: URI，appicon: 已在 main.js 水合）→ NativeImage；SVG/命名图标无法光栅化，跳过
    if (s.glyph && nativeImage) {
      try {
        const img = nativeImage.createFromDataURL(s.glyph)
        if (img && !img.isEmpty()) opts.icon = img
      } catch { /* 坏 data URI 按无图标处理 */ }
    }
    return new TouchBarButton(opts)
  })
  return new TouchBar({ items: buttons })
}

module.exports = { buildTouchBar }