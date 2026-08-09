#!/usr/bin/env python3
"""中文 Firefox Trace 中控台。

中控台只负责会话编排：启动一个有头、暂停采集的 Firefox，用户在浏览器
窗口里手动操作；中控台通过 trace-control.sh 切换记录状态，停止后把原始
JSONL 整理成 categorized/ 和 index/。浏览器内核仍是唯一采集源。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


ROOT = pathlib.Path(__file__).resolve().parents[1]
TRACE_CONTROL = ROOT / "tools" / "trace-control.sh"
TRACE_FINALIZE = ROOT / "tools" / "trace_finalize.py"
TRACE_LAUNCHER = ROOT / "tools" / "run-trace-firefox.sh"

OPTION_FLAGS = {
    "profile": ("--profile", "TRACE_PROFILE"),
    "js_mode": ("--js-mode", "TRACE_JS_MODE"),
    "script_contains": ("--script-contains", "TRACE_SCRIPT_CONTAINS"),
    "function_contains": ("--function-contains", "TRACE_FUNCTION_CONTAINS"),
    "script_sha256": ("--script-sha256", "TRACE_SCRIPT_SHA256"),
    "target_match": ("--target-match", "TRACE_TARGET_MATCH"),
    "query_fields": ("--query-fields", "TRACE_QUERY_FIELDS"),
    "body_fields": ("--body-fields", "TRACE_BODY_FIELDS"),
    "header_fields": ("--header-fields", "TRACE_HEADER_FIELDS"),
    "cookie_fields": ("--cookie-fields", "TRACE_COOKIE_FIELDS"),
    "object_depth": ("--object-depth", "TRACE_JS_OBJECT_DEPTH"),
    "object_keys": ("--object-keys", "TRACE_JS_OBJECT_KEYS"),
    "array_items": ("--array-items", "TRACE_JS_ARRAY_ITEMS"),
    "typed_array_bytes": ("--typed-array-bytes", "TRACE_JS_TYPED_ARRAY_BYTES"),
    "value_metadata": ("--value-metadata", "TRACE_JS_VALUE_METADATA"),
    "primitive_metadata": ("--primitive-metadata", "TRACE_JS_PRIMITIVE_METADATA"),
    "value_store_min_bytes": ("--value-store-min-bytes", "TRACE_JS_VALUE_STORE_MIN_BYTES"),
    "value_store_max_bytes": ("--value-store-max-bytes", "TRACE_JS_VALUE_STORE_MAX_BYTES"),
    "deferred_value_capture": ("--deferred-value-capture", "TRACE_JS_DEFERRED_VALUE_CAPTURE"),
    "deferred_value_pool_bytes": ("--deferred-value-pool-bytes", "TRACE_JS_DEFERRED_VALUE_POOL_BYTES"),
    "boundary_buffer_events": ("--boundary-buffer-events", "TRACE_JS_BOUNDARY_BUFFER_EVENTS"),
    "limit_events": ("--limit-events", "FIREFOX_TRACE_JS_LIMIT_EVENTS"),
}

VM_SAFE_DEFAULTS = {
    "vm_window_records": 65536,
    "opcode_limit": 4096,
    "opcode_execution_limit": 65536,
    "vm_step_limit": 2048,
    "opcode_max_events_per_second": 2000,
    "opcode_max_bytes_per_second": 4194304,
    "ipc_max_events_per_second": 12000,
    "ipc_max_bytes_per_second": 8388608,
    "opcode_stack_slots": 2,
    "wasm_module_limit": 16,
    "wasm_preview_bytes": 128,
    "wasm_dump_max_bytes": 1048576,
    "wasm_insn_limit": 512,
}

# Identity values are read by the VM/opcode hook, not by ordinary JIT
# boundary tracing.  Keep their aliases together so a later non-VM segment
# cannot inherit a previous dispatcher/hash window.
VM_IDENTITY_ENV = {
    "script_contains": (
        "TRACE_OPCODE_SCRIPT_CONTAINS",
        "FIREFOX_TRACE_OPCODE_SCRIPT_CONTAINS",
        "TRACE_JS_OPCODE_SCRIPT_CONTAINS",
        "FIREFOX_TRACE_JS_OPCODE_SCRIPT_CONTAINS",
    ),
    "script_sha256": (
        "TRACE_OPCODE_SCRIPT_SHA256",
        "FIREFOX_TRACE_OPCODE_SCRIPT_SHA256",
    ),
    "script_line": (
        "TRACE_OPCODE_SCRIPT_LINE",
        "FIREFOX_TRACE_OPCODE_SCRIPT_LINE",
    ),
    "script_column": (
        "TRACE_OPCODE_SCRIPT_COLUMN",
        "FIREFOX_TRACE_OPCODE_SCRIPT_COLUMN",
    ),
    "script_bytecode_length": (
        "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
        "FIREFOX_TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
    ),
    "pc_range": (
        "TRACE_OPCODE_PC_RANGE",
        "FIREFOX_TRACE_OPCODE_PC_RANGE",
    ),
    "dispatch_pc": (
        "TRACE_VM_DISPATCH_PC",
        "FIREFOX_TRACE_VM_DISPATCH_PC",
    ),
}


def load_target_candidates(trace_dir: pathlib.Path) -> dict:
    path = trace_dir / "index" / "target-candidates.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "schema": "firefox_trace.target_candidates.v1",
            "trace_dir": str(trace_dir),
            "status": "not-generated",
            "candidate_count": 0,
            "recommended": None,
            "candidates": [],
            "next_action": "先完成一次目标动作，停止整理后由工具自动推导脚本身份",
        }
    return data if isinstance(data, dict) else {}


def resolve_vm_identity(
    trace_dir: pathlib.Path, vm: object
) -> tuple[dict, dict]:
    """Merge analyzer output into VM settings without exposing guesswork."""
    payload = dict(vm) if isinstance(vm, dict) else {}
    requested_opcode = boolish(payload.get("opcode"))
    requested_step = boolish(payload.get("vm_step"))
    requested_window = boolish(payload.get("vm_window"))
    if not (requested_opcode or requested_step or requested_window):
        return payload, {
            "status": "not-requested",
            "applied": False,
            "candidate": None,
            "message": "当前阶段未开启 opcode/VM step",
        }

    discovery = load_target_candidates(trace_dir)
    candidate = discovery.get("recommended")
    if not isinstance(candidate, dict):
        # An Agent handoff may carry an analyzer-confirmed identity while the
        # next run intentionally uses a fresh output directory. Preserve that
        # explicit identity; only fall back when the VM request has no usable
        # script, hash, or function selector at all.
        explicit_identity = any(
            str(payload.get(key) or "").strip()
            for key in ("script_contains", "script_sha256", "function_contains")
        )
        if explicit_identity:
            return payload, {
                "status": "explicit-identity-applied",
                "applied": True,
                "candidate": None,
                "applied_keys": [],
                "message": "配置文件已提供 VM 身份；新输出目录尚未生成候选索引，保留显式身份",
            }
        payload["opcode"] = False
        payload["vm_step"] = False
        payload["vm_window"] = False
        return payload, {
            "status": "pending-first-pass",
            "applied": False,
            "candidate": None,
            "message": "尚未找到目标请求关联脚本；本轮自动回退为普通全链路，完成一次目标动作后再自动套用",
        }

    auto = candidate.get("vm") if isinstance(candidate.get("vm"), dict) else {}
    applied: list[str] = []
    for key in (
        "script_contains",
        "script_sha256",
        "function_contains",
        "script_line",
        "script_column",
        "script_bytecode_length",
        "pc_range",
        "dispatch_pc",
    ):
        if str(payload.get(key) or "").strip():
            continue
        value = auto.get(key)
        if value is not None and str(value).strip():
            payload[key] = str(value)
            applied.append(key)

    if not str(payload.get("script_contains") or "").strip():
        payload["opcode"] = False
        payload["vm_step"] = False
        payload["vm_window"] = False
        return payload, {
            "status": "pending-script-identity",
            "applied": False,
            "candidate": candidate,
            "applied_keys": applied,
            "message": "候选记录缺少可用脚本标识；本轮先保持普通全链路",
        }

    if requested_step and not str(payload.get("dispatch_pc") or "").strip():
        # A dispatcher candidate with medium/low confidence remains visible
        # for the Agent, but VM step is held back until a high-confidence PC is
        # available.  Keep opcode enabled so the next segment still contains
        # useful VM evidence.
        payload["vm_step"] = False
        payload["opcode"] = True
        return payload, {
            "status": "script-applied-dispatch-pending",
            "applied": True,
            "candidate": candidate,
            "applied_keys": applied,
            "message": "已自动套用脚本身份；dispatcher 尚未达到自动应用条件，暂以 opcode 采集",
        }

    return payload, {
        "status": "applied",
        "applied": True,
        "candidate": candidate,
        "applied_keys": applied,
        "message": "已自动套用候选脚本及分析结果",
    }


def resolve_payload_vm(
    trace_dir: pathlib.Path, payload: dict
) -> tuple[dict, dict]:
    """Return a payload whose visible VM choice matches applied evidence."""
    effective = dict(payload)
    requested = payload.get("vm") if isinstance(payload.get("vm"), dict) else {}
    effective_vm, auto_vm = resolve_vm_identity(trace_dir, requested)
    effective["vm"] = effective_vm
    requested_interpreter = any(
        boolish(requested.get(key)) for key in ("opcode", "vm_step", "vm_window")
    )
    applied_interpreter = any(
        boolish(effective_vm.get(key))
        for key in ("opcode", "vm_step", "vm_window")
    )
    if requested_interpreter and not applied_interpreter:
        options = dict(payload.get("options") or {})
        options["profile"] = "discover"
        options["js_mode"] = "boundary"
        options["script_contains"] = ""
        options["function_contains"] = ""
        options["script_sha256"] = ""
        effective["options"] = options
    return effective, auto_vm


def bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    if value is None or str(value).strip() == "":
        return default
    try:
        parsed = int(str(value), 10)
    except ValueError as error:
        raise ValueError(
            f"VM 参数需要是 {minimum} 到 {maximum} 的整数：{value}"
        ) from error
    if parsed < minimum or parsed > maximum:
        raise ValueError(
            f"VM 参数超出性能保护范围：{parsed}，允许 {minimum} 到 {maximum}"
        )
    return parsed


def vm_env_from_payload(vm: object) -> dict[str, str]:
    if not isinstance(vm, dict):
        return {}

    opcode = boolish(vm.get("opcode"))
    vm_step = boolish(vm.get("vm_step"))
    vm_window = boolish(vm.get("vm_window"))
    if vm_window and (opcode or vm_step):
        raise ValueError("VM window 与逐条 opcode/VM step 必须分阶段运行")
    interpreter = opcode or vm_step or vm_window
    stack_requested = opcode and (
        boolish(vm.get("opcode_stack")) or boolish(vm.get("opcode_stack_primitives"))
    )
    wasm_dump = boolish(vm.get("wasm_dump"))
    wasm_insn = boolish(vm.get("wasm_insn"))
    vm_unlimited = boolish(vm.get("unlimited"))
    env = {
        "TRACE_VM_SAFE_MODE": "0" if vm_unlimited else "1",
        "TRACE_UNSAFE_ALLOW": "1" if vm_unlimited else "0",
        "TRACE_EXECUTION_MODE": "opcode" if interpreter else "jit",
        "TRACE_OPCODE": "1" if opcode else "0",
        "TRACE_VM_WINDOW": "1" if vm_window else "0",
        "TRACE_VM_WINDOW_RECORDS": str(
            bounded_int(
                vm.get("vm_window_records"),
                VM_SAFE_DEFAULTS["vm_window_records"],
                1024,
                262144,
            )
        ),
        "TRACE_OPCODE_OPERANDS": "1"
        if opcode and boolish(vm.get("opcode_operands"))
        else "0",
        "TRACE_OPCODE_STACK_SLOTS": str(
            bounded_int(
                vm.get("opcode_stack_slots"),
                VM_SAFE_DEFAULTS["opcode_stack_slots"],
                0,
                4,
            )
            if stack_requested
            else 0
        ),
        "TRACE_OPCODE_STACK_PRIMITIVES": "1"
        if opcode and boolish(vm.get("opcode_stack_primitives"))
        else "0",
        "TRACE_OPCODE_LIMIT": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("opcode_limit"),
                VM_SAFE_DEFAULTS["opcode_limit"],
                1,
                20000,
            )
        ),
        "TRACE_OPCODE_EXECUTION_LIMIT": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("opcode_execution_limit"),
                VM_SAFE_DEFAULTS["opcode_execution_limit"],
                1024,
                1000000,
            )
        ),
        "TRACE_OPCODE_MAX_EVENTS_PER_SECOND": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("opcode_max_events_per_second"),
                VM_SAFE_DEFAULTS["opcode_max_events_per_second"],
                1,
                12000,
            )
        ),
        "TRACE_OPCODE_MAX_BYTES_PER_SECOND": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("opcode_max_bytes_per_second"),
                VM_SAFE_DEFAULTS["opcode_max_bytes_per_second"],
                65536,
                8388608,
            )
        ),
        "TRACE_IPC_MAX_EVENTS_PER_SECOND": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("ipc_max_events_per_second"),
                VM_SAFE_DEFAULTS["ipc_max_events_per_second"],
                1,
                12000,
            )
        ),
        "TRACE_IPC_MAX_BYTES_PER_SECOND": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("ipc_max_bytes_per_second"),
                VM_SAFE_DEFAULTS["ipc_max_bytes_per_second"],
                65536,
                8388608,
            )
        ),
        "TRACE_VM_STEP": "1" if vm_step else "0",
        "TRACE_VM_STEP_LIMIT": "0" if vm_unlimited else str(
            bounded_int(
                vm.get("vm_step_limit"),
                VM_SAFE_DEFAULTS["vm_step_limit"],
                1,
                20000,
            )
        ),
        "TRACE_WASM_DUMP": "1" if wasm_dump else "0",
        "TRACE_WASM_INSN": "1" if wasm_insn else "0",
        "TRACE_WASM_MODULE_LIMIT": str(
            bounded_int(
                vm.get("wasm_module_limit"),
                VM_SAFE_DEFAULTS["wasm_module_limit"],
                1,
                64,
            )
        ),
        "TRACE_WASM_PREVIEW_BYTES": str(
            bounded_int(
                vm.get("wasm_preview_bytes"),
                VM_SAFE_DEFAULTS["wasm_preview_bytes"],
                1,
                4096,
            )
        ),
        "TRACE_WASM_DUMP_MAX_BYTES": str(
            bounded_int(
                vm.get("wasm_dump_max_bytes"),
                VM_SAFE_DEFAULTS["wasm_dump_max_bytes"],
                1,
                4194304,
            )
        ),
        "TRACE_WASM_INSN_LIMIT": str(
            bounded_int(
                vm.get("wasm_insn_limit"),
                VM_SAFE_DEFAULTS["wasm_insn_limit"],
                1,
                4096,
            )
        ),
    }

    optional = {
        "script_contains": "TRACE_OPCODE_SCRIPT_CONTAINS",
        "script_sha256": "TRACE_SCRIPT_SHA256",
        "function_contains": "TRACE_FUNCTION_CONTAINS",
        "script_line": "TRACE_OPCODE_SCRIPT_LINE",
        "script_column": "TRACE_OPCODE_SCRIPT_COLUMN",
        "script_bytecode_length": "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
        "pc_range": "TRACE_OPCODE_PC_RANGE",
        "dispatch_pc": "TRACE_VM_DISPATCH_PC",
    }
    for source, target in optional.items():
        value = str(vm.get(source) or "").strip()
        # A discovered VM identity shown in the UI must not silently turn a
        # normal boundary/target segment into a stale VM-filtered segment.
        if interpreter and value:
            env[target] = value

    script_contains = str(vm.get("script_contains") or "").strip()
    if interpreter:
        env.update(
            {
                "TRACE_PROFILE": "vm",
                "TRACE_JS_MODE": "target",
                "TRACE_TARGET_MATCH": "all",
                "TRACE_JS_CAPTURE_VALUES": "0",
                "TRACE_JS_AUTO_CAPTURE_VALUES": "0",
                "TRACE_JS_BOUNDARY_BUFFER": "0",
                "FIREFOX_TRACE_JS_LIMIT_EVENTS": "12000",
            }
        )
        if script_contains:
            env["TRACE_SCRIPT_CONTAINS"] = script_contains

    if vm_window:
        # Keep the low-frequency request/call skeleton while the selected
        # script writes compact VM records. No per-op JSON is enabled here.
        env.update(
            {
                "TRACE_JS_MODE": "boundary",
                "TRACE_JS_CAPTURE_VALUES": "0",
                "TRACE_JS_AUTO_CAPTURE_VALUES": "0",
                "TRACE_JS_BOUNDARY_BUFFER": "1",
                "TRACE_JS_FULL_SPOOL": "0",
                "FIREFOX_TRACE_JS_LIMIT_EVENTS": "0",
            }
        )

    return env

MODULES = [
    "js",
    "xhr",
    "fetch",
    "ws",
    "http_raw",
    "wasm",
    "dom",
    "cookie",
    "storage",
    "script",
]

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

RESTART_REQUIRED = [
    "TRACE_AUTOMATION_SURFACE",
    "FIREFOX_TRACE_AUTOMATION_SURFACE",
    "TRACE_HEADLESS",
    "TRACE_EXECUTION_MODE",
    "TRACE_OPCODE",
    "TRACE_VM_WINDOW",
    "TRACE_VM_WINDOW_RECORDS",
    "TRACE_OPCODE_SCRIPT_CONTAINS",
    "TRACE_SCRIPT_SHA256",
    "TRACE_OPCODE_SCRIPT_LINE",
    "TRACE_OPCODE_SCRIPT_COLUMN",
    "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
]


def now_unix() -> int:
    return int(time.time())


def safe_trace_dir(value: str | None, default: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(value).expanduser() if value else default


def normalize_fields(value: object) -> str:
    if isinstance(value, list):
        value = ",".join(str(item) for item in value)
    return ",".join(
        item.strip()
        for item in str(value or "").replace(";", ",").split(",")
        if item.strip()
    )


def boolish(value: object) -> bool:
    return str(value).lower() not in ("", "0", "false", "off", "no", "none")


def normalize_js_mode(value: object) -> str:
    mode = str(value or "").strip().lower()
    # The desktop UI used to expose "auto" for the first-pass JS mode, but the
    # SpiderMonkey hook only understands boundary/target/deep/off.  Treat auto
    # as boundary so JS call events are actually emitted.
    return "boundary" if mode in {"", "auto", "discover", "full-chain"} else mode


def resolve_payload_js_mode(payload: dict) -> tuple[dict, dict]:
    """Prevent an empty target filter from silently producing zero JS calls."""
    effective = dict(payload)
    options = dict(payload.get("options") or {})
    explicit_env = dict(payload.get("env") or {})
    requested_mode = normalize_js_mode(
        explicit_env.get(
            "FIREFOX_TRACE_JS_MODE",
            explicit_env.get("TRACE_JS_MODE", options.get("js_mode")),
        )
    )
    filter_values = (
        options.get("script_contains"),
        options.get("function_contains"),
        options.get("script_sha256"),
        explicit_env.get("TRACE_JS_SCRIPT_CONTAINS"),
        explicit_env.get("FIREFOX_TRACE_JS_SCRIPT_CONTAINS"),
        explicit_env.get("TRACE_JS_FUNCTION_CONTAINS"),
        explicit_env.get("FIREFOX_TRACE_JS_FUNCTION_CONTAINS"),
        explicit_env.get("TRACE_JS_SCRIPT_SHA256"),
        explicit_env.get("FIREFOX_TRACE_JS_SCRIPT_SHA256"),
    )
    has_target_filter = any(str(value or "").strip() for value in filter_values)
    if requested_mode not in {"target", "deep"} or has_target_filter:
        return effective, {
            "status": "configured",
            "requested_mode": requested_mode,
            "effective_mode": requested_mode,
        }

    # Target/deep hooks deliberately reject an empty target set.  Boundary is
    # the only useful first-pass mode until analysis has supplied a script,
    # function, or hash filter.
    options["js_mode"] = "boundary"
    effective["options"] = options
    env = dict(explicit_env)
    for key in ("TRACE_JS_MODE", "FIREFOX_TRACE_JS_MODE"):
        if key in env:
            env[key] = "boundary"
    effective["env"] = env
    return effective, {
        "status": "boundary-fallback-empty-target",
        "requested_mode": requested_mode,
        "effective_mode": "boundary",
        "message": "target/deep 未加载脚本、函数或 SHA-256 候选，已自动使用 boundary，确保 JS Call 会记录。",
    }


def configured_fields(value: object) -> list[str]:
    text = str(value or "").strip()
    if not text or text == "__disabled__":
        return []
    return [item for item in re.split(r"[,;\s]+", text) if item]


def target_boundary_flush_filter(payload: dict) -> str:
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    query_fields = configured_fields(
        options.get("query_fields", payload.get("query_fields"))
    )
    body_fields = configured_fields(
        options.get("body_fields", payload.get("body_fields"))
    )
    reasons: list[str] = []
    for field in query_fields:
        reasons.extend((f"=xhr.send.{field}", f"=fetch.call.{field}"))
    for field in body_fields:
        reasons.extend((f"=xhr.body.{field}", f"=fetch.request.{field}"))
    return ",".join(dict.fromkeys(reasons))


def promise_drain_ms(payload: dict) -> int:
    """Give already-observed DOM Promises a short, bounded settle window."""
    raw = payload.get("promise_drain_ms")
    if raw is None:
        raw = os.environ.get("FIREFOX_TRACE_PROMISE_DRAIN_MS", "250")
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        value = 250
    return max(0, min(value, 2000))



def startup_env_from_payload(payload: dict) -> dict[str, str]:
    """Translate UI payload into launcher env before Firefox starts.

    Hot config still exists, but launch-time env is necessary for page-load
    evidence such as script.resource and early JS boundary events.
    """
    env: dict[str, str] = {}
    vm_env = vm_env_from_payload(payload.get("vm"))
    env.update(vm_env)

    for key, value in (payload.get("options") or {}).items():
        if key not in OPTION_FLAGS or value is None or str(value) == "":
            continue
        _flag, env_key = OPTION_FLAGS[key]
        env[env_key] = normalize_js_mode(value) if key == "js_mode" else str(value)

    for module, enabled in (payload.get("modules") or {}).items():
        if module in MODULE_ENV:
            env[MODULE_ENV[module]] = "1" if boolish(enabled) else "0"
            if module == "script":
                env["TRACE_SCRIPT_RESOURCE"] = "1" if boolish(enabled) else "0"
            if module == "wasm":
                env["TRACE_WASM"] = "1" if boolish(enabled) else "0"

    # JS call trace is a launch-time SpiderMonkey hook.  If this is only pushed
    # later through trace-control, page-load calls have already passed.  Keep it
    # explicit for every UI launch unless the user deliberately disables JS.
    modules_payload = payload.get("modules") if isinstance(payload.get("modules"), dict) else {}
    if boolish(modules_payload.get("js", True)):
        env.setdefault("FIREFOX_TRACE_JS", "1")
        env.setdefault("TRACE_JS", "1")
        env.setdefault("TRACE_JS_MODE", "boundary")
        env.setdefault("FIREFOX_TRACE_JS_MODE", "boundary")

    # Network response artifacts are part of the UI "full-chain" contract.
    # They must be present at launch time and in the initial trace-control file:
    # otherwise early page requests can only have response_preview and the
    # replay agent loses server-returned config/token evidence.  Keep max=0 as
    # "do not drop the artifact by trace-layer size"; the main JSONL still only
    # stores preview/hash/path metadata.
    plan_name = str(payload.get("plan") or payload.get("preset") or "").strip()
    if plan_name in {"", "full-chain"}:
        # Full-chain keeps the historical capture defaults. The added spool is
        # an output transport optimization: it does not narrow the observed
        # page events or alter the browser's execution path.
        env.setdefault("TRACE_JS_CAPTURE_VALUES", "1")
        env.setdefault("TRACE_JS_AUTO_CAPTURE_VALUES", "1")
        env.setdefault("TRACE_JS_THIS", "preview")
        env.setdefault("TRACE_JS_VALUE_STORE", "1")
        env.setdefault("TRACE_JS_DEFERRED_VALUE_CAPTURE", "1")
        env.setdefault("TRACE_JS_DEFERRED_VALUE_POOL_BYTES", str(64 * 1024 * 1024))
        env.setdefault("TRACE_JS_FULL_SPOOL", "1")
        env.setdefault("TRACE_JS_VALUE_METADATA_MIN_BYTES", "1")
        env.setdefault("TRACE_JS_MAX_VALUE_BYTES", "0")
        env.setdefault("TRACE_JS_TYPED_ARRAY_BYTES", "0")
        env.setdefault("TRACE_JS_OBJECT_TARGET_ONLY", "1")
        env.setdefault("TRACE_JS_BOUNDARY_BUFFER", "1")
        env.setdefault("TRACE_JS_BOUNDARY_BUFFER_EVENTS", "8192")
        env.setdefault(
            "TRACE_JS_BOUNDARY_FLUSH_ON",
            "dom.get,dom.call,xhr.send,xhr.body,fetch.call,fetch.request,cookie.get,cookie.set,storage.get,storage.set",
        )
        # Full-chain observes the complete WebIDL event surface. Object-value
        # capture remains non-recursive by default, so this does not invoke a
        # page-wide JS object walk merely to record the binding operation.
        env.setdefault("TRACE_DOM_EVENTS", "all")
        env.setdefault("TRACE_DOM_PREVIEW", "all")
        env.setdefault("TRACE_DOM_MODE", "all")
        env.setdefault("TRACE_DOM_CONTRACT", "1")
        env.setdefault("TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH", "0")
        env.setdefault("TRACE_DOM_VALUE_STORE", "1")
        env.setdefault("TRACE_DOM_VALUE_STORE_MIN_BYTES", "1")
        env.setdefault("TRACE_DOM_VALUE_STORE_MAX_BYTES", "0")
        env.setdefault("TRACE_DOM_OBJECT_VALUES", "1")
        env.setdefault("TRACE_FETCH_REQUEST_BODY", "full")
        env.setdefault("TRACE_FETCH_REQUEST_BODY_MAX_BYTES", "0")
        env.setdefault("TRACE_FETCH_REQUEST_BODY_HEX_BYTES", "0")
        env.setdefault("TRACE_XHR_REQUEST_BODY", "full")
        env.setdefault("TRACE_XHR_REQUEST_BODY_MAX_BYTES", "0")
        env.setdefault("TRACE_XHR_REQUEST_BODY_HEX_BYTES", "0")
        env.setdefault("TRACE_XHR_RESPONSE_BODY", "full")
        env.setdefault("TRACE_XHR_RESPONSE_BODY_STORE", "1")
        env.setdefault("TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES", "0")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY", "full")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY_MAX_BYTES", "0")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY_HEX_BYTES", "0")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY_STORE", "1")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES", "0")
        env.setdefault("TRACE_FETCH_RESPONSE_BODY_CHUNK_EVENTS", "0")
        env.setdefault("TRACE_XHR_EVENTS", "open,header,send,body,response")
        env.setdefault("TRACE_FETCH_REQUEST_HEADERS", "preview")
        env.setdefault("TRACE_FETCH_RESPONSE_HEADERS", "full")
        env.setdefault("TRACE_FETCH_RESPONSE_HEADERS_MAX_COUNT", "0")
        env.setdefault("TRACE_FETCH_RESPONSE_HEADER_VALUE_MAX_BYTES", "0")
        env.setdefault("TRACE_WS_PREVIEW_BYTES", "0")
        env.setdefault("TRACE_WASM_DUMP", "0")
        env.setdefault("TRACE_SCRIPT_RESOURCE_MAX_BYTES", "0")
        env.setdefault("TRACE_SCRIPT_RESOURCE_PREVIEW_LIMIT", "0")
        env.setdefault("TRACE_PREVIEW_LIMIT", "0")
        # vm_env_from_payload supplies guarded IPC defaults even while VM is
        # off. Full-chain must override those inherited values; an explicit
        # custom env line is applied below and still takes precedence.
        env["TRACE_IPC_MAX_EVENTS_PER_SECOND"] = "0"
        env["TRACE_IPC_MAX_BYTES_PER_SECOND"] = "0"

    vm_payload = payload.get("vm") if isinstance(payload.get("vm"), dict) else {}
    if vm_payload:
        wasm_selected = (
            boolish(vm_payload.get("wasm_module"))
            or boolish(vm_payload.get("wasm_dump"))
            or boolish(vm_payload.get("wasm_insn"))
        )
        env["FIREFOX_TRACE_WASM"] = "1" if wasm_selected else "0"
        env["TRACE_WASM"] = "1" if wasm_selected else "0"

    for key, value in (payload.get("env") or {}).items():
        if value is not None and str(value) != "":
            env_key = str(key)
            env[env_key] = (
                normalize_js_mode(value)
                if env_key in {"TRACE_JS_MODE", "FIREFOX_TRACE_JS_MODE"}
                else str(value)
            )

    # VM stage selection is an internal preset, not a competing JS-mode
    # choice.  Re-apply its controlled keys after ordinary UI options so a
    # default `boundary` radio value cannot undo the automatic VM identity.
    vm_payload = payload.get("vm") if isinstance(payload.get("vm"), dict) else {}
    vm_interpreter = any(
        boolish(vm_payload.get(key))
        for key in ("opcode", "vm_step", "vm_window")
    )
    explicit_env = {
        str(key) for key in (payload.get("env") or {}) if str(key).strip()
    }
    if vm_interpreter:
        for key, value in vm_env.items():
            if key not in explicit_env:
                env[key] = value

    aliases = [
        ("TRACE_PROFILE", "FIREFOX_TRACE_PROFILE"),
        ("TRACE_JS_MODE", "FIREFOX_TRACE_JS_MODE"),
        ("TRACE_JS_CAPTURE_VALUES", "FIREFOX_TRACE_JS_CAPTURE_VALUES"),
        ("TRACE_JS_AUTO_CAPTURE_VALUES", "FIREFOX_TRACE_JS_AUTO_CAPTURE_VALUES"),
        ("TRACE_JS_BOUNDARY_BUFFER", "FIREFOX_TRACE_JS_BOUNDARY_BUFFER"),
        ("TRACE_JS_BOUNDARY_BUFFER_EVENTS", "FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS"),
        ("TRACE_JS_BOUNDARY_FLUSH_ON", "FIREFOX_TRACE_JS_BOUNDARY_FLUSH_ON"),
        ("TRACE_JS_THIS", "FIREFOX_TRACE_JS_THIS"),
        ("TRACE_JS_ARGS", "FIREFOX_TRACE_JS_ARGS"),
        ("TRACE_JS_RET", "FIREFOX_TRACE_JS_RET"),
        ("TRACE_JS_OBJECT_DEPTH", "FIREFOX_TRACE_JS_OBJECT_DEPTH"),
        ("TRACE_JS_OBJECT_KEYS", "FIREFOX_TRACE_JS_OBJECT_KEYS"),
        ("TRACE_JS_ARRAY_ITEMS", "FIREFOX_TRACE_JS_ARRAY_ITEMS"),
        ("TRACE_JS_TYPED_ARRAY_BYTES", "FIREFOX_TRACE_JS_TYPED_ARRAY_BYTES"),
        ("TRACE_JS_VALUE_STORE", "FIREFOX_TRACE_JS_VALUE_STORE"),
        ("TRACE_JS_VALUE_METADATA", "FIREFOX_TRACE_JS_VALUE_METADATA"),
        ("TRACE_JS_PRIMITIVE_METADATA", "FIREFOX_TRACE_JS_PRIMITIVE_METADATA"),
        ("TRACE_JS_VALUE_STORE_MIN_BYTES", "FIREFOX_TRACE_JS_VALUE_STORE_MIN_BYTES"),
        ("TRACE_JS_VALUE_STORE_MAX_BYTES", "FIREFOX_TRACE_JS_VALUE_STORE_MAX_BYTES"),
        ("TRACE_JS_DEFERRED_VALUE_CAPTURE", "FIREFOX_TRACE_JS_DEFERRED_VALUE_CAPTURE"),
        ("TRACE_JS_DEFERRED_VALUE_POOL_BYTES", "FIREFOX_TRACE_JS_DEFERRED_VALUE_POOL_BYTES"),
        ("TRACE_JS_VALUE_METADATA_MIN_BYTES", "FIREFOX_TRACE_JS_VALUE_METADATA_MIN_BYTES"),
        ("TRACE_JS_MAX_VALUE_BYTES", "FIREFOX_TRACE_JS_MAX_VALUE_BYTES"),
        ("TRACE_JS_MAX_ARGS", "FIREFOX_TRACE_JS_MAX_ARGS"),
        ("TRACE_SCRIPT_CONTAINS", "FIREFOX_TRACE_SCRIPT_CONTAINS"),
        ("TRACE_SCRIPT_CONTAINS", "FIREFOX_TRACE_JS_SCRIPT_CONTAINS"),
        ("TRACE_FUNCTION_CONTAINS", "FIREFOX_TRACE_FUNCTION_CONTAINS"),
        ("TRACE_FUNCTION_CONTAINS", "FIREFOX_TRACE_JS_FUNCTION_CONTAINS"),
        ("TRACE_SCRIPT_SHA256", "FIREFOX_TRACE_JS_SCRIPT_SHA256"),
        ("TRACE_TARGET_MATCH", "FIREFOX_TRACE_TARGET_MATCH"),
        ("TRACE_QUERY_FIELDS", "FIREFOX_TRACE_QUERY_FIELDS"),
        ("TRACE_BODY_FIELDS", "FIREFOX_TRACE_BODY_FIELDS"),
        ("TRACE_HEADER_FIELDS", "FIREFOX_TRACE_HEADER_FIELDS"),
        ("TRACE_COOKIE_FIELDS", "FIREFOX_TRACE_COOKIE_FIELDS"),
        (
            "TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES",
            "FIREFOX_TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES",
        ),
        ("TRACE_XHR_RESPONSE_BODY", "FIREFOX_TRACE_XHR_RESPONSE_BODY"),
        ("TRACE_XHR_RESPONSE_BODY_STORE", "FIREFOX_TRACE_XHR_RESPONSE_BODY_STORE"),
        (
            "TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES",
            "FIREFOX_TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES",
        ),
        ("TRACE_FETCH_REQUEST_HEADERS", "FIREFOX_TRACE_FETCH_REQUEST_HEADERS"),
        ("TRACE_FETCH_RESPONSE_BODY", "FIREFOX_TRACE_FETCH_RESPONSE_BODY"),
        ("TRACE_FETCH_RESPONSE_BODY_STORE", "FIREFOX_TRACE_FETCH_RESPONSE_BODY_STORE"),
        (
            "TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES",
            "FIREFOX_TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES",
        ),
        ("TRACE_DOM_PREVIEW", "FIREFOX_TRACE_DOM_PREVIEW"),
        ("TRACE_DOM_LIMIT_EVENTS", "FIREFOX_TRACE_DOM_LIMIT_EVENTS"),
        ("TRACE_DOM_PROMISES", "FIREFOX_TRACE_DOM_PROMISES"),
        ("TRACE_DOM_PROMISE_LIMIT", "FIREFOX_TRACE_DOM_PROMISE_LIMIT"),
        ("TRACE_DOM_ARG_LIMIT", "FIREFOX_TRACE_DOM_ARG_LIMIT"),
        ("TRACE_DOM_OBJECT_VALUE_ITEMS", "FIREFOX_TRACE_DOM_OBJECT_VALUE_ITEMS"),
        ("TRACE_DOM_CONTRACT", "FIREFOX_TRACE_DOM_CONTRACT"),
        (
            "TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH",
            "FIREFOX_TRACE_DOM_CONTRACT_PROTOTYPE_DEPTH",
        ),
        ("TRACE_DOM_HOT_MEMBER_LIMIT", "FIREFOX_TRACE_DOM_HOT_MEMBER_LIMIT"),
        ("TRACE_DOM_HOT_MEMBER_SAMPLE", "FIREFOX_TRACE_DOM_HOT_MEMBER_SAMPLE"),
        ("TRACE_DOM_VALUE_STORE", "FIREFOX_TRACE_DOM_VALUE_STORE"),
        ("TRACE_DOM_VALUE_STORE_MIN_BYTES", "FIREFOX_TRACE_DOM_VALUE_STORE_MIN_BYTES"),
        ("TRACE_DOM_VALUE_STORE_MAX_BYTES", "FIREFOX_TRACE_DOM_VALUE_STORE_MAX_BYTES"),
    ]
    for source, target in aliases:
        if source in env:
            env[target] = env[source]
    for key, value in list(env.items()):
        if key.startswith("TRACE_JS_BOUNDARY_BUFFER_EVENTS_"):
            suffix = key.removeprefix("TRACE_JS_BOUNDARY_BUFFER_EVENTS_")
            env.setdefault(f"FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS_{suffix}", value)
    return env


def classify_event(path: pathlib.Path, event: dict) -> str:
    typ = str(event.get("type") or "")
    name = path.name.lower()
    if "control" in name or "ack" in name or typ.startswith("trace."):
        return "control-health"
    if typ.startswith(("xhr.", "fetch.", "websocket.", "http.raw")):
        return "network"
    if typ.startswith(("cookie", "storage")) or "cookie" in name or "storage" in name:
        return "state"
    if typ.startswith("script.") or "script" in name:
        return "script"
    if typ.startswith(("wasm.", "js.opcode", "js.vm_step", "js.vm_window")):
        return "wasm-vm"
    if typ.startswith("js."):
        return "js"
    if typ.startswith("worker.") or str(event.get("process_type") or "").lower() == "worker":
        return "worker"
    if typ.startswith("dom.") or "dom" in name:
        interface = str(event.get("interface") or event.get("interface_name") or "")
        if interface in {
            "Window",
            "WindowProxy",
            "Navigator",
            "WorkerNavigator",
            "Screen",
            "Location",
            "History",
            "Performance",
            "PerformanceEntry",
            "PerformanceNavigationTiming",
            "PerformanceResourceTiming",
            "Permissions",
            "PermissionStatus",
            "Crypto",
            "SubtleCrypto",
            "StorageManager",
            "UserAgentData",
        }:
            return "bom"
        return "dom"
    return "network" if "request" in typ else "control-health"


class TraceConsole:
    def __init__(self, default_trace_dir: pathlib.Path):
        self.default_trace_dir = default_trace_dir.expanduser()
        configured_python = os.environ.get("FIREFOX_TRACE_PYTHON", "")
        self.python_bin = (
            configured_python
            if configured_python and os.access(configured_python, os.X_OK)
            else sys.executable
        )
        self.runtime_root = pathlib.Path(
            os.environ.get(
                "FIREFOX_TRACE_RUNTIME_ROOT",
                "/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime",
            )
        ).expanduser()
        self._lock = threading.RLock()
        self._active: dict | None = None
        self._offsets: dict[str, int] = {}
        self._partials: dict[str, bytes] = {}
        self._event_counts: collections.Counter[str] = collections.Counter()
        self._category_counts: collections.Counter[str] = collections.Counter()
        self._event_total = 0
        self._byte_total = 0
        self._degraded_total = 0
        self._request_field_total = 0
        self._producer_candidate_total = 0
        self._event_times: collections.deque[float] = collections.deque(maxlen=4096)
        self._last_trace_dir: pathlib.Path | None = None

    def _session_path(self, trace_dir: pathlib.Path) -> pathlib.Path:
        return trace_dir / "ui-session.json"

    def _persist_session(self, session: dict) -> None:
        trace_dir = pathlib.Path(session["trace_dir"])
        trace_dir.mkdir(parents=True, exist_ok=True)
        data = {
            key: value
            for key, value in session.items()
            if key not in {"process", "reader_thread"}
        }
        tmp = self._session_path(trace_dir).with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        tmp.replace(self._session_path(trace_dir))

    def _load_persisted_session(self, trace_dir: pathlib.Path) -> dict:
        try:
            return json.loads(self._session_path(trace_dir).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _alive(self, session: dict) -> bool:
        process = session.get("process")
        if process is not None:
            return process.poll() is None
        pid = int(session.get("pid") or 0)
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    def _get_session(self, trace_dir: pathlib.Path) -> dict | None:
        if self._active and pathlib.Path(self._active["trace_dir"]) == trace_dir:
            return self._active
        persisted = self._load_persisted_session(trace_dir)
        return persisted or None

    def _resolve_firefox_bin(self, requested: str | None = None) -> str:
        candidates = [
            requested,
            os.environ.get("FIREFOX_BIN"),
            str(self.runtime_root / "Nightly.app/Contents/MacOS/firefox"),
        ]
        for candidate in candidates:
            if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return ""

    def _read_control(self, trace_dir: pathlib.Path) -> dict:
        path = trace_dir / "trace-control.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def run_control(
        self,
        trace_dir: pathlib.Path,
        action: str,
        args: list[str],
        control_file: str | None = None,
    ) -> dict:
        env = os.environ.copy()
        env["FIREFOX_TRACE_PYTHON"] = self.python_bin
        if control_file:
            env["TRACE_CONTROL_FILE"] = control_file
        proc = subprocess.run(
            [str(TRACE_CONTROL), str(trace_dir), action, *args],
            cwd=str(ROOT),
            env=env,
            text=True,
            capture_output=True,
        )
        if proc.returncode:
            raise RuntimeError(
                (proc.stderr or proc.stdout or "").strip()
                or f"trace-control exited with {proc.returncode}"
            )
        return json.loads(proc.stdout or "{}")

    def _drain_launcher_output(self, session: dict) -> None:
        process = session.get("process")
        trace_dir = pathlib.Path(session["trace_dir"])
        log_path = trace_dir / "ui-launcher.log"
        try:
            with log_path.open("a", encoding="utf-8") as output:
                if process and process.stdout:
                    for line in process.stdout:
                        output.write(line)
                        output.flush()
        except OSError:
            pass

    def open_session(self, payload: dict) -> dict:
        with self._lock:
            if self._active and self._alive(self._active):
                raise RuntimeError("当前已有 Firefox Trace 会话，请先关闭当前会话")

            raw_url = str(payload.get("url") or "").strip()
            parsed = urlparse(raw_url)
            if not raw_url or parsed.scheme not in {"http", "https", "file", "about"}:
                raise ValueError("URL 需要是 http、https、file 或 about 地址")

            trace_value = str(payload.get("trace_dir") or "").strip()
            if trace_value:
                trace_dir = pathlib.Path(trace_value).expanduser()
            else:
                trace_dir = pathlib.Path("/private/tmp") / (
                    f"firefox-trace-ui-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
                )
            trace_dir = trace_dir.resolve()
            trace_dir.mkdir(parents=True, exist_ok=True)
            effective_payload, auto_vm = resolve_payload_vm(trace_dir, payload)
            effective_payload, js_capture = resolve_payload_js_mode(effective_payload)
            existing_manifest = trace_dir / "manifest.json"
            if existing_manifest.exists() and not boolish(payload.get("reuse_trace")):
                raise RuntimeError(
                    f"输出目录已有 manifest.json：{trace_dir}；换一个目录或显式 reuse_trace"
                )

            profile_value = str(payload.get("profile_dir") or "").strip()
            profile_dir = (
                pathlib.Path(profile_value).expanduser().resolve()
                if profile_value
                else pathlib.Path("/private/tmp") / f"{trace_dir.name}-profile"
            )
            query_fields = normalize_fields(payload.get("query_fields"))
            body_fields = normalize_fields(payload.get("body_fields"))
            header_fields = normalize_fields(payload.get("header_fields"))
            cookie_fields = normalize_fields(payload.get("cookie_fields"))
            plan = str(payload.get("plan") or "full-chain").strip()
            preset = str(payload.get("preset") or plan).strip()
            label = str(payload.get("label") or "ui-manual").strip()
            trace_start = str(payload.get("trace_start") or "paused").strip().lower()
            if trace_start not in {"active", "paused", "prewarm"}:
                raise ValueError("trace_start 需要是 active、paused 或 prewarm")
            firefox_bin = self._resolve_firefox_bin(payload.get("firefox_bin"))
            if not firefox_bin:
                raise RuntimeError(
                    "找不到可执行 Firefox。请配置 FIREFOX_BIN 或 FIREFOX_TRACE_RUNTIME_ROOT"
                )

            env = os.environ.copy()
            env.update(
                {
                    "FIREFOX_TRACE_PYTHON": self.python_bin,
                    "TRACE_DIR": str(trace_dir),
                    "PROFILE_DIR": str(profile_dir),
                    "TRACE_START": trace_start,
                    "TRACE_HEADLESS": "0",
                    "TRACE_PLAN": plan,
                    "TRACE_CAPTURE_PLAN": plan,
                    "TRACE_PRESET": preset,
                    "TRACE_RUN_LABEL": label,
                    "TRACE_CAMPAIGN_ID": str(
                        payload.get("campaign_id") or f"ui-{time.strftime('%Y%m%d-%H%M%S')}"
                    ),
                    "FIREFOX_BIN": firefox_bin,
                }
            )
            if query_fields:
                env["TRACE_QUERY_FIELDS"] = query_fields
            if body_fields:
                env["TRACE_BODY_FIELDS"] = body_fields
            if header_fields:
                env["TRACE_HEADER_FIELDS"] = header_fields
            if cookie_fields:
                env["TRACE_COOKIE_FIELDS"] = cookie_fields
            env.update(startup_env_from_payload(effective_payload))

            command = [
                str(TRACE_LAUNCHER),
                "--trace-preset",
                preset,
                "--trace-plan",
                plan,
                "--trace-start",
                trace_start,
                "--trace-run-label",
                label,
                raw_url,
            ]
            process = subprocess.Popen(
                command,
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
            session = {
                "schema": "firefox_trace.ui_session.v1",
                "session_id": f"ui_{uuid.uuid4().hex[:12]}",
                "trace_dir": str(trace_dir),
                "profile_dir": str(profile_dir),
                "url": raw_url,
                "plan": plan,
                "preset": preset,
                "label": label,
                "pid": process.pid,
                "phase": "opening",
                "recording": trace_start in {"active", "prewarm"},
                "started_at_unix": now_unix(),
                "process": process,
                "auto_vm": auto_vm,
                "js_capture": js_capture,
            }
            self._active = session
            self._last_trace_dir = trace_dir
            self._reset_metrics(trace_dir)
            self._persist_session(session)
            reader = threading.Thread(
                target=self._drain_launcher_output,
                args=(session,),
                name="firefox-trace-launcher-reader",
                daemon=True,
            )
            session["reader_thread"] = reader
            reader.start()

            deadline = time.time() + 4
            while time.time() < deadline:
                if (trace_dir / "manifest.json").exists() or not self._alive(session):
                    break
                time.sleep(0.05)
            if (trace_dir / "trace-control.json").exists():
                session["phase"] = "recording" if trace_start in {"active", "prewarm"} else "paused"
            elif not self._alive(session):
                session["phase"] = "exited"
            self._persist_session(session)
            return self.session_status(trace_dir)

    def _reset_metrics(self, trace_dir: pathlib.Path) -> None:
        self._offsets.clear()
        self._partials.clear()
        self._event_counts.clear()
        self._category_counts.clear()
        self._event_total = 0
        self._byte_total = 0
        self._degraded_total = 0
        self._request_field_total = 0
        self._producer_candidate_total = 0
        self._event_times.clear()
        self._last_trace_dir = trace_dir

    def _consume_metrics(self, trace_dir: pathlib.Path) -> None:
        if self._last_trace_dir != trace_dir:
            self._reset_metrics(trace_dir)
        for path in sorted(trace_dir.glob("firefox-*.jsonl")):
            key = str(path)
            try:
                size = path.stat().st_size
                offset = self._offsets.get(key, 0)
                if size < offset:
                    offset = 0
                    self._partials.pop(key, None)
                with path.open("rb") as stream:
                    stream.seek(offset)
                    data = stream.read()
                self._offsets[key] = size
            except OSError:
                continue
            if not data:
                continue
            self._byte_total += len(data)
            data = self._partials.pop(key, b"") + data
            lines = data.split(b"\n")
            if data and not data.endswith(b"\n"):
                self._partials[key] = lines.pop()
            for raw in lines:
                if not raw.strip():
                    continue
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                typ = str(event.get("type") or "unknown")
                category = classify_event(path, event)
                self._event_total += 1
                self._event_counts[typ] += 1
                self._category_counts[category] += 1
                self._event_times.append(time.time())
                if typ == "trace.degraded":
                    self._degraded_total += 1
                if isinstance(event.get("query_fields"), dict):
                    self._request_field_total += len(event["query_fields"])
                if isinstance(event.get("body_fields"), dict):
                    self._request_field_total += len(event["body_fields"])
                if isinstance(event.get("header_fields"), dict):
                    self._request_field_total += len(event["header_fields"])
                if isinstance(event.get("cookie_fields"), dict):
                    self._request_field_total += len(event["cookie_fields"])
                if typ.startswith("js.call.") and (
                    event.get("target_match") is True
                    or event.get("capture_tier") == "boundary_auto"
                ):
                    self._producer_candidate_total += 1

    def _read_manifest(self, trace_dir: pathlib.Path) -> dict:
        try:
            return json.loads((trace_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _config_acknowledgements(
        self, trace_dir: pathlib.Path, control: dict, target_pid: str | None = None
    ) -> dict:
        path = trace_dir / "firefox-control-acks.jsonl"
        expected_version = control.get("version")
        expected_hash = control.get("config_hash")
        latest: dict[str, dict] = {}
        if path.is_file():
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "trace.config.applied":
                    continue
                child_id = str(event.get("child_id") or event.get("pid") or "unknown")
                latest[child_id] = event
        matching = [
            event
            for event in latest.values()
            if event.get("control_version") == expected_version
            and event.get("config_hash") == expected_hash
        ]
        target = str(target_pid).strip() if target_pid else None
        target_matching = (
            [event for event in matching if str(event.get("pid")) == target]
            if target
            else []
        )
        return {
            "ready": bool(target_matching) if target else bool(matching),
            "any_ready": bool(matching),
            "target_ready": bool(target_matching) if target else None,
            "target_pid": target,
            "expected_version": expected_version,
            "expected_config_hash": expected_hash,
            "processes": sorted(latest.values(), key=lambda item: str(item.get("child_id", ""))),
            "matching_processes": matching,
        }

    def session_status(
        self,
        trace_dir: pathlib.Path | None = None,
        target_pid: str | None = None,
    ) -> dict:
        with self._lock:
            trace_dir = trace_dir or self._last_trace_dir or self.default_trace_dir
            trace_dir = trace_dir.expanduser()
            session = self._get_session(trace_dir) or {
                "trace_dir": str(trace_dir),
                "phase": "idle",
                "recording": False,
                "pid": None,
            }
            self._consume_metrics(trace_dir)
            alive = self._alive(session)
            if session.get("phase") == "opening" and (trace_dir / "trace-control.json").exists():
                session["phase"] = "paused"
            if session.get("phase") in {"opening", "paused", "recording"} and not alive:
                session["phase"] = "exited"
            control = self._read_control(trace_dir)
            recording = bool(control.get("enabled")) and control.get("mode") == "active"
            if session.get("phase") not in {"closed", "exited"}:
                session["recording"] = recording
            manifest = self._read_manifest(trace_dir)
            now = time.time()
            while self._event_times and self._event_times[0] < now - 1:
                self._event_times.popleft()
            event_rate = len(self._event_times)
            budget_events = (
                (manifest.get("env") or {}).get("TRACE_IPC_MAX_EVENTS_PER_SECOND")
                or (manifest.get("env") or {}).get("FIREFOX_TRACE_IPC_MAX_EVENTS_PER_SECOND")
                or 0
            )
            budget_bytes = (
                (manifest.get("env") or {}).get("TRACE_IPC_MAX_BYTES_PER_SECOND")
                or (manifest.get("env") or {}).get("FIREFOX_TRACE_IPC_MAX_BYTES_PER_SECOND")
                or 0
            )
            final_summary = None
            try:
                final_summary = json.loads(
                    (trace_dir / "index" / "summary.json").read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError):
                pass
            target_discovery = load_target_candidates(trace_dir)
            health_status = "degraded" if self._degraded_total else "ok"
            result_session = {
                key: value
                for key, value in session.items()
                if key not in {"process", "reader_thread"}
            }
            result_session.update(
                {
                    "pid": session.get("pid"),
                    "alive": alive,
                    "recording": recording,
                    "segment_id": control.get("segment_id"),
                    "segment_label": control.get("segment_label"),
                    "phase": session.get("phase", "idle"),
                }
            )
            return {
                "ok": True,
                "trace_dir": str(trace_dir),
                "session": result_session,
                "control": control,
                "manifest": {
                    "target_url": manifest.get("target_url"),
                    "campaign_id": manifest.get("campaign_id"),
                    "preset": manifest.get("preset"),
                    "capture_plan": (manifest.get("env") or {}).get("TRACE_CAPTURE_PLAN")
                    or (manifest.get("env") or {}).get("TRACE_PLAN")
                    or manifest.get("preset"),
                },
                "metrics": {
                    "events_total": self._event_total,
                    "bytes_total": self._byte_total,
                    "events_per_second": event_rate,
                    "event_counts": dict(self._event_counts),
                    "category_counts": dict(self._category_counts),
                    "degraded_count": self._degraded_total,
                    "request_field_count": self._request_field_total,
                    "producer_candidate_count": self._producer_candidate_total,
                },
                "health": {
                    "status": health_status,
                    "trace_degraded": self._degraded_total > 0,
                    "event_budget_per_second": budget_events,
                    "byte_budget_per_second": budget_bytes,
                    "event_rate_over_budget": bool(
                        budget_events and event_rate > int(budget_events)
                    ),
                },
                "config_applied": self._config_acknowledgements(
                    trace_dir, control, target_pid
                ),
                "final_summary": final_summary,
                "target_discovery": target_discovery,
            }

    def action(self, name: str, payload: dict) -> dict:
        trace_dir = safe_trace_dir(payload.get("trace_dir"), self.default_trace_dir)
        session = self._get_session(trace_dir)
        if not session:
            raise RuntimeError("找不到对应 Firefox Trace 会话")
        control_action = "stop" if name == "pause" else name
        label = str(payload.get("label") or name)
        control = self.run_control(
            trace_dir,
            control_action,
            [label],
            payload.get("control_file"),
        )
        drained_ms = 0
        if name == "stop":
            drained_ms = promise_drain_ms(payload)
            if drained_ms:
                time.sleep(drained_ms / 1000.0)
        if self._active and pathlib.Path(self._active["trace_dir"]) == trace_dir:
            self._active["phase"] = (
                "recording" if control_action in {"start", "prewarm"} else "paused"
            )
            self._active["recording"] = bool(control.get("enabled"))
            self._persist_session(self._active)
        response = {
            "ok": True,
            "action": name,
            "trace_dir": str(trace_dir),
            "control": control,
            "promise_drain_ms": drained_ms,
        }
        if name == "stop" and payload.get("finalize", True):
            response["finalize"] = self.finalize(trace_dir)["result"]
        return response

    def config(self, payload: dict) -> dict:
        trace_dir = safe_trace_dir(payload.get("trace_dir"), self.default_trace_dir)
        effective_payload, auto_vm = resolve_payload_vm(trace_dir, payload)
        effective_payload, js_capture = resolve_payload_js_mode(effective_payload)
        effective_vm = effective_payload.get("vm") or {}
        args: list[str] = []
        unset_keys: set[str] = set()

        def add_unset(key: str):
            key = str(key).strip()
            if key and key not in unset_keys:
                unset_keys.add(key)
                args.extend(["--unset", key])

        if payload.get("segment"):
            args += ["--segment", str(payload["segment"])]
        if payload.get("preset"):
            args += ["--preset", str(payload["preset"])]
        vm_env = vm_env_from_payload(effective_vm)
        for key, value in (effective_payload.get("options") or {}).items():
            if key not in OPTION_FLAGS:
                continue
            flag, env_key = OPTION_FLAGS[key]
            if value is None or str(value) == "":
                add_unset(env_key)
            else:
                args += [flag, normalize_js_mode(value) if key == "js_mode" else str(value)]
        for module, enabled in (effective_payload.get("modules") or {}).items():
            if module in MODULES:
                args += ["--module", f"{module}={1 if enabled else 0}"]
        vm_payload = effective_vm
        if not isinstance(vm_payload, dict):
            vm_payload = {}
        wasm_selected = (
            boolish(vm_payload.get("wasm_module"))
            or boolish(vm_payload.get("wasm_dump"))
            or boolish(vm_payload.get("wasm_insn"))
        )
        if "wasm_module" in vm_payload or boolish(vm_payload.get("wasm_dump")) or boolish(
            vm_payload.get("wasm_insn")
        ):
            args += ["--module", f"wasm={1 if wasm_selected else 0}"]
        for key, value in (effective_payload.get("env") or {}).items():
            if value is None or str(value) == "":
                add_unset(str(key))
            else:
                env_key = str(key)
                env_value = (
                    normalize_js_mode(value)
                    if env_key in {"TRACE_JS_MODE", "FIREFOX_TRACE_JS_MODE"}
                    else str(value)
                )
                args += ["--set", f"{env_key}={env_value}"]
        for key in effective_payload.get("unset") or []:
            add_unset(str(key))
        explicit_env = {
            str(key)
            for key in (effective_payload.get("env") or {})
            if str(key).strip()
        }
        explicit_unset = {str(key) for key in effective_payload.get("unset") or []}
        for key, value in vm_env.items():
            if key not in explicit_env and key not in explicit_unset:
                args += ["--set", f"{key}={value}"]

        # A VM identity is meaningful only while opcode/VM step is enabled.
        # Clear the opcode-only aliases when the UI switches back to the
        # one-round target/value mode.  Shared regular filters remain governed
        # by the visible options above.
        if isinstance(payload.get("vm"), dict):
            vm_interpreter = any(
                boolish(effective_vm.get(key))
                for key in ("opcode", "vm_step", "vm_window")
            )
            options = effective_payload.get("options") or {}
            for source, aliases in VM_IDENTITY_ENV.items():
                vm_value = str(effective_vm.get(source) or "").strip()
                if vm_interpreter and vm_value:
                    continue
                if source in {"script_sha256", "function_contains"} and str(
                    options.get(source) or ""
                ).strip():
                    continue
                for key in aliases:
                    add_unset(key)
        control = self.run_control(
            trace_dir, "config", args, payload.get("control_file")
        )
        restart_keys = sorted(
            key for key in (control.get("env") or {}) if key in RESTART_REQUIRED
        )
        return {
            "ok": True,
            "trace_dir": str(trace_dir),
            "control": control,
            "restart_required_keys": restart_keys,
            "auto_vm": auto_vm,
            "js_capture": js_capture,
        }

    def finalize(self, trace_dir: pathlib.Path) -> dict:
        trace_dir = trace_dir.expanduser()
        proc = subprocess.run(
            [self.python_bin, str(TRACE_FINALIZE), str(trace_dir), "--json"],
            cwd=str(ROOT),
            text=True,
            capture_output=True,
        )
        if proc.returncode:
            raise RuntimeError(
                (proc.stderr or proc.stdout or "").strip()
                or f"trace_finalize exited with {proc.returncode}"
            )
        return {"ok": True, "trace_dir": str(trace_dir), "result": json.loads(proc.stdout)}

    def close(self, payload: dict) -> dict:
        trace_dir = safe_trace_dir(payload.get("trace_dir"), self.default_trace_dir)
        session = self._get_session(trace_dir)
        if not session:
            raise RuntimeError("找不到对应 Firefox Trace 会话")
        try:
            self.run_control(
                trace_dir,
                "stop",
                [str(payload.get("label") or "ui-close")],
                payload.get("control_file"),
            )
        except Exception:
            pass
        drained_ms = promise_drain_ms(payload)
        if drained_ms:
            time.sleep(drained_ms / 1000.0)
        finalized = None
        try:
            finalized = self.finalize(trace_dir)["result"]
        except Exception as error:
            finalized = {"error": str(error)}

        pid = int(session.get("pid") or 0)
        process = session.get("process")
        terminated = False
        if pid > 0 and self._alive(session):
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
                terminated = True
            except OSError:
                try:
                    os.kill(pid, signal.SIGTERM)
                    terminated = True
                except OSError:
                    pass
            deadline = time.time() + 4
            while time.time() < deadline and self._alive(session):
                time.sleep(0.1)
            if self._alive(session):
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except OSError:
                    pass
            if process is not None:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass

        if self._active and pathlib.Path(self._active["trace_dir"]) == trace_dir:
            self._active["phase"] = "closed"
            self._active["recording"] = False
            self._active["terminated"] = terminated
            self._persist_session(self._active)
            self._active = None
        return {
            "ok": True,
            "action": "close",
            "trace_dir": str(trace_dir),
            "pid": pid,
            "terminated": terminated,
            "promise_drain_ms": drained_ms,
            "finalize": finalized,
        }

    def latest(self) -> dict:
        roots = []
        for root in (pathlib.Path("/private/tmp"), self.default_trace_dir.parent):
            try:
                candidates = root.glob("firefox-trace-*")
            except OSError:
                continue
            for path in candidates:
                if (
                    path.is_dir()
                    and (path / "manifest.json").is_file()
                    and "-profile-" not in path.name
                    and not path.name.endswith("-profile")
                ):
                    try:
                        roots.append((path.stat().st_mtime, str(path)))
                    except OSError:
                        pass
        roots.sort(reverse=True)
        unique = []
        seen = set()
        for _, path in roots:
            if path not in seen:
                seen.add(path)
                unique.append(path)
        return {"ok": True, "dirs": unique[:20]}

    def summary(self, trace_dir: pathlib.Path) -> dict:
        status = self.session_status(trace_dir)
        if status.get("final_summary"):
            return status["final_summary"]
        files = {}
        for path in sorted(trace_dir.glob("firefox-*.jsonl")):
            try:
                files[path.name] = len(
                    path.read_text(encoding="utf-8", errors="ignore").splitlines()
                )
            except OSError:
                continue
        return {
            "ok": True,
            "trace_dir": str(trace_dir),
            "files": files,
            "metrics": status["metrics"],
            "control": status["control"],
        }


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    blob = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("cache-control", "no-store")
    handler.send_header("content-length", str(len(blob)))
    handler.end_headers()
    handler.wfile.write(blob)


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    console: TraceConsole

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/latest":
                json_response(self, 200, self.console.latest())
                return
            if parsed.path in {"/api/status", "/api/session/status"}:
                trace_dir = safe_trace_dir(
                    (query.get("trace_dir") or [""])[0],
                    self.console.default_trace_dir,
                )
                target_pid = (query.get("target_pid") or [""])[0] or None
                json_response(
                    self,
                    200,
                    self.console.session_status(trace_dir, target_pid),
                )
                return
            if parsed.path == "/api/summary":
                trace_dir = safe_trace_dir(
                    (query.get("trace_dir") or [""])[0],
                    self.console.default_trace_dir,
                )
                json_response(self, 200, self.console.summary(trace_dir))
                return
            json_response(self, 404, {"ok": False, "error": "not found"})
        except Exception as error:
            json_response(self, 500, {"ok": False, "error": str(error)})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            payload = read_json_body(self)
            if parsed.path == "/api/open":
                result = self.console.open_session(payload)
            elif parsed.path == "/api/config":
                result = self.console.config(payload)
            elif parsed.path == "/api/new-segment":
                result = self.console.action("new-segment", payload)
            elif parsed.path in {"/api/start", "/api/prewarm", "/api/pause"}:
                result = self.console.action(parsed.path.rsplit("/", 1)[-1], payload)
            elif parsed.path == "/api/stop":
                result = self.console.action("stop", {**payload, "finalize": True})
            elif parsed.path == "/api/finalize":
                trace_dir = safe_trace_dir(
                    payload.get("trace_dir"), self.console.default_trace_dir
                )
                result = self.console.finalize(trace_dir)
            elif parsed.path == "/api/close":
                result = self.console.close(payload)
            else:
                result = {"ok": False, "error": "not found"}
                json_response(self, 404, result)
                return
            json_response(self, 200, result)
        except Exception as error:
            json_response(self, 400, {"ok": False, "error": str(error)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Firefox Trace 中文中控台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument(
        "--trace-dir", default="/private/tmp/firefox-trace-console"
    )
    args = parser.parse_args()

    Handler.console = TraceConsole(pathlib.Path(args.trace_dir))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Firefox Trace 中控台：http://{args.host}:{args.port}/")
    print(f"默认输出目录：{Handler.console.default_trace_dir}")
    server.serve_forever()


if __name__ == "__main__":
    main()
