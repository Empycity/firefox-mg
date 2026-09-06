#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  trace-control.sh TRACE_DIR start|stop|prewarm|status [label]
  trace-control.sh TRACE_DIR new-segment [label]
  trace-control.sh TRACE_DIR config [options]

Config options:
  --segment LABEL
  --preset full-chain|discover-light|target-return|target-values|deep-causal|vm-window|opcode-window|manual
  --profile VALUE
  --js-mode boundary|target|deep|off
  --script-contains CSV
  --function-contains CSV
  --script-sha256 CSV
  --target-match all|any|auto
  --query-fields CSV
  --body-fields CSV
  --header-fields CSV
  --cookie-fields CSV
  --object-depth N
  --object-keys N
  --array-items N
  --typed-array-bytes N
  --value-metadata 0|1
  --primitive-metadata 0|1
  --value-store-min-bytes N
  --value-store-max-bytes N   JS value artifact 最大字节；0 表示不按大小丢弃
  --deferred-value-capture 0|1  命中请求后再写 JS 值制品
  --deferred-value-pool-bytes N  内存去重值池上限
  --boundary-buffer-events N  请求回溯调用窗口大小
  --limit-events N
  --module js|xhr|fetch|ws|http_raw|wasm|dom|cookie|storage|script=0|1
  --set TRACE_NAME=VALUE
  --unset TRACE_NAME
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

TRACE_DIR="$1"
ACTION="$2"
shift 2

CONTROL_FILE="${TRACE_CONTROL_FILE:-$TRACE_DIR/trace-control.json}"
CONTROL_LOG="$TRACE_DIR/firefox-control.jsonl"
FIREFOX_TRACE_PYTHON="${FIREFOX_TRACE_PYTHON:-/opt/miniconda3/envs/firefox-trace/bin/python}"
if [[ ! -x "$FIREFOX_TRACE_PYTHON" ]]; then
  echo "Firefox Trace python env not found: $FIREFOX_TRACE_PYTHON" >&2
  echo "Create it with: /opt/miniconda3/condabin/conda create -y -n firefox-trace python=3.11" >&2
  echo "Or override with: FIREFOX_TRACE_PYTHON=/path/to/python $0 ..." >&2
  exit 2
fi

case "$ACTION" in
  start|stop|prewarm|status|new-segment|config)
    ;;
  *)
    usage
    exit 2
    ;;
esac

"$FIREFOX_TRACE_PYTHON" - "$CONTROL_FILE" "$CONTROL_LOG" "$ACTION" "$@" <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import time

control_path = pathlib.Path(sys.argv[1])
control_log = pathlib.Path(sys.argv[2])
action = sys.argv[3]
argv = sys.argv[4:]

DEFAULT_MODULES = {
    "xhr": True,
    "fetch": True,
    "ws": False,
    "http_raw": False,
    "wasm": False,
    "js": True,
    "dom": True,
    "cookie": True,
    "storage": True,
    "script": True,
}

MODULE_ENV = {
    "xhr": "FIREFOX_TRACE_XHR",
    "fetch": "FIREFOX_TRACE_FETCH",
    "ws": "FIREFOX_TRACE_WS",
    "http_raw": "FIREFOX_TRACE_HTTP_RAW",
    "wasm": "FIREFOX_TRACE_WASM",
    "js": "FIREFOX_TRACE_JS",
    "dom": "FIREFOX_TRACE_DOM",
    "cookie": "FIREFOX_TRACE_COOKIE",
    "storage": "FIREFOX_TRACE_STORAGE",
    "script": "FIREFOX_TRACE_SCRIPT_RESOURCE",
}

# A few legacy/runtime paths still read the unprefixed module variables.  A
# hot config must update both spellings; otherwise a previous segment can leave
# TRACE_WASM/TRACE_JS enabled even after the UI turns the module off.
MODULE_ENV_ALIASES = {
    "js": "TRACE_JS",
    "wasm": "TRACE_WASM",
    "script": "TRACE_SCRIPT_RESOURCE",
}

PRESETS = {
    "manual": {},
    "full-chain": {
        "TRACE_PLAN": "full-chain",
        "TRACE_CAPTURE_PLAN": "full-chain",
        "TRACE_PROFILE": "discover",
        "TRACE_JS_MODE": "boundary",
        "TRACE_JS_AUTO_CAPTURE_VALUES": "1",
        "TRACE_JS_CAPTURE_VALUES": "1",
        "TRACE_JS_DEFERRED_VALUE_CAPTURE": "1",
        "TRACE_JS_DEFERRED_VALUE_POOL_BYTES": "67108864",
        "TRACE_JS_FULL_SPOOL": "1",
        "TRACE_JS_SCRIPT_EVENTS": "1",
        "TRACE_JS_THIS": "preview",
        "TRACE_JS_ARGS": "preview",
        "TRACE_JS_RET": "preview",
        "TRACE_JS_OBJECT_DEPTH": "0",
        "TRACE_JS_OBJECT_TARGET_ONLY": "1",
        "TRACE_JS_OBJECT_KEYS": "0",
        "TRACE_JS_ARRAY_ITEMS": "0",
        "TRACE_JS_TYPED_ARRAY_BYTES": "0",
        "TRACE_JS_VALUE_STORE": "1",
        "TRACE_JS_VALUE_METADATA": "1",
        "TRACE_JS_VALUE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_PRIMITIVE_METADATA": "1",
        "TRACE_JS_VALUE_STORE_MIN_BYTES": "1",
        "TRACE_JS_VALUE_STORE_MAX_BYTES": "0",
        "TRACE_JS_MAX_VALUE_BYTES": "0",
        "TRACE_JS_MAX_ARGS": "0",
        "TRACE_JS_BOUNDARY_BUFFER": "1",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS": "8192",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_GET": "2048",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL": "4096",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_SEND": "16384",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY": "32768",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL": "24576",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_REQUEST": "24576",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_COOKIE_GET": "4096",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_COOKIE_SET": "4096",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_STORAGE_GET": "4096",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_STORAGE_SET": "4096",
        "TRACE_JS_BOUNDARY_FLUSH_ON": "dom.get,dom.call,xhr.send,xhr.body,fetch.call,fetch.request,cookie.get,cookie.set,storage.get,storage.set",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELDS": "sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest",
        "TRACE_BODY_FIELDS": "sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest",
        "TRACE_HEADER_FIELDS": "sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest",
        "TRACE_COOKIE_FIELDS": "sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES": "0",
        "TRACE_XHR_EVENTS": "open,header,send,body,response",
        "TRACE_FETCH_REQUEST_HEADERS": "preview",
        "TRACE_XHR_REQUEST_BODY": "full",
        "TRACE_XHR_REQUEST_BODY_MAX_BYTES": "0",
        "TRACE_XHR_REQUEST_BODY_HEX_BYTES": "0",
        "TRACE_XHR_REQUEST_BODY_STORE": "1",
        "TRACE_XHR_RESPONSE_BODY": "full",
        "TRACE_XHR_RESPONSE_BODY_STORE": "1",
        "TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES": "0",
        "TRACE_FETCH_EVENTS": "all",
        "TRACE_FETCH_REQUEST_BODY": "full",
        "TRACE_FETCH_REQUEST_BODY_MAX_BYTES": "0",
        "TRACE_FETCH_REQUEST_BODY_HEX_BYTES": "0",
        "TRACE_FETCH_REQUEST_BODY_STORE": "1",
        "TRACE_FETCH_RESPONSE_HEADERS": "full",
        "TRACE_FETCH_RESPONSE_HEADERS_MAX_COUNT": "0",
        "TRACE_FETCH_RESPONSE_HEADER_VALUE_MAX_BYTES": "0",
        "TRACE_FETCH_RESPONSE_BODY": "full",
        "TRACE_FETCH_RESPONSE_BODY_MAX_BYTES": "0",
        "TRACE_FETCH_RESPONSE_BODY_HEX_BYTES": "0",
        "TRACE_FETCH_RESPONSE_BODY_STORE": "1",
        "TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES": "0",
        "TRACE_FETCH_RESPONSE_BODY_CHUNK_EVENTS": "0",
        "FIREFOX_TRACE_DOM": "1",
        "TRACE_DOM_MODE": "all",
        "TRACE_DOM_EVENTS": "all",
        "TRACE_DOM_PREVIEW": "all",
        "TRACE_DOM_CONTRACT": "1",
        "TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH": "0",
        "TRACE_DOM_VALUE_STORE": "1",
        "TRACE_DOM_VALUE_STORE_MIN_BYTES": "1",
        "TRACE_DOM_VALUE_STORE_MAX_BYTES": "0",
        "TRACE_DOM_OBJECT_VALUES": "1",
        "FIREFOX_TRACE_XHR": "1",
        "FIREFOX_TRACE_FETCH": "1",
        "FIREFOX_TRACE_WS": "1",
        "TRACE_WS_PREVIEW_BYTES": "0",
        "FIREFOX_TRACE_STORAGE": "1",
        "FIREFOX_TRACE_COOKIE": "1",
        "TRACE_SCRIPT_RESOURCE": "1",
        "TRACE_SCRIPT_RESOURCE_CAPTURE": "1",
        "TRACE_SCRIPT_RESOURCE_STORE": "1",
        "TRACE_SCRIPT_RESOURCE_MAX_BYTES": "0",
        "TRACE_SCRIPT_RESOURCE_PREVIEW_LIMIT": "0",
        "TRACE_PREVIEW_LIMIT": "0",
        "FIREFOX_TRACE_WASM": "0",
        "TRACE_WASM": "0",
        "TRACE_WASM_DUMP": "0",
        "TRACE_WASM_DUMP_MAX_BYTES": "1048576",
        "TRACE_WASM_PREVIEW_BYTES": "256",
        "TRACE_WASM_MODULE_LIMIT": "64",
        "TRACE_WASM_INSN": "0",
        "TRACE_IPC_MAX_EVENTS_PER_SECOND": "0",
        "TRACE_IPC_MAX_BYTES_PER_SECOND": "0",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "0",
    },
    "vm-window": {
        "TRACE_PLAN": "vm-window",
        "TRACE_CAPTURE_PLAN": "vm-window",
        "TRACE_PROFILE": "vm",
        "TRACE_JS_MODE": "boundary",
        "TRACE_EXECUTION_MODE": "opcode",
        "TRACE_VM_WINDOW": "1",
        "TRACE_VM_WINDOW_RECORDS": "65536",
        "TRACE_OPCODE": "0",
        "TRACE_VM_STEP": "0",
        "TRACE_JS_CAPTURE_VALUES": "1",
        "TRACE_JS_AUTO_CAPTURE_VALUES": "1",
        "TRACE_JS_BOUNDARY_BUFFER": "1",
        "TRACE_JS_FULL_SPOOL": "1",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "0",
        "TRACE_IPC_MAX_EVENTS_PER_SECOND": "0",
        "TRACE_IPC_MAX_BYTES_PER_SECOND": "0",
    },
    "opcode-window": {
        "TRACE_PLAN": "opcode-window",
        "TRACE_CAPTURE_PLAN": "opcode-window",
        "TRACE_PROFILE": "vm",
        "TRACE_JS_MODE": "boundary",
        "TRACE_EXECUTION_MODE": "opcode",
        "TRACE_OPCODE": "1",
        "TRACE_OPCODE_LIMIT": "4096",
        "TRACE_OPCODE_EXECUTION_LIMIT": "65536",
        "TRACE_OPCODE_OPERANDS": "1",
        "TRACE_OPCODE_STACK_SLOTS": "2",
        "TRACE_OPCODE_STACK_PRIMITIVES": "0",
        "TRACE_VM_STEP": "0",
        "TRACE_VM_STEP_LIMIT": "2048",
        "TRACE_OPCODE_MAX_EVENTS_PER_SECOND": "2000",
        "TRACE_OPCODE_MAX_BYTES_PER_SECOND": "4194304",
        "TRACE_IPC_MAX_EVENTS_PER_SECOND": "6000",
        "TRACE_IPC_MAX_BYTES_PER_SECOND": "4194304",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "12000",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "64",
        "FIREFOX_TRACE_DOM": "1",
        "TRACE_DOM_MODE": "signal",
        "TRACE_DOM_EVENTS": "get,call",
        "TRACE_DOM_PREVIEW": "none",
        "FIREFOX_TRACE_XHR": "1",
        "TRACE_XHR_EVENTS": "open,send,response",
        "TRACE_XHR_PREVIEW": "none",
        "FIREFOX_TRACE_FETCH": "1",
        "TRACE_FETCH_EVENTS": "all",
        "FIREFOX_TRACE_STORAGE": "1",
        "FIREFOX_TRACE_COOKIE": "1",
        "TRACE_SCRIPT_RESOURCE": "1",
        "FIREFOX_TRACE_WASM": "1",
        "TRACE_WASM": "1",
        "TRACE_WASM_MODULE_LIMIT": "16",
        "TRACE_WASM_PREVIEW_BYTES": "128",
        "TRACE_WASM_DUMP": "0",
        "TRACE_WASM_INSN": "0",
        "TRACE_WASM_INSN_LIMIT": "512",
    },
    "discover-light": {
        "TRACE_PROFILE": "discover",
        "TRACE_JS_MODE": "boundary",
        "TRACE_JS_CAPTURE_VALUES": "0",
        "TRACE_JS_BOUNDARY_BUFFER": "1",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS": "8192",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_GET": "2048",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL": "2048",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_SEND": "12288",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY": "16384",
        "TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL": "12288",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "64",
        "FIREFOX_TRACE_DOM": "1",
        "TRACE_DOM_MODE": "signal",
        "TRACE_DOM_EVENTS": "get,call",
        "TRACE_DOM_PREVIEW": "none",
        "FIREFOX_TRACE_XHR": "1",
        "TRACE_XHR_EVENTS": "open,send,response",
        "TRACE_XHR_PREVIEW": "none",
        "FIREFOX_TRACE_FETCH": "1",
        "TRACE_FETCH_EVENTS": "all",
        "FIREFOX_TRACE_STORAGE": "1",
        "FIREFOX_TRACE_COOKIE": "1",
        "TRACE_SCRIPT_RESOURCE": "1",
    },
    "target-return": {
        "TRACE_PROFILE": "target",
        "TRACE_JS_MODE": "target",
        "TRACE_TARGET_MATCH": "all",
        "TRACE_JS_EARLY_SCRIPT_FILTER": "1",
        "TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS": "1",
        "TRACE_JS_CAPTURE_VALUES": "1",
        "TRACE_JS_THIS": "none",
        "TRACE_JS_ARGS": "none",
        "TRACE_JS_RET": "preview",
        "TRACE_JS_OBJECT_DEPTH": "1",
        "TRACE_JS_OBJECT_KEYS": "32",
        "TRACE_JS_VALUE_STORE": "1",
        "TRACE_JS_VALUE_METADATA": "1",
        "TRACE_JS_VALUE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_PRIMITIVE_METADATA": "1",
        "TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_DEEP_LONG_STR": "256",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "50000",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "64",
    },
    "target-values": {
        "TRACE_PROFILE": "target",
        "TRACE_JS_MODE": "target",
        "TRACE_TARGET_MATCH": "all",
        "TRACE_JS_EARLY_SCRIPT_FILTER": "1",
        "TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS": "1",
        "TRACE_JS_CAPTURE_VALUES": "1",
        "TRACE_JS_THIS": "none",
        "TRACE_JS_ARGS": "preview",
        "TRACE_JS_RET": "preview",
        "TRACE_JS_OBJECT_DEPTH": "2",
        "TRACE_JS_OBJECT_KEYS": "64",
        "TRACE_JS_VALUE_STORE": "1",
        "TRACE_JS_VALUE_METADATA": "1",
        "TRACE_JS_VALUE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_PRIMITIVE_METADATA": "1",
        "TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_DEEP_LONG_STR": "256",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "50000",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "64",
    },
    "deep-causal": {
        "TRACE_PROFILE": "deep",
        "TRACE_JS_MODE": "deep",
        "TRACE_TARGET_MATCH": "all",
        "TRACE_JS_EARLY_SCRIPT_FILTER": "1",
        "TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS": "0",
        "TRACE_JS_CAPTURE_VALUES": "1",
        "TRACE_JS_THIS": "none",
        "TRACE_JS_ARGS": "preview",
        "TRACE_JS_RET": "preview",
        "TRACE_JS_OBJECT_DEPTH": "1",
        "TRACE_JS_OBJECT_KEYS": "32",
        "TRACE_JS_VALUE_STORE": "1",
        "TRACE_JS_VALUE_METADATA": "1",
        "TRACE_JS_VALUE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_PRIMITIVE_METADATA": "1",
        "TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES": "1",
        "TRACE_JS_DEEP_LONG_STR": "256",
        "TRACE_JS_DEEP_NATIVE": "0",
        "TRACE_JS_DEEP_SELFHOSTED": "0",
        "FIREFOX_TRACE_JS_LIMIT_EVENTS": "50000",
        "TRACE_REQUEST_URL": "preview",
        "TRACE_QUERY_FIELD_VALUES": "preview",
        "TRACE_QUERY_FIELD_VALUE_STORE": "1",
        "TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES": "64",
    },
}

ALIASES = {
    "TRACE_PROFILE": "FIREFOX_TRACE_PROFILE",
    "TRACE_JS_MODE": "FIREFOX_TRACE_JS_MODE",
    "TRACE_JS_CAPTURE_VALUES": "FIREFOX_TRACE_JS_CAPTURE_VALUES",
    "TRACE_JS_AUTO_CAPTURE_VALUES": "FIREFOX_TRACE_JS_AUTO_CAPTURE_VALUES",
    "TRACE_JS_BOUNDARY_BUFFER": "FIREFOX_TRACE_JS_BOUNDARY_BUFFER",
    "TRACE_JS_BOUNDARY_BUFFER_EVENTS": "FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS",
    "TRACE_JS_BOUNDARY_FLUSH_ON": "FIREFOX_TRACE_JS_BOUNDARY_FLUSH_ON",
    "TRACE_JS_THIS": "FIREFOX_TRACE_JS_THIS",
    "TRACE_JS_ARGS": "FIREFOX_TRACE_JS_ARGS",
    "TRACE_JS_RET": "FIREFOX_TRACE_JS_RET",
    "TRACE_JS_OBJECT_DEPTH": "FIREFOX_TRACE_JS_OBJECT_DEPTH",
    "TRACE_JS_OBJECT_KEYS": "FIREFOX_TRACE_JS_OBJECT_KEYS",
    "TRACE_JS_ARRAY_ITEMS": "FIREFOX_TRACE_JS_ARRAY_ITEMS",
    "TRACE_JS_TYPED_ARRAY_BYTES": "FIREFOX_TRACE_JS_TYPED_ARRAY_BYTES",
    "TRACE_JS_VALUE_STORE": "FIREFOX_TRACE_JS_VALUE_STORE",
    "TRACE_JS_VALUE_METADATA": "FIREFOX_TRACE_JS_VALUE_METADATA",
    "TRACE_JS_VALUE_METADATA_MIN_BYTES": "FIREFOX_TRACE_JS_VALUE_METADATA_MIN_BYTES",
    "TRACE_JS_PRIMITIVE_METADATA": "FIREFOX_TRACE_JS_PRIMITIVE_METADATA",
    "TRACE_JS_VALUE_STORE_MIN_BYTES": "FIREFOX_TRACE_JS_VALUE_STORE_MIN_BYTES",
    "TRACE_JS_VALUE_STORE_MAX_BYTES": "FIREFOX_TRACE_JS_VALUE_STORE_MAX_BYTES",
    "TRACE_JS_MAX_VALUE_BYTES": "FIREFOX_TRACE_JS_MAX_VALUE_BYTES",
    "TRACE_JS_MAX_ARGS": "FIREFOX_TRACE_JS_MAX_ARGS",
    "TRACE_SCRIPT_CONTAINS": "FIREFOX_TRACE_SCRIPT_CONTAINS",
    "TRACE_FUNCTION_CONTAINS": "FIREFOX_TRACE_FUNCTION_CONTAINS",
    "TRACE_SCRIPT_SHA256": "FIREFOX_TRACE_SCRIPT_SHA256",
    "TRACE_TARGET_MATCH": "FIREFOX_TRACE_TARGET_MATCH",
    "TRACE_JS_LIMIT_EVENTS": "FIREFOX_TRACE_JS_LIMIT_EVENTS",
    "TRACE_QUERY_FIELDS": "FIREFOX_TRACE_QUERY_FIELDS",
    "TRACE_BODY_FIELDS": "FIREFOX_TRACE_BODY_FIELDS",
    "TRACE_HEADER_FIELDS": "FIREFOX_TRACE_HEADER_FIELDS",
    "TRACE_COOKIE_FIELDS": "FIREFOX_TRACE_COOKIE_FIELDS",
    "TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES": "FIREFOX_TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES",
    "TRACE_XHR_RESPONSE_BODY": "FIREFOX_TRACE_XHR_RESPONSE_BODY",
    "TRACE_XHR_RESPONSE_BODY_STORE": "FIREFOX_TRACE_XHR_RESPONSE_BODY_STORE",
    "TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES": "FIREFOX_TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES",
    "TRACE_FETCH_REQUEST_HEADERS": "FIREFOX_TRACE_FETCH_REQUEST_HEADERS",
    "TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES": "FIREFOX_TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES",
    "TRACE_DOM_HOT_MEMBER_LIMIT": "FIREFOX_TRACE_DOM_HOT_MEMBER_LIMIT",
    "TRACE_DOM_HOT_MEMBER_SAMPLE": "FIREFOX_TRACE_DOM_HOT_MEMBER_SAMPLE",
    "TRACE_DOM_VALUE_STORE": "FIREFOX_TRACE_DOM_VALUE_STORE",
    "TRACE_DOM_VALUE_STORE_MIN_BYTES": "FIREFOX_TRACE_DOM_VALUE_STORE_MIN_BYTES",
    "TRACE_DOM_VALUE_STORE_MAX_BYTES": "FIREFOX_TRACE_DOM_VALUE_STORE_MAX_BYTES",
    "TRACE_DOM_CONTRACT": "FIREFOX_TRACE_DOM_CONTRACT",
    "TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH": "FIREFOX_TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH",
}

# JS filter names have existed under three spellings across the launcher,
# control file and SpiderMonkey hook. Treat them as one family so a hot
# config can both set and clear a filter without leaving a stale alias behind.
ENV_ALIAS_GROUPS = {
    "TRACE_SCRIPT_CONTAINS": (
        "TRACE_SCRIPT_CONTAINS",
        "FIREFOX_TRACE_SCRIPT_CONTAINS",
        "TRACE_JS_SCRIPT_CONTAINS",
        "FIREFOX_TRACE_JS_SCRIPT_CONTAINS",
    ),
    "TRACE_FUNCTION_CONTAINS": (
        "TRACE_FUNCTION_CONTAINS",
        "FIREFOX_TRACE_FUNCTION_CONTAINS",
        "TRACE_JS_FUNCTION_CONTAINS",
        "FIREFOX_TRACE_JS_FUNCTION_CONTAINS",
    ),
    "TRACE_SCRIPT_SHA256": (
        "TRACE_SCRIPT_SHA256",
        "FIREFOX_TRACE_SCRIPT_SHA256",
        "TRACE_JS_SCRIPT_SHA256",
        "FIREFOX_TRACE_JS_SCRIPT_SHA256",
    ),
}
OPTION_ENV = {
    "--profile": "TRACE_PROFILE",
    "--js-mode": "TRACE_JS_MODE",
    "--script-contains": "TRACE_SCRIPT_CONTAINS",
    "--function-contains": "TRACE_FUNCTION_CONTAINS",
    "--script-sha256": "TRACE_SCRIPT_SHA256",
    "--target-match": "TRACE_TARGET_MATCH",
    "--query-fields": "TRACE_QUERY_FIELDS",
    "--body-fields": "TRACE_BODY_FIELDS",
    "--header-fields": "TRACE_HEADER_FIELDS",
    "--cookie-fields": "TRACE_COOKIE_FIELDS",
    "--object-depth": "TRACE_JS_OBJECT_DEPTH",
    "--object-keys": "TRACE_JS_OBJECT_KEYS",
    "--array-items": "TRACE_JS_ARRAY_ITEMS",
    "--typed-array-bytes": "TRACE_JS_TYPED_ARRAY_BYTES",
    "--value-metadata": "TRACE_JS_VALUE_METADATA",
    "--primitive-metadata": "TRACE_JS_PRIMITIVE_METADATA",
    "--value-store-min-bytes": "TRACE_JS_VALUE_STORE_MIN_BYTES",
    "--value-store-max-bytes": "TRACE_JS_VALUE_STORE_MAX_BYTES",
    "--deferred-value-capture": "TRACE_JS_DEFERRED_VALUE_CAPTURE",
    "--deferred-value-pool-bytes": "TRACE_JS_DEFERRED_VALUE_POOL_BYTES",
    "--boundary-buffer-events": "TRACE_JS_BOUNDARY_BUFFER_EVENTS",
    "--limit-events": "FIREFOX_TRACE_JS_LIMIT_EVENTS",
}


def now_unix():
    return int(time.time())


def load_current():
    if not control_path.exists():
        return {}
    try:
        return json.loads(control_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(record):
    control_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = control_path.with_suffix(control_path.suffix + ".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(control_path)


def append_event(record, previous):
    event = {
        "schema": "firefox_trace.event.v1",
        "type": "trace.control",
        "ts_us": int(time.time() * 1_000_000),
        "action": record.get("action"),
        "enabled": record.get("enabled"),
        "mode": record.get("mode"),
        "label": record.get("label", ""),
        "segment_id": record.get("segment_id", ""),
        "segment_label": record.get("segment_label", ""),
        "control_file": str(control_path),
        "control_version": record.get("version"),
        "config_hash": record.get("config_hash", ""),
        "previous_state": previous,
    }
    control_log.parent.mkdir(parents=True, exist_ok=True)
    with control_log.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False, sort_keys=True))
        f.write("\n")


def boolish(value):
    if isinstance(value, bool):
        return value
    return str(value).lower() not in ("0", "false", "no", "off", "")


def normalize_modules(modules):
    merged = dict(DEFAULT_MODULES)
    if isinstance(modules, dict):
        for k, v in modules.items():
            if k in merged:
                merged[k] = boolish(v)
    return merged


def with_aliases(env):
    out = {str(k): str(v) for k, v in (env or {}).items() if str(v) != ""}
    for src, dst in ALIASES.items():
        if src in out:
            out[dst] = out[src]
    for canonical, keys in ENV_ALIAS_GROUPS.items():
        value = next((out[key] for key in keys if key in out and out[key] != ""), None)
        if value is not None:
            for key in keys:
                out[key] = value
    return out


def unset_env_key(env, key):
    for canonical, keys in ENV_ALIAS_GROUPS.items():
        if key == canonical or key in keys:
            for alias in keys:
                env.pop(alias, None)
            return
    env.pop(key, None)
    if key in ALIASES:
        env.pop(ALIASES[key], None)
    for src, dst in ALIASES.items():
        if key == dst:
            env.pop(src, None)
            env.pop(dst, None)


def config_hash(record):
    data = {
        "enabled": record.get("enabled"),
        "mode": record.get("mode"),
        "segment_id": record.get("segment_id"),
        "modules": record.get("modules", {}),
        "env": record.get("env", {}),
    }
    blob = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def apply_vm_safety_defaults(env):
    """Make direct control-file edits inherit the bounded VM profile."""
    out = dict(env or {})

    def value(*keys):
        for key in keys:
            item = out.get(key)
            if item is not None and str(item) != "":
                return str(item)
        return ""

    opcode_enabled = boolish(value("TRACE_OPCODE", "FIREFOX_TRACE_OPCODE"))
    execution_mode = value(
        "TRACE_EXECUTION_MODE", "FIREFOX_TRACE_EXECUTION_MODE"
    ).lower()
    vm_step_enabled = boolish(value("TRACE_VM_STEP", "FIREFOX_TRACE_VM_STEP"))
    vm_window_enabled = boolish(value("TRACE_VM_WINDOW", "FIREFOX_TRACE_VM_WINDOW"))
    if opcode_enabled or execution_mode == "opcode" or vm_step_enabled or vm_window_enabled:
        out.setdefault("TRACE_OPCODE_LIMIT", "4096")
        out.setdefault("TRACE_OPCODE_EXECUTION_LIMIT", "65536")
        out.setdefault("TRACE_VM_STEP_LIMIT", "2048")
        out.setdefault("TRACE_OPCODE_MAX_EVENTS_PER_SECOND", "2000")
        out.setdefault("TRACE_OPCODE_MAX_BYTES_PER_SECOND", "4194304")
        out.setdefault("TRACE_IPC_MAX_EVENTS_PER_SECOND", "0" if vm_window_enabled else "6000")
        out.setdefault("TRACE_IPC_MAX_BYTES_PER_SECOND", "0" if vm_window_enabled else "4194304")
        out.setdefault("TRACE_VM_WINDOW_RECORDS", "65536")
    return with_aliases(out)


def enforce_safety(record):
    env = record.get("env") or {}
    unsafe = str(env.get("TRACE_UNSAFE_ALLOW") or env.get("FIREFOX_TRACE_UNSAFE_ALLOW") or "").lower() in ("1", "true", "yes", "on")
    js_mode = str(env.get("TRACE_JS_MODE") or env.get("FIREFOX_TRACE_JS_MODE") or "").lower()
    if record.get("enabled") and js_mode == "deep" and not unsafe:
        has_filter = any((env.get(k) or "").strip() for k in (
            "TRACE_SCRIPT_CONTAINS",
            "FIREFOX_TRACE_SCRIPT_CONTAINS",
            "TRACE_FUNCTION_CONTAINS",
            "FIREFOX_TRACE_FUNCTION_CONTAINS",
            "TRACE_SCRIPT_SHA256",
            "FIREFOX_TRACE_SCRIPT_SHA256",
        ))
        if not has_filter:
            raise SystemExit("refuse to start js_mode=deep without script/function/hash filter; set TRACE_UNSAFE_ALLOW=1 to override")
    try:
        object_depth = int(env.get("TRACE_JS_OBJECT_DEPTH") or env.get("FIREFOX_TRACE_JS_OBJECT_DEPTH") or "0")
    except ValueError:
        object_depth = 0
    if record.get("enabled") and object_depth > 2 and not unsafe:
        raise SystemExit("refuse to start with TRACE_JS_OBJECT_DEPTH > 2 without TRACE_UNSAFE_ALLOW=1")

    def value(*keys):
        for key in keys:
            item = env.get(key)
            if item is not None and str(item) != "":
                return str(item)
        return ""

    def bounded(name, default, minimum, maximum):
        raw = value(name)
        if not raw:
            return default
        try:
            parsed = int(raw, 10)
        except ValueError:
            raise SystemExit(f"{name} must be an integer between {minimum} and {maximum}")
        if parsed < minimum or parsed > maximum:
            raise SystemExit(
                f"{name} must stay between {minimum} and {maximum}; "
                "set TRACE_UNSAFE_ALLOW=1 for an explicit override"
            )
        return parsed

    if unsafe:
        return

    opcode_enabled = boolish(value("TRACE_OPCODE", "FIREFOX_TRACE_OPCODE"))
    execution_mode = value(
        "TRACE_EXECUTION_MODE", "FIREFOX_TRACE_EXECUTION_MODE"
    ).lower()
    vm_step_enabled = boolish(value("TRACE_VM_STEP", "FIREFOX_TRACE_VM_STEP"))
    vm_window_enabled = boolish(value("TRACE_VM_WINDOW", "FIREFOX_TRACE_VM_WINDOW"))
    wasm_insn_enabled = boolish(value("TRACE_WASM_INSN", "FIREFOX_TRACE_WASM_INSN"))
    wasm_dump_enabled = boolish(value("TRACE_WASM_DUMP", "FIREFOX_TRACE_WASM_DUMP"))

    if opcode_enabled or execution_mode == "opcode" or vm_step_enabled or vm_window_enabled:
        if vm_window_enabled and (opcode_enabled or vm_step_enabled):
            raise SystemExit("TRACE_VM_WINDOW must run separately from TRACE_OPCODE/TRACE_VM_STEP")
        has_opcode_filter = any(
            value(key).strip()
            for key in (
                "TRACE_OPCODE_SCRIPT_CONTAINS",
                "FIREFOX_TRACE_OPCODE_SCRIPT_CONTAINS",
                "TRACE_SCRIPT_CONTAINS",
                "FIREFOX_TRACE_SCRIPT_CONTAINS",
            )
        )
        if not has_opcode_filter:
            raise SystemExit(
                "opcode/vm_step/vm-window requires an automatically resolved script identity"
            )
        if vm_window_enabled and not any(
            value(name).strip().lower()
            not in {"", "__disabled__", "__off__", "off", "none", "false", "0"}
            for name in (
                "TRACE_QUERY_FIELDS",
                "TRACE_BODY_FIELDS",
                "TRACE_HEADER_FIELDS",
                "TRACE_COOKIE_FIELDS",
            )
        ):
            raise SystemExit(
                "TRACE_VM_WINDOW requires at least one configured request target field"
            )
        if vm_step_enabled and not value(
            "TRACE_VM_DISPATCH_PC", "FIREFOX_TRACE_VM_DISPATCH_PC"
        ):
            raise SystemExit(
                "TRACE_VM_STEP requires TRACE_VM_DISPATCH_PC after the dispatcher PC is known"
            )
        bounded("TRACE_OPCODE_LIMIT", 4096, 1, 20000)
        bounded("TRACE_OPCODE_EXECUTION_LIMIT", 65536, 1024, 1000000)
        bounded("TRACE_OPCODE_MAX_EVENTS_PER_SECOND", 2000, 1, 12000)
        bounded("TRACE_OPCODE_MAX_BYTES_PER_SECOND", 1048576, 65536, 8388608)
        if not vm_window_enabled:
            bounded("TRACE_IPC_MAX_EVENTS_PER_SECOND", 6000, 1, 12000)
            bounded("TRACE_IPC_MAX_BYTES_PER_SECOND", 4194304, 65536, 8388608)
        bounded("TRACE_OPCODE_STACK_SLOTS", 0, 0, 4)
        bounded("TRACE_VM_STEP_LIMIT", 2048, 1, 20000)
        bounded("TRACE_VM_WINDOW_RECORDS", 65536, 1024, 262144)

    if not record.get("enabled"):
        return

    if wasm_insn_enabled:
        bounded("TRACE_WASM_INSN_LIMIT", 256, 1, 4096)
    if wasm_dump_enabled:
        bounded("TRACE_WASM_MODULE_LIMIT", 32, 1, 64)
        bounded("TRACE_WASM_DUMP_MAX_BYTES", 1048576, 1, 4194304)


def next_segment_id(current, label):
    existing = str(current.get("segment_id") or "")
    m = re.match(r"seg_(\d+)$", existing)
    n = int(m.group(1)) + 1 if m else int(current.get("segment_index") or 0) + 1
    return f"seg_{n:03d}", n, label or f"segment-{n:03d}"


def previous_state(current):
    return {
        "enabled": current.get("enabled"),
        "mode": current.get("mode"),
        "version": current.get("version"),
        "segment_id": current.get("segment_id"),
        "config_hash": current.get("config_hash"),
    }


def base_record(current, act, enabled, mode, label):
    record = dict(current)
    record.update({
        "schema": "firefox_trace.control.v2",
        "version": int(current.get("version") or 0) + 1,
        "updated_at_unix": now_unix(),
        "action": act,
        "enabled": enabled,
        "mode": mode,
        "label": label,
        "source": "trace-control.sh",
        "modules": normalize_modules(current.get("modules")),
        "env": with_aliases(current.get("env")),
    })
    if not record.get("segment_id"):
        sid, idx, slabel = next_segment_id({}, label or "initial")
        record["segment_id"] = sid
        record["segment_index"] = idx
        record["segment_label"] = slabel
    return record


def record_cleared_env(record, previous):
    """Record runtime variables removed by a hot config.

    Content processes inherit the launch environment.  Omitting a key from the
    next control document is therefore not enough to clear it in an already
    running process; the Gecko side consumes this explicit list and calls
    unsetenv().
    """
    previous_env = {
        str(key)
        for key in (previous.get("env") or {})
        if str(key).startswith(("TRACE_", "FIREFOX_TRACE_"))
    }
    current_env = {
        str(key)
        for key in (record.get("env") or {})
        if str(key).startswith(("TRACE_", "FIREFOX_TRACE_"))
    }
    cleared = set(record.get("unset") or [])
    cleared.update(previous_env - current_env)
    if cleared:
        record["unset"] = sorted(cleared)
    else:
        record.pop("unset", None)


def parse_config_args(args, current):
    env = dict(current.get("env") or {})
    explicit_env = {}
    explicit_unset = []
    modules = normalize_modules(current.get("modules"))
    module_env_overrides = {}
    segment_label = None
    preset = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--segment":
            i += 1
            segment_label = args[i]
        elif arg.startswith("--segment="):
            segment_label = arg.split("=", 1)[1]
        elif arg == "--preset":
            i += 1
            preset = args[i]
        elif arg.startswith("--preset="):
            preset = arg.split("=", 1)[1]
        elif arg == "--module":
            i += 1
            item = args[i]
            name, value = item.split("=", 1)
            if name not in modules:
                raise SystemExit(f"unknown module: {name}")
            modules[name] = boolish(value)
            module_env_overrides[name] = modules[name]
        elif arg.startswith("--module="):
            item = arg.split("=", 1)[1]
            name, value = item.split("=", 1)
            if name not in modules:
                raise SystemExit(f"unknown module: {name}")
            modules[name] = boolish(value)
            module_env_overrides[name] = modules[name]
        elif arg == "--set":
            i += 1
            key, value = args[i].split("=", 1)
            if value == "":
                explicit_unset.append(key)
            else:
                explicit_env[key] = value
        elif arg.startswith("--set="):
            key, value = arg.split("=", 1)[1].split("=", 1)
            if value == "":
                explicit_unset.append(key)
            else:
                explicit_env[key] = value
        elif arg == "--unset":
            i += 1
            explicit_unset.append(args[i])
        elif arg.startswith("--unset="):
            explicit_unset.append(arg.split("=", 1)[1])
        elif arg in OPTION_ENV:
            i += 1
            value = args[i]
            env_key = OPTION_ENV[arg]
            if value == "":
                explicit_unset.append(env_key)
            else:
                explicit_env[env_key] = value
        elif any(arg.startswith(k + "=") for k in OPTION_ENV):
            key, value = arg.split("=", 1)
            env_key = OPTION_ENV[key]
            if value == "":
                explicit_unset.append(env_key)
            else:
                explicit_env[env_key] = value
        else:
            raise SystemExit(f"unknown config option: {arg}")
        i += 1

    if preset:
        if preset not in PRESETS:
            raise SystemExit(f"unknown preset: {preset}")
        merged = dict(env)
        merged.update(PRESETS[preset])
        merged.update(explicit_env)
        env = merged
        env["TRACE_PRESET"] = preset
    else:
        env.update(explicit_env)

    for key in explicit_unset:
        unset_env_key(env, key)

    for name, enabled in module_env_overrides.items():
        env[MODULE_ENV[name]] = "1" if enabled else "0"
        alias = MODULE_ENV_ALIASES.get(name)
        if alias:
            env[alias] = "1" if enabled else "0"

    # Keep the human-readable module map aligned with preset/env composition.
    # The env values remain the runtime source of truth.
    for name, env_key in MODULE_ENV.items():
        if env_key in env:
            modules[name] = boolish(env[env_key])

    return with_aliases(env), modules, segment_label, preset


current = load_current()

if action == "status":
    print(json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True))
    raise SystemExit(0)

prev = previous_state(current)

if action in ("start", "stop", "prewarm"):
    label = argv[0] if argv else ""
    if action == "start":
        enabled, mode = True, "active"
    elif action == "prewarm":
        enabled, mode = True, "prewarm"
    else:
        enabled, mode = False, "paused"
    record = base_record(current, action, enabled, mode, label)
elif action == "new-segment":
    label = argv[0] if argv else ""
    record = base_record(current, "new-segment", False, "paused", label)
    sid, idx, slabel = next_segment_id(current, label)
    record["segment_id"] = sid
    record["segment_index"] = idx
    record["segment_label"] = slabel
elif action == "config":
    env, modules, segment_label, _preset = parse_config_args(argv, current)
    record = base_record(current, "config", boolish(current.get("enabled", False)), current.get("mode") or "paused", segment_label or current.get("label") or "")
    record["env"] = env
    record["modules"] = modules
    if segment_label:
        sid, idx, slabel = next_segment_id(current, segment_label)
        record["segment_id"] = sid
        record["segment_index"] = idx
        record["segment_label"] = slabel
else:
    raise SystemExit(f"unsupported action: {action}")

record["env"] = apply_vm_safety_defaults(record.get("env") or {})
record_cleared_env(record, current)
record["config_hash"] = config_hash(record)
record["previous_state"] = prev
enforce_safety(record)
save(record)
append_event(record, prev)
print(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True))
PY
