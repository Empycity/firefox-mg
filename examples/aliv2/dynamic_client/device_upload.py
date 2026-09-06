#!/usr/bin/env python3
"""device.captcha-open Log2/Log3 设备上报（全新 Data 生成）。

配方来源（详见 ../README.md 与 device_upload/README.md）：
- 请求参数（无 Timestamp）: AaduaneId, Version=2020-10-15, SignatureMethod,
  SignatureVersion, Format, Action, Data, SignatureNonce, Signature
- 签名 KEY_SECRET = DuanemHmyeE6LXCC46sJEDUw5DTlSZ（device 组，跨 r2/r5 稳定）
- Data = b64(AES-128-CBC(key=a549a55c60a39aa0, IV=0123456789ABCDEF, 明文))
  （LOG2_KEY 跨会话稳定：r2/r5 实测均可解开）
- Log2 明文 = appKey#W#b64(AES(sk,scene))#W20220202#CLOUD#<GatherCost>#501#b64(seg1#大密文#sub_a#sub_b##sub_ts)
- Log3 明文 = appKey#W#b64(AES(sk,scene))#W20220202#CLOUD#<seq>#b64(511#entry1-504#entry2)
  entry = b64(seg1#b64(AES(sk,内容))#sub_a#sub_b##sub_ts)；entry1=特征位图, entry2=行为 JSON
- 所有内层 AES 均用 session_key（DeviceConfig 解出）；sub_a/sub_b 是常量串的密文
- seg1 = DeviceConfig chunks[2]（服务端代发，形如 appKey-h-ts-uuid32）
- payload 的 sub1 = AES(sk, uuid32 最后 8 hex)；token 对在 deviceToken 与 Log2 间共用
"""
import base64, hashlib, hmac, json, os, random, re, time, urllib.parse, urllib.request, uuid

APP_KEY = 'sh87bd1512hsb03cb405803a307dbe32'
LOG2_KEY = 'a549a55c60a39aa0'
DEV_KEY_ID = 'DuaneAprqkYsF3nt1yjK29Bf'
DEV_KEY_SECRET = 'DuanemHmyeE6LXCC46sJEDUw5DTlSZ'
DEVICE_HOST = 'https://device.captcha-open.aliyuncs.com/'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0'
LOG2_KEY_ID = '111jdk439dJJIjd023823201'   # captcha-pro 组（调用方使用）

HERE = os.path.dirname(os.path.abspath(__file__))
TPL_LOG2 = os.path.join(HERE, 'device_upload', 'log2_plain_r8.txt')
TPL_LOG2_004 = os.path.join(HERE, 'device_upload', 'log2_plain_feilin004.txt')
TPL_BITMAP = os.path.join(HERE, 'device_upload', 'log3_bitmap.txt')
TPL_BEHAVIOR = os.path.join(HERE, 'device_upload', 'log3_behavior.json')


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _enc(aes_cbc, sk: str, s: str) -> str:
    return _b64(aes_cbc(sk, s.encode()))


def build_seg1_parts(seg1: str):
    """DeviceConfig chunks[2] -> (完整seg1, uuid32)。兼容带 WEB# 前缀。"""
    s = seg1.split('WEB#')[-1]
    uuid32 = s.rsplit('-', 1)[-1]
    return s, uuid32


def build_log2_payload(sub1: str, tok1: str, ts1: int, tok2: str, ts2: int,
                       start_ts: int, init_ts=None, device_ip: str = None,
                       config_ts: int = None, feilin_version: str = '',
                       template_payload: str = None,
                       preserve_template_timing: bool = False) -> str:
    """127 字段指纹遥测明文（r8 模板 + 动态字段刷新，与 dt payload 共用 sub1/token/时序）。"""
    path = TPL_LOG2_004 if '/feilin004.' in feilin_version else TPL_LOG2
    # The file terminator must not leak into the final payload field: the
    # native FeiLin004 Log2 plaintext ends with an empty f126 (no newline).
    f = (template_payload.rstrip('\r\n').split('#') if template_payload is not None
         else open(path).read().rstrip('\r\n').split('#'))
    f[21] = sub1                                                  # 与 deviceToken 共用
    if '/feilin004.' in feilin_version:
        with open(TPL_BITMAP, 'rb') as fh:
            f[88] = _b64(fh.read().strip())
    fixed_timing = os.environ.get('FEILIN_TIMING_VECTOR')
    if preserve_template_timing:
        pass
    elif fixed_timing:
        f[43] = '|'.join(fixed_timing.rstrip('|').split('|')[:6])
    elif '/feilin004.' in feilin_version:
        # 004 native T001 samples (2026-09-02 traces 02:09 and 13:16):
        # 20-936|23-3104|30-1|40-130|41-9187|70-9241
        # 20-1588|23-2942|30-0|40-69|41-7979|70-8025
        v41 = random.randint(7500, 9800)
        f[43] = '|'.join((f'20-{random.randint(850, 1700)}',
                          f'23-{random.randint(2900, 3400)}',
                          f'30-{random.randint(0, 1)}',
                          f'40-{random.randint(45, 170)}', f'41-{v41}',
                          f'70-{v41 + random.randint(40, 75)}'))
    else:
        v41 = random.randint(5800, 6200)
        f[43] = '|'.join((f'20-{random.randint(700, 1000)}',
                          f'23-{random.randint(1700, 2100)}', '30-0',
                          f'40-{random.randint(45, 65)}', f'41-{v41}',
                          f'70-{v41 + random.randint(30, 80)}'))
    f[71], f[72], f[73], f[74] = tok1, str(ts1), tok2, str(ts2)   # token 对（与 deviceToken 共用）
    if device_ip: f[42] = device_ip                               # 服务端实测 IP（chunk[8]）
    if '/feilin004.' in feilin_version:
        # 004 keeps the 50-character identifier skeleton and refreshes only
        # its trailing five hex positions (browser trace: offsets 45..49).
        f52 = list(f[52])
        f52[45:50] = [random.choice('0123456789abcdef') for _ in range(5)]
        f[52] = ''.join(f52)
    else:
        # FeiLin003 keeps a stable skeleton and randomizes only offsets 15..19.
        f52 = list(f[52])
        f52[15:20] = [random.choice('0123456789abcdef') for _ in range(5)]
        f[52] = ''.join(f52)
    f[87] = str(config_ts if config_ts is not None else start_ts + random.randint(2, 3))
    return '#'.join(f)


def build_log2_data(aes_cbc, sk: str, scene_id: str, gather_cost: int,
                    seg1: str, payload: str, ts_ms: int) -> str:
    scene = _enc(aes_cbc, sk, f'W.10054#saf-captcha-waf#{scene_id}')
    sub_a, sub_b, sub_ts = (_enc(aes_cbc, sk, 'saf-captcha-waf'),
                            _enc(aes_cbc, sk, 'W.10054'), _enc(aes_cbc, sk, str(ts_ms)))
    inner = f'{seg1}#{_enc(aes_cbc, sk, payload)}#{sub_a}#{sub_b}##{sub_ts}'
    plain = f'{APP_KEY}#W#{scene}#W20220202#CLOUD#{gather_cost}#501#{_b64(inner.encode())}'
    return _b64(aes_cbc(LOG2_KEY, plain.encode()))


def build_log3_data(aes_cbc, sk: str, scene_id: str, seq_cost: int, seg1: str,
                    start_ts: int, ts_ms: int, config_ts: int = None,
                    track_json: str = None, feilin_version: str = '') -> str:
    """entry1=特征位图（静态模板），entry2=行为 JSON（时间整体平移）。"""
    scene = _enc(aes_cbc, sk, f'W.10054#saf-captcha-waf#{scene_id}')
    sub_a, sub_b, sub_ts = (_enc(aes_cbc, sk, 'saf-captcha-waf'),
                            _enc(aes_cbc, sk, 'W.10054'), _enc(aes_cbc, sk, str(ts_ms)))
    def entry(content: str, suffix: str = '') -> str:
        return _b64(f'{seg1}#{_enc(aes_cbc, sk, content)}#{sub_a}#{sub_b}##{sub_ts}'.encode()) + suffix
    behavior = json.loads(open(TPL_BEHAVIOR).read())
    if track_json:
        wrapper = json.loads(track_json)
        track = wrapper['TrackList']
        def points(raw):
            out = []
            for item in raw.split('|'):
                if not item:
                    continue
                x, y, event_ts, *_ = item.split(',')
                out.append({'x': int(x), 'y': int(y), 't': int(event_ts)})
            return out
        behavior = {
            'mousemove': points(track.get('mp', '')),
            'mouseclick': [], 'keyup': [], 'scrollTop': [], 'scrollLeft': [],
            'pointerEvent': [], 'clientType': 'desktop',
            'startTime': int(wrapper['TrackStartTime']),
            'timestamp': str(config_ts if config_ts is not None else start_ts),
        }
        mc = track.get('mc', '').split(',')
        if len(mc) >= 3:
            behavior['pointerEvent'].append({
                'p': 0.5, 'b': 1, 'pt': 1, 'w': 1, 'h': 1,
                'x': int(mc[0]), 'y': int(mc[1]), 'it': True, 't': int(mc[2]),
            })
    timed_events = [event for key in ('mousemove', 'mouseclick', 'keyup',
                                      'scrollTop', 'scrollLeft', 'pointerEvent')
                    for event in behavior.get(key, []) if isinstance(event, dict)
                    and isinstance(event.get('t'), (int, float))]
    if timed_events and not track_json:
        old_min = min(event['t'] for event in timed_events)
        old_max = max(event['t'] for event in timed_events)
        old_span = max(1, old_max - old_min)
        # Native round28 ends its Log3 behavior 613 ms before submission and
        # covers a roughly three-second interaction window. Rebase the static
        # shape into this session instead of leaking the fixture's old times.
        if '/feilin004.' in feilin_version:
            new_max = random.randint(8200, 8600)
            new_span = random.randint(1800, 2300)
        else:
            new_max = max(1000, ts_ms - start_ts - random.randint(450, 700))
            new_span = random.randint(2600, 3200)
        new_min = max(0, new_max - new_span)
        for event in timed_events:
            event['t'] = round(new_min + (event['t'] - old_min) * new_span / old_span)
    if not track_json:
        behavior['startTime'] = start_ts + (random.randint(2200, 2600)
                                             if '/feilin004.' in feilin_version
                                             else random.randint(650, 950))
        behavior['timestamp'] = str(config_ts if config_ts is not None
                                    else start_ts + random.randint(1, 4))
    bitmap = open(TPL_BITMAP).read().strip()
    l1 = f'511#{entry(bitmap, "-504")}#{entry(json.dumps(behavior, separators=(",", ":")))}'
    plain = f'{APP_KEY}#W#{scene}#W20220202#CLOUD#{seq_cost}#{_b64(l1.encode())}'
    return _b64(aes_cbc(LOG2_KEY, plain.encode()))


def post_log(aes_cbc_unused, act: str, data_b64: str, timeout: int = 15) -> str:
    from ali_client import _http_post
    params = {'AaduaneId': DEV_KEY_ID, 'Version': '2020-10-15',
              'SignatureMethod': 'HMAC-SHA1', 'SignatureVersion': '1.0',
              'Format': 'JSON', 'Action': act, 'Data': data_b64,
              'SignatureNonce': str(uuid.uuid4())}
    qs = '&'.join(f'{urllib.parse.quote(k, safe="-_.~")}={urllib.parse.quote(v, safe="-_.~")}'
                  for k, v in sorted(params.items()))
    sts = f'POST&%2F&{urllib.parse.quote(qs, safe="-_.~")}'
    dig = hmac.new((DEV_KEY_SECRET + '&').encode(), sts.encode(), hashlib.sha1).digest()
    params['Signature'] = base64.b64encode(dig).decode()
    body = urllib.parse.urlencode(params).encode()
    headers = {
        'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://we.51job.com', 'Referer': 'https://we.51job.com/'}
    if act == 'Log3':
        headers['Te'] = 'trailers'
    return _http_post(DEVICE_HOST, body, headers)


def _self_check(aes_cbc):
    """字节级回归：本地明文重加密必须匹配已确认的 r2 密文摘要。"""
    IV_H = '30313233343536373839414243444546'
    def enc_raw(key: str, pt: bytes) -> bytes:
        import subprocess
        r = subprocess.run(['openssl', 'enc', '-aes-128-cbc', '-K', key.encode().hex(),
                            '-iv', IV_H], input=pt, capture_output=True)
        return r.stdout
    pt = open(os.path.join(HERE, 'device_upload', 'log2_plain.txt'), 'rb').read()
    cipher_sha256 = hashlib.sha256(enc_raw(LOG2_KEY, pt)).hexdigest()
    expected = '84f970375b0af18f60826d2b6f4e86ff1bbae94c25c9649d1e170bbcdb3f905a'
    same = cipher_sha256 == expected
    print(f'  self-check r2 Log2: {"PASS" if same else "FAIL"}')
    return same


if __name__ == '__main__':
    from ali_client import aes_cbc
    print('device_upload 自检:')
    _self_check(aes_cbc)
    # 结构自检：全新生成 -> 解密回读 -> 字段断言
    sk = 'ec2ff8b6dabc31c3'
    seg1 = f'{APP_KEY}-h-{int(time.time() * 1000)}-{uuid.uuid4().hex}'
    _, u32 = build_seg1_parts(seg1)
    now = int(time.time() * 1000)
    sub1 = 'AA0KAQVkBA0='
    tok1, tok2 = ('A' * 40, 'B' * 42)
    d2 = build_log2_data(aes_cbc, sk, '19x5u7lo', 4003, seg1,
                         build_log2_payload(sub1, tok1, now - 8000, tok2, now,
                                            now - 9000), now)
    pt2 = aes_cbc(LOG2_KEY, base64.b64decode(d2), decrypt=True).decode()
    s2 = pt2.split('#')
    assert s2[0] == APP_KEY and s2[4] == 'CLOUD' and s2[6] == '501', s2[:7]
    inner2 = base64.b64decode(s2[7]).decode().split('#')
    assert inner2[0] == seg1 and len(inner2) == 6 and inner2[4] == ''
    print('  fresh Log2 结构: PASS | Data len =', len(d2))
    d3 = build_log3_data(aes_cbc, sk, '19x5u7lo', 807, seg1, now - 9000, now)
    pt3 = aes_cbc(LOG2_KEY, base64.b64decode(d3), decrypt=True).decode()
    s3 = pt3.split('#')
    l1 = base64.b64decode(s3[6]).decode()
    assert l1.startswith('511#'), l1[:10]
    print('  fresh Log3 结构: PASS | Data len =', len(d3))
