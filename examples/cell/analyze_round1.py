#!/usr/bin/env python3
"""Read-only, LF-streaming inventory; redact payloads and volatile URLs."""
import collections
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

CASE = Path(__file__).resolve().parent
TRACE = CASE / "traces/round1"


def rows(path):
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if line.strip():
                yield number, json.loads(line)


def script_role(url):
    path = urlsplit(url).path
    if "/orchestrate/" in path:
        return "top-level-challenge"
    if "/challenge-platform/" in path and "/turnstile/" in path:
        return "challenge-iframe"
    return urlsplit(url)._replace(query="", fragment="").geturl()


def main():
    health = json.loads((TRACE / "index/trace-health.json").read_text())
    counters, scripts, functions, pids = (collections.Counter() for _ in range(4))
    anchors, requests = {}, {}
    cookie_milestones, script_resources, hashes = [], [], {}
    for path in sorted(TRACE.glob("firefox-*.jsonl")):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        hashes[path.name] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
        if "-js-" in path.name:
            continue
        for number, event in rows(path):
            kind = event.get("type", "")
            if kind.startswith(("xhr.", "fetch.")):
                key = (event.get("pid"), event.get("request_id"))
                item = requests.setdefault(key, {"pid": key[0], "request_id": key[1], "events": []})
                url = urlsplit(event.get("url", ""))
                if url.netloc:
                    # Path groups prove routing without exporting session-bearing suffixes.
                    parts = url.path.split("/")
                    item["endpoint"] = url.netloc + "/".join(parts[:7])
                item["events"].append({k: event[k] for k in ["type", "ts_us", "status", "body_length", "body_size", "origin_call_id"] if k in event} | {"source": f"{path.name}:{number}"})
                if event.get("origin_call_id"):
                    anchors[(event["pid"], event["origin_call_id"])] = None
            if kind in {"cookie.http_set", "cookie.set"}:
                cookie_milestones.append({"type": kind, "key": event.get("key"), "ts_us": event.get("ts_us"), "source": f"{path.name}:{number}", "outcome": event.get("outcome")})
            if kind == "script.resource":
                script_resources.append({k: event.get(k) for k in ["url", "artifact_stored", "raw_capture_enabled", "raw_size", "raw_captured_size"]} | {"source": f"{path.name}:{number}"})
    parents, selected = {}, {}
    for path in sorted(TRACE.glob("firefox-js-*.jsonl")):
        for number, event in rows(path):
            counters[event.get("type")] += 1
            pids[event.get("pid")] += 1
            if event.get("type", "").startswith("js.call."):
                role = script_role(event.get("script_url", ""))
                scripts[role] += 1
                functions[(role, event.get("function_name"))] += 1
                key = (event.get("pid"), event.get("call_id"))
                parents[key] = event.get("parent_call_id")
                if key in anchors:
                    selected[key] = {k: event.get(k) for k in ["pid", "call_id", "parent_call_id", "function_name", "js_mode", "target_match"]} | {"script_role": role, "source": f"{path.name}:{number}"}
    chains = []
    for key in anchors:
        cursor, seen, depth = key[1], set(), 0
        while cursor and cursor not in seen and (key[0], cursor) in parents:
            seen.add(cursor)
            cursor = parents[(key[0], cursor)]
            depth += 1
        chains.append({"pid": key[0], "origin_call_id": key[1], "observed": selected.get(key), "retained_ancestor_depth": depth, "missing_ancestor": cursor})
    summary = {
        "schema": "cell.trace_review.v1", "source": str(TRACE),
        "evidence_complete": health["evidence_complete"], "health_counts": health["counts"],
        "incomplete_reasons": health["incomplete_reasons"],
        "loss_reason_counts": dict(collections.Counter(e.get("reason") for e in health["limit_triggers"])),
        "js_event_counts": dict(counters), "js_pid_counts": dict(pids),
        "script_roles": scripts.most_common(),
        "hot_functions": [{"script_role": key[0], "function": key[1], "events": value} for key, value in functions.most_common(15)],
        "request_timelines": list(requests.values()), "origin_chains": chains,
        "cookie_milestones": cookie_milestones, "script_resources": script_resources,
        "source_hashes": hashes,
        "constraints": ["HTTP statuses are observations, not an application-success proof.", "Server-issued cookies are state milestones, not JS producer returns.", "A static-fallback script is not a proved VM identity.", "Missing JS values and source artifacts cannot be recovered from this light trace."],
    }
    destination = CASE / "analysis/round1-review.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "js_events": sum(counters.values()), "requests": len(requests), "resolved_origins": sum(x["observed"] is not None for x in chains), "origins": len(chains), "evidence_complete": health["evidence_complete"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
