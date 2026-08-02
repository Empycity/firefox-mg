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

The packaged runtime directory contains the browser app bundle. The skill package carries the launcher, profile `trace-user.js`, UI, finalizer, analyzer, and validation tools; it does not duplicate the large browser binary.
