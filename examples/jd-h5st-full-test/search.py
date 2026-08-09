#!/usr/bin/env python3
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote

from h5st_pure import (
    TOKEN_COOKIE_KEY,
    build_search_headers,
    build_url,
    compact_json,
    cookie_object_to_string,
    fetch_json_get,
    parse_cookie_string,
    read_cookie_file,
    request_h5st_token,
    search_offset,
    search_uuid,
    sha256_hex,
    sign_h5st,
)


# Edit these values directly in PyCharm.
KEYWORD = "iPhone17"
PAGE = 2
S = None
PVID = ""
TIMEOUT = 20

IMPERSONATE = "chrome120"
PRINT_SIGNED_REQUEST = False
PRINT_RESPONSE_HEADERS = False


THIS_DIR = Path(__file__).resolve().parent
COOKIE_FILE = THIS_DIR / "config" / "search_cookie.json"


def random_pvid() -> str:
    return __import__("secrets").token_hex(16)


def search_page_url() -> str:
    encoded_keyword = quote(str(KEYWORD), safe="")
    return f"https://search.jd.com/Search?keyword={encoded_keyword}&enc=utf-8"


def build_search_body(cookie_fields: dict[str, str], pvid: str, s: int) -> dict:
    area = (cookie_fields.get("ipLoc-djd") or "21-1911-1915-26809").replace("-", "_")
    return {
        "enc": "utf-8",
        "pvid": pvid,
        "from": "home",
        "area": area,
        "page": PAGE,
        "mode": "",
        "concise": False,
        "hoverPictures": False,
        "newAdvRepeat": True,
        "mixerParam": True,
        "new_interval": True,
        "s": s,
    }


def build_signed_request() -> dict:
    if not COOKIE_FILE.exists():
        raise SystemExit(f"Missing login cookie file: {COOKIE_FILE}")

    cookie = read_cookie_file(COOKIE_FILE)
    cookie_fields = parse_cookie_string(cookie)
    if not cookie_fields.get("thor") and not cookie_fields.get("pin"):
        raise RuntimeError("Login cookie is required for search; missing thor/pin")

    js_token = cookie_fields.get(TOKEN_COOKIE_KEY, "")
    if not js_token:
        raise RuntimeError(f"Login cookie is missing {TOKEN_COOKIE_KEY}; search needs x-api-eid-token")

    uuid = search_uuid(cookie_fields)
    if not uuid:
        raise RuntimeError("Cannot derive uuid from login cookie")

    pvid = PVID or random_pvid()
    s = search_offset(PAGE, S)
    body = build_search_body(cookie_fields, pvid, s)
    body_text = compact_json(body)
    t = int(time.time() * 1000)

    sign_input = {
        "appid": "search-pc-java",
        "functionId": "pc_search_searchWare",
        "client": "pc",
        "clientVersion": "1.0.0",
        "t": t,
        "body": sha256_hex(body_text),
    }
    token = request_h5st_token(
        "f06cc",
        timeout=TIMEOUT,
        impersonate=IMPERSONATE,
        location_href=search_page_url(),
        origin="https://search.jd.com",
        referer=search_page_url(),
    )
    signed = sign_h5st(
        sign_input,
        token,
        location_href=search_page_url(),
        origin="https://search.jd.com",
        referer=search_page_url(),
    )
    print(f"H5ST: {signed['h5st']}")

    cookie_fields[TOKEN_COOKIE_KEY] = js_token
    effective_cookie = cookie_object_to_string(cookie_fields)
    params = [
        ("appid", "search-pc-java"),
        ("t", t),
        ("client", "pc"),
        ("clientVersion", "1.0.0"),
        ("cthr", "1"),
        ("uuid", uuid),
        ("loginType", "3"),
        ("keyword", KEYWORD),
        ("functionId", "pc_search_searchWare"),
        ("body", body_text),
        ("x-api-eid-token", js_token),
        ("h5st", signed["h5st"]),
        ("t", int(time.time() * 1000)),
    ]
    return {
        "diagnostics": {
            "sdkAppId": "f06cc",
            "queryAppId": "search-pc-java",
            "functionId": "pc_search_searchWare",
            "keyword": KEYWORD,
            "page": PAGE,
            "s": s,
            "pvid": pvid,
            "uuid": uuid,
            "fp": token.fp,
            "_stk": signed["_stk"],
            "profile": {
                "canvas": token.profile.canvas,
                "webglFp": token.profile.webgl_fp,
                "screen": f"{token.profile.screen_width}x{token.profile.screen_height}",
                "outer": f"{token.profile.outer_width}x{token.profile.outer_height}",
                "pixelRatio": token.profile.pixel_ratio,
            },
            "tk03Length": len(token.tk),
            "h5stSegmentLengths": [len(part) for part in signed["h5st"].split(";")],
            "cookieKeys": list(cookie_fields.keys()),
        },
        "signInput": sign_input,
        "params": dict(params),
        "url": build_url("https://api.m.jd.com/api", params),
        "headers": build_search_headers(effective_cookie, KEYWORD),
    }


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
    signed_request = build_signed_request()
    if PRINT_SIGNED_REQUEST:
        print(json.dumps(signed_request, ensure_ascii=False, indent=2), file=sys.stderr)
    response = fetch_json_get(
        signed_request["url"],
        signed_request["headers"],
        timeout=TIMEOUT,
        impersonate=IMPERSONATE,
    )
    print_response(response)


if __name__ == "__main__":
    main()
