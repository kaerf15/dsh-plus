#!/bin/bash
# Mac 一键（本机 Tailscale 名可以是 lymmacbook-air / lym2 等）→ 连家中 Windows「lymhome」上的 dsh
set -euo pipefail

# 家中 Windows 固定 MagicDNS（Tailscale 后台把 Win 改名为 lymhome）
# tailnet 内用 HTTP（80），勿用 https——HTTPS/HTTP2 会弄断 dsh 的 WebSocket → 白屏
HOME_WINDOWS_HOST="lymhome.tail2453a3.ts.net"

APPS_FILE="${HOME}/Library/Application Support/DSH+/apps.json"
DSH_APP="/Applications/DSH+.app"

say() { echo "[家中dsh] $*"; }
fail() { say "❌ $*"; osascript -e "display alert \"家中 dsh\" message \"$*\" as critical" 2>/dev/null || true; exit 1; }
ok() { say "✅ $*"; }

if tailscale status &>/dev/null; then
  self=$(tailscale status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('Self',{}).get('HostName',''))" 2>/dev/null || true)
  [[ -n "${self:-}" ]] && say "本机 Tailscale：${self} → 远端 Windows：lymhome"
else
  say "未检测到 tailscale CLI，仍将尝试连接 ${HOME_WINDOWS_HOST}"
fi

ORIGIN="http://${HOME_WINDOWS_HOST}"
say "目标：${ORIGIN}"

code=$(curl -s -o /tmp/dsh-home-launch.json -w '%{http_code}' --max-time 12 \
  "${ORIGIN}/dsh-plus-surface/launch.json" 2>/dev/null || echo "000")
say "launch.json HTTP ${code}"

if [[ "$code" != "200" ]]; then
  fail "连不上家中 dsh。请在 Windows（lymhome）双击「家中Win-一键启动.bat」，并确认两台 Mac 都已登录同一 Tailscale 账号。"
fi

token=$(python3 -c "import json; print(json.load(open('/tmp/dsh-home-launch.json'))['token'])" 2>/dev/null || true)
if [[ -z "${token:-}" ]]; then
  fail "launch.json 无 token，检查家中是否装了 dsh-plus-surface 0.2.3+"
fi

mint_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 \
  "${ORIGIN}/?token=${token}" 2>/dev/null || echo "000")
if [[ "$mint_code" != "303" && "$mint_code" != "200" ]]; then
  say "换证 HTTP ${mint_code}（DSH+ 打开时仍会再试）"
else
  ok "换证正常"
fi

mkdir -p "$(dirname "$APPS_FILE")"
python3 <<PY
import json, os, time
path = os.path.expanduser("${APPS_FILE}")
url = "${ORIGIN}/"
name = "家中 dsh"
apps = []
if os.path.isfile(path):
    with open(path) as f:
        apps = json.load(f)
found = None
for a in apps:
    u = a.get("url") or ""
    if "lymhome" in u.lower() or a.get("name") in ("家中 dsh", "lymhome.tail2453a3.ts.net"):
        found = a
        break
if found:
    found["url"] = url
    found["name"] = name
    found["initial"] = "家"
    say = "更新"
else:
    apps.append({
        "id": f"app-{int(time.time()*1000)}",
        "name": name,
        "url": url,
        "icon": None,
        "initial": "家"
    })
    say = "新增"
# 清掉误配的 http://lymhome（Tailscale Serve 只走 https）
apps = [a for a in apps if not (a.get("url") or "").startswith("https://lymhome")]
with open(path, "w") as f:
    json.dump(apps, f, indent=2)
    f.write("\n")
print(say)
PY

ok "DSH+ 应用已配置 → ${ORIGIN}/"

if [[ -d "$DSH_APP" ]]; then
  open -a "$DSH_APP"
  ok "已启动 DSH+，点工具栏「家中 dsh」"
else
  fail "未找到 DSH+.app，请先安装 DSH+"
fi

osascript -e "display notification \"${ORIGIN}\" with title \"家中 dsh 已就绪\"" 2>/dev/null || true
say "完成。UU 备用：http://127.0.0.1:3090/（仅本机有映射时可用）。"
