# DSH+ 多连接 / 多应用显示面接入计划

> 立档时间：2026-08-25
> 状态：**Phase 1 + Phase 2 均已落地 ✅**（2026-08-25）。待真机验收：远端 dsh 连接、pi-web 分片事实
> 前置阅读：`DESIGN-surface.md`（三信封抽象：Fact → Item → Action）
> 触发场景：① 另一台 Mac 的 dsh web 经端口映射（本地 3081 → 远端 127.0.0.1:3080）加进壳，事实过不来；
> ② pi-web 想获得与 dsh 相同的显示面信息传递，且不改 pi-web 源码。

---

## 1. 一句话目标

把显示面的事实接入从「单例 bridge + 写死 dsh 应用」泛化为「**按连接实例化 + 多传输来源 + 动作按 appId 路由**」，
让远端 dsh、pi-web、未来任意应用都走同一条管道。**不改 recipe 求值器、Hub、渲染面、TouchBar。**

## 2. 现状评估结论（为什么这么改）

### 2.1 壳侧已经是统一架构，只剩两处焊点

三种内容源已在跑（`main.js` 接线处可见）：

| 内容源 | adapter | 现状 |
|---|---|---|
| 事实文件 `bridge.json` → recipe | `lib/surface/adapters/dsh-sessions.js` | 单例 `DshBridge`，`appId:'dsh'` 写死 |
| 任意 HTTP JSON 端点 → recipe | `lib/surface/adapters/http-poll.js` | 已通用（pi-web 忙闲灯、本机内存灯在用），纯 recipe 配置 |
| 页面直推 `window.__shell.emit(items)` | `lib/surface/adapters/emit.js` | 已通用，appId 由壳按 webContents 强制绑定 |

两处焊点：

1. **bridge 单例**：`lib/bridge.js` 的 `DshBridge` 全局只有一个，`setBaseUrl` 只跟本地 DSH 服务探测走；
   事实读取用 `fs.watchFile` + `fs.readFile` 读**本地** `~/.dsh/dsh-plus/bridge.json`。
   → 远端 dsh 的 bridge.json 写在远端磁盘，端口映射只转发 HTTP，本地壳读不到。
2. **动作写死**：`jumpToDshSession` 固定 `appViews.get('dsh')`；dsh-sessions adapter 的 Item `appId:'dsh'` 写死。
   → 新增应用（哪怕也是 dsh web）没有事实源、没有 adapter、点气泡没有跳转目标。

### 2.2 pi-web 侧的关键事实

- pi-web（`@agegr/pi-web`）是编译好的 Next.js 应用，**本体没有页面侧插件机制，不改源码**。
- 但它以 RPC 模式 spawn pi，**pi 插件体系完整可用**（npm 包插件 / `~/.pi/agent/extensions`，
  证据：pi-mcp-adapter 在 pi-web 设置里 Loaded）。RPC 模式下 extension 生命周期事件照发。
- pi extension 可拿到的事实比预期全：
  - running/idle/结束时刻：`agent_start` / `agent_end` / `agent_settled` / `session_start` / `session_shutdown`
  - 待交互（pendingInteraction）：approval / `ctx.ui.select|confirm` 走 `extension_ui_request`，**进程内自知，无需页面透传**
  - 标题 / cwd：session 上下文可取
  - 唯一缺口：`completed`（结束且**未看**）是页面选中态，没有 client 半拿不到 → 用壳侧 `markViewed` 等价语义顶替
- **多进程差异**：pi-web 每会话一个 pi 进程，每个 extension 实例只看得见自己 → 事实必须**分片**，
  不能照搬 dsh 的「单进程独写一份 bridge.json」。

## 3. 目标形状

```
任意应用 ──产事实──→ ① 本地事实文件（同机，现 bridge.json 形状）
                     ② HTTP JSON 端点（远端 / 端口映射也通）──┐
                     ③ 事实分片目录（多进程应用，每会话一片）  │
                     ④ 页面 emit（页面有能力推就推）           │
                                                             ▼
              壳：通用事实 adapter（per-app 实例化）→ recipe → Hub → 显示面
                                                             ▼
              壳 → 动作回传：executeJavaScript → 页面 handle() 约定 / URL 路由
```

架构不变量（不许碰）：recipe 只做纯字段匹配、Hub 只 merge+diff+route、Item 动作必须是可序列化描述符、
appId 由壳绑定（页面不可伪造）。

---

## 4. Phase 1：先做 dsh（壳侧泛化 + 远端连接）

### 4.1 壳侧改动（核心，一次到位）

| 文件 | 改动 |
|---|---|
| `lib/bridge.js` | `DshBridge` 支持 per-app 实例化；事实来源在「本地文件」之外加「**HTTP 拉取**」（fetch 同一形状的 facts JSON，复用摊平/emitIfChanged 逻辑）；降级轮询保留 |
| `main.js` | bridge 从单例改 `Map<appId, DshBridge>`；应用注册表加「这是 dsh 类应用」的标识（如 `kind:'dsh'` 或探测），为其建 bridge 并 `setBaseUrl(app.url)`；`jumpToDshSession` 泛化为按 appId 路由到对应 view |
| `lib/surface/adapters/dsh-sessions.js` | `appId:'dsh'` 参数化，每个 bridge 实例各接一个 adapter（Item id 前缀随之带 appId，防冲突） |

### 4.2 插件改动（`plugins/dsh-plus-surface`，增量，不动两半架构）

- host 半加一个**只读事实出口**：把内存 facts 通过 HTTP 暴露（`ctx.webServer` 加端点，或扩 `/dsh-plus-surface` RPC 通道加 `read` endpoint）。
  → 远端 dsh 经端口映射即可被壳拉到**全保真**事实（含 pendingInteraction、completed 粘性语义）。
- **不做远端/本地选项：双出口（文件 + HTTP）常开、零配置**。插件不知道也不该知道谁在消费
  （分层原则：只产事实）；「本地读文件 / 远端走 HTTP」的选择权在壳——壳天然知道哪个 app 是内置的、
  哪个是用户加的。做选项会引入双机配置漂移，且角色会随使用场景互换（今天远端明天本机），双出口永远是对的。
- 端点安全口径：只读、绑环回（复用 dsh web 的 webServer，不开新端口）；经映射转发时确认映射工具不对公网开放。
- 远端那台 Mac 的 dsh 需安装本插件（全保真模式的前提；不装则壳自动退到降级轮询 `/api/session.list`，仍有基本角标/气泡，3s 延迟、无待交互气泡）。

### 4.3 验收

- 本地 dsh：行为与现状完全一致（回归）。
- 远端 dsh（映射端口加进来的应用）：进行中角标、完成气泡、待交互气泡、点气泡跳回对应远端会话。
- 远端未装插件：降级轮询自动生效，角标/完成气泡可用。

---

## 5. Phase 2：再做 pi-web（pi 插件 + 壳侧租户接入）

### 5.1 pi 插件（新 npm 包，如 `pi-dsh-plus-surface`）

- 形态：npm 包形式的 pi 插件（同 pi-mcp-adapter 的安装方式），全局装一次，TUI / pi-web 都生效。
- 职责：订阅生命周期事件 → 写**事实分片**：

```
~/.pi/dsh-plus/facts/<sessionId>.json
  { "protocol":"dsh-plus.fact", "version":1, "domain":"pi.sessions",
    "pid":…, "heartbeat":1700000000000,          ← 壳据此识别死进程清片
    "session": { "status":"running|idle", "runningSince":…, "finishedAt":…,
                 "title":…, "cwd":…, "pendingInteraction":null } }
```

- 采集逻辑借鉴 `plugins/dsh-plus-surface`（running 沿、结束记 finishedAt、待交互上报），约一两百行。
- 注意 `session_start` 的 `reason:"new"|"resume"|"fork"` 重绑语义：extension 实例随会话重载，事实写入要幂等。

### 5.2 壳侧接入（已实现）

- 事实源：`lib/surface/facts-dir.js`（FactsDirSource，与 DshBridge 同鸭子类型）扫 `~/.pi/dsh-plus/facts/*.json`
  合并；running 且心跳过期（>15s）折算「中断结束」（idle + finishedAt=心跳，completed=false）；
  completed 粘性清除在壳侧（cleared 集，running 沿重新武装）——pi 没有 client 半可回传，语义由壳兜底。
- adapter 复用 `createDshSessionsAdapter`（名字有 dsh 但投影通用）：新增 `domain` 参数认领 recipe 域
  （dsh 系 'dsh.sessions'，pi 系 'pi.sessions'；无 domain 的 recipe 向后兼容、大家都认）。
- bundled `recipes/recipe.json` 转为顶层 recipes 数组，两域并列；pi 域条目 appId 留白，由 adapter adopt 绑定。
- 探测：`probeApp` 三级——dsh 插件出口 → dsh session.list → pi-web 签名（GET /api/sessions 有
  runningSessionIds 数组）。pi-web 命中后再按「是不是本机」二选一事实源：
  - **分片目录源**（`facts-dir.js`）：本机 + 装了 pi 插件。判别靠分片重叠（远端会话列表里有 id 命中本地
    分片文件），不靠地址——端口映射后远端也是环回地址，无从区分。
  - **HTTP 事实出口源**（`facts-dir.js` 传 url，同一套 merge 语义）：远端 + 装了插件 + 出口可达。
    出口是插件伴生 listener（`serve-facts.mjs`，对应 dsh 侧 webServer.register 的只读事实出口——
    pi-web 无挂载点，退而求独立端口）；只镜像分片不加工，折算/allowlist/bootstrap 仍在壳。
    寻址：`app.factsUrl`（独立映射端口）优先，其次同源路径（反代把出口挂进 pi-web 端口时零配置）。
  - **HTTP 轮询源**（`piweb-poll.js`）：出口也缺席的兑底。按 runningSessionIds
    迁移推断 running/idle/completed；历史洪水闸门：从未 running 过的会话不进表。
  - 三种源同鸭子类型，共用 pi.sessions recipe；30s 重探会自动升级（后装插件/出口就绪 poll→dir/http）。
- 动作回传：`open-pi-session` executor → pi-web 深链整页跳（`/?session=<id>`，本机/远端通用——
  远端经映射端口 loadURL 即可）。
- completed「看到即清」：壳观测应用页 URL 的 ?session=<id>（pi-web 选中会话的官方深链）+ 前台态，
  did-navigate-in-page（页内切换）/ switchApp（切回应用）/ 事实更新（正看着时跑完不出气泡）三路
  触发 markViewed；点气泡只是其中一种，无页面插件参与。
- pi 插件：`plugins/pi-dsh-plus-surface/`（npm 包形式，`pi install <路径>` 全局装，TUI / pi-web 同生效）。
  事件口径：agent_start → running；agent_settled → idle + completed=true；session_shutdown 仍在 running
  → 中断 completed=false；session_info_changed → 标题；心跳 5s 一片覆写。
- **验收时注意**：用户 recipe（~/.dsh/dsh-plus/recipe.json）里旧的 piweb 忙闲灯（http 源）与新
  pi:badge:running 会并存出两个角标——验收通过后删掉旧条目即可。

### 5.3 验收

- pi-web 里跑会话：壳上出进行中角标；一轮结束出完成气泡（标题/cwd 正确）；点气泡经深链跳回 pi-web 对应会话。
- pi 进程被强杀：心跳过期后该片折算中断结束（角标消失、不出完成气泡），不残留假角标。
- ~~approval / ui.select 等待时出待交互气泡~~ —— v1 不做（pi 无全局可观测的等待事件，见 §6）。

---

## 6. 明确不做

- 不改 pi-web 源码（无页面插件机制，patch 编译产物的路不走；上游有 `pi-web:session-row-contextmenu`
  这类下游 hook 先例，但不是通用机制）。
- 不给 dsh-plus-surface 插件加新 skill / 新插件目录——Phase 1 的插件改动只是 host 半多一个读出口。
- 不动 recipe 求值器、Hub、渲染面、TouchBar。
- pi 插件不做页面选中态追踪（无 client 半，`completed` 由壳侧页面观测 + cleared 粘性集顶替）；
  不做 pendingInteraction（pi 的确认/询问是各扩展自己的 `ctx.ui` 请求，无全局可观测事件）。

## 7. 风险与注意

- **私有面脆弱点**：dsh 侧的 `ctx.webServer` / RPC 通道、`agent/*` 事件登记在 `plugins/dsh-plus-surface/index.js` 文件头；
  pi 侧的扩展事件语义以 `docs/extensions.md` 为准（`agent_end` ≠ 彻底结束，状态集成用 `agent_settled`）。
- **多写者**：Phase 1 前 bridge.json 仍是单进程独写；Phase 2 的分片目录要避免两个 pi 进程写同一片
  （按 sessionId 命名 + 启动时校验片内 pid 是自己，否则换名/接管）。
- **远端安全**：事实 HTTP 出口只读、绑环回；经映射暴露时确认端口映射工具侧无对外开放。
- **依赖顺序**：Phase 1 的壳侧泛化是 Phase 2 的前置（per-app 事实源 + 动作路由两处都复用）。
- **远端 pi-web 已支持**：分片重叠→dir；否则探事实出口（插件伴生 listener，`app.factsUrl` 映射端口或
  同源反代路径）→ http，全保真（精确结束时刻/中断识别/命名）；出口也缺席才退 HTTP 轮询（零插件）。
  轮询源残留差距：轮询 3s 粒度、结束时刻=观测到迁移的时刻、无中断/完成的区分；远端不可达时保留
  最后一帧事实（与 dsh 降级轮询同策略，不制造假消失，代价是远端宕机时角标可能滞留到下次可达）。
  出口与分片源已抹平这些差距（同一套 merge 逻辑，只是分片换了传输）。
