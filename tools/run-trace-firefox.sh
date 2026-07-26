#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIREFOX_BIN="${FIREFOX_BIN:-$ROOT_DIR/gecko-dev/obj-aarch64-apple-darwin25.5.0/dist/Nightly.app/Contents/MacOS/firefox}"
TRACE_DIR="${TRACE_DIR:-/private/tmp/firefox-trace-$(date +%s)}"
PROFILE_DIR="${PROFILE_DIR:-/private/tmp/firefox-trace-profile-$(date +%s)}"
TRACE_USER_JS="${TRACE_USER_JS:-$ROOT_DIR/profiles/trace-user.js}"
TRACE_APPLY_USER_JS="${TRACE_APPLY_USER_JS:-1}"
TRACE_HEADLESS="${TRACE_HEADLESS:-0}"
TRACE_PRESET="${TRACE_PRESET:-}"
TRACE_CAMPAIGN_ID="${TRACE_CAMPAIGN_ID:-campaign-$(date +%Y%m%d-%H%M%S)}"
TRACE_RUN_LABEL="${TRACE_RUN_LABEL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trace-preset)
      TRACE_PRESET="${2:-}"
      shift 2
      ;;
    --trace-preset=*)
      TRACE_PRESET="${1#--trace-preset=}"
      shift
      ;;
    --trace-run-label)
      TRACE_RUN_LABEL="${2:-}"
      shift 2
      ;;
    --trace-run-label=*)
      TRACE_RUN_LABEL="${1#--trace-run-label=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

set_default() {
  local name="$1"
  local value="$2"
  if [[ -z "${!name:-}" ]]; then
    export "$name=$value"
  fi
}

apply_trace_preset() {
  case "$TRACE_PRESET" in
    ""|"manual")
      ;;
    "discover-light")
      set_default TRACE_PROFILE discover
      set_default TRACE_JS_MODE boundary
      set_default TRACE_JS_CAPTURE_VALUES 0
      set_default TRACE_JS_BOUNDARY_BUFFER 1
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS 8192
      set_default TRACE_REQUEST_URL preview
      set_default TRACE_QUERY_FIELD_VALUES preview
      set_default TRACE_QUERY_FIELD_VALUE_STORE 1
      set_default TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES 64
      set_default FIREFOX_TRACE_DOM 1
      set_default TRACE_DOM_MODE signal
      set_default TRACE_DOM_EVENTS get,call
      set_default TRACE_DOM_PREVIEW none
      set_default FIREFOX_TRACE_XHR 1
      set_default TRACE_XHR_EVENTS open,send,response
      set_default TRACE_XHR_PREVIEW none
      set_default FIREFOX_TRACE_FETCH 1
      set_default TRACE_FETCH_EVENTS all
      set_default FIREFOX_TRACE_STORAGE 1
      set_default FIREFOX_TRACE_COOKIE 1
      set_default TRACE_SCRIPT_RESOURCE 1
      ;;
    "target-return")
      set_default TRACE_PROFILE target
      set_default TRACE_JS_MODE target
      set_default TRACE_TARGET_MATCH all
      set_default TRACE_JS_EARLY_SCRIPT_FILTER 1
      set_default TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS 1
      set_default TRACE_JS_CAPTURE_VALUES 1
      set_default TRACE_JS_THIS none
      set_default TRACE_JS_ARGS none
      set_default TRACE_JS_RET preview
      set_default TRACE_JS_OBJECT_DEPTH 1
      set_default TRACE_JS_OBJECT_KEYS 32
      set_default TRACE_JS_VALUE_STORE 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_REQUEST_URL preview
      set_default TRACE_QUERY_FIELD_VALUES preview
      set_default TRACE_QUERY_FIELD_VALUE_STORE 1
      set_default TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES 64
      set_default FIREFOX_TRACE_DOM 1
      set_default TRACE_DOM_MODE signal
      set_default TRACE_DOM_EVENTS get,call
      set_default TRACE_DOM_PREVIEW none
      set_default FIREFOX_TRACE_XHR 1
      set_default TRACE_XHR_EVENTS open,send,response
      set_default TRACE_XHR_PREVIEW none
      set_default FIREFOX_TRACE_FETCH 1
      set_default TRACE_FETCH_EVENTS all
      set_default FIREFOX_TRACE_STORAGE 1
      set_default FIREFOX_TRACE_COOKIE 1
      set_default TRACE_SCRIPT_RESOURCE 1
      ;;
    "target-values")
      set_default TRACE_PROFILE target
      set_default TRACE_JS_MODE target
      set_default TRACE_TARGET_MATCH all
      set_default TRACE_JS_EARLY_SCRIPT_FILTER 1
      set_default TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS 1
      set_default TRACE_JS_CAPTURE_VALUES 1
      set_default TRACE_JS_THIS none
      set_default TRACE_JS_ARGS preview
      set_default TRACE_JS_RET preview
      set_default TRACE_JS_OBJECT_DEPTH 2
      set_default TRACE_JS_OBJECT_KEYS 64
      set_default TRACE_JS_VALUE_STORE 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_REQUEST_URL preview
      set_default TRACE_QUERY_FIELD_VALUES preview
      set_default TRACE_QUERY_FIELD_VALUE_STORE 1
      set_default TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES 64
      set_default FIREFOX_TRACE_DOM 1
      set_default TRACE_DOM_MODE signal
      set_default TRACE_DOM_EVENTS get,call
      set_default TRACE_DOM_PREVIEW none
      set_default FIREFOX_TRACE_XHR 1
      set_default TRACE_XHR_EVENTS open,send,response
      set_default TRACE_XHR_PREVIEW none
      set_default FIREFOX_TRACE_FETCH 1
      set_default TRACE_FETCH_EVENTS all
      set_default FIREFOX_TRACE_STORAGE 1
      set_default FIREFOX_TRACE_COOKIE 1
      set_default TRACE_SCRIPT_RESOURCE 1
      ;;
    "deep-causal")
      set_default TRACE_PROFILE deep
      set_default TRACE_JS_MODE deep
      set_default TRACE_TARGET_MATCH all
      set_default TRACE_JS_EARLY_SCRIPT_FILTER 1
      set_default TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS 0
      set_default TRACE_JS_CAPTURE_VALUES 1
      set_default TRACE_JS_THIS none
      set_default TRACE_JS_ARGS preview
      set_default TRACE_JS_RET preview
      set_default TRACE_JS_OBJECT_DEPTH 1
      set_default TRACE_JS_OBJECT_KEYS 32
      set_default TRACE_JS_VALUE_STORE 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default TRACE_JS_DEEP_NATIVE 0
      set_default TRACE_JS_DEEP_SELFHOSTED 0
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_REQUEST_URL preview
      set_default TRACE_QUERY_FIELD_VALUES preview
      set_default TRACE_QUERY_FIELD_VALUE_STORE 1
      set_default TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES 64
      set_default FIREFOX_TRACE_DOM 1
      set_default TRACE_DOM_MODE signal
      set_default TRACE_DOM_EVENTS get,call
      set_default TRACE_DOM_PREVIEW none
      set_default TRACE_SCRIPT_RESOURCE 1
      ;;
    "opcode-window")
      set_default TRACE_PROFILE vm
      set_default TRACE_JS_MODE target
      set_default TRACE_EXECUTION_MODE opcode
      set_default TRACE_OPCODE 1
      set_default TRACE_JS_CAPTURE_VALUES 0
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 100000
      ;;
    *)
      echo "Unknown TRACE_PRESET: $TRACE_PRESET" >&2
      echo "Known presets: discover-light, target-return, target-values, deep-causal, opcode-window, manual" >&2
      exit 2
      ;;
  esac
}

mkdir -p "$TRACE_DIR" "$PROFILE_DIR"

if [[ "$TRACE_APPLY_USER_JS" != "0" ]]; then
  cp "$TRACE_USER_JS" "$PROFILE_DIR/user.js"
fi

apply_trace_preset

export FIREFOX_TRACE_ENABLE="${FIREFOX_TRACE_ENABLE:-1}"
export FIREFOX_TRACE_LOG_DIR="${FIREFOX_TRACE_LOG_DIR:-$TRACE_DIR}"
export TRACE_CAMPAIGN_ID
export TRACE_PRESET

write_manifest() {
  local manifest_path="$TRACE_DIR/manifest.json"
  local target_url="${1:-}"
  if command -v python3 >/dev/null 2>&1; then
    TRACE_MANIFEST_PATH="$manifest_path" \
    TRACE_TARGET_URL_FOR_MANIFEST="$target_url" \
    TRACE_RUN_LABEL_FOR_MANIFEST="$TRACE_RUN_LABEL" \
    FIREFOX_BIN_FOR_MANIFEST="$FIREFOX_BIN" \
    PROFILE_DIR_FOR_MANIFEST="$PROFILE_DIR" \
    TRACE_USER_JS_FOR_MANIFEST="$TRACE_USER_JS" \
    python3 - <<'PY'
import json, os, time

keys = [
    "TRACE_CAMPAIGN_ID", "TRACE_PRESET", "TRACE_PROFILE", "TRACE_JS_MODE",
    "TRACE_SCRIPT_CONTAINS", "TRACE_FUNCTION_CONTAINS", "TRACE_SCRIPT_SHA256",
    "TRACE_TARGET_MATCH", "TRACE_JS_EARLY_SCRIPT_FILTER",
    "TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS", "TRACE_JS_CAPTURE_VALUES",
    "TRACE_JS_THIS", "TRACE_JS_ARGS", "TRACE_JS_RET", "TRACE_JS_OBJECT_DEPTH",
    "TRACE_JS_OBJECT_KEYS", "TRACE_JS_OBJECT_VALUE_KEYS", "TRACE_JS_VALUE_STORE",
    "TRACE_JS_DEEP_LONG_STR", "TRACE_JS_DEEP_NATIVE",
    "TRACE_JS_DEEP_SELFHOSTED", "TRACE_JS_DEEP_SUPPRESS_FUNCTIONS",
    "TRACE_REQUEST_URL", "TRACE_QUERY_FIELDS",
    "TRACE_QUERY_FIELD_VALUES", "TRACE_QUERY_FIELD_VALUE_STORE",
    "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES",
    "TRACE_FETCH_RESPONSE_BODY", "TRACE_FETCH_BODY", "TRACE_NETWORK_BODY",
    "TRACE_FETCH_RESPONSE_BODY_MAX_BYTES",
    "TRACE_FETCH_RESPONSE_BODY_HEX_BYTES",
    "TRACE_FETCH_RESPONSE_BODY_STORE",
    "TRACE_FETCH_RESPONSE_BODY_CHUNK_EVENTS", "TRACE_DOM_MODE",
    "TRACE_FETCH_REQUEST_BODY", "TRACE_FETCH_REQUEST_BODY_MAX_BYTES",
    "TRACE_FETCH_REQUEST_BODY_HEX_BYTES", "TRACE_FETCH_REQUEST_BODY_STORE",
    "TRACE_FETCH_RESPONSE_HEADERS", "TRACE_FETCH_RESPONSE_HEADER_NAMES",
    "TRACE_FETCH_RESPONSE_HEADERS_MAX_COUNT",
    "TRACE_FETCH_RESPONSE_HEADER_VALUE_MAX_BYTES",
    "TRACE_XHR_REQUEST_BODY", "TRACE_XHR_REQUEST_BODY_MAX_BYTES",
    "TRACE_XHR_REQUEST_BODY_HEX_BYTES", "TRACE_XHR_REQUEST_BODY_STORE",
    "TRACE_DOM_EVENTS", "TRACE_DOM_PREVIEW", "TRACE_DOM_HOT_MEMBER_LIMIT",
    "TRACE_DOM_HOT_MEMBER_SAMPLE", "TRACE_XHR_EVENTS", "TRACE_XHR_PREVIEW",
    "TRACE_SCRIPT_RESOURCE", "TRACE_SCRIPT_RESOURCE_CAPTURE",
    "TRACE_SCRIPT_RESOURCE_STORE", "TRACE_SCRIPT_RESOURCE_MAX_BYTES",
    "TRACE_SCRIPT_RESOURCE_PREVIEW_LIMIT", "TRACE_SCRIPT_RESOURCE_HEADERS",
    "TRACE_SCRIPT_RESOURCE_FILTER", "TRACE_SCRIPT_RESOURCE_HEADER_NAMES",
    "TRACE_FETCH_EVENTS", "TRACE_EXECUTION_MODE", "TRACE_OPCODE",
    "TRACE_OPCODE_SCRIPT_CONTAINS", "TRACE_OPCODE_PC_RANGE",
    "FIREFOX_TRACE_ENABLE", "FIREFOX_TRACE_LOG_DIR", "FIREFOX_TRACE_DOM",
    "FIREFOX_TRACE_XHR", "FIREFOX_TRACE_FETCH", "FIREFOX_TRACE_STORAGE",
    "FIREFOX_TRACE_COOKIE", "FIREFOX_TRACE_JS_LIMIT_EVENTS",
    "FIREFOX_TRACE_PREVIEW_LIMIT",
]

manifest = {
    "schema": "firefox_trace.manifest.v1",
    "created_at_unix": int(time.time()),
    "campaign_id": os.environ.get("TRACE_CAMPAIGN_ID", ""),
    "preset": os.environ.get("TRACE_PRESET", ""),
    "run_label": os.environ.get("TRACE_RUN_LABEL_FOR_MANIFEST", ""),
    "target_url": os.environ.get("TRACE_TARGET_URL_FOR_MANIFEST", ""),
    "trace_dir": os.environ.get("FIREFOX_TRACE_LOG_DIR", ""),
    "profile_dir": os.environ.get("PROFILE_DIR_FOR_MANIFEST", ""),
    "firefox_bin": os.environ.get("FIREFOX_BIN_FOR_MANIFEST", ""),
    "trace_user_js": os.environ.get("TRACE_USER_JS_FOR_MANIFEST", ""),
    "headless": os.environ.get("TRACE_HEADLESS", "0") == "1",
    "env": {k: os.environ[k] for k in keys if k in os.environ and os.environ[k] != ""},
    "notes": [
        "Presets set defaults only; explicit environment variables override them.",
        "A degraded event means the run is useful for candidate discovery but not for proving absence.",
    ],
}

with open(os.environ["TRACE_MANIFEST_PATH"], "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")
PY
  else
    {
      echo "{"
      echo "  \"schema\": \"firefox_trace.manifest.v1\","
      echo "  \"campaign_id\": \"${TRACE_CAMPAIGN_ID}\","
      echo "  \"preset\": \"${TRACE_PRESET}\","
      echo "  \"target_url\": \"${target_url}\""
      echo "}"
    } > "$manifest_path"
  fi
}

args=(--new-instance --profile "$PROFILE_DIR")
if [[ "$TRACE_HEADLESS" == "1" ]]; then
  args+=(--headless)
  if [[ -n "${TRACE_SCREENSHOT:-}" ]]; then
    args+=(--screenshot "$TRACE_SCREENSHOT")
  fi
fi

echo "TRACE_DIR=$TRACE_DIR"
echo "PROFILE_DIR=$PROFILE_DIR"
echo "FIREFOX_BIN=$FIREFOX_BIN"
echo "TRACE_PRESET=${TRACE_PRESET:-manual}"
echo "TRACE_CAMPAIGN_ID=$TRACE_CAMPAIGN_ID"

write_manifest "${1:-}"

exec "$FIREFOX_BIN" "${args[@]}" "$@"
