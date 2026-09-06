#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SRC="$ROOT/gecko-dev"
RUNTIME="${FIREFOX_TRACE_RUNTIME_ROOT:-/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime}"
LIB="$RUNTIME/Nightly.app/Contents/MacOS"

clang -std=c11 -O2 -DXP_DARWIN \
  -I"$SRC/security/nss/lib/nss" \
  -I"$SRC/security/nss/lib/ssl" \
  -I"$SRC/security/nss/lib/util" \
  -I"$SRC/security/nss/lib/certdb" \
  -I"$SRC/security/nss/lib/cryptohi" \
  -I"$SRC/security/nss/lib/freebl" \
  -I"$SRC/security/nss/lib/freebl/ecl" \
  -I"$SRC/security/nss/lib/pk11wrap" \
  -I"$SRC/obj-aarch64-apple-darwin25.6.0/dist/include/nspr" \
  -I"$SRC/nsprpub/pr/include" \
  -I"$SRC/nsprpub/lib/ds" \
  -L"$LIB" -Wl,-rpath,"$LIB" \
  "$ROOT/examples/aliv2/dynamic_client/nss_transport/nss_tls_probe.c" \
  -lnss3 -o "$ROOT/examples/aliv2/dynamic_client/nss_transport/nss-tls-probe"
