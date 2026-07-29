#!/usr/bin/env python3
"""Validate Firefox Trace fixture output without site-specific rules."""

import argparse
import hashlib
import json
import sys
from pathlib import Path


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def json_lines(trace_dir, pattern):
    events = []
    for path in sorted(trace_dir.glob(pattern)):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                events.append((path, line_number, json.loads(line)))
            except json.JSONDecodeError as error:
                fail(f"invalid JSON in {path}:{line_number}: {error.msg}")
    return events


def require_field(event, field, context):
    if field not in event:
        fail(f"{context} is missing {field}")
    return event[field]


def check_runtime(trace_dir):
    control_path = trace_dir / "trace-control.json"
    if not control_path.is_file():
        fail(f"missing {control_path}")
    control = json.loads(control_path.read_text(encoding="utf-8"))
    version = require_field(control, "version", "trace control")
    config_hash = require_field(control, "config_hash", "trace control")
    matches = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-control-acks*.jsonl")
        if event.get("type") == "trace.config.applied"
        and event.get("control_version") == version
        and event.get("config_hash") == config_hash
    ]
    if not matches:
        fail(f"no trace.config.applied ACK for version={version} config_hash={config_hash}")
    print(f"runtime: ACK matched version={version} config_hash={config_hash}")


def check_boundary(trace_dir):
    summaries = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-js-*.jsonl")
        if event.get("type") == "js.boundary.flush_summary"
    ]
    if not summaries:
        fail("no js.boundary.flush_summary event found")
    required = ("complete_window", "skipped_by_window", "dropped_before_flush",
                "window_capacity", "window_capacity_source")
    for index, event in enumerate(summaries, 1):
        for field in required:
            require_field(event, field, f"boundary summary #{index}")
    print(f"boundary: validated {len(summaries)} flush summaries")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_source_map(trace_dir):
    resources = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-script-*.jsonl")
        if event.get("type") == "script.resource" and event.get("source_map_resolved_url")
    ]
    if not resources:
        fail("no script.resource event with source_map_resolved_url found")
    for index, event in enumerate(resources, 1):
        raw_sha = require_field(event, "raw_sha256", f"source map event #{index}")
        artifact_path = require_field(event, "artifact_path", f"source map event #{index}")
        artifact = trace_dir / artifact_path
        if not artifact.is_file():
            fail(f"source map event #{index} artifact is missing: {artifact}")
        if artifact.stat().st_size != event.get("raw_size"):
            fail(f"source map event #{index} raw_size does not match {artifact}")
        if sha256(artifact) != raw_sha:
            fail(f"source map event #{index} raw_sha256 does not match {artifact}")
    print(f"source-map: validated {len(resources)} script artifacts")


def check_worker(trace_dir):
    suppressed = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-js-*.jsonl")
        if event.get("type") == "trace.suppressed"
        and event.get("reason") == "worker_thread_ipc_unsupported"
        and event.get("scope") == "worker"
    ]
    if not suppressed:
        fail("no worker_thread_ipc_unsupported trace.suppressed event found")
    print(f"worker: validated {len(suppressed)} suppression notices")


def check_worker_fetch(trace_dir):
    events = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-fetch-*.jsonl")
        if event.get("request_id")
    ]
    worker_calls = {
        event["request_id"]: event
        for event in events
        if event.get("type") == "fetch.call"
        and "worker_mode=" in event.get("url", "")
    }
    if len(worker_calls) < 2:
        fail("expected keepalive and regular Worker fetch.call events")
    if not {True, False} <= {event.get("keepalive") for event in worker_calls.values()}:
        fail("Worker fetch calls do not include both keepalive modes")

    required = {"fetch.call", "fetch.request", "fetch.response", "fetch.done"}
    for request_id in worker_calls:
        chain = [event for event in events if event["request_id"] == request_id]
        missing = required - {event.get("type") for event in chain}
        if missing:
            fail(f"Worker {request_id} missing events: {', '.join(sorted(missing))}")
        artifacts = [
            event for event in chain
            if event.get("type") == "fetch.body_artifact"
            and event.get("body_value_stored") is True
            and event.get("body_value_truncated") is False
        ]
        if not artifacts:
            fail(f"Worker {request_id} has no complete response artifact")
        for artifact in artifacts:
            relative_path = require_field(
                artifact, "body_value_store_path", f"Worker {request_id} artifact"
            )
            value_path = (trace_dir / relative_path).resolve()
            if trace_dir.resolve() not in value_path.parents or not value_path.is_file():
                fail(f"Worker {request_id} artifact is missing: {relative_path}")
            if sha256(value_path) != artifact.get("body_sha256"):
                fail(f"Worker {request_id} artifact digest does not match")
    print(f"worker-fetch: validated {len(worker_calls)} complete Worker fetch chains")


def check_websocket(trace_dir):
    frames = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-websocket-*.jsonl")
        if event.get("type") == "websocket.frame"
    ]
    if not frames:
        fail("no websocket.frame event found")
    directions = {event.get("direction") for event in frames}
    missing = {"send", "recv"} - directions
    if missing:
        fail(f"websocket frames missing directions: {', '.join(sorted(missing))}")
    required = ("schema", "socket_id", "url", "binary", "size",
                "preview_available", "preview_truncated")
    for index, event in enumerate(frames, 1):
        for field in required:
            require_field(event, field, f"websocket frame #{index}")
    print(f"websocket: validated {len(frames)} frames")


def check_fetch_body(trace_dir):
    responses = [
        event
        for _, _, event in json_lines(trace_dir, "firefox-fetch-*.jsonl")
        if event.get("type") in ("fetch.response", "fetch.body_artifact")
        and event.get("body_value_stored") is True
    ]
    if not responses:
        fail("no complete stored fetch response artifact found")
    for index, event in enumerate(responses, 1):
        if event.get("body_value_truncated") is not False:
            fail(f"fetch response #{index} stored a truncated body")
        relative_path = require_field(
            event, "body_value_store_path", f"fetch response #{index}"
        )
        if not relative_path:
            fail(f"fetch response #{index} has an empty artifact path")
        artifact = (trace_dir / relative_path).resolve()
        if trace_dir.resolve() not in artifact.parents or not artifact.is_file():
            fail(f"fetch response #{index} artifact is missing: {relative_path}")
        expected_sha = require_field(event, "body_sha256", f"fetch response #{index}")
        if sha256(artifact) != expected_sha:
            fail(f"fetch response #{index} body_sha256 does not match {relative_path}")
    print(f"fetch-body: validated {len(responses)} complete response artifacts")


def check_http_raw(trace_dir):
    events = json_lines(trace_dir, "firefox-http-raw-*.jsonl")
    chunks = [event for _, _, event in events if event.get("type") == "http.raw_chunk"]
    if not chunks:
        fail("no http.raw_chunk event found")
    for index, event in enumerate(chunks, 1):
        for field in ("channel_id", "offset", "source_count", "captured_size", "browsing_context_id", "top_level_browsing_context_id", "url", "payload_hex", "payload_hex_truncated", "capture_truncated"):
            require_field(event, field, f"http raw chunk #{index}")
        if len(event["payload_hex"]) % 2:
            fail(f"http raw chunk #{index} payload_hex is not byte aligned")
    print(f"http-raw: validated {len(chunks)} raw chunks")


def check_wasm(trace_dir):
    # WASM events arrive through content-parent trace IPC. Scanning every event
    # file also keeps captures produced before dedicated WASM routing usable.
    events = json_lines(trace_dir, "firefox-*.jsonl")
    modules = [event for _, _, event in events if event.get("type") == "wasm.module"]
    if not modules:
        fail("no wasm.module event found")
    for index, event in enumerate(modules, 1):
        for field in ("module_id", "module_sha1", "bytecode_size", "code_section_size",
                      "function_count", "function_import_count", "bytecode_preview_hex",
                      "bytecode_preview_truncated", "dump_requested", "dump_stored"):
            require_field(event, field, f"wasm module #{index}")
        if len(event["module_sha1"]) != 40:
            fail(f"wasm module #{index} module_sha1 is not a SHA-1 hex digest")
        if event["dump_stored"]:
            relative_path = require_field(event, "artifact_path", f"wasm module #{index}")
            artifact = (trace_dir / relative_path).resolve()
            if trace_dir.resolve() not in artifact.parents or not artifact.is_file():
                fail(f"wasm module #{index} artifact is missing: {relative_path}")
            if artifact.stat().st_size != event["bytecode_size"]:
                fail(f"wasm module #{index} artifact size does not match bytecode_size")
            if hashlib.sha1(artifact.read_bytes()).hexdigest() != event["module_sha1"]:
                fail(f"wasm module #{index} artifact SHA-1 does not match module_sha1")
    print(f"wasm: validated {len(modules)} module events")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "check", choices=("runtime", "boundary", "source-map", "worker", "worker-fetch", "websocket", "fetch-body", "http-raw", "wasm")
    )
    parser.add_argument("trace_dir", type=Path)
    args = parser.parse_args()
    if not args.trace_dir.is_dir():
        fail(f"not a trace directory: {args.trace_dir}")
    if args.check == "runtime":
        check_runtime(args.trace_dir)
    elif args.check == "boundary":
        check_boundary(args.trace_dir)
    elif args.check == "source-map":
        check_source_map(args.trace_dir)
    elif args.check == "worker":
        check_worker(args.trace_dir)
    elif args.check == "worker-fetch":
        check_worker_fetch(args.trace_dir)
    elif args.check == "fetch-body":
        check_fetch_body(args.trace_dir)
    elif args.check == "http-raw":
        check_http_raw(args.trace_dir)
    elif args.check == "wasm":
        check_wasm(args.trace_dir)
    else:
        check_websocket(args.trace_dir)


if __name__ == "__main__":
    main()
