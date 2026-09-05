---
name: dsh-plus-surface
description: >-
  The only DSH+ surface skill. Change toolbar / Touch Bar items by writing recipe.json.
  Covers dsh, plugin dsh-plus-surface, and the dsh-plus shell. Sessions and HTTP lamps
  are examples in this skill, not separate skills. NEVER create a new plugin, bundle,
  cordis_define, or extra SKILL.md. 改 DSH+ 工具栏：只写 recipe.json。禁止新建插件或拆新 skill。
  默认不改源码；改源码前先给方案、等用户同意。
---

# DSH+ 显示面（唯一 skill）

插件 `dsh-plus-surface`、壳 `dsh-plus`、会话事实桥都已经在跑。本 skill 是给模型看的**唯一说明书**。会话角标/气泡、HTTP 忙闲灯都是这里的**场景示例**，不是独立 skill。

## 禁令

| 用户要的 | 你做 | 你不做 |
|---|---|---|
| 工具栏出现/改/删/固定条目 | 改同一份 `recipe.json` 的 `items` | 新建插件、bundle、`cordis_define`、新目录、新的 `SKILL.md` |
| 新一类内容 | 写进同一份 recipe.json（HTTP 源用顶层 `recipes` 数组并列） | 再注册 skill / 再写画 UI 的插件 / 按场景新建目录 |
| 新 `action.type`（现成没有） | 先问用户；若要做，只改**已有**插件 `client.js` 的 `handle()` | 另起插件名 |
| 加本地应用启动器（DSH 右侧条目带） | 改 recipe.json 加一条：`action.type: "launch-app"` + `glyph: "appicon:<路径>"` | 改插件 / 新建图标面板 / 新建插件 |

不要调用 `dsh-plugin-dev`。不要 `dsh plugin add` 新包。本插件已在 web profile 里。

---

## 改源码的边界（默认不改源码）

**默认只改 `recipe.json`，不碰任何源码。** 需求先看能不能用 recipe 条目满足；`recipe.json` 是场景配置（热更新、可随时改、改了即生效），不算「改源码」。

### 什么算「源码」（改动前必须先给方案，等用户同意）

| 文件 | 说明 |
|---|---|
| `plugins/dsh-plus-surface/index.js` | 插件 host 半（事实采集） |
| `plugins/dsh-plus-surface/client.js` | 插件 client 半（动作入口） |
| 壳 `main.js`、`lib/**`（dsh-plus 目录下） | 壳逻辑 / 渲染 / 执行器 |
| `package.json`、构建/部署脚本 | 打包、依赖、部署 |
| **新增**任何源码文件（如新建 `lib/*.js`） | 等同改源码 |

### 什么不算源码（可自由改）

- `dsh-plus/recipes/recipe.json`（随包默认条目）与 `~/.dsh/dsh-plus/recipe.json`（用户覆盖）
- 本 `SKILL.md`（唯一说明书：更新说明/示例/规范，属文档不属源码）

### 改源码的流程（缺一不可）

1. **先给方案**：改哪个文件、为什么、具体改点；**不要直接执行**。
2. 等用户明确回复「可以 / 执行」再动手。
3. 改插件（`index.js`/`client.js`）→ `~/.dsh/profiles/web` 里 `pnpm install --force`（硬链接本会自动同步，照走一遍重打包 + diff 验证），然后**重启 dsh web**。
4. 改壳（`main.js`/`lib/**`）→ `dsh-plus` 里 `npm run dist` 重新打包，替换 `/Applications/DSH+.app`，然后**重启 DSH+**。

### 红线（即使改源码也不许）

- 不许新建插件 / bundle / `cordis_define` / 新 `SKILL.md` / 按场景新建目录。
- 新 `action.type` 只加进**已有**插件 `client.js` 的 `handle()` 或壳 Hub executor，不另起插件。

---

## 三件套（必须分清）

### 1. dsh（运行时 / 插件宿主）

- 家目录：`$DSH_HOME`，默认 `~/.dsh`
- 本机 web profile：`~/.dsh/profiles/web/package.json`
  - `dependencies["dsh-plus-surface"]` = `file:…/dsh-plus/plugins/dsh-plus-surface`（pnpm store **独立副本**，不是 `link:`）
  - `dsh.profile.bundles` 含 `"dsh-plus-surface"`
- 源码改插件后：在 `~/.dsh/profiles/web` 执行 `pnpm install --force`，再 diff `node_modules/dsh-plus-surface/` 与源码，不留漂移
- 模型能看见本 skill：是因为插件 host 半 `inject: ['skills']`，`registerProvider` 只挂 **这一个** skill（rank 600）。dsh 自带 filesystem provider（rank 400）扫 `~/.dsh/skills/`——**不要往那儿丢 SKILL.md 或 recipe.json**
- 重启 dsh web 后 skill 正文才换（DSH+ 托盘 → 重启 DSH）。`recipe.json` 热更新不需要重启 dsh

### 2. 插件 `dsh-plus-surface`（发动机，基本不动）

源码：`dsh-plus/plugins/dsh-plus-surface/`

| 半 | 文件 | 做什么 |
|---|---|---|
| host | `index.js` | 听 `agent/created|status|disposed` 写进程级真相（status/runningSince/finishedAt）；RPC `/dsh-plus-surface` 收 `sync`（client 透传标量快照） |
| client | `client.js` | 透传每个顶层会话的标量字段；`window.__dshPlus.handle({ type, target })` |

事实文件（壳读这个，不是改 UI）：

```
~/.dsh/dsh-plus/bridge.json
```

形状：`version:1`，`sessions[id] = { status: running|idle, runningSince, finishedAt, cli: { 任意标量字段 } }`。`status/runningSince/finishedAt` 是 host 独写的进程级真相；`cli` 是 client 透传的标量快照（completed / pendingInteraction / title / cwd / updatedAt / …），整体替换、字段消失即清。只记顶层会话（排除 subagent）。无 `connection` 的 CLI 进程不写这份文件。

现成动作两个：`open-session`（`target.sessionId`，client `handle` 调 `sessions.open`）与 `launch-app`（`target.path`，壳 Hub executor 直接 `shell.openPath` 启动本机应用，不经过 client）。壳 Hub 先把应用带到前台再 dispatch。

### 3. 壳 `dsh-plus`（画布 + recipe 求值）

源码：`dsh-plus/`（Electron）。工具栏 `lib/shell-ui.html` 按 `appId` 分组：`badge` 画在图标上，其余 kind 画在旁侧带。同一批 Item 也上 Touch Bar。本地应用启动器也是 Item：recipe.json 里写 `action.type: "launch-app"`（`target.path` 是 .app 路径）+ `glyph: "appicon:<绝对路径>"`（壳用 `app.getFileIcon` 取应用原始图标转 data URI），条目出现在 DSH 图标右侧条目带，点击启动本机应用。

recipe 两级各一份文件（1 秒轮询，同 `id` 后者赢）：

| 级 | 路径 |
|---|---|
| 随包默认 | `dsh-plus/recipes/recipe.json` |
| 用户覆盖/追加 | `~/.dsh/dsh-plus/recipe.json`（`$DSH_HOME/dsh-plus`，与 `bridge.json` 同目录） |

新内容写进这一份的 `items`，不要按场景新建目录。HTTP 等不同事实源：同一份文件用顶层 `recipes` 数组并列。

应用图标列表（与显示条目无关）：`~/Library/Application Support/DSH+/apps.json`。快捷键：同目录 `settings.json`。

三种内容源（不要再开私有 IPC）：

1. **bridge**：本插件写的会话事实 → 无 `source` 的 recipe
2. **http**：recipe 带 `"source": { "type": "http", "url", "intervalMs" }`，壳按 URL 起源绑 `appId`
3. **emit**：应用页 `window.__shell.emit(items)` 整份快照（`[]` 清空）；`appId` 由壳按 webContents 强制

---

## 你该交付什么

默认只改这一份（仓库内改默认条）：

```
dsh-plus/recipes/recipe.json
```

不重打包壳、只覆盖本机：写

```
~/.dsh/dsh-plus/recipe.json
```

同 `id` 覆盖，`"omit": true` 删除，没有的 id 就是新增。不要交新的 `SKILL.md`、不要交新插件、不要新建 `dsh-plus-<场景>/` 目录。

改完约 1 秒出现在工具栏。

---

## 管道（已在跑，不要实现）

```
事实（插件 / HTTP / emit）→ recipe.json → Item → 工具栏 / Touch Bar
```

Item：`id` `appId` `kind`(badge|bubble|text|card) `semantic`(busy|done|info|warn) `glyph` `title` `subtitle` `badge` `priority` `action:{type,target}`。
可点性只看 `action` 有无。`glyph`：`bubble`/`whale`、内联 svg、或该 recipe 目录里的图片文件名。

## 改 / 删 / 固定（都写在 recipe.json 的 items）

**改** — 同一 `id` 再写一条，整份替换。

**删** — `"omit": true`。foreach 展开的 id 必须带原 `foreach`。

**固定** — 不要 `aggregate`/`foreach`，一直挂着。

```jsonc
{ "id": "dsh:badge:running", "omit": true }
{ "id": "dsh:fin:${sessionId}", "omit": true, "foreach": { "where": { "completed": true } } }
{ "id": "dsh:pending:${sessionId}", "omit": true, "foreach": { "where": { "pendingInteraction": { "nonEmpty": true } } } }
{ "id": "dsh:btn:new", "appId": "dsh", "kind": "text", "title": "新对话", "semantic": "info",
  "action": { "type": "open-session", "target": { "sessionId": "new" } } }
```

emit 是整份快照：改就重推，删就从数组拿掉，清空就 `[]`。

---

## 场景示例（写进本 skill，不是新 skill）

### 会话：进行中角标 + 已完成未看气泡 + 待交互气泡

随包：`dsh-plus/recipes/recipe.json`。事实来自 `bridge.json`。三个信号都是纯字段匹配：`status`（host 进程级真相）、`completed`（dsh 运行时算好的「结束且未选中」，选中即清）、`pendingInteraction`（等待用户交互）。看过即消失、点开跳转都不是壳写死的。

```jsonc
{
  "protocol": "dsh-plus.recipe", "version": 1, "domain": "dsh.sessions",
  "join": { "identity": "sessionId" },
  "items": [
    {
      "id": "dsh:badge:running", "appId": "dsh", "kind": "badge", "semantic": "busy",
      "aggregate": { "count": { "where": { "status": "running", "pendingInteraction": { "nonEmpty": false } } } }, "omitWhenZero": true
    },
    {
      "id": "dsh:fin:${sessionId}", "appId": "dsh", "kind": "bubble", "semantic": "done", "glyph": "bubble",
      "foreach": { "where": { "completed": true, "pendingInteraction": { "nonEmpty": false } } },
      "title": "${title}", "subtitle": "${cwd}", "sortBy": "finishedAt", "sortDir": "desc",
      "action": { "type": "open-session", "target": { "sessionId": "${sessionId}" } }
    },
    {
      "id": "dsh:pending:${sessionId}", "appId": "dsh", "kind": "bubble", "semantic": "warn", "glyph": "bubble",
      "foreach": { "where": { "pendingInteraction": { "nonEmpty": true } } },
      "title": "${title}", "subtitle": "待交互", "sortBy": "updatedAt", "sortDir": "desc",
      "action": { "type": "open-session", "target": { "sessionId": "${sessionId}" } }
    }
  ]
}
```

> 语义补充：`completed` 是 dsh 运行时维护的实时布尔（`running→idle` 且未选中 → true；选中或下次运行 → false）。所以点开气泡会同时跳转并消泡，且不依赖壳是否记得你点过。进程重启时插件丢弃 `cli` 快照并把 running 记成一次结束，因此重启后不残留旧气泡（重启即清）。
> 多客户端补充：`completedNotifications` 是每个 client 页面各自内存维护的，host 收 sync 是整体替换、后写覆盖先写。为防止没选中会话的那个 client 把别人刚清的 `false` 盖回 `true`（气泡复活），host 半对 `completed:false` 做粘性清除：任一 client 报过 false，到下一个 running 沿之前，后续迟到的 true 一律丢弃。

### HTTP 忙闲灯

仓库示例：`dsh-plus/examples/dsh-plus-piweb/recipe.json`。**不要拷成新目录**。把这一份作为 `recipes` 数组里的第二项，写进 `dsh-plus/recipes/recipe.json` 或 `~/.dsh/dsh-plus/recipe.json`，改 `source.url`。壳用 URL 起源匹配 `apps.json` 里的应用。

同一份文件里会话 + HTTP 的形状：

```jsonc
{
  "protocol": "dsh-plus.recipe", "version": 1,
  "recipes": [
    { "domain": "dsh.sessions", "items": [ /* 现有会话条 */ ] },
    {
      "domain": "piweb",
      "source": { "type": "http", "url": "http://127.0.0.1:30141/api/sessions", "intervalMs": 3000 },
      "items": [
        { "id": "piweb:busy", "kind": "badge", "semantic": "busy",
          "foreach": { "where": { "runningSessionIds": { "nonEmpty": true } } } }
      ]
    }
  ]
}
```

### 本地应用启动器（固定条目 + launch-app）

不是独立图标/面板，就是 DSH 图标右侧条目带上的一条 Item：

```jsonc
{
  "id": "launch:safari",
  "appId": "dsh",
  "kind": "text",
  "semantic": "info",
  "glyph": "appicon:/Applications/Safari.app",
  "title": "Safari",
  "action": { "type": "launch-app", "target": { "path": "/Applications/Safari.app" } }
}
```

- `glyph: "appicon:<绝对路径>"` → 壳 `app.getFileIcon` 取应用原始图标转 data URI；取不到退化成纯文字。
- 多个应用加多条（`id` 各不同）；删 = `{ "id": "launch:safari", "omit": true }`。

---

## recipe.json 字段

- **aggregate**：整表一条。`omitWhenZero` 时零条不出。
- **foreach**：每条命中事实一条。`${字段}` 从该事实插值。
- **where**：字段等值（`completed: true`）；`{ "nonEmpty": true/false }`（通用谓词，HTTP 常用）。
- 省略 `source` = 用会话桥。HTTP 才写 `source.type=http`。
- 现成动作：`open-session`（`target.sessionId`）、`launch-app`（`target.path`，本地应用启动，配 `glyph: "appicon:<路径>"` 取原始图标）。没有的 type 先问用户，不要借机新建插件。
