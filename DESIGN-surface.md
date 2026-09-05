# DSH+ 显示面（Surface）架构设计存档

> 存档时间：2026-08-24
> 状态：已决策，全部落地 ✅（Phase 1a · Phase 2 壳侧 · Phase 1b · Phase 1c · Phase 3 Touch Bar · Phase 2b 插件侧 · 工具栏按 appId 画任意 kind · 砍掉 derive）
> 配套：`DEVELOPMENT.md`（实现细节/坑）、`README.md`（用户说明）

---

## 1. 一句话目标

把 DSH+ 顶部工具栏里「鲸鱼旁的红气泡」从**焊死在 DSH 会话语义上的私有 UI**，升级成一套**与来源无关、与显示目标无关的「内容 + 按钮」显示面管道**，让它在不打开语音、不碰应用容器包袱的前提下，未来能原样搬到 macOS Touch Bar、悬浮 HUD、菜单栏等任何显示面上。

范围裁定（明确不做的）：
- **不做语音**。显示面是「显示各种内容 + 可点击按钮」的地方，没有输入麦克风。
- Touch Bar 是另一个显示面，第一阶段只搭架构；Phase 3 已落地（`lib/surface/touchbar.js` 纯逻辑 + `lib/touchbar.js` electron 胶水）。

---

## 2. 当初的耦合（为什么要改）

改造前，「结束会话红气泡」拆散在三处，且每处都写死 DSH 语义：

| 位置 | 当时写死了什么 | 现在 |
|---|---|---|
| `lib/bridge.js` | 派生视图 `{ mode, running, finished:[{id,title,cwd,finishedAt}] }`（`derive()`） | 只摊平事实 `factsArray()`；角标/气泡一律 recipe 投影 |
| `lib/shell-ui.html` | 只把 `appId==='dsh' && kind==='bubble'` 画成红气泡；其它应用最多一个忙碌圆点 | 每个应用一组 `.app-group`：图标上画 badge，旁侧条目带画任意 kind |
| `main.js` | `bridge:tip-show/hide`、`bridge:jump` 绑死这条 IPC | 通用 `surface:*` IPC；跳会话是 `open-session` executor |

管道已经通用之后，产品曾仍焊在鲸鱼上——那是最后一道裂缝，现已拆开。

---

## 3. 核心抽象：三张信封 + 三层角色

**DSH 只负责「出内容」，壳只负责「给画布」；泡泡只是画布上的一种渲染。**

### 3.1 三张信封（全部版本化 JSON，可跨进程、可进 IPC、可走 Touch Bar）

**① 事实 Fact（应用 → 壳）**——插件只产领域事实，不知道「泡泡/角标」：

```jsonc
// ~/.dsh/dsh-plus/bridge.json —— 进程级真相 + client 透传标量快照
{
  "protocol": "dsh-plus.fact", "version": 1,
  "domain": "dsh.sessions", "updatedAt": 1700000000000,
  "sessions": { "<sessionId>": { "status":"idle",
    "runningSince":null,"finishedAt":1700000000000,
    "cli": { "title":"…","cwd":"…","completed":false,"pendingInteraction":null } } }
}
```

**② 条目 Item（壳内部标准形状）**——内容 + 按钮，一个形状全包：

```js
// 进行中角标 = 一条 badge
{ id:'dsh:badge:running', appId:'dsh', kind:'badge', semantic:'busy', badge:2, action:null }
// 结束气泡 = 一条 bubble，点击 = 一个动作描述符
{ id:'dsh:fin:abc', appId:'dsh', kind:'bubble', semantic:'done',
  title:'会话标题', subtitle:'/path/cwd',
  action:{ type:'open-session', target:{ sessionId:'abc' } } }
// 未来任意应用的一个可点按钮 = 形态 + action（可点性由 action 有无决定）
{ id:'appX:btn:reload', appId:'appX', kind:'text', glyph:'<svg…>', title:'重新加载',
  action:{ type:'reload' } }
```

Item 字段：`id / appId / channel / kind(badge|bubble|text|card) / semantic(busy|done|info|warn) / glyph / title / subtitle / badge / priority / action`。

> 两个正交轴：**`kind` 只决定形态（长什么样）**，**`action` 有无决定它是不是按钮（可不可点）**——一条 Item 可以是纯显示、纯按钮、或两者兼备（现在的结束气泡就是「显示 text + 可点按钮」）。**动作必须是可序列化描述符，绝不存闭包。**
>
> `glyph` 图标三种形态：命名内置（`whale`/`bubble`）、内联 `<svg>…</svg>`、图片文件（相对 skill 目录的 `png/svg/…` 路径，由 recipe-loader 自动读成 data URI 传输）。

**③ 动作 Action（壳 → 应用）**——点按钮后发回的唯一形状：

```jsonc
{ "protocol":"dsh-plus.action","version":1,"type":"open-session","target":{"sessionId":"abc"} }
```

### 3.2 三层角色（每层智商只被允许停在一层）

```
内容源 Adapter ──→ SurfaceHub ──→ 渲染目标 Surface
（收集事实→推导 Item） （merge+diff+route） （画内容+画按钮）
```

| 层 | 只允许知道 | 不允许知道 |
|---|---|---|
| 事实/插件 | 领域生命周期事实 | 泡泡、角标、Touch Bar、颜色 |
| Adapter | 事实→Item 的推导 | 泡泡长什么样、画在哪 |
| Hub | merge 各源 Item→按 id diff→路由 action | 事实从哪来、Item 长什么样、点在哪个屏 |
| Surface | 怎么把 Item 画成内容/按钮；用 `appId` 当布局锚点钉到对应图标旁 | 领域事实、动作怎么执行（只 `dispatch(id)`） |
| Executor | 某个 `action.type` 在领域里怎么执行 | 其它一切 |

Hub 是纯内存「合并 + diff + 路由」总线，不碰传输、不碰渲染、不碰领域。

---

## 4. Skill 层：插件（机制，稳定）𐄂 唯一 Skill（说明书）+ recipe.json（场景，热更新）

dsh 原生已具备 skill 机制（`packages/skill` + `docs/subsystems/skills.zh.md`），无需自造：

- `SkillProvider` / `ctx.skills`（`registerProvider/list/snapshot/get`）
- 本地 provider 用 **Chokidar 监听 skill 目录**（`<dshHome>/skills` 等），文件一动发 **`skills/change`**
- **`get()` 不缓存正文**，每次现读
- skill = 目录包 `<name>/SKILL.md` 或平铺 `<name>.md`，frontmatter 带 `metadata`，`resourceBase` 挂脚本

**Skill 不是「做气泡的插件」。** 气泡只是第一种场景模板。给人/模型看的只有 `dsh-plus-surface` 这一篇；场景本身是可热替换的 `recipe.json`。

### 4.1 三个稳定性层级

| 层 | 稳不稳 | 放什么 |
|---|---|---|
| 壳（electron） | 最稳 | 画布 + Hub + 渲染，不知道任何领域 |
| 插件（dsh-plus-surface） | 较稳 | 机制：采集事实、动作入口、注册唯一 skill |
| Skill（唯一 `dsh-plus-surface`） | 常更新 | 给人/模型的说明书；场景本身是同一份 `recipe.json`，不是独立 skill |

### 4.2 「收集信息 → 建立连接 → 信息传递」= 模板的四个动词

```
sources  采集：监听哪些事实（host 进程级 agent/created|status；client 快照标量透传）
join     连接：用哪个键把不同来源拼成一张事实表（sessionId）
items    呈现：事实推导成什么内容/按钮（Item）
actions  传递：点按钮发什么动作给应用（open-session…）
```

给人/模型看的**只有** `dsh-plus-surface/SKILL.md`（dsh / 插件 / 壳三件套 + 管道 + 场景示例）。机器跑的是 `recipes/recipe.json`。会话角标+气泡是这份文件里的 items：

```jsonc
// recipes/recipe.json（节选）
{
  "protocol": "dsh-plus.recipe", "version": 1, "domain": "dsh.sessions",
  "join": { "identity": "sessionId" },
  "items": [
    { "id": "dsh:badge:running", "appId": "dsh", "kind": "badge", "semantic": "busy",
      "aggregate": { "count": { "where": { "status": "running", "pendingInteraction": { "nonEmpty": false } } } }, "omitWhenZero": true },
    { "id": "dsh:fin:${sessionId}", "appId": "dsh", "kind": "bubble", "semantic": "done",
      "foreach": { "where": { "completed": true, "pendingInteraction": { "nonEmpty": false } } },
      "title": "${title}", "subtitle": "${cwd}",
      "action": { "type": "open-session", "target": { "sessionId": "${sessionId}" } } },
    { "id": "dsh:pending:${sessionId}", "appId": "dsh", "kind": "bubble", "semantic": "warn",
      "foreach": { "where": { "pendingInteraction": { "nonEmpty": true } } },
      "title": "${title}", "subtitle": "待交互",
      "action": { "type": "open-session", "target": { "sessionId": "${sessionId}" } } }
  ]
}
```

加一类新内容 = 写进同一份 `recipes/recipe.json` 的 `items`（用户覆盖则写 `~/.dsh/dsh-plus/recipe.json`），不要新目录、不要新 `SKILL.md`、不要新插件。HTTP 忙闲灯片段见 `examples/dsh-plus-piweb/`，合并进同一份文件的 `recipes` 数组。

### 4.3 dsh-tabbit 案例结论（已核代码）

`dsh-tabbit` 把 skill 打进 npm 包（`files:["skills/**"]`）+ 自定义 `SkillProvider`（`list()` 写死一个候选，`get()` 每次 `readFile` 现读，rank 600 bundled）。结论：

- **正文热更新**：能（`get()` 不缓存），但改的是 node_modules = 改插件，且无 watcher、无 `skills/change`。
- **目录热更新（新增/删除/换集合）**：**不能**（`list()` 写死）。
- 它自己的更新模型仍然是「让模型重跑 `dsh plugin add` 重装」。

所以：**bundle 模式适合「随插件走的默认 skill」，不适合「可独立更新、可加新模板」的 skill。**

### 4.4 最终落子：bundle 默认 + 目录覆盖/扩展

```
① bundle 唯一 skill  dsh-plus-surface（rank 600；管道 + 三件套 + 场景示例全写在这一篇）
② 随包默认 recipe    dsh-plus/recipes/recipe.json（会话角标+气泡；新内容写进这一份，不新建目录）
③ 用户覆盖           ~/.dsh/dsh-plus/recipe.json（同 id 覆盖 / omit 删除 / 追加 items；与 bridge.json 同目录）
④ 插件只注册         这一个 skill；壳 RecipeLoader 读这两份文件并热更新
```

关键：加一类新内容 = 改同一份 `recipe.json` 的 `items`，不要按场景新建目录。HTTP 等不同事实源：同一份文件用顶层 `recipes` 数组并列（一份无 source = 会话桥，一份带 `source.type=http`）。

> **实现备注**：给人/模型看的 SKILL.md 只在插件 bundle 里。壳 `dsh-plus/recipes/` 只放这一份 `recipe.json`。用户覆盖走 `~/.dsh/dsh-plus/recipe.json`，不要往 `~/.dsh/skills` 丢东西。

---

## 5. 目标目录结构

```
dsh-plus/
├── lib/
│   ├── surface/
│   │   ├── model.js             # Fact/Item/Action 三张信封协议（纯数据，零依赖）
│   │   ├── hub.js               # SurfaceHub：merge + diff + route，不碰领域
│   │   ├── recipes.js           # recipe 求值器（纯函数）：声明式模板 → Item
│   │   ├── recipe-loader.js     # 加载/热更新 recipe（bundled recipes/recipe.json + ~/.dsh/dsh-plus/recipe.json）
│   │   ├── adapters/
│   │   │   ├── dsh-sessions.js  # 接 bridge 事实 + 跑 recipe + 注册 open-session executor
│   │   │   ├── http-poll.js     # ✅ HTTP 源：轮询 JSON 端点 → 事实 → recipe → Item（pi-web busy）
│   │   │   └── emit.js          # ✅ 网页 window.__shell.emit 推 Item（快照，appId 壳侧强制）
│   │   └── touchbar.js          # ✅ Item→TouchBar 按钮描述符（纯逻辑）；electron 胶水在 lib/touchbar.js
│   ├── shell-ui.html            # 工具栏画布：按 appId 分组，badge 上图标、其余 kind 进条目带（未拆成独立文件）
│   ├── tooltip.html             # 悬停卡片（主进程子窗口，喂 title/subtitle/glyph）
│   └── bridge.js                # DshBridge：事实源（插件 bridge.json / 轮询降级）；不派生视图
├── recipes/                     # 壳随包 recipe（机器读）；只有一份 recipe.json，不要放 SKILL.md
│   └── recipe.json              # 默认会话角标+气泡；新条目写进这里
├── examples/
│   └── dsh-plus-piweb/          # HTTP 忙闲灯片段，合并进 recipe.json 的 recipes 数组，不要拷成新目录
├── plugins/
│   └── dsh-plus-surface/        # 事实出口 + 动作入口 + 唯一 Skill（原 dsh-plus-bridge，已改名）
│       ├── index.js             # host 半：采事实 + 只注册 dsh-plus-surface
│       ├── client.js            # browser 半：通用动作执行器 handle(action) + 上报 fact
│       └── skills/              # bundle：仅 dsh-plus-surface/SKILL.md
└── test/
```

---

## 6. 迁移路径（不推倒重来）

1. **Phase 1a ✅：等价重构** —— 三张信封 + Hub + dsh-sessions adapter + 通用 `surface:*` IPC + 工具栏渲染通用 Item。界面与行为与原来完全一致，泡泡不再焊在壳里。
2. **Phase 2 壳侧 ✅：recipe 引擎** —— `recipes.js` 求值器 + `recipe-loader.js` 热更新 + 默认 `recipes/recipe.json`；「增删改按钮/内容」从此改这一份（或覆盖到 `~/.dsh/dsh-plus/recipe.json`）即热生效，不碰代码。**已活体验证**：日志 `[surface] recipe 就绪：1 条 → 丢文件后 集变化：2 条 → 删文件后 集变化：1 条`，每次 1 秒内生效。
3. **Phase 2b ✅：插件侧** —— ① host 半只注册 `dsh-plus-surface`（rank 600）+ `skills/change` 钩子；② client 半 `handle(action)` 泛型动作入口（`open-session` 现可扩展）。场景说明书全部写进这一篇 skill，不按场景拆 SKILL.md。
   > 实战坑：bundle 插件上下文里 `ctx.get('skills')` 拿不到 skill 服务，必须 `export const inject = ['skills']` + `ctx.skills`（同 dsh-tabbit 的硬依赖写法）。
4. **Phase 1b ✅：每应用条目位 + http 源** —— toolbar 给非 DSH 应用加了「忙碌圆点」（busy badge item）；新增 `http-poll.js`：`source.type==='http'` 的 recipe 变成轮询端点，按 URL 绑定对应应用（`examples/dsh-plus-piweb/recipe.json` 合并进同一份 recipe.json 的 `recipes` 数组）。
5. **Phase 1c ✅：emit 管道** —— 应用页 `window.__shell.emit(items)` 直接推（`lib/app-preload.js` 只暴露这一个口；快照语义，appId 按发件 webContents 强制）。至此三种内容源（bridge 事实 / http 轮询 / 网页 emit）全部打通。
6. **Phase 3 ✅：Touch Bar 显示面** —— `lib/surface/touchbar.js`（Item→按钮描述符纯函数）+ `lib/touchbar.js`（electron 胶水）挂到 macOS 窗口。同一批 Item 现在渲染到**两个显示目标**（工具栏条目带 + Touch Bar），「与显示目标无关」闭环。
   > 本地应用启动（补充决策）：`lib/app-launcher.js` 提供 recipe/Item 管道上的两个壳本地能力——① `launch-app` 执行器（`target.path` → `shell.openPath`，Hub 注册的第二个 action.type）；② `glyph: appicon:<路径>` 水合（`app.getFileIcon` → data URI，发送给功能区前由壳完成，NativeImage 不跨 IPC）。本地应用启动器因此**不是**独立图标/面板，而是 DSH 图标右侧条目带上的普通 Item（kind:text + launch-app）。
7. **Phase 4 ✅：工具栏成为通用画布 + 单一投影口径** —— `shell-ui.html` 按 `appId` 给每个应用一组「图标 + 条目带」，`kind` 决定形态、`semantic` 决定颜色、有无 `action` 决定能不能点。`bridge.derive()` 已删除，变化键改为整张 `factsArray()`，标题变化不再被旧投影吞掉。

---

## 7. 不变式底线

> **Fact 哑、Item 通用、Action 可序列化；插件只有「事实出口 + 动作入口」两口；任何新内容、新按钮、新显示面都走这条管道，不许再开私有 bridge 通道。**
> **插件是发动机，Skill 是唯一说明书，recipe.json 是场景配方。发动机基本不动（重装才有），配方随时换、随时热更新。会话气泡只是第一份模板，不是 Skill 的身份。**