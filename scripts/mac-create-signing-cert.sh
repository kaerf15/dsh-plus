#!/usr/bin/env bash
# 解析本机可用的 codesign 身份：优先 DSH_PLUS_SIGN_IDENTITY，其次 Apple Development，最后才自签。
set -euo pipefail

CERT_NAME="${DSH_PLUS_SIGN_IDENTITY:-DSH Plus Dev}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

pick_existing() {
  if [[ -n "${DSH_PLUS_SIGN_IDENTITY:-}" ]]; then
    if security find-identity -v -p codesigning 2>/dev/null | grep -Fq "$DSH_PLUS_SIGN_IDENTITY"; then
      echo "$DSH_PLUS_SIGN_IDENTITY"
      return 0
    fi
    echo "[dsh-plus] 未找到指定的 DSH_PLUS_SIGN_IDENTITY=$DSH_PLUS_SIGN_IDENTITY" >&2
    return 1
  fi
  local id
  id=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[A-F0-9]*[[:space:]]*"\(.*\)"/\1/p' | head -1)
  if [[ -n "$id" ]]; then
    echo "$id"
    return 0
  fi
  return 1
}

if pick_existing >/dev/null 2>&1; then
  echo "[dsh-plus] 使用已有签名身份: $(pick_existing)"
  exit 0
fi

echo "[dsh-plus] 未找到 Apple Development 身份，创建本机自签证书: $CERT_NAME"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:2048 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 825 -nodes \
  -subj "/CN=${CERT_NAME}/O=DSH Plus Local/C=CN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

openssl pkcs12 -export \
  -out "$TMP/cert.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:dshplus \
  -legacy 2>/dev/null || openssl pkcs12 -export \
  -out "$TMP/cert.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:dshplus

security import "$TMP/cert.p12" -k "$KEYCHAIN" -P dshplus \
  -T /usr/bin/codesign -T /usr/bin/security

security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null || \
  echo "[dsh-plus] 提示: 若通知仍无效，请在钥匙串访问信任「$CERT_NAME」的代码签名"

id=$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[A-F0-9]*[[:space:]]*"\(.*\)"/\1/p' | grep -F "$CERT_NAME" | head -1)
if [[ -z "$id" ]]; then
  echo "[dsh-plus] 自签证书导入后仍不可用，请检查钥匙串" >&2
  exit 1
fi
echo "[dsh-plus] 自签身份就绪: $id"
