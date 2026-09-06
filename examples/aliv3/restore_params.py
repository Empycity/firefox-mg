#!/usr/bin/env python3
# aliv3 (51xf.cn 阿里云验证码 FeiLin 1.5.1 / pe.05x) 参数复现脚本
# 所有算法均经 round2 固定向量逐字节验证 (traces/round2)
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
import base64, hashlib, hmac, urllib.parse, uuid, datetime

IV = b'0123456789ABCDEF'                    # 所有 AES-CBC 共用固定 IV
MASTER = b'FqJB6iRNVYdEGpwb'                # 内嵌母密钥 (gr() 解密用)

# ---- gr(): 母密钥解密内嵌密文 → 派生所有 key/常量 ----
def gr(ct_b64: str) -> bytes:
    raw = base64.b64decode(ct_b64 + '==')
    n = len(raw) // 16 * 16
    return AES.new(MASTER, AES.MODE_CBC, IV).decrypt(raw[:n])

# gr 解出的常量 (round2 实测):
#   45f8ac1e1de14397                 DeviceData 外层 AES key
#   c175a358550d02e2                 DeviceData 内层配置 AES key
#   222aiJodos2938JDdosko2djd82sf0   captcha-open HMAC-SHA1 secret
#   DuanemHmyeE6LXCC46sJEDUw5DTlSZ   cloudauth   HMAC-SHA1 secret
#   111jdk439dJJIjd023823201         AaduaneId (captcha-open)
#   DuaneAprqkYsF3nt1yjK29Bf         AaduaneId (cloudauth)
#   87f879f135f27da7                 DeviceConfig(服务端下发) 解密 key
#   c752c71963b42578                 deviceToken part2 AES key (来自 DeviceConfig 解密结果 b64)
#   a549a55c60a39aa0                 Log2 Data AES key

APP_KEY = 'ab034ec0643f91399eb33e062dc7fae1'   # 固定"设备指纹"ID = 宿主初始化传入的 appKey, 非运行时生成

def aes_cbc_b64(key: bytes, plaintext: bytes) -> str:
    return base64.b64encode(AES.new(key, AES.MODE_CBC, IV).encrypt(pad(plaintext, 16))).decode()

# ---- Signature: HMAC-SHA1 POST&%2F&<pct(canonical)>, key = secret + '&' ----
def pct(s): return urllib.parse.quote(s, safe='-_.~')

def signature(body: str, secret: str) -> str:
    d = dict(urllib.parse.parse_qsl(body, keep_blank_values=True))
    d.pop('Signature', None)
    canon = '&'.join(f'{pct(k)}={pct(v)}' for k, v in sorted(d.items()))
    sts = f'POST&{pct("/")}&{pct(canon)}'
    return base64.b64encode(hmac.new((secret + '&').encode(), sts.encode(), hashlib.sha1).digest()).decode()

# ---- SignatureNonce: 32 次 Math.random, 每位 floor(r*16), 第16位补丁 n&3|8 ----
def signature_nonce(randoms) -> str:
    hexs = [f'{int(r * 16) % 16:x}' for r in randoms]
    hexs[16] = f'{(int(hexs[16], 16) & 3) | 8:x}'
    s = ''.join(hexs)
    return f'{s[:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:]}'

def timestamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

# ---- DeviceData: appKey#W#b64(AES(c175..., 配置行))#W20220202#CLOUD# ----
def device_data(config_line: str) -> str:
    inner = aes_cbc_b64(b'c175a358550d02e2', config_line.encode())
    pt = f'{APP_KEY}#W#{inner}#W20220202#CLOUD#'
    return aes_cbc_b64(b'45f8ac1e1de14397', pt.encode())
# round2 实测 config_line = 'W.10001.c#saf-captcha#1bn1l0rb#captcha-normal#1oa2ns#cn'

# ---- deviceToken ----
# 明文板: W.10054#####MacIntel#Firefox#142.0#...#saf-captcha#0###OeXRKvGg...#<ts>#ZYmsiNGj...#<ts>#desktop#false##9d4568c0...#...|81-3748|93-6714|94-6882(实时耗时段)
# part2 = aes_cbc_b64(b'c752c71963b42578', 板子明文)   # 640B, PKCS7=\r*13
# raw   = f'WEB#{APP_KEY}-h-<init_ts_ms>-<rand32hex>#{part2}#3156'
# final = raw + '#' + md5(raw + '#daye,raolewoba!')    # 固定盐 'daye,raolewoba!'
# deviceToken = base64(final)

def device_token_checksum(raw: str) -> str:
    return hashlib.md5((raw + '#daye,raolewoba!').encode()).hexdigest()

# ---- Log2 Data: AES(a549a55c60a39aa0) over appKey#W#<inner32B b64>#W20220202#CLOUD#3156#501#b64(token-raw) ----
def log2_data(inner32_b64: str, token_raw: str) -> str:
    pt = f'{APP_KEY}#W#{inner32_b64}#W20220202#CLOUD#3156#501#{base64.b64encode(token_raw.encode()).decode()}'
    return aes_cbc_b64(b'a549a55c60a39aa0', pt.encode())

# ---- captchaVerifyCallback data 字段: pe.059 自实现加密(无标准 CryptoJS 调用) ----
# 未还原 — 需要 VM/opcode 级 trace 或 pe.059 静态逆向
