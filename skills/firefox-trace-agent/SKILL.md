---
name: firefox-trace-reverse
description: Use this skill whenever the user provides a Firefox Trace TRACE_DIR, asks to analyze browser trace logs, locate a generated request field, explain the UI options/defaults, plan another trace run, reconstruct browser environment, extract a pure JS calculation, inspect WebSocket/WASM/JSVM evidence, or turn Firefox Trace evidence into a reproduction contract. It guides Codex through the bundled tools, categorized logs, causal indexes, and environment-vs-pure-computation workflow.
---

# Firefox Trace Agent

This skill turns a Firefox Trace output directory into an evidence-led analysis. Prefer offline analysis of the supplied `TRACE_DIR` first; start or control Firefox only when the logs show a concrete missing link.

## Inputs

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

3. Read `index/summary.json` and `index/causal-index.json`.
4. Read `categorized/request-fields.jsonl`, then `categorized/network.jsonl`, then `categorized/js.jsonl`.
5. Only after the request and candidate producer are understood, read scripts/state/dom/bom/wasm-vm as needed.

## Evidence workflow

Follow this sequence:

```text
TRACE_DIR health
  -> request field / request sink across query/body/headers/cookies
  -> URL / headers / body byte-level diff reproduction with fixed inputs
  -> JS value / producer candidates
  -> script artifact and source map
  -> state + DOM/BOM environment ledger
  -> dynamic-input model after fixed bytes match
  -> live request validation against the user-provided URL
```

Use `value_store_path` and SHA-256 alignment as the main bridge between request fields and JS values. `origin_call_id` gives request context; `call_id` and `parent_call_id` give local call graph context. Keep all three together in reports. For reproduction, first make the fixed URL, headers, cookies and body bytes match the trace vector; then model dynamic values and validate by actually requesting the user-provided URL.

## Evidence levels

- `candidate`: plausible request/script/function lead.
- `correlated`: same `origin_call_id`, compatible timing, or shared script identity.
- `matched`: request field raw/decoded/segment SHA-256 equals a JS value SHA-256 or exact artifact value.
- `confirmed`: a single-variable A/B run proves an environment/state input changes the producer/output.
- `reproduced`: local pure calculation or supplemented browser runtime matches retained browser vectors.

Treat `trace.degraded`, incomplete boundary windows, missing ACK, or missing value artifacts as candidate-only for the affected claim.

## Environment vs pure calculation

Use this split:

- Supplemented environment: the original page SDK/script should still generate dynamic values. Patch only missing browser APIs or fixed state shown by DOM/BOM/state/network logs.
- Pure calculation: all material inputs, ordering, serialization, crypto/hash primitive, encoding, and output placement are explicit and verified against browser vectors.
- Mixed: split the field into components only when full field evidence and component SHA-256 evidence both exist.

Keep acquisition of browser values outside the pure function. Pass confirmed environment/state values as explicit inputs.

## When logs are insufficient

Prefer another segment in the same Firefox session:

```text
discover-light/full-chain -> target-values -> deep-causal -> opcode-window
```

Narrow one dimension at a time: field location/name, automatically derived script identity, producer evidence, then VM/opcode PC range. The UI and server derive script substring/hash, PC range (`START:END`) and dispatcher PC from `index/target-candidates.json`; do not ask the user to invent internal filter values.

## Reference routing

Read these reference files only as needed:

- `references/ui-options.md`: UI controls, defaults, and what they write.
- `references/log-schema.md`: categorized logs, raw JSONL, indexes, value artifacts.
- `references/workflow.md`: complete Agent workflow from offline review to reproduction.
- `references/evidence-contract.md`: evidence levels, request sink, producer match, A/B, pure contract.
- `references/routing.md`: standard JS / JSVM / WASM / mixed route selection.
- `references/runtime.md`: launching the UI, command-line tools, runtime paths.
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

Treat VMP as a staged investigation. The Agent owns evidence analysis and chooses the next stage; the user only performs the short browser action and fills values the Agent has explicitly produced.

### Gate 0 — decide whether VMP is warranted

Agent reads the request field, producer chain, script identity and `wasm-vm` signals first. Remind the user only when there is evidence of an interpreter/VM pattern: encoded instruction/data arrays, a hot loop, opaque dispatch, or a JS opcode cluster. If the target is ordinary JS or WASM, keep the normal route and do not ask for VMP fields.

User reminder:

```text
先保持默认模块不动；如果确认是 JSVMP，请选择“JSVMP 第1轮：自动定位（先全链路）”，不填写目标脚本关键词、PC range 或 dispatcher PC，执行一次短目标动作。
```

### Gate 1 — opcode hotspot pass

The tool derives the target script substring from request caller/origin call/value evidence and analyzes `js.opcode` records with `trace_opcode_analyzer.py`. The Agent reviews the exact script identity and candidate `START:END` PC range; the UI applies them automatically.

If a hotspot range exists, remind the user:

```text
第一轮已找到 opcode 热点：SCRIPT_SUBSTRING，PC 范围：START:END。请选择“JSVMP 第2轮：自动套用 PC 窄采”，不回填内部参数，再执行一次相同动作。
```

If no stable hotspot exists, remind the user to repeat the same short action; keep the automatically derived script identity and expose no manual filter field.

### Gate 2 — dispatcher decision

Agent compares opcode PC, function/script identity, call context and request timing. Only when a native interpreter dispatch loop is evidenced does it report one dispatcher PC. A page-defined virtual PC is not automatically a native dispatcher PC.

If confirmed, remind the user:

```text
已确认 dispatcher PC：DISPATCH_PC。请选择“JSVMP 第3轮：自动套用 dispatcher”，工具自动保持脚本与 PC identity 并开启 VM step，执行一次短目标动作。
```

If not confirmed, keep the opcode-window route and ask for no VM step. Stack slot/type and primitive capture are follow-up evidence only when the unresolved question is VM state; WASM dump/raw bytes are follow-up evidence only when a WASM module is actually involved.

### Gate 3 — validate and move on

Agent validates `script_sha256`, PC/dispatcher identity, `call_id`, `origin_call_id`, request field SHA-256 and degraded status. Then report one next action only:

- `fixed-byte`: proceed to URL/headers/cookies/body diff;
- `missing-environment`: run a normal browser-environment segment;
- `missing-vm-state`: enable stack slot/type or primitive values for one short action;
- `dynamic`: fixed bytes match, begin dynamic-value generation and live URL response validation.

Always keep JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script modules enabled as context unless the trace is degraded or the Agent identifies a concrete overhead source. VM options are additive, not a replacement for the request and environment evidence.
