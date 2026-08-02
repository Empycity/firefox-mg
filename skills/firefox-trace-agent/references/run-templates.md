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
# repeat target action once
tools/trace-control.sh "$TRACE_DIR" stop after-target
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

## Narrow target-values segment

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --script-contains 'SCRIPT_SUBSTRING' \
  --function-contains 'FUNCTION_SUBSTRING' \
  --query-fields 'FIELD_A' \
  --body-fields 'FIELD_B' \
  --header-fields 'HEADER_A' \
  --cookie-fields 'COOKIE_A'
tools/trace-control.sh "$TRACE_DIR" start target-values
# repeat target action once
tools/trace-control.sh "$TRACE_DIR" stop after-target-values
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

## Bounded opcode window

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment opcode-window
tools/trace-control.sh "$TRACE_DIR" config \
  --preset opcode-window \
  --script-contains 'SCRIPT_SUBSTRING' \
  --set TRACE_OPCODE_SCRIPT_CONTAINS=SCRIPT_SUBSTRING \
  --set TRACE_OPCODE_PC_RANGE=START:END
# First VM pass can leave START:END empty; fill it after trace_opcode_analyzer identifies a hot PC range.
tools/trace-control.sh "$TRACE_DIR" start opcode-window
# short target action once
tools/trace-control.sh "$TRACE_DIR" stop after-opcode
python3 tools/trace_opcode_analyzer.py "$TRACE_DIR" --script-contains 'SCRIPT_SUBSTRING'
```
