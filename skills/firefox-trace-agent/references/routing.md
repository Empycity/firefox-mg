# Route Selection

Select a route from trace evidence, not from field names.

| Route | Signals | Next evidence |
|---|---|---|
| `standard-js` | Request field aligns with ordinary JS call/value records; script artifact is normal JS. | Confirm producer, then inspect args/return/object/state/env. |
| `jsvmp` | Dispatcher loop, encoded instruction/data arrays, hot opcode region, opaque local interpreter. | Confirm request-field producer first; then bounded opcode/VM step on one script. |
| `wasm` | `wasm.module`, module artifact, JS-to-WASM boundary near target request. | Record module hash/artifact/imports/exports and JS boundary. |
| `mixed` | Full field is assembled from components with distinct producers/classes. | Preserve full field; prove each component independently. |

## Opcode/VM discipline

Before enabling opcode/VM step, collect:

```text
script_contains or script_sha256
candidate function or dispatcher evidence
short reproducible target action
```

`contains` means a script URL/file-name substring. `opcode PC range` and `dispatcher PC` are produced by analysis, not guessed by the user: first run can leave them empty, then use `tools/trace_opcode_analyzer.py` to identify hot windows and a dispatcher candidate. Opcode events localize SpiderMonkey bytecode regions; they do not by themselves decode a page-defined VM instruction set.
