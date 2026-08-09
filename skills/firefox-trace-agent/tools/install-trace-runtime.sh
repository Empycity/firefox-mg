#!/bin/zsh
set -euo pipefail

# Install a locally built XUL into the desktop runtime.  On macOS every code
# page is checked while Firefox bootstraps; copying XUL without re-signing the
# bundle is rejected as CODESIGNING / Invalid Page before trace code runs.
ROOT="${0:A:h:h}"
SOURCE_XUL="${1:-$ROOT/gecko-dev/obj-aarch64-apple-darwin25.6.0/dist/Nightly.app/Contents/MacOS/XUL}"
RUNTIME_APP="${FIREFOX_TRACE_RUNTIME_APP:-/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app}"
TARGET_XUL="$RUNTIME_APP/Contents/MacOS/XUL"

[[ -f "$SOURCE_XUL" ]] || { print -u2 "Missing built XUL: $SOURCE_XUL"; exit 2; }
[[ -d "$RUNTIME_APP" ]] || { print -u2 "Missing runtime app: $RUNTIME_APP"; exit 2; }

cp "$SOURCE_XUL" "$TARGET_XUL"

# obj/dist app bundles contain absolute symlinks back into the source/build
# tree. Materialize file links so the packaged runtime remains relocatable and
# codesign does not reject destinations outside the bundle.
while IFS= read -r -d '' link; do
  temp="${link}.trace-materialize.$$"
  cp -pL "$link" "$temp"
  rm "$link"
  mv "$temp" "$link"
done < <(find "$RUNTIME_APP" -type l -print0)
find "$RUNTIME_APP" -type f -name .DS_Store -delete

codesign --force --deep --sign - "$RUNTIME_APP"
codesign --verify --strict "$TARGET_XUL"
codesign --verify --strict "$RUNTIME_APP/Contents/MacOS/libgkcodecs.dylib"
codesign --verify --deep --strict "$RUNTIME_APP"
spctl --assess --type execute --verbose=2 "$RUNTIME_APP"
"$RUNTIME_APP/Contents/MacOS/firefox" --version
print "Installed and ad-hoc signed: $RUNTIME_APP"
