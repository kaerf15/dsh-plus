#!/usr/bin/env bash
# 打包 DSH+.app -> /tmp 内签名（避开 iCloud 桌面 dist 上的 codesign detritus）-> 安装到 /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"
OUT_APP="$ROOT/dist/mac-arm64/DSH+.app"
STAGE="/tmp/dsh-plus-signed-$$/DSH+.app"
DEFAULT_INSTALL="/Applications/DSH+.app"
INSTALL="${DSH_PLUS_INSTALL:-$DEFAULT_INSTALL}"

bash "$ROOT/scripts/mac-create-signing-cert.sh"

CERT_NAME=$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[A-F0-9]*[[:space:]]*"\(.*\)"/\1/p' \
  | { if [[ -n "${DSH_PLUS_SIGN_IDENTITY:-}" ]]; then grep -F "$DSH_PLUS_SIGN_IDENTITY"; else cat; fi; } \
  | head -1)

if [[ -z "$CERT_NAME" ]]; then
  echo "[dsh-plus] no codesign identity" >&2
  exit 1
fi
echo "[dsh-plus] signing identity: $CERT_NAME"

echo "[dsh-plus] electron-builder --dir ..."
(cd "$ROOT" && npm run dist)

if [[ ! -d "$OUT_APP" ]]; then
  echo "[dsh-plus] missing $OUT_APP" >&2
  exit 1
fi

rm -rf "$(dirname "$STAGE")"
mkdir -p "$(dirname "$STAGE")"
echo "[dsh-plus] copy to /tmp and codesign ..."
ditto "$OUT_APP" "$STAGE"

xattr -cr "$STAGE" 2>/dev/null || true

codesign --force --deep --sign "$CERT_NAME" \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  "$STAGE"

codesign --verify --deep --strict "$STAGE"
echo "[dsh-plus] codesign:"
codesign -dv "$STAGE" 2>&1 | head -6

echo "[dsh-plus] install to $INSTALL (quit DSH+ first)"
osascript -e 'if application "DSH+" is running then tell application "DSH+" to quit' 2>/dev/null || true
sleep 1
ditto "$STAGE" "$INSTALL"

rm -rf "$(dirname "$STAGE")"
echo "[dsh-plus] done. Enable notifications in System Settings > Notifications > DSH+, and in DSH+ whale menu > Notification settings."
echo "[dsh-plus] installed: $INSTALL"
