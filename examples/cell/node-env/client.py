#!/usr/bin/env python3
"""Cell browser-less client skeleton.

Python owns the session/cookies and transport; Node (harness.js) owns the
supplemented JS environment for the Cloudflare chl_page orchestrate script.

Current boundary (see FINDINGS.md): the harness passes the orchestrate VM's
init checks and opens the first eb/ beacon, but the final fo/ clearance POST
requires the Turnstile iframe VM (challenges.cloudflare.com), which is not
yet reproduced offline. This client reports the exact stage reached instead
of pretending to obtain cf_clearance.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE / "harness.js"
TARGET = "https://www.cell.com/"


def run(stage_ms: int = 45000) -> int:
    env = dict(os.environ, HARNESS_MS=str(stage_ms))
    proc = subprocess.run(
        ["node", str(HARNESS)], cwd=HERE, env=env,
        capture_output=True, text=True, timeout=stage_ms / 1000 + 60,
    )
    log_path = HERE / "harness-log.json"
    log = json.loads(log_path.read_text()) if log_path.exists() else {"log": [], "cookies": []}
    cookies = {c["name"]: c["value"] for c in log.get("cookies", [])}
    kinds: dict[str, int] = {}
    for rec in log.get("log", []):
        kinds[rec["kind"]] = kinds.get(rec["kind"], 0) + 1
    print(json.dumps({
        "node_exit": proc.returncode,
        "target": TARGET,
        "cookies_seen": sorted(cookies),
        "cf_clearance": cookies.get("cf_clearance"),
        "stage_activity": kinds,
        "stderr_tail": proc.stderr.strip().splitlines()[-3:],
    }, ensure_ascii=False, indent=1))
    return 0 if cookies.get("cf_clearance") else 3


if __name__ == "__main__":
    sys.exit(run())
