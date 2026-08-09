#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from curl_cffi import requests
except ModuleNotFoundError as exc:
    raise SystemExit("Missing dependency: pip install curl_cffi") from exc


# Env-patched Node VM version. Edit these values directly in PyCharm.
PAGE = 3
TIMEOUT = 20
H5ST_TIMEOUT_MS = 30000

# Fresh by default: regenerate h5st fp/tk03, risk fp/jsToken/eid, and protocol cookies.
RESET_STATE_BEFORE_RUN = True
DELETE_STATE_AFTER_RUN = True

# Keep empty for anonymous protocol state. Set an absolute path for one-off cookie replay.
COOKIE_FILE = ""

IMPERSONATE = "chrome120"
PRINT_SIGNED_REQUEST = False
PRINT_RESPONSE_HEADERS = False


THIS_DIR = Path(__file__).resolve().parent
NODE_INDEX = THIS_DIR / "index.js"
STATE_FILE = THIS_DIR / "state" / "index_state.json"


def clear_state() -> None:
    if STATE_FILE.exists():
        STATE_FILE.unlink()


def build_signed_request() -> dict:
    env = os.environ.copy()
    env["JD_PRINT_HEADERS"] = "1"
    env["JD_FORCE_H5ST_INIT"] = "1"
    env.pop("JD_FETCH", None)
    if COOKIE_FILE:
        env["JD_COOKIE_FILE"] = COOKIE_FILE

    proc = subprocess.run(
        ["node", str(NODE_INDEX), f"--page={PAGE}", f"--h5st-timeout={H5ST_TIMEOUT_MS}"],
        cwd=str(THIS_DIR),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout).strip())

    return json.loads(proc.stdout)


def fetch_response(signed_request: dict):
    return requests.get(
        signed_request["url"],
        headers=signed_request["headers"],
        impersonate=IMPERSONATE,
        timeout=TIMEOUT,
    )


def print_response(response) -> None:
    print(f"HTTP {response.status_code}", file=sys.stderr)
    if PRINT_RESPONSE_HEADERS:
        print(json.dumps(dict(response.headers), ensure_ascii=False, indent=2), file=sys.stderr)

    try:
        body = response.json()
    except ValueError:
        print(response.text)
    else:
        print(json.dumps(body, ensure_ascii=False, indent=2))


def main() -> None:
    if RESET_STATE_BEFORE_RUN:
        clear_state()

    try:
        signed_request = build_signed_request()
        if PRINT_SIGNED_REQUEST:
            print(json.dumps(signed_request, ensure_ascii=False, indent=2), file=sys.stderr)
        response = fetch_response(signed_request)
        print_response(response)
    finally:
        if DELETE_STATE_AFTER_RUN:
            clear_state()


if __name__ == "__main__":
    main()
