#!/usr/bin/env python3
"""Replay the fixed comment-list vector through Python with live Firefox cookies.

The only query mutation is a_bogus.  Browser-added request state is taken from
the active Firefox profile; the contract supplies the captured request vector.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from curl_cffi import requests


ROOT = Path(__file__).resolve().parent
DEFAULT_CONTRACT = ROOT / "runtime-contract.json"
DEFAULT_PROFILE = Path(os.environ.get("DOUYIN_FIREFOX_PROFILE", "/private/tmp/firefox-native-replay-134318-cdp"))


def runner_signature(path: Path) -> str:
    return signature_from_report(json.loads(path.read_text()))


def signature_from_report(report: dict) -> str:
    request = next(entry for entry in report["xhr"] if entry["phase"] == "send")
    return dict(parse_qsl(urlsplit(request["url"]).query, keep_blank_values=True))["a_bogus"]


def generate_signature(contract_path: Path) -> str:
    runner = ROOT / "bdms-runner.js"
    completed = subprocess.run(
        ["node", str(runner), "--config", str(contract_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return signature_from_report(json.loads(completed.stdout))


def replace_signature(url: str, signature: str) -> str:
    parts = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != "a_bogus"]
    query.append(("a_bogus", signature))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def host_matches(cookie_host: str, request_host: str) -> bool:
    domain = cookie_host.lstrip(".").lower()
    host = request_host.lower()
    return host == domain or host.endswith("." + domain)


def profile_cookie_header(profile: Path, request_host: str) -> str:
    cookie_db = profile / "cookies.sqlite"
    # Firefox keeps recent writes in a WAL that can hold an exclusive lock.
    # Querying a short-lived file snapshot includes HttpOnly cookies without
    # interrupting the active browser process.
    with tempfile.TemporaryDirectory(prefix="firefox-cookie-snapshot-") as directory:
        snapshot = Path(directory) / cookie_db.name
        for suffix in ("", "-wal", "-shm"):
            source = Path(f"{cookie_db}{suffix}")
            if source.exists():
                shutil.copy2(source, Path(f"{snapshot}{suffix}"))
        with sqlite3.connect(snapshot) as connection:
            rows = connection.execute("SELECT host, name, value FROM moz_cookies").fetchall()
    cookies = [(name, value) for host, name, value in rows if host_matches(host, request_host)]
    return "; ".join(f"{name}={value}" for name, value in cookies)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--all-cookies", action="store_true", help="use all applicable profile cookies instead of only ttwid")
    parser.add_argument("--no-response", action="store_true", help="omit the complete response body from JSON output")
    signature = parser.add_mutually_exclusive_group()
    signature.add_argument("--a-bogus")
    signature.add_argument("--runner-json", type=Path)
    args = parser.parse_args()

    contract = json.loads(args.contract.read_text())
    value = args.a_bogus or (runner_signature(args.runner_json) if args.runner_json else generate_signature(args.contract))
    request = contract["request"]
    url = replace_signature(request["unsigned_url"], value)
    target = urlsplit(url)
    headers = dict(request["headers"])
    headers["User-Agent"] = contract["environment_contract"]["values"]["Navigator.userAgent"]["value"]
    headers["Referer"] = "https://www.douyin.com/"
    cookie_header = profile_cookie_header(args.profile, target.hostname or "")
    if not args.all_cookies:
        cookie_header = "; ".join(
            part for part in cookie_header.split("; ") if part.split("=", 1)[0] == "ttwid"
        )
    headers["Cookie"] = cookie_header

    response = requests.get(
        url,
        headers=headers,
        impersonate="firefox135",
        timeout=30,
        allow_redirects=False,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = None
    output = {
        "http_status": response.status_code,
        "response_bytes": len(response.content),
        "json_status_code": payload.get("status_code") if isinstance(payload, dict) else None,
        "comments": len(payload.get("comments", [])) if isinstance(payload, dict) else 0,
        "a_bogus_length": len(value),
        "a_bogus_sha256": hashlib.sha256(value.encode()).hexdigest(),
        "cookie_count": len([part for part in headers.get("Cookie", "").split("; ") if part]),
        "accepted": response.status_code == 200 and isinstance(payload, dict) and payload.get("status_code") == 0 and bool(payload.get("comments")),
    }
    if not args.no_response:
        output["response"] = response.text
    print(json.dumps(output, indent=2))
    return 0 if output["accepted"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
