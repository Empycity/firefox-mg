#!/usr/bin/env python3
import json
import sys
import time
from pathlib import Path
from loguru import logger as log

from h5st_pure import (
    TOKEN_COOKIE_KEY,
    build_index_cookie,
    build_index_headers,
    build_url,
    compact_json,
    fetch_json_get,
    read_cookie_file,
    request_h5st_token,
    sha256_hex,
    sign_h5st,
    build_visit_uuid,
    parse_cookie_string,
)


# Edit these values directly in PyCharm.
PAGE = 4
TIMEOUT = 20

# Empty = anonymous protocol cookies. You can set this to config/search_cookie.json
# or another local cookie file if you want to replay with a login state.
COOKIE_FILE = ""

IMPERSONATE = "chrome120"
PRINT_SIGNED_REQUEST = False
PRINT_RESPONSE_HEADERS = False


THIS_DIR = Path(__file__).resolve().parent


def build_signed_request() -> dict:
    body = {
        "page": PAGE,
        "pagesize": 25,
        "area": "",
        "source": "pc-home",
        "kuangjia": 1,
        "notJsonp": True,
    }
    body_text = compact_json(body)
    cookie = read_cookie_file(COOKIE_FILE) if COOKIE_FILE else ""
    cookie_fields = parse_cookie_string(cookie)
    uuid = cookie_fields.get("__jda") or build_visit_uuid()

    token = request_h5st_token(
        "b5216",
        timeout=TIMEOUT,
        impersonate=IMPERSONATE,
        location_href="https://www.jd.com/",
        origin="https://www.jd.com",
        referer="",
    )
    t = int(time.time() * 1000)
    sign_input = {
        "appid": "www-jd-com",
        "body": sha256_hex(body_text),
        "client": "pc",
        "clientVersion": "1.0.0",
        "functionId": "pc_home_feed",
        "t": t,
        "uuid": uuid,
    }
    signed = sign_h5st(
        sign_input,
        token,
        location_href="https://www.jd.com/",
        origin="https://www.jd.com",
        referer="",
    )
    h5st = signed["h5st"]
    log.info(f"Signing request: {h5st}")
    js_token = cookie_fields.get(TOKEN_COOKIE_KEY, "")
    params = [
        ("appid", "www-jd-com"),
        ("client", "pc"),
        ("clientVersion", "1.0.0"),
        ("t", t),
        ("uuid", uuid),
        ("body", body_text),
        ("functionId", "pc_home_feed"),
        ("h5st", signed["h5st"]),
        ("loginType", "3"),
    ]
    if js_token:
        params.append(("x-api-eid-token", js_token))

    effective_cookie = cookie or build_index_cookie(uuid, token_value=js_token)
    return {
        "diagnostics": {
            "sdkAppId": "b5216",
            "queryAppId": "www-jd-com",
            "functionId": "pc_home_feed",
            "page": PAGE,
            "uuid": uuid,
            "fp": token.fp,
            "profile": {
                "canvas": token.profile.canvas,
                "webglFp": token.profile.webgl_fp,
                "screen": f"{token.profile.screen_width}x{token.profile.screen_height}",
                "outer": f"{token.profile.outer_width}x{token.profile.outer_height}",
                "pixelRatio": token.profile.pixel_ratio,
            },
            "tk03Length": len(token.tk),
            "h5stSegmentLengths": [len(part) for part in signed["h5st"].split(";")],
            "cookieKeys": list(parse_cookie_string(effective_cookie).keys()),
        },
        "signInput": sign_input,
        "params": dict(params),
        "url": build_url("https://api.m.jd.com/", params),
        "headers": build_index_headers(effective_cookie),
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
        debug = dict(signed_request)
        debug["diagnostics"] = {
            **debug["diagnostics"],
            "h5stSegmentLengths": [len(part) for part in debug["params"]["h5st"].split(";")],
        }
        print(json.dumps(debug, ensure_ascii=False, indent=2), file=sys.stderr)
    response = fetch_json_get(
        signed_request["url"],
        signed_request["headers"],
        timeout=TIMEOUT,
        impersonate=IMPERSONATE,
    )
    print_response(response)


if __name__ == "__main__":
    main()
