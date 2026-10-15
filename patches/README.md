# Gecko patch package

This repository intentionally does not include the full `gecko-dev` checkout.
The browser modifications are stored as a patch against the Gecko commit in
`gecko-base-commit.txt`.

Apply flow:

```bash
git clone https://github.com/mozilla/gecko-dev.git
cd gecko-dev
git checkout "$(cat ../patches/gecko-base-commit.txt)"
git apply --index ../patches/gecko-firefox-trace.patch
```

For a fresh device, follow the full [build and deployment manual](../BUILD.md).
The repeatable bootstrap entrypoint performs checkout and patch application:

```bash
tools/bootstrap-trace.sh --prepare
tools/bootstrap-trace.sh --build
tools/bootstrap-trace.sh --install
```

Set `GECKO_DIR`, `MOZBUILD_STATE_PATH`, and `FIREFOX_TRACE_RUNTIME_APP` when
using a different checkout or runtime location. The script is idempotent for
an already-applied patch and stops when the Gecko checkout has local changes.
The build requires the platform's Mozilla build prerequisites and a local
`.mozconfig`; the `.mozconfig` is intentionally not shared because compiler
and SDK paths vary by machine. `--install` packages the build into a fresh
runtime app bundle and signs it locally; the desktop install helper targets
macOS.

The patch includes current Firefox Trace changes in Gecko source files. Runtime
helpers, docs, smoke pages, and launch scripts live directly in this repository.

Build flow used on macOS:

```bash
cd gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

The local `.mozconfig` used during development is machine-specific because it
contains an absolute `CBINDGEN` path. Keep that local unless you replace paths
with your own environment.
