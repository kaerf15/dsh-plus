# 家中 dsh 远程访问 · 操作文档

通过 **Tailscale** 在 Mac 上用 **DSH+** 访问家中 Windows 上的 dsh web。  
**UU 端口映射（3090）** 可保留作备用，与 Tailscale 并行，互不影响。

| 项目 | 说明 |
|------|------|
| dsh 版本 | `0.1.2-alpha.1` |
| 家中 Windows Tailscale 名 | **lymhome** |
| 访问地址（主） | `https://lymhome.tail2453a3.ts.net/` |
| 访问地址（备） | `http://127.0.0.1:3090/`（仅配置了 UU 映射的 Mac） |
| 鉴权 | dsh 0.1.2 浏览器 cookie；DSH+ 经 `dsh-plus-surface` 的 `launch.json` 自动换证 |

脚本位置：`dsh-plus/scripts/`（桌面包 `~/Desktop/家中dsh-一键包/` 为分发副本）。

---

## 一、架构

```
Mac（DSH+）                    家中 Windows（lymhome）
    │                                │
    │  HTTPS（Tailscale Serve）       │
    └──────── tailnet ──────────────►│  tailscale serve
                                     │       ↓
                                     │  127.0.0.1:3080  dsh web
```

- dsh **只监听** `127.0.0.1:3080`，不绑 `0.0.0.0`。
- Windows 上 `tailscale serve` 把 tailnet 的 HTTPS 转到本机 3080。
- `dsh web` 必须带 `--trusted-host lymhome.tail2453a3.ts.net`，否则浏览器访问会 **403**。
- 插件 **dsh-plus-surface 0.2.3+** 提供 `launch.json`，DSH+ 自动取 token 换 cookie（约 30 天有效）。

---

## 二、设备与命名

在 [Tailscale 管理后台 → Machines](https://login.tailscale.com/admin/machines) 确认：

| 设备 | Tailscale 名 | 角色 |
|------|----------------|------|
| 家中 Windows | **lymhome** | 跑 dsh + Serve |
| Mac 主力 | 如 `lymmacbook-air` | DSH+ 客户端 |
| Mac 副机 | **lym2** | DSH+ 客户端（只改名，不跑 dsh） |

**注意：** `lym2` 是副机在 tailnet 里的名字，**不是** dsh 地址。所有 Mac 都连 `https://lymhome.tail2453a3.ts.net/`。

三台设备须登录 **同一 Tailscale 账号**。

---

## 三、家中 Windows（一次性 + 日常）

### 3.1 前置

1. 安装 **Tailscale for Windows**，登录。
2. 机器名确认为 **lymhome**。
3. 安装 **dsh 0.1.2-alpha.1**。
4. 安装 web profile 插件（与 Mac 本机一致），**必须含 dsh-plus-surface 0.2.3+**。

### 3.2 一键启动

`dsh-plus/scripts/home-win-tailscale-serve.ps1` + 两个 `.bat`（见桌面包 `Windows/`）。

**双击 `家中Win-一键启动.bat`**：Serve + 重启 dsh（含 `--trusted-host`）。  
**双击 `家中Win-重启dsh.bat`**：仅重启 dsh。

### 3.3 开机自启

```powershell
tailscale serve --bg http://127.0.0.1:3080
dsh web --no-open --trusted-host lymhome.tail2453a3.ts.net
```

---

## 四、Mac 使用 DSH+

双击 `mac-connect-home-dsh.command`（桌面包：`连接家中dsh.command`）。

DSH+ 应用 URL：`https://lymhome.tail2453a3.ts.net/`；UU 备用 `http://127.0.0.1:3090/` 可保留。

---

## 五、Tailscale SSH（可选）

1. [Admin](https://login.tailscale.com/admin) 开启 **Tailscale SSH** + 配置 ACL  
2. Windows：`OpenSSH.Server` + `sshd` 自启  
3. Mac：`tailscale ssh 用户名@lymhome`

详见桌面包 `操作文档.md` 第六节全文。

---

## 六、故障对照

| 现象 | 处理 |
|------|------|
| 超时 / 000 | Win 跑一键启动 bat |
| 403 | 重启 dsh 并带 `--trusted-host` |
| 401 | DSH+ 关标签再开 / 再跑 `.command` |
| launch.json 404 | 装 dsh-plus-surface |

---

*2026-08-29 · 完整版见 `~/Desktop/家中dsh-一键包/操作文档.md`*
