# Browser Runtime

The Agent-facing entrypoint is the bundled `tools/run-trace-firefox.sh`. It creates an isolated profile, writes `manifest.json` and `trace-control.json`, applies the selected plan, and starts the headed modified Firefox build.

Set the runtime explicitly when the skill is installed outside this repository:

```bash
export FIREFOX_TRACE_REPO=/absolute/path/to/firefoxTrace
export FIREFOX_TRACE_RUNTIME_ROOT=/absolute/path/to/firefox-trace-runtime
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON=/opt/miniconda3/envs/firefox-trace/bin/python
```

Required checks:

```bash
test -x "$FIREFOX_BIN"
test -x "$FIREFOX_TRACE_PYTHON"
test -x tools/run-trace-firefox.sh
"$FIREFOX_BIN" --version
```

Use a headed browser (`TRACE_HEADLESS=0`) for field analysis. The same Firefox session can receive new segments through `tools/trace-control.sh`; this avoids changing profile state between discovery, producer confirmation, and dependency collection.

For an Agent-started run, verify the headed window/process after launch. After
the watchdog receipt reports stop/finalize, close the Firefox launcher process
group before cleanup; stopping collection alone leaves the browser running.

The packaged runtime directory contains the browser app bundle. The skill package carries the launcher, profile `trace-user.js`, UI, finalizer, analyzer, and validation tools; it does not duplicate the large browser binary.

## Current runtime review

The browser can retain a complete request-field/value/script/DOM-BOM evidence chain,
but an `environment-contract.json` is not automatically a complete offline browser.
Check `coverage.value_capture_complete` and `coverage.object_contract_complete`
before calling a supplemented host reproduced. Large full-chain runs can contain
hundreds of thousands of events and degraded records even when the target field is
present; report those records instead of silently treating the directory as exact.

For replay, bind a candidate to the same script, endpoint, and retained request
vector. Preserve URL/query, headers, cookies, body bytes, serialization order, and
all non-target fields; replace only the target field. Do not invent a downstream
request when its original vector was not captured. A transport-level HTTP 200 is
only a connectivity check; require the endpoint's business response for acceptance.

Fingerprint surfaces are targeted overlays, not a reason to increase global object
depth. Prioritize Canvas/WebGL, Plugin/mimeTypes, TextMetrics, Function#toString,
event order, timing/random, and Promise settlement at the concrete producer call.

## Observation versus execution

Keep passive observation and execution-changing instrumentation separate.
Network, DOM, value and object-identity observers belong in the acceptance run.
Native call depth, global object walks, opcode and VM-step capture can change
timing, recursion depth and task ordering; enable them only in short, isolated
diagnostic windows. A failure seen only with execution-changing probes is an
instrumentation result until reproduced with the acceptance observer set.
Keep experimental Navigator/Window shape patches opt-in and record their byte delta.

Current patched-runtime invariants: page-object preview has a thread-local
getter re-entry guard; Worker events are serialized through the owning trace
thread; raw HTTP `0` means unlimited; internal TextMetrics getter noise is
suppressed; DOM listener/insertion/dispatch records retain object identity; and
Fetch records preserve both logical headers and final channel headers. Verify
these with focused smoke traces after replacing `XUL` and re-signing the full
macOS app bundle.

Firefox `obj/dist` app bundles may contain absolute symlinks into the source
tree. A published runtime must materialize those file links, remove Finder
metadata, and pass `codesign --verify --deep --strict` after signing; otherwise
the apparent app bundle is neither relocatable nor a valid standalone runtime.
