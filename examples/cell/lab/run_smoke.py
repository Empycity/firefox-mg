#!/usr/bin/env python3
"""One headed localhost run, with an immediate target/time/size watchdog."""
import hashlib
import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

CASE = Path(__file__).resolve().parents[1]
ROOT = CASE.parents[1]
OUT = CASE / "verification" / os.environ.get("CELL_SMOKE_LABEL", "native-smoke")
TRACE = OUT / "trace"
PROFILE = OUT / "profile"
REPORT = OUT / "page-result.json"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        data = (CASE / "lab/vm-stress.html").read_bytes()
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
        assert value["fixture"] == "local-dispatch-v1" and value["steps"] == 2000
        assert value["evidence"] == "trace-batch-evidence:" + "Q" * 4096
        REPORT.write_text(json.dumps(value, indent=2) + "\n")
        data = b'{"ok":true,"fixture":"local-dispatch-v1"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def stop_process(process):
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=8)


def main():
    assert not TRACE.exists(), "Do not overwrite a previous acceptance run"
    OUT.mkdir(parents=True, exist_ok=True)
    config = json.loads((CASE / "agent-next.json").read_text())
    env = os.environ.copy()
    env.update(config["env"])
    env.update({"FIREFOX_BIN": str(CASE / "runtime/Nightly.app/Contents/MacOS/firefox"),
                "FIREFOX_TRACE_PYTHON": sys.executable, "TRACE_DIR": str(TRACE),
                "PROFILE_DIR": str(PROFILE), "TRACE_HEADLESS": "0",
                "TRACE_QUERY_FIELDS": "__disabled__", "TRACE_BODY_FIELDS": "__disabled__",
                "TRACE_HEADER_FIELDS": "__disabled__", "TRACE_COOKIE_FIELDS": "__trace_smoke_finished"})
    browser = watchdog = None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever)
    server_thread.start()
    url = f"http://127.0.0.1:{server.server_port}/vm-stress.html"
    try:
        with (OUT / "launcher.log").open("w") as browser_log, (OUT / "watchdog.log").open("w") as watchdog_log:
            browser = subprocess.Popen([str(ROOT / "tools/run-trace-firefox.sh"),
                                       "--trace-plan", "full-chain", "--trace-preset", "full-chain",
                                       "--trace-start", "active", url], cwd=ROOT, env=env,
                                       stdout=browser_log, stderr=subprocess.STDOUT, start_new_session=True)
            watchdog = subprocess.Popen([sys.executable, str(ROOT / "tools/trace-stop-on-target.py"),
                                        str(TRACE), "--max-seconds", "120", "--max-bytes", "2147483648",
                                        "--url-contains", f"127.0.0.1:{server.server_port}"], cwd=ROOT,
                                        env=env, stdout=watchdog_log, stderr=subprocess.STDOUT, start_new_session=True)
            receipt = {"browser_pid": browser.pid, "watchdog_pid": watchdog.pid,
                       "headless": False, "url": url, "trace": str(TRACE), "started_at": time.time()}
            (OUT / "process-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            time.sleep(2)
            receipt["process_observation"] = subprocess.run(
                ["/bin/ps", "-p", str(browser.pid), "-o", "pid=,comm="], capture_output=True, text=True).stdout
            (OUT / "process-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            code = watchdog.wait(timeout=145)
            stop_process(browser)
            print("watchdog_exit", code)
            assert code == 0 and REPORT.exists(), "Local page/watchdog did not complete; inspect retained logs"
    finally:
        stop_process(watchdog)
        stop_process(browser)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
    health = json.loads((TRACE / "index/trace-health.json").read_text())
    summary = json.loads((TRACE / "index/summary.json").read_text())
    page = json.loads(REPORT.read_text())
    assert not health["incomplete_reasons"], health["incomplete_reasons"]
    assert summary["js_value_artifact_count"] > 0
    # This fixture is an inline script, not a downloaded script.resource.
    # Its source is retained by the SpiderMonkey source-dump hook instead.
    source_artifact_count = len(list((TRACE / "scripts").glob("*")))
    assert source_artifact_count > 0
    assert page["heartbeats"] > 0
    result = {"passed": True, "fixture": page["fixture"], "steps": page["steps"],
              "elapsed_ms": page["elapsedMs"], "heartbeats": page["heartbeats"],
              "max_heartbeat_gap_ms": page["maxHeartbeatGapMs"],
              "evidence_complete": health["evidence_complete"], "health_counts": health["counts"],
              "js_value_artifact_count": summary["js_value_artifact_count"],
              "script_identity": summary["script_identity"],
              "source_artifact_count": source_artifact_count,
              "fixture_sha256": hashlib.sha256((CASE / "lab/vm-stress.html").read_bytes()).hexdigest(),
              "scope": "Local headed regression, not a remote-site no-hang guarantee"}
    (OUT / "acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
