#!/usr/bin/env python3
"""Build the two account-scoped runtime files from a Chrome create_v2 curl and Storage export."""
from __future__ import annotations

import argparse
import base64
import json
import shlex
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit


def curl_parts(text: str):
    args = shlex.split(text.replace("\\\n", " "))
    url = next((x for x in args if x.startswith("http")), "")
    headers = {}
    cookie = ""
    for i, item in enumerate(args):
        if item in ("-H", "--header") and i + 1 < len(args):
            name, sep, value = args[i + 1].partition(":")
            if sep:
                headers[name.strip().lower()] = value.strip()
        if item in ("-b", "--cookie") and i + 1 < len(args):
            cookie = args[i + 1]
    return url, headers, cookie, request_body_from_curl_args(args)


def strip_query_keys(url: str, names: set[str]) -> str:
    from urllib.parse import urlencode, urlunsplit
    parts = urlsplit(url)
    pairs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in names]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(pairs), parts.fragment))


def normalize_request_body(value):
    """Return the actual JSON body from js-reverse/DevTools wrapper shapes."""
    if isinstance(value, dict):
        # js-reverse may export requestBody as {available,size,encoding,text}.
        if isinstance(value.get("text"), str):
            try:
                return json.loads(value["text"])
            except json.JSONDecodeError:
                return value
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return normalize_request_body(parsed)
    return None


def request_body_from_export(request: dict):
    for key in ("requestBody", "postData", "body"):
        body = normalize_request_body(request.get(key))
        if body is not None:
            return body
    return None


def request_body_from_curl_args(args: list[str]):
    for i, item in enumerate(args):
        if item in ("--data-raw", "--data", "--data-binary", "--data-ascii", "-d") and i + 1 < len(args):
            return normalize_request_body(args[i + 1])
        for prefix in ("--data-raw=", "--data=", "--data-binary=", "--data-ascii="):
            if item.startswith(prefix):
                return normalize_request_body(item.split("=", 1)[1])
    return None

def unwrap(value):
    if isinstance(value, dict) and isinstance(value.get("data"), str):
        try:
            return json.loads(value["data"])
        except json.JSONDecodeError:
            return value
    return value


def load_storage(path: Path):
    root = json.loads(path.read_text(encoding="utf-8"))
    if "crypt" in root and "sign" in root:
        crypt, sign = unwrap(root["crypt"]), unwrap(root["sign"])
        local = {
            "security-sdk/s_sdk_crypt_sdk": json.dumps({"data": json.dumps(crypt, separators=(",", ":"))}, separators=(",", ":")),
            "security-sdk/s_sdk_sign_data_key/web_protect": json.dumps({"data": json.dumps(sign, separators=(",", ":"))}, separators=(",", ":")),
        }
        return crypt, sign, local, {},
    local = root.get("localStorage") or root.get("local") or {}
    session = root.get("sessionStorage") or root.get("session") or {}
    if not local:
        raise SystemExit("storage export has no localStorage/local object")
    crypt = unwrap(json.loads(local["security-sdk/s_sdk_crypt_sdk"]))
    sign = unwrap(json.loads(local["security-sdk/s_sdk_sign_data_key/web_protect"]))
    return crypt, sign, local, session


def ecdh_bytes(pem: str) -> list[int]:
    js = """const fs=require('fs'),crypto=require('crypto'); const k=crypto.createPrivateKey(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify([...Buffer.from(k.export({format:'jwk'}).d,'base64url')]));"""
    run = subprocess.run(["node", "-e", js], input=pem, text=True, capture_output=True, check=True)
    return json.loads(run.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--curl", type=Path, help="file containing Copy as cURL output")
    ap.add_argument("--request-json", type=Path, help="js-reverse exported request JSON")
    ap.add_argument("--storage", type=Path, required=True, help="JSON copied from the Storage export snippet")
    ap.add_argument("--dir", type=Path, default=Path(__file__).parent)
    args = ap.parse_args()
    if bool(args.curl) == bool(args.request_json):
        raise SystemExit("provide exactly one of --curl or --request-json")
    current_body = None
    if args.request_json:
        request = json.loads(args.request_json.read_text(encoding="utf-8"))
        url = request.get("url", "")
        headers = {str(k).lower(): str(v) for k, v in request.get("requestHeaders", {}).items()}
        cookie = headers.get("cookie", "")
        current_body = request_body_from_export(request)
    else:
        url, headers, cookie, current_body = curl_parts(args.curl.read_text(encoding="utf-8"))
    crypt, sign, local, session = load_storage(args.storage)
    if current_body is not None and (not isinstance(current_body, dict) or "item" not in current_body):
        raise SystemExit("create_v2 request body is missing item; copy the final create_v2 request as cURL again")
    missing = [name for name, value in {
        "curl/request URL": url, "Cookie": cookie, "bd-ticket-guard-client-data": headers.get("bd-ticket-guard-client-data"),
        "x-secsdk-csrf-token": headers.get("x-secsdk-csrf-token"),
        "x-tt-session-dtrait": headers.get("x-tt-session-dtrait"), "ec_privateKey": crypt.get("ec_privateKey"),
        "ticket": sign.get("ticket"), "ts_sign": sign.get("ts_sign"), "client_cert": sign.get("client_cert"),
    }.items() if not value]
    if missing:
        raise SystemExit("missing required fields: " + ", ".join(missing))
    query = dict(parse_qsl(urlsplit(url).query))
    if query.get("msToken") and "msToken=" not in cookie:
        cookie = cookie.rstrip("; ") + "; msToken=" + query["msToken"]
    cookie_map = dict(part.strip().split("=", 1) for part in cookie.split(";") if "=" in part)
    if query.get("msToken") and cookie_map.get("msToken") and unquote(query["msToken"]) != unquote(cookie_map["msToken"]):
        raise SystemExit("inconsistent input: URL msToken differs from Cookie msToken")
    guard = headers.get("bd-ticket-guard-client-data")
    if guard:
        try:
            guard_data = json.loads(base64.b64decode(unquote(guard) + "=="))
            if guard_data.get("ts_sign") and guard_data["ts_sign"] != sign.get("ts_sign"):
                raise SystemExit("inconsistent input: Ticket Guard ts_sign differs from Storage")
        except (ValueError, json.JSONDecodeError) as exc:
            raise SystemExit(f"invalid bd-ticket-guard-client-data: {exc}") from exc
    if headers.get("bd-ticket-guard-ree-public-key") and sign.get("client_cert"):
        if headers["bd-ticket-guard-ree-public-key"] != sign["client_cert"].removeprefix("pub."):
            raise SystemExit("inconsistent input: Ticket Guard public key differs from Storage")
    runtime = {
        "schema": "douyin.local_security_runtime.v1", "ecdh_key": ecdh_bytes(crypt["ec_privateKey"]),
        "ticket": sign["ticket"], "ts_sign": sign["ts_sign"],
        "ree_public_key": sign["client_cert"].removeprefix("pub."),
        "origin": "https://creator.douyin.com", "referer": "https://creator.douyin.com/creator-micro/content/manage",
        "sec_ch_ua": headers.get("sec-ch-ua", ""), "sec_ch_ua_mobile": headers.get("sec-ch-ua-mobile", "?0"),
        "sec_ch_ua_platform": headers.get("sec-ch-ua-platform", "\"macOS\""),
        "csrf": headers["x-secsdk-csrf-token"], "x_tt_session_dtrait": headers["x-tt-session-dtrait"],
    }
    if headers.get("bd-ticket-guard-client-data"):
        runtime["bd_ticket_guard_client_data_header"] = headers["bd-ticket-guard-client-data"]
    out = args.dir
    full_storage = {"localStorage": local, "sessionStorage": session}
    (out / "security-storage-full.json").write_text(json.dumps(full_storage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "security-runtime.json").write_text(json.dumps(runtime, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "cookie.txt").write_text(cookie.strip(), encoding="utf-8")
    contract_path = out / "creator-runtime-contract.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    cookies = {}
    for part in cookie.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name: cookies[name] = unquote(value)
    seed = contract.setdefault("restore_seed", {})
    seed["cookies"] = cookies
    if local:
        merged_local = dict(seed.get("localStorage", {}))
        merged_local.update(local)
        seed["localStorage"] = merged_local
    if session:
        merged_session = dict(seed.get("sessionStorage", {}))
        merged_session.update(session)
        seed["sessionStorage"] = merged_session
    # 同步当前浏览器成功 create_v2 的 URL/body 模板。a_bogus 每次本地重算，不写入模板。
    if url:
        contract.setdefault("request", {})["unsigned_url"] = strip_query_keys(url, {"a_bogus"})
    if current_body:
        contract.setdefault("request", {})["body"] = current_body
    contract_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("updated cookie.txt, security-runtime.json, security-storage-full.json, creator-runtime-contract.json")
    print("required fields ok: Cookie, URL msToken, bd-ticket-guard-client-data, csrf, dtrait, ecdh private key, ticket, ts_sign, public key")


if __name__ == "__main__":
    main()
