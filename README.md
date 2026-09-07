# DSH+

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 套一个**原生桌面窗口**的多应用壳。它不止是"桌面版"，更把多智能体协作里最容易被忽略的**消息通知**补齐成刚需功能。

![DSH+ 界面](screenshots/dsh-plus.png)

![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-8A2BE2) ![dsh](https://img.shields.io/badge/dsh-any%20version-8A2BE2)

## 它特别在哪

### 1. 不绑定任何 DSH 版本——为所有版本的 Harness 套一个壳

**壳与内容彻底解耦。** DSH 本体和插件在 `~/.dsh` 里照常更新升级，壳内部**不绑死版本号**。所以 **DSH 每发一次新版本，你不用跟着重新打包这个壳**——它天然兼容任意版本，装完即用。

### 2. 消息通知——多智能体协作的刚需

> ⚠️ **消息通知需要装插件**（`dsh-plus-surface` / `pi-dsh-plus-surface`），壳本身**不内置**通知能力。**未装插件时**只降级为轮询角标，**不会有系统通知**。装法见下文「会话状态与显示面」。

装上插件后，**无论 DSH / pi-web 装在本地还是远程电脑**，都能拿到消息通知。远程场景（比如装在另一台机器/服务器上，经 `DSH_URL` 或端口映射连过来）也一样：远端装了插件 → 走事实出口拿全保真的精确状态；远端没装插件 → 自动退化为轮询（仍有基本角标/完成气泡，但无精确中断识别与命名）。

- 会话**完成**、**等待你回应**（待交互/未读）时，壳会推给你系统通知。
- 除了 DSH 会话，**你也可以把其他消息源推到上面**，统一收口。
- 通知图标采用苹果 **Touch Bar** 的设计灵感——功能区就是一条"外接状态条"，把进行中会话数、待交互/未读气泡、Dock 角标、系统通知渲染成直观的状态。

> **需要在系统里开启。** 系统通知默认是**关闭**的，用之前请先开启：左侧工具栏**第一个鲸鱼图标（DSH）上右键** → **「通知设置」**，并在 **macOS 系统设置 → 通知 → DSH+** 里允许通知。只在壳退到后台时才推送，前台不打扰。

![鲸鱼右键菜单：通知设置入口](screenshots/dsh-plus-menu.png)

### 3. 兼容 pi-web，也能加任何网页

不只是 DSH。**当你也在用 [pi-web](https://github.com/agegr/pi-web)**（本地或远程），装上对应插件后同样能收到"消息完成通知"。而且功能区的 `+` 可以添加**任意 `http(s)` 本地服务或网页**——把常用的工具都收进一个桌面窗口里。

## 核心能力

- **免打包免签名运行**：`npm install && npm start` 直接跑，无需签名。
- **自动连接 dsh web**：扫描本机端口命中 dsh 特征，也能 `+` 手动加任意应用（不写死端口）。
- **消息通知**：完成 / 待交互系统通知，仅后台推送（需在系统里开启）。
- **显示面管道**：功能区 **Fact → Item → Hub** 把会话状态渲染成角标与气泡（配 `plugins/dsh-plus-surface`）。
- **托盘守护**：关窗口不退出，鲸鱼图标保留；完全退出时才停止当前端口上的 dsh。
- **原生右键兜底**：补裁剪/复制/粘贴、链接、图片、刷新、开发者工具，并避开页面自有菜单。
- **本地应用启动器**：在 `recipes/recipe.json` 加一条即可出现在条目带，一键启动任意应用。

## 运行

```bash
cd dsh-plus
npm install
npm start          # = electron .
```

**前置**：本机已安装 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（`npm i -g @deepseek-ai/dsh`）。未安装时壳会弹出版本选择面板，一键安装并自动拉起。

### 连接 dsh web（不写死端口）

1. 显式 `DSH_URL` 环境变量（最高优先）
2. 扫描本机监听端口，命中 dsh 特征（见 `lib/detect-dsh.js`）
3. 都没找到且允许自动拉起：自选空闲端口（从 3080 起），`dsh web --port N --no-open` 并等待就绪

**远程场景**：dsh 或 pi-web 装在**另一台电脑/服务器**上时，用 `DSH_URL` 指向它的地址即可（如 `http://192.168.1.20:3080`，或经端口映射/隧道暴露的地址）。远端**装了插件**（`dsh-plus-surface` / `pi-dsh-plus-surface`）→ 走事实出口拿全保真的精确状态（含精确结束时刻、中断识别、命名）；远端**没装插件** → 自动退化为轮询（仍有基本角标/完成气泡）。两种情况下消息通知都能到你这台机器上，只是精确度有差。

| 变量 | 作用 |
|------|------|
| `DSH_URL` | 显式地址，如 `http://127.0.0.1:8080`（本地）或 `http://192.168.1.20:3080`（远程） |
| `DSH_SHELL_NO_SPAWN=1` | 禁止自动拉起 dsh |
| `DSH_SHELL_SIGNATURES` | 覆盖检测特征（逗号分隔，官方改版救场） |
| `DSH_SHELL_NATIVE_MENU=0` | 关闭应用区原生右键菜单兜底 |

dsh **0.1.2+** 浏览器鉴权：壳在能拿到 launch token 时静默换 cookie 再加载页面；换不到则走官方 401，不替换成引导页。

## 会话状态与显示面（推荐装插件）

消息角标/气泡的完整能力需要**两个插件**，分别接 DSH 侧和 pi 侧的事实：

- **`dsh-plus-surface`**（已发布 npm，v0.2.4）——dsh 侧事实桥。把 DSH 进程内的会话事实（进行中/结束/被查看）写成 `~/.dsh/dsh-plus/bridge.json`，并为壳提供页面内会话跳转入口。
- **`pi-dsh-plus-surface`**（已发布 npm，v0.1.2）——pi 侧事实插件。把每个 pi 会话的进行中/结束/命名事实写成**分片文件**（`~/.pi/dsh-plus/facts/<sessionId>.json`），壳读目录合并出角标与气泡。**TUI 与 pi-web 通用**（全局装一次两边都生效）。

**装 dsh 侧插件**（npm 安装）：

```bash
dsh plugin --profile web add dsh-plus-surface
# 部署到 ~/.dsh/profiles/web 后在该目录 pnpm install --force 重打包
```

**装 pi 侧插件**（pi packages，npm 源）：

```bash
pi install npm:pi-dsh-plus-surface
# 或写入 ~/.pi/agent/settings.json 的 "packages": ["npm:pi-dsh-plus-surface@0.1.2"]
```

- **进行中**：DSH 图标左上角绿色角标（进行中会话数）
- **待交互 / 已完成未看**：鲸鱼右侧条目带气泡（红/黄语义色），悬停看标题 + 目录，点击跳对话
- **Dock / 任务栏角标**：待交互 + 已完成未看总数
- **系统通知**（默认关）：仅在壳后退时推送，前台不打扰

插件未装时自动降级为轮询 `session.list`。事实文件：`~/.dsh/dsh-plus/bridge.json`。

### pi-web

添加 `http://127.0.0.1:<pi-web端口>` 为应用；busy 灯走 HTTP 轮询 `/api/sessions`。完整会话气泡需装 `plugins/pi-dsh-plus-surface`。**pi-web 装在远程电脑上也可以**——在功能区 `+` 添加远程地址（如 `http://192.168.1.20:<pi-web端口>`，或经端口映射/隧道暴露的地址），远端装了 `pi-dsh-plus-surface` 插件后，`serve-facts.mjs` 会提供 HTTP 只读事实出口（默认 `DSH_PLUS_FACTS_PORT` 3099），壳拉取后同样能出角标、完成气泡与消息通知。pi-web 的 GitHub 仓库见 [agegr/pi-web](https://github.com/agegr/pi-web)。

## 下载安装包（未签名）

从 [Releases](https://github.com/kaerf15/dsh-plus/releases) 直接下载安装包即可，**无需自己打包**。安装包**当前未签名**（macOS 无 Apple Developer 证书、Windows 无代码签名证书），因此首次运行会被系统拦截，需要手动允许一次：

**macOS（.dmg）**
1. 双击 `DSH+-0.1.8-arm64.dmg`，把 **DSH+** 拖进「应用程序」。
2. 首次打开若弹出 **“无法验证开发者”**，右键 DSH+ → **打开**，再点 **“打开”** 确认。
3. 如果仍被拦截：**系统设置 → 隐私与安全性**，在「安全性」里点 **“仍要打开”**。

**Windows（.exe）**
1. 双击 `DSH+ Setup 0.1.8.exe` 安装。
2. SmartScreen 若弹出 **“Windows 已保护你的电脑”**，点 **“更多信息”** → **“仍要运行”**。
3. 若被杀软拦截，放行一次即可。

> 想彻底去掉这些提示，可自备证书：macOS 用 `npm run dist:signed`（需 Apple Development 证书），Windows 在 electron-builder 里配置签名证书（见 [Code Signing](https://www.electron.build/code-signing)）后重新打包。

### macOS 通知中心：需要签名

> ⚠️ 对 **macOS** 而言，**只有已签名的 .app 才能把气泡/消息推送到「通知中心」**。当前发布的未签名包虽然能显示**前台角标/气泡**（功能区、Dock 角标），但 **`new Notification()` 会被系统静默丢弃**，通知中心里看不到。
>
> **想要 macOS 弹出「通知中心」的消息，需要在已签名的 .app 上运行，并让 macOS 授权通知：**
>
> 1. 用 `npm run dist:signed` 签一个自己的版本（脚本会从本机钥匙串找一个 Apple 开发证书来签名并安装到 `/Applications/DSH+.app`）。
> 2. 在 **系统设置 → 通知 → DSH+** 里允许通知，再在 DSH+ 鲸鱼菜单 → **「通知设置」** 打开开关。
> 3. 首次双击启动若被 Gatekeeper 拦截（Apple 开发证书**未公证**，外部下载必然触发），右键 DSH+ → **打开** 允许即可。
>
> > 📌 说明：`npm run dist:signed` 签名后请先验证签名有效（`codesign --verify --deep --strict /Applications/DSH+.app`）。若安装到 `/Applications` 后校验报 *"resource fork / Finder information detritus"*，是同步盘（如 iCloud/桌面）给 bundle 加了额外扩展属性所致，清掉即可：`xattr -dr com.apple.fileprovider.fpfs#P /Applications/DSH+.app` 和 `xattr -dr com.apple.FinderInfo /Applications/DSH+.app`。
>
> - **Apple 开发证书**：适合本机/开发者设备，签完通知中心可用，但**未公证**，给任何人下载双击会被 Gatekeeper 拦（需右键打开）。
> - 若要给**外部用户**任意下载且开箱即用，需换 **Developer ID Application** 证书签名并做 **Apple 公证**（notarization）。

## 源码打包（可选）

你自己改源码后想重新打包：

```bash
npm run dist              # electron-builder --dir → dist/mac-arm64/DSH+.app 或 dist/win-unpacked/
npm run dist:signed       # macOS：签名并安装到 /Applications/DSH+.app（需 Apple Development 证书）
```

自用开发直接 `npm start` 即可，不必打包。

## 目录结构

```
dsh-plus/
├── main.js                 # 主进程：窗口、托盘、应用容器、显示面 Hub、通知
├── lib/
│   ├── dsh-service.js      # dsh web 生命周期（解析/拉起/停止/重启）
│   ├── detect-dsh.js       # 端口自动检测
│   ├── dsh-manage.js       # DSH 安装/版本管理
│   ├── dsh-auth.js         # 0.1.2+ launch token → cookie
│   ├── bridge.js           # dsh 事实源（读 bridge.json / HTTP 降级）
│   ├── notifications.js    # 系统通知中心
│   ├── surface/            # 显示面管道（model / hub / adapters / attention）
│   ├── shell-ui.html       # 功能区 UI
│   └── shell-preload.js
├── plugins/
│   ├── dsh-plus-surface/   # dsh 侧：事实出口 + 动作入口
│   └── pi-dsh-plus-surface/# pi 侧：分片事实写 ~/.pi/dsh-plus/facts/
├── recipes/recipe.json     # 默认显示面投影规则
├── scripts/                # mac 签名打包、Tailscale 等
└── test/                   # node --test test/*.test.mjs
```

## License

[MIT](LICENSE) © [kaerf15](https://github.com/kaerf15)
