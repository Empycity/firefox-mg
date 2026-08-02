# Bundled Firefox Trace Tools

These are a delivery snapshot of the generic tools used by `firefox-trace-agent`.

Set runtime locations before use:

```bash
export FIREFOX_TRACE_REPO=/absolute/path/to/firefoxTrace
export FIREFOX_TRACE_RUNTIME_ROOT=/absolute/path/to/firefox-trace-runtime
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON=${FIREFOX_TRACE_PYTHON:-/opt/miniconda3/envs/firefox-trace/bin/python}
```

The bundled launcher uses the copied `profiles/trace-user.js` and the configured `FIREFOX_BIN`. The browser binary is intentionally external so the skill package remains small and can follow a selected Firefox build.

Offline tools work without Firefox:

```bash
python3 tools/trace_finalize.py TRACE_DIR --json
python3 tools/trace_analyzer.py TRACE_DIR --preset generic --json
python3 tools/trace_check.py --help
python3 tools/trace_store.py --help
```
