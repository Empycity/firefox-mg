# Firefox Startup And Recovery

Use one launcher path per session. The UI launcher and the command-line
launcher both create an isolated profile and pass the trace control file to
the modified Firefox binary. Do not start a second Firefox manually for the
same run.

## Preferred Agent path

For a known URL or verification task, start the browser directly through the
project launcher. Run this command in the normal macOS process environment,
not inside a restricted child sandbox:

```bash
cd /absolute/path/to/firefoxTrace
TRACE_DIR="/private/tmp/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
PROFILE_DIR="/private/tmp/firefox-trace-profile-$$" \
TRACE_HEADLESS=0 \
FIREFOX_BIN="/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox" \
FIREFOX_TRACE_PYTHON="/opt/miniconda3/envs/firefox-trace/bin/python" \
tools/run-trace-firefox.sh \
  --trace-preset manual \
  --trace-start paused \
  "TARGET_URL"
```

Successful startup means the launcher remains alive, `manifest.json` records
the requested Nightly/profile/URL, and the headed `firefox` GUI process exists.
The modified browser is used for Trace collection, environment repair and live
validation. Final Node runners must not start or depend on Firefox.

## Desktop UI path

From the repository root:

```bash
open "Firefox Trace Console.app"
```

If Finder does not show a window, use the source launcher in the same
repository:

```bash
tools/trace-desktop.sh
```

`Firefox Trace Console.app` can be moved to another folder on this Mac. Its
launcher first uses `FIREFOX_TRACE_ROOT`, then the colocated repository, and
then the standard checkout path `/Users/empycity/Desktop/JS-tools/firefoxTrace`.
If the repository itself is elsewhere, start it from a terminal with:

```bash
FIREFOX_TRACE_ROOT="/path/to/firefoxTrace" open "/path/to/Firefox Trace Console.app"
```

The Nightly runtime is a separate directory. Keeping
`/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime` is the default; when it
is moved, set `FIREFOX_TRACE_RUNTIME_ROOT` before opening the app or select the
new `Contents/MacOS/firefox` in the UI. The runtime app must stay intact as a
whole bundle; move `Nightly.app`, not individual dylibs or `XUL`.

The UI starts Firefox through `tools/run-trace-firefox.sh`. Fill the visible
session fields, choose `active` or `paused`, then use `打开 Firefox`. The
browser window can take a few seconds to initialize; wait for the UI status to
reach `paused` or `recording` before touching the page. The first trace should
use a fresh output directory and a temporary profile unless a session profile
is part of the test.

## Full Trace command

Use the packaged Nightly app executable, not `dist/bin/firefox`. This is the
same backend path used by the desktop console:

```bash
cd /absolute/path/to/firefoxTrace
export FIREFOX_TRACE_REPO="$PWD"
export FIREFOX_TRACE_RUNTIME_ROOT="/absolute/path/to/firefox-trace-runtime"
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON="/opt/miniconda3/envs/firefox-trace/bin/python"

test -x "$FIREFOX_BIN"
test -x "$FIREFOX_TRACE_PYTHON"
"$FIREFOX_BIN" --version

TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
PROFILE_DIR="/private/tmp/firefox-trace-profile-$$" \
TRACE_HEADLESS=0 \
tools/run-trace-firefox.sh \
  --trace-plan full-chain \
  --trace-start paused \
  "TARGET_URL"
```

Use `--trace-start active` when page-load code creates the target value. Use
`paused` when login, navigation or a user action prepares the page first. The
launcher always passes `--new-instance --profile PROFILE_DIR`; this prevents a
different running Firefox profile from receiving the URL or trace settings.

For Agent-started runs, confirm the headed window/process, then close the
launcher process group after watchdog stop/finalize.

## Startup preflight

Before waiting on a slow launch, check the deterministic failure points:

```bash
test -x "$FIREFOX_BIN" || echo "bad FIREFOX_BIN"
"$FIREFOX_BIN" --version
test -x "$FIREFOX_TRACE_PYTHON" || echo "bad FIREFOX_TRACE_PYTHON"
test -x tools/run-trace-firefox.sh
FIREFOX_APP="${FIREFOX_BIN%/Contents/MacOS/firefox}"
codesign --verify --strict "$FIREFOX_APP/Contents/MacOS/XUL"
codesign --verify --strict "$FIREFOX_APP/Contents/MacOS/libgkcodecs.dylib"
spctl --assess --type execute --verbose=2 "$FIREFOX_APP"
```

The launcher writes `manifest.json`, `trace-control.json` and (for the UI)
`ui-launcher.log` under `TRACE_DIR`. Read those files before restarting. A
directory containing `manifest.json` is an existing run; choose a new
directory or explicitly set `reuse_trace=true` for a deliberate segment.
`--version` only checks that the executable can start far enough to print its
version. The repository's development Nightly contains resource symlinks back
to the source/build tree, so `codesign --verify --deep --strict` on the whole
bundle can report those links even after the code pages are correctly signed.
The preflight therefore checks the mapped `XUL`/dylib code pages and `spctl`
acceptance, followed by a real headed launch smoke test when a prior run
reported `Invalid Page`.

## Common startup failures

| Symptom | Check | Recovery |
|---|---|---|
| `Couldn't load XPCOM` | Binary path points at `dist/bin/firefox` or an incomplete build. | Select `gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/firefox` or the packaged runtime Nightly executable. |
| `Code Signature Invalid` / `Invalid Page` on launch | A mapped code page was copied after signing, or the runtime was only partially installed. | Run `tools/install-trace-runtime.sh` (pass the built `XUL` path when needed), then verify `XUL`/`libgkcodecs.dylib` and launch once. Do not change the page profile to hide it. |
| UI opens but no Firefox window | `TRACE_HEADLESS` may be `1`, an old session may still own the profile, or the launcher exited early. | Set `TRACE_HEADLESS=0`, inspect `ui-launcher.log`, close the old UI session, and use a new temporary profile. |
| Launch reports an existing `manifest.json` | The output directory is from a previous run. | Create a new timestamp directory; reuse only for an intentional same-profile segment. |
| Python environment error | `FIREFOX_TRACE_PYTHON` is missing or not executable. | Point it at the project trace Python or use the interpreter shown by the launcher error. |
| Browser is alive but page appears frozen | Full value/object/VM capture is too wide or the page is still loading. | Stop the run, start a fresh directory with `full-chain + boundary`, VM/WASM/Raw HTTP off, and use `paused` if preparation is needed. |
| RDP/BiDi console cannot connect | The session was not launched with an external debugging endpoint. | Use the visible Firefox DevTools console for the direct object probe, or relaunch through the configured Firefox debugging/MCP entrypoint. A missing console endpoint does not justify a new full trace. |

Do not repeatedly double-click the app while a launcher process is alive. One
Firefox session, one profile and one `TRACE_DIR` make startup errors
diagnosable.

## Direct object lookup without another Trace

When the page is already open, keep this Firefox process and profile. Use the
visible DevTools console or the configured Firefox RDP/BiDi `script.evaluate`
endpoint to run the expression from
`references/environment-repair-playbook.md`. This reads the browser's real
object, descriptor, prototype and value in place; it does not restart Firefox
or create another trace directory.

Record the browser build, page URL, profile and expression hash beside the
observation. Use the value to patch the local host, then validate the same
request vector. Only reopen Firefox when the page/profile is gone, the missing
state is inside an inaccessible Worker/iframe/closure, or a new causal trace
is specifically required.
