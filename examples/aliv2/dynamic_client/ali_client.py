#!/usr/bin/env python3
"""51job 阿里云验证码 V2 本地动态客户端（T001 闭环）。

已还原的算法（详见 ../README.md）：
- Signature     = Base64(HMAC-SHA1("POST&%2F&" + pct(排序query), KEY_SECRET + "&"))
- DeviceData    = AES-CBC(45f8ac1e1de14397, appKey#W#AES(c175a358550d02e2, 场景串)#W20220202#CLOUD#)
- DeviceConfig  = AES-CBC 解密(87f879f135f27da7) → session_key 等
- deviceToken   = b64("WEB#appKey-h-ts-uuid#AES(session_key,指纹明文)#0#md5(...#0#daye,raolewoba!)")
- 滑块 data/arg = 当轮 StaticPath 对应的 sg JSVMP（Node，`sg_cache.py` 自动下载、提取并缓存）
全部 AES-128-CBC，固定 IV "0123456789ABCDEF"。
"""
import atexit, base64, hashlib, hmac, json, os, random, re, subprocess, sys, time, urllib.request, urllib.parse, uuid
from http.cookiejar import CookieJar

try:
    from curl_cffi import requests as _cffi_req      # 浏览器级 TLS 指纹（推荐: pip install curl_cffi）
    _TLS = 'cffi'
except ImportError:
    _TLS = 'urllib'                                   # 回退: python TLS（可能被风控降分）

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0'
IV = "0123456789ABCDEF"
PAGE_URL = 'https://we.51job.com/api/job/search-pc?api_key=51job'
CAPTCHA_HOST = 'https://93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com/'
CAPTCHA_VERIFY_HOST = 'https://93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com/'
KEY_ID = '111jdk439dJJIjd023823201'
KEY_SECRET = '222aiJodos2938JDdosko2djd82sf0'
APP_KEY = 'sh87bd1512hsb03cb405803a307dbe32'   # feilin/sg 内嵌常量（设备 ID）
AES_MAIN = '45f8ac1e1de14397'                   # DeviceData 外层
AES_SCENE = 'c175a358550d02e2'                  # DeviceData 内层（场景串）
AES_DEVCONF = '87f879f135f27da7'                # DeviceConfig 解密
MD5_SALT = 'daye,raolewoba!'

def aes_cbc(key: str, data: bytes, decrypt=False) -> bytes:
    args = ['openssl', 'enc', '-aes-128-cbc', '-K', key.encode().hex(), '-iv', IV.encode().hex()]
    if decrypt: args.insert(2, '-d')
    r = subprocess.run(args, input=data, capture_output=True)
    if r.returncode != 0: raise RuntimeError(r.stderr.decode())
    return r.stdout

def pct(s: str) -> str:
    return urllib.parse.quote(str(s), safe='-_.~').replace('*', '%2A')

def sign_params(params: dict) -> str:
    qs = '&'.join(f'{pct(k)}={pct(v)}' for k, v in sorted(params.items()))
    sts = f'POST&%2F&{pct(qs)}'
    dig = hmac.new((KEY_SECRET + '&').encode(), sts.encode(), hashlib.sha1).digest()
    return base64.b64encode(dig).decode()

# ---- requests-go 传输层（Firefox 142 TLS/HTTP2 指纹）----
RG_FIREFOX_JA3 = ('771,4865-4867-4866-49195-49199-52393-52392-49196-49200-'
                  '49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-34-18-51-43-13-45-28-27-65037,'
                  '4588-29-23-24-25-256-257,0')
RG_HEADER_ORDER = ['Host', 'User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding',
                   'Content-Type', 'Content-Length', 'Origin', 'Connection', 'Referer',
                   'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'Idempotency-Key', 'Te']
RG_PSEUDO_ORDER = [':method', ':path', ':authority', ':scheme']
RG_FIREFOX_HELLO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                'firefox142_tls_h2_fingerprint.json')
NATIVE_TRANSPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                'firefox_transport', 'firefox-transport')
NSS_TRANSPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'nss_transport', 'nss-tls-probe')
_RG_SESSION = None
_CFFI_SESSION = None
_CFFI_API_SESSION = None
_CHALLENGE_COOKIE = None
_CHALLENGE_NSS_SESSION = None
_NSS_ORIGIN_SESSIONS = {}
_NSS_FALLBACK_TO_CFFI = False

def rg_session():
    """requests-go 会话（Firefox 指纹 + 浏览器实测头序）。环境变量 TRANSPORT=rg 启用。"""
    global _RG_SESSION
    if _RG_SESSION is None:
        import copy
        import requests_go
        from requests_go.tls_config.config import TLS_FIREFOX_145
        # Start with the library's full Firefox/uTLS contract.  A bare
        # TLSConfig carries Chrome-like extension internals and H2 windows.
        cfg = copy.deepcopy(TLS_FIREFOX_145)
        cfg.ja3 = RG_FIREFOX_JA3
        cfg.random_ja3 = False
        cfg.tls_extensions.supported_signature_algorithms = [
            'ecdsa_secp256r1_sha256', 'ecdsa_secp384r1_sha384',
            'ecdsa_secp521r1_sha512', 'rsa_pss_rsae_sha256',
            'rsa_pss_rsae_sha384', 'rsa_pss_rsae_sha512',
            'rsa_pkcs1_sha256', 'rsa_pkcs1_sha384', 'rsa_pkcs1_sha512',
            'rsa_pkcs1_sha1',
        ]
        cfg.tls_extensions.supported_delegated_credentials_algorithms = [
            'ecdsa_secp256r1_sha256', 'ecdsa_secp384r1_sha384',
            'ecdsa_secp521r1_sha512',
        ]
        # requests-go's typed Firefox preset still hard-codes ecdsa_sha1 in
        # delegated_credentials and emits a one-byte-longer ECH GREASE body.
        # Its raw mode parses this record as a uTLS ClientHelloSpec, rewrites
        # SNI for the request URL, and regenerates key shares/ECH material.
        # That preserves the native Firefox 142 extension structure without
        # replaying ephemeral secrets from the captured handshake.
        with open(RG_FIREFOX_HELLO, 'r', encoding='utf-8') as fh:
            handshake = bytes.fromhex(json.load(fh)['client_hello']['client_hello_hex'])
        record = b'\x16\x03\x01' + len(handshake).to_bytes(2, 'big') + handshake
        cfg.tls_extensions.client_hello_hex_stream = record.hex()
        # The preset ACKs the server SETTINGS before request HEADERS. Firefox
        # sends its first HEADERS frame before that ACK; disabling the eager
        # ACK reproduces the observed initial frame order.
        cfg.http2_settings.settings_ack = False
        cfg.headers_order = RG_HEADER_ORDER
        cfg.pseudo_header_order = RG_PSEUDO_ORDER
        cfg.user_agent = UA
        _RG_SESSION = requests_go.Session()
        # requests_go.Session.request() remounts its adapter from this
        # property on every HTTPS request.
        _RG_SESSION.tls_config = cfg
        _RG_SESSION.mount('https://', requests_go.adapters.TLSAdapter(tls_config=cfg))
    return _RG_SESSION

def cffi_session():
    """Persistent Firefox-impersonated session for the challenge/resource/API chain."""
    global _CFFI_SESSION
    if _CFFI_SESSION is None:
        if os.environ.get('CFFI_DEBUG') == '1':
            from curl_cffi import Curl
            _CFFI_SESSION = _cffi_req.Session(curl=Curl(debug=True), impersonate='firefox')
        else:
            _CFFI_SESSION = _cffi_req.Session(impersonate='firefox')
    return _CFFI_SESSION

def cffi_api_session():
    """Captcha API session with no browser-profile HTTP header residue.

    Resource GETs intentionally use the impersonation profile's navigation
    headers.  Reusing that curl handle for XHR POSTs leaves those defaults on
    some curl_cffi versions even when a later request disables them.
    """
    global _CFFI_API_SESSION
    if _CFFI_API_SESSION is None:
        profile = os.environ.get('CFFI_PROFILE', 'firefox')
        kwargs = {'impersonate': profile, 'default_headers': False}
        if os.environ.get('CFFI_DEBUG') == '1':
            from curl_cffi import Curl
            kwargs['curl'] = Curl(debug=True)
        _CFFI_API_SESSION = _cffi_req.Session(**kwargs)
    return _CFFI_API_SESSION

def _proxy_url():
    if 'CLIENT_PROXY' in os.environ:
        p = os.environ['CLIENT_PROXY'].strip()
        if p.lower() in ('', 'none', 'direct', 'off'):
            return None
        return p
    # The standalone NSS path resolves and connects IPv4 itself. Inheriting
    # the desktop proxy changes the Init egress to IPv6 and creates an F001
    # session, so proxy use must be explicit for this transport.
    if os.environ.get('TRANSPORT') == 'nss':
        return None
    import subprocess
    try:
        out = subprocess.run(['scutil', '--proxy'], capture_output=True, text=True, timeout=5).stdout
        if 'HTTPSEnable : 1' in out:
            port = out.split('HTTPSPort :')[1].split()[0]
            return f'http://127.0.0.1:{port}'
    except Exception: pass
    return None

_PROXY = _proxy_url()

def _rg_request(method: str, url: str, data=None, idem: str = None):
    s = rg_session()
    if _PROXY: s.proxies = {'http': _PROXY, 'https': _PROXY}
    h = {'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5',
         'Origin': 'https://we.51job.com', 'Referer': 'https://we.51job.com/',
         'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site'}
    if method == 'GET':
        h['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        r = s.get(url, headers=h, timeout=15)
    else:
        h['Accept'] = '*/*'
        h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
        if idem: h['Idempotency-Key'] = idem            # 浏览器每个 API POST 都带
        r = s.post(url, data=data, headers=h, timeout=15)
    return r

class _NativeResponse:
    def __init__(self, status, headers, body):
        self.status_code = status
        self.headers_list = headers
        self.content = body
        self.text = body.decode('utf-8', 'replace')

    def header(self, name, default=None):
        name = name.lower()
        for key, value in self.headers_list:
            if key.lower() == name:
                return value
        return default

def _native_request(method: str, url: str, headers: dict, data: bytes = None):
    if not os.path.exists(NATIVE_TRANSPORT):
        raise RuntimeError(f'native Firefox transport is not built: {NATIVE_TRANSPORT}')
    client_hello_hex = ''
    if os.path.exists(RG_FIREFOX_HELLO):
        with open(RG_FIREFOX_HELLO, 'r', encoding='utf-8') as fh:
            handshake = bytes.fromhex(json.load(fh)['client_hello']['client_hello_hex'])
        client_hello_hex = (b'\x16\x03\x01' + len(handshake).to_bytes(2, 'big') + handshake).hex()
    payload = {
        'method': method,
        'url': url,
        'headers': [[key, str(value)] for key, value in headers.items() if value is not None],
        'body_base64': base64.b64encode(data or b'').decode(),
        # Empty means use uTLS HelloFirefox_Auto; a captured record remains
        # preferred when the historical fingerprint fixture is available.
        'client_hello_hex': client_hello_hex,
        # The successful Firefox oracle reaches Init over IPv4, while Go's
        # default Happy Eyeballs choice used IPv6 and produced an F001-born
        # session. Keep the address family explicit and overrideable.
        'network': os.environ.get('NATIVE_NETWORK', 'tcp4'),
        'timeout_seconds': 15,
    }
    proc = subprocess.run([NATIVE_TRANSPORT], input=json.dumps(payload).encode(),
                          capture_output=True, timeout=20)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode('utf-8', 'replace')[-500:])
    result = json.loads(proc.stdout)
    if result.get('error'):
        raise RuntimeError(result['error'])
    body = base64.b64decode(result.get('body_base64') or '')
    response_headers = result.get('headers') or []
    encoding = next((value for key, value in response_headers
                     if key.lower() == 'content-encoding'), '').lower()
    if encoding == 'br':
        import brotli
        body = brotli.decompress(body)
    elif encoding == 'gzip':
        import gzip
        body = gzip.decompress(body)
    elif encoding == 'zstd':
        import zstandard
        body = zstandard.ZstdDecompressor().decompress(body)
    return _NativeResponse(result['status'], response_headers, body)

def _h2_frame(frame_type: int, flags: int, stream_id: int, payload: bytes = b'') -> bytes:
    return (len(payload).to_bytes(3, 'big') + bytes((frame_type, flags)) +
            (stream_id & 0x7fffffff).to_bytes(4, 'big') + payload)

def _build_nss_h2_request(method: str, url: str, headers: dict, data: bytes,
                          encoder, stream_id: int, initial: bool) -> bytes:
    from hpack.hpack import encode_integer

    parsed = urllib.parse.urlsplit(url)
    path = parsed.path or '/'
    if parsed.query:
        path += '?' + parsed.query
    body = data or b''
    regular = [(key.lower(), str(value)) for key, value in headers.items()
               if value is not None and key.lower() not in ('host', 'connection', 'te')]
    # Gecko's H2 compressor always appends this at the protocol layer, so it
    # does not appear in BiDi's channel-header snapshot.
    regular.append(('te', 'trailers'))

    # Gecko deliberately emits :path as a literal without indexing, even for
    # "/", where a generic HPACK encoder would use static-table index 4. Keep
    # that policy and then let hpack maintain the normal dynamic table for the
    # remaining fields. This reproduces the retained Firefox HEADERS block
    # byte-for-byte for the local navigation fixture.
    path_huffman = encoder.huffman_coder.encode(path.encode())
    path_length = encode_integer(len(path_huffman), 7)
    path_length[0] |= 0x80
    method_index = {'GET': b'\x82', 'POST': b'\x83'}.get(method.upper())
    if method_index is None:
        raise RuntimeError(f'unsupported NSS H2 method: {method}')
    block = method_index + b'\x04' + bytes(path_length) + path_huffman
    block += encoder.encode([(':authority', parsed.netloc), (':scheme', parsed.scheme),
                             *regular], huffman=True)
    settings = b''.join(setting.to_bytes(2, 'big') + value.to_bytes(4, 'big') for setting, value in (
        (1, 65536), (2, 0), (4, 131072), (5, 16384)))
    wire = b''
    if initial:
        wire = b'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'
        wire += _h2_frame(4, 0, 0, settings)
        wire += _h2_frame(8, 0, 0, (12517377).to_bytes(4, 'big'))
    # nsISupportsPriority: root document=-20 -> raw weight 41; ordinary
    # XHR/fetch=0 -> raw weight 21 (Http2StreamBase::SetPriority).
    priority_weight = 41 if headers.get('Sec-Fetch-Dest') == 'document' else 21
    priority = (0).to_bytes(4, 'big') + bytes((priority_weight,))
    wire += _h2_frame(1, 0x24 | (0x1 if not body else 0), stream_id, priority + block)
    wire += _h2_frame(8, 0, stream_id, (12451840).to_bytes(4, 'big'))
    for offset in range(0, len(body), 16384):
        chunk = body[offset:offset + 16384]
        flags = 0x1 if offset + len(chunk) == len(body) else 0
        wire += _h2_frame(0, flags, stream_id, chunk)
    return wire


def _decode_nss_h2_response(raw: bytes, decoder, target_stream: int):
    status = 0
    response_headers = []
    response_body = bytearray()
    header_block = bytearray()
    offset = 0
    while offset + 9 <= len(raw):
        length = int.from_bytes(raw[offset:offset + 3], 'big')
        frame_type, flags = raw[offset + 3], raw[offset + 4]
        stream_id = int.from_bytes(raw[offset + 5:offset + 9], 'big') & 0x7fffffff
        payload = raw[offset + 9:offset + 9 + length]
        if len(payload) != length:
            raise RuntimeError('truncated NSS HTTP/2 response frame')
        offset += 9 + length
        if stream_id != target_stream:
            continue
        if frame_type in (1, 9):
            if frame_type == 1:
                if flags & 0x8:
                    pad = payload[0]
                    payload = payload[1:len(payload) - pad]
                if flags & 0x20:
                    payload = payload[5:]
            header_block.extend(payload)
            if flags & 0x4:
                for key, value in decoder.decode(bytes(header_block), raw=False):
                    if key == ':status':
                        status = int(value)
                    else:
                        response_headers.append((key, value))
                header_block.clear()
        elif frame_type == 0:
            if flags & 0x8:
                pad = payload[0]
                payload = payload[1:len(payload) - pad]
            response_body.extend(payload)
    if offset != len(raw) or not status:
        raise RuntimeError(f'invalid NSS HTTP/2 response: bytes={len(raw)} status={status}')
    response = _NativeResponse(status, response_headers, bytes(response_body))
    encoding = (response.header('content-encoding', '') or '').lower()
    if encoding == 'br':
        import brotli
        response = _NativeResponse(status, response_headers, brotli.decompress(response.content))
    elif encoding == 'gzip':
        import gzip
        response = _NativeResponse(status, response_headers, gzip.decompress(response.content))
    elif encoding == 'zstd':
        import zstandard
        response = _NativeResponse(status, response_headers,
                                   zstandard.ZstdDecompressor().decompress(response.content))
    return response


def _nss_command(parsed, mode='--h2-stdio'):
    command = [NSS_TRANSPORT, parsed.hostname, str(parsed.port or 443), mode]
    if _PROXY:
        proxy = urllib.parse.urlsplit(_PROXY)
        if proxy.hostname and proxy.port:
            command.extend((proxy.hostname, str(proxy.port)))
    return command


def _read_exact_pipe(pipe, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = pipe.read(length - len(chunks))
        if not chunk:
            raise RuntimeError('NSS session closed while reading framed response')
        chunks.extend(chunk)
    return bytes(chunks)


class _NssH2Session:
    """Persistent NSS/H2 connection used by challenge stream 3 and favicon stream 5."""

    def __init__(self, url: str):
        from hpack import Encoder, Decoder
        if not os.path.exists(NSS_TRANSPORT):
            raise RuntimeError(f'NSS transport is not built: {NSS_TRANSPORT}')
        self.parsed = urllib.parse.urlsplit(url)
        self.encoder = Encoder()
        self.decoder = Decoder()
        self.stream_id = 3
        self.proc = subprocess.Popen(
            _nss_command(self.parsed, '--h2-session'), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def request(self, method: str, url: str, headers: dict, data: bytes = None):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme, parsed.hostname, parsed.port or 443) != (
                self.parsed.scheme, self.parsed.hostname, self.parsed.port or 443):
            raise RuntimeError('NSS H2 session origin mismatch')
        stream_id = self.stream_id
        wire = _build_nss_h2_request(method, url, headers, data or b'', self.encoder,
                                     stream_id, initial=stream_id == 3)
        self.proc.stdin.write(len(wire).to_bytes(4, 'big') + wire)
        self.proc.stdin.flush()
        try:
            response_len = int.from_bytes(_read_exact_pipe(self.proc.stdout, 4), 'big')
        except RuntimeError as exc:
            self.proc.wait(timeout=2)
            stderr = self.proc.stderr.read().decode('utf-8', 'replace').strip()
            raise RuntimeError(f'{exc}; NSS helper exited {self.proc.returncode}: {stderr}') from exc
        raw = _read_exact_pipe(self.proc.stdout, response_len)
        self.stream_id += 2
        if os.environ.get('NSS_DEBUG') == '1':
            print('[nss-session]', parsed.path, 'stream=', stream_id,
                  'wire=', len(wire), 'response=', response_len, file=sys.stderr)
        return _decode_nss_h2_response(raw, self.decoder, stream_id)

    def close(self):
        if self.proc.poll() is not None:
            return
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.terminate()


def _close_challenge_nss_session():
    if _CHALLENGE_NSS_SESSION is not None:
        _CHALLENGE_NSS_SESSION.close()
    for session in _NSS_ORIGIN_SESSIONS.values():
        session.close()


atexit.register(_close_challenge_nss_session)


def _nss_request(method: str, url: str, headers: dict, data: bytes = None):
    """One Firefox-NSS TLS connection with Firefox's observed first H2 stream."""
    if not os.path.exists(NSS_TRANSPORT):
        raise RuntimeError(f'NSS transport is not built: {NSS_TRANSPORT}')
    from hpack import Encoder, Decoder

    parsed = urllib.parse.urlsplit(url)
    encoder = Encoder()
    wire = _build_nss_h2_request(method, url, headers, data or b'', encoder, 3, True)

    child_env = os.environ.copy()
    if url == PAGE_URL and os.environ.get('NSS_KEEP_CHALLENGE_OPEN', '1') != '0':
        child_env['NSS_HOLD_OPEN_MS'] = os.environ.get('NSS_CHALLENGE_HOLD_MS', '20000')
    proc = subprocess.run(_nss_command(parsed), input=wire, capture_output=True, timeout=25,
                          env=child_env)
    if os.environ.get('NSS_DEBUG') == '1':
        body_len = len(data or b'')
        print('[nss]', proc.stderr.decode('utf-8', 'replace').strip(),
              '| h2 writes=', (70, len(wire) - 70 - (body_len + 9), body_len + 9),
              file=sys.stderr)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode('utf-8', 'replace')[-1000:])

    return _decode_nss_h2_response(proc.stdout, Decoder(), 3)

def _selected_transport_request(method: str, url: str, headers: dict, data: bytes = None):
    """NSS is intentionally scoped to the challenge and Init birth requests."""
    global _CHALLENGE_NSS_SESSION, _NSS_FALLBACK_TO_CFFI
    mode = os.environ.get('TRANSPORT')
    if mode == 'nss' and url == PAGE_URL:
        if _CHALLENGE_NSS_SESSION is not None:
            _CHALLENGE_NSS_SESSION.close()
        try:
            _CHALLENGE_NSS_SESSION = _NssH2Session(url)
            return _CHALLENGE_NSS_SESSION.request(method, url, headers, data)
        except RuntimeError as exc:
            if _TLS != 'cffi' or os.environ.get('NSS_AUTO_FALLBACK', '1') == '0':
                raise
            _NSS_FALLBACK_TO_CFFI = True
            _CHALLENGE_NSS_SESSION = None
            print(f'[transport] NSS unavailable on this CDN route; using curl_cffi: {exc}',
                  file=sys.stderr)
            return _cffi_request(method, url, headers, data)
    if mode == 'nss' and url.startswith(CAPTCHA_HOST):
        if _NSS_FALLBACK_TO_CFFI:
            return _cffi_request(method, url, headers, data)
        return _nss_request(method, url, headers, data)
    return _native_request(method, url, headers, data)


def _cffi_request(method: str, url: str, headers: dict, data: bytes = None):
    session = cffi_session() if method == 'GET' else cffi_api_session()
    kwargs = {
        'headers': headers,
        'timeout': 15,
        'default_headers': False,
        'proxies': {'http': _PROXY, 'https': _PROXY} if _PROXY else None,
    }
    if method != 'GET':
        kwargs['data'] = data or b''
    response = session.request(method, url, **kwargs)
    response_headers = list(response.headers.items())
    return _NativeResponse(response.status_code, response_headers, response.content)

def _http_post(host: str, body: bytes, headers: dict) -> dict:
    """传输层：优先 curl_cffi firefox 指纹（HTTP/2 + TLS 指纹），否则回退 urllib。
    r6 http_raw 实测浏览器请求头序：Host,User-Agent,Accept,Accept-Language,
    Accept-Encoding,Content-Type,Content-Length,Origin,Connection,Referer,
    Sec-Fetch-Dest,Sec-Fetch-Mode,Sec-Fetch-Site,Idempotency-Key。

    _NSS_FALLBACK_TO_CFFI 只覆盖挑战页导航：we.51job.com 的 CDN 自 2026-09-02
    起对非浏览器客户端只协商 http/1.1（curl 实测同样如此），而 aliyuncs 四个
    接口域名 NSS 均可协商 h2。Init/UploadLog/Log2/Log3/Verify 必须继续走 NSS，
    否则整条链退化为已知触发 F001 的 curl_cffi 指纹。"""
    transport = os.environ.get('TRANSPORT')
    # In standalone mode the device reports are part of the session's browser
    # fingerprint too. Keep Init, UploadLog, Log2/Log3 and Verify on the same
    # Firefox NSS/H2 implementation; the bridge oracle only proved curl_cffi
    # for the final replay, because Firefox had already emitted its own logs.
    if transport in ('native', 'nss'):
        exact = {
            'User-Agent': headers.get('User-Agent', UA),
            'Accept': headers.get('Accept', '*/*'),
            'Accept-Language': headers.get('Accept-Language', 'en-US,en;q=0.5'),
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Content-Type': headers.get('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8'),
            'Content-Length': str(len(body)),
            'Origin': headers.get('Origin', 'https://we.51job.com'),
            'Connection': 'keep-alive',
            'Referer': headers.get('Referer', 'https://we.51job.com/'),
            'Sec-Fetch-Dest': headers.get('Sec-Fetch-Dest', 'empty'),
            'Sec-Fetch-Mode': headers.get('Sec-Fetch-Mode', 'cors'),
            'Sec-Fetch-Site': headers.get('Sec-Fetch-Site', 'cross-site'),
        }
        if headers.get('Idempotency-Key'):
            exact['Idempotency-Key'] = headers['Idempotency-Key']
        if headers.get('Te'):
            exact['Te'] = headers['Te']
        if transport == 'nss':
            parsed = urllib.parse.urlsplit(host)
            if parsed.hostname == 'device.captcha-open.aliyuncs.com':
                key = (parsed.scheme, parsed.hostname, parsed.port or 443)
                session = _NSS_ORIGIN_SESSIONS.get(key)
                if session is None:
                    session = _NssH2Session(host)
                    _NSS_ORIGIN_SESSIONS[key] = session
                response = session.request('POST', host, exact, body)
            else:
                response = _nss_request('POST', host, exact, body)
        else:
            response = _native_request('POST', host, exact, body)
        return json.loads(response.text)
    if transport == 'rg':
        idem = headers.get('Idempotency-Key')
        return json.loads(_rg_request('POST', host, body, idem=idem).text)
    if _TLS == 'cffi':
        if os.environ.get('CFFI_EXACT_HEADERS', '1') != '0':
            exact = {
                'User-Agent': headers.get('User-Agent', UA),
                'Accept': headers.get('Accept', '*/*'),
                'Accept-Language': headers.get('Accept-Language', 'en-US,en;q=0.5'),
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Content-Type': headers.get('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8'),
                'Content-Length': str(len(body)),
                'Origin': headers.get('Origin', 'https://we.51job.com'),
                'Connection': 'keep-alive',
                'Referer': headers.get('Referer', 'https://we.51job.com/'),
                'Sec-Fetch-Dest': headers.get('Sec-Fetch-Dest', 'empty'),
                'Sec-Fetch-Mode': headers.get('Sec-Fetch-Mode', 'cors'),
                'Sec-Fetch-Site': headers.get('Sec-Fetch-Site', 'cross-site'),
                # Explicit suppression is needed with curl_cffi 0.13 when a
                # Firefox impersonation profile is active.
                'Upgrade-Insecure-Requests': None,
                'Sec-Fetch-User': None,
                'Priority': None,
                'Te': None,
            }
            if headers.get('Idempotency-Key'):
                exact['Idempotency-Key'] = headers['Idempotency-Key']
            headers = exact
        r = cffi_api_session().post(
            host, data=body, headers=headers, timeout=15,
            default_headers=False, accept_encoding='gzip, deflate, br, zstd',
            proxies={'http': _PROXY, 'https': _PROXY} if _PROXY else None)
        return json.loads(r.text)
    req = urllib.request.Request(host, data=body, headers=headers)
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def captcha_post(host: str, params: dict) -> dict:
    supplied = dict(params)
    ordered = {
        'AaduaneId': KEY_ID,
        'SignatureMethod': 'HMAC-SHA1',
        'SignatureVersion': '1.0',
        'Format': 'JSON',
        'Timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if 'Version' in supplied:
        ordered['Version'] = supplied.pop('Version')
    ordered.update(supplied)
    ordered['SignatureNonce'] = str(uuid.uuid4())
    ordered['Signature'] = sign_params(ordered)
    body = urllib.parse.urlencode(ordered).encode()
    headers = {
        'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://we.51job.com', 'Referer': 'https://we.51job.com/',
        'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site'}
    # Firefox injects this after the JS-visible XHR header stage.  BiDi's final
    # request snapshot confirms it is present on the wire. Gecko's retained
    # values are positive signed int64 values, never the high half of uint64.
    if os.environ.get('CAPTCHA_IDEMPOTENCY_KEY', '1') != '0':
        headers['Idempotency-Key'] = f'"{random.getrandbits(63)}"'
    return _http_post(host, body, headers)

def prepare_browser_init(certify_id: str):
    """Reproduce the observed challenge -> SDK resource -> Init timing window."""
    try:
        trace_ms = int(certify_id[8:21])
    except (TypeError, ValueError):
        trace_ms = int(time.time() * 1000)

    def wait_for_offset(minimum_ms, maximum_ms):
        target = random.randint(minimum_ms, maximum_ms)
        remaining = target - (int(time.time() * 1000) - trace_ms)
        if remaining > 0:
            time.sleep(remaining / 1000)

    if os.environ.get('INIT_PRELOAD_PAGE_ASSETS', '0') != '0':
        assets = (
            ('https://img.alicdn.com/imgextra/i1/O1CN01L12MaQ1ZwfYKk7Yrc_!!6000000003259-2-tps-900-594.png',
             {'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Referer': 'https://we.51job.com/', 'Sec-Fetch-Dest': 'image',
              'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site',
              'Priority': 'u=5, i'}),
            ('https://we.51job.com/favicon.ico',
             {'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Referer': PAGE_URL, 'Cookie': f'acw_tc={_CHALLENGE_COOKIE}',
              'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin', 'Priority': 'u=6'}),
        )
        for index, (url, extra_headers) in enumerate(assets):
            if os.environ.get('INIT_BROWSER_DELAY', '0') != '0':
                if index == 0:
                    wait_for_offset(400, 800)
                else:
                    wait_for_offset(2000, 2300)
            headers = {'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5', **extra_headers}
            if os.environ.get('TRANSPORT') == 'nss' and not _NSS_FALLBACK_TO_CFFI:
                parsed = urllib.parse.urlsplit(url)
                if (_CHALLENGE_NSS_SESSION is not None and
                        parsed.hostname == urllib.parse.urlsplit(PAGE_URL).hostname):
                    _CHALLENGE_NSS_SESSION.request('GET', url, headers)
                else:
                    _nss_request('GET', url, headers)
            elif os.environ.get('TRANSPORT') == 'native':
                _native_request('GET', url, headers)
            elif os.environ.get('TRANSPORT') == 'rg':
                rg_session().get(url, headers=headers, timeout=15)
            elif _TLS == 'cffi':
                cffi_session().get(url, headers=headers, timeout=15,
                                   proxies={'http': _PROXY, 'https': _PROXY} if _PROXY else None)

    if os.environ.get('INIT_PRELOAD_JS', '0') != '0':
        if os.environ.get('INIT_BROWSER_DELAY', '0') != '0':
            wait_for_offset(2100, 2400)
        now = time.localtime()
        cache_key = now.tm_year + now.tm_mon + now.tm_mday + now.tm_hour
        url = f'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js?t={cache_key}'
        headers = {
            'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Referer': 'https://we.51job.com/', 'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site',
            'Priority': 'u=2',
        }
        if os.environ.get('TRANSPORT') == 'nss' and not _NSS_FALLBACK_TO_CFFI:
            _nss_request('GET', url, headers)
        elif os.environ.get('TRANSPORT') == 'native':
            _native_request('GET', url, headers)
        elif os.environ.get('TRANSPORT') == 'rg':
            rg_session().get(url, headers=headers, timeout=15)
        elif _TLS == 'cffi':
            cffi_session().get(url, headers=headers, timeout=15,
                               proxies={'http': _PROXY, 'https': _PROXY} if _PROXY else None)

    if os.environ.get('INIT_BROWSER_DELAY', '0') != '0':
        # Successful round25/27 browser sessions send Init about 3.24s/2.86s
        # after the challenge timestamp embedded in certifyId.
        minimum = int(os.environ.get('INIT_DELAY_MIN_MS', '2850'))
        maximum = int(os.environ.get('INIT_DELAY_MAX_MS', '3300'))
        target = random.randint(minimum, maximum)
        remaining = target - (int(time.time() * 1000) - trace_ms)
        if remaining > 0:
            time.sleep(remaining / 1000)

UPLOAD_HOST = 'https://upload.captcha-pro-open.aliyuncs.com/'
PFX = '93bc86fc5f88a01515ccdf7ea6192e9f'

def upload_log(scene_id: str, certify_id: str, init_ts: int, init_rt: int,
               js_ts: int, js_rt: int, server_ip: str) -> dict:
    """UploadLog（feilin 时序日志，明文 JSON）：浏览器流程 Init 后必发，客户端此前缺失。"""
    log = {'sId': scene_id, 'pfx': PFX,
           'mInit': {'t': init_ts + init_rt, 's': True,
                     'msg': 'INIT_SUCCESS', 'rt': init_rt},
           'hst': 'captcha-pro-open.aliyuncs.com', 'cId': certify_id, 'ip': server_ip,
           'js': {'t': js_ts, 's': True, 'msg': 'DYNAMICJS_LOADED', 'rt': js_rt},
           'rt': js_ts - init_ts + random.randint(70, 150)}
    params = {'Action': 'UploadLog', 'Version': '2023-03-05',
              'log': json.dumps(log, separators=(',', ':'))}
    params['AaduaneId'] = KEY_ID
    params['SignatureMethod'] = 'HMAC-SHA1'
    params['SignatureVersion'] = '1.0'
    params['Format'] = 'JSON'
    params['Timestamp'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    params['SignatureNonce'] = str(uuid.uuid4())
    params['Signature'] = sign_params(params)
    body = urllib.parse.urlencode(params).encode()
    idem = str(random.getrandbits(63))
    return _http_post(UPLOAD_HOST, body, {
        'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://we.51job.com', 'Referer': 'https://we.51job.com/',
        'Idempotency-Key': f'"{idem}"',
        'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site'})

def build_device_data(scene_id: str) -> str:
    inner_plain = f'W.10001.c#saf-captcha-waf#{scene_id}#captcha-normal#undefined#cn'
    inner = base64.b64encode(aes_cbc(AES_SCENE, inner_plain.encode())).decode()
    outer_plain = f'{APP_KEY}#W#{inner}#W20220202#CLOUD#'
    return base64.b64encode(aes_cbc(AES_MAIN, outer_plain.encode())).decode()

def fetch_challenge():
    global _CHALLENGE_COOKIE
    cj = CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    if os.environ.get('TRANSPORT') in ('rg', 'native', 'nss'):
        html = ''
        rd = None
        navigation_headers = {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Priority': 'u=0, i',
        }
        for _attempt in range(3):
            if os.environ.get('TRANSPORT') in ('native', 'nss'):
                rr = _selected_transport_request('GET', PAGE_URL, navigation_headers)
            else:
                rr = rg_session().get(PAGE_URL, headers=navigation_headers, timeout=15)
            html = rr.text
            raw_m = re.search(r'<textarea id="renderData"[^>]*>(.*?)</textarea>', html)
            raw = raw_m.group(1) if raw_m else html
            for mm in re.finditer(r'\{[^{}]*"sceneId"[^{}]*\}', raw):
                rd = json.loads(mm.group(0)); break
            if rd: break
            time.sleep(2)
        if os.environ.get('TRANSPORT') in ('native', 'nss'):
            set_cookie = rr.header('set-cookie', '')
            cm = re.search(r'(?:^|;\s*)acw_tc=([^;]+)', set_cookie)
            acw = cm.group(1) if cm else None
        else:
            acw = rg_session().cookies.get('acw_tc')   # 会话级 cookie jar（跨请求累积）
        if not acw and rd:
            import re as _re2
            scm = _re2.search(r'acw_tc=([0-9a-f]{30})', html)
            acw = scm.group(1) if scm else None
        _CHALLENGE_COOKIE = acw
        return rd, acw[:30], html
    if _TLS == 'cffi':
        r = cffi_session().get(PAGE_URL, headers={'User-Agent': UA}, timeout=15,
                               proxies={'http': _PROXY, 'https': _PROXY} if _PROXY else None)
        html = r.text
        acw = r.cookies.get('acw_tc')
        m = re.search(r'<textarea id="renderData"[^>]*>(.*?)</textarea>', html)
        rd = json.loads(re.search(r'\{.*\}', m.group(1)).group(0))
        return rd, acw[:30], html
    resp = op.open(urllib.request.Request(PAGE_URL, headers={'User-Agent': UA}), timeout=15)
    html = resp.read().decode('utf8', 'replace')
    m = re.search(r'<textarea id="renderData"[^>]*>(.*?)</textarea>', html)
    rd = json.loads(re.search(r'\{.*\}', m.group(1)).group(0))
    acw = next(c.value for c in cj if c.name == 'acw_tc')
    return rd, acw[:30], html

if __name__ == '__main__':
    rd, certify_id, html = fetch_challenge()
    print('[1] challenge ok | certifyId:', certify_id, '| scene:', rd['sceneId'])
    prepare_browser_init(certify_id)
    params = {
        'Action': 'InitCaptchaV2', 'Version': '2023-03-05', 'SceneId': rd['sceneId'],
        'Language': 'en', 'Mode': 'embed',
        'UserUserId': rd['userUserId'], 'UserId': rd['userId'],
        'UserCertifyId': certify_id, 'DeviceData': build_device_data(rd['sceneId']),
    }
    resp = captcha_post(CAPTCHA_HOST, params)
    print('[2] InitCaptchaV2:', json.dumps(resp, ensure_ascii=False)[:300])
    json.dump({'renderData': rd, 'certifyId': certify_id, 'init': resp},
              open('/tmp/dyn_state.json', 'w'))
