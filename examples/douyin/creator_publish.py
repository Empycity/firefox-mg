#!/usr/bin/env python3
"""Douyin creator image-upload and publish pipeline.

The module keeps HTTP transport in Python while delegating a_bogus generation
to the portable Firefox environment contract and its local Node VM.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import binascii
import copy
import datetime as dt
import hashlib
import hmac
import json
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

from PIL import Image
from curl_cffi import requests


HERE = Path(__file__).resolve().parent
DEFAULT_CONTRACT = HERE / "creator-runtime-contract.json"
DEFAULT_SECURITY_RUNTIME = HERE / "security-runtime.json"
CREATOR_ORIGIN = "https://creator.douyin.com"
IMAGE_X_ENDPOINT = "https://imagex.bytedanceapi.com/"
VOD_ENDPOINT = "https://vod.bytedanceapi.com/"
SERVICE_ID = "jm8ajry58r"
APP_ID = "2906"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0"
CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"


class PipelineError(RuntimeError):
    pass


class Log:
    COLORS = {"INFO": "\033[36m", "OK": "\033[32m", "WARN": "\033[33m", "ERROR": "\033[31m"}

    def __init__(self, color: bool = True) -> None:
        self.color = color and sys.stdout.isatty()

    def emit(self, level: str, stage: str, message: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        label = f"{level:<5}"
        if self.color:
            label = f"{self.COLORS[level]}{label}\033[0m"
        print(f"{stamp} | {label} | {stage:<12} | {message}", flush=True)

    def info(self, stage: str, message: str) -> None:
        self.emit("INFO", stage, message)

    def ok(self, stage: str, message: str) -> None:
        self.emit("OK", stage, message)


@dataclass(frozen=True)
class BrowserCookie:
    host: str
    name: str
    value: str
    path: str = "/"
    secure: bool = True


@dataclass(frozen=True)
class UploadCredential:
    access_key: str
    secret_key: str
    session_token: str
    user_id: str = ""


@dataclass(frozen=True)
class UploadedImage:
    store_uri: str
    upload_id: str
    width: int
    height: int
    size: int
    md5: str
    crc32: str


@dataclass(frozen=True)
class UploadedVideo:
    video_id: str
    store_uri: str
    upload_id: str
    width: int
    height: int
    duration: float
    size: int
    format: str
    codec: str
    crc32: str


@dataclass(frozen=True)
class PublishOptions:
    text: str = ""
    visibility_type: int = 1
    download: int = 1
    timing: int = 0


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def generate_creation_id(now_ms: int | None = None) -> str:
    alphabet = string.ascii_lowercase + string.digits
    prefix = "".join(secrets.choice(alphabet) for _ in range(8))
    return prefix + str(now_ms if now_ms is not None else time.time_ns() // 1_000_000)


def crc32_hex(data: bytes) -> str:
    return f"{binascii.crc32(data) & 0xFFFFFFFF:08x}"


def cookie_value(cookies: Iterable[BrowserCookie], name: str, host_suffix: str) -> str:
    matches = [cookie.value for cookie in cookies if cookie.name == name and cookie.host.endswith(host_suffix)]
    if not matches:
        raise PipelineError(f"Required Cookie is missing: {name} @ {host_suffix}")
    return matches[-1]


def parse_cookie_header(value: str, host: str = ".douyin.com") -> list[BrowserCookie]:
    cookies = []
    for part in value.strip().split(";"):
        name, separator, item_value = part.strip().partition("=")
        if separator and name:
            cookie_host = ".bytedance.com" if name == "msToken" else host
            cookies.append(BrowserCookie(cookie_host, name, item_value))
    if not cookies:
        raise PipelineError("Cookie header is empty")
    return cookies


def persist_cookie_file(path: Path, client: "HttpClient") -> None:
    cookies = client.browser_cookies()
    if not cookies:
        return
    # Preserve the latest value for duplicate names while keeping stable order.
    latest: dict[str, str] = {}
    order: list[str] = []
    for cookie in cookies:
        if cookie.name not in latest:
            order.append(cookie.name)
        latest[cookie.name] = cookie.value
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("; ".join(f"{name}={latest[name]}" for name in order), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def canonical_query(url: str) -> str:
    pairs = parse_qsl(urlsplit(url).query, keep_blank_values=True)
    encoded = [(quote(key, safe="-_.~"), quote(value, safe="-_.~")) for key, value in pairs]
    return "&".join(f"{key}={value}" for key, value in sorted(encoded))


def remove_query_parameter(url: str, name: str) -> str:
    parts = urlsplit(url)
    query = urlencode([(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != name])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def sign_aws_v4_request(
    method: str,
    url: str,
    credential: UploadCredential,
    payload: bytes = b"",
    now: dt.datetime | None = None,
    *,
    service: str,
    region: str = "cn-north-1",
) -> dict[str, str]:
    now = now or dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()
    headers = {"x-amz-date": amz_date, "x-amz-security-token": credential.session_token}
    if payload:
        headers["x-amz-content-sha256"] = payload_hash
    signed_names = sorted(headers)
    canonical_headers = "".join(f"{name}:{headers[name].strip()}\n" for name in signed_names)
    signed_headers = ";".join(signed_names)
    parts = urlsplit(url)
    canonical_request = "\n".join((
        method.upper(), quote(parts.path or "/", safe="/-_.~"), canonical_query(url),
        canonical_headers, signed_headers, payload_hash,
    ))
    scope = f"{date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join((
        "AWS4-HMAC-SHA256", amz_date, scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ))

    def digest(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode(), hashlib.sha256).digest()

    signing_key = digest(
        digest(digest(digest(("AWS4" + credential.secret_key).encode(), date), region), service),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    result = {name.title(): value for name, value in headers.items()}
    result["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={credential.access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return result


def sign_imagex_request(
    method: str,
    url: str,
    credential: UploadCredential,
    payload: bytes = b"",
    now: dt.datetime | None = None,
) -> dict[str, str]:
    return sign_aws_v4_request(method, url, credential, payload, now, service="imagex")


def extract_user_id(session_token: str) -> str:
    encoded = session_token[4:] if session_token.startswith("STS2") else session_token
    try:
        padding = "=" * (-len(encoded) % 4)
        outer = json.loads(base64.b64decode(encoded + padding))
        policy = json.loads(outer["PolicyString"])
        condition = policy["Statement"][0]["Condition"]
        if isinstance(condition, str):
            condition = json.loads(condition)
        user_id = str(condition["UserId"])
    except (ValueError, TypeError, KeyError, IndexError, binascii.Error) as exc:
        raise PipelineError("temporary upload credential has no readable UserId") from exc
    if not user_id:
        raise PipelineError("temporary upload credential contains an empty UserId")
    return user_id


class ABogusSigner:
    def __init__(self, contract_path: Path, cookies: Iterable[BrowserCookie]) -> None:
        self.contract_path = contract_path.resolve()
        self.cookies = list(cookies)

    def sign(self, unsigned_url: str, method: str = "GET", body: Any = None) -> str:
        contract = json.loads(self.contract_path.read_text(encoding="utf-8"))
        contract["script_path"] = str((self.contract_path.parent / contract["script_path"]).resolve())
        contract["request"] = {
            "request_id": "python-runtime",
            "method": method.upper(),
            "unsigned_url": unsigned_url,
            "headers": {},
            "body": body,
            "target_field": "a_bogus",
        }
        contract.setdefault("restore_seed", {})["cookies"] = {
            item.name: item.value for item in self.cookies if item.host.endswith(("douyin.com", "bytedance.com"))
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", prefix="douyin-contract-", delete=False) as stream:
            json.dump(contract, stream)
            temp_path = Path(stream.name)
        try:
            run = subprocess.run(
                ["node", str(HERE / "bdms-runner.js"), "--config", str(temp_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            result = json.loads(run.stdout)
            target_path = urlsplit(unsigned_url).path
            sends = [entry for entry in result.get("xhr", []) if entry.get("phase") == "send"]
            match = next((entry for entry in reversed(sends) if urlsplit(entry.get("url", "")).path == target_path), None)
            signature = dict(parse_qsl(urlsplit((match or {}).get("url", "")).query)).get("a_bogus", "")
            if not signature:
                raise PipelineError(f"VM produced no a_bogus for {target_path}")
            return signature
        finally:
            temp_path.unlink(missing_ok=True)


def with_query(url: str, params: Mapping[str, Any]) -> str:
    parts = urlsplit(url)
    query = urlencode([(key, str(value).lower() if isinstance(value, bool) else str(value)) for key, value in params.items()])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def append_signature(url: str, signature: str) -> str:
    parts = urlsplit(url)
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    pairs = [(key, value) for key, value in pairs if key != "a_bogus"] + [("a_bogus", signature)]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(pairs), parts.fragment))


class HttpClient:
    def __init__(self, cookies: Iterable[BrowserCookie], retries: int, log: Log, impersonate: str = "chrome136") -> None:
        self.retries = retries
        self.log = log
        self.impersonate = impersonate
        self.session = requests.Session(impersonate=impersonate)
        user_agent = CHROME_UA if impersonate.startswith("chrome") else UA
        self.session.headers.update({"User-Agent": user_agent, "Accept-Language": "en-US,en;q=0.5"})
        for item in cookies:
            self.session.cookies.set(item.name, item.value, domain=item.host, path=item.path, secure=item.secure)

    def browser_cookies(self) -> list[BrowserCookie]:
        return [
            BrowserCookie(cookie.domain, cookie.name, cookie.value, cookie.path or "/", cookie.secure)
            for cookie in self.session.cookies.jar
            if cookie.domain.endswith(("douyin.com", "bytedance.com"))
        ]

    @staticmethod
    def cookie_fingerprints(cookies: Iterable[BrowserCookie]) -> dict[str, str]:
        return {
            f"{item.host}|{item.path}|{item.name}": hashlib.sha256(item.value.encode()).hexdigest()
            for item in cookies
        }

    def rotate_security_markers(self) -> None:
        """复刻浏览器安全 SDK：按发布任务刷新 __security_mc_* 版本戳。

        本轮链路对比证实：浏览器不是每个 signed_creator_url() 都刷新这三个戳，
        而是每个发布任务开始刷新一次；任务内部从 upload-auth 到最终 create_v2
        保持同一组 cert_key/crypt_sdk/sign_data_key_web_protect。下一发布任务再换
        新值。bd-ticket-guard-client-data、CSRF、dtrait 在同一会话内固定复用。"""
        import random
        rand_hex = lambda n: "".join(random.choice("0123456789abcdef") for _ in range(n))
        for name in (
            "__security_mc_1_s_sdk_cert_key",
            "__security_mc_1_s_sdk_crypt_sdk",
            "__security_mc_1_s_sdk_sign_data_key_web_protect",
        ):
            marker = f"{rand_hex(8)}-4{rand_hex(3)}-{random.choice('89ab')}{rand_hex(3)}"
            self.session.cookies.set(name, marker, domain=".douyin.com", path="/", secure=True)

    def request(self, method: str, url: str, *, stage: str, retry: bool = True, **kwargs: Any):
        attempts = self.retries + 1 if retry else 1
        for attempt in range(1, attempts + 1):
            try:
                before = self.cookie_fingerprints(self.browser_cookies())
                response = self.session.request(method, url, timeout=30, **kwargs)
                observed_ms_token = next(
                    (value for key, value in response.headers.items() if key.lower() == "x-ms-token" and value),
                    None,
                )
                if observed_ms_token:
                    token_text = str(observed_ms_token)
                    # 浏览器在同一会话内 msToken 固定不变（request-1/2/3.json 三次 URL msToken 完全一致）。
                    # 服务器返回的 x-ms-token 只观测、绝不回写；一旦回写，第 3 次 create_v2 会因 token 漂移被 403。
                    self.log.info(stage, f"x-ms-token observed len={len(token_text)} sha256={hashlib.sha256(token_text.encode()).hexdigest()[:16]} (held fixed, not applied)")
                after = self.cookie_fingerprints(self.browser_cookies())
                added = sorted(set(after) - set(before))
                removed = sorted(set(before) - set(after))
                changed = sorted(key for key in set(before) & set(after) if before[key] != after[key])
                if added or removed or changed:
                    self.log.info(stage, f"session_cookie_delta added={len(added)} removed={len(removed)} changed={len(changed)}")
                if response.status_code < 500 or attempt == attempts:
                    return response
                error = f"HTTP {response.status_code}"
            except requests.RequestsError as exc:
                if attempt == attempts:
                    raise PipelineError(f"{stage} network error after {attempts} attempts: {exc}") from exc
                error = type(exc).__name__
            delay = min(0.5 * 2 ** (attempt - 1), 4.0)
            self.log.info(stage, f"retry {attempt}/{attempts - 1}, reason={error}, wait={delay:.1f}s")
            time.sleep(delay)
        raise AssertionError("unreachable")


def response_json(response: Any, stage: str) -> dict[str, Any]:
    if response.status_code != 200:
        raise PipelineError(f"{stage} returned HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise PipelineError(f"{stage} returned {len(response.content)} bytes of invalid JSON") from exc


class LocalSecurityRuntime:
    """Generate the ticket-guard request headers without a browser call."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = json.loads(path.read_text(encoding="utf-8"))
        if self.data.get("schema") != "douyin.local_security_runtime.v1":
            raise PipelineError(f"unsupported local security runtime: {path}")
        required = ("ecdh_key", "ticket", "ts_sign", "ree_public_key", "csrf", "x_tt_session_dtrait")
        missing = [key for key in required if not self.data.get(key)]
        if missing:
            raise PipelineError(
                f"security runtime missing {', '.join(missing)}; export the two current Chrome localStorage keys"
            )
        self.ecdh_key = bytes(int(value) & 0xFF for value in self.data["ecdh_key"])
        if len(self.ecdh_key) != 32:
            raise PipelineError("security runtime ecdh_key must contain exactly 32 bytes")

    def headers(self, path: str = "/web/api/media/aweme/create_v2/") -> dict[str, str]:
        # 浏览器连续 3 次成功 create_v2 的实测行为：
        # - bd-ticket-guard-client-data / csrf / dtrait 三次完全固定；
        # - 每次只轮换三个 __security_mc_* Cookie、a_bogus 和业务 body。
        # 因此运行态里若有浏览器成功请求导出的 frozen_client_data，优先逐字节复用。
        # 缺少旧字段时才回退为本地 HMAC 生成，便于 dry-run 和旧快照兼容。
        client_data = str(self.data.get("bd_ticket_guard_client_data_header") or "")
        if not client_data:
            timestamp = int(time.time())
            sign_data = f"ticket={self.data['ticket']}&path={path}&timestamp={timestamp}"
            req_sign = base64.b64encode(hmac.new(self.ecdh_key, sign_data.encode(), hashlib.sha256).digest()).decode()
            client_data = base64.b64encode(compact_json({
                "ts_sign": self.data["ts_sign"], "req_content": "ticket,path,timestamp",
                "req_sign": req_sign, "timestamp": timestamp,
            })).decode()

        headers = {
            "bd-ticket-guard-ree-public-key": str(self.data["ree_public_key"]),
            "bd-ticket-guard-web-version": "2", "bd-ticket-guard-web-sign-type": "1",
            "bd-ticket-guard-version": "2", "bd-ticket-guard-iteration-version": "1",
            "bd-ticket-guard-client-data": client_data,
        }
        if self.data.get("csrf"):
            headers["x-secsdk-csrf-token"] = str(self.data["csrf"])
        for key, field in (("x-tt-session-dtrait", "x_tt_session_dtrait"), ("Origin", "origin"),
                           ("Referer", "referer"), ("sec-ch-ua", "sec_ch_ua"),
                           ("sec-ch-ua-mobile", "sec_ch_ua_mobile"), ("sec-ch-ua-platform", "sec_ch_ua_platform")):
            if self.data.get(field): headers[key] = str(self.data[field])
        return headers


class CreatorPublisher:
    def __init__(
        self,
        client: HttpClient,
        signer: ABogusSigner,
        cookies: Iterable[BrowserCookie],
        contract: Mapping[str, Any],
        log: Log,
    ) -> None:
        self.client = client
        self.signer = signer
        self.contract = contract
        self.log = log
        base_query = dict(parse_qsl(urlsplit(contract["request"]["unsigned_url"]).query))
        self.browser_params = {key: value for key, value in base_query.items() if key not in {"read_aid", "a_bogus", "msToken"}}
        self.local_security_runtime: LocalSecurityRuntime | None = None

    def set_local_security_runtime(self, runtime: LocalSecurityRuntime | None) -> None:
        self.local_security_runtime = runtime

    def create_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Priority": "u=1, i",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
        }
        runtime = getattr(self, "local_security_runtime", None)
        if runtime:
            headers.update(runtime.headers())
        return headers
    def current_cookies(self) -> list[BrowserCookie]:
        return self.client.browser_cookies()

    def parse_create_response(self, response: Any) -> dict[str, Any]:
        if response.status_code != 200:
            self.log.info("create-v2", f"http={response.status_code}; response_headers={','.join(sorted(k.lower() for k in response.headers if k.lower().startswith(('x-', 'bd-', 'content-'))))}")
            self.log.info("create-v2", f"response_prefix={response.text[:160].replace(chr(10), ' ')}")
            if response.status_code == 403:
                raise PipelineError(
                    "create-v2 returned HTTP 403; batch stopped. Current Cookie/security runtime may be expired "
                    "or blocked by account verification; rebuild runtime after browser-side verification"
                )
            raise PipelineError(f"create-v2 returned HTTP {response.status_code}")
        if not response.content or not response.text.strip():
            raise PipelineError(
                "create-v2 returned HTTP 200 with empty response; likely mobile verification/captcha is required. "
                "Open creator.douyin.com in the browser, complete phone verification, then manually export "
                "create-v2.curl and browser-storage-current.json again."
            )
        data = response_json(response, "create-v2")
        if data.get("status_code") != 0:
            raise PipelineError(f"create-v2 business status={data.get('status_code')}")
        return data

    def signed_creator_url(self, path: str, extra: Mapping[str, Any] | None = None, method: str = "GET", body: Any = None) -> str:
        cookies = self.current_cookies()
        ms_token = cookie_value(cookies, "msToken", "bytedance.com")
        params = dict(self.browser_params)
        params.update(extra or {})
        params["msToken"] = ms_token
        unsigned = with_query(CREATOR_ORIGIN + path, params)
        self.signer.cookies = cookies
        return append_signature(unsigned, self.signer.sign(unsigned, method, body))

    def upload_auth(self) -> UploadCredential:
        url = self.signed_creator_url("/web/api/media/upload/auth/v5/")
        headers = {"Accept": "application/json, text/plain, */*"}
        data = response_json(self.client.request("GET", url, stage="upload-auth", headers=headers), "upload-auth")
        if data.get("status_code") != 0:
            raise PipelineError(f"upload-auth business status={data.get('status_code')}")
        raw = json.loads(data["auth"])
        user_id = extract_user_id(raw["SessionToken"])
        self.log.ok("upload-auth", "temporary media credential and account binding acquired")
        return UploadCredential(raw["AccessKeyID"], raw["SecretAccessKey"], raw["SessionToken"], user_id)

    def apply_upload(self, credential: UploadCredential) -> tuple[str, str, str, str, str]:
        random_value = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(11))
        url = with_query(IMAGE_X_ENDPOINT, {
            "Action": "ApplyImageUpload", "Version": "2018-08-01", "ServiceId": SERVICE_ID,
            "app_id": APP_ID, "user_id": "", "s": random_value,
        })
        headers = sign_imagex_request("GET", url, credential)
        data = response_json(self.client.request("GET", url, stage="apply-upload", headers=headers), "apply-upload")
        address = data["Result"]["UploadAddress"]
        store = address["StoreInfos"][0]
        self.log.ok("apply-upload", "StoreUri and upload slot acquired")
        return store["StoreUri"], store["UploadID"], store["Auth"], address["UploadHosts"][0], address["SessionKey"]

    def upload_binary(self, image_path: Path, store_uri: str, auth: str, host: str) -> tuple[bytes, str]:
        payload = image_path.read_bytes()
        checksum = crc32_hex(payload)
        headers = {
            "Authorization": auth, "Content-CRC32": checksum, "X-Storage-U": "",
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="upload.jpg"',
        }
        url = f"https://{host}/upload/v1/{store_uri}"
        response = self.client.request("POST", url, stage="binary-upload", headers=headers, data=payload)
        data = response_json(response, "binary-upload")
        if data.get("code") != 2000:
            raise PipelineError(f"binary-upload business code={data.get('code')}")
        self.log.ok("binary-upload", f"uploaded {len(payload)} bytes, crc32={checksum}")
        return payload, checksum

    def commit_upload(self, credential: UploadCredential, session_key: str) -> dict[str, Any]:
        url = with_query(IMAGE_X_ENDPOINT, {
            "Action": "CommitImageUpload", "Version": "2018-08-01", "ServiceId": SERVICE_ID,
            "app_id": APP_ID, "user_id": "",
        })
        payload = compact_json({"SessionKey": session_key})
        headers = {"Content-Type": "application/json", **sign_imagex_request("POST", url, credential, payload)}
        data = response_json(self.client.request("POST", url, stage="commit-upload", headers=headers, data=payload), "commit-upload")
        result = data["Result"]
        if not result.get("Results") or result["Results"][0].get("UriStatus") != 2000:
            raise PipelineError("commit-upload did not confirm UriStatus=2000")
        self.log.ok("commit-upload", "image metadata committed")
        return result

    def upload(self, image_path: Path) -> UploadedImage:
        credential = self.upload_auth()
        store_uri, upload_id, auth, host, session_key = self.apply_upload(credential)
        payload, checksum = self.upload_binary(image_path, store_uri, auth, host)
        result = self.commit_upload(credential, session_key)
        plugin = result.get("PluginResult", [{}])[0]
        with Image.open(image_path) as image:
            fallback_width, fallback_height = image.size
        return UploadedImage(
            store_uri=store_uri,
            upload_id=upload_id,
            width=int(plugin.get("ImageWidth") or fallback_width),
            height=int(plugin.get("ImageHeight") or fallback_height),
            size=len(payload),
            md5=hashlib.md5(payload).hexdigest(),
            crc32=checksum,
        )

    def validate_material(self, image: UploadedImage) -> None:
        url = self.signed_creator_url("/aweme/v1/creator/get/url/", {"uri": image.store_uri})
        data = response_json(self.client.request("GET", url, stage="validate-uri"), "validate-uri")
        if data.get("status_code") != 0:
            raise PipelineError(f"validate-uri business status={data.get('status_code')}")
        self.log.ok("validate-uri", "creator material URL resolved")

    def apply_video_upload(self, credential: UploadCredential, size: int) -> tuple[str, str, str, str, str, str]:
        random_value = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(11))
        url = with_query(VOD_ENDPOINT, {
            "Action": "ApplyUploadInner", "Version": "2020-11-19", "SpaceName": "aweme",
            "FileType": "video", "IsInner": 1, "FileSize": size, "app_id": APP_ID,
            "user_id": credential.user_id, "s": random_value,
        })
        headers = sign_aws_v4_request("GET", url, credential, service="vod")
        data = response_json(self.client.request("GET", url, stage="video-apply", headers=headers), "video-apply")
        result = data["Result"]["InnerUploadAddress"]
        node = result["UploadNodes"][0]
        store = node["StoreInfos"][0]
        storage_user = str(store.get("StorageHeader", {}).get("USER_ID") or credential.user_id)
        if storage_user != credential.user_id:
            raise PipelineError("video-apply account binding does not match upload credential")
        self.log.ok("video-apply", "Vid, StoreUri, upload slot, and session acquired")
        return node["Vid"], store["StoreUri"], store["UploadID"], store["Auth"], node["UploadHost"], node["SessionKey"]

    def upload_video_binary(
        self, video_path: Path, store_uri: str, auth: str, host: str, user_id: str,
    ) -> tuple[bytes, str]:
        payload = video_path.read_bytes()
        checksum = crc32_hex(payload)
        base_url = f"https://{host}/upload/v1/{store_uri}"
        common_headers = {"Authorization": auth, "X-Storage-U": user_id, "x-storage-mode": "gateway"}
        transfer_headers = {
            **common_headers,
            "Content-CRC32": checksum,
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="upload.mp4"',
        }
        if len(payload) <= 5 * 1024 * 1024:
            direct = response_json(
                self.client.request(
                    "POST", base_url, stage="video-direct", headers=transfer_headers,
                    data=payload, retry=False,
                ),
                "video-direct",
            )
            if direct.get("code") != 2000:
                raise PipelineError(
                    f"video-direct code={direct.get('code')}, message={direct.get('message')}"
                )
            self.log.ok("video-upload", f"direct uploaded {len(payload)} bytes, crc32={checksum}")
            return payload, checksum
        init_url = with_query(base_url, {"uploadmode": "part", "phase": "init"})
        init = response_json(
            self.client.request("POST", init_url, stage="video-init", headers=common_headers, data=b""),
            "video-init",
        )
        if init.get("code") != 2000:
            raise PipelineError(f"video-init business code={init.get('code')}")
        multipart_id = init["data"]["uploadid"]
        transfer_url = with_query(base_url, {
            "uploadid": multipart_id, "part_number": 1, "phase": "transfer", "part_offset": 0,
        })
        transfer = response_json(
            self.client.request(
                "POST", transfer_url, stage="video-transfer", headers=transfer_headers,
                data=payload,
            ),
            "video-transfer",
        )
        server_crc = str(transfer.get("data", {}).get("crc32") or "").lower()
        if transfer.get("code") != 2000 or server_crc != checksum:
            raise PipelineError(
                f"video-transfer code={transfer.get('code')}, local_crc32={checksum}, "
                f"server_crc32={server_crc or 'missing'}, message={transfer.get('message')}"
            )
        finish_url = with_query(base_url, {"uploadmode": "part", "phase": "finish", "uploadid": multipart_id})
        finish = response_json(
            self.client.request(
                "POST", finish_url, stage="video-finish", headers=common_headers,
                data=f"1:{checksum}".encode(),
            ),
            "video-finish",
        )
        if finish.get("code") != 2000:
            raise PipelineError(f"video-finish business code={finish.get('code')}")
        self.log.ok("video-upload", f"uploaded {len(payload)} bytes, crc32={checksum}")
        return payload, checksum

    def commit_video_upload(
        self, credential: UploadCredential, session_key: str,
    ) -> dict[str, Any]:
        url = with_query(VOD_ENDPOINT, {
            "Action": "CommitUploadInner", "Version": "2020-11-19", "SpaceName": "aweme",
            "app_id": APP_ID, "user_id": credential.user_id,
        })
        payload = compact_json({
            "SessionKey": session_key,
            "Functions": [{"name": "GetMeta"}, {"name": "Snapshot", "input": {"SnapshotTime": 0}}],
        })
        headers = {
            "Content-Type": "application/json",
            **sign_aws_v4_request("POST", url, credential, payload, service="vod"),
        }
        data = response_json(
            self.client.request("POST", url, stage="video-commit", headers=headers, data=payload),
            "video-commit",
        )
        results = data.get("Result", {}).get("Results", [])
        if not results or not results[0].get("Vid") or not results[0].get("VideoMeta"):
            raise PipelineError("video-commit returned no Vid metadata")
        self.log.ok("video-commit", "VOD metadata committed")
        return results[0]

    def wait_video_ready(self, video_id: str, attempts: int = 30, interval: float = 1.0) -> dict[str, Any]:
        enable_url = self.signed_creator_url("/web/api/media/video/enable/", {"video_id": video_id})
        self.client.request("GET", enable_url, stage="video-enable")
        for attempt in range(1, attempts + 1):
            url = self.signed_creator_url("/web/api/media/video/transend/", {"video_id": video_id})
            data = response_json(self.client.request("GET", url, stage="video-status"), "video-status")
            if data.get("status_code") == 0 and data.get("play_url"):
                self.log.ok("video-status", f"processing complete after {attempt} check(s)")
                return data
            if attempt < attempts:
                time.sleep(interval)
        raise PipelineError(f"video processing did not finish after {attempts} checks")

    def upload_video(self, video_path: Path) -> UploadedVideo:
        credential = self.upload_auth()
        size = video_path.stat().st_size
        video_id, store_uri, upload_id, auth, host, session_key = self.apply_video_upload(credential, size)
        payload, checksum = self.upload_video_binary(video_path, store_uri, auth, host, credential.user_id)
        committed = self.commit_video_upload(credential, session_key)
        if committed["Vid"] != video_id:
            raise PipelineError("video-commit returned a different Vid")
        status = self.wait_video_ready(video_id)
        meta = committed["VideoMeta"]
        return UploadedVideo(
            video_id=video_id, store_uri=meta.get("Uri") or store_uri, upload_id=upload_id,
            width=int(status.get("width") or meta.get("Width") or 0),
            height=int(status.get("height") or meta.get("Height") or 0),
            duration=float(status.get("duration") or meta.get("Duration") or 0),
            size=len(payload), format=str(status.get("format") or meta.get("Format") or ""),
            codec=str(status.get("codec_type") or meta.get("Codec") or ""), crc32=checksum,
        )

    def build_create_body(
        self, images: list[UploadedImage], creation_id: str, options: PublishOptions,
    ) -> dict[str, Any]:
        if not images:
            raise PipelineError("create_v2 requires at least one uploaded image")
        body = copy.deepcopy(self.contract["request"].get("body"))
        if not isinstance(body, dict) or "item" not in body or "common" not in body.get("item", {}):
            raise PipelineError("runtime contract create_v2 body is missing item.common; re-export create-v2.curl and run 更新运行态.py")
        common = body["item"]["common"]
        common["text"] = options.text
        common["visibility_type"] = options.visibility_type
        common["download"] = options.download
        common["timing"] = options.timing
        common["images"] = [
            {"uri": image.store_uri, "width": image.width, "height": image.height}
            for image in images
        ]
        common["creation_id"] = creation_id
        body["item"]["cover"]["poster"] = images[0].store_uri
        return body

    def publish(
        self, images: list[UploadedImage], creation_id: str, options: PublishOptions,
    ) -> dict[str, Any]:
        body = self.build_create_body(images, creation_id, options)
        url = self.signed_creator_url(
            "/web/api/media/aweme/create_v2/", {"read_aid": 2906}, method="POST", body=body,
        )
        headers = self.create_headers()
        response = self.client.request("POST", url, stage="create-v2", headers=headers, data=compact_json(body), retry=False)
        data = self.parse_create_response(response)
        self.log.ok("create-v2", f"published, item_id_present={bool(data.get('item_id'))}")
        return data

    def build_video_create_body(
        self, video: UploadedVideo, poster_uri: str, creation_id: str, options: PublishOptions,
    ) -> dict[str, Any]:
        body = copy.deepcopy(self.contract["request"].get("body"))
        if not isinstance(body, dict) or "item" not in body or "common" not in body.get("item", {}):
            raise PipelineError("runtime contract create_v2 body is missing item.common; re-export create-v2.curl and run 更新运行态.py")
        common = body["item"]["common"]
        common.update({
            "text": options.text, "visibility_type": options.visibility_type,
            "download": options.download, "timing": options.timing,
            "media_type": 4, "video_id": video.video_id, "creation_id": creation_id,
        })
        common.pop("images", None)
        cover = body["item"].setdefault("cover", {})
        cover["poster"] = poster_uri
        cover.setdefault("poster_delay", 0)
        return body

    def publish_video(
        self, video: UploadedVideo, poster_uri: str, creation_id: str, options: PublishOptions,
    ) -> dict[str, Any]:
        body = self.build_video_create_body(video, poster_uri, creation_id, options)
        url = self.signed_creator_url(
            "/web/api/media/aweme/create_v2/", {"read_aid": 2906}, method="POST", body=body,
        )
        headers = self.create_headers()

        # 诊断日志：记录关键字段的 hash 用于三次请求对比
        import hashlib
        dtrait = headers.get("x-tt-session-dtrait", "")
        csrf = headers.get("x-secsdk-csrf-token", "")
        client_data = headers.get("bd-ticket-guard-client-data", "")
        self.log.info("create-v2", f"dtrait_len={len(dtrait)} dtrait_sha256={hashlib.sha256(dtrait.encode()).hexdigest()[:16]}")
        self.log.info("create-v2", f"csrf_sha256={hashlib.sha256(csrf.encode()).hexdigest()[:16]}")
        self.log.info("create-v2", f"client_data_len={len(client_data)} client_data_sha256={hashlib.sha256(client_data.encode()).hexdigest()[:16]}")
        markers = {c.name.split("s_sdk_")[-1]: c.value for c in self.current_cookies() if c.name.startswith("__security_mc_1_s_sdk_")}
        self.log.info("create-v2", "security_mc " + " ".join(f"{k}={v}" for k, v in sorted(markers.items())))

        response = self.client.request("POST", url, stage="create-v2", headers=headers, data=compact_json(body), retry=False)
        data = self.parse_create_response(response)
        self.log.ok("create-v2", f"video published, item_id_present={bool(data.get('item_id'))}")
        return data


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Upload and publish Douyin creator media")
    parser.add_argument("images", type=Path, nargs="*", help="one or more local image paths")
    parser.add_argument("--video", type=Path, help="one local video path")
    parser.add_argument("--video-batch", type=Path, nargs="+", help="publish videos sequentially in one shared HTTP Session")
    parser.add_argument("--video-id", help="publish an already processed VOD video without uploading again")
    parser.add_argument("--poster-uri", help="committed ImageX StoreUri used as the video cover")
    parser.add_argument("--text", default="", help="post caption")
    parser.add_argument(
        "--visibility-type", type=int, choices=(0, 1), default=1,
        help="create_v2 visibility: 0=public, 1=private (default: private)",
    )
    parser.add_argument("--download", type=int, choices=(0, 1), default=1, help="allow download flag")
    parser.add_argument("--timing", type=int, default=0, help="publish timing value (observed immediate=0)")
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument(
        "--cookie-clipboard", action="store_true",
        help="read creator Cookie header from the macOS clipboard",
    )
    parser.add_argument("--cookie-file", type=Path, help="read creator Cookie header from a local file")
    parser.add_argument(
        "--ms-token-clipboard", action="store_true",
        help="read msToken from the macOS clipboard",
    )
    parser.add_argument("--retries", type=int, default=2, help="network retries before create_v2")
    parser.add_argument("--impersonate", choices=("firefox135", "chrome136"), default="chrome136", help="curl_cffi TLS/browser profile")
    parser.add_argument("--local-security-runtime", type=Path, help="generate Ticket Guard headers locally from a code-side runtime seed")
    parser.add_argument("--upload-only", action="store_true", help="stop after StoreUri validation")
    parser.add_argument("--dry-run", action="store_true", help="validate local runtime without network requests")
    parser.add_argument("--no-color", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    log = Log(not args.no_color)
    if not args.contract.is_file():
        raise PipelineError(f"runtime contract not found: {args.contract}")
    if shutil.which("node") is None:
        raise PipelineError("node executable is missing")
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    if args.dry_run:
        log.ok("dry-run", f"contract={args.contract.name}, schema={contract.get('schema')}")
        log.ok("dry-run", f"node={shutil.which('node')}, VM asset present")
        for image_path in args.images:
            with Image.open(image_path) as image:
                log.ok("dry-run", f"image={image_path.name}, size={image.width}x{image.height}")
        if args.video:
            log.ok("dry-run", f"video={args.video.name}, bytes={args.video.stat().st_size}")
        return 0
    media_inputs = int(bool(args.images)) + int(bool(args.video)) + int(bool(args.video_batch)) + int(bool(args.video_id))
    if media_inputs != 1:
        raise PipelineError("provide image paths, one --video path, or one --video-id")
    if any(not image.is_file() for image in args.images) or (args.video and not args.video.is_file()) or any(not video.is_file() for video in (args.video_batch or [])):
        raise PipelineError("one or more media paths do not exist")
    if args.cookie_file:
        cookies = parse_cookie_header(args.cookie_file.read_text(encoding="utf-8"))
        if args.ms_token_clipboard:
            ms_token = subprocess.run(["pbpaste"], check=True, capture_output=True, text=True).stdout.strip()
            if not ms_token or ";" in ms_token or "\n" in ms_token or "\r" in ms_token:
                raise PipelineError("clipboard does not contain one raw msToken")
            cookies.append(BrowserCookie(".bytedance.com", "msToken", ms_token))
        elif not any(item.name == "msToken" for item in cookies):
            raise PipelineError("cookie file must include msToken (or use --ms-token-clipboard)")
        log.ok("session", f"loaded {len(cookies)} persisted session Cookies; values hidden")
    elif args.cookie_clipboard:
        cookie_text = subprocess.run(["pbpaste"], check=True, capture_output=True, text=True).stdout
        cookies = parse_cookie_header(cookie_text)
        if not any(item.name == "msToken" for item in cookies):
            raise PipelineError("clipboard Cookie must include msToken")
        log.ok("session", f"loaded {len(cookies)} clipboard Cookies; values hidden")
    else:
        raise PipelineError("provide creator Cookies with --cookie-file or --cookie-clipboard")
    client = HttpClient(cookies, max(0, args.retries), log, args.impersonate)
    if args.cookie_file:
        atexit.register(persist_cookie_file, args.cookie_file, client)
    signer = ABogusSigner(args.contract, cookies)
    publisher = CreatorPublisher(client, signer, cookies, contract, log)
    security_runtime = args.local_security_runtime
    if security_runtime is None and DEFAULT_SECURITY_RUNTIME.is_file():
        security_runtime = DEFAULT_SECURITY_RUNTIME
    if security_runtime:
        publisher.set_local_security_runtime(LocalSecurityRuntime(security_runtime))
    elif not args.upload_only:
        raise PipelineError(f"local security runtime not found: {DEFAULT_SECURITY_RUNTIME}")
    creation_id = generate_creation_id()
    log.info("pipeline", f"creation_id={creation_id}; reused for this task")
    if args.video_batch:
        if args.upload_only:
            raise PipelineError("--video-batch requires publication; use --video for upload-only")
        options = PublishOptions(args.text, args.visibility_type, args.download, args.timing)
        results = []
        for index, video_path in enumerate(args.video_batch, 1):
            creation_id = generate_creation_id()
            client.rotate_security_markers()  # 浏览器每个发布任务开始换一次，任务内 upload-auth 到 create_v2 保持同一组三戳。
            log.info("batch", f"task={index}/{len(args.video_batch)} creation_id={creation_id}")
            video = publisher.upload_video(video_path)
            with tempfile.TemporaryDirectory(prefix="douyin-video-cover-") as directory:
                cover_path = Path(directory) / "cover.jpg"
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "0", "-i", str(video_path), "-frames:v", "1", str(cover_path)], check=True, timeout=60)
                cover = publisher.upload(cover_path)
                publisher.validate_material(cover)
            checkpoint = {"task": index, "file": video_path.name, "video_id": video.video_id, "poster_uri": cover.store_uri, "creation_id": creation_id}
            log.ok("checkpoint", json.dumps(checkpoint, ensure_ascii=False))
            result = publisher.publish_video(video, cover.store_uri, creation_id, options)
            results.append({**checkpoint, "status_code": result.get("status_code"), "item_id": result.get("item_id")})
        print(json.dumps({"batch": results}, ensure_ascii=False))
        return 0
    if args.video or args.video_id:
        client.rotate_security_markers()  # 单视频任务同样只在任务开始轮换一次。
        if args.video_id:
            video = UploadedVideo(args.video_id, "", "", 0, 0, 0, 0, "", "", "")
        else:
            video = publisher.upload_video(args.video)
        output = {
            "video_id": video.video_id, "store_uri": video.store_uri, "width": video.width,
            "height": video.height, "duration": video.duration, "size": video.size,
            "format": video.format, "codec": video.codec,
        }
        if not args.upload_only:
            poster_uri = args.poster_uri
            if not poster_uri and args.video:
                if shutil.which("ffmpeg") is None:
                    raise PipelineError("automatic video cover requires ffmpeg")
                with tempfile.TemporaryDirectory(prefix="douyin-video-cover-") as directory:
                    cover_path = Path(directory) / "cover.jpg"
                    subprocess.run(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "0",
                         "-i", str(args.video), "-frames:v", "1", str(cover_path)],
                        check=True,
                        timeout=60,
                    )
                    log.info("pipeline", "uploading generated video cover")
                    cover = publisher.upload(cover_path)
                    publisher.validate_material(cover)
                    poster_uri = cover.store_uri
            if not poster_uri:
                raise PipelineError("existing --video-id publish requires --poster-uri")
            options = PublishOptions(args.text, args.visibility_type, args.download, args.timing)
            result = publisher.publish_video(video, poster_uri, creation_id, options)
            output.update({"status_code": result.get("status_code"), "item_id": result.get("item_id")})
        print(json.dumps(output, ensure_ascii=False))
        return 0
    client.rotate_security_markers()  # 图片发布任务开始轮换一次，任务内保持一致。
    images = []
    for index, image_path in enumerate(args.images, 1):
        log.info("pipeline", f"uploading image {index}/{len(args.images)}")
        image = publisher.upload(image_path)
        publisher.validate_material(image)
        images.append(image)
        log.ok("pipeline", f"StoreUri={image.store_uri}, dimensions={image.width}x{image.height}")
    if not args.upload_only:
        options = PublishOptions(args.text, args.visibility_type, args.download, args.timing)
        result = publisher.publish(images, creation_id, options)
        print(json.dumps({"status_code": result.get("status_code"), "item_id": result.get("item_id")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PipelineError, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, KeyError, UnicodeError) as error:
        print(f"ERROR | {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
