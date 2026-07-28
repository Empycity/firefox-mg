#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIREFOX_TRACE_PYTHON="${FIREFOX_TRACE_PYTHON:-/opt/miniconda3/envs/firefox-trace/bin/python}"

if [[ ! -x "$FIREFOX_TRACE_PYTHON" ]]; then
  echo "Firefox Trace python env not found: $FIREFOX_TRACE_PYTHON" >&2
  echo "Create it with: /opt/miniconda3/condabin/conda create -y -n firefox-trace python=3.11" >&2
  exit 2
fi

export FIREFOX_TRACE_PYTHON
exec "$FIREFOX_TRACE_PYTHON" "$ROOT_DIR/tools/trace-console-server.py" "$@"
