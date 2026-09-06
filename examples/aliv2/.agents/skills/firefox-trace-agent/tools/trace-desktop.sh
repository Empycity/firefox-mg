#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${FIREFOX_TRACE_PYTHON:-}"
if [[ -z "$PY" || ! -x "$PY" ]]; then
  if [[ -x /opt/miniconda3/envs/firefox-trace/bin/python ]]; then
    PY=/opt/miniconda3/envs/firefox-trace/bin/python
  else
    PY="$(command -v python3)"
  fi
fi
export FIREFOX_TRACE_ROOT="$ROOT"
cd "$ROOT"
exec "$PY" "$ROOT/tools/trace-desktop.py"
