#!/usr/bin/env bash
set -euo pipefail

# Prepare a reproducible Gecko checkout from the patch package. Building is
# opt-in because a Gecko build can take substantial disk space and time.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GECKO_DIR="${GECKO_DIR:-$ROOT_DIR/gecko-dev}"
GECKO_REPO="${GECKO_REPO:-https://github.com/mozilla/gecko-dev.git}"
BASE_COMMIT="$(tr -d '[:space:]' < "$ROOT_DIR/patches/gecko-base-commit.txt")"
PATCH_FILE="$ROOT_DIR/patches/gecko-firefox-trace.patch"

usage() {
  cat <<'EOF'
Usage:
  tools/bootstrap-trace.sh [--prepare] [--build] [--install]

Environment:
  GECKO_DIR                 Gecko checkout (default: ./gecko-dev)
  GECKO_REPO                Gecko git URL
  MOZBUILD_STATE_PATH       mach state directory (default: ./.mozbuild)
  FIREFOX_TRACE_RUNTIME_APP install destination for --install

The script checks out patches/gecko-base-commit.txt and applies the tracked
patch with git apply --index. It never resets an existing checkout.
EOF
}

prepare=0
build=0
install=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare) prepare=1; shift ;;
    --build) build=1; prepare=1; shift ;;
    --install) install=1; build=1; prepare=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if (( ! prepare )); then prepare=1; fi

if [[ ! -d "$GECKO_DIR/.git" ]]; then
  command -v git >/dev/null || { echo "git is required" >&2; exit 2; }
  git clone "$GECKO_REPO" "$GECKO_DIR"
fi
patch_applied=0
if git -C "$GECKO_DIR" apply --reverse --check "$PATCH_FILE"; then
  patch_applied=1
  echo "Patch already applied; keeping the existing index."
else
  if [[ -n "$(git -C "$GECKO_DIR" status --porcelain)" ]]; then
    echo "Gecko checkout has local changes; commit or stash them before bootstrap: $GECKO_DIR" >&2
    exit 3
  fi
  if [[ ! -f "$GECKO_DIR/.git/shallow" ]]; then
    git -C "$GECKO_DIR" fetch --all --tags --quiet
  fi
  git -C "$GECKO_DIR" checkout "$BASE_COMMIT"
  if git -C "$GECKO_DIR" apply --check "$PATCH_FILE"; then
    git -C "$GECKO_DIR" apply --index "$PATCH_FILE"
  else
    echo "Patch does not apply cleanly to $BASE_COMMIT." >&2
    exit 3
  fi
fi

if (( build )); then
  : "${MOZBUILD_STATE_PATH:=$ROOT_DIR/.mozbuild}"
  export MOZBUILD_STATE_PATH
  export MACH_TELEMETRY_DISABLED="${MACH_TELEMETRY_DISABLED:-1}"
  (cd "$GECKO_DIR" && python3 ./mach build)
fi
if (( install )); then
  FIREFOX_TRACE_RUNTIME_APP="${FIREFOX_TRACE_RUNTIME_APP:-$ROOT_DIR/firefox-trace-runtime/Nightly.app}" \
    "$ROOT_DIR/tools/install-trace-runtime.sh" "$GECKO_DIR"/obj-*/dist/Nightly.app/Contents/MacOS/XUL
fi
printf 'Prepared Gecko at %s\nBase commit: %s\nPatch: %s\n' "$GECKO_DIR" "$BASE_COMMIT" "$PATCH_FILE"
