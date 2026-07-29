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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("check", choices=("runtime", "boundary", "source-map"))
    parser.add_argument("trace_dir", type=Path)
    args = parser.parse_args()
    if not args.trace_dir.is_dir():
        fail(f"not a trace directory: {args.trace_dir}")
    if args.check == "runtime":
        check_runtime(args.trace_dir)
    elif args.check == "boundary":
        check_boundary(args.trace_dir)
    else:
        check_source_map(args.trace_dir)


if __name__ == "__main__":
    main()
