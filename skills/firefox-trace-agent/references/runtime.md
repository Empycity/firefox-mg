# Runtime And Tool Usage

## Desktop UI

```bash
tools/trace-desktop.sh
```

or double-click:

```text
Firefox Trace Console.app
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

## Mandatory Agent watchdog

Whenever the Agent launches or resumes collection, start this in the same turn:

```bash
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
TRACE_WATCHDOG_PID=$!
```

The watchdog incrementally reads Fetch/XHR/Cookie JSONL files. As soon as a
configured query/body/header/cookie field and any referenced artifact are on
disk, it runs `trace-control.sh stop target-found`, waits briefly for an ACK,
and runs `trace_finalize.py`. It performs the same stop/finalize sequence at
120 seconds or 2 GiB. Keep its PID, inspect the receipt, and stop collection
immediately if the process exits without one.

When the same configured field occurs on several endpoints, add
`--url-contains '/exact/endpoint/'`. The target receipt then requires both the
field and that URL substring, so an earlier unrelated request does not stop the
run.

## Analyze/finalize

```bash
python3 tools/trace_finalize.py "$TRACE_DIR" --json
python3 tools/trace_analyzer.py "$TRACE_DIR" --preset generic --json
python3 tools/trace_store.py import "$TRACE_DIR" --db /tmp/firefox-trace.sqlite
python3 tools/trace_opcode_analyzer.py "$TRACE_DIR" --width 64 --top-windows 3
python3 tools/trace_vm_window.py "$TRACE_DIR"
```
