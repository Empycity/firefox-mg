#!/usr/bin/env python3
"""Headed localhost A/B runner and pure-Python artifact-integrity verifier.

This is a collector test, not an implementation of a website challenge.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
VALUES = [b"ASCII:" + b"Q" * 262144,
          b"NUL:" + b"A" * 4096 + b"\0" + b"B" * 262144,
          ("UNICODE:" + "中😀\u2028\u2029" * 18000).encode()]
TAIL = b"TAIL_AFTER_TARGET:value-transport-v2"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def verify(trace):
    """Offline only: check every JS artifact reference, not just health flags."""
    cache, errors, expected_refs, rows = {}, [], {}, 0
    manifest_path = trace / "fixture-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for item in manifest["files"]:
            path = trace / item["path"]
            if not path.resolve().is_relative_to(trace.resolve()):
                errors.append(f"manifest path outside fixture: {item['path']}")
                continue
            try:
                data = path.read_bytes()
                if digest(data) != item["sha256"] or len(data) != item["bytes"]:
                    errors.append(f"manifest hash/length mismatch: {item['path']}")
            except OSError as exc:
                errors.append(f"manifest missing file {item['path']}: {exc}")
    wanted = {digest(value) for value in VALUES}
    max_preview_bytes = 0
    tail_refs = 0
    event_counts = {}
    for path in sorted(trace.glob("firefox-js-*.jsonl")):
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError) as exc:
                    errors.append(f"{path.name}:{number}: {exc}")
                    continue
                rows += 1
                typ = row.get("type", "")
                event_counts[typ] = event_counts.get(typ, 0) + 1
                for item in walk(row):
                    relative = item.get("value_store_path")
                    if not relative:
                        continue
                    artifact = trace / relative
                    if not artifact.resolve().is_relative_to(trace.resolve()):
                        errors.append(f"artifact outside trace: {relative}")
                        continue
                    if relative not in cache:
                        try:
                            data = artifact.read_bytes()
                            cache[relative] = (digest(data), len(data))
                        except OSError as exc:
                            errors.append(f"missing artifact {relative}: {exc}")
                            cache[relative] = (None, None)
                    actual_hash, actual_len = cache[relative]
                    if item.get("sha256") and item["sha256"] != actual_hash:
                        errors.append(f"artifact hash mismatch: {relative}")
                    size = item.get("size")
                    if isinstance(size, int) and size != actual_len:
                        errors.append(f"artifact length mismatch: {relative}")
                    if actual_hash in wanted:
                        expected_refs[actual_hash] = expected_refs.get(actual_hash, 0) + 1
                        preview = item.get("preview", "")
                        max_preview_bytes = max(max_preview_bytes, len(preview.encode()))
                    if actual_hash == digest(TAIL):
                        tail_refs += 1
    complete_values = []
    for value in VALUES:
        path = trace / "values" / (digest(value) + ".txt")
        complete_values.append(path.is_file() and path.read_bytes() == value)
    result = {"js_rows": rows, "event_counts": event_counts,
              "unique_referenced_artifacts": len(cache), "artifact_errors": errors,
              "full_test_values_equal": complete_values, "expected_value_references": expected_refs,
              "max_test_value_inline_bytes": max_preview_bytes, "post_target_tail_references": tail_refs,
              "js_log_bytes": sum(p.stat().st_size for p in trace.glob("firefox-js-*.jsonl")),
              "fixture_sha256": digest((HERE / "value-stress.html").read_bytes())}
    result["passed"] = (rows > 0 and not errors and all(complete_values)
                        and len(expected_refs) == 3 and tail_refs > 0)
    return result


def stop(process):
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=8)


def run(args):
    out = HERE / "runs" / args.label
    if out.exists():
        raise FileExistsError(out)
    out.mkdir(parents=True)
    trace, profile = out / "trace", out / "profile"
    expected = [{"size": len(value), "sha256": digest(value)} for value in VALUES]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != "/value-stress.html":
                self.send_error(404)
                return
            data = (HERE / "value-stress.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            if self.path != "/complete" or not 0 < length < 65536:
                self.send_error(400)
                return
            value = json.loads(self.rfile.read(length))
            if value.get("digests") != expected or value.get("iterations") != 48:
                self.send_error(422)
                return
            (out / "page-result.json").write_text(json.dumps(value, indent=2) + "\n")
            data = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/value-stress.html"
    # No inherited tracing overrides: each run records the same explicit inputs.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("TRACE_", "FIREFOX_TRACE_"))}
    env.update({"FIREFOX_BIN": str(Path(args.runtime).resolve()),
                "FIREFOX_TRACE_PYTHON": sys.executable,
                "TRACE_DIR": str(trace), "PROFILE_DIR": str(profile), "TRACE_HEADLESS": "0",
                "TRACE_QUERY_FIELDS": "__disabled__", "TRACE_BODY_FIELDS": "__disabled__",
                "TRACE_HEADER_FIELDS": "__disabled__", "TRACE_COOKIE_FIELDS": "__trace_transport_finished",
                "TRACE_JS_FULL_SPOOL": "1", "TRACE_JS_SCRIPT_EVENTS": "1",
                "TRACE_JS_CAPTURE_VALUES": "1", "TRACE_JS_AUTO_CAPTURE_VALUES": "1",
                "TRACE_JS_THIS": "preview", "TRACE_JS_ARGS": "preview", "TRACE_JS_RET": "preview",
                "TRACE_JS_MAX_VALUE_BYTES": "0", "TRACE_JS_VALUE_STORE_MIN_BYTES": "1",
                "TRACE_JS_VALUE_STORE_MAX_BYTES": "0", "TRACE_JS_DEFERRED_VALUE_CAPTURE": "1",
                "TRACE_JS_OBJECT_DEPTH": "0", "TRACE_DOM": "0", "TRACE_STORAGE": "0",
                "TRACE_WS": "0", "TRACE_WASM": "0", "TRACE_JS_BOUNDARY_BUFFER": "1",
                "TRACE_IPC_MAX_EVENTS_PER_SECOND": "0", "TRACE_IPC_MAX_BYTES_PER_SECOND": "0"})
    browser = watchdog = None
    try:
        with (out / "launcher.log").open("w") as launch_log, (out / "watchdog.log").open("w") as watch_log:
            browser = subprocess.Popen([str(ROOT / "tools/run-trace-firefox.sh"), "--trace-plan", "full-chain",
                                        "--trace-preset", "full-chain", "--trace-start", "active", url],
                                       cwd=ROOT, env=env, stdout=launch_log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            watchdog = subprocess.Popen([sys.executable, str(ROOT / "tools/trace-stop-on-target.py"), str(trace),
                                         "--max-seconds", "120", "--max-bytes", "2147483648",
                                         "--url-contains", f"127.0.0.1:{server.server_port}"],
                                        cwd=ROOT, env=env, stdout=watch_log, stderr=subprocess.STDOUT,
                                        start_new_session=True)
            receipt = {"browser_pid": browser.pid, "watchdog_pid": watchdog.pid,
                       "url": url, "runtime": args.runtime, "headed": True, "start": time.time()}
            (out / "processes.json").write_text(json.dumps(receipt, indent=2) + "\n")
            code = watchdog.wait(timeout=150)
            if code:
                raise RuntimeError(f"watchdog exit {code}; inspect {out}")
    finally:
        stop(watchdog)
        stop(browser)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        (out / "cleanup.json").write_text(json.dumps({"browser_exit": browser.poll() if browser else None,
            "watchdog_exit": watchdog.poll() if watchdog else None, "server_thread_alive": thread.is_alive()}, indent=2) + "\n")
    result = verify(trace)
    result["page"] = json.loads((out / "page-result.json").read_text())
    result["health"] = json.loads((trace / "index/trace-health.json").read_text())
    (out / "acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "health"}, ensure_ascii=False))
    if args.expect_new:
        assert not result["artifact_errors"], result["artifact_errors"][:5]
        assert all(result["full_test_values_equal"])
        assert len(result["expected_value_references"]) == 3
        assert result["post_target_tail_references"] > 0
        assert result["max_test_value_inline_bytes"] <= 515
        assert not result["health"]["incomplete_reasons"]
        assert result["page"]["heartbeats"] > 0
        assert result["page"]["maxHeartbeatGapMs"] < 1000


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime")
    parser.add_argument("--label")
    parser.add_argument("--expect-new", action="store_true")
    parser.add_argument("--verify-trace", type=Path, help="Offline Python-only verification; starts no browser")
    args = parser.parse_args()
    if args.verify_trace:
        result = verify(args.verify_trace)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        sys.exit(0 if result["passed"] else 1)
    if not args.runtime or not args.label or Path(args.label).name != args.label:
        parser.error("--runtime and a single-component --label are required")
    run(args)
