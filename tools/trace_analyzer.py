#!/usr/bin/env python3
"""
Firefox Trace offline analyzer.

First-pass goal:
  - consume jsonl logs produced by the modified Firefox trace browser;
  - find target-like request parameters without pre-known JS function names;
  - walk origin_call_id / parent_call_id to produce candidate scripts/functions
    for the next TRACE_JS_MODE=target/deep run.

This is intentionally conservative: if JS logs are missing or degraded, the
report says so instead of pretending the call chain is complete.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import re
import sys
import urllib.parse
from dataclasses import dataclass, field
from typing import Any


HIGH_ENTROPY_RE = re.compile(r"[A-Za-z0-9_-]{24,}")
GENERIC_FIELDS = ["sign", "signature", "token", "riskData", "fp", "nonce", "timestamp", "captchaId"]
PRESET_FIELDS = {
    "generic": GENERIC_FIELDS,
    "none": [],
}


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = collections.Counter(value)
    total = len(value)
    return -sum((n / total) * math.log2(n / total) for n in counts.values())


def is_high_entropy(value: str) -> bool:
    return len(value) >= 24 and shannon_entropy(value) >= 3.5


def load_jsonl(root: pathlib.Path) -> list[dict[str, Any]]:
    files: list[pathlib.Path]
    if root.is_file():
        files = [root]
        base_dir = root.parent
    else:
        files = sorted(root.glob("*.jsonl"))
        base_dir = root
    rows: list[dict[str, Any]] = []
    for path in files:
        with path.open("r", errors="replace") as f:
            for line_no, line in enumerate(f, 1):
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                row["_file"] = path.name
                row["_line"] = line_no
                row["_root_dir"] = str(base_dir)
                rows.append(row)
    return rows


def iter_text_values(row: dict[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key in (
        "url",
        "key",
        "storage_type",
        "detail_value",
        "value_preview",
        "body_preview",
        "response_preview",
    ):
        value = row.get(key)
        if isinstance(value, str):
            out.append((key, value))
    query_fields = row.get("query_fields")
    if isinstance(query_fields, dict):
        for key, value in query_fields.items():
            if isinstance(value, str):
                out.append((f"query_fields.{key}", value))
    for arg in row.get("args") or []:
        if isinstance(arg, dict) and isinstance(arg.get("preview"), str):
            out.append(("arg.preview", arg["preview"]))
    data = row.get("data")
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str):
                out.append((f"data.{key}", value))

    root_dir = pathlib.Path(row["_root_dir"]) if isinstance(row.get("_root_dir"), str) else None

    def walk(value: Any, path: str) -> None:
        if isinstance(value, dict):
            preview = value.get("preview")
            if isinstance(preview, str):
                out.append((f"{path}.preview", preview))
            for scalar_key in ("bytes_hex", "sha256"):
                scalar_value = value.get(scalar_key)
                if isinstance(scalar_value, str) and scalar_value:
                    out.append((f"{path}.{scalar_key}", scalar_value))
            store_path = value.get("value_store_path")
            if root_dir and isinstance(store_path, str) and store_path:
                full_path = (root_dir / store_path).resolve()
                try:
                    # Keep analyzer bounded; trace core already has a per-value
                    # max, but this protects offline runs against manual files.
                    if full_path.is_file() and full_path.stat().st_size <= 8 * 1024 * 1024:
                        out.append((f"{path}.value_store", full_path.read_text(errors="replace")))
                except Exception:
                    pass
            props = value.get("props")
            if isinstance(props, list):
                for item in props:
                    if isinstance(item, dict):
                        key = item.get("key")
                        child_path = f"{path}.{key}" if key is not None else f"{path}.<prop>"
                        walk(item.get("value"), child_path)
            items = value.get("items")
            if isinstance(items, list):
                for index, item in enumerate(items):
                    walk(item, f"{path}[{index}]")
            for key, child in value.items():
                if key not in {"props", "items"}:
                    walk(child, f"{path}.{key}" if path else key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")

    if isinstance(data, dict):
        walk(data, "data")
    return out


def parse_query_values(url_or_text: str) -> dict[str, list[str]]:
    text = urllib.parse.unquote(url_or_text)
    if "?" in text:
        query = urllib.parse.urlsplit(text).query
        if not query:
            query = text.split("?", 1)[1]
    else:
        if "=" not in text:
            return {}
        query = text
    parsed = urllib.parse.parse_qs(query, keep_blank_values=True)
    return {k: v for k, v in parsed.items()}


def field_leaf_name(path: str) -> str:
    parts = [p for p in re.split(r"[.\[\]]+", path) if p]
    if not parts:
        return ""
    leaf = parts[-1]
    if leaf in {"preview", "value_store", "value"} and len(parts) >= 2:
        leaf = parts[-2]
    return leaf


@dataclass
class Finding:
    kind: str
    field: str
    value: str
    row: dict[str, Any]

    @property
    def origin_call_id(self) -> str | None:
        value = self.row.get("origin_call_id")
        if isinstance(value, str):
            return value
        if isinstance(self.row.get("type"), str) and self.row["type"].startswith("js.call."):
            call_id = self.row.get("call_id")
            return call_id if isinstance(call_id, str) else None
        return None


def find_interesting_fields(rows: list[dict[str, Any]], names: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    wanted = {n.lower() for n in names}
    seen: set[tuple[str, str, str | None]] = set()
    for row in rows:
        for field, text in iter_text_values(row):
            leaf = field_leaf_name(field).lower()
            if leaf in wanted and text and text not in {"Object", "Array", "Function"}:
                key = (leaf, text[:256], row.get("origin_call_id"))
                if key not in seen:
                    seen.add(key)
                    findings.append(Finding(leaf, field, text, row))
            if text and text.lower() in wanted:
                key = ("field_name", text[:256], row.get("origin_call_id"))
                if key not in seen:
                    seen.add(key)
                    findings.append(Finding(text, field, text, row))

            parsed = parse_query_values(text)
            for name, values in parsed.items():
                lname = name.lower()
                if lname in wanted:
                    for value in values:
                        key = (lname, value[:256], row.get("origin_call_id"))
                        if key not in seen:
                            seen.add(key)
                            findings.append(Finding(lname, name, value, row))
                for value in values:
                    if HIGH_ENTROPY_RE.search(value) and is_high_entropy(value):
                        key = ("high_entropy", value[:256], row.get("origin_call_id"))
                        if key not in seen:
                            seen.add(key)
                            findings.append(Finding("high_entropy", name, value, row))
    return findings


def prioritize_findings(findings: list[Finding]) -> list[Finding]:
    priority = {
        "sign": 1,
        "signature": 1,
        "token": 2,
        "riskdata": 3,
        "fp": 4,
        "nonce": 5,
        "timestamp": 6,
        "captchaid": 7,
        "high_entropy": 9,
    }
    return sorted(
        findings,
        key=lambda f: (
            priority.get(f.kind, 5),
            f.row.get("ts_us") or 0,
            f.row.get("_file") or "",
            f.row.get("_line") or 0,
        ),
    )


@dataclass
class Index:
    calls: dict[str, dict[str, Any]] = field(default_factory=dict)
    call_events: list[dict[str, Any]] = field(default_factory=list)
    children: dict[str, list[str]] = field(default_factory=lambda: collections.defaultdict(list))
    degraded: list[dict[str, Any]] = field(default_factory=list)
    function_counts: collections.Counter[tuple[str, str]] = field(default_factory=collections.Counter)
    script_counts: collections.Counter[str] = field(default_factory=collections.Counter)
    script_hash_counts: collections.Counter[str] = field(default_factory=collections.Counter)
    script_sources: dict[str, dict[str, Any]] = field(default_factory=dict)


def build_index(rows: list[dict[str, Any]]) -> Index:
    idx = Index()
    for row in rows:
        typ = row.get("type")
        if typ == "trace.degraded":
            idx.degraded.append(row)
        if typ == "js.call.enter":
            idx.call_events.append(row)
            cid = row.get("call_id")
            if isinstance(cid, str):
                idx.calls[cid] = row
                parent = row.get("parent_call_id")
                if isinstance(parent, str):
                    idx.children[parent].append(cid)
            script = row.get("script_url") or ""
            fn = row.get("function_name") or ""
            script_sha256 = row.get("script_sha256") or ""
            if script:
                idx.script_counts[script] += 1
            if script_sha256:
                idx.script_hash_counts[script_sha256] += 1
                source_path = row.get("script_source_path")
                if isinstance(source_path, str) and source_path:
                    idx.script_sources.setdefault(
                        script_sha256,
                        {
                            "script_sha256": script_sha256,
                            "script_source_path": source_path,
                            "script_source_status": row.get("script_source_status"),
                            "script_source_length": row.get("script_source_length"),
                            "script_url": script,
                        },
                    )
            if script or fn:
                idx.function_counts[(script, fn)] += 1
    idx.call_events.sort(key=lambda r: r.get("ts_us") or 0)
    return idx


def call_chain(idx: Index, call_id: str | None, max_depth: int = 80) -> list[dict[str, Any]]:
    if not call_id:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    cur = call_id
    while cur and cur not in seen and len(out) < max_depth:
        seen.add(cur)
        row = idx.calls.get(cur)
        if not row:
            break
        out.append(row)
        parent = row.get("parent_call_id")
        cur = parent if isinstance(parent, str) else ""
    return out


def nearby_calls(
    idx: Index, row: dict[str, Any], window_us: int = 5000, max_items: int = 12
) -> list[dict[str, Any]]:
    ts = row.get("ts_us")
    if not isinstance(ts, int):
        return []
    context = row.get("caller_url") or row.get("page_url") or row.get("url") or ""
    out: list[dict[str, Any]] = []
    for call in idx.call_events:
        call_ts = call.get("ts_us")
        if not isinstance(call_ts, int):
            continue
        delta = call_ts - ts
        if abs(delta) > window_us:
            continue
        script = call.get("script_url") or ""
        same_context = bool(context and script and (script in context or context in script))
        item = dict(call)
        item["_delta_us"] = delta
        item["_same_context"] = same_context
        out.append(item)
    out.sort(key=lambda c: (not c.get("_same_context"), abs(c.get("_delta_us") or 0)))
    return out[:max_items]


def candidate_filters(
    chains: list[list[dict[str, Any]]],
    nearby_groups: list[list[dict[str, Any]]],
    idx: Index,
) -> tuple[list[str], list[str], list[str]]:
    scripts = collections.Counter()
    funcs = collections.Counter()
    script_hashes = collections.Counter()
    for chain in chains:
        for row in chain:
            script = row.get("script_url") or ""
            fn = row.get("function_name") or ""
            script_sha256 = row.get("script_sha256") or ""
            if script and script not in {"self-hosted"}:
                scripts[script] += 1
            if script_sha256:
                script_hashes[script_sha256] += 1
            if fn and fn not in {"anonymous"}:
                funcs[fn] += 1
    for group in nearby_groups:
        for row in group[:8]:
            script = row.get("script_url") or ""
            fn = row.get("function_name") or ""
            script_sha256 = row.get("script_sha256") or ""
            weight = 2 if row.get("_same_context") else 1
            if script and script not in {"self-hosted"}:
                scripts[script] += weight
            if script_sha256:
                script_hashes[script_sha256] += weight
            if fn and fn not in {"anonymous"}:
                funcs[fn] += weight
    if not scripts:
        scripts.update(idx.script_counts)
    if not script_hashes:
        script_hashes.update(idx.script_hash_counts)
    if not funcs:
        funcs.update(collections.Counter({fn: n for (_script, fn), n in idx.function_counts.items() if fn}))

    script_tokens = []
    for script, _ in scripts.most_common(8):
        name = pathlib.PurePosixPath(urllib.parse.urlsplit(script).path).name
        script_tokens.append(name or script)

    func_tokens = []
    for fn, _ in funcs.most_common(12):
        if fn and fn not in func_tokens:
            func_tokens.append("=" + fn)

    hash_tokens = []
    for script_sha256, _ in script_hashes.most_common(8):
        if script_sha256 and script_sha256 not in hash_tokens:
            hash_tokens.append("=" + script_sha256)
    return script_tokens, func_tokens, hash_tokens


def build_next_trace_env(
    scripts: list[str], funcs: list[str], script_hashes: list[str], fields: list[str]
) -> str:
    query_fields = []
    for field in fields:
        if field and field not in query_fields:
            query_fields.append(field)
    lines = [
        "# Generated by tools/trace_analyzer.py",
        "# Review TRACE_SCRIPT_CONTAINS / TRACE_FUNCTION_CONTAINS before running on a new site.",
        "TRACE_PROFILE=target",
        "TRACE_JS_MODE=target",
        f"TRACE_SCRIPT_CONTAINS={','.join(scripts)}",
        f"TRACE_FUNCTION_CONTAINS={','.join(funcs)}",
        f"TRACE_SCRIPT_SHA256={','.join(script_hashes)}",
        "TRACE_TARGET_MATCH=all",
        "TRACE_JS_CAPTURE_VALUES=1",
        "TRACE_JS_OBJECT_DEPTH=1",
        "TRACE_JS_OBJECT_KEYS=32",
        "TRACE_JS_ARRAY_ITEMS=16",
        "TRACE_JS_VALUE_STORE=1",
        "TRACE_JS_DEEP_LONG_STR=128",
        "TRACE_JS_VALUE_STORE_MAX_BYTES=8388608",
        f"TRACE_QUERY_FIELDS={','.join(query_fields)}",
    ]
    return "\n".join(lines) + "\n"


def summarize_finding(
    finding: Finding, idx: Index, nearby_window_us: int
) -> dict[str, Any]:
    chain = call_chain(idx, finding.origin_call_id)
    nearby = nearby_calls(idx, finding.row, nearby_window_us)
    row = finding.row
    summary: dict[str, Any] = {
        "kind": finding.kind,
        "field": finding.field,
        "event_type": row.get("type"),
        "origin_call_id": finding.origin_call_id,
        "caller_url": row.get("caller_url"),
        "request_id": row.get("request_id"),
        "query_fields": row.get("query_fields"),
        "chain_found": bool(chain),
        "chain": [
            {
                "call_id": c.get("call_id"),
                "parent_call_id": c.get("parent_call_id"),
                "function_name": c.get("function_name"),
                "script_url": c.get("script_url"),
                "script_id": c.get("script_id"),
                "script_sha256": c.get("script_sha256"),
                "script_source_path": c.get("script_source_path"),
                "script_source_status": c.get("script_source_status"),
                "line": c.get("line"),
                "column": c.get("column"),
            }
            for c in chain[:20]
        ],
        "nearby_calls": [
            {
                "delta_us": c.get("_delta_us"),
                "same_context": c.get("_same_context"),
                "call_id": c.get("call_id"),
                "parent_call_id": c.get("parent_call_id"),
                "function_name": c.get("function_name"),
                "script_url": c.get("script_url"),
                "script_id": c.get("script_id"),
                "script_sha256": c.get("script_sha256"),
                "script_source_path": c.get("script_source_path"),
                "script_source_status": c.get("script_source_status"),
                "line": c.get("line"),
                "column": c.get("column"),
            }
            for c in nearby
        ],
    }
    value = finding.value
    summary["value_preview"] = value[:256] + ("..." if len(value) > 256 else "")
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=pathlib.Path, help="trace log directory or jsonl file")
    parser.add_argument(
        "--preset",
        choices=sorted(PRESET_FIELDS),
        default="generic",
        help="built-in generic field preset; use --field for site-specific target fields",
    )
    parser.add_argument("--field", action="append", default=[], help="extra field names to prioritize")
    parser.add_argument("--max-findings", type=int, default=12)
    parser.add_argument(
        "--nearby-window-us",
        type=int,
        default=5000,
        help="fallback JS-call time window when origin_call_id has no exact chain",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument(
        "--write-next-env",
        nargs="?",
        const="trace-next.env",
        help="write a suggested second-pass env file; default path is trace-next.env in cwd",
    )
    args = parser.parse_args(argv)

    rows = load_jsonl(args.path)
    idx = build_index(rows)
    fields = []
    for name in PRESET_FIELDS[args.preset] + args.field:
        if name and name not in fields:
            fields.append(name)
    findings = prioritize_findings(find_interesting_fields(rows, fields))[
        : args.max_findings
    ]
    chains = [call_chain(idx, f.origin_call_id) for f in findings]
    nearby_groups = [nearby_calls(idx, f.row, args.nearby_window_us) for f in findings]
    scripts, funcs, script_hashes = candidate_filters(chains, nearby_groups, idx)

    report = {
        "path": str(args.path),
        "row_count": len(rows),
        "event_counts": dict(collections.Counter(r.get("type") for r in rows)),
        "field_preset": args.preset,
        "fields": fields,
        "degraded": idx.degraded,
        "finding_count": len(findings),
        "findings": [
            summarize_finding(f, idx, args.nearby_window_us) for f in findings
        ],
        "candidate_next_trace": {
            "TRACE_JS_MODE": "target",
            "TRACE_SCRIPT_CONTAINS": ",".join(scripts),
            "TRACE_FUNCTION_CONTAINS": ",".join(funcs),
            "TRACE_SCRIPT_SHA256": ",".join(script_hashes),
            "TRACE_TARGET_MATCH": "all",
            "TRACE_JS_CAPTURE_VALUES": "1",
            "TRACE_JS_OBJECT_DEPTH": "1",
            "TRACE_JS_VALUE_STORE": "1",
        },
        "top_scripts": idx.script_counts.most_common(20),
        "top_script_hashes": idx.script_hash_counts.most_common(20),
        "script_sources": list(idx.script_sources.values()),
        "top_functions": [
            {"script_url": script, "function_name": fn, "count": count}
            for (script, fn), count in idx.function_counts.most_common(30)
        ],
    }

    next_env = build_next_trace_env(scripts, funcs, script_hashes, fields)
    if args.write_next_env:
        next_path = pathlib.Path(args.write_next_env)
        next_path.write_text(next_env)
        report["next_env_path"] = str(next_path)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    print(f"Trace: {report['path']}")
    print(f"Rows: {report['row_count']}")
    print(f"Field preset: {args.preset} fields={','.join(fields)}")
    if idx.degraded:
        print("WARNING: trace.degraded present; this run is incomplete.")
        for row in idx.degraded[:5]:
            print(f"  - module={row.get('module')} reason={row.get('reason')} limit={row.get('limit')}")
    print(f"Findings: {len(findings)}")
    for i, item in enumerate(report["findings"], 1):
        print(f"\n[{i}] {item['kind']} field={item['field']} type={item['event_type']}")
        print(f"    origin_call_id={item['origin_call_id']} caller={item['caller_url']}")
        print(f"    value={item.get('value_preview')}")
        if item["chain_found"]:
            print("    chain:")
            for c in item["chain"][:8]:
                script_hash = c.get("script_sha256")
                hash_note = f" sha256={script_hash[:12]}" if isinstance(script_hash, str) and script_hash else ""
                source_path = c.get("script_source_path")
                source_note = f" source={source_path}" if isinstance(source_path, str) and source_path else ""
                print(f"      {c['call_id']} {c['function_name']} {c['script_url']}:{c['line']}:{c['column']}{hash_note}{source_note}")
        else:
            print("    chain: not found in JS boundary log")
            if item["nearby_calls"]:
                print(f"    nearby JS calls (+/- {args.nearby_window_us}us):")
                for c in item["nearby_calls"][:6]:
                    print(
                        f"      {c['delta_us']:+}us {c['call_id']} {c['function_name']} "
                        f"{c['script_url']}:{c['line']}:{c['column']}"
                    )
    print("\nCandidate next trace:")
    for key, value in report["candidate_next_trace"].items():
        print(f"  {key}={value}")
    if args.write_next_env:
        print(f"\nWrote next trace env: {args.write_next_env}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
