#!/usr/bin/env python3
"""Finalize a Firefox Trace run into agent-friendly categorized logs and indexes.

The browser keeps its low-level JSONL streams unchanged.  This post-stop pass
adds a stable, user-facing view under ``categorized/`` and ``index/``:

* DOM/BOM separation for binding events;
* normalized URL-query, request-header, cookie and request-body field records;
* JS, network, state, script, worker, WASM/VM and control buckets;
* target-field -> JS value -> environment context relations.

It is deliberately schema-tolerant so older trace directories remain usable.
"""

from __future__ import annotations

import argparse
import bisect
import collections
import hashlib
import json
import pathlib
import re
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable


VM_WINDOW_HEADER = struct.Struct("<8sIIQQQQIIQ")
VM_WINDOW_RECORD = struct.Struct("<QQQQQQIIIB16sBBB")


BOM_INTERFACES = {
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
    "RTCPeerConnection",
    "RTCRtpSender",
    "RTCRtpReceiver",
    "MediaDevices",
    "MediaQueryList",
    "StorageManager",
    "UserAgentData",
    "PluginArray",
    "MimeTypeArray",
}

GENERIC_TARGET_FIELDS = {
    "sign",
    "signature",
    "token",
    "riskdata",
    "fp",
    "nonce",
    "timestamp",
    "captchaid",
    "securitytoken",
    "antitoken",
    "authtoken",
    "checksum",
    "digest",
}

CATEGORY_NAMES = (
    "dom",
    "bom",
    "js",
    "network",
    "state",
    "script",
    "worker",
    "wasm-vm",
    "control-health",
    "request-fields",
)

WEB_ASSET_KEYWORDS = (
    "envcode",
    "ubcode",
    "_$webrt",
    "signature",
    "securityToken",
    "antiToken",
    "authToken",
    "getJsToken",
    "jsToken",
    "SHA256",
    "functionId",
    "fingerprint",
    "canvas",
    "webgl",
    "encrypt",
    "sign",
)

FUNCTION_DECL_RE = re.compile(
    r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\("
    r"|(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*[:=]\s*function\s*\(",
    re.S,
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def byte_size(value: str) -> int:
    return len(value.encode("utf-8"))


def load_manifest(trace_dir: pathlib.Path) -> dict[str, Any]:
    try:
        return json.loads((trace_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def target_fields(manifest: dict[str, Any]) -> set[str]:
    env = manifest.get("env") or {}
    raw_values = [
        env.get("TRACE_QUERY_FIELDS"),
        env.get("FIREFOX_TRACE_QUERY_FIELDS"),
        env.get("TRACE_BODY_FIELDS"),
        env.get("FIREFOX_TRACE_BODY_FIELDS"),
        env.get("TRACE_HEADER_FIELDS"),
        env.get("FIREFOX_TRACE_HEADER_FIELDS"),
        env.get("TRACE_COOKIE_FIELDS"),
        env.get("FIREFOX_TRACE_COOKIE_FIELDS"),
    ]
    disabled_tokens = {"__disabled__", "__off__", "off", "none", "false", "0"}
    explicitly_configured = any(raw is not None for raw in raw_values)
    values = {
        item.strip().lower()
        for raw in raw_values
        if raw
        for item in str(raw).replace(";", ",").split(",")
        if item.strip() and item.strip().lower() not in disabled_tokens
    }
    if values:
        return values
    return set() if explicitly_configured else set(GENERIC_TARGET_FIELDS)


def jsonl_rows(trace_dir: pathlib.Path) -> Iterable[tuple[pathlib.Path, int, dict[str, Any]]]:
    for path in sorted(trace_dir.glob("firefox-*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                yield path, line_number, row


def event_type(row: dict[str, Any]) -> str:
    return str(row.get("type") or "")


def classify_dom_interface(row: dict[str, Any]) -> str:
    interface = str(row.get("interface") or row.get("interface_name") or "")
    if interface in BOM_INTERFACES:
        return "bom"
    return "dom"


def classify_event(path: pathlib.Path, row: dict[str, Any]) -> str:
    typ = event_type(row)
    lower_path = path.name.lower()
    if "control" in lower_path or "ack" in lower_path or typ.startswith("trace."):
        return "control-health"
    if typ.startswith(("xhr.", "fetch.", "websocket.", "http.raw")):
        return "network"
    if typ.startswith(("cookie", "storage")) or "cookie" in lower_path or "storage" in lower_path:
        return "state"
    if typ.startswith(("script.",)) or "script" in lower_path:
        return "script"
    if typ.startswith(("wasm.", "js.opcode", "js.vm_step", "js.vm_window")):
        return "wasm-vm"
    if typ.startswith(("js.",)):
        return "js"
    if typ.startswith(("worker.",)) or str(row.get("process_type") or "").lower() == "worker":
        return "worker"
    if typ.startswith(("dom.",)) or "dom" in lower_path:
        return classify_dom_interface(row)
    return "control-health" if not typ else "network" if "request" in typ else "js"


def inspect_vm_window_artifact(trace_dir: pathlib.Path, row: dict[str, Any]) -> dict[str, Any]:
    relative = str(row.get("artifact_path") or "")
    result: dict[str, Any] = {
        "valid": False,
        "artifact_path": relative,
        "format": "ftvmw1-le",
    }
    if not relative:
        result["error"] = "missing_artifact_path"
        return result
    root = trace_dir.resolve()
    path = (trace_dir / relative).resolve()
    if path != root and root not in path.parents:
        result["error"] = "artifact_outside_trace_dir"
        return result
    try:
        size = path.stat().st_size
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            raw_header = stream.read(VM_WINDOW_HEADER.size)
            digest.update(raw_header)
            if len(raw_header) != VM_WINDOW_HEADER.size:
                result["error"] = "short_header"
                return result
            (
                magic,
                version,
                record_size,
                first_seq,
                last_seq,
                total_written,
                overwritten,
                capacity,
                count,
                trigger_ts_us,
            ) = VM_WINDOW_HEADER.unpack(raw_header)
            expected_size = VM_WINDOW_HEADER.size + count * record_size
            if magic.rstrip(b"\0") != b"FTVMW1":
                result["error"] = "bad_magic"
                return result
            if version != 1 or record_size != VM_WINDOW_RECORD.size:
                result["error"] = "unsupported_record_format"
                return result
            if size != expected_size:
                result["error"] = "artifact_size_mismatch"
                result["expected_size"] = expected_size
                result["actual_size"] = size
                return result
            expected_seq = first_seq
            for _ in range(count):
                raw_record = stream.read(record_size)
                digest.update(raw_record)
                seq = VM_WINDOW_RECORD.unpack(raw_record)[0]
                if seq != expected_seq:
                    result["error"] = "record_sequence_gap"
                    result["expected_seq"] = expected_seq
                    result["actual_seq"] = seq
                    return result
                expected_seq += 1
    except OSError as error:
        result["error"] = f"artifact_read_error:{error.strerror or error}"
        return result
    result.update(
        {
            "valid": True,
            "sha256": digest.hexdigest(),
            "size": size,
            "version": version,
            "record_size": record_size,
            "first_seq": first_seq,
            "last_seq": last_seq,
            "total_written": total_written,
            "pretrigger_overwritten": overwritten,
            "capacity": capacity,
            "record_count": count,
            "trigger_ts_us": trigger_ts_us,
            "sequence_complete": count == 0 or expected_seq - 1 == last_seq,
        }
    )
    return result


def compact_event(row: dict[str, Any], path: pathlib.Path, line: int, category: str) -> dict[str, Any]:
    result = dict(row)
    result["_category"] = category
    result["_source_file"] = path.name
    result["_source_line"] = line
    return result


def enrich_script_resource_identity(rows: list[dict[str, Any]]) -> dict[str, int]:
    """Join downloaded script resources to runtime JS events by URL.

    Script loading and SpiderMonkey call logging are separate streams.  A JS
    call can therefore carry a URL while the corresponding ``script.resource``
    row carries the only complete artifact hash.  Keep an existing engine hash
    authoritative; use the raw artifact hash only when the call stream omitted
    one, and label that provenance so agents do not confuse the two sources.
    """
    identities: dict[str, set[tuple[str, str]]] = collections.defaultdict(set)
    resource_count = 0
    for row in rows:
        if row.get("type") != "script.resource":
            continue
        raw_sha = str(row.get("raw_sha256") or "").strip()
        if not raw_sha:
            continue
        resource_count += 1
        artifact_path = str(row.get("artifact_path") or "")
        for key in ("url", "final_url", "original_url"):
            url = str(row.get(key) or "").strip()
            if url:
                identities[url].add((raw_sha, artifact_path))
        # Make the resource itself consumable by the same downstream indexes.
        row.setdefault("script_sha256", raw_sha)
        row["script_raw_sha256"] = raw_sha
        if artifact_path:
            row["script_artifact_path"] = artifact_path

    joined = 0
    ambiguous = 0
    for row in rows:
        if not str(row.get("script_url") or "").strip():
            continue
        matches = identities.get(str(row.get("script_url")).strip(), set())
        if not matches:
            continue
        if len(matches) != 1:
            ambiguous += 1
            continue
        raw_sha, artifact_path = next(iter(matches))
        row["script_raw_sha256"] = raw_sha
        if not str(row.get("script_sha256") or "").strip():
            row["script_sha256"] = raw_sha
            row["script_hash_source"] = "script.resource.raw_sha256"
            joined += 1
        if artifact_path:
            row["script_artifact_path"] = artifact_path

    return {
        "resource_hash_count": resource_count,
        "joined_event_count": joined,
        "ambiguous_event_count": ambiguous,
        "url_key_count": len(identities),
    }


def url_query_fields(url: str, wanted: set[str]) -> dict[str, str]:
    if not isinstance(url, str) or not url:
        return {}
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query, keep_blank_values=True)
    except ValueError:
        return {}
    return {
        name: values[-1] if values else ""
        for name, values in query.items()
        if name.lower() in wanted
    }


def header_value(entry: Any) -> str:
    if isinstance(entry, dict):
        value = entry.get("value")
        if value is None:
            value = entry.get("preview")
        return "" if value is None else str(value)
    return "" if entry is None else str(entry)


def request_header_fields(row: dict[str, Any], wanted: set[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    typ = str(row.get("type") or "")
    if typ == "xhr.header":
        name = str(row.get("detail_name") or "")
        value = str(row.get("detail_value") or "")
        if name and value and name.lower() in wanted:
            values[name] = value
    if typ in {"fetch.call", "fetch.request", "xhr.open", "xhr.send", "xhr.body"}:
        headers = row.get("headers")
        if isinstance(headers, dict):
            for name, entry in headers.items():
                if str(name).lower() in wanted:
                    values[str(name)] = header_value(entry)
    header_fields = row.get("header_fields")
    if isinstance(header_fields, dict):
        for name, value in header_fields.items():
            values[str(name)] = header_value(value)
    return values


def parse_cookie_header(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    if not isinstance(value, str) or not value:
        return result
    for part in value.split(";"):
        if not part.strip():
            continue
        if "=" not in part:
            continue
        name, val = part.split("=", 1)
        name = name.strip()
        if name:
            result[name] = val.strip()
    return result


def cookie_fields(row: dict[str, Any], wanted: set[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    typ = str(row.get("type") or "")

    def add(name: Any, value: Any) -> None:
        key = str(name or "").strip()
        if not key or key.lower() not in wanted:
            return
        values[key] = "" if value is None else str(value)

    # Cookie-related trace events: document.cookie, CookieStore, HTTP Set-Cookie,
    # and storage lifecycle all normalize to key/value_preview when a concrete
    # cookie name is known.
    if typ.startswith("cookie") or row.get("source") in {"document.cookie", "cookieStore", "http.set-cookie", "storage"}:
        key = row.get("key")
        if key:
            add(key, row.get("value_preview") or row.get("value") or "")
        elif isinstance(row.get("value_preview"), str):
            for key, value in parse_cookie_header(row["value_preview"]).items():
                add(key, value)
        if isinstance(row.get("header_preview"), str):
            for key, value in parse_cookie_header(row["header_preview"]).items():
                add(key, value)

    # Request Cookie header, when surfaced by XHR/fetch/request-header hooks.
    if typ == "xhr.header" and str(row.get("detail_name") or "").lower() == "cookie":
        for key, value in parse_cookie_header(str(row.get("detail_value") or "")).items():
            add(key, value)
    headers = row.get("headers")
    if isinstance(headers, dict):
        for name, entry in headers.items():
            if str(name).lower() == "cookie":
                for key, value in parse_cookie_header(header_value(entry)).items():
                    add(key, value)
    return values


def read_value_store(trace_dir: pathlib.Path, rel_path: str) -> str:
    if not rel_path:
        return ""
    try:
        candidate = trace_dir / rel_path
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return ""


def url_decode_chain(value: str) -> list[dict[str, Any]]:
    """Return stable URL-decoded forms for correlation without losing raw form."""
    forms: list[dict[str, Any]] = []
    current = value
    seen = {current}
    layer = 0
    while True:
        decoded = urllib.parse.unquote_plus(current)
        if decoded == current or decoded in seen:
            break
        layer += 1
        forms.append(
            {
                "form": "url_decoded" if layer == 1 else f"url_decoded_{layer}",
                "decode_layer": layer,
                "value": decoded,
                "sha256": sha256_text(decoded),
                "size": byte_size(decoded),
            }
        )
        seen.add(decoded)
        current = decoded
        if layer >= 16:
            break
    return forms


def composite_segments(value: str) -> list[dict[str, Any]]:
    """Split long composite fields into reusable segment hashes.

    This is intentionally generic: many signature/token fields are compound
    strings joined by delimiters, not just a single opaque value.
    """
    separators = [";", "|", ","]
    best_sep = ""
    best_parts: list[str] = []
    for sep in separators:
        parts = value.split(sep)
        meaningful = [part for part in parts if part]
        if len(meaningful) > len(best_parts):
            best_sep = sep
            best_parts = parts
    if len([part for part in best_parts if part]) <= 1:
        return []
    rows = []
    for index, part in enumerate(best_parts):
        if not part:
            continue
        rows.append(
            {
                "form": "segment",
                "separator": best_sep,
                "segment_index": index,
                "sha256": sha256_text(part),
                "size": byte_size(part),
                "preview": part[:512],
            }
        )
    return rows


def iter_field_records(
    row: dict[str, Any],
    path: pathlib.Path,
    line: int,
    wanted: set[str],
    trace_dir: pathlib.Path | None = None,
) -> Iterable[dict[str, Any]]:
    transport = "fetch" if "fetch" in path.name else "xhr" if "xhr" in path.name else "request"
    common = {
        "schema": "firefox_trace.field.v1",
        "type": "request.field",
        "ts_us": row.get("ts_us"),
        "pid": row.get("pid"),
        "segment_id": row.get("segment_id"),
        "control_version": row.get("control_version"),
        "request_id": row.get("request_id"),
        "origin_call_id": row.get("origin_call_id"),
        "caller_url": row.get("caller_url"),
        "url": row.get("url") or row.get("request_url"),
        "transport": transport,
        "_source_file": path.name,
        "_source_line": line,
    }

    emitted: set[tuple[str, str]] = set()

    def emit(location: str, name: str, value: Any, metadata: Any = None):
        normalized = str(name)
        if normalized.lower() not in wanted and not (isinstance(value, str) and len(value) >= 24):
            return
        meta = metadata if isinstance(metadata, dict) else {}
        if isinstance(value, (dict, list)):
            preview = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        elif value is None:
            preview = ""
        else:
            preview = str(value)
        digest = meta.get("sha256") or (sha256_text(preview) if preview else "")
        stored_value = ""
        store_path = str(meta.get("value_store_path") or "")
        if trace_dir is not None and store_path:
            stored_value = read_value_store(trace_dir, store_path)
        raw_value = stored_value if stored_value else preview
        raw_size = byte_size(raw_value)
        decoded_forms = url_decode_chain(raw_value)
        primary_decoded = decoded_forms[-1] if decoded_forms else None
        segment_source = str(primary_decoded["value"]) if primary_decoded else raw_value
        segments = composite_segments(segment_source)
        key = (location, normalized.lower())
        if key in emitted and not meta.get("value_store_path"):
            return
        emitted.add(key)
        record = dict(common)
        record.update(
            {
                "location": location,
                "field_name": normalized,
                "field_path": normalized,
                "value_preview": preview[:512],
                "value_size": meta.get("size", len(preview.encode("utf-8"))),
                "value_sha256": digest,
                "value_store_path": store_path,
                "value_stored": meta.get("stored"),
                "value_raw_preview": raw_value[:512],
                "value_raw_size": raw_size,
                "value_sha256_raw": sha256_text(raw_value) if raw_value else "",
                "value_decoded_preview": (primary_decoded["value"][:512] if primary_decoded else raw_value[:512]),
                "value_decoded_size": (primary_decoded["size"] if primary_decoded else raw_size),
                "value_sha256_decoded": (primary_decoded["sha256"] if primary_decoded else sha256_text(raw_value) if raw_value else ""),
                "encoding_status": "url_encoded" if primary_decoded else "plain",
                "decoded_forms": [
                    {key: val for key, val in item.items() if key != "value"}
                    | {"preview": str(item.get("value") or "")[:512]}
                    for item in decoded_forms
                ],
                "composite_segments": segments,
                "target": normalized.lower() in wanted,
                "high_entropy_candidate": len(preview) >= 24,
            }
        )
        yield record

    field_locations = {
        "query_fields": "url.query",
        "body_fields": "body",
        "header_fields": "headers",
        "cookie_fields": "cookies",
    }
    for key, location in field_locations.items():
        values = row.get(key)
        metadata = row.get(f"{key}_meta")
        if not isinstance(values, dict):
            continue
        for name, value in values.items():
            yield from emit(location, name, value, metadata.get(name) if isinstance(metadata, dict) else None)

    url = row.get("url") or row.get("request_url")
    if isinstance(url, str) and not row.get("query_fields"):
        for name, value in url_query_fields(url, wanted).items():
            yield from emit("url.query", name, value)

    if not row.get("header_fields"):
        for name, value in request_header_fields(row, wanted).items():
            yield from emit("headers", name, value)
    if not row.get("cookie_fields"):
        for name, value in cookie_fields(row, wanted).items():
            yield from emit("cookies", name, value)


def walk_sha_values(value: Any, path: str = "") -> Iterable[dict[str, str]]:
    if isinstance(value, dict):
        if isinstance(value.get("sha256"), str) and value.get("sha256"):
            yield {
                "sha256": value["sha256"],
                "value_store_path": str(value.get("value_store_path") or ""),
                "value_path": path,
            }
        for key, child in value.items():
            yield from walk_sha_values(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_sha_values(child, f"{path}[{index}]")


def value_text_from_field(field: dict[str, Any], trace_dir: pathlib.Path) -> str:
    stored = read_value_store(trace_dir, str(field.get("value_store_path") or ""))
    if stored:
        return stored
    return str(field.get("value_raw_preview") or field.get("value_preview") or "")


def build_environment_contract(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Produce a bounded replay ledger from DOM/BOM observations.

    The binding logger deliberately represents object values by class name.
    This index keeps that distinction explicit: scalar returns are restorable,
    while object observations are dependency evidence that needs a browser
    implementation rather than a JSON serialization.
    """
    observations: dict[str, dict[str, Any]] = {}
    objects: dict[str, dict[str, Any]] = {}
    member_contracts: dict[str, dict[str, Any]] = {}
    lifecycle_events: list[dict[str, Any]] = []
    missing_value_count = 0
    object_value_count = 0
    contract_event_count = 0
    contract_incomplete_count = 0
    async_result_calls = 0
    async_result_members: dict[str, int] = {}
    async_result_settlements = 0
    async_results: dict[str, list[dict[str, Any]]] = {}
    async_result_observations = 0
    async_result_observed_pending = 0
    async_result_fulfilled = 0
    async_result_rejected = 0
    promise_call_counts: dict[str, int] = collections.defaultdict(int)
    promise_settlement_counts: dict[str, int] = collections.defaultdict(int)
    promise_ledger: dict[str, dict[str, Any]] = {}
    dom_degraded = False
    contract_deduplicated_stream = False

    def add_object(contract: Any, row: dict[str, Any], role: str) -> str:
        nonlocal contract_incomplete_count
        if not isinstance(contract, dict):
            return ""
        object_id = str(contract.get("object_id") or "")
        if not object_id:
            return ""
        item = objects.setdefault(
            object_id,
            {
                "object_id": object_id,
                "class": contract.get("class") or "",
                "realm_id": contract.get("realm_id") or "",
                "prototype_chain": contract.get("prototype_chain") or [],
                "prototype_complete": contract.get("prototype_complete") is True,
                "observed_as": [],
                "access_count": 0,
                "first_ts_us": int(row.get("ts_us") or 0),
                "last_ts_us": int(row.get("ts_us") or 0),
            },
        )
        item["access_count"] += 1
        item["last_ts_us"] = max(int(item["last_ts_us"]), int(row.get("ts_us") or 0))
        if role not in item["observed_as"]:
            item["observed_as"].append(role)
        if contract.get("prototype_complete") is False:
            item["prototype_complete"] = False
            contract_incomplete_count += 1
        return object_id

    for row in rows:
        if row.get("contract_capture") in {"full", "reference"}:
            contract_deduplicated_stream = True
        if row.get("type") == "trace.degraded" and row.get("module") == "dom":
            dom_degraded = True
        if row.get("_category") not in {"bom", "dom"}:
            continue
        if row.get("type") == "dom.promise.observe":
            async_result_observations += 1
            promise_id = str(row.get("promise_id") or "")
            state = str(row.get("state") or "unknown")
            ledger = promise_ledger.setdefault(
                promise_id or f"observe_{async_result_observations}",
                {
                    "promise_id": promise_id,
                    "interface": row.get("interface") or "",
                    "member": row.get("member") or "",
                    "origin_call_id": row.get("origin_call_id") or "",
                    "observed_states": [],
                    "settlement_states": [],
                    "settlement_count": 0,
                    "call_count": 0,
                },
            )
            if state not in ledger["observed_states"]:
                ledger["observed_states"].append(state)
            if state == "pending":
                async_result_observed_pending += 1
            continue
        if row.get("type") == "dom.promise.settle":
            async_key = f"{row.get('interface')}.{row.get('member')}"
            async_result_settlements += 1
            state = str(row.get("state") or "unknown")
            promise_id = str(row.get("promise_id") or "")
            if promise_id:
                promise_settlement_counts[promise_id] += 1
                ledger = promise_ledger.setdefault(
                    promise_id,
                    {
                        "promise_id": promise_id,
                        "interface": row.get("interface") or "",
                        "member": row.get("member") or "",
                        "origin_call_id": row.get("origin_call_id") or "",
                        "observed_states": [],
                        "settlement_states": [],
                        "settlement_count": 0,
                        "call_count": 0,
                    },
                )
                ledger["settlement_count"] += 1
                if state not in ledger["settlement_states"]:
                    ledger["settlement_states"].append(state)
            if state == "fulfilled":
                async_result_fulfilled += 1
            elif state == "rejected":
                async_result_rejected += 1
            async_results.setdefault(async_key, []).append(
                {
                    "state": state,
                    "value": row.get("value"),
                    "promise_id": promise_id,
                    "origin_call_id": row.get("origin_call_id") or "",
                    "ts_us": int(row.get("ts_us") or 0),
                }
            )
            continue
        if row.get("type") == "dom.event.dispatch":
            lifecycle_events.append(
                {
                    "ts_us": int(row.get("ts_us") or 0),
                    "interface": row.get("interface") or "",
                    "event_type": row.get("event_type") or "",
                    "dispatch_phase": row.get("dispatch_phase") or "",
                    "target_object_id": row.get("target_object_id") or "",
                    "native_target_id": row.get("native_target_id") or "",
                }
            )
            continue
        receiver_id = add_object(row.get("receiver_contract"), row, "receiver")
        value_id = add_object(row.get("value_object_contract"), row, "value")
        if (row.get("type") in {"dom.call", "dom.construct"}
                and row.get("value_kind") == "object"
                and row.get("value_preview") == "Promise"):
            async_result_calls += 1
            async_key = f"{row.get('interface')}.{row.get('member')}"
            async_result_members[async_key] = async_result_members.get(async_key, 0) + 1
            promise_id = str(row.get("promise_id") or "")
            if promise_id:
                promise_call_counts[promise_id] += 1
                ledger = promise_ledger.setdefault(
                    promise_id,
                    {
                        "promise_id": promise_id,
                        "interface": row.get("interface") or "",
                        "member": row.get("member") or "",
                        "origin_call_id": row.get("origin_call_id") or "",
                        "observed_states": [],
                        "settlement_states": [],
                        "settlement_count": 0,
                        "call_count": 0,
                    },
                )
                ledger["call_count"] += 1
        argument_ids = [
            object_id
            for arg in row.get("args") or []
            if isinstance(arg, dict)
            if (object_id := add_object(arg.get("object_contract"), row, "argument"))
        ]
        if receiver_id:
            contract_event_count += 1
            interface = str(row.get("interface") or "")
            member = str(row.get("member") or "")
            operation = str(row.get("type") or "")
            member_key = f"{interface}.{member}" if interface and member else ""
            if member_key:
                descriptor = row.get("member_descriptor")
                member_item = member_contracts.setdefault(
                    member_key,
                    {
                        "interface": interface,
                        "member": member,
                        "operations": [],
                        "descriptor": descriptor if isinstance(descriptor, dict) else None,
                        "receiver_object_ids": [],
                        "value_object_ids": [],
                        "argument_object_ids": [],
                        "origin_call_ids": [],
                        "access_count": 0,
                    },
                )
                member_item["access_count"] += 1
                if operation and operation not in member_item["operations"]:
                    member_item["operations"].append(operation)
                if receiver_id not in member_item["receiver_object_ids"]:
                    member_item["receiver_object_ids"].append(receiver_id)
                if value_id and value_id not in member_item["value_object_ids"]:
                    member_item["value_object_ids"].append(value_id)
                for argument_id in argument_ids:
                    if argument_id not in member_item["argument_object_ids"]:
                        member_item["argument_object_ids"].append(argument_id)
                origin_call_id = row.get("origin_call_id")
                if origin_call_id and origin_call_id not in member_item["origin_call_ids"]:
                    member_item["origin_call_ids"].append(origin_call_id)
        if row.get("type") != "dom.get":
            continue
        interface = str(row.get("interface") or "")
        member = str(row.get("member") or "")
        if not interface or not member:
            continue
        key = f"{interface}.{member}"
        item = observations.setdefault(
            key,
            {
                "interface": interface,
                "member": member,
                "category": row.get("_category"),
                "access_count": 0,
                "value_kind": "unknown",
                "value": None,
                "restorable": False,
                "last_ts_us": 0,
            },
        )
        item["access_count"] += 1
        item["last_ts_us"] = max(int(item["last_ts_us"]), int(row.get("ts_us") or 0))
        if row.get("value_preview_enabled") is False:
            missing_value_count += 1
            continue
        kind = str(row.get("value_kind") or "unknown")
        value = row.get("value_preview")
        value_store_path = str(row.get("value_store_path") or "")
        value_stored = row.get("value_stored") is True and bool(value_store_path)
        value_truncated = row.get("value_preview_truncated") is True
        item["value_kind"] = kind
        item["value"] = value
        if value_store_path:
            item["value_store_path"] = value_store_path
            item["value_stored"] = value_stored
        if row.get("value_size") is not None:
            item["value_size"] = row.get("value_size")
        item["restorable"] = kind in {"undefined", "null", "boolean", "number", "string"} and (
            not value_truncated or value_stored
        )
        if value_truncated and not value_stored:
            missing_value_count += 1
        if kind == "object":
            object_value_count += 1

    for promise_id, count in promise_call_counts.items():
        if promise_id in promise_ledger:
            promise_ledger[promise_id]["call_count"] = count
    for promise_id, count in promise_settlement_counts.items():
        if promise_id in promise_ledger:
            promise_ledger[promise_id]["settlement_count"] = count
    tracked_promises = [
        promise_id
        for promise_id, count in promise_call_counts.items()
        if count > 0
    ]
    async_result_values_captured = all(
        promise_settlement_counts.get(promise_id, 0)
        >= promise_call_counts.get(promise_id, 0)
        for promise_id in tracked_promises
    )
    if async_result_calls and not tracked_promises:
        # Older traces have no promise_id. Preserve their previous aggregate
        # semantics while clearly exposing that exact pairing is unavailable.
        async_result_values_captured = async_result_settlements >= async_result_calls
    async_result_pending = sum(
        max(0, promise_call_counts.get(promise_id, 0)
            - promise_settlement_counts.get(promise_id, 0))
        for promise_id in tracked_promises
    )

    values = dict(sorted(observations.items()))
    return {
        "schema": "firefox_trace.environment_contract.v2",
        "source": "categorized DOM/BOM binding observations",
        "values": values,
        "objects": dict(sorted(objects.items())),
        "members": dict(sorted(member_contracts.items())),
        "async_results": dict(sorted(async_results.items())),
        "promise_ledger": dict(sorted(promise_ledger.items())),
        "lifecycle_events": sorted(lifecycle_events, key=lambda item: item["ts_us"]),
        "coverage": {
            "observed_members": len(values),
            "restorable_members": sum(1 for item in values.values() if item["restorable"]),
            "object_members": sum(1 for item in values.values() if item["value_kind"] == "object"),
            "missing_value_events": missing_value_count,
            "object_value_events": object_value_count,
            "value_capture_complete": missing_value_count == 0,
            "object_contract_events": contract_event_count,
            "object_contract_objects": len(objects),
            "object_contract_members": len(member_contracts),
            "lifecycle_event_count": len(lifecycle_events),
            "object_contract_incomplete_events": contract_incomplete_count,
            "async_result_calls": async_result_calls,
            "async_result_observations": async_result_observations,
            "async_result_observed_pending": async_result_observed_pending,
            "async_result_pending": async_result_pending,
            "async_result_fulfilled": async_result_fulfilled,
            "async_result_rejected": async_result_rejected,
            "async_result_settlements": async_result_settlements,
            "async_result_members": dict(sorted(async_result_members.items())),
            "async_result_values_captured": async_result_values_captured,
            "contract_deduplicated_stream": contract_deduplicated_stream,
            "object_contract_complete": (
                contract_event_count > 0
                and contract_incomplete_count == 0
                and (contract_deduplicated_stream or not dom_degraded)
            ),
        },
        "notes": [
            "Scalar getter values can seed an offline replay host.",
            "Object entries form a non-recursive reference graph of accessed browser objects.",
            "Member descriptors are engine metadata; capturing them does not invoke page getters.",
            "A false value_capture_complete means this trace can locate dependencies but cannot prove an exact offline host replay.",
            "A false object_contract_complete means object shape or DOM event evidence was incomplete.",
            "A false async_result_values_captured means DOM returned one or more Promises but their fulfillment values were not captured.",
            "promise_ledger distinguishes an observed pending Promise from one that settled after the stop boundary.",
            "Deduplicated contract streams retain first-seen object metadata before hot-member sampling.",
        ],
    }


def _manifest_env(manifest: dict[str, Any]) -> dict[str, str]:
    raw = manifest.get("env") or {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items() if value is not None}


def build_trace_health(
    manifest: dict[str, Any],
    rows: Iterable[dict[str, Any]],
    field_rows: Iterable[dict[str, Any]],
    environment_contract: dict[str, Any],
) -> dict[str, Any]:
    """Separate page execution from trace evidence completeness.

    Trace limits are observer-side policies. They may remove evidence, but
    they must not be interpreted as changing the page's JS/DOM/network result.
    Every explicit loss signal is retained in a compact, machine-readable list.
    """
    all_rows = list(rows)
    all_fields = list(field_rows)
    env = _manifest_env(manifest)
    incomplete: list[str] = []
    triggers: list[dict[str, Any]] = []
    seen_reasons: set[str] = set()

    def add_trigger(reason: str, row: dict[str, Any] | None = None, **extra: Any) -> None:
        reason = str(reason)
        if reason not in seen_reasons:
            seen_reasons.add(reason)
            incomplete.append(reason)
        item: dict[str, Any] = {"reason": reason}
        if row:
            for key in ("type", "module", "ts_us", "pid", "segment_id", "control_version", "config_hash"):
                if row.get(key) is not None:
                    item[key] = row.get(key)
            for key in (
                "limit", "count", "dropped", "dropped_bytes", "skipped_by_window",
                "dropped_before_flush", "captured_size", "capture_truncated",
                "raw_captured_size", "raw_capture_limit", "value_store_skipped",
            ):
                if row.get(key) is not None:
                    item[key] = row.get(key)
        item.update(extra)
        triggers.append(item)

    def nested_truncations(value: Any, path: str = "") -> Iterable[str]:
        if isinstance(value, dict):
            # A preview may be deliberately shorter than the request/module,
            # while a sibling artifact contains the complete bytes. Treat the
            # preview as complete evidence when that artifact is present and
            # itself was not truncated. This covers JS values, Fetch/XHR body
            # stores, field value stores and full WASM dumps.
            artifact_specs = (
                # These flags describe a complete sidecar even when the
                # inline preview itself is marked truncated.
                ("value_stored", "value_store_path", None),
                ("bytes_stored", "bytes_store_path", None),
                ("body_value_stored", "body_value_store_path", "body_value_truncated"),
                ("request_body_stored", "request_body_store_path", "request_body_truncated"),
                ("response_body_stored", "response_body_store_path", "response_body_truncated"),
                ("stored", "value_store_path", None),
                ("dump_stored", "artifact_path", "dump_truncated"),
            )
            complete_artifacts = {
                flag
                for flag, path_key, truncated_key in artifact_specs
                if value.get(flag) is True
                and bool(str(value.get(path_key) or ""))
                and (truncated_key is None or value.get(truncated_key) is not True)
            }
            has_complete_value_artifact = bool(complete_artifacts)
            def artifact_covers_truncation(key: str) -> bool:
                if "value_stored" in complete_artifacts or "bytes_stored" in complete_artifacts:
                    return key in {"value_preview_truncated", "bytes_truncated"}
                if "body_value_stored" in complete_artifacts or "request_body_stored" in complete_artifacts or "response_body_stored" in complete_artifacts:
                    return key in {"body_preview_truncated", "truncated", "request_body_truncated", "response_body_truncated"}
                if "stored" in complete_artifacts:
                    return key == "truncated"
                if "dump_stored" in complete_artifacts:
                    return key == "bytecode_preview_truncated"
                return False
            for key, child in value.items():
                child_path = f"{path}.{key}" if path else str(key)
                is_truncation = (
                    str(key).endswith("_truncated")
                    or key in {"truncated", "capture_truncated"}
                )
                if child is True and is_truncation:
                    if not (has_complete_value_artifact and artifact_covers_truncation(str(key))):
                        yield child_path
                yield from nested_truncations(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                yield from nested_truncations(child, f"{path}[{index}]")

    for row in all_rows:
        typ = str(row.get("type") or "")
        if typ == "trace.degraded":
            module = str(row.get("module") or "unknown")
            reason = str(row.get("reason") or "unknown")
            add_trigger(f"{module}:{reason}", row)
        elif typ == "trace.suppressed":
            add_trigger(
                f"{str(row.get('module') or 'unknown')}:suppressed:{str(row.get('reason') or 'unknown')}",
                row,
            )
        elif typ == "js.boundary.flush_summary" and row.get("complete_window") is False:
            add_trigger("js:boundary_window_incomplete", row)
        elif typ == "js.vm_window":
            validation = row.get("artifact_validation") or {}
            if not validation.get("valid"):
                add_trigger(
                    "vm_window:artifact_invalid",
                    row,
                    artifact_error=validation.get("error", "unknown"),
                )

        # Preview truncation is harmless only if the same record carries a
        # complete value artifact. Nested JS arguments/returns are evidence
        # too, so inspect the complete event tree rather than only top-level
        # fields.
        for path in nested_truncations(row):
            add_trigger(f"{typ or 'event'}:{path}", row)
        # ``below_min_bytes`` is an artifact-storage optimization. In
        # particular, an empty string is fully represented by value_preview=""
        # and has no bytes that could be lost. A storage-skip marker therefore
        # is evidence loss only when a separate truncation marker says the
        # inline value is incomplete (handled directly above).
        if row.get("args_truncated") is True:
            add_trigger(f"{typ or 'event'}:args_truncated", row)
        if row.get("object_values") and isinstance(row.get("object_values"), dict):
            if row["object_values"].get("_truncated") is True:
                add_trigger(f"{typ or 'event'}:object_values_truncated", row)

    coverage = environment_contract.get("coverage") or {}
    dom_enabled = str(env.get("TRACE_DOM", env.get("FIREFOX_TRACE_DOM", "1"))).lower() not in {
        "0", "false", "off", "none"
    }
    dom_rows = [row for row in all_rows if str(row.get("_category") or "") in {"dom", "bom"}]
    if dom_enabled and dom_rows:
        if coverage.get("value_capture_complete") is False:
            add_trigger("environment:value_capture_incomplete")
        if env.get("TRACE_DOM_CONTRACT") or env.get("FIREFOX_TRACE_DOM_CONTRACT"):
            if coverage.get("object_contract_complete") is False:
                add_trigger("environment:object_contract_incomplete")
    # A Promise still pending when the operator stops a trace is an observed
    # final state, not a dropped value. Treat it as incomplete only when no
    # promise remains pending yet the ledger still lacks a required settlement.
    pending_promises = int(coverage.get("async_result_pending", 0) or 0)
    if (
        coverage.get("async_result_calls", 0)
        and coverage.get("async_result_values_captured") is False
        and not pending_promises
    ):
        add_trigger("environment:promise_settlement_incomplete")

    target_without_store = 0
    for field in all_fields:
        if not field.get("target"):
            continue
        raw_size = int(field.get("value_raw_size") or field.get("value_size") or 0)
        preview = str(field.get("value_raw_preview") or field.get("value_preview") or "")
        if raw_size > len(preview.encode("utf-8")) and not field.get("value_store_path"):
            target_without_store += 1
    if target_without_store:
        add_trigger("request:target_value_without_complete_artifact", count=target_without_store)

    target_env_names = (
        "TRACE_QUERY_FIELDS",
        "FIREFOX_TRACE_QUERY_FIELDS",
        "TRACE_BODY_FIELDS",
        "FIREFOX_TRACE_BODY_FIELDS",
        "TRACE_HEADER_FIELDS",
        "FIREFOX_TRACE_HEADER_FIELDS",
        "TRACE_COOKIE_FIELDS",
        "FIREFOX_TRACE_COOKIE_FIELDS",
    )
    disabled_targets = {"", "__disabled__", "__off__", "off", "none", "false", "0"}
    configured_targets = {
        item.strip().lower()
        for name in target_env_names
        for item in str(env.get(name) or "").replace(";", ",").split(",")
        if item.strip().lower() not in disabled_targets
    }
    target_matches = sum(1 for field in all_fields if field.get("target"))
    if configured_targets and not target_matches:
        add_trigger(
            "request:configured_target_not_observed",
            configured_targets=sorted(configured_targets),
        )

    config_ack_count = sum(
        1 for row in all_rows if row.get("type") == "trace.config.applied"
    )
    if configured_targets and not config_ack_count:
        add_trigger("control:runtime_config_not_acknowledged")

    vm_window_enabled = str(
        env.get("TRACE_VM_WINDOW", env.get("FIREFOX_TRACE_VM_WINDOW", "0"))
    ).lower() not in {"", "0", "false", "off", "none"}
    vm_window_artifacts = sum(
        1 for row in all_rows if row.get("type") == "js.vm_window"
    )
    if vm_window_enabled and not vm_window_artifacts:
        add_trigger("vm_window:artifact_not_emitted")

    # Keep configured policy visible without treating an unset variable as a
    # hidden cap. Zero, false, none and empty are the documented unlimited/off
    # values for the relevant limits.
    limit_names = (
        "LIMIT", "MAX_BYTES", "MAX_COUNT", "POOL_BYTES", "BUFFER_EVENTS",
        "RATE", "DEPTH", "KEYS", "ITEMS", "CHUNK_EVENTS",
    )
    configured_limits = {
        key: value
        for key, value in sorted(env.items())
        if any(token in key.upper() for token in limit_names)
    }
    return {
        "schema": "firefox_trace.health.v1",
        "evidence_complete": not incomplete,
        "runtime_behavior_unchanged": True,
        "runtime_behavior_check": "observer_only_design",
        "runtime_behavior_note": (
            "limits gate trace formatting, observer delivery, or artifact storage; "
            "they do not gate JS/DOM/network execution"
        ),
        "incomplete_reasons": incomplete,
        "limit_triggers": triggers,
        "configured_limits": configured_limits,
        "counts": {
            "raw_events": len(all_rows),
            "trace_degraded": sum(1 for row in all_rows if row.get("type") == "trace.degraded"),
            "trace_suppressed": sum(1 for row in all_rows if row.get("type") == "trace.suppressed"),
            "target_fields_without_complete_artifact": target_without_store,
            "target_field_matches": target_matches,
            "runtime_config_acks": config_ack_count,
            "vm_window_artifacts": vm_window_artifacts,
            "dom_bom_events": len(dom_rows),
        },
        "environment_coverage": coverage,
        "notes": [
            "evidence_complete=false means only the affected evidence claim is incomplete; it does not mean the page action did not run",
            "runtime_behavior_unchanged is a trace-hook design assertion, not a byte-for-byte page replay proof",
            "unset DOM/BOM limits are represented by absence from configured_limits; explicit zero remains unlimited",
        ],
    }


def target_value_forms(field: dict[str, Any], trace_dir: pathlib.Path) -> list[dict[str, Any]]:
    raw = value_text_from_field(field, trace_dir)
    forms: list[dict[str, Any]] = []
    if raw:
        forms.append(
            {
                "form": "raw",
                "value": raw,
                "sha256": sha256_text(raw),
                "size": byte_size(raw),
            }
        )
    for item in url_decode_chain(raw):
        forms.append(item)
    decoded = forms[-1]["value"] if forms else raw
    for segment in composite_segments(decoded):
        preview = str(segment.get("preview") or "")
        forms.append(
            {
                "form": "segment",
                "value": preview,
                "sha256": segment.get("sha256"),
                "size": segment.get("size"),
                "separator": segment.get("separator"),
                "segment_index": segment.get("segment_index"),
            }
        )
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in forms:
        digest = str(item.get("sha256") or "")
        form = str(item.get("form") or "")
        key = (form, digest)
        if digest and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def public_value_form(item: dict[str, Any]) -> dict[str, Any]:
    return {key: val for key, val in item.items() if key != "value"} | {
        "preview": str(item.get("value") or "")[:512]
    }


def dedupe_matches(matches: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for item in matches:
        key = (
            item.get("match_type"),
            item.get("source_file"),
            item.get("source_line"),
            item.get("call_id"),
            item.get("value_store_path"),
            item.get("value_path"),
            item.get("target_form"),
            item.get("segment_index"),
        )
        if key in seen:
            continue
        seen.add(key)
        rows.append(item)
    return rows


def write_jsonl(path: pathlib.Path, rows: Iterable[dict[str, Any]]) -> int:
    count = 0
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    return count


def safe_asset_name(url: str, fallback: str = "asset") -> str:
    parsed = urllib.parse.urlsplit(url)
    stem = (parsed.netloc + parsed.path).strip("/") or fallback
    stem = re.sub(r"[^A-Za-z0-9_.@=-]+", "__", stem)[:180].strip("._")
    if not stem:
        stem = fallback
    if parsed.query:
        stem += "__q_" + hashlib.sha256(parsed.query.encode()).hexdigest()[:10]
    return stem


def http_get_bytes(url: str, timeout: float = 12.0, max_bytes: int = 8 * 1024 * 1024) -> tuple[bytes, dict[str, str], str]:
    request = urllib.request.Request(
        url,
        headers={
            "user-agent": "Mozilla/5.0 FirefoxTrace/1.0",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - local trace asset capture
        final_url = response.geturl()
        headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
        chunks = []
        total = 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                chunks.append(chunk[: max_bytes - (total - len(chunk))])
                break
            chunks.append(chunk)
        return b"".join(chunks), headers, final_url


def html_script_urls(html: str, base_url: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    patterns = (
        r"<script[^>]+src=[\"']([^\"']+)[\"']",
        r"[\"']((?:https?:)?//[^\"']+?\.js(?:\?[^\"']*)?)[\"']",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, html, re.I):
            url = urllib.parse.urljoin(base_url, match.group(1))
            if url not in seen and urllib.parse.urlsplit(url).scheme in {"http", "https"}:
                seen.add(url)
                urls.append(url)
    return urls


def asset_keyword_hits(text: str) -> dict[str, dict[str, Any]]:
    hits: dict[str, dict[str, Any]] = {}
    lower = text.lower()
    for keyword in WEB_ASSET_KEYWORDS:
        count = lower.count(keyword.lower())
        if count:
            first = lower.find(keyword.lower())
            hits[keyword] = {"count": count, "first_offset": first}
    return hits


def target_context_markers(wanted: set[str]) -> dict[str, int]:
    """Return marker -> weight used to locate producer functions in JS assets."""
    markers: dict[str, int] = {}
    for item in wanted:
        value = str(item or "").strip()
        if value:
            markers[value] = max(markers.get(value, 0), 850)
    # These are not site names; they are generic VM/environment payload names
    # that become strong only when found inside/near a target-family function.
    markers.update({"envcode": 180, "ubcode": 180, "_$webrt": 220})
    return markers


def line_and_absolute_column(text: str, offset: int) -> tuple[int, int]:
    """SpiderMonkey's reported column for minified assets tracks source offset.

    In captured Firefox traces the function JSScript column is consistently the
    function keyword offset plus a small parser offset.  Keep this estimate in
    the index so the next pass can pin one target function without the user
    guessing PC ranges.
    """
    return text.count("\n", 0, max(0, offset)) + 1, max(0, offset) + 3


def extract_target_functions_from_text(
    text: str, wanted: set[str], max_items: int = 8
) -> list[dict[str, Any]]:
    """Find likely target producer functions from downloaded JS content.

    This is intentionally generic: it scans marker context and attributes the
    hit to the nearest named function declaration in the same minified region.
    The result feeds a second trace pass with function/script-column hints.
    """
    if not text:
        return []
    markers = target_context_markers(wanted)
    if not markers:
        return []

    decls: list[dict[str, Any]] = []
    for match in FUNCTION_DECL_RE.finditer(text):
        name = match.group(1) or match.group(2) or ""
        if not name:
            continue
        start = match.start(1) - len("function ") if match.group(1) else match.start()
        if start < 0:
            start = match.start()
        line, column = line_and_absolute_column(text, start)
        decls.append(
            {
                "name": name,
                "source_offset": start,
                "script_line": line,
                "script_column": column,
            }
        )
    if not decls:
        return []

    lower = text.lower()
    indexed_markers = [(marker, marker.lower(), weight) for marker, weight in markers.items()]
    by_key: dict[tuple[str, int], dict[str, Any]] = {}

    for index, decl in enumerate(decls):
        start = int(decl["source_offset"])
        end = int(decls[index + 1]["source_offset"]) if index + 1 < len(decls) else min(len(text), start + 120_000)
        if end <= start:
            continue
        region_lower = lower[start:end]
        score = 0
        hits: list[dict[str, Any]] = []
        for marker, marker_lower, weight in indexed_markers:
            pos = region_lower.find(marker_lower)
            if pos < 0:
                continue
            absolute = start + pos
            score += weight
            hits.append(
                {
                    "marker": marker,
                    "offset": absolute,
                    "distance": absolute - start,
                }
            )
        if not hits:
            continue

        hit_names = {str(hit["marker"]).lower() for hit in hits}
        has_target_family = bool(hit_names & {str(item).lower() for item in wanted})
        has_vm_env = bool(hit_names & {"envcode", "ubcode", "_$webrt"})
        if has_target_family and has_vm_env:
            score += 420

        # Prefer compact producer bodies over giant wrappers when marker scores
        # tie, but keep wrappers as secondary candidates.
        span = end - start
        score -= min(180, span // 1500)
        key = (str(decl["name"]), start)
        by_key[key] = {
            **decl,
            "score": int(score),
            "markers": hits[:8],
            "reason": "target field context"
            + (" + vm/env markers" if has_vm_env else ""),
            "estimated": True,
        }

    candidates = sorted(
        by_key.values(),
        key=lambda row: (
            -int(row.get("score") or 0),
            int((row.get("markers") or [{}])[0].get("distance") or 0),
            int(row.get("source_offset") or 0),
        ),
    )
    return candidates[:max_items]


def asset_target_functions(
    trace_dir: pathlib.Path, asset: dict[str, Any], wanted: set[str]
) -> list[dict[str, Any]]:
    existing = asset.get("target_functions")
    if isinstance(existing, list) and existing:
        return [item for item in existing if isinstance(item, dict)]
    rel = str(asset.get("path") or "")
    if not rel:
        return []
    try:
        text = (trace_dir / rel).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    return extract_target_functions_from_text(text, wanted)


def asset_target_signal_score(asset: dict[str, Any], wanted: set[str]) -> tuple[float, list[str]]:
    """Score downloaded JS artifacts that look like target-field producers.

    Request wrappers often own the XHR caller frame while the actual signing SDK
    lives in a separately downloaded script.  This pass promotes script-content
    evidence, without requiring the user to know a script keyword.
    """
    hits = asset.get("keyword_hits")
    if not isinstance(hits, dict):
        return 0.0, []
    url = str(asset.get("url") or asset.get("final_url") or "")
    url_lower = url.lower()
    hit_keys = {str(key) for key in hits}
    hit_lower = {key.lower() for key in hit_keys}
    score = 0.0
    reasons: list[str] = []

    generic_security_hits = {
        "signature",
        "securitytoken",
        "antitoken",
        "authtoken",
        "getjstoken",
        "jstoken",
        "sha256",
        "functionid",
        "fingerprint",
        "encrypt",
        "sign",
    }
    matched_generic = sorted(hit_lower & generic_security_hits)
    if matched_generic:
        score += min(180.0, 18.0 * sum(int(hits[key].get("count") or 1) for key in hit_keys if key.lower() in matched_generic))
        reasons.append("script content security keywords")

    # JSVMP/encoded interpreter markers: promote strongly when they co-occur
    # with target-family or signing markers, but do not require site-specific names.
    vm_hits = hit_lower & {"_$webrt", "envcode", "ubcode"}
    if vm_hits:
        score += 360.0 + 90.0 * len(vm_hits)
        reasons.append("script content contains VM/environment markers")

    if any(token in url_lower for token in ("security", "risk", "captcha")):
        score += 160.0
        reasons.append("script URL looks like security SDK")

    return score, reasons


def collect_trace_asset_urls(manifest: dict[str, Any], rows: list[dict[str, Any]]) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()

    def add(url: Any):
        if not isinstance(url, str) or not url.strip():
            return
        item = urllib.parse.urljoin(str(manifest.get("target_url") or ""), url.strip())
        parsed = urllib.parse.urlsplit(item)
        if parsed.scheme not in {"http", "https"}:
            return
        path = parsed.path.lower()
        is_script_path = bool(
            re.search(r"\.(?:js|mjs|cjs)(?:$|/)", path)
            or re.search(r"(?:^|[/_-])javascript(?:$|[/_-])", path)
        )
        if is_script_path:
            if item not in seen:
                seen.add(item)
                urls.append(item)

    for row in rows:
        for key in ("caller_url", "script_url", "url", "request_url", "source_url", "resolved_url"):
            add(row.get(key))
    return urls


def download_web_assets(
    trace_dir: pathlib.Path,
    manifest: dict[str, Any],
    rows: list[dict[str, Any]],
    wanted: set[str] | None = None,
    max_scripts: int = 80,
) -> dict[str, Any]:
    target_url = str(manifest.get("target_url") or "")
    assets_dir = trace_dir / "web-assets"
    html_dir = assets_dir / "html"
    js_dir = assets_dir / "js"
    html_dir.mkdir(parents=True, exist_ok=True)
    js_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "schema": "firefox_trace.web_assets.v1",
        "target_url": target_url,
        "created_at_unix": int(time.time()),
        "html": None,
        "scripts": [],
        "errors": [],
        "keyword_index_path": "index/web-assets.json",
    }

    script_urls: list[str] = []
    seen_scripts: set[str] = set()

    def add_script(url: str):
        if url not in seen_scripts and urllib.parse.urlsplit(url).scheme in {"http", "https"}:
            seen_scripts.add(url)
            script_urls.append(url)

    if urllib.parse.urlsplit(target_url).scheme in {"http", "https"}:
        try:
            html_bytes, headers, final_url = http_get_bytes(target_url, max_bytes=4 * 1024 * 1024)
            html_path = html_dir / (safe_asset_name(final_url, "target") + ".html")
            html_path.write_bytes(html_bytes)
            html_text = html_bytes.decode(headers.get("content-encoding") or "utf-8", errors="ignore")
            if "<" not in html_text[:256]:
                html_text = html_bytes.decode("utf-8", errors="ignore")
            for url in html_script_urls(html_text, final_url):
                add_script(url)
            result["html"] = {
                "url": target_url,
                "final_url": final_url,
                "path": str(html_path.relative_to(trace_dir)),
                "size": len(html_bytes),
                "sha256": hashlib.sha256(html_bytes).hexdigest(),
                "script_count": len(script_urls),
            }
        except Exception as error:  # noqa: BLE001 - keep finalize best-effort
            result["errors"].append({"url": target_url, "stage": "html", "error": str(error)})

    for url in collect_trace_asset_urls(manifest, rows):
        add_script(url)

    for index, url in enumerate(script_urls[:max_scripts], 1):
        path = js_dir / f"{index:03d}__{safe_asset_name(url, 'script')}"
        if not path.name.endswith(".js"):
            path = path.with_suffix(path.suffix + ".js" if path.suffix else ".js")
        try:
            data, headers, final_url = http_get_bytes(url, max_bytes=8 * 1024 * 1024)
            path.write_bytes(data)
            text = data.decode("utf-8", errors="ignore")
            item = {
                "url": url,
                "final_url": final_url,
                "path": str(path.relative_to(trace_dir)),
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "content_type": headers.get("content-type", ""),
                "keyword_hits": asset_keyword_hits(text),
            }
            target_functions = extract_target_functions_from_text(text, wanted or set())
            if target_functions:
                item["target_functions"] = target_functions
            result["scripts"].append(item)
        except Exception as error:  # noqa: BLE001
            result["errors"].append({"url": url, "stage": "script", "error": str(error)})

    return result


def script_match_token(script_url: str) -> str:
    """Return a stable, URL-safe substring for the opcode hook.

    The runtime needs a cheap substring filter before it can emit opcode
    events.  The user should not have to invent that substring, so derive it
    from the script identity captured in the request caller/call chain.
    """
    parsed = urllib.parse.urlsplit(script_url)
    path = parsed.path.rstrip("/")
    name = pathlib.PurePosixPath(path).name
    if name:
        return name
    return parsed.netloc or script_url


def _int_value(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def opcode_identity_for_script(
    rows: list[dict[str, Any]], script_url: str, script_sha256: str = ""
) -> dict[str, Any]:
    """Summarize opcode evidence for one automatically selected script."""
    opcode_rows = [
        row
        for row in rows
        if row.get("type") == "js.opcode"
        and str(row.get("script_url") or "") == script_url
        and (not script_sha256 or str(row.get("script_sha256") or "") in {"", script_sha256})
    ]
    if not opcode_rows:
        return {
            "event_count": 0,
            "script_line": None,
            "script_column": None,
            "script_bytecode_length": None,
            "pc_range": "",
            "dispatcher_pc": "",
            "dispatcher_candidate_pc": None,
            "dispatcher_candidate": {
                "confidence": "none",
                "score": 0.0,
                "signals_are_heuristic": True,
            },
            "hot_pcs": [],
            "windows": [],
        }

    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = collections.defaultdict(list)
    for row in opcode_rows:
        grouped[
            (
                _int_value(row.get("script_line")),
                _int_value(row.get("script_column")),
                _int_value(row.get("script_bytecode_length")),
            )
        ].append(row)
    identity, group_rows = max(grouped.items(), key=lambda item: len(item[1]))

    branch_ops = {
        "And",
        "Case",
        "Coalesce",
        "Default",
        "Goto",
        "JumpIfFalse",
        "JumpIfTrue",
        "LoopHead",
        "Or",
        "TableSwitch",
    }
    data_ops = {
        "GetElem",
        "GetElemSuper",
        "GetProp",
        "SetElem",
        "SetProp",
        "StrictSetElem",
        "StrictSetProp",
    }
    call_ops = {"Call", "CallContent", "CallIgnoresRv", "CallIter", "New"}
    pc_counts: collections.Counter[int] = collections.Counter()
    branch_counts: collections.Counter[int] = collections.Counter()
    data_counts: collections.Counter[int] = collections.Counter()
    call_counts: collections.Counter[int] = collections.Counter()
    op_counts: dict[int, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for row in group_rows:
        pc = _int_value(row.get("pc"))
        op = str(row.get("op_name") or "")
        pc_counts[pc] += 1
        op_counts[pc][op] += 1
        if op in branch_ops:
            branch_counts[pc] += 1
        if op in data_ops:
            data_counts[pc] += 1
        if op in call_ops:
            call_counts[pc] += 1

    pcs = sorted(pc_counts)
    windows: list[dict[str, Any]] = []
    width = 64
    for start_index, start in enumerate(pcs):
        selected = [pc for pc in pcs if start <= pc <= start + width - 1]
        if not selected:
            continue
        hits = sum(pc_counts[pc] for pc in selected)
        branch_hits = sum(branch_counts[pc] for pc in selected)
        windows.append(
            {
                "start": start,
                "end": start + width - 1,
                "hits": hits,
                "branch_hits": branch_hits,
                "distinct_pcs": len(selected),
                "score": hits + branch_hits * 2,
            }
        )
    selected_windows: list[dict[str, Any]] = []
    for item in sorted(windows, key=lambda row: (-row["score"], row["start"])):
        if any(
            not (item["end"] < prior["start"] or item["start"] > prior["end"])
            for prior in selected_windows
        ):
            continue
        item["env"] = f"TRACE_OPCODE_PC_RANGE={item['start']}:{item['end']}"
        selected_windows.append(item)
        if len(selected_windows) >= 4:
            break

    op_counts_total = collections.Counter(
        str(row.get("op_name") or "") for row in group_rows
    )
    unique_pcs = len(pc_counts)
    repetition = len(group_rows) / max(unique_pcs, 1)
    loop_hits = op_counts_total["LoopHead"]
    branch_hits = sum(op_counts_total[name] for name in branch_ops)
    data_access_hits = sum(op_counts_total[name] for name in data_ops)
    call_hits = sum(op_counts_total[name] for name in call_ops)
    score = min(
        100.0,
        repetition * 12.0
        + min(loop_hits, 20) * 1.5
        + min(branch_hits, 40) * 0.8
        + min(data_access_hits, 60) * 0.5
        + min(call_hits, 30) * 0.5,
    )
    if repetition >= 4 and loop_hits and data_access_hits:
        confidence = "high"
    elif (
        (repetition >= 2 and (loop_hits or branch_hits) and data_access_hits)
        or (loop_hits >= 3 and branch_hits >= 3 and data_access_hits >= 3)
    ):
        confidence = "medium"
    else:
        confidence = "low"

    dispatcher_ranked = sorted(
        pc_counts,
        key=lambda pc: (
            -(
                pc_counts[pc]
                + branch_counts[pc] * 2
                + data_counts[pc] * 1.5
                + call_counts[pc]
            ),
            pc,
        ),
    )
    dispatcher_candidate_pc = dispatcher_ranked[0] if dispatcher_ranked else None
    # Only auto-apply VM step when the heuristic reaches high confidence.  A
    # medium result remains visible to the Agent but does not turn on a
    # potentially noisy dispatcher stream by itself.
    dispatcher_pc = (
        str(dispatcher_candidate_pc)
        if confidence == "high" and dispatcher_candidate_pc is not None
        else ""
    )
    hot_pcs = [
        {
            "pc": pc,
            "hits": pc_counts[pc],
            "branch_hits": branch_counts[pc],
            "ops": [name for name, _ in op_counts[pc].most_common(4)],
        }
        for pc, _count in pc_counts.most_common(12)
    ]
    dispatcher = {
        "confidence": confidence,
        "score": round(score, 2),
        "event_to_pc_ratio": round(repetition, 3),
        "hottest_pc_hits": max(pc_counts.values(), default=0),
        "loop_hits": loop_hits,
        "branch_hits": branch_hits,
        "data_access_hits": data_access_hits,
        "call_hits": call_hits,
        "candidate_pc": dispatcher_candidate_pc,
        "signals_are_heuristic": True,
    }
    return {
        "event_count": len(group_rows),
        "script_line": identity[0],
        "script_column": identity[1],
        "script_bytecode_length": identity[2],
        "pc_range": (
            f"{selected_windows[0]['start']}:{selected_windows[0]['end']}"
            if selected_windows
            else ""
        ),
        "dispatcher_pc": dispatcher_pc,
        "dispatcher_candidate_pc": dispatcher_candidate_pc,
        "dispatcher_candidate": dispatcher,
        "hot_pcs": hot_pcs,
        "windows": selected_windows,
    }


def build_target_candidates(
    trace_dir: pathlib.Path,
    manifest: dict[str, Any],
    wanted: set[str],
    field_rows: list[dict[str, Any]],
    all_rows: list[dict[str, Any]],
    targets: list[dict[str, Any]],
    web_assets: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the next-pass identity index without user-supplied script text."""
    target_rows = [row for row in field_rows if row.get("target") is True]
    if not target_rows:
        # Keep high-entropy rows as a diagnostic hint, but do not promote them
        # to an automatic VM identity when the configured field name missed.
        target_rows = [
            row for row in field_rows if row.get("high_entropy_candidate") is True
        ][:24]
    deduped_target_rows: list[dict[str, Any]] = []
    seen_target_rows: set[tuple[Any, ...]] = set()
    for row in target_rows:
        key = (
            row.get("request_id"),
            row.get("field_name"),
            row.get("location"),
            row.get("ts_us"),
        )
        if key in seen_target_rows:
            continue
        seen_target_rows.add(key)
        deduped_target_rows.append(row)
    target_rows = deduped_target_rows[:256]

    # A full-page trace can contain many requests with the same dynamic field.
    # The user action immediately before Stop is the operative one-pass target,
    # so select its final request cluster instead of allowing an early SDK
    # request with a coincidental value match to become the recommendation.
    target_rows.sort(key=lambda row: _int_value(row.get("ts_us")))
    target_scope_request_ids: list[str] = []
    for row in reversed(target_rows):
        request_id = str(row.get("request_id") or "")
        if request_id and request_id not in target_scope_request_ids:
            target_scope_request_ids.append(request_id)
        if len(target_scope_request_ids) >= 4:
            break
    target_scope_request_ids.reverse()
    if target_scope_request_ids:
        target_scope_set = set(target_scope_request_ids)
        target_rows = [
            row for row in target_rows
            if str(row.get("request_id") or "") in target_scope_set
        ]

    js_enters = [
        row
        for row in all_rows
        if row.get("type") in {"js.call.enter", "js.script.enter"}
        and row.get("script_url")
    ]
    js_enters.sort(key=lambda row: _int_value(row.get("ts_us")))
    js_by_context: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    js_times_by_context: dict[tuple[str, str], list[int]] = collections.defaultdict(list)
    for row in js_enters:
        context_key = (
            str(row.get("pid") or "unknown"),
            str(row.get("segment_id") or "initial"),
        )
        js_by_context[context_key].append(row)
        js_times_by_context[context_key].append(_int_value(row.get("ts_us")))
    call_index: dict[tuple[str, str, str], dict[str, Any]] = {}
    children_by_parent: dict[tuple[str, str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for row in js_enters:
        key = (
            str(row.get("pid") or "unknown"),
            str(row.get("segment_id") or "initial"),
            str(row.get("call_id") or ""),
        )
        if key[2]:
            call_index[key] = row
        parent = str(row.get("parent_call_id") or "")
        if parent:
            children_by_parent[
                (str(row.get("pid") or "unknown"), str(row.get("segment_id") or "initial"), parent)
            ].append(row)

    aggregated: dict[tuple[str, str], dict[str, Any]] = {}

    def add(
        script_url: Any,
        script_sha256: Any,
        score: float,
        reason: str,
        field: dict[str, Any] | None = None,
        call: dict[str, Any] | None = None,
        role: str = "static-fallback",
    ) -> None:
        url = str(script_url or "").strip()
        if not url or url in {"self-hosted", "null", "None"}:
            return
        sha = str(script_sha256 or "").strip()
        key = next(
            (existing for existing in aggregated if existing[0] == url),
            (url, sha),
        )
        item = aggregated.setdefault(
            key,
            {
                "script_url": url,
                "script_sha256": sha,
                "script_match": script_match_token(url),
                "score": 0.0,
                "reasons": [],
                "field_names": [],
                "request_ids": [],
                "origin_call_ids": [],
                "caller_urls": [],
                "call_ids": [],
                "function_names": [],
                "call_sites": [],
                "roles": [],
                "runtime_score": 0.0,
                "partial_origin_chain": False,
            },
        )
        if sha and not item.get("script_sha256"):
            item["script_sha256"] = sha
        item["score"] += score
        if role != "static-fallback":
            item["runtime_score"] += score
        if role not in item["roles"]:
            item["roles"].append(role)
        if reason not in item["reasons"]:
            item["reasons"].append(reason)
        if field:
            name = str(field.get("field_name") or "")
            request_id = str(field.get("request_id") or "")
            origin = str(field.get("origin_call_id") or "")
            caller = str(field.get("caller_url") or "")
            if name and name not in item["field_names"]:
                item["field_names"].append(name)
            if request_id and request_id not in item["request_ids"]:
                item["request_ids"].append(request_id)
            if origin and origin not in item["origin_call_ids"]:
                item["origin_call_ids"].append(origin)
            if caller and caller not in item["caller_urls"]:
                item["caller_urls"].append(caller)
        if call:
            call_id = str(call.get("call_id") or "")
            function_name = str(call.get("function_name") or "")
            if call_id and call_id not in item["call_ids"]:
                item["call_ids"].append(call_id)
            if function_name and function_name not in item["function_names"]:
                item["function_names"].append(function_name)
            site = {
                "line": call.get("line"),
                "column": call.get("column"),
                "script_line": call.get("script_line"),
                "script_column": call.get("script_column"),
                "script_bytecode_length": call.get("script_bytecode_length"),
            }
            if site not in item["call_sites"]:
                item["call_sites"].append(site)

    # The request hook already records the caller URL.  This is the strongest
    # generic relation and works even when JS values were intentionally light.
    for field in target_rows:
        caller = field.get("caller_url")
        add(
            caller,
            field.get("script_sha256"),
            120,
            "request caller_url",
            field=field,
            role="request-sink-frame",
        )
        origin = str(field.get("origin_call_id") or "")
        if origin:
            key = (
                str(field.get("pid") or "unknown"),
                str(field.get("segment_id") or "initial"),
                origin,
            )
            direct = call_index.get(key)
            if direct:
                add(
                    direct.get("script_url"),
                    direct.get("script_sha256"),
                    110,
                    "origin_call_id exact match",
                    field=field,
                    call=direct,
                    role="request-writer",
                )
                parent = str(direct.get("parent_call_id") or "")
                depth = 1
                while parent and depth <= 12:
                    parent_row = call_index.get(
                        (
                            str(direct.get("pid") or "unknown"),
                            str(direct.get("segment_id") or "initial"),
                            parent,
                        )
                    )
                    if not parent_row:
                        break
                    add(
                        parent_row.get("script_url"),
                        parent_row.get("script_sha256"),
                        max(20, 70 - depth * 5),
                        "origin call chain",
                        field=field,
                        call=parent_row,
                        role="request-caller",
                    )
                    parent = str(parent_row.get("parent_call_id") or "")
                    depth += 1
            else:
                # A ring window can retain calls whose parent is the network
                # sink even when the sink's own enter event predates the
                # window.  Keep this causal evidence, but label it partial
                # instead of inventing an exact writer identity.
                for child in children_by_parent.get(key, [])[:32]:
                    add(
                        child.get("script_url"),
                        child.get("script_sha256"),
                        95,
                        "retained descendant of origin_call_id",
                        field=field,
                        call=child,
                        role="causal-descendant",
                    )
                    child_key = next(
                        (
                            existing
                            for existing, item in aggregated.items()
                            if item.get("script_url") == child.get("script_url")
                        ),
                        None,
                    )
                    if child_key:
                        aggregated[child_key]["partial_origin_chain"] = True

        ts = _int_value(field.get("ts_us"))
        pid = str(field.get("pid") or "unknown")
        segment = str(field.get("segment_id") or "initial")
        context_key = (pid, segment)
        context_calls = js_by_context.get(context_key, [])
        context_times = js_times_by_context.get(context_key, [])
        left = bisect.bisect_left(context_times, ts - 20_000)
        right = bisect.bisect_right(context_times, ts + 20_000)
        nearby = context_calls[left:right]
        for call in sorted(
            nearby,
            key=lambda row: abs(_int_value(row.get("ts_us")) - ts),
        )[:16]:
            add(
                call.get("script_url"),
                call.get("script_sha256"),
                max(5, 40 - abs(_int_value(call.get("ts_us")) - ts) / 1000),
                "near request time",
                field=field,
                call=call,
                role="nearby-runtime",
            )

    # Existing value matches remain useful when the request hook has no direct
    # caller metadata.  Match them back to their field by source identity.
    scoped_request_ids = {str(row.get("request_id") or "") for row in target_rows}
    field_keys = {
        (
            str(item.get("field", {}).get("_source_file") or ""),
            _int_value(item.get("field", {}).get("_source_line")),
            str(item.get("field", {}).get("field_name") or ""),
        )
        for item in targets
    }
    for item in targets:
        field = item.get("field") or {}
        if str(field.get("request_id") or "") not in scoped_request_ids:
            continue
        key = (
            str(field.get("_source_file") or ""),
            _int_value(field.get("_source_line")),
            str(field.get("field_name") or ""),
        )
        if key not in field_keys:
            continue
        for producer in item.get("producer_candidates") or []:
            add(
                producer.get("script_url"),
                producer.get("script_sha256"),
                90,
                "request value matched JS artifact",
                field=field,
                role="value-producer",
            )

    # Promote downloaded script artifacts that contain target-family and VM/sign
    # markers.  This catches the common shape where XHR caller_url points at a
    # wrapper script while the real producer is a security SDK loaded nearby.
    if isinstance(web_assets, dict):
        anchor_field = target_rows[0] if target_rows else None
        for asset in web_assets.get("scripts") or []:
            if not isinstance(asset, dict):
                continue
            score, reasons = asset_target_signal_score(asset, wanted)
            target_functions = asset_target_functions(trace_dir, asset, wanted)
            if target_functions:
                score += 520.0 + min(480.0, float(target_functions[0].get("score") or 0) / 4.0)
                reasons.append("script source has target-field function context")
            if score <= 0:
                continue
            add(
                asset.get("final_url") or asset.get("url"),
                asset.get("sha256"),
                score,
                " + ".join(reasons),
                field=anchor_field,
                role="static-fallback",
            )

    target_functions_by_url: dict[str, list[dict[str, Any]]] = {}
    if isinstance(web_assets, dict):
        for asset in web_assets.get("scripts") or []:
            if not isinstance(asset, dict):
                continue
            url = str(asset.get("final_url") or asset.get("url") or "")
            if not url:
                continue
            funcs = asset_target_functions(trace_dir, asset, wanted)
            if funcs:
                target_functions_by_url[url] = funcs

    candidates: list[dict[str, Any]] = []
    for item in aggregated.values():
        item["score"] = round(float(item["score"]), 2)
        item["runtime_score"] = round(float(item["runtime_score"]), 2)
        item["reasons"].sort()
        item["confidence"] = (
            "correlated"
            if item["score"] >= 90
            else "candidate"
            if item["score"] >= 45
            else "weak"
        )
        opcode = opcode_identity_for_script(
            all_rows,
            item["script_url"],
            item.get("script_sha256") or "",
        )
        target_functions = target_functions_by_url.get(str(item.get("script_url") or ""), [])
        if target_functions:
            item["target_functions"] = target_functions[:6]
            item["target_function_names"] = [
                str(fn.get("name") or "")
                for fn in target_functions[:6]
                if str(fn.get("name") or "")
            ]
        opcode_vm = dict(opcode)
        opcode_column = _int_value(opcode.get("script_column"), -1)
        opcode_target_mismatch = False
        if target_functions and opcode_column >= 0:
            nearest = min(
                target_functions,
                key=lambda fn: abs(_int_value(fn.get("script_column"), -10**12) - opcode_column),
            )
            distance = abs(_int_value(nearest.get("script_column"), -10**12) - opcode_column)
            # Hot opcode windows often land in behavioural sensor functions
            # (mousemove/touchmove) inside the same security SDK.  If source
            # context says the target-field producer is elsewhere, keep the
            # opcode evidence visible but do not auto-apply that wrong PC.
            if distance > 1024:
                opcode_target_mismatch = True
                opcode_vm["pc_range"] = ""
                opcode_vm["dispatcher_pc"] = ""
                opcode_vm["target_context_mismatch"] = {
                    "opcode_script_column": opcode_column,
                    "nearest_target_function": nearest,
                    "distance": distance,
                    "action": "ignore_hot_opcode_window_for_auto_apply",
                }
        item["opcode"] = opcode
        vm = {
            "script_contains": item["script_match"],
        }
        if item.get("script_sha256"):
            vm["script_sha256"] = item["script_sha256"]
        if target_functions:
            primary_fn = target_functions[0]
            names = [
                str(fn.get("name") or "")
                for fn in target_functions[:4]
                if str(fn.get("name") or "")
            ]
            if names:
                vm["function_contains"] = ",".join(names)
            if primary_fn.get("script_line") is not None:
                vm["script_line"] = str(primary_fn.get("script_line"))
            if primary_fn.get("script_column") is not None:
                vm["script_column"] = str(primary_fn.get("script_column"))
        # Exact script identity for opcode is learned from opcode rows, not
        # guessed from a request caller's source location.
        for source, target in (
            ("script_line", "script_line"),
            ("script_column", "script_column"),
            ("script_bytecode_length", "script_bytecode_length"),
        ):
            if opcode_target_mismatch:
                continue
            if target in vm:
                continue
            if opcode_vm.get(source) is not None:
                vm[target] = str(opcode[source])
        if opcode_vm.get("pc_range"):
            vm["pc_range"] = opcode_vm["pc_range"]
        if opcode_vm.get("dispatcher_pc"):
            vm["dispatch_pc"] = opcode_vm["dispatcher_pc"]
        if opcode_vm.get("target_context_mismatch"):
            vm["opcode_hot_window_status"] = "ignored: target function context mismatch"
        item["vm"] = vm
        has_runtime_evidence = float(item.get("runtime_score") or 0) > 0
        item["stage"] = (
            "dispatcher-ready"
            if has_runtime_evidence and opcode_vm.get("dispatcher_pc")
            else "pc-ready"
            if has_runtime_evidence and opcode_vm.get("pc_range")
            else "function-ready"
            if has_runtime_evidence and target_functions
            else "script-ready"
            if has_runtime_evidence and item.get("script_match")
            else "needs-review"
        )
        candidates.append(item)

    def candidate_stage_priority(item: dict[str, Any]) -> int:
        stage = str(item.get("stage") or "")
        if stage == "dispatcher-ready":
            return 4
        if stage == "pc-ready":
            return 3
        if stage == "function-ready":
            return 2
        if _int_value((item.get("opcode") or {}).get("event_count")) > 0:
            return 1
        if stage == "script-ready":
            return 1
        return 0

    def candidate_role_priority(item: dict[str, Any]) -> int:
        roles = set(item.get("roles") or [])
        # A value that exactly matches the final request field is direct
        # producer evidence.  It outranks the transport wrapper and every
        # nearby/static observation without naming any vendor-specific script.
        if "value-producer" in roles:
            return 5
        if "request-writer" in roles:
            return 4
        if "request-sink-frame" in roles:
            return 3
        if "causal-descendant" in roles:
            return 2
        if "nearby-runtime" in roles:
            return 1
        return 0

    candidates.sort(
        key=lambda item: (
            -candidate_role_priority(item),
            -int(float(item.get("runtime_score") or 0) > 0),
            -float(item.get("runtime_score") or 0),
            -candidate_stage_priority(item),
            -_int_value((item.get("opcode") or {}).get("event_count")),
            -float(item.get("score") or 0),
            str(item.get("script_url") or ""),
        )
    )
    candidates = candidates[:12]
    for rank, item in enumerate(candidates, 1):
        item["rank"] = rank
        # Keep UI and logs compact while preserving enough evidence for an
        # Agent to verify the automatic selection.
        item["call_ids"] = item["call_ids"][:12]
        item["function_names"] = item["function_names"][:12]
        item["call_sites"] = item["call_sites"][:12]
        item["field_names"] = item["field_names"][:12]
        item["request_ids"] = item["request_ids"][:12]
        item["origin_call_ids"] = item["origin_call_ids"][:12]
        item["caller_urls"] = item["caller_urls"][:8]

    status = "ready" if candidates else "no-target-field"
    recommendation = candidates[0] if candidates else None
    return {
        "schema": "firefox_trace.target_candidates.v1",
        "trace_dir": str(trace_dir),
        "target_url": manifest.get("target_url"),
        "generated_at_unix": int(time.time()),
        "target_fields": sorted(wanted),
        "target_scope_request_ids": target_scope_request_ids,
        "status": status,
        "selection": "automatic",
        "candidate_count": len(candidates),
        "recommended": recommendation,
        "candidates": candidates,
        "next_action": (
            "重复同一目标动作；工具会自动使用推荐脚本身份"
            if recommendation
            else "先确认目标字段名称/位置，再重复同一目标动作"
        ),
        "notes": [
            "script_match is generated from request caller_url, origin_call_id, nearby JS calls and value matches.",
            "pc_range and dispatch_pc are analyzer outputs; users do not guess them.",
            "dispatcher_pc is auto-applied only when the heuristic confidence is high.",
        ],
    }


def finalize(trace_dir: pathlib.Path, download_assets: bool = True) -> dict[str, Any]:
    trace_dir = trace_dir.resolve()
    manifest = load_manifest(trace_dir)
    wanted = target_fields(manifest)
    categorized = trace_dir / "categorized"
    index_dir = trace_dir / "index"
    categorized.mkdir(parents=True, exist_ok=True)
    index_dir.mkdir(parents=True, exist_ok=True)

    buckets: dict[str, list[dict[str, Any]]] = {name: [] for name in CATEGORY_NAMES if name != "request-fields"}
    field_rows: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    source_files: collections.Counter[str] = collections.Counter()
    request_callers: dict[tuple[str, str, str], dict[str, Any]] = {}

    for path, line, row in jsonl_rows(trace_dir):
        if row.get("type") == "js.vm_window":
            row = dict(row)
            row["artifact_validation"] = inspect_vm_window_artifact(trace_dir, row)
        transport = "fetch" if "fetch" in path.name else "xhr" if "xhr" in path.name else ""
        request_id = str(row.get("request_id") or "")
        pid = str(row.get("pid") or "")
        request_key = (transport, pid, request_id)
        if transport and request_id and row.get("type") in {"fetch.call", "xhr.open"}:
            request_callers[request_key] = {
                key: row.get(key)
                for key in ("origin_call_id", "caller_url", "caller_line", "caller_column")
                if row.get(key) is not None
            }
        caller = request_callers.get(request_key)
        if caller and not row.get("origin_call_id"):
            # fetch.request/xhr.body are emitted after their call/open event and
            # do not carry scripted caller data themselves. Preserve that
            # identity on field records so value-to-call analysis can start at
            # the request body rather than fall back to a time window.
            row = dict(row)
            row.update(caller)
        category = classify_event(path, row)
        decorated = compact_event(row, path, line, category)
        buckets.setdefault(category, []).append(decorated)
        all_rows.append(decorated)
        source_files[path.name] += 1
        field_rows.extend(iter_field_records(row, path, line, wanted, trace_dir))

    script_identity = enrich_script_resource_identity(all_rows)

    for category, rows in buckets.items():
        write_jsonl(categorized / f"{category}.jsonl", rows)
    write_jsonl(categorized / "request-fields.jsonl", field_rows)

    environment_contract = build_environment_contract(all_rows)
    (index_dir / "environment-contract.json").write_text(
        json.dumps(environment_contract, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    trace_health = build_trace_health(
        manifest, all_rows, field_rows, environment_contract
    )
    (index_dir / "trace-health.json").write_text(
        json.dumps(trace_health, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )

    js_by_sha: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    js_artifacts_by_path: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in buckets.get("js", []):
        for item in walk_sha_values(row):
            meta = {
                "source_file": row.get("_source_file"),
                "source_line": row.get("_source_line"),
                "event_type": row.get("type"),
                "call_id": row.get("call_id"),
                "parent_call_id": row.get("parent_call_id"),
                "origin_call_id": row.get("origin_call_id"),
                "function_name": row.get("function_name"),
                "script_url": row.get("script_url"),
                "script_sha256": row.get("script_sha256"),
                "value_store_path": item.get("value_store_path"),
                "value_path": item.get("value_path"),
            }
            js_by_sha[item["sha256"]].append(meta)
            if item.get("value_store_path"):
                js_artifacts_by_path[str(item.get("value_store_path"))].append(meta)

    context_by_origin: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in all_rows:
        origin = row.get("origin_call_id")
        if isinstance(origin, str) and origin:
            context_by_origin[origin].append(
                {
                    "category": row.get("_category"),
                    "type": row.get("type"),
                    "source_file": row.get("_source_file"),
                    "source_line": row.get("_source_line"),
                    "call_id": row.get("call_id"),
                    "origin_call_id": origin,
                    "interface": row.get("interface"),
                    "member": row.get("member"),
                    "key": row.get("key"),
                    "function_name": row.get("function_name"),
                    "script_url": row.get("script_url"),
                    "value_sha256": row.get("sha256"),
                }
            )

    targets = []
    for field in field_rows:
        forms = target_value_forms(field, trace_dir)
        producer_matches: list[dict[str, Any]] = []
        for form in forms:
            digest = str(form.get("sha256") or "")
            if not digest:
                continue
            if form.get("form") == "segment" and int(form.get("size") or 0) < 24:
                continue
            exact_type = "segment_exact" if form.get("form") == "segment" else f"exact_{form.get('form')}"
            for candidate in js_by_sha.get(digest, []):
                producer_matches.append(
                    dict(candidate)
                    | {
                        "match_type": exact_type,
                        "target_form": form.get("form"),
                        "target_sha256": digest,
                        "segment_index": form.get("segment_index"),
                    }
                )
        containing_forms = [
            form
            for form in forms
            if isinstance(form.get("value"), str)
            and len(str(form.get("value"))) >= 24
        ]
        if containing_forms and js_artifacts_by_path:
            for rel_path, refs in js_artifacts_by_path.items():
                text = read_value_store(trace_dir, rel_path)
                if not text:
                    continue
                for form in containing_forms:
                    needle = str(form.get("value") or "")
                    if not needle or needle == text:
                        continue
                    if needle in text:
                        match_type = (
                            "segment_contains"
                            if form.get("form") == "segment"
                            else f"contains_{form.get('form')}"
                        )
                        for ref in refs:
                            producer_matches.append(
                                dict(ref)
                                | {
                                    "match_type": match_type,
                                    "target_form": form.get("form"),
                                    "target_sha256": form.get("sha256"),
                                    "segment_index": form.get("segment_index"),
                                    "container_value_store_path": rel_path,
                                }
                            )
        producer_candidates = dedupe_matches(producer_matches)
        origin = field.get("origin_call_id")
        context = context_by_origin.get(origin, []) if origin else []
        targets.append(
            {
                "field": field,
                "target_value_forms": [public_value_form(item) for item in forms],
                "producer_candidates": producer_candidates,
                "same_origin_context": context,
                "evidence_level": "matched" if producer_candidates else "candidate",
            }
        )

    web_assets = download_web_assets(trace_dir, manifest, all_rows, wanted) if download_assets else None
    if web_assets is not None:
        (index_dir / "web-assets.json").write_text(
            json.dumps(web_assets, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    degraded = [
        row
        for row in all_rows
        if row.get("type") == "trace.degraded"
        or (
            row.get("type") == "js.boundary.flush_summary"
            and row.get("complete_window") is False
        )
    ]
    event_counts = collections.Counter(str(row.get("type") or "unknown") for row in all_rows)
    category_counts = {category: len(rows) for category, rows in buckets.items()}
    # Deferred capture stores value identity directly in the enclosing call
    # event, so it deliberately emits no second js.value.store record.
    js_value_artifact_ids = {
        str(item.get("value_store_path") or item.get("sha256") or "")
        for row in buckets.get("js", [])
        for item in walk_sha_values(row)
        if item.get("value_store_path")
    }
    js_value_artifact_count = len(js_value_artifact_ids)
    js_value_capture_event_count = sum(
        1
        for row in buckets.get("js", [])
        if row.get("capture_status") or row.get("capture_tier") or row.get("data")
    )
    js_value_missing_hint = ""
    if category_counts.get("js", 0) and js_value_capture_event_count == 0:
        js_value_missing_hint = (
            "JS events exist but no value capture markers were found; check that the "
            "runtime was rebuilt with boundary value capture and that "
            "TRACE_JS_CAPTURE_VALUES / TRACE_JS_AUTO_CAPTURE_VALUES reached the content process."
        )
    files = {
        str(path.relative_to(trace_dir)): path.stat().st_size
        for root in (categorized, index_dir, trace_dir / "web-assets")
        if root.exists()
        for path in root.rglob("*")
        if path.is_file()
    }

    causal_index = {
        "schema": "firefox_trace.causal_index.v1",
        "trace_dir": str(trace_dir),
        "target_fields": sorted(wanted),
        "targets": targets,
        "degraded_count": len(degraded),
        "notes": [
            "matched means a request field raw/decoded/segment value equals or is contained by a JS-captured value artifact.",
            "same_origin_context is correlation evidence; dependency confirmation still needs a controlled A/B run.",
        ],
    }
    (index_dir / "causal-index.json").write_text(
        json.dumps(causal_index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    target_candidates = build_target_candidates(
        trace_dir,
        manifest,
        wanted,
        field_rows,
        all_rows,
        targets,
        web_assets,
    )
    (index_dir / "target-candidates.json").write_text(
        json.dumps(target_candidates, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    for generated in (
        index_dir / "causal-index.json",
        index_dir / "target-candidates.json",
        index_dir / "environment-contract.json",
        index_dir / "trace-health.json",
    ):
        try:
            files[str(generated.relative_to(trace_dir))] = generated.stat().st_size
        except OSError:
            pass

    summary = {
        "schema": "firefox_trace.final_summary.v1",
        "trace_dir": str(trace_dir),
        "campaign_id": manifest.get("campaign_id"),
        "run_label": manifest.get("run_label"),
        "target_url": manifest.get("target_url"),
        "capture_plan": (manifest.get("env") or {}).get("TRACE_CAPTURE_PLAN")
        or (manifest.get("env") or {}).get("TRACE_PLAN")
        or manifest.get("preset"),
        "target_fields": sorted(wanted),
        "event_count": len(all_rows),
        "script_identity": script_identity,
        "event_counts": dict(event_counts),
        "category_counts": category_counts,
        "request_field_count": len(field_rows),
        "target_field_match_count": sum(
            1 for row in field_rows if bool(row.get("target"))
        ),
        "js_value_artifact_count": js_value_artifact_count,
        "js_value_capture_event_count": js_value_capture_event_count,
        "js_value_missing_hint": js_value_missing_hint,
        "target_match_count": sum(1 for item in targets if item["evidence_level"] == "matched"),
        "degraded_count": len(degraded),
        "source_files": dict(source_files),
        "generated_files": files,
        "index_paths": {
            "causal_index": "index/causal-index.json",
            "request_fields": "categorized/request-fields.jsonl",
            "web_assets": "index/web-assets.json" if web_assets is not None else "",
            "target_candidates": "index/target-candidates.json",
            "environment_contract": "index/environment-contract.json",
            "trace_health": "index/trace-health.json",
        },
        "target_candidate_count": target_candidates["candidate_count"],
        "target_candidate_status": target_candidates["status"],
        "environment_contract": environment_contract["coverage"],
        "trace_health": trace_health,
        "recommended_target_script": (
            (target_candidates.get("recommended") or {}).get("script_url") or ""
        ),
        "web_assets": web_assets,
        "web_asset_count": len((web_assets or {}).get("scripts", [])) if web_assets is not None else 0,
        "web_asset_error_count": len((web_assets or {}).get("errors", [])) if web_assets is not None else 0,
    }
    (index_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace_dir", type=pathlib.Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-download-assets", action="store_true", help="skip best-effort HTML/JS asset download")
    args = parser.parse_args()
    if not args.trace_dir.is_dir():
        parser.error(f"trace directory does not exist: {args.trace_dir}")
    result = finalize(args.trace_dir, download_assets=not args.no_download_assets)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"Finalized: {result['trace_dir']}")
        print(f"Events: {result['event_count']}  request fields: {result['request_field_count']}")
        print(
            f"Target fields: {result['target_field_match_count']}  "
            f"matched JS values: {result['target_match_count']}  "
            f"degraded: {result['degraded_count']}"
        )
        for category, count in result["category_counts"].items():
            print(f"  {category}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
