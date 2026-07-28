#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import sys
import urllib.request


def iter_script_events(trace_dir: pathlib.Path):
    for path in sorted(trace_dir.glob("firefox-script-*.jsonl")):
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line_no, line in enumerate(f, 1):
                if "source_map_resolved_url" not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    print(f"skip invalid json: {path}:{line_no}", file=sys.stderr)
                    continue
                if event.get("type") == "script.resource":
                    yield path, line_no, event


def source_map_name(event):
    raw_sha = event.get("raw_sha256")
    if raw_sha:
        return f"{raw_sha}.map"
    url = event.get("final_url") or event.get("url") or "unknown-script"
    return hashlib.sha256(url.encode("utf-8", errors="replace")).hexdigest() + ".map"


def fetch_bytes(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "firefoxTrace-source-map-fetcher"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch source maps referenced by firefox-script-*.jsonl into a trace directory."
    )
    parser.add_argument("trace_dir", type=pathlib.Path)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    trace_dir = args.trace_dir.resolve()
    out_dir = trace_dir / "source_maps"
    index_path = out_dir / "index.jsonl"
    events = list(iter_script_events(trace_dir))
    if not events:
        print("no source_map_resolved_url entries found")
        return 0

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for log_path, line_no, event in events:
        url = event.get("source_map_resolved_url")
        if not url:
            continue
        rel_path = pathlib.Path("source_maps") / source_map_name(event)
        abs_path = trace_dir / rel_path
        record = {
            "schema": "firefox_trace.source_map_artifact.v1",
            "source_map_url": event.get("source_map_url", ""),
            "source_map_resolved_url": url,
            "script_url": event.get("final_url") or event.get("url", ""),
            "script_raw_sha256": event.get("raw_sha256", ""),
            "script_artifact_path": event.get("artifact_path", ""),
            "script_log": str(log_path),
            "script_log_line": line_no,
            "artifact_path": str(rel_path),
        }
        if args.dry_run:
            print(json.dumps({**record, "status": "dry_run"}, ensure_ascii=False))
            continue
        if abs_path.exists() and not args.overwrite:
            record["status"] = "exists"
            record["size"] = abs_path.stat().st_size
        else:
            try:
                data = fetch_bytes(url, args.timeout)
                abs_path.write_bytes(data)
                record["status"] = "stored"
                record["size"] = len(data)
                record["sha256"] = hashlib.sha256(data).hexdigest()
                written += 1
            except Exception as exc:
                record["status"] = "error"
                record["error"] = str(exc)
        with index_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            f.write("\n")
        print(json.dumps(record, ensure_ascii=False, sort_keys=True))

    print(f"source maps stored: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
