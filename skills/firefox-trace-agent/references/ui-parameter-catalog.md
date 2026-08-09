# UI Parameter Catalog

This is the source-oriented map for the desktop panel. Read it before writing
`agent-next.json` or telling the user which controls to change. The visible
Tk controls live in `tools/trace-desktop.py`; runtime translation and bounds
live in `tools/trace-console-server.py` and `tools/trace-control.sh`.

The panel has three kinds of values:

1. **Visible controls**: the user can select or type them in the panel.
2. **Agent-owned values**: the analyzer writes them to `agent-next.json`; the
   user loads the file and repeats the action.
3. **Runtime-only values**: long `TRACE_*` variables belong in `env` or
   `agent-next.env`, not in a hand-filled UI field.

## 1. Session

| Panel item | Config key | Runtime effect | Agent choice |
|---|---|---|---|
| Target URL | `ui.url` / `url` | Page opened by the headed Firefox launcher. | Copy the exact page and query needed to reproduce the action. |
| Output directory | `ui.trace_dir` / `trace_dir` | `TRACE_DIR`; raw JSONL, artifacts and indexes are written here. | Use a fresh timestamp directory for a final independent run. |
| Firefox executable | `ui.firefox_bin` / `firefox_bin` | Modified Firefox binary. | Keep the project runtime; record `--version` in the report. |
| Profile directory | `ui.profile_dir` / `profile_dir` | Cookie, Storage, permissions and session state. | Reuse the same profile for an environment comparison; use a fresh profile only for a deliberate state experiment. |
| Run label | `ui.label` / `label` | `manifest.json`/segment label. | Describe the evidence gap, not the website. |
| Startup mode | `ui.trace_start` | `active`, `paused`, or `prewarm`. | `active` for page-load generation; `paused` for login/preparation; `prewarm` for a delayed action window. |
| Reuse output directory | `ui.reuse_trace` | Append a segment to an existing `TRACE_DIR`. | Keep off for a final trace; use on only when the same profile and campaign are intentional. |
| New timestamp directory | button | Creates a fresh `TRACE_DIR`. | Use before a new final candidate. |

## 2. First-pass and target fields

| Panel item | Config key | Values | Meaning |
|---|---|---|---|
| Capture plan | `ui.plan` / `plan` | `full-chain`, `discover-light` | Full-chain is the one-pass evidence candidate. Light is a lower-cost discovery pass. |
| URL Query fields | `ui.query_fields` | CSV or `__disabled__` | Extract matching query fields plus preview, size, SHA-256 and optional artifact. |
| POST Body fields | `ui.body_fields` | CSV or `__disabled__` | Extract JSON/form body fields without changing the real upload stream. |
| Request Header fields | `ui.header_fields` | CSV or `__disabled__` | Extract matching request headers and mark `location=headers`. |
| Cookie fields | `ui.cookie_fields` | CSV or `__disabled__` | Match Cookie, `document.cookie`, CookieStore and Set-Cookie lifecycle values. |
| Four scope checkboxes | `ui.field_scopes` | `query/body/header/cookie: true|false` | A disabled scope is serialized as `__disabled__`; it is not the same as an empty field list. |
| Capture intensity | `ui.intensity_key` | `auto`, `hi-fi`, `near-full` | Applies numeric defaults for object/value/opcode budgets. Explicit `options`/`vm` values in JSON win afterwards. |
| Ordinary JS event fuse | `ui.unlimited_trace` | checkbox | Full-chain applies `FIREFOX_TRACE_JS_LIMIT_EVENTS=0`; light keeps the bounded fuse. A fuse hit must be reported as degraded. |
| Show advanced / Agent config | `ui.show_advanced` | checkbox | Reveals modules, JS/value controls, VM/WASM and extra env. Loading a complete JSON normally turns this on. |

Use the real target field name in the correct scope. Keep the other three
scopes disabled once the location is known; this reduces noise without
changing the request.

UI event/value limits are capture settings, not lifecycle protection. Whenever
the Agent starts the browser, it must also run `trace-stop-on-target.py` with
the configured fields, a 120-second limit and a 2 GiB directory limit. The
first durable target event triggers immediate stop/finalize. This applies to
`full-chain` even when its ordinary JS event fuse is `0`.

### Intensity materialization

The current UI presets write these values when selected:

| Preset | Object depth | Object keys | Array items | TypedArray bytes | JS event limit | Value-store minimum |
|---|---:|---:|---:|---:|---:|---:|
| `auto` / 通用完整值落盘（默认） | `1` | `0` | `0` | `0` | `0` in full-chain | `1` |
| `hi-fi` / 高保真短窗口 | `1` | `0` | `0` | `1024` | `100000` | `1` |
| `near-full` / 近全量短窗口 | `2` | `0` | `0` | `8192` | `300000` | `1` |

`object_keys=0` and `array_items=0` mean no count cutoff, not “capture no
keys/items”. For a targeted final overlay, replace them with `32` and `16`.

## 3. Module switches

The checkboxes are serialized under `modules` and also become the corresponding
runtime gates.

| Module | full-chain | discover-light | Evidence |
|---|---:|---:|---|
| JS | on | on | JS call enter/return, values and call context. |
| XHR | on | on | XHR open/send/body/response and fields. |
| Fetch | on | on | Fetch call/request/response/done and fields. |
| DOM/BOM | on | on | Full-chain records `all` DOM/BOM operations, scalar values, Promise settlement and non-recursive object contracts. Light keeps the signal-only form. |
| Cookie | on | on | Cookie reads/writes and lifecycle. |
| Storage | on | on | local/session/partitioned storage and related state. |
| Script artifact | on | on | Script URL, source/hash and downloaded artifact. |
| WebSocket | on | off | WebSocket frames and lifecycle; enable only when the target uses it. |
| Raw HTTP | off | off | Channel chunks and payload bytes; use after logical request evidence is aligned. |

WASM is controlled in the VM/WASM panel. Selecting a WASM option makes the
server add the `wasm` module even though it is not a normal module checkbox.

## 4. JS Call / value controls

### Visible controls

| Panel item | Config key | Default/values | Use |
|---|---|---|---|
| JS mode | `options.js_mode` | `boundary` / `target` / `deep` / `off` | `boundary` is first-pass and one-pass; `target` needs an Agent-loaded identity; `deep` is a confirmed local call tree; `off` removes JS calls. |
| Object depth | `options.object_depth` | current targeted overlay `0` | Keep `0` with an unpatched/stock binary. The patched Gecko build has a thread-local preview re-entry guard, so a narrow all-evidence pass may use `1..2`. |
| Object keys | `options.object_keys` | current targeted overlay `0` | Property count is inactive at depth `0`; use narrow DOM member capture for named browser object values. |
| Array items | `options.array_items` | current targeted overlay `0` | `0` means no count cutoff; use it with the patched guard when full array evidence is required. |
| TypedArray bytes | `options.typed_array_bytes` | `0` in auto/full-chain | `0` captures all available bytes; a positive value is an explicit preview cap for typed arrays, ArrayBuffer and DataView. |
| Value metadata | `options.value_metadata` | `1` | Record hash, role, path, call and artifact metadata for short/long values. |
| Primitive metadata | `options.primitive_metadata` | `1` | Keep number/boolean/null/undefined evidence such as time, flags and counters. |
| Value-store minimum | `options.value_store_min_bytes` | `1` | Values at or above this UTF-8 size get a `values/` artifact; the default keeps short dynamic values available for byte alignment. |
| Deferred capture | `options.deferred_value_capture` | `1` | Keep hot JS paths asynchronous; do not turn this off on a heavy page without a reason. |
| Deferred pool bytes | `options.deferred_value_pool_bytes` | `67108864` | In-memory value pool before an explicit degraded event. |
| Boundary window | `options.boundary_buffer_events` | `8192` | Recent JS call window retained for a target request; it is separate from the ordinary JS event fuse. |
| Ordinary JS event limit | `options.limit_events` | `0` full-chain, `50000` discover-light | `0` is unlimited at the ordinary JS layer. A non-zero value is only the explicit light-plan fuse and is reported if reached. |

### Agent-owned or runtime-only JS values

These fields exist in the JSON schema but are not normal free-text UI inputs:

| Field | Owner | Source |
|---|---|---|
| `options.profile` | Agent/server | Plan and VM stage (`discover`, `field`, `target`, `deep`, `vm`). |
| `options.target_match` | Agent/server | `auto` normally; `all` for a confirmed script/function identity. |
| `options.script_contains` | Agent/server | Runtime request writer/value producer and script artifact. |
| `options.function_contains` | Agent/server | Stable function evidence from `categorized/js.jsonl`. |
| `options.script_sha256` | Agent/server | Exact script artifact hash. |
| `options.value_store_max_bytes` | runtime/env | `0` means the trace layer does not discard by artifact size. |

The user should load these through `agent-next.json`; the Agent should not ask
the user to copy a long script URL, function filter or hash by hand.

### Known targeted-object crash guard

Before emitting a complete config, check the combined effective payload, not
only the visible intensity preset. If any of `script_contains`,
`function_contains`, or `script_sha256` is non-empty, force both
`options.object_depth` and `TRACE_JS_OBJECT_DEPTH` to `0` for the current
runtime. A matching identity sets `object_target_match=true`; positive depth
then reaches `writeObjectProps()` and `JS_GetPropertyById()`, where a scripted
getter can recursively enter `AutoFirefoxTraceJSCall` until the content process
hits its stack guard page. Preserve value metadata/store and use
`TRACE_DOM_MEMBERS` with `TRACE_DOM_OBJECT_VALUES=1` for named values instead.

## 5. VM / WASM panel

The stage combobox is the primary control. Applying a stage resets the fine
checkboxes first; explicit JSON `vm` values are applied afterwards.

| Stage | VM window | JS opcode | Raw operands | Stack primitive | VM step | WASM metadata |
|---|---:|---:|---:|---:|---:|---:|
| 默认关闭 VM | off | off | off | off | off | off |
| 一轮还原模式 | off | off | off | off | off | off |
| VM window | on | off | compact binary | top-2 exact primitives | off | off |
| 局部 opcode | off | on | on | off | off | off |
| VM step / dispatcher | off | off | off | off | on | off |
| WASM 模块元数据 | off | off | off | off | off | on |

Visible numeric fields include script line/column, bytecode length, stack
slots, opcode limit, execution budget, VM-step limit, opcode/IPC events per
second, opcode/IPC bytes per second and WASM module/preview/dump/instruction
limits. Script substring, script hash, PC range and dispatcher PC are
Agent-owned identities; the analyzer or a loaded JSON supplies them.

Safe defaults:

```text
vm_window_records=65536
opcode_limit=4096
opcode_execution_limit=65536
vm_step_limit=2048
opcode_max_events_per_second=2000
opcode_max_bytes_per_second=4194304
ipc_max_events_per_second=6000
ipc_max_bytes_per_second=4194304
opcode_stack_slots=2
wasm_module_limit=16
wasm_preview_bytes=128
wasm_dump_max_bytes=1048576
wasm_insn_limit=512
```

`VM/opcode 也不截断` sets `TRACE_UNSAFE_ALLOW=1`. Use it only after a script
and short target action are already locked, then stop immediately after the
request. It is a trace budget switch, not a normal first-pass setting.

## 6. Extra environment and file loading

The `⑥ 额外环境变量` text area accepts one `NAME=VALUE` pair per line. The
buttons are:

- `加载 Agent 完整配置…`: fills session, scopes, modules, JS/value, VM/WASM
  and env from `firefox_trace.agent_config.v1`.
- `加载当前目录 agent-next.json`: reads `$TRACE_DIR/agent-next.json`.
- `加载 env 文件…`: loads an env-only file from the reported absolute path.
- `加载当前目录 agent-next.env`: reads `$TRACE_DIR/agent-next.env`.
- `清空`: removes the text-area content.

Use a complete JSON whenever any visible control changes. Use `agent-next.env`
only when the visible form stays unchanged. The first trace has no output
directory yet, so its env area remains empty; the Agent writes the next-pass
file only after finalization.

The desktop console also supports drag-and-drop: drop an `agent-next.json` on
the `拖入 agent-next.json` target to fill every visible session/field/module/
JS/VM/env control, or drop an `.env`/`.txt` file on the environment target to
fill the env text area. Readonly comboboxes are click-select only; wheel and
trackpad events over a closed dropdown are routed to the surrounding pane and
never change its selected value. The left configuration pane and right status
pane have independent vertical scroll regions, so a small window does not
hide controls or log status.

## 7. Evidence gap to next configuration

| Observed gap | Next UI/config | Keep off or constrain |
|---|---|---|
| Target request or location unknown | `full-chain + active + boundary`; enable the four field scopes until location is known. | VM/opcode, Raw HTTP. |
| Page must be prepared first | `full-chain + paused + boundary`; start only before the target action. | Pre-action noise, VM. |
| Request exists but JS value/producer is missing | `full-chain + boundary`; script identity from `target-candidates.json`, depth/keys/arrays `0`, value metadata/store on; add narrow DOM members for named host values. | JS object property expansion, global DOM depth, `deep`, VM. |
| Object type exists but inner fingerprint value is missing | Keep boundary and add `TRACE_DOM_OBJECT_VALUES=1` plus only observed `TRACE_DOM_INTERFACES`/`TRACE_DOM_MEMBERS`. | `TRACE_DOM_MODE=all`, recursive object walk. |
| Long value is preview-only or truncated | Enable value metadata/store; set store minimum `1`, max `0`, and keep the exact script/request scope. | Replacing the value with a guessed short preview. |
| Candidate request returns an unexpected status | First validate the exact browser vector and application response semantics. | Changing headers/cookies or patching before the vector is fixed. |
| Candidate differs from browser bytes | Run `tools/trace-align.js` with URL, headers, cookies, body, raw/decoded field and first-difference output. | Comparing length alone. |
| Logical request aligns but transport bytes differ | Add `Raw HTTP` for one short action. | Keeping Raw HTTP on for the whole page. |
| Fixed bytes align and only time/random/session values differ | Move to dynamic-input generation and native page/profile validation; then pure calculation when the user wants an offline deliverable. | Reusing historical time/random/nonce values. |
| VM/interpreter evidence remains after producer is known | `局部 opcode` first; `VM step` only after a dispatcher PC is confirmed. | Stack/primitive/WASM broad capture. |
| Browser API or native path is the named blocker | Patch the smallest browser surface, preserve normal execution, add a rollback and smoke test, then rerun the same request. | Changing unrelated scheduling, serialization or request routing. |

## 8. Agent handoff contract

After choosing a row above, write one complete `agent-next.json` in the current
trace directory. Tell the user the exact file path, the one UI load action, the
one browser action to repeat and the stop condition. A handoff is complete only
when the JSON contains every visible value that changed; the user never has to
retype a long filter or env block.
