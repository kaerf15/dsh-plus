#!/usr/bin/env bash
# 验收家中 Windows（lymhome）连通性
set -euo pipefail
HOST="${1:-lymhome.tail2453a3.ts.net}"
ORIGIN="https://${HOST}"
echo ">> 本机: $(tailscale status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('Self',{}).get('HostName','?'))" 2>/dev/null || echo '?')"
echo ">> 目标 Windows (lymhome): ${ORIGIN}"
code=$(curl -s -o /tmp/dsh-launch.json -w '%{http_code}' --max-time 8 "${ORIGIN}/dsh-plus-surface/launch.json" || echo 000)
echo "launch.json HTTP $code"
[[ "$code" == "200" ]] && head -c 80 /tmp/dsh-launch.json && echo
