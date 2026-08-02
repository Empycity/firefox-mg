#!/usr/bin/env python3
"""Validate evidence gates for a Firefox Trace Agent contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

GATES = (
    "preflight",
    "discover",
    "producer",
    "debug-handoff",
    "dependencies",
    "environment-proof",
    "pure-contract",
    "reproduced",
)
PLACEHOLDER = re.compile(r"^(?:[A-Z][A-Z0-9_]*|<[^>]+>)$")


def present(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not PLACEHOLDER.fullmatch(value.strip())


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def require(errors: list[str], data: dict[str, Any], path: str) -> Any:
    node: Any = data
    for part in path.split("."):
        node = mapping(node).get(part)
    if not present(node):
        errors.append(f"missing {path}")
    return node


def validate_common(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    for path in (
        "task_id",
        "task.target_url",
        "task.field_name",
        "task.reproducible_action",
        "task.success_gate",
        "collection.campaign_id",
        "collection.trace_dir",
        "runtime.firefox_bin",
        "runtime.firefox_version",
        "runtime.launcher",
        "runtime.trace_python",
    ):
        require(errors, data, path)
    if mapping(data.get("task")).get("field_location") not in {"query", "body", "headers", "cookies"}:
        errors.append("task.field_location must be query, body, headers, or cookies")
    if mapping(data.get("workspace")).get("reuse_checked") is not True:
        errors.append("workspace.reuse_checked must be true")
    if mapping(data.get("runtime")).get("headed") is not True:
        errors.append("runtime.headed must be true")
    return errors


def validate_preflight(data: dict[str, Any], errors: list[str]) -> None:
    runtime = mapping(data.get("runtime"))
    for name in ("firefox_bin", "launcher", "trace_python"):
        value = runtime.get(name)
        if present(value) and not Path(value).is_file():
            errors.append(f"runtime.{name} is not a file: {value}")
    trace_dir = mapping(data.get("collection")).get("trace_dir")
    if present(trace_dir) and not Path(trace_dir).parent.is_dir():
        errors.append(f"collection.trace_dir parent is missing: {Path(trace_dir).parent}")
    session = mapping(data.get("browser_session"))
    mode = session.get("mode")
    if mode not in {"new", "reuse", "offline-review"}:
        errors.append("browser_session.mode must be new, reuse, or offline-review")
        return
    if session.get("reuse_checked") is not True:
        errors.append("browser_session.reuse_checked must be true")
    if session.get("control_surface") != "firefox-trace":
        errors.append("browser_session.control_surface must be firefox-trace")
    if session.get("other_browser_mcps") != []:
        errors.append("browser_session.other_browser_mcps must be an empty array")
    for name in ("active_trace_dir", "manifest"):
        if not present(session.get(name)):
            errors.append(f"missing browser_session.{name}")
    if mode == "new":
        for name in ("profile_dir", "control_file"):
            if not present(session.get(name)):
                errors.append(f"missing browser_session.{name}")
        if not present(session.get("new_instance_reason")):
            errors.append("new browser session requires browser_session.new_instance_reason")
    elif mode == "reuse":
        for name in ("profile_dir", "control_file"):
            if not present(session.get(name)):
                errors.append(f"missing browser_session.{name}")
        if session.get("active_trace_dir") != trace_dir:
            errors.append("reuse browser session requires active_trace_dir to equal collection.trace_dir")
        for name in ("active_trace_dir", "profile_dir"):
            value = session.get(name)
            if present(value) and not Path(value).is_dir():
                errors.append(f"reused browser session directory is missing: {value}")
        control_file = session.get("control_file")
        if present(control_file) and not Path(control_file).is_file():
            errors.append(f"reused browser control file is missing: {control_file}")
    else:
        if session.get("active_trace_dir") != trace_dir:
            errors.append("offline review requires active_trace_dir to equal collection.trace_dir")
        active_trace_dir = session.get("active_trace_dir")
        if present(active_trace_dir) and not Path(active_trace_dir).is_dir():
            errors.append(f"offline review trace directory is missing: {active_trace_dir}")
        manifest = session.get("manifest")
        if present(manifest) and not Path(manifest).is_file():
            errors.append(f"offline review manifest is missing: {manifest}")
        for name in ("active_trace_dir", "manifest"):
            value = session.get(name)
            if not present(value):
                errors.append(f"offline review evidence is missing: {name}")
    if mode != "offline-review" and data.get("phase") == "preflight":
        collection = mapping(data.get("collection"))
        if collection.get("preset") != "discover-light":
            errors.append("first collection preset must be discover-light")
        if collection.get("segment") != "discover":
            errors.append("first collection segment must be discover")
        if data.get("next_action") != "RUN_DISCOVER_LIGHT":
            errors.append("preflight next_action must be RUN_DISCOVER_LIGHT")


def validate_routing(data: dict[str, Any], errors: list[str]) -> None:
    routing = mapping(data.get("routing"))
    route = routing.get("classification")
    if route not in {"standard-js", "jsvmp", "wasm", "mixed"}:
        errors.append("routing.classification must be standard-js, jsvmp, wasm, or mixed")
    for name in ("signals", "evidence_refs"):
        value = routing.get(name)
        if not isinstance(value, list) or not value:
            errors.append(f"routing.{name} must be non-empty")
    if not present(routing.get("next_step")):
        errors.append("missing routing.next_step")
    if route == "wasm":
        modules = routing.get("wasm_modules")
        if not isinstance(modules, list) or not modules:
            errors.append("routing.wasm_modules must contain module evidence for wasm")
        else:
            for index, module in enumerate(modules):
                item = mapping(module)
                for name in ("module_sha1", "artifact_path", "trace_ref"):
                    if not present(item.get(name)):
                        errors.append(f"missing routing.wasm_modules[{index}].{name}")


def validate_debug_handoff(data: dict[str, Any], errors: list[str]) -> None:
    debugging = mapping(data.get("debugging"))
    session = mapping(data.get("browser_session"))
    if debugging.get("mode") != "external-mcp":
        errors.append("debugging.mode must be external-mcp for debug handoff")
    if debugging.get("mcp_name") != "js-reverse":
        errors.append("debugging.mcp_name must be js-reverse")
    if session.get("other_browser_mcps") != ["js-reverse"]:
        errors.append("browser_session.other_browser_mcps must be [js-reverse] for debug handoff")
    if debugging.get("trace_session_state") != "stopped":
        errors.append("debug handoff requires debugging.trace_session_state=stopped")
    if debugging.get("browser_state_imported") is not False:
        errors.append("debug handoff requires debugging.browser_state_imported=false")
    handoff = mapping(debugging.get("trace_handoff"))
    for name in (
        "trace_dir",
        "request_id",
        "origin_call_id",
        "script_sha256",
        "function_name",
        "unresolved_question",
    ):
        if not present(handoff.get(name)):
            errors.append(f"missing debugging.trace_handoff.{name}")
    if handoff.get("trace_dir") != mapping(data.get("collection")).get("trace_dir"):
        errors.append("debugging.trace_handoff.trace_dir must equal collection.trace_dir")


def validate_request(data: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    sink = mapping(mapping(data.get("evidence")).get("request_sink"))
    for name in ("trace_dir", "manifest", "request_id", "origin_call_id", "field_sha256"):
        require(errors, {"sink": sink}, f"sink.{name}")
    if sink.get("trace_health") != "complete":
        errors.append("request_sink.trace_health must be complete")
    for name in ("trace_dir", "manifest"):
        value = sink.get(name)
        if present(value) and not Path(value).exists():
            errors.append(f"request_sink.{name} is missing: {value}")
    return sink


def validate_producer(data: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    producer = mapping(mapping(data.get("evidence")).get("producer"))
    for name in ("call_id", "origin_call_id", "script_sha256", "function_name", "value_sha256"):
        require(errors, {"producer": producer}, f"producer.{name}")
    if producer.get("match_kind") not in {"exact-value", "sha256"}:
        errors.append("producer.match_kind must be exact-value or sha256")
    sink = mapping(mapping(data.get("evidence")).get("request_sink"))
    if present(producer.get("value_sha256")) and present(sink.get("field_sha256")):
        if producer["value_sha256"] != sink["field_sha256"]:
            errors.append("producer.value_sha256 must equal request_sink.field_sha256")
    if present(producer.get("origin_call_id")) and present(sink.get("origin_call_id")):
        if producer["origin_call_id"] != sink["origin_call_id"]:
            errors.append("producer.origin_call_id must equal request_sink.origin_call_id")
    return producer


def validate_dependencies(data: dict[str, Any], errors: list[str], require_ab: bool) -> list[dict[str, Any]]:
    dependencies = mapping(data.get("evidence")).get("dependencies")
    if not isinstance(dependencies, list) or not dependencies:
        errors.append("evidence.dependencies must contain at least one material dependency")
        return []
    for index, dependency in enumerate(dependencies):
        item = mapping(dependency)
        prefix = f"dependencies[{index}]"
        for name in ("id", "source_event", "field_sha256", "evidence_level", "status"):
            if not present(item.get(name)):
                errors.append(f"missing {prefix}.{name}")
        if item.get("class") not in {"pure", "environment", "state", "mixed"}:
            errors.append(f"{prefix}.class is invalid")
        if not isinstance(item.get("propagation_call_ids"), list) or not item["propagation_call_ids"]:
            errors.append(f"{prefix}.propagation_call_ids must be non-empty")
        if item.get("class") != "pure" and require_ab:
            if not present(item.get("ab_pair_id")) or item.get("ab_result") != "confirmed":
                errors.append(f"{prefix} requires confirmed single-variable A/B evidence")
    return [mapping(item) for item in dependencies]


def validate_pure_contract(data: dict[str, Any], errors: list[str]) -> list[dict[str, Any]]:
    pure = mapping(mapping(data.get("evidence")).get("pure_contract"))
    for name in ("function_name", "serialization", "output_encoding"):
        if not present(pure.get(name)):
            errors.append(f"missing pure_contract.{name}")
    vectors = pure.get("vectors")
    if not isinstance(vectors, list) or not vectors:
        errors.append("pure_contract.vectors must contain retained browser vectors")
        return []
    for index, vector in enumerate(vectors):
        item = mapping(vector)
        for name in ("id", "browser_field_sha256", "trace_ref"):
            if not present(item.get(name)):
                errors.append(f"missing pure_contract.vectors[{index}].{name}")
    return [mapping(vector) for vector in vectors]


def validate_reproduction(data: dict[str, Any], errors: list[str], vectors: list[dict[str, Any]]) -> None:
    reproduction = mapping(mapping(data.get("evidence")).get("reproduction"))
    results = reproduction.get("vector_results")
    if not isinstance(results, list) or len(results) < len(vectors):
        errors.append("reproduction.vector_results must cover every retained vector")
        return
    vector_ids = {vector.get("id") for vector in vectors}
    observed = set()
    for index, result in enumerate(results):
        item = mapping(result)
        if item.get("vector_id") not in vector_ids:
            errors.append(f"reproduction.vector_results[{index}].vector_id is unknown")
        observed.add(item.get("vector_id"))
        if item.get("equal") is not True:
            errors.append(f"reproduction.vector_results[{index}].equal must be true")
    if observed != vector_ids:
        errors.append("reproduction results do not cover the retained vector set")


def validate(data: dict[str, Any], gate: str) -> list[str]:
    errors = validate_common(data)
    if gate == "preflight":
        validate_preflight(data, errors)
        return errors
    validate_request(data, errors)
    validate_routing(data, errors)
    if gate == "discover":
        return errors
    validate_producer(data, errors)
    if gate == "producer":
        return errors
    if gate == "debug-handoff":
        validate_debug_handoff(data, errors)
        return errors
    validate_dependencies(data, errors, require_ab=False)
    if gate == "dependencies":
        return errors
    validate_dependencies(data, errors, require_ab=True)
    if gate == "environment-proof":
        return errors
    vectors = validate_pure_contract(data, errors)
    if gate == "pure-contract":
        return errors
    validate_reproduction(data, errors, vectors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", type=Path)
    parser.add_argument("--gate", choices=GATES, required=True)
    args = parser.parse_args()
    try:
        data = json.loads(args.contract.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"CONTRACT FAIL: {exc}", file=sys.stderr)
        return 2
    if not isinstance(data, dict):
        print("CONTRACT FAIL: root must be a JSON object", file=sys.stderr)
        return 2
    errors = validate(data, args.gate)
    if errors:
        print(f"CONTRACT FAIL: gate={args.gate}", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"CONTRACT PASS: gate={args.gate} task_id={data['task_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
