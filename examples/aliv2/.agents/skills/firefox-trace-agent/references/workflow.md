# Agent Workflow

Use `trace-mode-playbook.md` whenever choosing a rerun mode, recording a
browser-visible environment value, or writing `agent-next.json`. The tables
below describe the evidence workflow; the playbook owns the exact UI and VM
parameter combinations.

## Phase -1: Bound every Agent-started trace

Start `tools/trace-stop-on-target.py` in the same turn as any Agent launch or
resume. For Agent-driven actions, the configured target becoming durable is
the stop condition. For user-driven actions, configure a nonmatching sentinel,
keep only the time/size fuses automatic, and stop immediately when the user
explicitly says stop. Never use broad `code` or `token` targets without an
exact endpoint filter. A resumed watchdog reads current `trace-control.json`
fields and only the current `segment_id`; it must not stop on an old segment.
The mandatory fuses are 120 seconds and 2 GiB unless the user-driven window has
an explicitly bounded longer duration. If the watchdog is not alive,
immediately stop collection before troubleshooting. Retain its JSON receipt
until acceptance, then remove the Agent-created full trace after the portable
fixture passes independently.

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

## Phase 2: Fixed-byte reproduction and dynamic boundary

Before writing dynamic generators, reconstruct every retained fixed part of one browser vector exactly:

```text
URL path/query bytes
request headers
Cookie header / cookie state
request body bytes
method
content-type / charset / serialization order
```

Compare with the trace at diff level and keep the result as a fixed diagnostic vector. Mark each input as fixed, session-derived or per-request dynamic. Captured time/random values may be injected only to diagnose a historical vector; do not replay them as final runtime state. For the final request, generate time, random, nonce and fresh session-derived values live.

If the complete host contract is retained, an aligned diff is the preferred gate. If it is incomplete or the field is intentionally dynamic, preserve the fixed request vector and test a fresh candidate in the native Firefox page/profile. Verify that the candidate hash survives to the actual sent request, then require the application-level response success condition. See `validation-ladder.md`.

Request vectors are scoped by script identity and endpoint. Never mix `p` from one
JS artifact with `sr/ct/st/cr/og`, query, headers, cookies, or body fields from a
different request. When a related request is absent from the trace, keep it out of
the acceptance claim until a new trace captures its complete vector.

## Phase 3: Producer candidates

Read `index/causal-index.json` first. Then verify in `categorized/js.jsonl`.

Read `producer_match` and `producer_chain` before the full candidate list. If
the request origin points only to a transport wrapper, run
`tools/trace_analyzer.py`; it resolves the request field SHA to the deepest
preceding exact JS return in the same process/segment.

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

If a target-values run matches the script but consumes its JS event budget
before the request, treat it as function discovery. Rerun with script SHA plus
exact function identity; script identity alone is not producer proof.

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

### Locate the first state-machine divergence

For Worker, iframe or multi-request protocols, compare browser and local runs as
ordered state transitions rather than only comparing the final request. At every
response boundary, retain the ordered messages/tasks produced next, including
payload hashes, destination realm and request relation. The first unequal task
list locates the decision boundary in the preceding response handler or host
telemetry calculation.

For Dedicated Worker traffic, read `index/message-timelines.json` before doing
time-window correlation. Require one `message_id` across
`send/clone/enqueue/dispatch`, use `parent_task_id` for listener-triggered sends,
and join the sender's `dom.call` by the same ID. A missing phase is recorded as
an incomplete message, not inferred from nearby payload text.

Do not synthesize the browser's missing next URL, message or request in the local
run. That hides the upstream divergence and cannot satisfy replay acceptance.
Continue by diffing the inputs consumed before the first unequal task, including
nested object values, realm identities, event metadata, stacks and timing/order.

## Phase 6: Present reproduction routes

- If original script can run when APIs/state are supplied: build a supplemented browser-like environment and let the SDK generate dynamic values.
- If algorithm is explicit and inputs are known: present a pure-function route with its required contract and test vectors. Start pure-compute extraction only when the user selects that deliverable.
- If VM/WASM: lock script/module first, then use bounded opcode/WASM evidence only for the unresolved region.

## Phase 7: Repair only the named evidence gap

Choose the next trace mode from the gap, rather than treating multiple runs as mandatory:

| Missing evidence | Next mode | Required identity | Keep off |
|---|---|---|---|
| No target request or script identity | `full-chain`, `active`, JS `boundary` | target query/body/header/cookie field | VM/opcode/WASM instruction |
| Login/preparation before the target action | `full-chain`, `paused`, JS `boundary` | target fields | VM/opcode until target action |
| Target request exists but args/return/object values are absent | `full-chain` object overlay / `target-values`, JS `boundary` | script/function/SHA candidate | global object expansion; VM/opcode |
| Offline host reaches a named unrecorded DOM/BOM API | `full-chain` targeted DOM overlay | exact `Interface.member` from the host exception and current script artifact | `TRACE_DOM_MODE=all`, VM/opcode |
| DOM string return has `value_preview_truncated=true` without a stored artifact | `full-chain` with DOM value store | `TRACE_DOM_VALUE_STORE=1`, current script artifact | substituting the truncated preview in an offline host |
| Local producer subcalls are unresolved | `deep-causal` | stable script/function/SHA candidate | unrelated scripts; VM step unless proven needed |
| Interpreter/VM proof is missing after the producer is known | `opcode-window` | stable script and analyzer PC range | VM step until dispatcher is confirmed |

Write the visible UI selection and all long environment variables to `agent-next.json`. The user loads it and repeats the same short target action once. A new trace replaces an incomplete prior trace for final evidence; it never fills gaps by merging directories.

Prefer the same session and a new segment:

```bash
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
# UI/server normally reads index/target-candidates.json and supplies internal
# script/function filters automatically; explicit flags are expert CLI overrides.
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --query-fields 'FIELD_A,FIELD_B' \
  --body-fields 'FIELD_C' \
  --header-fields 'HEADER_A' \
  --cookie-fields 'COOKIE_A'
tools/trace-control.sh "$TRACE_DIR" start target-values
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
# user repeats target action once
# watchdog stops and finalizes on the first durable target
```

Broaden one filter at a time.

For a targeted DOM overlay, preserve the normal `TRACE_DOM_MODE=signal` and
add only the observed surfaces to the generated config, for example
`TRACE_DOM_INTERFACES=CanvasRenderingContext2D,WebGL2RenderingContext` and
`TRACE_DOM_MEMBERS=Window.getComputedStyle,Permissions.query`. Use the
interface/member identity observed in the current trace or local exception;
do not substitute values. A standard ECMAScript primitive missing from a Node
host is supplied by the local runtime, while browser-visible return values are
read from the replacement trace.

When a result has the right object brand but an incomplete inner value (for
example `ImageData.data`, a typed-array WebGL vector, an extension array, or
`TextMetrics` fields), keep the normal targeted overlay and set
`TRACE_DOM_OBJECT_VALUES=1`. It records bounded, whitelisted scalar fields and
array elements for the returned object; it is not a generic object-depth walk.
Do not replace a recorded collection with `[]`, `{}`, or zero-length data.
Reuse a Firefox value from an earlier trace only when the profile/browser
identity and the value are demonstrably stable; otherwise make the replacement
trace self-contained. Chrome/CDP breakpoints or method wrappers may establish
which browser members are read and in what order, but Firefox trace or Firefox
BiDi remains the source of the final browser-visible values.

Read `index/environment-contract.json` before declaring an offline host
complete. `promise_ledger` pairs each DOM Promise call with its `promise_id`,
initial state, and fulfillment/rejection event. `coverage.async_result_pending`
is the number still unsettled at the stop boundary; `async_result_values_captured`
is the gate for byte-level replay. When it is false, list `async_result_members`
and obtain the observed fulfillment state from the same Firefox profile/current
page when available. The stop action already waits a bounded 250ms drain (the
UI/API `promise_drain_ms` override is clamped to 0-2000ms).

The script loader and JS call logger are separate streams. Finalize joins
`script.resource.raw_sha256` to JS events by exact `url/final_url/original_url`
and marks fallback provenance as `script_hash_source`; use that hash in the next
target configuration only when the candidate also has request/origin evidence.


## Phase 7B: JSVMP/opcode follow-up

When the target looks like JSVMP, keep the normal full-chain modules as context and add VM evidence in segments. Do not merge evidence from discovery and final trace directories: use discovery solely to generate a complete final-trace configuration, then assess whether that final trace needs VM evidence:

1. Confirm target request and script first.
2. Select the automatic JSVMP discovery stage; the server derives `script_contains` from the first-pass request/call evidence. If no candidate exists yet, it records a normal full-chain discovery pass.
3. Review `index/target-candidates.json` and `tools/trace_opcode_analyzer.py` output.
4. Select the next automatic stage. The server applies `TRACE_OPCODE_PC_RANGE=START:END` and enables `TRACE_VM_STEP=1` only when an analyzer-confirmed dispatcher identity is available.

Explain to the user that “fill after analysis” means a previous trace produced the PC value; it is not a value they should guess.

## Agent/user checkpoint messages

At every VMP transition, output one concrete next action instead of exposing raw VM knobs:

1. Target unknown: keep defaults; run `JSVMP round 1`; user fills no script or VM identity fields.
2. Hot PC found: report `START:END`; user selects round 2 and repeats the same action.
3. Dispatcher confirmed: report one PC; user selects round 3 and repeats the same action.
4. Dispatcher unconfirmed: keep opcode window; request no dispatcher PC and no VM step.
5. Fixed bytes aligned: stop widening VM capture and move to dynamic-value/live-response validation.

## Phase 8: Portable evidence closure

Once the final behavior passes, export a self-contained, target-window fixture:

```text
script artifact + identity
request URL/header/body template
minimal environment contract
causally required JS/DOM/state events
all transitively referenced value artifacts
SHA-256 file manifest and source provenance
```

Verify the runner and acceptance gate using only that fixture. Treat missing
collection metadata, object identity records, Promise settlements and referenced
value files as dependency-closure failures. Source paths in the manifest are
provenance, not runtime lookup locations.

If the deliverable is a standalone runner, add one final compilation step:
fold call IDs/time windows into ordered replay records, keep only consumed
fields and transitively referenced values, embed the exact script/environment
contract in a structured code/data module, and remove raw JSONL/value-store
lookups from runtime code. Compare bundle sections by byte size and re-run the
fresh dynamic endpoint gate before deleting the portable build fixture.

## Phase 9: Report

Use `references/report-template.md`. Include exact paths and hashes so another
Agent can verify without redoing the whole analysis.
