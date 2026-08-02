# Agent Workflow

## Phase 0: Offline review

1. Set `TRACE_DIR`.
2. Run finalizer if needed.
3. Read manifest and summary.
4. Mark trace health:
   - complete: target data present and no relevant degraded event;
   - candidate-only: degraded, incomplete boundary, missing ACK, or missing artifacts.

## Phase 1: Target request

Read `categorized/request-fields.jsonl` and `categorized/network.jsonl`.
Record:

```text
request_id
transport
URL
method
field location: url.query | body | headers | cookies
field name
raw SHA-256
decoded SHA-256
value_store_path
origin_call_id
headers
cookies
request body
response artifact
```

## Phase 2: Fixed-byte reproduction before dynamic values

Before writing dynamic generators, reconstruct one retained browser vector exactly:

```text
URL path/query bytes
request headers
Cookie header / cookie state
request body bytes
method
content-type / charset / serialization order
```

Compare with the trace at diff level. Keep this as a fixed test vector. Only after fixed bytes match should you model dynamic values such as time, random, nonce, server-returned tokens, storage-derived values, or SDK-computed signatures. Final success is a live request to the user-provided URL with response status/content/business condition passing.

## Phase 3: Producer candidates

Read `index/causal-index.json` first. Then verify in `categorized/js.jsonl`.

For each candidate, keep:

```text
call_id
parent_call_id
origin_call_id
function_name
script_url
script_sha256
value_role
value_path
value_store_path
value_sha256
match_type
```

`same_origin_context` is context, not proof by itself.

## Phase 4: Script source

Use script records to read local artifacts:

```text
scripts/
web-assets/js/
source_maps/
```

If source maps are referenced but absent:

```bash
python3 tools/fetch_source_maps.py "$TRACE_DIR"
```

## Phase 5: Dependency ledger

Classify each material input:

| Class | Meaning |
|---|---|
| pure | Business input or deterministic value passed explicitly. |
| environment | Browser-visible APIs: navigator/screen/document/canvas/performance/crypto/etc. |
| state | Cookie/storage/IndexedDB/response-derived persistent or session value. |
| mixed | Assembled from two or more classes. |

For each item, include source event, propagation calls, producer relation, and evidence level.

## Phase 6: Decide reproduction route

- If original script can run when APIs/state are supplied: build a supplemented browser-like environment and let the SDK generate dynamic values.
- If algorithm is explicit and inputs are known: extract a pure function with test vectors.
- If VM/WASM: lock script/module first, then use bounded opcode/WASM evidence only for the unresolved region.

## Phase 7: Repair missing evidence

Prefer the same session and a new segment:

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --script-contains 'SCRIPT_SUBSTRING' \
  --function-contains 'FUNCTION_SUBSTRING' \
  --query-fields 'FIELD_A,FIELD_B' \
  --body-fields 'FIELD_C' \
  --header-fields 'HEADER_A' \
  --cookie-fields 'COOKIE_A'
tools/trace-control.sh "$TRACE_DIR" start target-values
# user repeats target action once
tools/trace-control.sh "$TRACE_DIR" stop after-target-values
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

Broaden one filter at a time.


## Phase 7B: JSVMP/opcode follow-up

When the target looks like JSVMP, keep the normal full-chain modules as context and add VM evidence in segments:

1. Confirm target request and script first.
2. Run an opcode segment with `JS opcode` enabled and `script_contains` set; leave PC range and dispatcher PC empty on this pass.
3. Analyze with `tools/trace_opcode_analyzer.py`.
4. Run a narrower segment with `TRACE_OPCODE_PC_RANGE=START:END` or enable `TRACE_VM_STEP=1` only after `TRACE_VM_DISPATCH_PC` is known.

Explain to the user that “fill after analysis” means a previous trace produced the PC value; it is not a value they should guess.

## Phase 8: Report

Use `references/report-template.md`. Include exact paths and hashes so another Agent can verify without redoing the whole analysis.


## Agent/user checkpoint messages

At every VMP transition, output one concrete next action instead of exposing raw VM knobs:

1. Target unknown: keep defaults; run `JSVMP round 1`, fill only the script substring.
2. Hot PC found: report `START:END`; user runs round 2 with that range.
3. Dispatcher confirmed: report one PC; user runs round 3 with VM step.
4. Dispatcher unconfirmed: keep opcode window; request no dispatcher PC and no VM step.
5. Fixed bytes aligned: stop widening VM capture and move to dynamic-value/live-response validation.
