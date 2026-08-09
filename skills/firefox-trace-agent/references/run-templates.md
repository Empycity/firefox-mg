# Run Templates

## One-pass UI-equivalent full chain

```bash
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
TRACE_QUERY_FIELDS='FIELD_A,FIELD_B' \
TRACE_BODY_FIELDS='FIELD_A,FIELD_B' \
TRACE_HEADER_FIELDS='HEADER_A,HEADER_B' \
TRACE_COOKIE_FIELDS='COOKIE_A,COOKIE_B' \
tools/run-trace-firefox.sh \
  --trace-preset full-chain \
  --trace-plan full-chain \
  --trace-start active \
  'TARGET_URL'

# Required in the same Agent turn as launch:
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
TRACE_WATCHDOG_PID=$!
```

## Paused target action

```bash
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
TRACE_QUERY_FIELDS='FIELD_A,FIELD_B' \
TRACE_BODY_FIELDS='FIELD_A,FIELD_B' \
TRACE_HEADER_FIELDS='HEADER_A,HEADER_B' \
TRACE_COOKIE_FIELDS='COOKIE_A,COOKIE_B' \
tools/run-trace-firefox.sh \
  --trace-preset full-chain \
  --trace-plan full-chain \
  --trace-start paused \
  'TARGET_URL'

tools/trace-control.sh "$TRACE_DIR" start target-action
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
TRACE_WATCHDOG_PID=$!
# repeat target action once
# watchdog stops and finalizes immediately when the target is durable
```

## Narrow target-values segment

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
# UI/server normally reads index/target-candidates.json and supplies script
# identity automatically; explicit flags are expert CLI overrides.
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --query-fields 'FIELD_A' \
  --body-fields 'FIELD_B' \
  --header-fields 'HEADER_A' \
  --cookie-fields 'COOKIE_A'
tools/trace-control.sh "$TRACE_DIR" start target-values
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
TRACE_WATCHDOG_PID=$!
# repeat target action once
# watchdog stops and finalizes immediately when the target is durable
```

## Bounded opcode window

Before verbose opcode, prefer a compact VM window:

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment vm-window
tools/trace-control.sh "$TRACE_DIR" config \
  --preset vm-window \
  --query-fields 'FIELD_A'
tools/trace-control.sh "$TRACE_DIR" start vm-window
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
# repeat the target action once; target hit freezes the binary window
python3 tools/trace_vm_window.py "$TRACE_DIR"
```

## Bounded verbose opcode window

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment opcode-window
tools/trace-control.sh "$TRACE_DIR" config \
  --preset opcode-window \
# The UI/server reads index/target-candidates.json and supplies the script
# identity and PC range; users do not type SCRIPT_SUBSTRING or START:END.
tools/trace-control.sh "$TRACE_DIR" start opcode-window
# short target action once
tools/trace-control.sh "$TRACE_DIR" stop after-opcode
python3 tools/trace_opcode_analyzer.py "$TRACE_DIR"
```
