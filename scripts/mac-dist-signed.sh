#!/usr/bin/env bash
# 打包 DSH+.app -> /tmp 内用 Apple 开发证书签名（避开 iCloud 桌面 dist 上的 codesign detritus）
# -> 生成已签名 DMG，并安装到 /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"
OUT_APP="$ROOT/dist/mac-arm64/DSH+.app"
STAGE_DIR="/tmp/dsh-plus-signed-$$"
STAGE="$STAGE_DIR/DSH+.app"
DMG_STAGE="$STAGE_DIR/dmg"
DEFAULT_INSTALL="/Applications/DSH+.app"
INSTALL="${DSH_PLUS_INSTALL:-$DEFAULT_INSTALL}"

list_identities() {
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[A-F0-9]*[[:space:]]*"\(.*\)"/\1/p'
}

pick_identity() {
  local ids picked
  ids="$(list_identities)"
  if [[ -z "$ids" ]]; then
    return 1
  fi
  if [[ -n "${DSH_PLUS_SIGN_IDENTITY:-}" ]]; then
    picked="$(echo "$ids" | grep -F "$DSH_PLUS_SIGN_IDENTITY" | head -1 || true)"
    if [[ -n "$picked" ]]; then
      echo "$picked"
      return 0
    fi
    echo "[dsh-plus] 未找到指定的 DSH_PLUS_SIGN_IDENTITY=$DSH_PLUS_SIGN_IDENTITY" >&2
    return 1
  fi
  for needle in "Developer ID Application" "Apple Development" "Mac Developer"; do
    picked="$(echo "$ids" | grep -F "$needle" | head -1 || true)"
    if [[ -n "$picked" ]]; then
      echo "$picked"
      return 0
    fi
  done
  echo "$ids" | head -1
}

bash "$ROOT/scripts/mac-create-signing-cert.sh"

CERT_NAME="$(pick_identity || true)"
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

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$DMG_STAGE"
echo "[dsh-plus] copy to /tmp and codesign ..."
ditto "$OUT_APP" "$STAGE"

xattr -cr "$STAGE" 2>/dev/null || true

codesign --force --deep --sign "$CERT_NAME" \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  "$STAGE"

codesign --verify --deep --strict "$STAGE"
echo "[dsh-plus] codesign:"
codesign -dv "$STAGE" 2>&1 | head -8

VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
DMG_NAME="DSH+-${VERSION}-${ARCH}.dmg"
DMG_TMP="$STAGE_DIR/$DMG_NAME"
DMG_OUT="$ROOT/dist/$DMG_NAME"

echo "[dsh-plus] create DMG $DMG_NAME ..."
ditto "$STAGE" "$DMG_STAGE/DSH+.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create \
  -volname "DSH+" \
  -srcfolder "$DMG_STAGE" \
  -ov -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_TMP" >/dev/null

codesign --force --sign "$CERT_NAME" --timestamp "$DMG_TMP"
codesign --verify --strict "$DMG_TMP"
mkdir -p "$ROOT/dist"
ditto "$DMG_TMP" "$DMG_OUT"
echo "[dsh-plus] dmg: $DMG_OUT"
codesign -dv "$DMG_OUT" 2>&1 | head -6

echo "[dsh-plus] install to $INSTALL (quit DSH+ first)"
osascript -e 'if application "DSH+" is running then tell application "DSH+" to quit' 2>/dev/null || true
sleep 1
ditto "$STAGE" "$INSTALL"

rm -rf "$STAGE_DIR"
echo "[dsh-plus] done. Enable notifications in System Settings > Notifications > DSH+, and in DSH+ whale menu > Notification settings."
echo "[dsh-plus] installed: $INSTALL"
echo "[dsh-plus] dmg: $DMG_OUT"
