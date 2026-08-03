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
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable


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
    values = {
        item.strip().lower()
        for raw in raw_values
        if raw
        for item in str(raw).replace(";", ",").split(",")
        if item.strip()
    }
    return values or set(GENERIC_TARGET_FIELDS)


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
    if typ.startswith(("wasm.", "js.opcode", "js.vm_step")):
        return "wasm-vm"
    if typ.startswith(("js.",)):
        return "js"
    if typ.startswith(("worker.",)) or str(row.get("process_type") or "").lower() == "worker":
        return "worker"
    if typ.startswith(("dom.",)) or "dom" in lower_path:
        return classify_dom_interface(row)
    return "control-health" if not typ else "network" if "request" in typ else "js"


def compact_event(row: dict[str, Any], path: pathlib.Path, line: int, category: str) -> dict[str, Any]:
    result = dict(row)
    result["_category"] = category
    result["_source_file"] = path.name
    result["_source_line"] = line
    return result


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
        if path.endswith(".js") or ".js" in path or "javascript" in item.lower():
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

    js_enters = [
        row
        for row in all_rows
        if row.get("type") == "js.call.enter" and row.get("script_url")
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
    for row in js_enters:
        key = (
            str(row.get("pid") or "unknown"),
            str(row.get("segment_id") or "initial"),
            str(row.get("call_id") or ""),
        )
        if key[2]:
            call_index[key] = row

    aggregated: dict[tuple[str, str], dict[str, Any]] = {}

    def add(
        script_url: Any,
        script_sha256: Any,
        score: float,
        reason: str,
        field: dict[str, Any] | None = None,
        call: dict[str, Any] | None = None,
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
            },
        )
        if sha and not item.get("script_sha256"):
            item["script_sha256"] = sha
        item["score"] += score
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
                    )
                    parent = str(parent_row.get("parent_call_id") or "")
                    depth += 1

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
            )

    # Existing value matches remain useful when the request hook has no direct
    # caller metadata.  Match them back to their field by source identity.
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
            )

    candidates: list[dict[str, Any]] = []
    for item in aggregated.values():
        item["score"] = round(float(item["score"]), 2)
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
        item["opcode"] = opcode
        vm = {
            "script_contains": item["script_match"],
        }
        if item.get("script_sha256"):
            vm["script_sha256"] = item["script_sha256"]
        # Exact script identity for opcode is learned from opcode rows, not
        # guessed from a request caller's source location.
        for source, target in (
            ("script_line", "script_line"),
            ("script_column", "script_column"),
            ("script_bytecode_length", "script_bytecode_length"),
        ):
            if opcode.get(source) is not None:
                vm[target] = str(opcode[source])
        if opcode.get("pc_range"):
            vm["pc_range"] = opcode["pc_range"]
        if opcode.get("dispatcher_pc"):
            vm["dispatch_pc"] = opcode["dispatcher_pc"]
        item["vm"] = vm
        item["stage"] = (
            "dispatcher-ready"
            if opcode.get("dispatcher_pc")
            else "pc-ready"
            if opcode.get("pc_range")
            else "script-ready"
            if item.get("script_match")
            else "needs-review"
        )
        candidates.append(item)

    candidates.sort(
        key=lambda item: (
            -float(item.get("score") or 0),
            -_int_value((item.get("opcode") or {}).get("event_count")),
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

    for path, line, row in jsonl_rows(trace_dir):
        category = classify_event(path, row)
        decorated = compact_event(row, path, line, category)
        buckets.setdefault(category, []).append(decorated)
        all_rows.append(decorated)
        source_files[path.name] += 1
        field_rows.extend(iter_field_records(row, path, line, wanted, trace_dir))

    for category, rows in buckets.items():
        write_jsonl(categorized / f"{category}.jsonl", rows)
    write_jsonl(categorized / "request-fields.jsonl", field_rows)

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

    web_assets = download_web_assets(trace_dir, manifest, all_rows) if download_assets else None
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
    js_value_artifact_count = sum(
        1
        for row in buckets.get("js", [])
        if row.get("type") == "js.value.store" and row.get("stored") is True
    )
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
    )
    (index_dir / "target-candidates.json").write_text(
        json.dumps(target_candidates, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    for generated in (
        index_dir / "causal-index.json",
        index_dir / "target-candidates.json",
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
        "event_counts": dict(event_counts),
        "category_counts": category_counts,
        "request_field_count": len(field_rows),
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
        },
        "target_candidate_count": target_candidates["candidate_count"],
        "target_candidate_status": target_candidates["status"],
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
        print(f"Matched JS values: {result['target_match_count']}  degraded: {result['degraded_count']}")
        for category, count in result["category_counts"].items():
            print(f"  {category}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
