# dsh-plus-surface

DSH+ 显示面的 dsh 侧插件：**事实出口 + 动作入口 + 唯一 Skill**。把 dsh 进程内的会话事实写成
`$DSH_HOME/dsh-plus/bridge.json`（事实出口），接收壳发来的可序列化动作（动作入口），
并注册 **一个** bundled skill（rank 600）：`dsh-plus-surface`。会话角标、HTTP 灯等场景
都写在这一篇里；加新内容 = 改同一份 `recipes/recipe.json`（或 `~/.dsh/dsh-plus/recipe.json`），不要再注册 skill、不要新建插件或目录。

## 两半职责

| 半 | 环境 | 职责 |
|---|---|---|
| `index.js`（host） | dsh web host 进程 | 听 `agent/created\|status\|disposed` 维护进程级真相 `{status, runningSince, finishedAt}`，原子写桥文件；同时开 **HTTP 只读事实出口** `GET /dsh-plus-surface/bridge.json`（与桥文件同一份内存事实，供远端壳经端口映射拉取）；提供 `/dsh-plus-surface` RPC 通道，`sync` 端点合并 client 透传的标量快照（仅顶层会话、字段消失即清）；`ctx.skills.registerProvider` 只注册 `dsh-plus-surface`（rank 600）+ `skills/change` 钩子 |
| `client.js`（client） | dsh web 页面 | 把每个顶层会话的可序列化标量字段整体透传给 host（`pendingInteraction` / `title` / `cwd` / …）并上报页面选中态（`selected`，host 据此推导 `completed`）；暴露 `window.__dshPlus.handle(action)` 通用动作入口（`open-session` 现可扩展）+ `jump` 兼容别名 |

判断逻辑（进行中角标、已完成未看 / 待交互气泡、气泡生命周期）全部在壳的 `recipe.json` 里做纯字段匹配；本插件只透传事实、只执行壳发来的动作。CLI 进程不产事实（无 `connection` 服务即不启用事实桥）。

## 双出口：本地文件 + HTTP（远端连接）

事实出口常开两个，零配置、无远端/本地开关——**选择权在壳**：

- **本地壳**：`fs.watchFile` 读 `bridge.json`（1s 感知）
- **远端壳**（另一台机器的 dsh web 经端口映射加进 DSH+）：轮询 `GET /dsh-plus-surface/bridge.json`（1s），与桥文件同形状同语义（含 `pendingInteraction` / `completed` 粘性清除）
- **自动换证**（0.1.2+，可选）：`GET /dsh-plus-surface/launch.json` 只对环回连接返回 `{ token }`。壳若拿到就静默换证；**没装本插件不影响页面接入**——视图按浏览器直接打开地址，换证是壳自己的事。

安全口径：HTTP 出口只读、随 dsh web 的环回绑定，不开新端口；经映射/反代转发时自行确认不对公网开放。
插件缺席时壳自动退到 `/api/session.list` 降级轮询（只有基本角标/完成气泡，无待交互气泡）。

## 桥文件形状

```jsonc
{
  "version": 1,
  "pid": 12345,
  "updatedAt": 1787400000000,
  "sessions": {
    "session-…": {
      "status": "running",           // running | idle（host 独写）
      "runningSince": 1787400000000, // host 独写
      "finishedAt": null,            // 最近一次 running→idle 的时刻（host 独写）
      "completed": false,            // 完成未看（host 依各 client 选中上报推导：
                                     // 结束瞬间无人选中 = 未看；任一 client 选中即清，
                                     // 直到下个 running 沿重新武装）
      "cli": {                        // client 透传的标量快照，整体替换、字段消失即清
        "title": "对话标题",
        "cwd": "/abs/path",
        "pendingInteraction": null,   // approval | plan-review | question
        "updatedAt": 1787400000000
      }
    }
  }
}
```

## 动作入口（handle）

壳点显示面上的按钮 → 发一个可序列化描述符给 client 半：

```js
window.__dshPlus.handle({ type: 'open-session', target: { sessionId: 'session-…' } })
```

现成动作是 `open-session`。新 `action.type` 才改本插件 `client.js` 的 `handle()`（壳管道不动）——**不要另起一个插件**。工具栏条目本身只改 `recipe.json`。

## 安装

```bash
dsh plugin --profile web add <本目录绝对路径>
# 源码改动后按 AGENTS.md 约定：在 ~/.dsh/profiles/web 下 pnpm install --force 重打包
```

重启 dsh web 后生效（DSH+ 托盘菜单 → 重启 DSH 即可）。

注意：`exports` 里必须包含 `"./package.json": "./package.json"`——client 模块系统
用 `require.resolve('<pkg>/package.json')` 读 `dsh.client` 声明，exports 地图会墙化子路径，
缺了这一行 client 半会被静默跳过（host 半照常工作，boot 图里没有本包）。

## 兼容基线

`verifiedWith: 0.1.2-alpha.1`。私有面脆弱点逐条登记在 `index.js` / `client.js` 文件头注释。