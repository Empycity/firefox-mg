#!/usr/bin/env python3
"""Stop and finalize a trace as soon as its configured target field is durable."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any


FIELD_KEYS = ("query_fields", "body_fields", "header_fields", "cookie_fields")
ENV_KEYS = {
    "query_fields": ("TRACE_QUERY_FIELDS", "FIREFOX_TRACE_QUERY_FIELDS"),
    "body_fields": ("TRACE_BODY_FIELDS", "FIREFOX_TRACE_BODY_FIELDS"),
    "header_fields": ("TRACE_HEADER_FIELDS", "FIREFOX_TRACE_HEADER_FIELDS"),
    "cookie_fields": ("TRACE_COOKIE_FIELDS", "FIREFOX_TRACE_COOKIE_FIELDS"),
}
DISABLED = {"", "__disabled__", "__off__", "off", "none", "false", "0"}
ARTIFACT_KEYS = (
    "value_store_path",
    "body_value_store_path",
    "request_body_store_path",
    "response_body_store_path",
    "artifact_path",
)
URL_KEYS = ("url", "host_url", "channel_url", "final_url")


def parse_args() -> argparse.Namespace:
    here = pathlib.Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace_dir", type=pathlib.Path)
    parser.add_argument("--max-seconds", type=float, default=120.0)
    parser.add_argument("--max-bytes", type=int, default=2 * 1024**3)
    parser.add_argument("--poll-ms", type=int, default=200)
    parser.add_argument("--ack-seconds", type=float, default=5.0)
    parser.add_argument(
        "--url-contains",
        default="",
        help="Stop only when the target event URL contains this substring.",
    )
    parser.add_argument(
        "--segment-id",
        default="",
        help="Only inspect events from this segment (defaults to the current trace-control segment).",
    )
    parser.add_argument("--control-script", type=pathlib.Path, default=here / "trace-control.sh")
    parser.add_argument("--finalize-script", type=pathlib.Path, default=here / "trace_finalize.py")
    parser.add_argument("--python", default=os.environ.get("FIREFOX_TRACE_PYTHON", sys.executable))
    return parser.parse_args()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def configured_fields(manifest: dict[str, Any]) -> dict[str, set[str]]:
    env = manifest.get("env") if isinstance(manifest.get("env"), dict) else {}
    result: dict[str, set[str]] = {}
    for field_key, names in ENV_KEYS.items():
        raw = next((env.get(name) for name in names if env.get(name) is not None), "")
        result[field_key] = {
            item.strip().lower()
            for item in str(raw).replace(";", ",").split(",")
            if item.strip().lower() not in DISABLED
        }
    return result


def trace_size(trace_dir: pathlib.Path) -> int:
    total = 0
    try:
        paths = trace_dir.rglob("*")
        for path in paths:
            try:
                if path.is_file() and not path.is_symlink():
                    total += path.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


def artifact_paths(event: dict[str, Any], field_key: str, name: str) -> list[str]:
    paths: list[str] = []
    meta = event.get(f"{field_key}_meta")
    if isinstance(meta, dict) and isinstance(meta.get(name), dict):
        paths.extend(str(meta[name].get(key) or "") for key in ARTIFACT_KEYS)
    paths.extend(str(event.get(key) or "") for key in ARTIFACT_KEYS)
    return [path for path in paths if path]


def artifact_ready(trace_dir: pathlib.Path, event: dict[str, Any], field_key: str, name: str) -> bool:
    paths = artifact_paths(event, field_key, name)
    if not paths:
        # The complete scalar is already durable in the JSONL event.
        value = event.get(field_key, {}).get(name)
        return value is not None
    return all((trace_dir / path).is_file() for path in paths)


def event_urls(event: dict[str, Any]) -> list[str]:
    urls = [str(event.get(key)) for key in URL_KEYS if event.get(key)]
    # document.cookie events have page_url, unlike HTTP cookie events which
    # have host_url/channel_url. Do not let the initiator page override an
    # explicit request endpoint: that would stop on unrelated XHR/Fetch calls.
    if not urls and str(event.get("type") or "").startswith("cookie."):
        if event.get("page_url"):
            urls.append(str(event["page_url"]))
    return urls


def url_matches(event: dict[str, Any], url_contains: str) -> bool:
    return not url_contains or any(url_contains in url for url in event_urls(event))


def top_level_cookie_match(event: dict[str, Any], wanted: set[str]) -> str | None:
    if not wanted or not str(event.get("type") or "").startswith("cookie."):
        return None
    actual = str(event.get("key") or "")
    if actual.lower() not in wanted:
        return None
    value = event.get("value_preview")
    return actual if value is not None and str(value) != "" else None


def find_target(
    trace_dir: pathlib.Path,
    event: dict[str, Any],
    targets: dict[str, set[str]],
    source_file: str,
    url_contains: str = "",
) -> dict[str, Any] | None:
    if not url_matches(event, url_contains):
        return None
    for field_key in FIELD_KEYS:
        values = event.get(field_key)
        if not isinstance(values, dict):
            continue
        by_lower = {str(name).lower(): str(name) for name in values}
        for wanted in targets[field_key]:
            actual = by_lower.get(wanted)
            if actual is not None and artifact_ready(trace_dir, event, field_key, actual):
                return {
                    "field": actual,
                    "field_location": field_key.removesuffix("_fields"),
                    "event_type": str(event.get("type") or "unknown"),
                    "request_id": event.get("request_id"),
                    "url": next(iter(event_urls(event)), None),
                    "source_file": source_file,
                }
    cookie = top_level_cookie_match(event, targets["cookie_fields"])
    if cookie is not None:
        urls = event_urls(event)
        return {
            "field": cookie,
            "field_location": "cookie",
            "event_type": str(event.get("type") or "unknown"),
            "request_id": event.get("request_id") or event.get("channel_id"),
            "url": urls[0] if urls else None,
            "source_file": source_file,
        }
    return None


def may_contain_target(event: dict[str, Any], targets: dict[str, set[str]]) -> bool:
    for field_key in FIELD_KEYS:
        values = event.get(field_key)
        if not isinstance(values, dict):
            continue
        if not targets[field_key]:
            return True
        names = {str(name).lower() for name in values}
        if names & targets[field_key]:
            return True
    if top_level_cookie_match(event, targets["cookie_fields"]) is not None:
        return True
    return False


def segment_matches(event: dict[str, Any], active_segment: str) -> bool:
    """Accept legacy untagged events only for the initial trace segment.

    Cookie/network producers created before segment tagging can emit a null
    segment_id.  Rejecting those events makes the watchdog miss a real target
    in seg_001.  Later resumed segments remain strict so an old untagged event
    cannot stop a new segment.
    """
    if not active_segment:
        return True
    event_segment = str(event.get("segment_id") or "")
    if event_segment:
        return event_segment == active_segment
    return active_segment in {"seg_001", "seg_1", "1"}


class JsonlTail:
    def __init__(self) -> None:
        self.offsets: dict[pathlib.Path, int] = {}
        self.partials: dict[pathlib.Path, bytes] = {}

    def events(self, trace_dir: pathlib.Path):
        paths = sorted(
            set(trace_dir.glob("firefox-fetch-*.jsonl"))
            | set(trace_dir.glob("firefox-xhr-*.jsonl"))
            | set(trace_dir.glob("firefox-cookie-*.jsonl"))
        )
        for path in paths:
            try:
                size = path.stat().st_size
                offset = self.offsets.get(path, 0)
                if size < offset:
                    offset = 0
                    self.partials.pop(path, None)
                with path.open("rb") as stream:
                    stream.seek(offset)
                    chunk = stream.read()
                self.offsets[path] = size
            except OSError:
                continue
            if not chunk:
                continue
            data = self.partials.pop(path, b"") + chunk
            lines = data.split(b"\n")
            if not data.endswith(b"\n"):
                self.partials[path] = lines.pop()
            for raw in lines:
                if not raw.strip():
                    continue
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    yield path.name, event


def wait_for_ack(trace_dir: pathlib.Path, control: dict[str, Any], timeout: float) -> bool:
    path = trace_dir / "firefox-control-acks.jsonl"
    expected_version = control.get("version")
    expected_hash = control.get("config_hash")
    if expected_version is None:
        return False
    deadline = time.monotonic() + max(timeout, 0)
    while True:
        required: set[tuple[Any, Any]] = set()
        received: set[tuple[Any, Any]] = set()
        try:
            with path.open(encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if (event.get("control_version") != expected_version
                            or event.get("config_hash") != expected_hash):
                        continue
                    identity = (event.get("child_id"), event.get("pid"))
                    if event.get("type") == "trace.config.push" and event.get("detail") == "sent":
                        required.add(identity)
                    elif event.get("type") == "trace.config.applied":
                        received.add(identity)
            # Legacy runtimes do not emit push records. New runtimes must ACK
            # every successfully pushed child, not just an unrelated process.
            if received and (not required or required <= received):
                return True
        except OSError:
            pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def stop_and_finalize(args: argparse.Namespace, reason: str, detail: dict[str, Any], started: float) -> int:
    before = trace_size(args.trace_dir)
    stop_elapsed = time.monotonic() - started
    stop = subprocess.run(
        [str(args.control_script), str(args.trace_dir), "stop", reason],
        text=True,
        capture_output=True,
        check=False,
    )
    control = read_json(args.trace_dir / "trace-control.json")
    acknowledged = wait_for_ack(args.trace_dir, control, args.ack_seconds)
    finalized = subprocess.run(
        [args.python, str(args.finalize_script), str(args.trace_dir), "--json"],
        text=True,
        capture_output=True,
        check=False,
    )
    receipt = {
        "reason": reason,
        **detail,
        "bytes_at_stop": before,
        "stop_elapsed_seconds": round(stop_elapsed, 3),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "stop_sent": stop.returncode == 0,
        "stop_acknowledged": acknowledged,
        "finalized": finalized.returncode == 0,
    }
    if stop.returncode:
        receipt["stop_error"] = stop.stderr.strip()[-500:]
    if finalized.returncode:
        receipt["finalize_error"] = finalized.stderr.strip()[-500:]
    print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), flush=True)
    if stop.returncode or finalized.returncode:
        return 5
    if reason == "target-found" and not acknowledged:
        return 6
    return {"target-found": 0, "time-limit": 3, "size-limit": 4}[reason]


def main() -> int:
    args = parse_args()
    args.trace_dir = args.trace_dir.resolve()
    started = time.monotonic()
    tail = JsonlTail()
    targets: dict[str, set[str]] = {key: set() for key in FIELD_KEYS}
    pending: list[tuple[str, dict[str, Any]]] = []
    last_size_check = 0.0
    size = 0
    initial_control = read_json(args.trace_dir / "trace-control.json")
    active_segment = args.segment_id or str(initial_control.get("segment_id") or "")
    while True:
        manifest = read_json(args.trace_dir / "manifest.json")
        control = read_json(args.trace_dir / "trace-control.json")
        parsed = configured_fields(control)
        if not any(parsed.values()):
            parsed = configured_fields(manifest)
        if any(parsed.values()):
            targets = parsed
        new_events = list(tail.events(args.trace_dir))
        pending.extend(
            (source_file, event)
            for source_file, event in new_events
            if segment_matches(event, active_segment)
            and may_contain_target(event, targets)
        )
        still_pending: list[tuple[str, dict[str, Any]]] = []
        for source_file, event in pending:
            match = find_target(
                args.trace_dir,
                event,
                targets,
                source_file,
                args.url_contains,
            )
            if match:
                return stop_and_finalize(args, "target-found", match, started)
            if (
                url_matches(event, args.url_contains)
                and may_contain_target(event, targets)
            ):
                still_pending.append((source_file, event))
        pending = still_pending
        elapsed = time.monotonic() - started
        if args.max_seconds > 0 and elapsed >= args.max_seconds:
            return stop_and_finalize(args, "time-limit", {}, started)
        if elapsed - last_size_check >= 1.0 or last_size_check == 0.0:
            size = trace_size(args.trace_dir)
            last_size_check = elapsed
        if args.max_bytes > 0 and size >= args.max_bytes:
            return stop_and_finalize(args, "size-limit", {}, started)
        time.sleep(max(args.poll_ms, 10) / 1000)


if __name__ == "__main__":
    raise SystemExit(main())
