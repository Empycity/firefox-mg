#!/usr/bin/env python3
import hashlib
import json
import random
import re
import time
import uuid as uuid_lib
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional, Union
from urllib.parse import quote, urlencode

try:
    from curl_cffi import requests
except ModuleNotFoundError as exc:
    raise SystemExit("Missing dependency: pip install curl_cffi") from exc


VERSION = "5.3"
FILE_VERSION = "h5_file_v5.3.4"
PLATFORM = "web"
REQUEST_ALGO_URL = "https://cactus.jd.com/request_algo"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.0.0 Safari/537.36"
)
APP_VERSION = USER_AGENT.removeprefix("Mozilla/")
SEC_CH_UA = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"'
TOKEN_COOKIE_KEY = "3AB9D23F7A4B3CSS"
EID_COOKIE_KEY = "3AB9D23F7A4B3C9B"

JD_B64_ALPHABET = "rqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA-_9876543210zyxwvuts"
JD_HASH_CHARS = "nmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA-_9876543210zyxwvutsrqpo"
JD_RANDOM_CHARS = "0123456789abmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
FP_HEAD_CHARS = "25beijnpyz"
FP_BODY_CHARS = "1257abeijmnpvyz"

TZ_CN = timezone(timedelta(hours=8))
RNG = random.SystemRandom()


@dataclass
class FingerprintProfile:
    ua: str = USER_AGENT
    app_version: str = APP_VERSION
    sua: str = "Macintosh; Intel Mac OS X 10_15_7"
    platform: str = "MacIntel"
    language: str = "zh-CN"
    languages: str = "zh-CN,zh"
    mime_types_len: int = 2
    plugins_len: int = 5
    screen_width: int = 1728
    screen_height: int = 1117
    outer_width: int = 1510
    outer_height: int = 1080
    pixel_ratio: int = 2
    canvas: str = "9a76ddfa8d870bf65de748a4913b9eb6"
    canvas1: str = "9a76ddfa8d870bf65de748a4913b9eb6"
    webgl_fp: str = ""
    ccn: int = 12
    pp: dict[str, str] = field(default_factory=dict)
    pp1: str = ""
    stack_line: str = "    at HTMLScriptElement.<anonymous> (https://www.jd.com/:1:1)"
    native_string: str = "function Window() { [native code] }$function toString() { [native code] }"


def random_md5(label: str, seed: str) -> str:
    return hashlib.md5(f"{label}:{seed}".encode("utf-8")).hexdigest()


def generate_fingerprint_profile() -> FingerprintProfile:
    # Keep UA / sec-ch-ua stable with the transport headers, but rotate the
    # browser fingerprint values that the SDK normally derives from canvas,
    # WebGL, screen and native-code probes.
    display = RNG.choice(
        [
            {"sw": 1728, "sh": 1117, "ow": 1510, "oh": 1080, "pr": 2},
            {"sw": 1512, "sh": 982, "ow": 1512, "oh": 944, "pr": 2},
            {"sw": 1440, "sh": 900, "ow": 1440, "oh": 817, "pr": 2},
            {"sw": 1792, "sh": 1120, "ow": 1512, "oh": 982, "pr": 2},
            {"sw": 1920, "sh": 1080, "ow": 1728, "oh": 1005, "pr": 1},
        ]
    )
    seed = f"{time.time_ns()}:{uuid_lib.uuid4().hex}:{display}"
    canvas = random_md5("canvas-toDataURL", seed)
    webgl_fp = random_md5("webgl-fingerprint", seed)
    return FingerprintProfile(
        screen_width=display["sw"],
        screen_height=display["sh"],
        outer_width=display["ow"],
        outer_height=display["oh"],
        pixel_ratio=display["pr"],
        canvas=canvas,
        canvas1=canvas,
        webgl_fp=webgl_fp,
    )


@dataclass
class H5stToken:
    sdk_app_id: str
    fp: str
    tk: str
    rd: str
    profile: FingerprintProfile = field(default_factory=generate_fingerprint_profile)


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def md5_bytes_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def jd_md5_string(text: str) -> str:
    if text == "":
        return hashlib.md5(b"").hexdigest()
    return hashlib.md5((se_data1(text) + "RvI<7|").encode("utf-8")).hexdigest()


def random_from_charset(length: int, charset: str = JD_RANDOM_CHARS) -> str:
    return "".join(RNG.choice(charset) for _ in range(length))


def sdk_random(length: int) -> str:
    value = random_from_charset(length)
    if len(value) > 5:
        value = value[:5] + "3" + value[5 : len(value) - 1]
    return value


def tk06_prefix(rand32: str) -> str:
    operators = "+x"
    digits = "123"
    count = 2 + int(RNG.random() * 4)
    expr = []
    for index in range(count):
        expr.append(digits[int(RNG.random() * len(digits))])
        if index < count - 1:
            expr.append(operators[int(RNG.random() * len(operators))])
    text = "".join(expr)
    if len(text) < 9:
        text += rand32[: 9 - len(text)]
    return jd_b64_stringify(text.encode("utf-8"))[1:]


def generate_fp() -> str:
    return (
        random_from_charset(2, FP_HEAD_CHARS)
        + random_from_charset(13, FP_BODY_CHARS)
        + str(RNG.randrange(10))
    )


def jd_b64_stringify(data: bytes) -> str:
    out: list[str] = []
    for i in range(0, len(data), 3):
        block = data[i : i + 3]
        if len(block) != 3:
            raise ValueError("jd_b64_stringify expects 3-byte aligned input")
        bits = (block[0] << 16) | (block[1] << 8) | block[2]
        out.append(JD_B64_ALPHABET[(bits >> 18) & 0x3F])
        out.append(JD_B64_ALPHABET[(bits >> 12) & 0x3F])
        out.append(JD_B64_ALPHABET[(bits >> 6) & 0x3F])
        out.append(JD_B64_ALPHABET[bits & 0x3F])
    return "".join(out)


def jd_b64_encode_bytes(data: bytes) -> str:
    groups = [data[i : i + 3] for i in range(0, len(data), 3)]
    if not groups:
        groups = [b"\x03\x03\x03"]
    else:
        last = groups[-1]
        if len(last) == 1:
            groups[-1] = last + b"\x02\x02"
        elif len(last) == 2:
            groups[-1] = last + b"\x01"
        else:
            groups.append(b"\x03\x03\x03")
    transformed = b"".join(reversed(groups))
    encoded = jd_b64_stringify(transformed)
    return "".join(encoded[i : i + 4][::-1] for i in range(0, len(encoded), 4))


def jd_b64_encode_text(text: str) -> str:
    return jd_b64_encode_bytes(text.encode("utf-8"))


def jd_sha256_string(text: str) -> str:
    if text == "":
        return hashlib.sha256(b"").hexdigest()
    return hashlib.sha256((se_data1(text) + "RvI<7|").encode("utf-8")).hexdigest()


def se_data1(text: str) -> str:
    segment_count = 6
    factor = 28
    base = len(text) // segment_count
    chars: list[str] = []
    for index in range(segment_count):
        start = index * base
        width = base if index != segment_count - 1 else base + (len(text) % segment_count)
        total = sum(ord(ch) for ch in text[start : start + width]) * factor
        chars.append(JD_HASH_CHARS[total % len(JD_HASH_CHARS)])
    return text + "".join(chars)


def date17(timestamp_ms: Optional[int] = None) -> str:
    ms = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    dt = datetime.fromtimestamp((ms + 5000) / 1000, TZ_CN)
    return dt.strftime("%Y%m%d%H%M%S") + f"{(ms + 5000) % 1000:03d}"


def int64_le_hex(value: int) -> str:
    return int(value).to_bytes(8, "little", signed=False).hex()


def local_tk(fp: str, timestamp_ms: Optional[int] = None) -> str:
    now_ms = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    prefix = tk06_prefix(sdk_random(32))
    rand12 = sdk_random(12)
    seed_rand = rand12[5:] + rand12[:5]
    seed_hex = "e8".encode().hex() + seed_rand.encode().hex() + int64_le_hex(now_ms) + fp.encode().hex()
    payload_seed_hex = "e8".encode().hex() + rand12.encode().hex() + int64_le_hex(now_ms) + fp.encode().hex()
    seed_digest = md5_bytes_hex(bytes.fromhex(seed_hex))[:8]
    payload = prefix + jd_b64_encode_bytes(bytes.fromhex(seed_digest.encode().hex() + payload_seed_hex))
    checksum = jd_md5_string("tk06w0641lf" + payload)[:8]
    return f"tk06w{checksum}41lf{payload}"


def build_env(
    mode: int,
    fp: str,
    sdk_app_id: str,
    timestamp_ms: Optional[int] = None,
    *,
    location_href: str = "https://www.jd.com/",
    origin: str = "https://www.jd.com",
    referer: str = "",
    profile: Optional[FingerprintProfile] = None,
) -> dict[str, Any]:
    profile = profile or generate_fingerprint_profile()
    extend = {
        "wd": 0,
        "l": 0,
        "ls": 5,
        "wk": 0,
        "bu1": "0.1.4",
        "bu3": 43,
        "bu4": 0,
        "bu5": 0,
        "bu6": 32,
        "bu7": 0,
        "bu8": 0,
        "random": sdk_random(11),
        "bu12": -8,
        "bu10": 14,
        "bu11": 3,
        "bu13": "Fz",
    }
    common_tail = {
        "pf": profile.platform,
        "random": sdk_random(10),
        "v": FILE_VERSION,
        "bu4": "0",
        "canvas": profile.canvas,
        "webglFp": profile.webgl_fp,
        "ccn": profile.ccn,
        "bu14": sdk_random(10),
    }
    if mode == 1:
        env = {
            "sua": profile.sua,
            "pp": dict(profile.pp),
            "extend": extend,
            **common_tail,
            "t": int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms),
            "fp": fp,
        }
        return env

    env = {
        "wc": 0,
        "wd": 0,
        "l": profile.language,
        "ls": profile.languages,
        "ml": profile.mime_types_len,
        "pl": profile.plugins_len,
        "av": profile.app_version,
        "ua": profile.ua,
        "sua": profile.sua,
        "pp": dict(profile.pp),
        "extend": extend,
        "pp1": profile.pp1,
        "bu1": "",
        "w": profile.screen_width,
        "h": profile.screen_height,
        "ow": profile.outer_width,
        "oh": profile.outer_height,
        "url": location_href,
        "og": origin,
        "pr": profile.pixel_ratio,
        **common_tail,
        "re": referer,
        "referer": referer,
        "bu2": profile.stack_line,
        "bu3": profile.native_string,
        "canvas1": profile.canvas1,
        "ai": sdk_app_id,
        "fp": fp,
        "wk": 0,
    }
    return env


def parse_algo_rd(algo: str) -> str:
    match = re.search(r"var\s+rd\s*=\s*['\"]([^'\"]+)['\"]", algo)
    if not match:
        raise ValueError(f"Cannot extract rd from algo: {algo[:120]}")
    return match.group(1)


def request_h5st_token(
    sdk_app_id: str,
    *,
    timeout: int = 20,
    impersonate: str = "chrome120",
    location_href: str = "https://www.jd.com/",
    origin: str = "https://www.jd.com",
    referer: str = "",
) -> H5stToken:
    fp = generate_fp()
    now_ms = int(time.time() * 1000)
    profile = generate_fingerprint_profile()
    env = build_env(
        0,
        fp,
        sdk_app_id,
        now_ms,
        location_href=location_href,
        origin=origin,
        referer=referer,
        profile=profile,
    )
    payload = {
        "version": VERSION,
        "fp": fp,
        "appId": sdk_app_id,
        "timestamp": now_ms,
        "platform": PLATFORM,
        "expandParams": jd_b64_encode_text(pretty_json(env)),
        "fv": FILE_VERSION,
        "localTk": local_tk(fp, now_ms),
    }
    response = requests.post(
        REQUEST_ALGO_URL,
        data=compact_json(payload),
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "origin": origin,
            "referer": location_href,
            "user-agent": USER_AGENT,
        },
        impersonate=impersonate,
        timeout=timeout,
    )
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"request_algo returned non-json HTTP {response.status_code}: {response.text[:300]}") from exc
    result = ((body.get("data") or {}).get("result") or {})
    tk = result.get("tk") or ""
    result_fp = result.get("fp") or ""
    algo = result.get("algo") or ""
    if response.status_code != 200 or body.get("status") != 200 or not tk or result_fp != fp or not algo:
        raise RuntimeError(f"request_algo failed HTTP {response.status_code}: {compact_json(body)[:800]}")
    return H5stToken(sdk_app_id=sdk_app_id, fp=fp, tk=tk, rd=parse_algo_rd(algo), profile=profile)


def sorted_param_list(sign_input: dict[str, Any]) -> list[tuple[str, Any]]:
    return [(key, sign_input[key]) for key in sorted(sign_input)]


def gs(dynamic_key: str, param_list: list[tuple[str, Any]]) -> str:
    text = "&".join(f"{key}:{value}" for key, value in param_list)
    return jd_sha256_string(dynamic_key + text + dynamic_key)


def gsd(dynamic_key: str) -> str:
    return jd_sha256_string(dynamic_key + "appid:appid&functionid:functionId" + dynamic_key)


def sign_h5st(
    sign_input: dict[str, Any],
    token: H5stToken,
    *,
    timestamp_ms: Optional[int] = None,
    location_href: str = "https://www.jd.com/",
    origin: str = "https://www.jd.com",
    referer: str = "",
) -> dict[str, Any]:
    now_ms = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    date_segment = date17(now_ms)
    env = build_env(
        1,
        token.fp,
        token.sdk_app_id,
        now_ms,
        location_href=location_href,
        origin=origin,
        referer=referer,
        profile=token.profile,
    )
    env_encoded = jd_b64_encode_text(pretty_json(env))
    param_list = sorted_param_list(sign_input)
    stk = ",".join(key for key, _ in param_list)
    stk_encoded = jd_b64_encode_text(stk)
    dynamic_key = jd_sha256_string(token.tk + token.fp + date_segment + "54" + token.sdk_app_id + token.rd)
    seg4 = gs(dynamic_key, param_list)
    seg8 = gsd(dynamic_key)
    h5st = ";".join(
        [
            date_segment,
            token.fp,
            token.sdk_app_id,
            token.tk,
            seg4,
            VERSION,
            str(now_ms),
            env_encoded,
            seg8,
            stk_encoded,
        ]
    )
    return {"_stk": stk, "_ste": 1, "h5st": h5st}


def parse_cookie_string(cookie_string: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for part in str(cookie_string or "").split(";"):
        item = part.strip()
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        fields[key] = value
    return fields


def cookie_object_to_string(fields: dict[str, str]) -> str:
    return "; ".join(f"{key}={value}" for key, value in fields.items() if value not in ("", None))


def read_cookie_file(file_path: Union[str, Path]) -> str:
    raw = Path(file_path).read_text("utf-8").strip()
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw
    if isinstance(parsed, str):
        return parsed
    if isinstance(parsed, dict):
        return str(parsed.get("cookie") or "")
    if isinstance(parsed, list):
        return "; ".join(
            f"{item.get('name')}={item.get('value')}"
            for item in parsed
            if isinstance(item, dict) and item.get("name") and item.get("value") is not None
        )
    return raw


def search_uuid(cookie_fields: dict[str, str]) -> str:
    jda = cookie_fields.get("__jda", "")
    parts = jda.split(".")
    if len(parts) > 1 and parts[1]:
        return parts[1]
    return cookie_fields.get("__jdu", "")


def random_digits(length: int) -> str:
    return "".join(str(RNG.randrange(10)) for _ in range(length))


def random_base64url(length: int) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    return "".join(RNG.choice(alphabet) for _ in range(length))


def build_visit_uuid() -> str:
    now_ms = int(time.time() * 1000)
    sec = now_ms // 1000
    jdu = f"{now_ms}{random_digits(9)}"
    return f"95931165.{jdu}.{sec}.{sec}.{sec}.1"


def build_index_cookie(uuid_value: str, token_value: str = "", eid_value: str = "") -> str:
    sec = int(time.time())
    jdu = uuid_value.split(".")[1] if "." in uuid_value else f"{int(time.time() * 1000)}{random_digits(9)}"
    shsh_id = str(uuid_lib.uuid4())
    fields = {
        "__jdv": f"76161171|direct|-|none|-|{int(time.time() * 1000)}",
        "__jdu": jdu,
        TOKEN_COOKIE_KEY: token_value,
        EID_COOKIE_KEY: eid_value,
        "areaId": "21",
        "ipLoc-djd": "21-1911-0-0",
        "PCSYCityID": "CN_360000_360700_0",
        "shshshfpa": f"{shsh_id}-{sec}",
        "shshshfpx": f"{shsh_id}-{sec}",
        "__jda": uuid_value,
        "__jdb": f"95931165.1.{jdu}|1.{sec}",
        "__jdc": "95931165",
        "wlfstk_smdl": random_base64url(32).lower(),
        "shshshfpb": random_base64url(80),
    }
    return cookie_object_to_string(fields)


def fetch_json_get(url: str, headers: dict[str, str], *, timeout: int = 20, impersonate: str = "chrome120"):
    return requests.get(url, headers=headers, impersonate=impersonate, timeout=timeout)


def build_index_headers(cookie: str) -> dict[str, str]:
    return {
        "accept": "application/json, text/plain, */*",
        "origin": "https://www.jd.com",
        "referer": "https://www.jd.com/",
        "user-agent": USER_AGENT,
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "x-referer-page": "https://www.jd.com/",
        "x-rp-client": "h5_2.2.0",
        "cookie": cookie,
    }


def build_search_headers(cookie: str, keyword: str) -> dict[str, str]:
    encoded_keyword = quote(str(keyword), safe="")
    return {
        "accept": "application/json, text/plain, */*",
        "origin": "https://search.jd.com",
        "referer": f"https://search.jd.com/Search?keyword={encoded_keyword}&enc=utf-8",
        "user-agent": USER_AGENT,
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "x-referer-page": "https://search.jd.com/Search",
        "x-rp-client": "h5_2.1.0",
        "cookie": cookie,
    }


def search_offset(page: int, explicit_value: Optional[int] = None) -> int:
    if explicit_value is not None:
        return int(explicit_value)
    return 1 if page <= 1 else (page - 1) * 20


def build_url(base: str, params: list[tuple[str, Any]]) -> str:
    return f"{base}?{urlencode([(key, str(value)) for key, value in params])}"
