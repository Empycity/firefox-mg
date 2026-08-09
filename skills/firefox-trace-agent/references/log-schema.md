# Log Schema And Output Directory

A run produces one `TRACE_DIR`.

```text
TRACE_DIR/
  manifest.json
  trace-control.json
  firefox-*.jsonl
  values/
  scripts/
  source_maps/
  web-assets/
  categorized/
  index/
```

## High-value files

| File | Use |
|---|---|
| `manifest.json` | Configuration: URL, preset/plan, startup mode, Firefox binary, profile, fields, modules, env. |
| `trace-control.json` | Runtime enabled/mode/segment/config hash. |
| `firefox-control-acks*.jsonl` | Target process configuration ACK. |
| `values/` | Complete request fields, body, response, JS args/return/object values. |
| `scripts/` | Browser-captured script artifacts. |
| `web-assets/` | Finalizer best-effort page and JS downloads. |
| `index/summary.json` | Counts, target fields, degraded count, generated files, match count. |
| `index/causal-index.json` | Target field forms, producer candidates, same-origin context. |
| `index/target-candidates.json` | Automatically ranked request-associated scripts, script match token, exact script identity, opcode PC range and dispatcher candidate for the next segment. |
| `index/trace-health.json` | Loss markers plus runtime ACK and configured-target observation gates. |

## Categorized logs

| Category | Contents | Agent use |
|---|---|---|
| `request-fields` | Field location (`url.query`/`body`/`headers`/`cookies`), raw/decoded SHA-256, artifact path, composite segments. | Start here for target request fields. |
| `network` | XHR/Fetch/WebSocket/raw HTTP requests and responses, including request headers when captured. | Reconstruct URL, headers, cookies, body and server-returned state. |
| `js` | JS calls, values, call IDs, parent IDs, script identity. | Locate producer and propagation. |
| `script` | Script URLs, hashes, artifacts, source maps. | Read algorithm source. |
| `state` | Cookie/storage/IndexedDB records. | Identify persistent/session dependencies. |
| `dom` | Document, nodes, canvas, DOM calls/events. | Supplement DOM environment. |
| `bom` | Navigator, screen, location, history, performance, crypto. | Supplement browser environment. |
| `wasm-vm` | WASM modules, compact VM window metadata, opcode, VM step. | Route JSVM/WASM cases. |

## JSONL consumer contract

Read JSONL incrementally. Do not use whole-file `readFileSync(...).split()` for
large streams. An empty stream has zero records, not one empty JSON value.
Portable exporters must preserve record discriminator fields such as `type`,
plus IDs needed by downstream joins; field minimization is valid only after the
fixture is replayed independently.
| `control-health` | control, ACK, degraded, boundary summary. | Decide evidence quality. |

DOM Promise records are split into two event types. Observation is unbounded by
default; an Agent may add `TRACE_DOM_PROMISE_LIMIT` as an explicit observer-side
budget, which is reported as `trace.degraded` when reached:

```text
dom.promise.observe  { promise_id, state: pending|fulfilled|rejected, origin_call_id }
dom.promise.settle   { promise_id, state: fulfilled|rejected, value, origin_call_id }
```

`index/environment-contract.json.promise_ledger` is the joined view. Use
`coverage.async_result_pending` for unresolved calls at the stop boundary and
`coverage.async_result_values_captured` as the replay gate. A short stop drain is
applied by the UI so settlement events that are already queued can arrive without
keeping the whole page trace open.

## Value alignment

Use these fields:

```text
value_store_path
sha256 / value_sha256 / value_sha256_raw / value_sha256_decoded
call_id
parent_call_id
origin_call_id
request_id
script_sha256
script_raw_sha256
script_hash_source
```

A producer claim is strong when the request field SHA-256 equals a JS value SHA-256 and the request context matches by `origin_call_id` or explicit call/request linkage.

`target-candidates.json` is the UI handoff file. The user does not provide
`TRACE_OPCODE_SCRIPT_CONTAINS`, `TRACE_OPCODE_PC_RANGE`, or
`TRACE_VM_DISPATCH_PC`; the server reads the recommended candidate and applies
only the fields supported by the current evidence. Dispatcher PC is applied
automatically only for a high-confidence heuristic result.

`js.vm_window` points to `firefox-vm-window-*.bin`. Format `ftvmw1-le` has a
64-byte header followed by fixed 80-byte records containing seq/time/call/PC,
SpiderMonkey op and operand bytes, stack depth, and exact top-two primitive
payloads when present. Run `tools/trace_vm_window.py TRACE_DIR`; do not expand
the whole artifact into categorized JSONL. Sandboxed content sends the complete
binary to the parent in one IPC message; the parent writes one accepted window
per segment before the metadata event is observed.

For a run with explicit query/body/header/cookie targets, health is incomplete
when either `control:runtime_config_not_acknowledged` or
`request:configured_target_not_observed` is present. A manifest, static web
asset, or source candidate does not prove that Firefox entered the configured
runtime. The VM-window analyzer also exits non-zero when no window metadata is
present.

## Composite fields

`request-fields` may include:

```text
decoded_forms
composite_segments
```

Use segments as leads. A segment match proves that component appeared in JS; the full-field producer still needs full field or assembly evidence.
