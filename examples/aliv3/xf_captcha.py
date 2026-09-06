# -*- coding: utf-8 -*-
"""
captcha_51xf.py —— 杭银 51xf（resource.51xf.cn）阿里云 v3 PUZZLE 滑块 · 单文件整合版
（SceneId=1bn1l0rb / prefix=1oa2ns，原 51xf/ 多模块工程的合并，2026-09-05）

流程：
  1. Log1/Log2 设备会话（cloudauth-device）      2. InitCaptchaV3 -> CertifyId/PUZZLE 图
  3. YOLO 识别缺口 xPos                          4. 变速轨迹（xPos = slidePos*(slidePos+20)/280）
  5. fp2(142 段) -> AES -> deviceToken           6. sg 密码打包 data
  7. VerifyCaptchaV3 -> T001/F015

用法：
  python captcha_51xf.py [轮数=1] [轮间隔秒=6]

每日 feilin 轮换：只替换【每日层 A：v78d98s】与【每日层 B：dfghfgdh6】两段
（照 纯算/阿里v2_技术文档.md 0.4 清单，算法点下标 = env 同下标段）。

依赖：requests_go（首选，Go 网络栈 TLS_CHROME_LATEST）、captcha_recognizer（YOLO 缺口识别）、
      pycryptodome、opencv-python、numpy；均缺失时有回退，但成功率下降。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import random
import sys
import threading
import time
import urllib.parse
import uuid
import zlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

import requests


def step_log(*args):
    """过程日志：生产静默，XF_DEBUG=1 时输出（等价 print）。"""
    if os.environ.get("XF_DEBUG"):
        print(*args)
import urllib3
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

# ---- HTTP 后端自动选择：requests_go（最新 Chrome TLS）> curl_cffi > 裸 requests ----
_BACKEND = "requests"
try:
    import requests_go as _rg
    from requests_go import tls_config as _tls_config_mod
    _BACKEND = "requests_go"
except ImportError:
    try:
        from curl_cffi import requests as _curl_requests  # type: ignore
        _BACKEND = "curl_cffi"
    except ImportError:
        _curl_requests = None

urllib3.disable_warnings()


# ============================================================
# 站点常量（51xf 实例，真实抓包确认）
# ============================================================
PREFIX = "1oa2ns"
SCENE_ID = "1bn1l0rb"
SITE_ORIGIN = "https://resource.51xf.cn"
SITE_REFERER = "https://resource.51xf.cn/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) "
      "Gecko/20100101 Firefox/142.0")   # 与 trace 采集环境自洽

CAPTCHA_ENDPOINT = "https://%s.captcha-open.aliyuncs.com/" % PREFIX
CAPTCHA_VERIFY_ENDPOINT = "https://%s-verify.captcha-open.aliyuncs.com/" % PREFIX
IMAGE_CDN = "https://static-captcha.aliyuncs.com/"

# captcha-open 实例公共密钥对（AliyunCaptcha.js 内置，同 lanqiao/beeize/政采）
AK_PARAM_NAME = "AaduaneId"
CAPTCHA_AK = "111jdk439dJJIjd023823201"
CAPTCHA_SK = "222aiJodos2938JDdosko2djd82sf0"
API_VERSION = "2023-03-05"

# 设备会话（cloudauth-device）
DEVICE_HOST = "cloudauth-device-dualstack.cn-shanghai.aliyuncs.com"
DEVICE_AK = "DuaneAprqkYsF3nt1yjK29Bf"
DEVICE_SK = "DuanemHmyeE6LXCC46sJEDUw5DTlSZ"
DEVICE_API_VERSION = "2020-10-15"

# 密钥体系（V3 族同源：同 APP_KEY、同 AES 密钥表）
APP_KEY = "ab034ec0643f91399eb33e062dc7fae1"
APP_VERSION = "W20220202"
DEVICE_TYPE_WEB = "W"
PLATFORM_INNER = "W.10001.c"       # DeviceData inner 明文第 1 段
DEVICE_PLATFORM = "W.10054"        # Log2 设备指纹 platform（v3 族）
APP_NAME = "saf-captcha"
REGION = "cn"
AES_IV = b"0123456789ABCDEF"
ACCESS_SEC = b"FqJB6iRNVYdEGpwb"
WEB_AES_SECRET_KEY_ENC = {
    "REQ": "8KmHIQsc5+LZJA7uYex3WaHdkjgCtS6epbG/bc9xss0=",
    "RES": "9NhnQQ+LRrKCkAuxwZaUWGBtSzaFtFlNb/ksJCrCgrM=",
    "FLAG": "k+1RW0cz3iDi2RAbC/c3QKzTPiVwNmNO1910DXe6Gas=",
}
K_REQ = "45f8ac1e1de14397"
K_RES = "87f879f135f27da7"
K_FLAG = "c175a358550d02e2"
K_UPLOAD = "a549a55c60a39aa0"
TOKEN_MD5_SALT = "daye,raolewoba!"

# —— trace round2 真值板（字段拼接唯一来源，禁止混用其他来源模板）——
_LOG2_BOARD = "W.10054#1.5#11#Apple#Gecko#MacIntel#Firefox#142.0#3#[application/pdf,text/pdf]#false#2#Apple M1, or similar#Mozilla###0#0#0#c7714802b27c8c2aa0cf82e0385668af#24#AQ9lBGlnCW0=##30*0*0*0#30#30#srgb#false#false#false#0#0#94433880daa9f55b02a5836769d31ee2##12##Mac OS#10.15#1#false#en-US+en-US+en#Asia/Shanghai#183.192.134.245#20-1601|23-2936|30-0|40-57|41-3251|70-3278#true#true#true#1117*1728#true#0#false#false#b0221e949bc26cd714809eb4511abddcb9bc358576039de263#https://resource.51xf.cn/H5/captcha.html##891*1280#975*1280#1084*1728#102#891*1280#true##false#142.0#Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0#unspecified#false#saf-captcha#0#[PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF]#-480#OeXRKvGg0JJs5oBfFVHwhDYYz2rqHrshzj5Cfs3L#1788661650055#ZYmsiNGjs199XizcgWgYJmWtyUP2tY9CTdDGbjZb3h#1788661654002#desktop#false##9d4568c009d203ab10e33ea9953a0264#99914b932bd37a50b983c5e7c90ae93b#5.0 (Macintosh)#Mozilla####1#1#1788661648416#MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMxIzEjMCMwMTExMTEwMDExMTExMTExMTExMTExMTExMQ==#0#0#true#0#1#1#0#0#0#0#0#0#0#0#0#0#0#0#0#1#-1#[]#0|0|0|0|0|0|1|1|0|0|0|0|0|0|0|1|1|0|1|1|0|1|1|0|0|0|0|1|1|0|1|1|0#0#[0,a]###true#https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin008.489f1fe42772a97d510f162902b33c35c004ce7746ca3f4696c42f8d1f677670.js#[[https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin008.489f1fe42772a97d510f162902b33c35c004ce7746ca3f4696c42f8d1f677670.js,151,0]]#false#false#true#false#false#false#[true,true,true,true,true]#false##[0,0]#1####https#false#c:#0#0#0#".split("#")
_LOG2_BOARD += [""] * (142 - len(_LOG2_BOARD))
_FP2_BOARD = "W.10054#####MacIntel#Firefox#142.0#############24#AQ9lBGlnCW0=###########94433880daa9f55b02a5836769d31ee2##12##Mac OS#10.15#####183.192.134.245#20-1601|23-2936|30-0|40-57|41-3251|70-3278|71-3668|80-3670#true###1117*1728##0##################saf-captcha#0###OeXRKvGg0JJs5oBfFVHwhDYYz2rqHrshzj5Cfs3L#1788661650055#ZYmsiNGjs199XizcgWgYJmWtyUP2tY9CTdDGbjZb3h#1788661654002#desktop#false##9d4568c009d203ab10e33ea9953a0264#########1788661648416#MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMxIzEjMCMwMTExMTEwMDExMTExMTExMTExMTExMTExMQ==#0#0#true##################-1##############################".split("#")
_FP2_BOARD += [""] * (142 - len(_FP2_BOARD))
FEILIN_SIZE_FALLBACK = 579254      # 探测失败时的兜底值
_FEILIN_SIZE_CACHE: Dict[str, int] = {}


def feilin_size(feilin_path: str) -> int:
    """自动获取当前 feilin 脚本体积（HEAD content-length），按 path 进程内缓存。"""
    if not feilin_path:
        return FEILIN_SIZE_FALLBACK
    if feilin_path in _FEILIN_SIZE_CACHE:
        return _FEILIN_SIZE_CACHE[feilin_path]
    url = "https://g.alicdn.com/captcha-frontend/FeiLin/%s.js" % feilin_path
    size = FEILIN_SIZE_FALLBACK
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            cl = r.headers.get("Content-Length")
            if cl:
                size = int(cl)
    except Exception:
        pass
    _FEILIN_SIZE_CACHE[feilin_path] = size
    return size
CAPTCHA_FRONT_STR = "W.10001.c#saf-captcha##captcha-front#%s#cn" % PREFIX


# ============================================================
# 密码原语（AES-128-CBC / POP 签名）
# ============================================================
def aes_encrypt(key: bytes, plaintext: str) -> str:
    if len(key) != 16:
        raise ValueError("AES key must be 16 bytes")
    ct = AES.new(key, AES.MODE_CBC, AES_IV).encrypt(pad(plaintext.encode("utf-8"), 16))
    return base64.b64encode(ct).decode("ascii")


def aes_decrypt(key: bytes, ciphertext_b64: str) -> str:
    if len(key) != 16:
        raise ValueError("AES key must be 16 bytes")
    pt = AES.new(key, AES.MODE_CBC, AES_IV).decrypt(base64.b64decode(ciphertext_b64))
    return unpad(pt, 16).decode("utf-8")


def decrypt_stored_key(ciphertext_b64: str) -> str:
    return aes_decrypt(ACCESS_SEC, ciphertext_b64)


def _pop_percent_encode(value: str) -> str:
    return urllib.parse.quote(str(value), safe="~")


def pop_sign_params(params: Mapping[str, str], access_key_secret: str) -> Dict[str, str]:
    """就地补 Signature（签名按 key 排序计算，字典插入序 = wire 序）。"""
    params = dict(params)
    params.pop("Signature", None)
    canon = "&".join("%s=%s" % (_pop_percent_encode(k), _pop_percent_encode(params[k]))
                     for k in sorted(params))
    sts = "POST&" + _pop_percent_encode("/") + "&" + _pop_percent_encode(canon)
    digest = hmac.new((access_key_secret + "&").encode("utf-8"), sts.encode("utf-8"), hashlib.sha1).digest()
    params["Signature"] = base64.b64encode(digest).decode("ascii")
    return params


def _pop_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _nonce() -> str:
    return str(uuid.uuid4())


# ============================================================
# 密钥集合与 DeviceData
# ============================================================
@dataclass
class CaptchaKeys:
    req_key: bytes
    res_key: bytes
    flag_key: bytes

    @classmethod
    def load(cls) -> "CaptchaKeys":
        return cls(
            req_key=decrypt_stored_key(WEB_AES_SECRET_KEY_ENC["REQ"]).encode(),
            res_key=decrypt_stored_key(WEB_AES_SECRET_KEY_ENC["RES"]).encode(),
            flag_key=decrypt_stored_key(WEB_AES_SECRET_KEY_ENC["FLAG"]).encode(),
        )


def build_device_data(keys: CaptchaKeys, scene_id: str, prefix: str) -> str:
    inner_plain = "%s#%s#%s#captcha-normal#%s#%s" % (PLATFORM_INNER, APP_NAME, scene_id, prefix, REGION)
    inner = aes_encrypt(keys.flag_key, inner_plain)
    outer_plain = "%s#%s#%s#%s#CLOUD#" % (APP_KEY, DEVICE_TYPE_WEB, inner, APP_VERSION)
    return aes_encrypt(keys.req_key, outer_plain)


# ============================================================
# 每日层 A：v78d98s（feilin008 版，2026-09-05）
#   sid[-8:] -> XOR"582abb1e" -> printable 移位((code+"c8228469"[i%8]-64)%95+32) -> b64
#   feilin 轮换时替换本段（算法点/常量见 纯算/阿里v2_技术文档.md 当日小节）
# ============================================================
_V78_XOR_KEY = "582abb1e"
_V78_SHIFT_KEY = "c8228469"


def _v78_js_mod(a, n):
    r = abs(a) % n
    return r if a >= 0 else -r


def _v78_xor_utf8(s, key):
    data = bytearray(s.encode("utf-8"))
    kb = key.encode("utf-8")
    for i in range(len(s)):
        data[i] ^= kb[i % len(kb)]
    return bytes(data).decode("utf-8", errors="replace")


def _v78_move_key(s, key):
    out = []
    for i, ch in enumerate(s):
        code = ord(ch)
        if 32 <= code <= 126:
            out.append(chr(_v78_js_mod(code + ord(key[i % len(key)]) - 64, 95) + 32))
        else:
            out.append(ch)
    return "".join(out)


def v78d98s(session_id):
    s = str(session_id or "")[-8:]
    mid = _v78_xor_utf8(s, _V78_XOR_KEY)
    return base64.b64encode(_v78_move_key(mid, _V78_SHIFT_KEY).encode("latin-1")).decode("ascii")


# ============================================================
# 每日层 B：dfghfgdh6（feilin008 版，2026-09-05）
#   algoOrder [85,0,95,72,105,1,100,94,90,86]；算法点下标 = env 同下标段
#   消费：md5(algoPoints[idx])[:5]，空输出点 "00000"
# ============================================================
_DFG_ALGO_ORDER = [85, 0, 95, 72, 105, 1, 100, 94, 90, 86]


def _dfg_js_mod(a, n):
    r = abs(a) % n
    return r if a >= 0 else -r


def _dfg_chr(x):
    return chr(x % 65536)


def _dfg_m32(x):
    return x & 0xFFFFFFFF


def _dfg_scalar(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        s = v
    else:
        try:
            s = json.dumps(v, separators=(",", ":"), ensure_ascii=False)
        except Exception:
            s = str(v)
    return s.replace("#", "").replace('"', "")


def _dfg_xk8(s, add=207, key="XK8"):
    out = []
    for i, ch in enumerate(s):
        b = _dfg_js_mod(ord(ch) + add, 65536)
        out.append(_dfg_chr(_dfg_js_mod(b + ord(key[i % len(key)]) - 48, 65536)))
    return "".join(out)


def _dfg_xor119(s):
    key = "XOR119"
    out = []
    for i, ch in enumerate(s):
        a = _dfg_js_mod(ord(ch) + 119 + i, 65536)
        out.append(_dfg_chr(_dfg_js_mod(a, 65536) ^ ord(key[i % len(key)])))
    return "".join(out)


def _dfg_xk37(s):
    key = "XK37ML9"
    out = []
    for i, ch in enumerate(s):
        a = _dfg_js_mod(ord(ch) + 37 + i, 65536)
        out.append(_dfg_chr(_dfg_js_mod(a, 65536) ^ ord(key[i % len(key)])))
    return "".join(out)


def _dfg_add116(s):
    return "".join(_dfg_chr(_dfg_js_mod(_dfg_js_mod(ord(c) + 116, 65536) ^ 116, 65536)) for c in s)


def _dfg_sub45(s):
    return "".join(_dfg_chr(_dfg_js_mod(ord(c) - 90, 65536) ^ 45) for c in s)


def _dfg_add79(s):
    return "".join(_dfg_chr((_dfg_js_mod(ord(c) + 79, 65536) ^ 179)) for c in s)


def _dfg_sub117_234(s):
    return "".join(_dfg_chr((_dfg_m32(ord(c) - 117) ^ 234) & 0xFFFF) for c in s)


_DFG_POINT_DEFS = {
    85: ("gdfgs23145", _dfg_sub117_234),
    0: ("dghfh565", _dfg_sub45),
    95: ("fxcv342", _dfg_xk8),
    72: ("hgvh4435", _dfg_xk8),
    105: ("dr5435", _dfg_add79),
    1: ("asdfasdf", _dfg_xor119),
    100: ("vv4c234", _dfg_xk37),
    94: ("gfdg3424", _dfg_xor119),
    90: ("vcvbtryr43", _dfg_sub45),
    86: ("h9w87s9", _dfg_add116),
}


def dfghfgdh6(env=None):
    env = env or {}
    parts = []
    for idx in _DFG_ALGO_ORDER:
        key, transform = _DFG_POINT_DEFS[idx]
        value = transform(_dfg_scalar(env.get(key)))
        parts.append(hashlib.md5(value.encode("utf-8")).hexdigest()[:5] if value else "00000")
    return "".join(parts)


# ============================================================
# 设备会话（Log1 注册 + Log2 指纹上报）
# ============================================================
def _ds_aes_enc(key, plain):
    c = AES.new(key.encode(), AES.MODE_CBC, AES_IV)
    return base64.b64encode(c.encrypt(pad(plain.encode(), 16))).decode()


def _ds_aes_dec(key, enc_b64):
    c = AES.new(key.encode(), AES.MODE_CBC, AES_IV)
    return unpad(c.decrypt(base64.b64decode(enc_b64)), 16).decode()


def _ds_sign(data, sk):
    safe = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~'*()")

    def enc(v):
        out = []
        for ch in str(v):
            if ch in safe:
                out.append(ch)
            else:
                out.extend("%%%02X" % b for b in ch.encode())
        return "".join(out)

    d = {k: v for k, v in data.items() if k != "Signature"}
    cqs = "&".join("%s=%s" % (k, enc(d[k])) for k in sorted(d))
    s = "POST&%s&%s" % (enc("/"), enc(cqs))
    return base64.b64encode(hmac.new((sk + "&").encode(), s.encode(), hashlib.sha1).digest()).decode()


def _ds_usp(s):
    safe = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*-._")
    out = []
    for byte in str(s).encode("utf-8"):
        ch = chr(byte)
        if ch in safe:
            out.append(ch)
        elif ch == " ":
            out.append("+")
        else:
            out.append("%%%02X" % byte)
    return "".join(out)


def _rand_chars(n):
    chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(random.choice(chars) for _ in range(n))


# Log2 env 模板（142 段；下标 = 每日算法消费下标）
IDX_COLOR_MD5 = 19
IDX_V78D98S = 21
IDX_CANVAS_MD5 = 32
IDX_IP = 42
IDX_NGHJDFGSH = 43
IDX_DFGHFGDH6 = 52
IDX_TOKEN_C = 71
IDX_TS_C = 72
IDX_TOKEN_L = 73
IDX_TS_L = 74
IDX_CFG_TS = 87
IDX_FEILIN_URL = 117
IDX_FEILIN_OBS = 118

ENV_TEMPLATE = [
    "W.10054", "1.5", "11", "", "Blink", "Win32", "Chrome", "147.0.0.0", "504",
    "[application/pdf,text/pdf]", "false", "0.9375", "Google Inc. (NVIDIA)",
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Ti (0x00001F95) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "", "", "0", "0", "0", "fe78931a5aa2c8d4b0449d4bd1fabaee", "104", "bm85HDM1YmE=", "16",
    "0*0*40*0", "32", "32", "srgb", "false", "false", "false", "0", "0",
    "c5f495b08dc86f8cd7e04e9592c1c022", "", "8", "[[audioinput,],[videoinput,],[audiooutput,]]",
    "Windows", "10", "0.96", "true", "zh-CN", "Asia/Shanghai", "", "",
    "true", "true", "true", "864*1536", "true", "0", "false", "false",
    "9eb4507a9a921536edaa191e8b5a3508842de263405f8c7883", "https://dy.feigua.cn/", "",
    "983*2048", "824*1536", "824*1536", "0", "983*2027", "true", "", "true", "147.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "unspecified", "false", "saf-captcha", "0",
    "[PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF]",
    "-480", "6JrLK08zjDyychwZvHWzTaCSnBELWY2ezApjL8fM", "", "NFTDf8TPKqmQIbO2JxttoMAKVuXnOFmu06SE6hd5fO",
    "", "desktop", "false", "", "9d4568c009d203ab10e33ea9953a0264", "99914b932bd37a50b983c5e7c90ae93b",
    "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Mozilla", "64", "147.0.7727.102", "", "0", "0", "", 
    "MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzEjMCMxMTExMTExMDExMTExMTExMTExMTExMTExMQ==",
    "1", "1", "true", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1",
    "0", "[Google Chrome,Not.A/Brand,Chromium]",
    "0|0|0|0|0|0|1|1|0|1|1|0|1|1|0|1|1|0|1|1|0|1|1|0|1|1|0|1|1|0|1|1|0",
    "0", "[0,a]", "false", "", "true", "", "[[https://g.alicdn.com/captcha-frontend/FeiLin/,10,579254]]",
    "false", "false", "true", "false", "false", "false", "[true,true,true,true,true]", "false", "",
    "[0,0]", "1", "", "", "", "https", "false", "file:",
    "[1.3,9.9,3.9,0.3,0.1,0,4.8,5,4.9,4.3,6.6,7.3,4.8,4.1]", "[1231.164,1231.164,1247.7]", "0",
    "[c4928a18fbbe0592aceba92682a62fcc,122,110]", "[c03e21facb8041e7fad3aa74fe53fc49,240,60]", "1",
]


class DeviceSession(object):
    """feilin 设备会话：Log1 注册 -> env -> Log2 上报。产出 fp2/DeviceToken 所需全部状态。"""

    def __init__(self, proxies: Optional[dict] = None):
        self.proxies = proxies
        self.session_key = None
        self.session_id = None
        self.feilin_path = None
        self.config_ts = None
        self.config_ip = None
        self.gather_cost = random.randint(240, 340)
        self.t0 = None
        self.canvas_md5 = os.urandom(16).hex()
        self.color_md5 = os.urandom(16).hex()
        self.token_c = _rand_chars(40)
        self.token_l = _rand_chars(42)

    def log1(self):
        inner = _ds_aes_enc(K_FLAG, CAPTCHA_FRONT_STR)
        plain = "#".join([APP_KEY, "W", inner, APP_VERSION, "CLOUD", ""])
        data = {
            "AaduaneId": DEVICE_AK, "Version": DEVICE_API_VERSION,
            "SignatureMethod": "HMAC-SHA1", "SignatureVersion": "1.0", "Format": "JSON",
            "Action": "Log1", "Data": _ds_aes_enc(K_REQ, plain),
            "SignatureNonce": str(uuid.uuid4()),
        }
        data["Signature"] = _ds_sign(data, DEVICE_SK)
        s = requests.Session()
        s.headers.clear()
        r = s.post("https://%s/" % DEVICE_HOST,
                   data="&".join("%s=%s" % (k, _ds_usp(v)) for k, v in data.items()),
                   headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                   timeout=30, verify=False, proxies=self.proxies)
        resp = r.json()
        if str(resp.get("Code")) != "200":
            raise RuntimeError("Log1 失败: %s" % r.text[:200])
        self.device_config_raw = resp["ResultObject"]["DeviceConfig"]
        cfg = _ds_aes_dec(K_RES, resp["ResultObject"]["DeviceConfig"]).split("#")
        self.session_key = base64.b64decode(cfg[0]).decode()
        self.session_id = cfg[2]
        self.feilin_path = cfg[3]
        self.config_ts = cfg[7]
        self.config_ip = cfg[8]
        self.t0 = int(self.config_ts) - random.randint(1270, 1570)
        return resp

    def _timeline(self):
        o11 = random.randint(130, 240)
        o20 = o11 + random.randint(1, 4)
        o23 = o20 + random.randint(95, 130)
        o30 = o23 + random.randint(1, 3)
        o40 = o30 + random.randint(1, 6)
        o41 = o40 + random.randint(250, 330)
        o70 = o41 + random.randint(0, 3)
        ms = [10, 11, 20, 23, 30, 40, 41, 70]
        vals = [0, o11, o20, o23, o30, o40, o41, o70]
        return ["%d-%d" % (k, v) for k, v in zip(ms, vals)]

    def _board(self, verify_ts=None):
        fields = list(_LOG2_BOARD)
        fields[21] = v78d98s(self.session_id)
        fields[42] = self.config_ip
        fields[43] = "|".join(self._timeline())
        fields[52] = dfghfgdh6({
            "gdfgs23145": fields[85], "dghfh565": fields[0], "fxcv342": fields[95],
            "hgvh4435": str(self.t0), "dr5435": fields[105], "asdfasdf": fields[1],
            "vv4c234": fields[100], "gfdg3424": fields[94], "vcvbtryr43": fields[90],
            "h9w87s9": fields[86], "v78d98s": fields[21],
        })
        fields[71] = self.token_c
        fields[72] = str(self.t0)
        fields[73] = self.token_l
        fields[74] = str(verify_ts if verify_ts else self.t0 + (int(self.config_ts) - self.t0) * 40 // 100)
        fields[87] = str(self.config_ts)
        fields[77] = ""
        feilin_url = "https://g.alicdn.com/captcha-frontend/FeiLin/" + self.feilin_path + ".js"
        fields[117] = feilin_url
        fields[118] = "[[%s,%s,%d]]" % (feilin_url, 24.5, feilin_size(self.feilin_path))
        return "#".join(fields[:142])

    def _build_env(self):
        return self._board()

    def log2(self):
        h_outer = _ds_aes_enc(self.session_key, DEVICE_PLATFORM + "#saf-captcha")
        h = _ds_aes_enc(self.session_key, "saf-captcha")
        z = _ds_aes_enc(self.session_key, DEVICE_PLATFORM)
        big_l = _ds_aes_enc(self.session_key, str(int(time.time() * 1000)))
        payload = base64.b64encode("#".join([
            self.session_id,
            _ds_aes_enc(self.session_key, self._build_env()),
            h, z, "",
            _ds_aes_enc(self.session_key, str(int(time.time() * 1000))),
        ]).encode()).decode("ascii")
        t = [APP_KEY, "W", h_outer, APP_VERSION, "CLOUD", str(self.gather_cost), "501", payload]
        data = {
            "AaduaneId": DEVICE_AK, "Version": DEVICE_API_VERSION,
            "SignatureMethod": "HMAC-SHA1", "SignatureVersion": "1.0", "Format": "JSON",
            "Action": "Log2", "Data": _ds_aes_enc(K_UPLOAD, "#".join(t)),
            "SignatureNonce": str(uuid.uuid4()),
        }
        data["Signature"] = _ds_sign(data, DEVICE_SK)
        s = requests.Session()
        s.headers.clear()
        r = s.post("https://%s/" % DEVICE_HOST,
                   data="&".join("%s=%s" % (k, _ds_usp(v)) for k, v in data.items()),
                   headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                   timeout=30, verify=False, proxies=self.proxies)
        resp = r.json()
        if str(resp.get("Code")) != "200":
            raise RuntimeError("Log2 失败: %s" % r.text[:200])
        return resp


# ============================================================
# fp2（142 段）与 deviceToken
# ============================================================
FP2_TOKEN_40 = "VCf41raeYYIeBzJDfXxH9KVxMVECJa8RuwGvxFeX"
FP2_TOKEN_42 = "k3bYpKpOnyQ7UL9NeGvSRC4PuTWtcemvAE91Bl0GDH"
FP2_FIXED_78 = "9d4568c009d203ab10e33ea9953a0264"
FP2_FIXED_88 = "MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzEjMSMxMTExMTExMDExMTExMTExMTExMTExMTExMQ=="
CHROME_VERSION = "147.0.0.0"
SCREEN_W, SCREEN_H = 1536, 864
FONTS = 104
EVENT_DELTAS = [(10, 0), (11, 408), (20, 409), (23, 659), (30, 661), (40, 671),
                (41, 946), (70, 947), (71, 1002), (80, 1002), (81, 1004)]


def build_event_timing(verify_elapsed_from_load):
    parts = []
    for code, delta in EVENT_DELTAS:
        parts.append("%d-%d" % (code, max(0, delta + random.randint(-4, 4))))
    parts.append("93-%d" % (verify_elapsed_from_load + random.randint(0, 4)))
    parts.append("94-%d" % (verify_elapsed_from_load + random.randint(14, 20)))
    return "|".join(parts)


def build_fp2(client_session, certify_id, config_ip, event_timing,
              page_load_ts, verify_ts, session_ts,
              fp_version="W.10054", canvas_md5="", session_jitter_ms=3, tokens=None):
    """trace 真值 fp2 板（deviceToken part2）+ 会话动态覆盖。"""
    fields = list(_FP2_BOARD)
    fields[21] = v78d98s(client_session)
    fields[42] = config_ip
    fields[43] = event_timing
    fields[52] = dfghfgdh6({
        "gdfgs23145": fields[85], "dghfh565": fields[0], "fxcv342": fields[95],
        "hgvh4435": str(page_load_ts), "dr5435": fields[105], "asdfasdf": fields[1],
        "vv4c234": fields[100], "gfdg3424": fields[94], "vcvbtryr43": fields[90],
        "h9w87s9": fields[86], "v78d98s": fields[21],
    })
    if tokens:
        fields[71], fields[72], fields[73], fields[74] = (
            tokens[0], str(page_load_ts), tokens[1], str(verify_ts))
    else:
        fields[72] = str(int(page_load_ts))
        fields[74] = str(int(verify_ts))
    fields[87] = str(int(session_ts) + session_jitter_ms)
    return "#".join(fields[:142])


def build_device_token(session_key, fp2_plain, session_id, num=None):
    aes_b64 = aes_encrypt(session_key.encode("utf-8"), fp2_plain)
    num = str(num if num is not None else random.randint(212, 452))
    preimage = "WEB#%s#%s#%s#%s" % (session_id, aes_b64, num, TOKEN_MD5_SALT)
    digest = hashlib.md5(preimage.encode("utf-8")).hexdigest()
    plain = "WEB#%s#%s#%s#%s" % (session_id, aes_b64, num, digest)
    return base64.b64encode(plain.encode("utf-8")).decode("ascii")


# ============================================================
# sg 密码（data 打包）：plain = 32hex 前缀 + TrackList JSON
#   -> b64(zlib) -> 64 元素 RC4 族按位置替换（z1 = "3e627e1b4c63f913" 跨变体恒定）
# ============================================================
SG_Z1 = "3e627e1b4c63f913"
_SG_S0 = [
    32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
    60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
    18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
    8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
]
_SG_N = 64


def _sg_ksa(z1):
    S = list(_SG_S0)
    key = [ord(c) for c in z1]
    j = 0
    for i in range(_SG_N):
        j = ((((i + j + S[i] + S[j]) >> 1) + key[i % len(key)]) & (_SG_N - 1))
        if i != j:
            S[i], S[j] = S[j], S[i]
    return S


def _sg_encrypt_intermediate(intermediate_b64, z1=SG_Z1):
    S = _sg_ksa(z1)
    out = bytearray()
    i = 0
    j = 0
    for ch in intermediate_b64:
        m = ord(ch)
        j = (((i ^ j) + (S[i] ^ S[j])) & (_SG_N - 1))
        if i != j:
            S[i], S[j] = S[j], S[i]
        m = m + i + S[i]
        m = m - (j + S[j])
        m = m ^ (S[i] + S[j])
        m = m ^ S[(S[i] + S[j]) & (_SG_N - 1)]
        out.append(m & 0xFF)
        i = (i + 1) & (_SG_N - 1)
    return bytes(out)


def sg_encode_data(trajectory_json):
    prefix = os.urandom(16).hex()
    plain = (prefix + trajectory_json).encode("utf-8")
    intermediate = base64.b64encode(zlib.compress(plain, 6)).decode("ascii")
    return base64.b64encode(_sg_encrypt_intermediate(intermediate, SG_Z1)).decode("ascii")


# ============================================================
# RPC 客户端（requests_go 后端优先）
# ============================================================
@dataclass
class InitResult:
    certify_id: str
    static_path: str
    captcha_type: str
    session_key: str
    feilin_path: str
    config_ts: str
    config_ip: str
    raw: Dict[str, Any] = field(default_factory=dict)


class CaptchaClient:
    def __init__(self, keys: Optional[CaptchaKeys] = None, proxies: Optional[dict] = None):
        self.proxies = proxies
        self.prefix_keys = keys or CaptchaKeys.load()
        self.endpoint = CAPTCHA_ENDPOINT
        self.verify_endpoint = CAPTCHA_VERIFY_ENDPOINT
        self._tls_config = None
        if _BACKEND == "requests_go":
            self.session = _rg.Session()
            self._tls_config = _tls_config_mod.TLS_CHROME_LATEST
        elif _BACKEND == "curl_cffi":
            try:
                self.session = _curl_requests.Session(impersonate="edge101")
            except TypeError:
                self.session = _curl_requests.Session()
        else:
            self.session = requests.Session()

    def _headers(self) -> Dict[str, str]:
        return {
            "User-Agent": UA, "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Origin": SITE_ORIGIN, "Referer": SITE_REFERER,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }

    def _post(self, url, params):
        extra = {"tls_config": self._tls_config} if self._tls_config else {}
        if self.proxies:
            extra["proxies"] = self.proxies
        return self.session.post(url, headers=self._headers(), data=params, timeout=30, **extra)

    def _signed(self, action, extra):
        params = {
            AK_PARAM_NAME: CAPTCHA_AK, "SignatureMethod": "HMAC-SHA1",
            "SignatureVersion": "1.0", "Format": "JSON",
            "Timestamp": _pop_timestamp(), "Version": API_VERSION, "Action": action,
        }
        params.update(extra)
        params["SignatureNonce"] = params.get("SignatureNonce") or _nonce()
        return pop_sign_params(params, CAPTCHA_SK)

    def init_captcha_v3(self) -> InitResult:
        device_data = build_device_data(self.prefix_keys, SCENE_ID, PREFIX)
        params = self._signed("InitCaptchaV3", {
            "SceneId": SCENE_ID, "Language": "cn", "Mode": "embed", "DeviceData": device_data,
        })
        resp = self._post(self.endpoint, params)
        body = resp.json()
        if not body.get("Success"):
            raise RuntimeError("InitCaptchaV3 failed: %s" % resp.text[:600])
        dc_enc = body.get("DeviceConfig", "")
        dc_plain = aes_decrypt(self.prefix_keys.res_key, dc_enc) if dc_enc else ""
        parts = dc_plain.split("#") if dc_plain else []
        return InitResult(
            certify_id=body.get("CertifyId", ""), static_path=body.get("StaticPath", ""),
            captcha_type=body.get("CaptchaType", ""),
            session_key=base64.b64decode(parts[0]).decode("utf-8", "replace") if parts else "",
            feilin_path=parts[3] if len(parts) > 3 else "",
            config_ts=parts[7] if len(parts) > 7 else "",
            config_ip=parts[8] if len(parts) > 8 else "",
            raw=body,
        )

    def verify_captcha_v3(self, certify_id, device_token, data):
        cvp = '{"sceneId":"%s","certifyId":"%s","deviceToken":"%s","data":"%s"}' % (
            SCENE_ID, certify_id, device_token, data)
        params = self._signed("VerifyCaptchaV3", {
            "SceneId": SCENE_ID, "CertifyId": certify_id, "CaptchaVerifyParam": cvp,
        })
        resp = self._post(self.verify_endpoint, params)
        return resp.json()


# ============================================================
# PUZZLE 缺口识别（YOLO 主策略 + cv2 兜底）
# ============================================================
_YOLO_SLIDER = None
_YOLO_LOCK = threading.Lock()


def detect_puzzle_gap(back_bytes: bytes, shad_bytes: bytes) -> int:
    with _YOLO_LOCK:
        """识别缺口左缘（图像坐标 = xPos）。主策略 YOLO-seg（置信度 ~0.95），兜底 cv2 三策略投票。"""
        global _YOLO_SLIDER
        if os.environ.get("XF_DEBUG"):        # 仅调试时落盘原图
            open("_back_live.png", "wb").write(back_bytes)
            open("_shadow_live.png", "wb").write(shad_bytes)
        _t0 = time.time()
        try:
            if _YOLO_SLIDER is None:
                from captcha_recognizer.slider import Slider
                _t0 = time.time()
                _YOLO_SLIDER = Slider()
                step_log("[YOLO] 模型加载 %.1fs（进程内仅一次）" % (time.time() - _t0))
            box, conf = _YOLO_SLIDER.identify(source=back_bytes)
            step_log("[YOLO] 识别耗时 %.0fms conf=%.2f" % ((time.time() - _t0) * 1000, conf))
            if conf >= 0.5:
                return int(round(box[0]))
        except Exception as e:
            step_log("[PUZZLE] YOLO 识别失败，回退 cv2：", str(e)[:80])
        import cv2
        import numpy as np
        bg = cv2.imdecode(np.frombuffer(back_bytes, np.uint8), cv2.IMREAD_COLOR)
        sh = cv2.imdecode(np.frombuffer(shad_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
        ys, xs = np.where(sh[:, :, 3] > 10)
        piece = sh[ys.min():ys.max()+1, xs.min():xs.max()+1]
        mask = (piece[:, :, 3] > 10).astype(np.uint8) * 255
        mask3 = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
        res_a = cv2.matchTemplate(bg, piece[:, :, :3], cv2.TM_CCOEFF_NORMED, mask=mask3)
        _, _, loc_a, _ = cv2.minMaxLoc(res_a)
        res_b = cv2.matchTemplate(bg, piece[:, :, :3], cv2.TM_SQDIFF, mask=mask3)
        _, _, loc_b, _ = cv2.minMaxLoc(res_b)
        ge = cv2.Canny(cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY), 80, 200)
        pe = cv2.Canny(piece[:, :, :3], 80, 200)
        res_c = cv2.matchTemplate(ge, pe, cv2.TM_CCOEFF_NORMED)
        _, mv_c, _, loc_c = cv2.minMaxLoc(res_c)
        cands = [loc_a[0], loc_b[0], loc_c[0]]
        best = None
        for i in range(3):
            for j in range(i + 1, 3):
                d = abs(cands[i] - cands[j])
                if best is None or d < best[0]:
                    best = (d, (cands[i] + cands[j]) // 2)
        if best[0] > 6 or mv_c < 0.12:
            raise RuntimeError("缺口识别置信度低 minPairDiff=%d confC=%.3f" % (best[0], mv_c))
        return best[1]


# ============================================================
# 变速滑块轨迹（xPos = slidePos×(slidePos+20)/280；源自 10 组真实成功轨迹逆向）
# ============================================================
def xpos_to_slidepos(gap_x):
    """逆向变速公式：缺口位置 -> 滑块拖动距离"""
    return round(-10 + math.sqrt(100 + 280 * gap_x))


def _gen_drag(sx, sy, dist, t0):
    """拖拽点序列：短暂起步 -> 快速拖动 -> 逐像素精确逼近。"""
    pts = [(sx, sy, t0)]
    pause = random.randint(20, 90)
    exp = random.uniform(1.5, 3.0)
    main_dist = round(dist * random.uniform(0.92, 0.97))
    main_dur = random.randint(700, 1400)
    up_prob = random.uniform(0.02, 0.08)
    dn_prob = random.uniform(0.01, 0.06)
    cur_y = sy
    last_x = sx
    cur_t = t0 + pause
    elapsed = 0
    while elapsed <= main_dur:
        frac = min(elapsed / main_dur, 1.0)
        eased = 1 - (1 - frac) ** exp
        x = sx + round(eased * main_dist)
        r = random.random()
        if r < up_prob:
            cur_y += 1
        elif r < up_prob + dn_prob:
            cur_y -= 1
        if x != last_x or random.random() > 0.5:
            pts.append((x, cur_y, cur_t))
            last_x = x
        dt = random.randint(6, 10)
        cur_t += dt
        elapsed += dt
    if last_x < sx + main_dist:
        pts.append((sx + main_dist, cur_y, cur_t))
        last_x = sx + main_dist
        cur_t += random.randint(6, 10)
    remaining = max(0, sx + dist - last_x)
    for i in range(remaining):
        dt = random.randint(15, 60) if i < remaining // 2 else random.randint(30, 200)
        cur_t += dt
        last_x += 1
        if random.random() < 0.05:
            cur_y += random.choice([-1, 1])
        pts.append((last_x, cur_y, cur_t))
    if pts[-1][0] != sx + dist:
        cur_t += random.randint(20, 60)
        pts.append((sx + dist, cur_y, cur_t))
    return pts


def _gen_approach(sx, sy, ex, ey, t0, t1, min_n=6):
    dur = max(100, t1 - t0)
    n = min(max(min_n, dur // random.randint(8, 16)), 50)
    pts = []
    for i in range(n):
        f = i / max(1, n - 1)
        e = 1 - (1 - f) ** 2
        x = round(sx + (ex - sx) * e + random.gauss(0, 0.8))
        y = round(sy + (ey - sy) * e + random.gauss(0, 0.8))
        pts.append((x, y, t0 + round(f * dur)))
    return pts


def _gen_ks(t1s, t1e, t2s, t2e):
    evts = []
    for a, b in [(t1s, t1e), (t2s, t2e)]:
        if a >= b:
            continue
        for t in sorted(random.randint(a, b) for _ in range(random.randint(3, 5))):
            evts.append(t)
            evts.append(t + random.randint(0, 4))
    evts.sort()
    return "|".join(f"{t}, ,1" for t in evts)


def _gen_fi(t1d, t2d, t3d, t3u):
    b1 = t2d + random.randint(0, 1)
    b2 = t3d + random.randint(0, 1)
    return "|".join([
        f"{t1d + random.randint(1, 8)},1,1",
        f"{b1},0,1", f"{b1 + 1},1,1",
        f"{b2},0,1", f"{b2 + 1},1,1",
        f"{t3u + random.randint(0, 5)},0,1",
    ])


def generate_trajectory(xPos, start_anchor=None):
    """输入缺口位置 xPos，生成完整 TrackList（与真实 VerifyCaptchaV3 payload 同构）。
    start_anchor: 轨迹允许的最早起点（ms 时间戳，通常 = init 时刻 - 1500）。
    全部时间戳用加减法锚定到当前时刻，无需真实等待。"""
    slide_pos = xpos_to_slidepos(xPos)
    now = int(time.time() * 1000)
    fps = random.uniform(57, 72)
    si = f"342,1280,588,342,588,672,720,{fps},1280"

    c1x, c1y = random.randint(100, 200), random.randint(256, 285)
    c2x, c2y = random.randint(135, 190), random.randint(350, 385)
    c3x, c3y = random.randint(145, 195), random.randint(430, 455)
    slx, sly = random.randint(36, 45), random.randint(382, 391)

    t1d = random.randint(300, 800)
    t1u = t1d + random.randint(60, 120)
    ks1s = t1u + random.randint(100, 300)
    ks1e = ks1s + random.randint(250, 600)
    t2d = ks1e + random.randint(100, 350)
    t2u = t2d + random.randint(60, 120)
    ks2s = t2u + random.randint(100, 300)
    ks2e = ks2s + random.randint(250, 500)
    t3d = ks2e + random.randint(100, 300)
    t3u = t3d + random.randint(40, 100)
    t4d = t3u + random.randint(300, 700)

    drag = _gen_drag(slx, sly, slide_pos, t4d)
    last_drag = drag[-1]
    t4u = last_drag[2] + random.randint(200, 800)
    end_x = slx + slide_pos
    end_y = last_drag[1]

    mm_pts = list(drag)
    mm_pts.append((end_x, end_y, t4u))
    mm_pts.append((end_x + random.randint(35, 50), end_y + random.randint(55, 70), t4u + 17))

    mp_pts = []
    ox, oy = random.randint(300, 340), random.randint(290, 360)
    mp_pts += _gen_approach(ox, oy, c1x, c1y, random.randint(50, 300), t1d - random.randint(80, 200))
    mp_pts.append((c1x, c1y, t1d + random.randint(20, 80)))
    mp_pts += _gen_approach(c1x + random.randint(-3, 3), c1y + random.randint(-2, 2),
                            c2x, c2y, ks1e - random.randint(200, 500), t2d - random.randint(30, 100))
    mp_pts.append((c2x, c2y, t2d + random.randint(10, 40)))
    mp_pts += _gen_approach(c2x + random.randint(-2, 2), c2y + random.randint(-2, 2),
                            c3x, c3y, ks2e - random.randint(100, 300), t3d - random.randint(20, 60))
    mp_pts.append((c3x, c3y, t3d + random.randint(10, 30)))
    cx, cy = random.randint(280, 340), random.randint(300, 380)
    tc = t3u + random.randint(100, 400)
    mp_pts += _gen_approach(c3x, c3y, cx, cy, t3u + random.randint(30, 80), tc)
    mp_pts += _gen_approach(cx, cy, slx, sly, tc + random.randint(100, 500), t4d - random.randint(30, 100))
    mp_pts.append((slx, sly, t4d - random.randint(10, 40)))
    mp_pts += drag[1:]

    mp_pts.sort(key=lambda p: p[2])
    clean = [mp_pts[0]]
    for p in mp_pts[1:]:
        if p[2] > clean[-1][2]:
            clean.append(p)
    mp_pts = clean

    # —— 时间线锚定（纯加减法，不 sleep）：整条轨迹平移，使终点≈当前时刻 ——
    span = mm_pts[-1][2]
    start_wall = now - span
    if start_anchor and start_wall < start_anchor:
        start_wall = start_anchor
    delta = start_wall - now
    mm_pts = [(x, y, t + delta) for x, y, t in mm_pts]
    mp_pts = [(x, y, t + delta) for x, y, t in mp_pts]
    t1d += delta; t1u += delta; t2d += delta; t2u += delta
    t3d += delta; t3u += delta; t4d += delta; t4u += delta
    ks1s += delta; ks1e += delta; ks2s += delta; ks2e += delta

    mc = "|".join([
        f"{c1x},{c1y},{t1d}, ,1", f"{c2x},{c2y},{t2d}, ,1",
        f"{c3x},{c3y},{t3d}, ,1", f"{slx},{sly},{t4d}, ,1",
    ])
    mu = "|".join([
        f"{c1x},{c1y},{t1u}, ,1", f"{c2x},{c2y},{t2u}, ,1",
        f"{c3x},{c3y},{t3u}, ,1", f"{end_x},{end_y},{t4u}, ,1",
    ])
    mm = "|".join(f"{p[0]},{p[1]},{p[2]},1" for p in mm_pts)
    mp = "|".join(f"{p[0]},{p[1]},{p[2]},1" for p in mp_pts)
    ks = _gen_ks(ks1s, ks1e, ks2s, ks2e)
    fi = _gen_fi(t1d, t2d, t3d, t3u)
    vt = now + random.randint(0, 120)

    return {
        "TrackList": {
            "mc": mc, "tc": "", "mu": mu, "te": "",
            "mp": mp, "tmv": "", "mm": mm, "ks": ks, "fi": fi,
            "startTime": start_wall, "si": si,
        },
        "TrackStartTime": start_wall, "VerifyTime": vt,
        "xPos": str(xPos), "slidePos": str(slide_pos),
    }


# ============================================================
# 端到端编排
# ============================================================
def run(max_verify_attempts: int = 3, verify: bool = True, proxies: Optional[dict] = None) -> dict:
    client = CaptchaClient(proxies=proxies)
    keys = CaptchaKeys.load()

    ds = DeviceSession(proxies=proxies)
    ds.log1()
    step_log("[Log1] session=", ds.session_id[:50], "ip=", ds.config_ip)
    ds.log2()
    step_log("[Log2] OK gather_cost=", ds.gather_cost)

    init = client.init_captcha_v3()
    init_ts = int(time.time() * 1000)
    print("[init] CertifyId=%s StaticPath=%s CaptchaType=%s" % (
        init.certify_id, init.static_path, init.captcha_type))
    fp_version = "W.10054"

    gap_img_x = None
    if init.captcha_type == "PUZZLE" and init.raw.get("Image"):
        ua = {"User-Agent": UA, "Referer": SITE_REFERER}
        for attempt_no in range(1, 6):
            try:
                back = requests.get(IMAGE_CDN + init.raw["Image"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                shad = requests.get(IMAGE_CDN + init.raw["PuzzleImage"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                gap_img_x = detect_puzzle_gap(back, shad)
                step_log("[PUZZLE] xPos=%s（第 %d 次识别）" % (gap_img_x, attempt_no))
                break
            except RuntimeError as e:
                print("[PUZZLE] %s，重新 init 换图（不耗 verify）" % e)
                time.sleep(1)
                init = client.init_captcha_v3()
                init_ts = int(time.time() * 1000)
        if gap_img_x is None:
            raise RuntimeError("连续 5 张图缺口识别失败")

    result = {"init": init.raw, "attempts": []}
    for attempt in range(1, max_verify_attempts + 1):
        if attempt > 1 and init.captcha_type == "PUZZLE":
            ua = {"User-Agent": UA, "Referer": SITE_REFERER}
            for attempt_no in range(1, 6):
                try:
                    back = requests.get(IMAGE_CDN + init.raw["Image"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                    shad = requests.get(IMAGE_CDN + init.raw["PuzzleImage"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                    gap_img_x = detect_puzzle_gap(back, shad)
                    print("[PUZZLE retry %d] xPos=%s" % (attempt, gap_img_x))
                    break
                except RuntimeError as e:
                    print("[PUZZLE] %s，重新 init 换图" % e)
                    time.sleep(1)
                    init = client.init_captcha_v3()
                    init_ts = int(time.time() * 1000)
            if gap_img_x is None:
                raise RuntimeError("连续 5 张图缺口识别失败")

        tl_obj = generate_trajectory(gap_img_x, start_anchor=init_ts - 1500)
        traj_json = json.dumps(tl_obj, separators=(",", ":"), ensure_ascii=False)

        vt_ms = int(time.time() * 1000)
        session_ts = int(ds.config_ts) + 3
        canvas_md5 = ds.canvas_md5
        event_timing = build_event_timing(vt_ms - ds.t0)
        fp2_plain = build_fp2(
            client_session=ds.session_id, certify_id=init.certify_id,
            config_ip=init.config_ip, event_timing=event_timing,
            page_load_ts=ds.t0, verify_ts=vt_ms + 2, session_ts=session_ts,
            tokens=(ds.token_c, ds.token_l))
        device_token = build_device_token(init.session_key, fp2_plain, ds.session_id,
                                          num=ds.gather_cost)
        data = sg_encode_data(traj_json)
        cvp = '{"sceneId":"%s","certifyId":"%s","deviceToken":"%s","data":"%s"}' % (
            SCENE_ID, init.certify_id, device_token, data)
        if not verify:
            return {"cvp": cvp, "certifyId": init.certify_id, "init": init.raw, "attempts": []}
        if os.environ.get("XF_DEBUG"):
            import base64 as _b64
            _dump = {"certifyId": init.certify_id, "session_key": init.session_key,
                     "session_id": ds.session_id, "feilin": init.feilin_path,
                     "config_ts": init.config_ts, "config_ip": init.config_ip,
                     "traj_json": traj_json, "fp2_plain": fp2_plain,
                     "device_token": device_token, "data": data,
                     "session_key_b64": _b64.b64encode(init.session_key.encode()).decode()}
            json.dump(_dump, open("_debug_single.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

        if os.environ.get("XF_WIRE"):
            json.dump({"url": client.verify_endpoint, "headers": client._headers(),
                       "cvp": '{"sceneId":"%s","certifyId":"%s","deviceToken":"%s","data":"%s"}' % (
                           SCENE_ID, init.certify_id, device_token, data)},
                      open("_wire_single.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        resp = client.verify_captcha_v3(init.certify_id, device_token, data)
        code = (resp.get("Result") or {}).get("VerifyCode")
        ok = (resp.get("Result") or {}).get("VerifyResult")
        print("[verify %d/%d] VerifyCode=%s VerifyResult=%s" % (attempt, max_verify_attempts, code, ok))
        result["attempts"].append(resp)
        if ok:
            result["verify"] = resp
            result["t001"] = True
            result["securityToken"] = (resp.get("Result") or {}).get("securityToken", "")
            break
        time.sleep(random.uniform(1.5, 2.5))
        try:
            init = client.init_captcha_v3()
            init_ts = int(time.time() * 1000)
            print("[re-init] 新 CertifyId=%s" % init.certify_id)
        except Exception as e:
            print("[re-init] failed(沿用原 CertifyId): %s" % str(e)[:120])
    else:
        result["t001"] = False
    return result


_STAT_LOCK = threading.Lock()
_STAT = {"ok": 0, "total": 0}


def _worker(worker_id, rounds, pace):
    for i in range(rounds):
        ok = False
        try:
            res = run(max_verify_attempts=3)
            ok = bool(res.get("t001"))
        except Exception as e:
            print("[w%d] 异常: %s" % (worker_id, str(e)[:160]))
        with _STAT_LOCK:
            _STAT["total"] += 1
            _STAT["ok"] += int(ok)
            print("[进度] %d/%d ok=%d" % (_STAT["total"], _STAT["total"] and _STAT["total"], _STAT["ok"]))
        if i < rounds - 1:
            time.sleep(pace)


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    pace = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    t0 = time.time()
    if threads <= 1:
        ok = 0
        for i in range(1, rounds + 1):
            print("\n===== round %d/%d =====" % (i, rounds))
            res = run(max_verify_attempts=3)
            if res.get("t001"):
                ok += 1
                print("=== T001 OK === securityToken: %s" % res["securityToken"][:40])
            else:
                print("=== FAILED (no T001) ===")
            if i < rounds:
                time.sleep(pace)
        print("\nT001 %d/%d = %.1f%%" % (ok, rounds, ok / rounds * 100.0))
        return
    per = -(-rounds // threads)
    workers = []
    for w in range(threads):
        n = min(per, rounds - w * per)
        if n > 0:
            workers.append((w, n))
    pool = []
    for w, n in workers:
        th = threading.Thread(target=_worker, args=(w, n, pace))
        th.start()
        pool.append(th)
    for th in pool:
        th.join()
    total, ok = _STAT["total"], _STAT["ok"]
    print("\n===== 压测完成：%.1fs =====" % (time.time() - t0))
    print("T001 %d/%d = %.1f%%" % (ok, total, (ok / total * 100.0) if total else 0.0))


if __name__ == "__main__":
    main()
