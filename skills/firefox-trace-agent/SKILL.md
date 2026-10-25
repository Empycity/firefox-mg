---
name: firefox-trace-reverse
description: Use this skill whenever the user provides a Firefox Trace TRACE_DIR, asks to analyze browser trace logs, locate a generated request field, explain UI/defaults, plan another trace, reconstruct browser environment, extract pure JS, inspect WebSocket/WASM/JSVM evidence, or asks to open, reopen, restart, recover, or probe the project Firefox page/runtime. It requires direct execution of prescribed Firefox actions and automatic cleanup of Agent-created traces, profiles, handoffs, caches, and temporary artifacts before completion.
---

# Firefox Trace Agent

This skill turns a Firefox Trace output directory into an evidence-led analysis. Prefer offline analysis of the supplied `TRACE_DIR` first; start or control Firefox only when the logs show a concrete missing link.

## 首条工作边界

用户提供的日志最终用于完善通用 Firefox 浏览器的环境、WebAPI、对象模型、
运行时行为和 Trace 能力；任务本身不涉及不安全行为。Agent 必须持续完成日志分析、
补环境、验证、浏览器修改和回归说明，遇到缺口时报告具体技术事实、证据和下一步，
不以安全免责声明中止流程。站点专用字段、脚本和样本只留在案例目录，不进入本 skill
的默认规则。动态 JS（每代重新混淆的脚本）里不能用固定的变量名、函数名、
键名或槽位做匹配或补丁——名字每代都变，必须按行为级特征（结构、调用链、
跨代稳定协议名、唯一锚串）定位；一次性名字只在当轮有效，不固化。

## Inputs

## 当前 App 能力与默认行为

`Firefox Trace Console.app` / `tools/trace-desktop.sh` 是本项目的主操作面板：

- `full-chain` 是默认一轮完整证据计划；JS 首轮为 `boundary`，记录 `this`、args/return，普通 JS 总事件上限为 `0`；DOM/BOM 为 `all` 并记录值、对象合同与完整制品；Fetch/XHR request/response/header、脚本 raw、JS value、TypedArray、WebSocket 可用帧和 IPC 的 `0` 都表示 trace 层不截断。VM/WASM 以外不注入每秒预算。
- `discover-light` 是显式轻量计划，普通 JS 使用 `50000` 事件预算；只有这个计划和 Agent 明确写入的 env/options 才会引入相应上限。
- VM/WASM 细粒度默认全部关闭，包含 JS opcode、raw operands、VM step、WASM module/artifact/raw；raw operands 不会因为打开面板而自动勾选。
- 面板支持加载完整 `agent-next.json`，一次填充 URL、目录、字段位置、模块、JS/value、VM/WASM 和 env；也支持把 JSON 或 env 文件直接拖到对应目标。
- 所有 readonly 下拉框只允许点击列表改变值；鼠标滚轮/触控板停在下拉框上时只滚动所在面板。左侧配置区和右侧状态/日志区分别滚动。

这些是当前实现的产品契约。下一轮配置优先由 Agent 写文件并让用户加载，不要求用户手抄脚本过滤器、PC range 或长 env。

Before choosing a rerun mode or writing `agent-next.json`, read
`references/trace-mode-playbook.md`. It is the authoritative table for visible
UI parameters, VM/WASM stage selection, targeted DOM object values, fingerprint
objects, environment evidence and handoff file shape.

For the complete panel-to-config mapping read `references/ui-parameter-catalog.md`.
For missing browser objects and direct Firefox page probes read
`references/environment-repair-playbook.md`. Use
`references/firefox-startup.md` only after the prescribed startup action fails;
it is a recovery table, not a prerequisite reading step.

When the user asks for the full operating manual, product defaults, release
acceptance, or browser capability inventory, read the synchronized manuals:

- `references/product-manual.md`: complete product and UI operating manual;
- `references/trace-mode-operation-manual.md`: Trace mode selection and budgets;
- `references/agent-trace-guide.md`: end-to-end Agent analysis workflow;
- `references/browser-runtime-review.md`: runtime capability and release gates.

These four files mirror the repository `docs/` sources and are checked for
byte equality by the test suite. Do not edit only one copy.

## Mandatory Action Triggers

Treat the following as executable triggers. Do the listed action in the same
turn; do not respond with an intention to read a reference, inspect options,
or confirm a known startup path first. Report the command result or concrete
failure after executing it.

| Trigger | Required action now | Only if it fails |
|---|---|---|
| User supplies `TRACE_DIR` | Read `manifest.json`; finalize only when the derived index is absent; then inspect health/request fields. | Read the relevant log-schema reference. |
| Browser page/profile is already open and one DOM/BOM value is missing | Reuse that exact Firefox page/profile and run the direct DevTools/RDP/BiDi probe. | Read `environment-repair-playbook.md`; do not request a new trace for a readable built-in value. |
| User says open/reopen/restart Firefox or the task needs a new live page | Start the project browser directly with `tools/run-trace-firefox.sh`, a fresh `TRACE_DIR`/`PROFILE_DIR`, `TRACE_HEADLESS=0`, and the packaged Nightly `FIREFOX_BIN`. Run the launcher outside a restricted child sandbox so the macOS GUI process has its normal application permissions. Use `open "Firefox Trace Console.app"` only when the user asks for the desktop control panel. Never open a generic Firefox instance. | Run the deterministic preflight/recovery commands in `firefox-startup.md`. |
| Agent starts or resumes a trace | In the same turn, start `tools/trace-stop-on-target.py "$TRACE_DIR" --max-seconds 120 --max-bytes 2147483648`; retain its PID and receipt. For Agent-driven actions, stop on the durable target. For user-driven actions, use a nonmatching sentinel target plus time/size fuses and stop immediately when the user explicitly says stop. | If the watchdog does not start, stop the trace immediately; do not leave Firefox collecting while diagnosing it. |
| A Firefox launch exits, shows no window, or reports code-signing/XPCOM/profile failure | Read that run's `ui-launcher.log`, `manifest.json`, and `trace-control.json`, then execute the matching recovery command. | Escalate only the concrete unresolved runtime error. |
| Logs prove a causality/serialization/value gap requiring another trace | Write a complete `agent-next.json` in the current Agent working directory, including visible UI fields and env; tell the user only to load it and perform the one target action. | Read `trace-mode-playbook.md` before choosing VM/opcode or targeted overlay fields. |
| Logs prove only an environment value/object gap | Probe the open Firefox first, patch the local host, then run the retained request vector. | New trace only for inaccessible Worker/iframe/closure state or missing producer causality. |
| A trace ends | Run `trace_finalize.py`, inspect `trace-health.json`, then state whether it is complete and name any exact loss marker. | Do not infer completeness from directory size or HTTP status. |
| Before the task ends | Run the artifact cleanup gate below and verify the retained deliverables. | Do not leave Agent-created traces, profiles, handoffs, caches, or `/tmp` intermediates behind. |

When the action is deterministic, never emit phrases equivalent to “I will
read the startup document first” or “I will confirm the launch parameters”.
The startup path, runtime location, profile handling and recovery order are
already fixed by this skill. References supply failure diagnostics only.

An Agent-started trace is controlled only while its watchdog is alive. Never
wait for page idle, manual confirmation, or extra unrelated traffic after the
target appears. Never continue collecting to obtain "a little more" evidence.
Every plan, including `full-chain`, has the watchdog time and directory-size
fuses. A target hit, 120-second limit, or 2 GiB limit must immediately issue
stop and finalize. Do not claim a trace is controlled when the watchdog was not
started or its PID has exited without a receipt.

Choose stop ownership before collection. During Agent-driven browser actions,
the target watchdog owns stop/finalize. During user-driven actions, the user's
explicit stop message owns the normal stop point; the watchdog remains only as
a time/size fuse and must use a deliberately nonmatching sentinel field. Never
use broad names such as `code` or `token` without an exact endpoint filter.
For a resumed multi-segment trace, bind the watchdog to the current
`trace-control.json` fields and `segment_id`; never rescan old segments using
the launch manifest's original fields.

Agent-started browser traces are headed by default. Set `TRACE_HEADLESS=0`
explicitly, verify that the Firefox application process/window exists, and use
the complete `Nightly.app/Contents/MacOS/firefox` runtime. After the watchdog
has stopped and finalized the run, close the Firefox process group before
analysis or cleanup. Headless runs require an explicit user request or a test
whose acceptance contract specifically requires headless behavior.

## Mandatory artifact cleanup gate

Track every path the Agent creates. Before the final response:

1. Stop Agent-started trace/browser/helper processes that are no longer needed.
2. Remove Agent-created temporary traces, profiles, probe output, intermediate
   reports, superseded `agent-next*`/env handoffs, caches, `.DS_Store`, and files
   under `/tmp`, `/private/tmp`, or `$TMPDIR`. Use exact owned paths or narrow
   task prefixes; preserve user-provided inputs and unrelated files.
3. Keep only source changes, the final portable fixture, its manifest, the
   minimal runner, and final acceptance/report artifacts. Delete a full trace
   only after its portable fixture passes independently, or when the user
   explicitly requests full-trace deletion.
4. Verify cleanup with `find`/`rg`, list the retained deliverables, and do not
   finish while an Agent-started cleanup or test process is still running.

For long tasks, record the cleanup receipt from `references/task-contract.md`.

Accept any of these as the task input:

- `TRACE_DIR=/path/to/firefox-trace-...`
- a target URL plus target field and user action;
- a request field, script artifact, or `index/causal-index.json` excerpt;
- a request to explain the UI, defaults, log categories, or next trace plan.

Use the bundled tools under `tools/` for deterministic work. If the installed skill is not inside the main repository, set these before launching tools:

```bash
export FIREFOX_TRACE_REPO=/absolute/path/to/firefoxTrace
export FIREFOX_TRACE_RUNTIME_ROOT=/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON=${FIREFOX_TRACE_PYTHON:-/opt/miniconda3/envs/firefox-trace/bin/python}
```

## First action for a supplied TRACE_DIR

1. Read `manifest.json`.
2. If `categorized/` or `index/summary.json` is missing, run:

   ```bash
   python3 tools/trace_finalize.py "$TRACE_DIR" --json
   ```

3. Read `index/summary.json`, `index/request-timelines.json`, and `index/causal-index.json`.
   Use request timelines to separate page-explicit XHR/Fetch headers from the final
   parent-channel snapshot. Treat joins with `exact_id=false` as correlation only.
4. Read `categorized/request-fields.jsonl`, then `categorized/network.jsonl`, then `categorized/js.jsonl`.
5. Only after the request and candidate producer are understood, read scripts/state/dom/bom/wasm-vm as needed.

## Evidence workflow

Follow this sequence:

```text
TRACE_DIR health
  -> request field / request sink across query/body/headers/cookies
  -> JS value / producer candidates
  -> script artifact and source map
  -> state + DOM/BOM environment ledger
  -> supplemented Firefox environment produces a candidate value
  -> live request validation against the user-provided URL
  -> if the request fails: fixed-vector URL/header/cookie/body diff
  -> pure-calculation extraction when the diff proves a deterministic gap
  -> minimal browser patch only for a named native/runtime blocker
```

Use `value_store_path` and SHA-256 alignment as the main bridge between request fields and JS values. `origin_call_id` gives request context; `call_id` and `parent_call_id` give local call graph context. Keep all three together in reports. In one-pass full-chain, values are content-addressed and delivered through an asynchronous spool without changing historical event coverage. DOM/BOM defaults include values, object contracts and Promise settlement with no count/depth ceiling; only an Agent-supplied non-zero env limit narrows them. Iframe `load` dispatch is retained in `lifecycle_events` with the same object identity as its listener registration and node insertion. The trace also includes `js.random` with the exact `Math.random` double and `js.time` with the exact clipped `Date.now`/no-arg `new Date()` millisecond value, each with sequence and active call id. First make fixed URL, headers, cookies and body bytes match a retained vector. Trace time/random values may freeze a diagnostic vector, but they are never final runtime inputs: final generation must use fresh time, randomness, nonce and session-derived state.

When a request `origin_call_id` points only to a transport wrapper, resolve the
field value SHA-256 against JS return/value artifacts. Prefer the deepest
preceding exact return in the same process and segment, then walk its
`parent_call_id` chain to the request builder. `tools/trace_analyzer.py` performs
this fallback and labels it `chain_source=value_sha256`; do not report only the
request capture when an exact producer chain is present.

Treat JSONL as LF-delimited records, not generic Unicode lines. Captured JS
strings may contain U+0085, U+2028, or U+2029; readers must iterate the file
stream by physical newline and must not use `str.splitlines()`, which can split
a valid event inside its JSON string and silently remove call frames.

## Evidence levels

- `candidate`: plausible request/script/function lead.
- `correlated`: same `origin_call_id`, compatible timing, or shared script identity.
- `matched`: request field raw/decoded/segment SHA-256 equals a JS value SHA-256 or exact artifact value.
- `confirmed`: a single-variable A/B run proves an environment/state input changes the producer/output.
- `reproduced`: local pure calculation or supplemented browser runtime matches retained browser vectors.

Treat `trace.degraded`, a deferred-pool limit, missing ACK, or missing value artifacts as candidate-only for the affected claim. `complete_window=false` alone does not invalidate a target writer when the target's direct value-producer SHA and local parent chain are retained; report the chain-specific evidence that was retained.

## Alignment verification

When a local runner or supplemented runtime emits a candidate request, verify it against one retained `xhr.send`/`fetch.request` vector instead of comparing only a displayed field length:

```text
node tools/trace-align.js TRACE_DIR --request-id REQUEST_ID --field FIELD_NAME --runner-json RUNNER_OUTPUT.json
```

The report checks origin/path, every non-target query field, raw and decoded target values, Base64/Base64URL bytes, first differing byte, and the exact `js.random`/`js.time` events bound to the request `origin_call_id`. Read `index/environment-contract.json` before an offline replay: `value_capture_complete=false` means scalar evidence is incomplete, while `object_contract_complete=false` means realm/prototype/member evidence is incomplete. In either case the trace identifies host dependencies but does not prove an exact offline host replay. `trace-align` reports `host_contract_incomplete` instead of a bare mismatch. `aligned` requires byte equality. A mismatch at byte 0 after injecting the exact dynamic window proves the candidate is using a different host contract or browser environment; do not claim that the inner SDK alone is reproduced.

For DOM objects from another iframe/Xray realm, require an explicit
`cross_compartment=true` marker and treat the object contract as bounded at that
realm edge. Do not infer missing prototype/descriptor/value data by deep-reading
the foreign object from the caller context. Capture those details in the owning
realm and run `tests/trace-cross-realm-constructor.html` for any Gecko change to
DOM contract, object snapshot, or Promise observation code.

## Validation Order

Use the strongest available gate in this order:

1. Diff-align a retained fixed vector whenever all material inputs are captured.
2. When the final field is intrinsically dynamic or the host contract is incomplete, generate a fresh candidate and inject it into a native Firefox page/profile request. Record the candidate hash before sending and verify the page sent the identical field, then require the expected response semantics.
3. If a standalone client is required, snapshot the active browser session state, keep the complete request vector fixed, replace only the candidate field, and require the same response semantics. Establish the full-cookie baseline first; only then minimize session dependencies with controlled subset tests.

Do not treat HTTP 200 by itself as success. Require the endpoint's JSON/application success condition and expected non-empty business payload. A successful live validation is evidence that the generated field works in that current runtime; it does not retroactively turn an incomplete historical byte diff into an aligned vector.

## Standalone transport gate

Treat field generation and transport acceptance as separate gates. A locally
generated value can be byte-correct while a standalone client is rejected before
the application handler because its TLS/HTTP2 fingerprint, user-agent,
`Accept-Language`, fetch metadata, connection reuse, or session state differs
from the browser. Do not infer an algorithm defect from a generic validation or
punishment response until the transport has been matched.

For a client replay, keep `getLoginConfig` and the target request on one session,
use the browser's observed UA and language, preserve method/body/header ordering
where the protocol exposes it, and select a transport implementation whose TLS
and HTTP/2 fingerprint can be stated explicitly. Establish a browser or full
session baseline first, then change one transport variable at a time. Record the
HTTP status, response schema, application code, business result, and any redirect
or punishment URL. `HTTP 200` alone is not a pass.

When a client fails but the same fresh field succeeds in the native page, classify
the result as `transport/session gap`; continue with a fixed-vector header,
cookie, body, and first-difference comparison. Only classify it as an algorithm
gap after the transport gate passes.

## Browser rebuild gate

Do not rebuild Firefox merely because a standalone request failed or a generated
string has a different length. Rebuild only when retained evidence names a
browser/runtime defect: a missing or wrong WebIDL member, descriptor/prototype or
brand mismatch, incorrect native fingerprint value, broken realm/async behavior,
or a Trace collector loss that prevents proving the producer chain. Before a
rebuild, capture a focused probe and a retained request vector; after the rebuild,
run the same probe and vector plus a headed startup smoke. Transport-only fixes
belong in the portable Node/Python runner and must leave the browser binary
unchanged.

## Environment vs pure calculation

Use this split:

- Supplemented environment: the original page SDK/script should still generate dynamic values. Patch only missing browser APIs or fixed state shown by DOM/BOM/state/network logs.
- Pure calculation: all material inputs, ordering, serialization, crypto/hash primitive, encoding, and output placement are explicit and verified against browser vectors. Enter this route only after the user chooses a pure-compute deliverable; otherwise report it as an available route and continue with the supplemented runtime.
- Mixed: split the field into components only when full field evidence and component SHA-256 evidence both exist.

Keep acquisition of browser values outside the pure function. Pass confirmed environment/state values as explicit inputs.

## Environment repair order

When a full trace lacks a built-in object or an inner browser value, do not
immediately ask for another trace. Keep the current Firefox page/profile open
and use its DevTools console or Firefox RDP/BiDi `script.evaluate` to read the
specific object, descriptors, prototype chain, brand, selected members and
Promise fulfillment. Record the result as `browser-console-observed`, compare
it with the local host, and patch the smallest missing surface. Read
`references/environment-repair-playbook.md` for the probe and report shape.

Use a new trace only for missing causality (which call produced the value),
missing request/serialization order, inaccessible Worker/iframe/closure state,
or a bounded VM/raw-transport question. A missing scalar/object value alone is
handled by the open Firefox page first.

The repair loop is:

```text
Firefox object observation
  -> local shape/value diff
  -> native-like minimal host patch
  -> original script runs
  -> same request vector and application response check
  -> fixed-byte diff if it fails
  -> pure calculation if deterministic inputs are explicit
```

A browser patch must preserve the original call order, task timing,
serialization, request routing and unrelated APIs. Add a focused smoke probe,
record rollback scope, and rerun the same vector before calling the patch
reproduced.

## When logs are insufficient

Treat the first `full-chain` directory as a complete candidate, not an automatically disposable discovery pass. Use it directly when it contains the request, value artifacts, script identity, environment contract and response evidence needed for the task. Only when a named gap remains, write a complete `agent-next.json` for a fresh, narrower final trace. Do not merge evidence across directories: the later directory must independently contain every artifact used for its final claim.

After a reproduction passes, export a target-window portable fixture beside the
runner. Include the exact script artifact, request template, minimal environment
contract, causally required JS/DOM/state events, every referenced value artifact,
and a SHA-256 manifest. Run the fixture independently before archiving the full
trace. Runtime code must not search sibling trace directories or depend on an
absolute trace path; an absolute source path may remain only as provenance.
For a standalone deliverable, compile the independently accepted fixture into
the smallest structured runtime module actually consumed by the runner, then
repeat fresh-input/application acceptance. Raw JSONL streams and value-store
directories are build evidence, not production runtime dependencies.

For that final trace, retain `JS mode=boundary` and the full async spool. On the current runtime, a configured script/function/hash identity makes matching calls `object_target_match=true`. The patched Gecko build in this checkout now has a thread-local preview re-entry guard around `JS_GetPropertyById`; targeted `object_depth=1..2` is available for the explicit all-evidence pass, including getter-bearing objects. Keep `object_depth=0` when the selected binary is an unpatched/stock runtime, and retain scalar/primitive/value-store evidence in either case. A narrow `TRACE_DOM_MEMBERS` plus `TRACE_DOM_OBJECT_VALUES=1` remains the lower-noise option for named browser values.

If a tab crashes after a targeted overlay, inspect the pending Firefox Crash Reporter `.extra` file. Repeating `AutoFirefoxTraceJSCall::writeObjectProps -> JS_GetPropertyById -> js::CallGetter -> AutoFirefoxTraceJSCall` frames with `EXC_BAD_ACCESS / KERN_PROTECTION_FAILURE` identify the pre-guard recursion. Finalize the failed trace as incomplete, use `object_depth=0` with an unpatched binary (or rebuild the patched binary), and do not attribute the crash to the number of request target fields unless the field extractor itself appears in the symbolized stack.

Do not ask the user to manually transfer filters. Write visible UI values and long `TRACE_*` variables into `$TRACE_DIR/agent-next.json`, then tell the user to load it from `② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json`. When only an env handoff is needed, write `agent-next.env` in the current Agent working directory (`$PWD/agent-next.env`), report its absolute path, and instruct the user to use `加载 env 文件…`; never hide an Agent-generated env file only in a prior trace directory.

VM/opcode follows only after the final full-chain overlay still lacks required evidence:

```text
full-chain/一轮还原（默认已含值制品） -> VM window -> 局部 opcode -> VM step
```

Narrow one dimension at a time: field location/name, automatically derived script identity, producer evidence, then VM/opcode PC range. The UI and server derive script substring/hash, PC range (`START:END`) and dispatcher PC from `index/target-candidates.json`; do not ask the user to invent internal filter values. The first trace does not need a handoff file: after stop/finalize, write visible UI changes and long next-pass `TRACE_*` variables to `$TRACE_DIR/agent-next.json` and tell the user to click `② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json`. For an env-only handoff, use `$PWD/agent-next.env` and the `加载 env 文件…` picker.

For a first or one-pass trace, instruct `JS mode=boundary`, not `target` or `deep`: those precise modes require at least one loaded script, function, or SHA-256 candidate. An empty target set emits no JS calls by design. The desktop console visibly falls back to `boundary` and logs the reason; report that as a configuration correction, never as missing page activity. Do not promote a static source keyword candidate over a runtime request-field/value match: report roles separately as `request-writer`, `request-sink-frame`, `value-producer`, `internal-algorithm`, or `static-fallback`.

A script SHA alone can still be too broad for a high-frequency SDK. During a
target-values run, inspect event growth before the target action completes. If
the selected script consumes the JS event budget, retain that run only for
function discovery and rerun with `script_sha256 + exact function names`.
Verify the final field SHA against the selected function return; a successful
script match by itself is not producer proof.

## Reference routing

Read these reference files only as needed:

- `references/ui-options.md`: UI controls, defaults, and what they write.
- `references/ui-parameter-catalog.md`: every visible panel control, hidden
  Agent-owned identity, default and gap-to-next-trace mapping.
- `references/log-schema.md`: categorized logs, raw JSONL, indexes, value artifacts.
- `references/workflow.md`: complete Agent workflow from offline review to reproduction.
- `references/evidence-contract.md`: evidence levels, request sink, producer match, A/B, pure contract.
- `references/validation-ladder.md`: fixed-vector diff, native-page injection, protocol replay, dynamic-input and cookie-dependency gates.
- `references/routing.md`: standard JS / JSVM / WASM / mixed route selection.
- `references/runtime.md`: launching the UI, command-line tools, runtime paths.
- `references/browser-runtime.md`: current browser capabilities, contract limits, and replay rules.
- `references/environment-repair-playbook.md`: direct Firefox object probes,
  native-like object shape, fingerprint values and missing-environment reports.
- `references/firefox-startup.md`: stable UI/CLI startup, profiles, paths and
  launch failure recovery.
- `references/report-template.md`: final report format.

## Output format

For analysis tasks, deliver:

```text
1. Trace health
2. Target request and field record
3. Producer candidates with evidence level
4. Script artifacts to inspect
5. Environment/state dependency ledger
6. Pure calculation or supplemented-runtime plan
7. Exact next action or reproduction status
```

For UI/help tasks, explain the relevant option defaults and their tradeoff in user language, then point to the matching log outputs.

## VMP checkpoint protocol: Agent actions and user reminders

Treat VMP as a staged investigation. The Agent owns evidence analysis and chooses the next stage; the user only performs the short browser action and loads values the Agent has explicitly produced. At every VM stage, tell the user exactly which UI preset to select, which boxes to leave checked/unchecked, whether to load `agent-next.env`, what browser action to repeat, and when to stop.

### Gate 0 — decide whether VMP is warranted

Agent reads the request field, producer chain, script identity, `target-candidates.json`, and `wasm-vm` signals first. Remind the user only when there is evidence of an interpreter/VM pattern: encoded instruction/data arrays, a hot loop, opaque dispatch, or a JS opcode cluster. If the target is ordinary JS or WASM, keep the normal route and do not ask for VMP fields.

User reminder template:

```text
现在先不进 opcode/VM。VM/JSVMP 阶段预设选“一轮还原模式（推荐：请求触发回溯）”。
勾选状态：JS opcode 不勾；raw operands 不勾；栈 slot 类型不勾；栈 primitive 值不勾；VM step 不勾；WASM module 元数据按 Agent 要求开/关；WASM 模块 artifact 不勾；WASM raw bytes 不勾；VM/opcode 也不截断不勾。
操作：打开/开始记录后，只执行一次目标动作；目标请求出现后马上点“停止并整理”。不要手填脚本关键词、PC range 或 dispatcher PC。
```

### Gate 1 — target/value pass before opcode

If the first pass found the request field but the JS/value chain is too noisy or missing, write the next target/value handoff before asking the user to run again:

```text
$TRACE_DIR/agent-next.json
$PWD/agent-next.env
```

Prefer `agent-next.json` when any visible UI value changes. It uses schema
`firefox_trace.agent_config.v1` and contains `ui`, `modules`, `options`, `vm`
and `env`, so the user can load every field with one click. Keep
`agent-next.env` as a compatibility file when only environment variables
change. The JSON should contain the Agent-approved `TRACE_PROFILE`,
`TRACE_JS_MODE`, `TRACE_SCRIPT_CONTAINS`, target fields, value capture and
VM-off settings. Prefer script-only narrowing first; add function filters only
when the previous trace proves they are stable.

User reminder template:

```text
我已经把下一轮完整配置写到：$TRACE_DIR/agent-next.json。
UI 操作：在②首轮采集 / 目标字段面板点“加载当前目录 agent-next.json”。
VM/JSVMP 阶段预设仍选“一轮还原模式”。JS opcode、VM step、WASM dump/raw 都不勾。
然后点“应用配置”或重启后“打开 Firefox”；页面准备好后点“开始记录”，只触发同一个目标动作一次，看到目标请求后立刻“停止并整理”。
```

### Gate 2 — local opcode hotspot pass

The tool derives the target script substring from request caller/origin call/value evidence and analyzes `js.opcode` records with `trace_opcode_analyzer.py`. The Agent reviews the exact script identity and candidate `START:END` PC range; the UI/env applies them automatically.

If a hotspot range exists, write or confirm `agent-next.json` with the script identity/PC window and remind the user:

```text
已找到 opcode 热点：SCRIPT_SUBSTRING，PC 范围：START:END。
UI 选择：VM/JSVMP 阶段预设选“局部 opcode：自动候选脚本”。
勾选状态：JS opcode 勾；raw operands 勾；栈 slot 类型先不勾；栈 primitive 值先不勾；VM step 不勾；WASM 相关不勾；VM/opcode 也不截断不勾。
如果我写了 agent-next.json，先加载它。然后执行同一个短目标动作一次；目标请求出现后马上停止整理。
```

If no stable hotspot exists, keep the target/value route and ask for another one-shot action; keep filters in `agent-next.json`, and do not ask the user to invent manual PC values.

### Gate 3 — dispatcher / VM step decision

Agent compares opcode PC, function/script identity, call context and request timing. Only when a native interpreter dispatch loop is evidenced does it report one dispatcher PC. A page-defined virtual PC is not automatically a native dispatcher PC.

If confirmed, write or confirm `agent-next.json` with dispatcher identity and remind the user:

```text
已确认 dispatcher PC：DISPATCH_PC。
UI 选择：VM/JSVMP 阶段预设选“VM step：已确认 dispatcher”。
勾选状态：VM step 勾；JS opcode 按 Agent 提醒开/关；raw operands 按 Agent 提醒开/关；栈 slot 类型/primitive 值只有我要求看 VM 状态时才勾；WASM 相关不勾；VM/opcode 也不截断不勾。
不要自己填写 PC。加载 agent-next.json 后执行同一个短目标动作一次；请求出现后马上停止整理。
```

If not confirmed, stay on `局部 opcode：自动候选脚本`; stack slot/type and primitive capture are follow-up evidence only when the unresolved question is VM state; WASM dump/raw bytes are follow-up evidence only when a WASM module is actually involved.

### Gate 4 — validate and move on

Agent validates `script_sha256`, PC/dispatcher identity, `call_id`, `origin_call_id`, request field SHA-256 and degraded status. Then report one next action only:

- `fixed-byte`: proceed to URL/headers/cookies/body diff;
- `missing-environment`: run a normal browser-environment segment;
- `missing-vm-state`: enable stack slot/type or primitive values for one short action;
- `dynamic`: fixed bytes match, begin dynamic-value generation and live URL response validation.

Always keep JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script modules enabled as context unless the trace is degraded or the Agent identifies a concrete overhead source. VM options are additive, not a replacement for the request and environment evidence.
