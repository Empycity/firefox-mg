#!/bin/zsh
set -euo pipefail

# Install a locally built XUL into the desktop runtime.  On macOS every code
# page is checked while Firefox bootstraps; copying XUL without re-signing the
# bundle is rejected as CODESIGNING / Invalid Page before trace code runs.
ROOT="${0:A:h:h}"
find_default_xul() {
  local path
  for path in "$ROOT"/gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/XUL; do
    [[ -f "$path" ]] && { print -r -- "$path"; return 0; }
  done
  return 1
}

SOURCE_XUL="${1:-$(find_default_xul || true)}"
RUNTIME_APP="${FIREFOX_TRACE_RUNTIME_APP:-$ROOT/firefox-trace-runtime/Nightly.app}"
TARGET_XUL="$RUNTIME_APP/Contents/MacOS/XUL"
SOURCE_APP="${SOURCE_XUL%/Contents/MacOS/XUL}"
SOURCE_APPLICATION_INI="$SOURCE_APP/Contents/Resources/application.ini"
TARGET_APPLICATION_INI="$RUNTIME_APP/Contents/Resources/application.ini"
TARGET_BROWSER_APPLICATION_INI="$RUNTIME_APP/Contents/Resources/browser/application.ini"

[[ -f "$SOURCE_XUL" ]] || { print -u2 "Missing built XUL: $SOURCE_XUL"; exit 2; }
if [[ ! -d "$RUNTIME_APP" ]]; then
  mkdir -p "${RUNTIME_APP:h}"
  ditto "$SOURCE_APP" "$RUNTIME_APP"
fi
[[ -d "$RUNTIME_APP/Contents/MacOS" ]] || {
  print -u2 "Invalid runtime app bundle: $RUNTIME_APP"
  exit 2
}

# obj/dist app bundles contain absolute symlinks back into the source/build
# tree. Materialize file links before installing files so the copies below
# never write through a link into the build tree, the packaged runtime remains
# relocatable, and codesign does not reject destinations outside the bundle.
while IFS= read -r -d '' link; do
  temp="${link}.trace-materialize.$$"
  cp -pL "$link" "$temp"
  rm "$link"
  mv "$temp" "$link"
done < <(find "$RUNTIME_APP" -type l -print0)
find "$RUNTIME_APP" -type f -name .DS_Store -delete

cp "$SOURCE_XUL" "$TARGET_XUL"
cmp -s "$SOURCE_XUL" "$TARGET_XUL" || {
  print -u2 "Installed XUL differs before signing: $TARGET_XUL"
  exit 3
}
SOURCE_SHA256="$(shasum -a 256 "$SOURCE_XUL" | awk '{print $1}')"
print "Verified pre-sign XUL SHA-256: $SOURCE_SHA256"

# Keep the runtime's version and BuildID metadata aligned with the XUL build.
# The launcher derives its isolated FirefoxTrace application identity from this
# file, so stale metadata can otherwise make the -app bootstrap fail.
if [[ -f "$SOURCE_APPLICATION_INI" ]]; then
  cp "$SOURCE_APPLICATION_INI" "$TARGET_APPLICATION_INI"
  cmp -s "$SOURCE_APPLICATION_INI" "$TARGET_APPLICATION_INI" || {
    print -u2 "Installed application.ini differs before signing: $TARGET_APPLICATION_INI"
    exit 3
  }

  # macOS 27 can deny a locally modified Nightly access to the stock
  # ~/Library/Application Support/Firefox registry before --profile is parsed.
  # A browser-local -app manifest gives the trace build its own FirefoxTrace
  # registry without changing the explicit per-run PROFILE_DIR.
  /usr/bin/python3 - "$SOURCE_APPLICATION_INI" "$TARGET_BROWSER_APPLICATION_INI" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
text = source.read_text(encoding="utf-8")

def set_app_value(data: str, key: str, value: str) -> str:
    app_start = data.index("[App]")
    next_section = data.find("\n[", app_start + 1)
    if next_section < 0:
        next_section = len(data)
    section = data[app_start:next_section]
    pattern = re.compile(rf"(?m)^{re.escape(key)}=.*$")
    if pattern.search(section):
        section = pattern.sub(f"{key}={value}", section, count=1)
    else:
        section = section.rstrip("\n") + f"\n{key}={value}\n"
    return data[:app_start] + section + data[next_section:]

for key, value in (
    ("Profile", "FirefoxTrace"),
    ("RemotingName", "firefox-trace"),
    ("CodeName", "FirefoxTrace"),
    ("ID", "local.firefox-trace.runtime"),
):
    text = set_app_value(text, key, value)

text = re.sub(r"(?m)^EnableProfileMigrator=.*$", "EnableProfileMigrator=0", text)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding="utf-8")
PY
fi

codesign --force --deep --sign - "$RUNTIME_APP"
codesign --verify --strict "$TARGET_XUL"
codesign --verify --strict "$RUNTIME_APP/Contents/MacOS/libgkcodecs.dylib"
codesign --verify --deep --strict "$RUNTIME_APP"
spctl --assess --type execute --verbose=2 "$RUNTIME_APP"
"$RUNTIME_APP/Contents/MacOS/firefox" --version
print "Installed and ad-hoc signed: $RUNTIME_APP"
