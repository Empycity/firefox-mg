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
  --preset discover-light|target-return|target-values|deep-causal|manual
  --profile VALUE
  --js-mode boundary|target|deep|off
  --script-contains CSV
  --function-contains CSV
  --script-sha256 CSV
  --target-match all|any|auto
  --query-fields CSV
  --object-depth N
  --object-keys N
  --array-items N
  --typed-array-bytes N
  --value-metadata 0|1
  --primitive-metadata 0|1
  --value-store-min-bytes N
  --limit-events N
  --module js|xhr|fetch|ws|http_raw|dom|cookie|storage|script=0|1
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
    "js": "FIREFOX_TRACE_JS",
    "dom": "FIREFOX_TRACE_DOM",
    "cookie": "FIREFOX_TRACE_COOKIE",
    "storage": "FIREFOX_TRACE_STORAGE",
    "script": "FIREFOX_TRACE_SCRIPT_RESOURCE",
}

PRESETS = {
    "manual": {},
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
    "TRACE_SCRIPT_CONTAINS": "FIREFOX_TRACE_SCRIPT_CONTAINS",
    "TRACE_FUNCTION_CONTAINS": "FIREFOX_TRACE_FUNCTION_CONTAINS",
    "TRACE_SCRIPT_SHA256": "FIREFOX_TRACE_SCRIPT_SHA256",
    "TRACE_TARGET_MATCH": "FIREFOX_TRACE_TARGET_MATCH",
    "TRACE_JS_LIMIT_EVENTS": "FIREFOX_TRACE_JS_LIMIT_EVENTS",
    "TRACE_QUERY_FIELDS": "FIREFOX_TRACE_QUERY_FIELDS",
}

OPTION_ENV = {
    "--profile": "TRACE_PROFILE",
    "--js-mode": "TRACE_JS_MODE",
    "--script-contains": "TRACE_SCRIPT_CONTAINS",
    "--function-contains": "TRACE_FUNCTION_CONTAINS",
    "--script-sha256": "TRACE_SCRIPT_SHA256",
    "--target-match": "TRACE_TARGET_MATCH",
    "--query-fields": "TRACE_QUERY_FIELDS",
    "--object-depth": "TRACE_JS_OBJECT_DEPTH",
    "--object-keys": "TRACE_JS_OBJECT_KEYS",
    "--array-items": "TRACE_JS_ARRAY_ITEMS",
    "--typed-array-bytes": "TRACE_JS_TYPED_ARRAY_BYTES",
    "--value-metadata": "TRACE_JS_VALUE_METADATA",
    "--primitive-metadata": "TRACE_JS_PRIMITIVE_METADATA",
    "--value-store-min-bytes": "TRACE_JS_VALUE_STORE_MIN_BYTES",
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
    return out


def unset_env_key(env, key):
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
            explicit_env[key] = value
        elif arg.startswith("--set="):
            key, value = arg.split("=", 1)[1].split("=", 1)
            explicit_env[key] = value
        elif arg == "--unset":
            i += 1
            explicit_unset.append(args[i])
        elif arg.startswith("--unset="):
            explicit_unset.append(arg.split("=", 1)[1])
        elif arg in OPTION_ENV:
            i += 1
            explicit_env[OPTION_ENV[arg]] = args[i]
        elif any(arg.startswith(k + "=") for k in OPTION_ENV):
            key, value = arg.split("=", 1)
            explicit_env[OPTION_ENV[key]] = value
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

record["config_hash"] = config_hash(record)
record["previous_state"] = prev
enforce_safety(record)
save(record)
append_event(record, prev)
print(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True))
PY
