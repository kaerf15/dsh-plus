# DSH+（DSH+）— 开发交接文档

> 本文档给**接手开发的工具/人**看：项目现状、架构、设计决策、已完成与未完成、坑与注意点。
> 看完本文 + `main.js` + `lib/` 三件套，即可独立继续开发。
>
> 版本记录：单应用壳（v1）已于 2026-08-22 升级为**多应用容器**（v2），本文已同步。

---

## 1. 这是什么

给本地服务套一个**原生桌面窗口**的桌面壳，现为**多应用容器**：

- **顶部一条自绘功能区（工具栏）** + **下方 WebContentsView 应用区**
- 默认应用 **DSH**（dsh web，自动定位/拉起/托管）；任何人可点功能区 `+` 添加任意 `http(s)` 应用（本地服务、网页均可）
- 核心思想不变：**壳与内容解耦**——DSH 本体与插件在 `~/.dsh` 官方更新，壳永远不用跟着升级/重打包
- 用户自用：免打包、免签名、免公证、免认证；**进出壳管一切**（见 §7），平时不碰终端

> **架构方向（2026-08-24 起）**：功能区的「内容 + 按钮」正在从 DSH 专属的硬编码，重构为一条与来源/显示目标无关的**显示面（Surface）管道**——事实（Fact）→ 条目（Item）→ 渲染面（Surface），详见 [`DESIGN-surface.md`](DESIGN-surface.md)。新代码在 `lib/surface/`（`model.js` / `hub.js` / `adapters/`）；`lib/bridge.js` 暂作 DSH 事实源，后续迁入插件侧 Skill 模板。

## 2. 目录结构

```
dsh-plus/
├── package.json         # name: dsh-plus; productName: DSH+; main: main.js; scripts.start: electron .
│                        # devDependencies: electron 43.4.0 + electron-builder 26；scripts.dist 打包（--dir）
├── main.js              # 主进程（≈500 行）：窗口 / 功能区 / 应用视图 / IPC / DSH 管理 UI，组装各模块
├── assets/              # icon.png（Dock 蓝底白鲸）+ tray.png / tray@2x.png（托盘鲸鱼 template）
├── lib/
│   ├── dsh-service.js   # dsh web 进程生命周期：解析地址（三级兜底）/ 拉起 / 停止 / 重启（纯 Node、可独立测试）
│   ├── detect-dsh.js    # dsh web 端口自动检测（纯 Node、无 electron 依赖、可独立测试；findDshPort 支持 listPorts 注入）
│   ├── dsh-manage.js    # DSH 安装/版本管理：检测安装、读版本、查最新/列版本、npm 一键安装（纯 Node、可独立测试）
│   ├── tray.js          # 托盘图标 + 菜单（鲸鱼 template）
│   ├── context-menu.js  # 应用视图原生右键菜单（编辑/链接/图片/重载）
│   ├── shell-ui.html    # 功能区 UI：自绘工具栏（应用按钮/图标 + "+"添加应用表单 + DSH 安装面板），明暗主题自适应
│   └── shell-preload.js # 功能区 preload：sandbox + contextIsolation 下暴露 window.shell IPC 桥（含 window.shell.dsh.*）
├── test/
│   └── detect.test.mjs  # 端口检测测试（node:test，7 个用例；findDshPort 用 listPorts 注入消除 netstat 快照竞态）
└── README.md            # 面向使用者的简短说明
```

## 3. 双 webContents 模型（理解架构的关键）

```
┌──────────────────────────────────────────────────┐
│ 功能区 = win.webContents（loadFile lib/shell-ui.html）│ 44px
│          preload 注入 window.shell（ipcMain 桥）      │
├──────────────────────────────────────────────────┤
│ 应用区 = WebContentsView（每应用一个，切换显隐）          │
│   win.contentView.addChildView(view)                 │
│   仅 activeAppId 的 view visible                     │
│   bounds: {x:0, y:TOOLBAR_HEIGHT, w, h−TOOLBAR_HEIGHT}│
└──────────────────────────────────────────────────┘
```

- 几何：`TOOLBAR_HEIGHT = 44`；macOS 左上让位红黄绿（`trafficLightPosition {16,15}`，UI padding-left 80px）；Windows 右上让位 min/max/close（`titleBarOverlay`，UI padding-right 140px）
- 窗口 `titleBarStyle: 'hidden'`（自绘标题栏）；功能区整条 `-webkit-app-region: drag` 可拖拽，按钮/表单 `no-drag`
- `layoutViews()`：resize / 切换时重算可见 view 的 bounds

## 4. 应用注册表 + IPC

- 状态：`apps` 数组 `{ id, name, url, icon, initial }`；`appViews` Map `id → WebContentsView`；`activeAppId`
- **持久化**：用户添加的应用写入 `~/Library/Application Support/DSH+/apps.json`（DSH 内置应用不存）；启动时读取并恢复，因此关闭壳再开工具栏仍保留
- 默认应用：`apps = [{ id:'dsh', name:'DSH', url: currentUrl, icon:null, initial:'D', builtin:'dsh' }]`（currentUrl 来自 §6 端口定位），窗口重开只重建视图、不重置注册表
- `createAppView(app)`：WebContentsView（`contextIsolation:true / nodeIntegration:false / sandbox:true`)→ `win.contentView.addChildView` → setWindowOpenHandler（同源在 view 内跳转、外链系统浏览器）→ 挂右键兜底（§8）→ 抓 favicon（`page-favicon-updated` 更新 app.icon 并广播）→ loadURL（失败显示 data:URL 提示页）→ layoutViews
- `switchApp(id)`：切 activeAppId → layoutViews + broadcastApps
- `saveApps()` / `loadApps()`：读写 `apps.json`，增删改应用后自动保存、`before-quit` 再保存一次
- IPC 表（主进程 ⇄ 功能区，经 `lib/shell-preload.js` 暴露为 `window.shell.*`）：

| IPC | 方向 | 说明 |
|---|---|---|
| `shell:get-apps` | invoke | 返回 apps（含 active 标记） |
| `shell:apps-changed` | 主→页 | broadcastApps 广播（app 增删 / 图标 / active 变化） |
| `shell:switch-app` | send | 切换应用 |
| `shell:add-app` {name,url} | invoke | 校验 http(s) → push apps → createAppView → switchApp → saveApps()；返回 {ok,id} |
| `shell:edit-app` {id,name,url} | invoke | 编辑已有应用 URL/名称，改完后 saveApps() |
| `shell:remove-app` {id} | send | 删除应用，saveApps()
| `shell:minimize` / `shell:hide` | send | 窗口最小化 / 隐藏 |

**DSH 管理 IPC（主进程 ⇄ 功能区，经 `window.shell.dsh.*`）**：

| IPC | 方向 | 说明 |
|---|---|---|
| `dsh:get-status` | invoke | 返回 `{installed, version, appUrl, managed}`（是否安装 / 版本 / 是否壳托管） |
| `dsh:list-versions` | invoke | `npm view @deepseek-ai/dsh versions --json`，倒序返回全部版本 |
| `dsh:install` {version} | invoke | `npm install -g @deepseek-ai/dsh@版本`（长任务），安装成功后自动 `restartDsh()`，然后广播状态 |
| `dsh:open-install-panel` | 主→页 | **首次启动未安装 DSH 时**自动打开版本选择面板；功能区不再常驻该入口 |

> 检查更新、重启 DSH 不经过 IPC：由主进程右键菜单（`showDshMenu`）直接调用，用系统对话框（`dialog.showMessageBox`）反馈结果。右键菜单已去掉「安装 / 更换版本」常驻入口。

## 5. 代码地图（main.js + lib 模块）

| 位置 | 内容 |
|---|---|
| 顶部常量/几何 | `TOOLBAR_HEIGHT=44` |
| 全局状态 | `win`、`tray`、`quitting`、`installing`、`apps`、`activeAppId`、`appViews`、`toolbarOverlayOpen` |
| `lib/dsh-service.js` | `DshService`：dsh web URL 解析、spawn、kill、restart、stop（纯 Node，无 electron 依赖） |
| `lib/tray.js` | `createTray({ assetsDir, onToggle, onQuit })`：鲸鱼 template 托盘 |
| `lib/context-menu.js` | `setupContextMenu(view, app, getWindow)`：每个应用 view 的原生右键兜底 |
| `lib/detect-dsh.js` | dsh web 端口自动检测（见 §6） |
| `lib/dsh-manage.js` | DSH 安装/版本管理：检测安装、列版本、npm 一键安装 |
| `loadApps() / saveApps()` | 读写 `~/Library/Application Support/DSH+/apps.json`；用户应用增删改/退出时自动保存 |
| `createAppView(app)` | 创建 WebContentsView、挂右键、抓 favicon、loadURL |
| `createWindow()` | 隐藏标题栏窗口 → 功能区 loadFile(shell-ui.html) → 恢复所有应用视图 |
| `layoutViews()` / `broadcastApps()` | resize/切换时重算可见 view bounds；向功能区广播应用列表 |
| `showDshMenu()` | DSH 右键管理菜单（检查更新、重启 DSH；已去掉常驻「安装/更换版本」入口） |
| `restartDsh()` / `doInstallVersion()` / `checkForUpdate()` | DSH 重启与安装；安装成功后自动 restartDsh |
| 生命周期 | 单实例锁；启动时检测 DSH 是否安装；关窗口不退出；Cmd+Q/托盘退出才 quit；`before-quit → saveApps(); service.stop()` |

## 6. 端口定位（不写死 3080，任何端口都能接住）

`lib/detect-dsh.js`，顺序：

```
1. DSH_URL 环境变量（显式指定，最高优先）
2. 扫描本机监听端口 → 命中任一 dsh 特征 → 连接
   特征：'<title>DeepSeek Harness</title>' / 'deepseek-ai/dsh-api-gateway'
        / 'deepseek-ai/dsh-client-modules' / 'deepseek-ai/dsh-client-connection'（任一命中）
   先试 3080 → netstat 列出 127.0.0.1 监听端口（mac/Linux: -an -p tcp；Win: -ano）→ 并发 8 路探测
   特征可用 DSH_SHELL_SIGNATURES=逗号分隔覆盖（官方改版救场）
3. 没找到且 AUTO_SPAWN → pickFreePort(3080) 自选空闲端口 → dsh web --port N --no-open
   → waitForHttpReady（只等 HTTP 2xx/3xx/4xx 响应，不信特征——端口是壳自选的）
```

## 7. 进/出壳 dsh 进程语义（方案 B：退出时全部停止）

- dsh web 进程生命周期由 `lib/dsh-service.js` 的 `DshService` 统一封装
- 启动时：`resolveUrl()` 按 §6 三级兜底定位；已安装则自动拉起；未安装则返回 null（不阻塞，等用户通过面板安装）
- 安装成功后：自动 `restartDsh()` 拉起并加载新实例
- `DshService.stop()`：退出壳时**停止托管实例 + 当前连接端口上的所有 dsh web 实例**（包括外部手动启动的），保持桌面干净
- 拉起后就绪失败 → 自动清理未就绪实例（不残留）
- 壳被强杀（kill -9）→ 托管 dsh 成孤儿，下次启动按外部实例连接（不托管）

**测试教训（已踩过）**：不要杀用户正在用的 dsh 来测托管链路（用户可能正用别的工具/脚本反复拉起）。
安全验证：① 确认无 dsh 时开壳 → 日志出现 `已自动拉起 dsh web` → 退壳 → 该 dsh 消失。

## 8. 右键菜单（每个应用 view 独立兜底）

- dsh 页面自实现的菜单（如 JSON 树）是 DOM 实现，Electron 不拦截，照常工作
- 壳补**原生右键兜底**（挂在每个 view 的 `context-menu` 事件）：
  - 可编辑区：剪切/复制/粘贴/全选；选中文字：复制
  - 链接：同源在应用 view 内打开 / 复制链接地址（外链走系统浏览器）
  - 图片：复制图片地址 / 用浏览器打开；总是有：刷新 / DevTools
- **防双弹**：延迟 80ms 用 `executeJavaScript` 探测页面已有可见 `[role="menu"]` 则不叠加
- 关闭：`DSH_SHELL_NATIVE_MENU=0`

## 9. 平台兼容

- 一份代码通吃 macOS / Windows
- Windows 差异：`spawn('dsh.cmd', ..., {shell:true, windowsHide:true})`；netstat `-ano`；窗口用 `titleBarOverlay`（mac 用 trafficLightPosition）
- 服务均仅绑定 127.0.0.1
- 打包可选、自用可跳过：`npx electron-builder --dir` 出未签名 .app + `xattr -dr com.apple.quarantine`；对外分发才需要签名/公证（$99/年，用户暂不做）

## 10. 环境变量一览

| 变量 | 作用 |
|---|---|
| `DSH_URL` | 显式 dsh web 地址（最高优先） |
| `DSH_SHELL_NO_SPAWN=1` | 禁止自动拉起 dsh |
| `DSH_SHELL_SIGNATURES` | 覆盖检测特征（逗号分隔） |
| `DSH_SHELL_NATIVE_MENU=0` | 关闭原生右键菜单兜底 |

## 11. 测试

```bash
cd dsh-plus
node --test test/*.test.mjs   # 全部单测（当前 37 个）；裸 node --test test/ 会报 MODULE_NOT_FOUND
node --check main.js          # 语法检查
npm start                     # 跑壳（冒烟方法见 §12）
```

## 12. 已知问题 / 注意点

- **单实例锁**：`requestSingleInstanceLock` 失败即退出；测试残留旧壳实例会导致新壳"秒退"（日志空）。
  排查：杀干净 `dsh-plus/node_modules/electron` 相关进程（主进程命令行 `.../Electron.app/Contents/MacOS/Electron .`）。
- **冒烟测试方法（隔离法）**：打包版壳（`/Applications/DSH+.app`）占着单实例锁时，源码 `npm start` 会秒退。用独立 userData 起源码实例即可隔离开锁和配置，且复用已在跑的 DSH（不会二次拉起）：
  `ELECTRON_ENABLE_LOGGING=1 ./node_modules/.bin/electron . --user-data-dir=/tmp/dsh-plus-smoke-ud`
  `ELECTRON_ENABLE_LOGGING=1` 会把渲染层 console/异常和主进程 `[dsh-plus]` 日志都打到 stdout；跑完 `pkill -f dsh-plus-smoke-ud` 精准回收（不动打包版）。
- **打包版壳被 kill 会被 launchd 自动拉起**：`kill` 主进程后 macOS 以 `application.com.dshplus.app.<pid>.<session>` 重新拉起并重新夺回单实例锁。要换源码实例，用 `osascript -e 'tell application "DSH+" to quit'` 优雅退出（走 before-quit，连带停托管 dsh）。
- **bridge 事实调试**：`DSH_BRIDGE_DEBUG=1` 时 bridge 每读一次事实文件打 `[bridge] 读文件: N 条`。事实来自 dsh 插件写的 bridge 文件（`~/.dsh` 下），`/api/session.list` 只是降级轮询。壳不派生视图；角标/气泡由 recipe 投影。
- **应用图标「已完成未看」计数角标**：`countDoneBubbles(hub.snapshot())`（kind=bubble 且 semantic=done，跨应用求和，与条目带红气泡同口径）。macOS/Linux 走 `app.setBadgeCount`（窗口藏托盘也显示）；Windows 无原生计数 API，用任务栏 overlay 图标——主进程无光栅字体，图标由功能区 canvas 渲染成 dataURL 经 IPC 回传（`shell:render-badge` → `shell:badge-icon`），0 时清空。功能区未加载完时主进程 send 会丢，`did-finish-load` 补一次。
- **dsh 0.1.2+ 一次性 token 鉴权适配**：0.1.2 起 dsh web 的 index 页、`/api/*`、Remote WS 全要签名 cookie（无 loopback 豁免；插件经 webServer 自建的精确路由不受闸门）。**页面接入不绑插件**：视图就是直接打开应用地址。壳能自己换证的情况（托管实例扫 stdout、URL 自带 `?token=`、对端碰巧有 launch.json、已落盘的 30 天 cookie）会静默换完再进；换不到就留官方 401，不换成壳的引导页。检测侧：`isDshOnPort` 把「401 + 正文恰好 unauthorized」也认作 dsh。
- **spawn 异步 error**：`spawn` 的 ENOENT 走 `'error'` 事件而非 throw，不监听会崩整个壳——已改为 Promise + `once('error')`。
- **lsof 误杀客户端**：杀托管 dsh 不带 `-sTCP:LISTEN` 会误杀壳自己的 keep-alive 连接——已加。
- **应用注册持久化**：用户添加的应用已保存到 `~/Library/Application Support/DSH+/apps.json`，重启自动恢复。
- **强杀遗留孤儿**：壳被 kill -9 时托管 dsh 不清理，属预期；下次按外部实例连接。
- **iCloud 桌面同步 × codesign**：项目在 `~/Desktop` 下时，iCloud 同步守护会持续给 `dist/` 里文件重打 `com.apple.FinderInfo` / `fileprovider.fpfs#P` 标记，导致 codesign 报 `resource fork ... detritus not allowed`，删了还会回来。**解法**：把 `.app` 移到 `/tmp` 签名后再部署；或把项目挪出桌面。
- **dsh 检测别只信 PATH**：Finder 启动的壳 PATH 很窄，且 dsh 可能装在 nvm/volta/asdf 动态路径。`dsh-manage.js` 的 `resolveDshBin()` 四层兜底（PATH → 常见路径 → npm prefix → 运行中端口特征），spawn 拉起也用解析出的完整路径。
- netstat 输出格式跨平台差异：macOS `127.0.0.1.3080 ...LISTEN`（点分隔）、Windows 冒号；正则已兼容（`[:.]`）。
- `executeJavaScript` 探测在页面未加载/沙箱异常时抛错 → catch 后照常弹原生菜单（降级不阻塞）。
- 日志：壳 stdout 需要 `ELECTRON_ENABLE_LOGGING=1` 可见；托管 dsh 日志在 `~/.dsh-plus-dsh.log`。
- **Dock 显示名**：未打包（`npm start`）时 macOS Dock 悬停名读 `node_modules/electron/dist/Electron.app` 的 `Info.plist`（默认 `Electron`），与 `app.setName`/`productName` 无关。已在 `Info.plist` 把它改成「DSH+」（备份 `Info.plist.bak`）。**`npm install`（重装 electron）会覆盖它，需要重做**：`cd node_modules/electron/dist/Electron.app/Contents && /usr/libexec/PlistBuddy -c "Set :CFBundleName DSH+" -c "Set :CFBundleDisplayName DSH+" Info.plist`。正式解法是打包成 `.app`（electron-builder）。

## 13. 后续优化方向（按需）

- 窗口位置/大小记忆（重启恢复几何）
- 功能区细节：应用拖拽排序、多应用懒加载（切到才起/切走可冻，降内存）
- **接入终端（terminal）**：把纯 CLI agent 作为「终端应用」嵌进容器（xterm.js + node-pty），busy 走 `process` 通道（见 §16）——后续开发

## 14. DSH 官方色板（功能区配色参考，curl `@deepseek-ai/dsh-client-ui-theme/client.js` 实测）

DSH 是一套克制的**蓝灰中性 + DeepSeek 蓝** token 系统，深/浅两套主题（当前 shell-ui.html 已按此落地）。

**核心 token（功能区用）**：

| 角色 | 浅色 | 暗色 |
|---|---|---|
| 背景 base / layer-1 | `#ffffff` | `#151517` / `#232324` |
| 主文字 label-primary | `#0f1115` | `#f9fafb` |
| 次文字 label-secondary（图标描边用） | `#61666b` | `#cfd3d6` |
| 边框 border-l1 | `#0000000a`（黑 4%） | `#ffffff0f`（白 6%） |
| 品牌主色 deepseek | `#4176e6`（deepseek-500） | `#5686fe`（deepseek-450） |

**功能区配色建议（token 落地）**：
- 工具栏底：`#f9fafb` / 暗 `#151517`
- 图标描边：`#61666b` / 暗 `#cfd3d6`
- hover 底：`#f1f3f5` / 暗 `#232324`
- 选中态：DeepSeek 蓝 `#4176e6` / 暗 `#5686fe`
- 分隔线（功能区↔内容）：DSH 原生 `#0000000a` 浅色过淡，建议加一档 `#00000014`~`#1a`

**完整静态色板（`--dsw-static-*`）**（备用，写插件/改顶栏可查）：
- 中性蓝灰 neutral-bluish：`00 #fff` `50 #f9fafb` `60 #f5f6f7` `75 #f1f3f5` `100 #ebeef2` `150 #e9ecf2` `200 #e1e5ee` `300 #cfd3d6` `400 #adb2b8` `500 #979da6` `600 #81858c` `700 #61666b` `750 #43454a` `800 #353638` `850 #2c2c2e` `875 #232324` `900 #1b1b1c` `950 #151517` `1000 #0f1115`
- DeepSeek 蓝：`50 #edf3fe` `100 #e4edfd` `200 #d3e2ff` `300 #b7c8fe` `400 #679efe` `450 #5686fe` `500 #4176e6` `600 #4868b2` `800 #34415b` `900 #283142`
- 辅助蓝 blue：`50 #eff6ff` `75 #e5f0ff` `100 #dbeafe` `300 #93c5fd` `400 #60a5fa` `450 #4d93f8` `500 #3b82f6` `600 #2563eb` `800 #1e40af` `900 #0e3074` `950 #172554`

## 15. 功能区的终极定位 —— DSH 外接状态条（Agent 时代的 Touch Bar）（方向已定；实现见 DESIGN-surface.md）

> 本节是早期方向性讨论。实际落地走了更彻底的「Surface 管道」（Fact→Item→Hub→任意显示目标），详见 `DESIGN-surface.md`；同一批 Item 同时渲染到工具栏气泡带和 macOS Touch Bar（Phase 1a/b/c + Phase 3 均已完成）。

**核心定位**：壳 = DSH 的**外接状态条 / 监听器（Listener/Display）**。模式是「**DSH 出内容，壳出管道和画布**」——不是壳定义控件让应用填，而是壳只给一块画布 + 一根管道，DSH 插件想往上发什么消息、展示什么，完全自己说了算。

**主从反转**：
- ❌ 旧设想：壳定义按钮/进度/标签等控件，应用往里填
- ✅ 新定位：壳提供「固定区 + 动态区」，动态区是应用自己的画布，DSH 自己决定内容

**技术形态构想**：
- 功能区 = 固定区（应用切换 / 拖拽 / 窗口控制，壳管）+ 动态区（活跃应用贡献内容）
- 动态区最干净的做法：**DSH 自己 serve 一个面板页**（如 `http://127.0.0.1:3080/touchbar`），壳把它嵌进功能区；面板页与 DSH 主页面同源、天然共享 session，DSH 想画啥画啥
- `emit` 管道退化成「开关面板 / 调尺寸 / 透传消息」；busy 都可以是 DSH 面板里自己画的小动画，壳不必懂 busy

**为什么这个形态在 Agent 时代成立（Touch Bar 当年不成立的根因）**：
- Touch Bar（2016）生错了年代：当时软件是「同步、单任务、前台」，状态就在眼前，常驻动态条是伪需求
- Agent 时代三前提全变：① 同步 → 异步（任务跑半小时，需别处常驻显示进度）② 单任务 → 并行（多 agent 同时跑，需一条总览看谁在忙）③ 可见 → 后台不可见（切走就“消失”，需永远在视野边上的“它还在跑”信号）

**定位一句话**：把 Touch Bar 这个生错年代的概念，搬回它本该出生的 Agent 时代——不是“教苹果做 Touch Bar”，是概念等到了真问题。

## 16. busy 信号三通道框架 + pi-web 接入方案（已实现：http/bridge/emit 三通道；process 未做）

> 落地结果：http → `lib/surface/adapters/http-poll.js` + `examples/dsh-plus-piweb/recipe.json`；bridge → `dsh-plus-surface` 插件写事实 + `dsh-sessions.js`；emit → `lib/app-preload.js` 暴露的 `window.__shell.emit(items)`（快照语义，**注意与本节下方旧的 `emit(type,payload)` 草案不同**）。process 通道未做。

**`app.busySignal` 抽象**：每个应用声明自己的 busy 信号来源，壳侧图标动画统一、只认一个布尔值。「**http**」通道是唯一**位置无关**的（相对路径跟着应用 URL 走），本地远程一体。

| 通道 | 方向 | 适用 |
|---|---|---|
| `http` | 壳轮询应用自带的 REST 接口 | pi-web（`/api/sessions` → `runningSessionIds`） |
| `bridge` | 应用主动推（emit） | DSH（有插件系统，最省） |
| `process` | 监控 CLI 输出流 | 纯 CLI（后做） |

**pi-web 方案（已实测验证）**：
- 接入：`http://127.0.0.1:30141`（Next.js 全栈 React，pi coding agent 的 web UI），点 `+` 加即可，自带 512px favicon
- busy：轮询 `GET /api/sessions`，看 `runningSessionIds`——**空=空闲、非空=执行中**（已验证：当前会话就在其中，信号实时准确）
- 安全：本地 `/api/sessions` 无鉴权即返回全部会话；远程部署需注意（会暴露所有对话，且需 `start:lan` 监听 0.0.0.0）

**DSH 的 busy 为什么走 bridge**：
- DSH 无轻量 REST 状态接口（`/api/sessions`、`/api/status` 等均 404；核心通信是 ACP WebSocket 实时协议）
- 三条可选：解析 ACP 协议（深耦合）/ DOM 探测（脆弱）/ **bridge 插件（有插件系统，最省）**
- 远程 DSH：自动定位、自动拉起/托管均失效（本机专属）；busy 靠远程装 bridge 插件，否则只剩 DOM 探测

**bridge 协议（极简开放管道）**：
```
window.__shell.emit(type, payload)   // 应用 → 壳
window.__shell.on(type, cb)          // 应用 ← 壳（可选）
```
busy 只是 `emit('state', { busy:true })` 的一种；DSH 想传什么 message 就传什么，壳不认就忽略，双方不绑死。

**落地优先序（不急，后续实现）**：先把「固定区 + 动态区 + emit 管道 + http 探测（pi-web）」骨架搭好；DSH 的 bridge 插件 + touchbar 面板页后续再做。

## 17. 一句话交接

**改壳 = 改 `main.js` +（需要时）`lib/` 三件套；dsh 本体在 `~/.dsh` 官方更新，永远不用碰；
`npm start` 即用：自动定位 DSH、退出即清理自己托管的 dsh、绝不误杀外部实例；功能区内可随时 `+` 加任意本地应用。**

## 18. DSH 版本 / 更新 / 安装管理（已实现）

**背景**：DSH 经 npm 全局包 `@deepseek-ai/dsh` 安装（`dsh` CLI 暴露 `--version`）。本壳把「检查更新 / 重启 / 安装版本」收进右键 DSH 图标的管理菜单里，免碰终端。

**实现**：`lib/dsh-manage.js`（纯 Node，无 electron 依赖，可独立测试），封装：
- `getInstalledVersion()` → `{installed, version}`（`spawn dsh --version`，命令不存在=未安装）
- `getLatestVersion()` / `listVersions()` → 共用 `npm view @deepseek-ai/dsh time --json`（`getVersionTimes()`）：前者取发布时间最新者，后者按发布时间降序（不看 dist-tag：预发布只挂非 latest tag 时查 latest 会漏检）
- `installVersion(v, onProgress)` → `npm install -g @deepseek-ai/dsh@v --no-audit --no-fund`（长任务 Promise）
- `isValidVersion(v)` → 只放行 semver / `latest`，防命令注入

**入口（右键 DSH 图标 → `showDshMenu()`，主进程原生菜单）**：
- 标题项：`DSH v当前版本`（或「DSH — 未安装」，disabled）
- 「检查更新…」 → `checkForUpdate()`：对比本机版本与 npm latest，用 `dialog.showMessageBox` 反馈；有更新可直接「升级到 latest」
- 「重启 DSH」 → `doRestartDsh()` → `restartDshService()`，结果用对话框反馈
- 「安装 / 更换版本…」 → `win.webContents.send('dsh:open-install-panel')`，UI 弹出一个极简面板（版本下拉 + 安装按钮）

**关键点**：
- npm/dsh 命令跨平台：Windows 用 `npm.cmd`/`dsh.cmd` + `shell:true`；mac/Linux 直呼
- 所有网络命令带超时（`npm view` 30s / `dsh --version` 15s），UI 不卡死
- `hasUpdate = current !== latest`（npm `latest` tag 即最新发布，字符串不等即判有更新）
- 「重启 DSH」= `restartDshService()`：显式 DSH_URL（可能是远程）只 reload 不碰本地进程；否则停掉当前连接的实例（无论托管/外部）→ 优先在原端口重新拉起（`waitPortFree` 等旧进程退出）→ `waitForHttpReady` → 更新 `currentUrl` + 重载视图；**端口稳定不漂移**
- 未安装 DSH：启动时 `dialog.showMessageBox` 提醒一次，可一键去安装

**坑**：`npm install -g` 到系统 npm 前缀（如 /usr/local）可能 EACCES 需 sudo；本机 Homebrew 前缀 `/opt/homebrew` 无此问题。安装失败时 stderr 尾行会透传到 UI。