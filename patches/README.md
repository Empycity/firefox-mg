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
