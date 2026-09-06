# UI Options And Defaults

The desktop UI is the primary product surface: `Firefox Trace Console.app` or `tools/trace-desktop.sh`.

For the decision matrix, fingerprint-object overlays and a complete config
schema, read `trace-mode-playbook.md` before changing controls manually. The
complete panel-to-JSON map is `ui-parameter-catalog.md`; missing built-in
objects use `environment-repair-playbook.md`; stable launch and recovery use
`firefox-startup.md`.


## Panel operating rules

- First chain-discovery pass: keep the default `全量 trace` (`full-chain`) and start active if page-load code matters.
- One-pass byte/environment evidence: use `全量 trace` with `JS mode=boundary`; continuous args/return, values, and `Math.random` returns go through the async full spool. DOM/BOM scalar getter returns, Cookie, and Storage remain available for environment reconstruction. Finalization writes the bounded ledger to `index/environment-contract.json`.
- Treat the first `full-chain` directory as the final candidate when its request, values, environment contract and response evidence are complete. When one named gap remains, use a fresh, narrower rerun without merging directories; the Agent writes the visible UI/environment configuration as `agent-next.json`.
- For the final pass, keep `full-chain + boundary`, set `TRACE_JS_OBJECT_TARGET_ONLY=1`, and use the discovered script/function/hash identity with depth `1`, keys `32`, array items `16`. Boundary calls remain full-chain; only matching object values are expanded.
- `target` and `deep` require a loaded script, function, or SHA-256 candidate. If the identity is empty, the desktop console visibly switches to `boundary` and logs the reason instead of producing an empty JS trace.
- `target` is a narrow JS-only follow-up: it records only configured identity matches and their values. It is not the final full-chain mode. Load it only from an Agent-generated complete config after a candidate is confirmed; otherwise retain `boundary`.
- Fill the target field where it lives: query, body, request header, or cookie.
- JSVMP/WASM options are additive evidence. Keep JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script enabled unless the run becomes degraded or too heavy.
- Script identity is tool-owned. The request caller, `origin_call_id`, JS call chain, value matches and script artifacts produce `index/target-candidates.json`; the UI applies the selected identity, opcode PC range and dispatcher PC automatically.

## Raw HTTP

Raw HTTP records lower-level HTTP channel payload chunks (`channel_id`, `offset`, `payload_hex`, URL/context metadata). Use it when logical XHR/Fetch evidence is already aligned but byte-level differences remain: multipart boundaries, compression/charset, binary bodies, newline/encoding issues, or response chunk inspection. It is usually off during normal environment reconstruction and pure calculation work.

## Session panel

| UI item | Default | Effect |
|---|---:|---|
| Target URL | `about:blank` | Firefox opens this address. |
| Output directory | `~/Desktop/firefox-trace-outputs/firefox-trace-YYYYMMDD-HHMMSS` | All logs/artifacts/indexes for the run. |
| Firefox binary | packaged runtime Nightly if present | Modified Firefox executable. |
| Profile directory | empty | Empty creates a temporary profile; fill it to reuse state. |
| Run label | `manual` | Human-readable label in manifest/control. |
| Startup mode | `active` | Open and trace immediately. |
| Reuse output directory | off | Keep off for a fresh run; turn on to append segments. |

Startup modes:

| Mode | Use |
|---|---|
| `active` | Capture page-load scripts, initialization, early requests. Recommended for chain discovery. |
| `paused` | Prepare login/captcha/navigation first, then start before the target action. |
| `prewarm` | Warm browser/runtime before a formal action window. |

## Capture plan

| Plan | Use | Evidence |
|---|---|---|
| `全量 trace` / `full-chain` | Default one-pass evidence collection | Continuous JS boundary, script-run, untruncated value/script artifacts, complete Fetch/XHR request and response artifacts, DOM/BOM `all` values/object contracts/Promise settlement, Cookie/Storage and WebSocket. `0` for full-chain artifact/preview limits means no trace-side truncation. VM/WASM off. |
| `轻量 trace` / `discover-light` | Lower overhead first pass | Requests, scripts, DOM/BOM signal, Cookie/Storage and bounded JS boundary with reduced value capture. |

Default target fields are generic:

```text
signature,token,risk_field,fingerprint,nonce,timestamp,challenge_id,security_token,anti_token,auth_token,checksum,digest
```

Users can replace them with any query/body/header/cookie field names. Header matches appear as `location=headers`; cookie matches appear as `location=cookies`.

## Modules

`full-chain`: JS, XHR, Fetch, DOM/BOM, Cookie, Storage, Script artifact and
WebSocket on; Raw HTTP off. `discover-light`: the same core modules with
WebSocket off; Raw HTTP off. VM/WASM switches are controlled by the VM stage.
The exact switch-to-config mapping is in `ui-parameter-catalog.md`.

## JS value options

Default UI strength is `通用完整值落盘（默认）`:

- full-chain uses `0` (no ordinary JS total-count cutoff); discover-light uses the explicit `50000` fuse;
- object depth: `1` in the UI full-chain preset, with `TRACE_JS_OBJECT_TARGET_ONLY=1` so expansion is limited to a confirmed target identity. For a final Agent-generated overlay, keep depth `1`, keys `32`, and array items `16`;
- object keys: `0` means no key-count cutoff;
- array items: `0` means no item-count cutoff;
- typed-array bytes: `256` in the default UI preset;
- value metadata: `1`;
- primitive metadata: `1`;
- value store min bytes: `1`, so short dynamic values, flags, timestamps and nonces remain available for alignment;
- JS value store max bytes: `0`, meaning do not drop artifacts by trace-layer size;
- deferred value capture: `1`; it prevents synchronous per-call value IPC/file writes;
- deferred value pool: `67108864` bytes; a pool-limit event is explicit degradation, not silent truncation;
- boundary window: `8192` events; it is separate from the ordinary JS event fuse.

Full values are usually stored under `values/`; JSONL keeps preview, size, SHA-256, and path.

## VM/WASM options

Defaults after applying either first-pass capture plan: all VM/WASM fine-grained
checkboxes are off, including raw operands and WASM module metadata. A loaded
Agent configuration or a selected VM stage is the only normal way to enable
them.

Safety defaults:

| Parameter | Default |
|---|---:|
| opcode limit | 4096 |
| opcode execution budget | 65536 |
| VM step limit | 2048 |
| opcode events/s | 2000 |
| opcode bytes/s | 4194304 |
| IPC events/s | 12000 |
| IPC bytes/s | 8388608 |
| stack slots | 2 |
| WASM module limit | 16 |
| WASM preview bytes | 128 |
| WASM dump max bytes | 1048576 |
| WASM insn limit | 512 |

`目标脚本 contains` is an internal runtime substring generated from the recommended script URL; the user does not enter it. `opcode PC range` is a numeric SpiderMonkey bytecode range like `120:220`, generated by the analyzer. `dispatcher PC` is the single bytecode PC of a JSVM dispatcher loop and is auto-applied only when the heuristic reaches high confidence. Raw operands and every VM/WASM checkbox start off; selecting a VM stage is the only normal way to enable them.


## VM stage presets

Use the UI preset instead of guessing individual checkboxes:

- `一轮还原模式（推荐：请求触发回溯）`: no full-site opcode/VM step; use request-triggered JS/value/source ring-buffer evidence first.
- `局部 opcode：自动候选脚本`: enable JS opcode + raw operands only after a candidate script/range exists.
- `VM step：已确认 dispatcher`: enable VM step only after the dispatcher PC is confirmed.
- `默认关闭 VM（普通 full-chain）`: VM/WASM fine-grained switches all off.
- `WASM：只看模块元数据`: module metadata only; dump/raw bytes are follow-up options.

For the second target/value pass, usually select `一轮还原模式`, leave JS opcode and VM step unchecked, and narrow via `agent-next.json` rather than asking the user to type long filters. Use `agent-next.env` only when no visible UI value changes.

Agent reminder checklist per stage:

| Stage | User instruction |
|---|---|
| One-pass evidence | Select `一轮还原模式`; keep JS opcode/VM step/WASM dump/raw off; do one target action and stop. |
| Target/value rerun | Load Agent-generated `$TRACE_DIR/agent-next.json`; for env-only changes use `加载 env 文件…` with `$PWD/agent-next.env`; keep VM preset as `一轮还原模式`; do the same short target action. |
| Opcode hotspot | Select `局部 opcode：自动候选脚本`; check JS opcode + raw operands; leave VM step and stack primitives off unless requested. |
| Dispatcher | Select `VM step：已确认 dispatcher` only after Agent provides/loads dispatcher PC; do not ask the user to type PC. |
| VM state follow-up | Check stack slot/type or primitive values only when Agent asks for VM state evidence. |

Keep the normal JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script modules enabled unless the run is degraded or the Agent identifies a concrete overhead source.

## Missing built-in objects

When the request and producer are already present but a DOM/BOM object or
returned value is absent from the trace, keep the current Firefox page/profile
open and use the DevTools console or Firefox RDP/BiDi `script.evaluate` first.
Capture the named object, descriptor/prototype/brand and selected value, record
it as `browser-console-observed`, and patch the local host from that result.
Do not start another full trace for a value-only gap. Read
`environment-repair-playbook.md` for the bounded probe and the conditions that
still justify a new trace.

## Firefox startup

Use `Firefox Trace Console.app` or `tools/trace-desktop.sh` for the headed UI.
The command-line equivalent and recovery table are in `firefox-startup.md`.
Always verify the packaged Nightly executable with `--version`, use a fresh
profile/output directory, and inspect `ui-launcher.log` before restarting a
slow or failed process.

## Extra env file loading

Env files are a post-first-pass handoff, not a first-pass requirement. Leave the panel empty on the first trace. When an Agent needs an env-only handoff, it writes `agent-next.env` in its current working directory and reports the absolute path for `加载 env 文件…`.

The `② 首轮采集 / 目标字段` panel always shows the complete-config buttons;
the advanced env panel remains available for env-only edits. The controls are:

- `加载 Agent 完整配置…`: choose a complete `agent-next.json` handoff and fill
  every visible configuration field in one operation.
- `加载当前目录 agent-next.json`: load
  `$TRACE_DIR/agent-next.json` without navigating a file picker.
- `加载 env 文件…`: choose any `.env`/text file and load `NAME=VALUE` lines into the text box.
- `加载当前目录 agent-next.env`: load `$TRACE_DIR/agent-next.env` from the current output directory.
- `清空`: clear the env text box.

`agent-next.json` uses schema `firefox_trace.agent_config.v1`. It contains
`ui` (session, field values, field-scope checkboxes, intensity and VM stage),
`modules`, `options` (JS/value controls), `vm` (all opcode/WASM controls and
limits), and `env`. The complete example, including every visible VM limit,
is in `references/agent-next.json.example`.

The loader also accepts a flat file and an `env` string, so an Agent can write
only the fields it is changing. Explicit `options`/`vm` values are applied
after intensity/stage defaults and are not overwritten by a preset. The JSON
button fills the session, target fields, field scopes, modules, JS/value
controls, VM/WASM controls, limits and env text in one operation.

When the Agent proposes long env variables, write them into its current working directory:

```text
$PWD/agent-next.env
```

For a complete handoff, write the complete UI JSON in the trace directory and the optional env-only compatibility file in the Agent working directory:

```text
$TRACE_DIR/agent-next.json
$PWD/agent-next.env
```

Then instruct the user:

```text
② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json -> 应用配置/打开 Firefox
```

For env-only handoffs use `加载 env 文件…` and select the reported absolute
path. This avoids copy/paste truncation and missed checkboxes.

## Layout and scrolling

Both left and right UI panes are independently scrollable. Readonly dropdowns
do not consume wheel/trackpad input to change their value: selection happens
by clicking the opened list, while scrolling over a closed dropdown moves its
containing pane. `agent-next.json` and env files can be dropped onto the two
visible drop targets; the complete JSON loader fills all UI fields in one pass.
