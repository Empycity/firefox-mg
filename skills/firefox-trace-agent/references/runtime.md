# Runtime And Tool Usage

## Desktop UI

```bash
tools/trace-desktop.sh
```

or double-click:

```text
Firefox Trace Console.app
```

## Web UI / HTTP API

```bash
tools/trace-console.sh --host 127.0.0.1 --port 8788
```

## Runtime paths

Recommended environment:

```bash
export FIREFOX_TRACE_RUNTIME_ROOT=/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON=/opt/miniconda3/envs/firefox-trace/bin/python
```

If this skill is installed outside the main repository, also set:

```bash
export FIREFOX_TRACE_REPO=/absolute/path/to/firefoxTrace
```

## CLI launch

```bash
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
TRACE_QUERY_FIELDS='sign,signature,token' \
TRACE_BODY_FIELDS='sign,signature,token' \
tools/run-trace-firefox.sh \
  --trace-preset full-chain \
  --trace-plan full-chain \
  --trace-start active \
  'https://example.com/'
```

## Runtime control

```bash
tools/trace-control.sh "$TRACE_DIR" status
tools/trace-control.sh "$TRACE_DIR" start target-action
tools/trace-control.sh "$TRACE_DIR" stop after-target
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
```

## Analyze/finalize

```bash
python3 tools/trace_finalize.py "$TRACE_DIR" --json
python3 tools/trace_analyzer.py "$TRACE_DIR" --preset generic --json
python3 tools/trace_store.py import "$TRACE_DIR" --db /tmp/firefox-trace.sqlite
python3 tools/trace_opcode_analyzer.py "$TRACE_DIR" --width 64 --top-windows 3
```
