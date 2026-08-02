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
| `wasm-vm` | WASM modules, opcode, VM step. | Route JSVM/WASM cases. |
| `control-health` | control, ACK, degraded, boundary summary. | Decide evidence quality. |

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
```

A producer claim is strong when the request field SHA-256 equals a JS value SHA-256 and the request context matches by `origin_call_id` or explicit call/request linkage.

## Composite fields

`request-fields` may include:

```text
decoded_forms
composite_segments
```

Use segments as leads. A segment match proves that component appeared in JS; the full-field producer still needs full field or assembly evidence.
