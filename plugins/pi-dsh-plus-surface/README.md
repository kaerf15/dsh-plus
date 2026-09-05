# pi-dsh-plus-surface

DSH+ 显示面的 pi 侧事实插件：把每个 pi 会话的进行中/结束/命名事实写成**分片文件**
（`~/.pi/dsh-plus/facts/<sessionId>.json`），DSH+ 壳读目录合并出进行中角标、完成气泡、
点击跳回会话。TUI 与 pi-web（RPC 模式）通用——全局装一次，两边都生效。

## 为什么是分片

pi-web 每个会话一个 pi 进程，每个扩展实例只看得见自己这条会话。一个进程写一片，
壳按目录合并 + 心跳（5s）识别活进程：`running` 且心跳过期（>15s）的片被壳折算成
「中断结束」（记 finishedAt、不出完成气泡），与 dsh 侧「进程重启 = 被打断」同语义。

## 事实形状（与 dsh-plus-surface 的 bridge.json 同信封）

```jsonc
{
  "protocol": "dsh-plus.fact", "version": 1, "domain": "pi.sessions",
  "sessionId": "…", "pid": 12345, "heartbeat": 1787400000000, "updatedAt": 1787400000000,
  "session": {
    "status": "running",        // running | idle
    "runningSince": 1787400000000,
    "finishedAt": null,
    "title": "会话名（未命名取 cwd 末段）",
    "cwd": "/abs/path",
    "completed": false           // 结束即未看；壳点气泡跳转时清，新一轮 running 重新武装
  }
}
```

事件口径：`agent_start` → running；`agent_settled`（不是 `agent_end`，自动重试/压缩不算完）→ idle +
completed=true；老版 pi 无 `agent_settled`（如 @mariozechner 0.73.x），由 `agent_end` 加 3s 宽限兜底（宽限内跟上新
`agent_start` 视为续跑）；`session_shutdown` 时仍在 running → 中断，completed=false。

**不做 pendingInteraction**：pi 的确认/询问是各扩展自己的 `ctx.ui` 请求，没有全局可观测事件。

## 安装

复制到 pi 全局扩展目录（`~/.pi/agent/extensions/*/index.ts` 自动发现，不走 settings 挂路径；
注意 `pi install <本地路径>` 只是向 settings 写路径引用、不复制文件，源码挪动/改名会断链）：

```bash
mkdir -p ~/.pi/agent/extensions/pi-dsh-plus-surface
cp index.ts serve-facts.mjs package.json README.md ~/.pi/agent/extensions/pi-dsh-plus-surface/
# 源码改动后重跑一次复制；运行中的 pi 进程 /reload 或重启后加载新版
```

装完新启动的 pi / pi-web 会话即产事实；DSH+ 壳侧的显示规则在同一份 recipe.json
（bundled `pi.sessions` 域），动作是 `open-pi-session`（壳走 pi-web 深链 `/?session=<id>`）。

## HTTP 事实出口（远端壳用，0.1.2+）

对应 dsh 侧的「双出口常开」（`webServer.register('/dsh-plus-surface/bridge.json')`）：pi-web 没有可挂载的
webServer（编译死 Next.js，扩展开不了同源端点，pi-web 0.8.11 HTTP 面已逐路由核实），出口由伴生 listener
`serve-facts.mjs` 提供——插件在 session_start 时确保拉起（端口被占即静默退场，幂等、零配置），只读镜像
分片目录，**不做任何归并/折算**（语义全在壳的 `FactsDirSource`，与本地 fs 读法一字不差）。

- 路由：`GET /pi-dsh-plus-surface/shards.json` → `{version:1, shards:[{name, body}]}`；只读、绑 `127.0.0.1`，
  端口 `DSH_PLUS_FACTS_PORT` 默认 `3099`
- 手动跑也行：`node serve-facts.mjs`（env `DSH_PLUS_FACTS_DIR` / `DSH_PLUS_FACTS_PORT`）
- 运维注记：出口是 detached 独立进程，插件文件更新后旧进程仍占着端口（新拉起会静默退场）——
  改过 `serve-facts.mjs` 后要手动杀旧进程（`lsof -ti tcp:3099 | xargs kill`）才会跑上新版
- 壳侧寻址（`main.js` probeApp）：分片重叠判本机 → dir；否则探 `app.factsUrl`（独立映射端口，如
  `http://127.0.0.1:3082`）再探同源路径（远端反代把出口挂进 pi-web 端口时零配置）→ 出口就绪即全保真
  （精确结束时刻/中断识别/命名），都缺席才退 `piweb-poll.js` 轮询——与 dsh 侧「出口缺席退轮询」同构
- 安全口径与 dsh 侧一致：只读、绑环回；经映射暴露时确认映射工具侧不对公网开放

## 配套

- 壳侧来源：`lib/surface/facts-dir.js`（本机分片目录合并 + completed 粘性清除；0.1.2 起同一套逻辑
  兼读 HTTP 出口镜像）；出口都缺席时壳自动用 `lib/surface/piweb-poll.js`（按 `/api/sessions` 的
  running 迁移推断，零插件可用）
- 设计文档：`DESIGN-multi-connection.md` Phase 2
