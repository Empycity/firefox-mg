#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$(command -v python3)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/firefox-trace-launcher-test.XXXXXX")"
TRACE_DIR="$TMP_DIR/trace"

FIREFOX_TRACE_PYTHON="$PYTHON_BIN" \
FIREFOX_BIN=/usr/bin/true \
TRACE_DIR="$TRACE_DIR" \
"$ROOT_DIR/tools/run-trace-firefox.sh" \
  --trace-wait-seconds 0 \
  https://fixture.invalid/

test -f "$TRACE_DIR/manifest.json"
test -f "$TRACE_DIR/trace-control.json"

SECONDS=0
FIREFOX_TRACE_PYTHON="$PYTHON_BIN" \
FIREFOX_BIN=/usr/bin/true \
TRACE_DIR="$TMP_DIR/wait-trace" \
"$ROOT_DIR/tools/run-trace-firefox.sh" \
  --trace-wait-seconds 1 \
  https://fixture.invalid/
test "$SECONDS" -ge 1

if FIREFOX_TRACE_PYTHON="$PYTHON_BIN" FIREFOX_BIN=/usr/bin/true \
  "$ROOT_DIR/tools/run-trace-firefox.sh" --trace-wait-seconds invalid \
  https://fixture.invalid/ >/dev/null 2>&1; then
  echo "launcher accepted an invalid --trace-wait-seconds value" >&2
  exit 1
fi

echo "run-trace-firefox launcher tests: passed"
