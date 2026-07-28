#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACE_RUN_SUFFIX="${TRACE_RUN_SUFFIX:-$(date +%s)-$$}"
find_default_firefox_bin() {
  local candidate=""
  shopt -s nullglob
  for path in "$ROOT_DIR"/gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/firefox; do
    if [[ -x "$path" ]]; then
      candidate="$path"
    fi
  done
  shopt -u nullglob
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  printf '%s\n' "$ROOT_DIR/gecko-dev/obj-aarch64-apple-darwin25.5.0/dist/Nightly.app/Contents/MacOS/firefox"
}

FIREFOX_BIN="${FIREFOX_BIN:-$(find_default_firefox_bin)}"
TRACE_DIR="${TRACE_DIR:-/private/tmp/firefox-trace-$TRACE_RUN_SUFFIX}"
PROFILE_DIR="${PROFILE_DIR:-/private/tmp/firefox-trace-profile-$TRACE_RUN_SUFFIX}"
TRACE_USER_JS="${TRACE_USER_JS:-$ROOT_DIR/profiles/trace-user.js}"
TRACE_APPLY_USER_JS="${TRACE_APPLY_USER_JS:-1}"
TRACE_HEADLESS="${TRACE_HEADLESS:-0}"
TRACE_PRESET="${TRACE_PRESET:-}"
TRACE_CAMPAIGN_ID="${TRACE_CAMPAIGN_ID:-campaign-$(date +%Y%m%d-%H%M%S)}"
TRACE_RUN_LABEL="${TRACE_RUN_LABEL:-}"
TRACE_AUTOMATION_SURFACE="${TRACE_AUTOMATION_SURFACE:-baseline}"
TRACE_START="${TRACE_START:-active}"
TRACE_CONTROL_FILE="${TRACE_CONTROL_FILE:-$TRACE_DIR/trace-control.json}"
FIREFOX_TRACE_PYTHON="${FIREFOX_TRACE_PYTHON:-/opt/miniconda3/envs/firefox-trace/bin/python}"
if [[ ! -x "$FIREFOX_TRACE_PYTHON" ]]; then
  echo "Firefox Trace python env not found: $FIREFOX_TRACE_PYTHON" >&2
  echo "Create it with: /opt/miniconda3/condabin/conda create -y -n firefox-trace python=3.11" >&2
  echo "Or override with: FIREFOX_TRACE_PYTHON=/path/to/python $0 ..." >&2
  exit 2
fi

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
    --trace-automation-surface)
      TRACE_AUTOMATION_SURFACE="${2:-}"
      shift 2
      ;;
    --trace-automation-surface=*)
      TRACE_AUTOMATION_SURFACE="${1#--trace-automation-surface=}"
      shift
      ;;
    --trace-start)
      TRACE_START="${2:-}"
      shift 2
      ;;
    --trace-start=*)
      TRACE_START="${1#--trace-start=}"
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

case "$TRACE_AUTOMATION_SURFACE" in
  "stock"|"baseline")
    ;;
  *)
    echo "Unknown TRACE_AUTOMATION_SURFACE: $TRACE_AUTOMATION_SURFACE" >&2
    echo "Known modes: stock, baseline" >&2
    exit 2
    ;;
esac

case "$TRACE_START" in
  "active"|"paused"|"prewarm")
    ;;
  *)
    echo "Unknown TRACE_START: $TRACE_START" >&2
    echo "Known modes: active, paused, prewarm" >&2
    exit 2
    ;;
esac

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
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_GET 2048
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL 2048
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_SEND 12288
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY 16384
      set_default TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL 12288
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
      set_default TRACE_IPC_MAX_EVENTS_PER_SECOND 16000
      set_default TRACE_IPC_MAX_BYTES_PER_SECOND 8388608
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
      set_default TRACE_JS_VALUE_METADATA 1
      set_default TRACE_JS_VALUE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_PRIMITIVE_METADATA 1
      set_default TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_IPC_MAX_EVENTS_PER_SECOND 10000
      set_default TRACE_IPC_MAX_BYTES_PER_SECOND 8388608
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
      set_default TRACE_JS_VALUE_METADATA 1
      set_default TRACE_JS_VALUE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_PRIMITIVE_METADATA 1
      set_default TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_IPC_MAX_EVENTS_PER_SECOND 8000
      set_default TRACE_IPC_MAX_BYTES_PER_SECOND 8388608
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
      set_default TRACE_JS_VALUE_METADATA 1
      set_default TRACE_JS_VALUE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_PRIMITIVE_METADATA 1
      set_default TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES 1
      set_default TRACE_JS_DEEP_LONG_STR 256
      set_default TRACE_JS_DEEP_NATIVE 0
      set_default TRACE_JS_DEEP_SELFHOSTED 0
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 50000
      set_default TRACE_IPC_MAX_EVENTS_PER_SECOND 5000
      set_default TRACE_IPC_MAX_BYTES_PER_SECOND 8388608
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
      set_default TRACE_OPCODE_LIMIT 10000
      set_default TRACE_OPCODE_OPERANDS 1
      set_default TRACE_OPCODE_STACK_SLOTS 4
      set_default TRACE_OPCODE_STACK_PRIMITIVES 0
      set_default TRACE_JS_CAPTURE_VALUES 0
      set_default FIREFOX_TRACE_JS_LIMIT_EVENTS 10000
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

if [[ "${TRACE_EXECUTION_MODE:-}" == "opcode" || "${TRACE_OPCODE:-0}" != "0" ]]; then
  if [[ -z "${TRACE_OPCODE_SCRIPT_CONTAINS:-${TRACE_SCRIPT_CONTAINS:-}}" ]]; then
    echo "opcode-window requires TRACE_OPCODE_SCRIPT_CONTAINS or TRACE_SCRIPT_CONTAINS" >&2
    exit 2
  fi
fi

export FIREFOX_TRACE_ENABLE="${FIREFOX_TRACE_ENABLE:-1}"
export FIREFOX_TRACE_JS="${FIREFOX_TRACE_JS:-1}"
export FIREFOX_TRACE_LOG_DIR="${FIREFOX_TRACE_LOG_DIR:-$TRACE_DIR}"
export TRACE_CAMPAIGN_ID
export TRACE_PRESET
export TRACE_START
export TRACE_CONTROL_FILE
export FIREFOX_TRACE_CONTROL_FILE="${FIREFOX_TRACE_CONTROL_FILE:-$TRACE_CONTROL_FILE}"
export FIREFOX_TRACE_PYTHON
export TRACE_AUTOMATION_SURFACE
export FIREFOX_TRACE_AUTOMATION_SURFACE="${FIREFOX_TRACE_AUTOMATION_SURFACE:-$TRACE_AUTOMATION_SURFACE}"

write_trace_control() {
  local action="start"
  local enabled="true"
  local mode="$TRACE_START"
  case "$TRACE_START" in
    active)
      enabled="true"
      action="initial_active"
      ;;
    paused)
      enabled="false"
      action="initial_paused"
      ;;
    prewarm)
      enabled="true"
      action="initial_prewarm"
      ;;
  esac

  if [[ -n "$FIREFOX_TRACE_PYTHON" ]]; then
    TRACE_CONTROL_FILE_PATH="$TRACE_CONTROL_FILE" \
    TRACE_CONTROL_ACTION="$action" \
    TRACE_CONTROL_ENABLED="$enabled" \
    TRACE_CONTROL_MODE="$mode" \
    TRACE_CONTROL_SOURCE="run-trace-firefox.sh" \
    "$FIREFOX_TRACE_PYTHON" - <<'PY'
import hashlib, json, os, pathlib, time

path = pathlib.Path(os.environ["TRACE_CONTROL_FILE_PATH"])
path.parent.mkdir(parents=True, exist_ok=True)
enabled = os.environ.get("TRACE_CONTROL_ENABLED", "true") == "true"
env = {
    k: v
    for k, v in os.environ.items()
    if v and (k.startswith("TRACE_") or k.startswith("FIREFOX_TRACE_"))
}
aliases = {
    "TRACE_PROFILE": "FIREFOX_TRACE_PROFILE",
    "TRACE_JS_MODE": "FIREFOX_TRACE_JS_MODE",
    "TRACE_SCRIPT_CONTAINS": "FIREFOX_TRACE_SCRIPT_CONTAINS",
    "TRACE_FUNCTION_CONTAINS": "FIREFOX_TRACE_FUNCTION_CONTAINS",
    "TRACE_SCRIPT_SHA256": "FIREFOX_TRACE_SCRIPT_SHA256",
    "TRACE_TARGET_MATCH": "FIREFOX_TRACE_TARGET_MATCH",
    "TRACE_QUERY_FIELDS": "FIREFOX_TRACE_QUERY_FIELDS",
}
for src, dst in aliases.items():
    if src in env and dst not in env:
        env[dst] = env[src]
record = {
    "schema": "firefox_trace.control.v2",
    "version": 1,
    "updated_at_unix": int(time.time()),
    "action": os.environ.get("TRACE_CONTROL_ACTION", ""),
    "enabled": enabled,
    "mode": os.environ.get("TRACE_CONTROL_MODE", "active"),
    "label": os.environ.get("TRACE_RUN_LABEL", ""),
    "source": os.environ.get("TRACE_CONTROL_SOURCE", ""),
    "segment_id": "seg_001",
    "segment_index": 1,
    "segment_label": os.environ.get("TRACE_RUN_LABEL", "") or "initial",
    "modules": {
        "xhr": True,
        "fetch": True,
        "js": True,
        "dom": True,
        "cookie": True,
        "storage": True,
        "script": True,
    },
    "env": env,
}
hash_data = {
    "enabled": record["enabled"],
    "mode": record["mode"],
    "segment_id": record["segment_id"],
    "modules": record["modules"],
    "env": record["env"],
}
record["config_hash"] = hashlib.sha256(
    json.dumps(hash_data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()[:16]
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(path)
PY
  else
    {
      echo "{"
      echo "  \"schema\": \"firefox_trace.control.v1\","
      echo "  \"version\": 1,"
      echo "  \"action\": \"$action\","
      echo "  \"enabled\": $enabled,"
      echo "  \"mode\": \"$mode\""
      echo "}"
    } > "$TRACE_CONTROL_FILE"
  fi
}

write_manifest() {
  local manifest_path="$TRACE_DIR/manifest.json"
  local target_url="${1:-}"
  if [[ -n "$FIREFOX_TRACE_PYTHON" ]]; then
    TRACE_MANIFEST_PATH="$manifest_path" \
    TRACE_TARGET_URL_FOR_MANIFEST="$target_url" \
    TRACE_RUN_LABEL_FOR_MANIFEST="$TRACE_RUN_LABEL" \
    FIREFOX_BIN_FOR_MANIFEST="$FIREFOX_BIN" \
    PROFILE_DIR_FOR_MANIFEST="$PROFILE_DIR" \
    TRACE_USER_JS_FOR_MANIFEST="$TRACE_USER_JS" \
    "$FIREFOX_TRACE_PYTHON" - <<'PY'
import json, os, time

keys = [
    "TRACE_CAMPAIGN_ID", "TRACE_PRESET", "TRACE_AUTOMATION_SURFACE",
    "TRACE_START", "TRACE_CONTROL_FILE", "FIREFOX_TRACE_CONTROL_FILE",
    "FIREFOX_TRACE_AUTOMATION_SURFACE",
    "TRACE_PROFILE", "TRACE_JS_MODE",
    "TRACE_SCRIPT_CONTAINS", "TRACE_FUNCTION_CONTAINS", "TRACE_SCRIPT_SHA256",
    "TRACE_TARGET_MATCH", "TRACE_JS_EARLY_SCRIPT_FILTER",
    "TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS", "TRACE_JS_CAPTURE_VALUES",
    "TRACE_JS_BOUNDARY_BUFFER", "TRACE_JS_BOUNDARY_BUFFER_EVENTS",
    "TRACE_JS_BOUNDARY_FLUSH_ON",
    "TRACE_JS_THIS", "TRACE_JS_ARGS", "TRACE_JS_RET", "TRACE_JS_OBJECT_DEPTH",
    "TRACE_JS_OBJECT_KEYS", "TRACE_JS_OBJECT_VALUE_KEYS", "TRACE_JS_VALUE_STORE",
    "TRACE_JS_VALUE_METADATA", "TRACE_JS_VALUE_METADATA_MIN_BYTES",
    "TRACE_JS_PRIMITIVE_METADATA", "TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES",
    "TRACE_JS_VALUE_STORE_MIN_BYTES", "TRACE_JS_DEEP_LONG_STR",
    "TRACE_JS_DEEP_NATIVE",
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
    "TRACE_OPCODE_SCRIPT_CONTAINS", "TRACE_OPCODE_PC_RANGE", "TRACE_OPCODE_LIMIT",
    "TRACE_OPCODE_SCRIPT_LINE", "TRACE_OPCODE_SCRIPT_COLUMN",
    "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
    "TRACE_VM_STEP", "TRACE_VM_DISPATCH_PC", "TRACE_VM_STEP_LIMIT",
    "TRACE_OPCODE_OPERANDS", "TRACE_OPCODE_STACK_SLOTS", "TRACE_OPCODE_STACK_PRIMITIVES",
    "FIREFOX_TRACE_ENABLE", "FIREFOX_TRACE_LOG_DIR", "FIREFOX_TRACE_DOM",
    "FIREFOX_TRACE_XHR", "FIREFOX_TRACE_FETCH", "FIREFOX_TRACE_STORAGE",
    "FIREFOX_TRACE_COOKIE", "FIREFOX_TRACE_JS_BOUNDARY_BUFFER",
    "FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS",
    "FIREFOX_TRACE_JS_TARGET_BOUNDARY_BUFFER",
    "FIREFOX_TRACE_JS_BOUNDARY_FLUSH_ON",
    "FIREFOX_TRACE_JS_LIMIT_EVENTS", "FIREFOX_TRACE_PREVIEW_LIMIT",
    "TRACE_IPC_MAX_EVENTS_PER_SECOND", "TRACE_IPC_MAX_BYTES_PER_SECOND",
    "FIREFOX_TRACE_IPC_MAX_EVENTS_PER_SECOND", "FIREFOX_TRACE_IPC_MAX_BYTES_PER_SECOND",
]

dynamic_prefixes = (
    "TRACE_JS_BOUNDARY_BUFFER_EVENTS_",
    "FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS_",
)
for key in sorted(os.environ):
    if any(key.startswith(prefix) for prefix in dynamic_prefixes):
        keys.append(key)

manifest = {
    "schema": "firefox_trace.manifest.v1",
    "created_at_unix": int(time.time()),
    "campaign_id": os.environ.get("TRACE_CAMPAIGN_ID", ""),
    "preset": os.environ.get("TRACE_PRESET", ""),
    "automation_surface": os.environ.get("TRACE_AUTOMATION_SURFACE", ""),
    "trace_start": os.environ.get("TRACE_START", ""),
    "trace_control_file": os.environ.get("TRACE_CONTROL_FILE", ""),
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
      echo "  \"automation_surface\": \"${TRACE_AUTOMATION_SURFACE}\","
      echo "  \"trace_start\": \"${TRACE_START}\","
      echo "  \"trace_control_file\": \"${TRACE_CONTROL_FILE}\","
      echo "  \"target_url\": \"${target_url}\""
      echo "}"
    } > "$manifest_path"
  fi
}

manifest_target_url() {
  local skip_next=0
  local arg
  for arg in "$@"; do
    if [[ "$skip_next" == "1" ]]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      --profile|--screenshot|--remote-debugging-port|--remote-allow-hosts|--remote-allow-origins)
        skip_next=1
        ;;
      --profile=*|--screenshot=*|--remote-debugging-port=*|--remote-allow-hosts=*|--remote-allow-origins=*)
        ;;
      --*)
        ;;
      *)
        printf '%s\n' "$arg"
        return 0
        ;;
    esac
  done
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
echo "TRACE_START=$TRACE_START"
echo "TRACE_CONTROL_FILE=$TRACE_CONTROL_FILE"
echo "TRACE_AUTOMATION_SURFACE=$TRACE_AUTOMATION_SURFACE"
echo "FIREFOX_TRACE_AUTOMATION_SURFACE=$FIREFOX_TRACE_AUTOMATION_SURFACE"

write_trace_control
write_manifest "$(manifest_target_url "$@")"

exec "$FIREFOX_BIN" "${args[@]}" "$@"
