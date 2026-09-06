#!/usr/bin/env python3
"""51job 验证码 T001 闭环动态客户端：真实 HTTP 全流程。"""
import os, sys

# This checkout has requests-go in the project's established reverse-engineering
# environment.  Direct execution should use the same transport automatically.
_PYTHON_PROJECT = '/opt/miniconda3/envs/pythonProject/bin/python'
if os.environ.get('_ALIV2_PYTHON_BOOTSTRAPPED') != '1' and os.path.exists(_PYTHON_PROJECT):
    try:
        import requests_go  # noqa: F401
    except ImportError:
        env = dict(os.environ, _ALIV2_PYTHON_BOOTSTRAPPED='1')
        os.execve(_PYTHON_PROJECT, [_PYTHON_PROJECT, os.path.abspath(__file__), *sys.argv[1:]], env)

os.environ.setdefault('TRANSPORT', 'nss')

import base64, hashlib, hmac, json, random, re, string, subprocess, time, urllib.request, urllib.parse, uuid, zlib
from http.cookiejar import CookieJar
from ali_client import (UA, IV, PAGE_URL, CAPTCHA_HOST, CAPTCHA_VERIFY_HOST,
                        KEY_ID, KEY_SECRET, APP_KEY, AES_MAIN, AES_SCENE, AES_DEVCONF,
                        MD5_SALT, aes_cbc, pct, sign_params, captcha_post,
                        build_device_data, fetch_challenge, upload_log,
                        prepare_browser_init)
HERE = os.path.dirname(os.path.abspath(__file__))

DEBUG_DIR = os.environ.get('ALIV2_DEBUG_DIR')

def debug_write(name, data):
    """Persist one run's protocol artifacts when ALIV2_DEBUG_DIR is set."""
    if not DEBUG_DIR:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    mode = 'wb' if isinstance(data, bytes) else 'w'
    kwargs = {} if mode == 'wb' else {'encoding': 'utf-8'}
    with open(os.path.join(DEBUG_DIR, name), mode, **kwargs) as fh:
        fh.write(data)

def vm_call(bc, harness, args):
    """调 sg JSVMP（Node 子进程）。bc: 'R1'(加密) / 'R2'(轨迹打包)。"""
    script = (
        'eval(require("fs").readFileSync("%s","utf8"));'
        'const args=%s;'
        'const out=D(0,[],globalThis[%r],globalThis[%r],{r:1},args);'
        'process.stdout.write(String(out));'
    ) % (harness, json.dumps(args), bc, 'F1' if bc == 'R1' else 'F2')
    r = subprocess.run(['node', '-e', script], capture_output=True, timeout=30)
    open('/tmp/vm_debug.log','a').write(f'\n=== {bc} args={json.dumps(args)[:120]}\nscript={script[:200]}\nout_len={len(r.stdout)} out={r.stdout[:60]}\n')
    if r.returncode != 0: raise RuntimeError(r.stderr.decode()[:300])
    return r.stdout.decode()

def build_device_token(session_key, seg1, payload, gather=None):
    # field[3] = GatherCost（feilin 采集耗时；须与 Log2 seg5 一致）
    from runtime_support import resolve_gather_cost
    gather = str(resolve_gather_cost(gather))
    cipher_b64 = base64.b64encode(aes_cbc(session_key, payload)).decode()
    core = f"WEB#{seg1}#{cipher_b64}#{gather}"
    md5hex = hashlib.md5((core + "#" + MD5_SALT).encode()).hexdigest()
    return base64.b64encode(f"{core}#{md5hex}".encode()).decode()


def run_feilin_runtime(init_response, certify_id):
    """Run the real current FeiLin script in the isolated Node shim."""
    runner = os.path.join(os.path.dirname(HERE), 'feilin_runtime', 'run_feilin005.js')
    request = dict(init_response)
    request['CertifyId'] = certify_id
    r = subprocess.run(['node', runner, '-'], input=json.dumps(request),
                       capture_output=True, text=True, timeout=45)
    if r.returncode != 0:
        raise RuntimeError('FeiLin runtime failed: ' + (r.stderr or r.stdout)[-500:])
    for line in r.stdout.splitlines():
        if line.startswith('__FEILIN_RESULT__'):
            return json.loads(line[len('__FEILIN_RESULT__'):])
    raise RuntimeError('FeiLin runtime returned no result')

def build_track_json(rd, certify_id, init_ts=None, verify_ts=None):
    """track.py 全新生成 + r9 真样本时间线对齐：
    - TrackStartTime ≈ 页面加载（init_ts 前 0~1.5s），VerifyTime ≈ 提交时刻
    - 轨迹内部时间由 initialIdle 撑满整个会话时长（浏览器实测 17~28s）
    - startTime 为数字；si 第 8 位 = 125（6pm feilin002 实测 rAF 指标）
    - 前缀(R2) 浏览器端含 16 次 Math.random，服务端不可重算，无需对齐"""
    import sys as _sys
    _sys.path.insert(0, HERE)
    from track import generate_track_list
    rand16 = lambda: "".join(random.choice(string.digits + string.ascii_lowercase) for _ in range(16))
    arg = vm_call('R1', vm_file, [certify_id, rand16()])
    now = verify_ts or int(time.time() * 1000)
    SI = '1280,1728,891,1280,891,975,1117,125,1280'
    if os.environ.get('FEILIN_VERSION', '').find('/feilin004.') >= 0:
        # FeiLin004 records the collector start marker after Init, not at the
        # page-navigation timestamp used by the older 003 profile.
        track_start = (init_ts or now) + random.randint(2200, 2600)
    else:
        track_start = (init_ts or now - 25000) - random.randint(0, 1500)
    target_span = now - track_start                       # 浏览器实测 17~28s
    # 按 r9 真实 T001 校准：密集接近段(55-80 点/1.0-1.6s) + 拖动(22-30 点/550-900ms)
    approach_points = random.randint(55, 80)
    approach_dur = random.randint(1000, 1600)
    drag_dur = random.randint(550, 900)
    track, _ = generate_track_list({'startTime': 0, 'si': SI,
                                    'approachPoints': approach_points,
                                    'approachDuration': approach_dur,
                                    'dragPointCount': random.randint(22, 30),
                                    'dragDuration': drag_dur,
                                    'initialIdle': max(1000, target_span - approach_dur - drag_dur - 250)})
    elapsed = track['mm'].split('|')[-1].split(',')[2] if False else None
    import re as _re
    last_t = max(int(p.split(',')[2]) for p in track['mp'].split('|') if p)
    track['startTime'] = track_start                      # 数字（r9 实测非字符串）
    wrapper = {'TrackList': track, 'TrackStartTime': track_start,
               'VerifyTime': track_start + last_t + random.randint(100, 400), 'arg': arg}
    return json.dumps(wrapper, separators=(',', ':')), arg
if __name__ == '__main__':
    # [1-2] 挑战页 + InitCaptchaV2
    rd, certify_id, html = fetch_challenge()
    print('[1] certifyId:', certify_id)
    prepare_browser_init(certify_id)
    init_ts = int(time.time() * 1000)
    init = captcha_post(CAPTCHA_HOST, {
        'Action': 'InitCaptchaV2', 'Version': '2023-03-05', 'SceneId': rd['sceneId'],
        'Language': 'en', 'Mode': 'embed',
        'UserUserId': rd['userUserId'], 'UserId': rd['userId'],
        'UserCertifyId': certify_id, 'DeviceData': build_device_data(rd['sceneId'])})
    assert init.get('Success'), init
    init_rt = int(time.time() * 1000) - init_ts
    # Current FeiLin003 cadence from the latest two T001 browser oracles.
    # The protocol accepts immediate sequential submission; delays remain
    # opt-in for reproducing a browser timing vector.
    verify_at_ms = int(os.environ.get('VERIFY_AT_MS', '0'))
    print('[2] Init ok | StaticPath:', init['StaticPath'], '| rt:', init_rt)

    # [3] DeviceConfig 解密
    dec = aes_cbc(AES_DEVCONF, base64.b64decode(init['DeviceConfig']), decrypt=True).decode()
    chunks = dec.split('#')
    session_key = base64.b64decode(chunks[0]).decode()
    seg1 = chunks[2]
    config_ts = int(chunks[7])
    server_ip = chunks[8] if len(chunks) > 8 and chunks[8] else None   # 服务端实测 IP（f[42] 来源）
    feilin_path = chunks[3] if len(chunks) > 3 else ''
    os.environ['FEILIN_VERSION'] = feilin_path
    print('[3] session_key:', session_key, '| seg1:', seg1[:50],
          '| config_ts:', config_ts, '| server_ip:', server_ip)
    if feilin_path:
        from feilin_version import record
        print('[feilin] NEW VERSION:' if record(feilin_path) else '[feilin] known:', feilin_path)

    if '/feilin004.' in feilin_path:
        # Payload timestamps model the collector state; transport submission
        # stays immediate unless a retained browser timing vector is requested.
        upload_at_ms = int(os.environ.get('UPLOAD_AT_MS', '0'))
        log2_at_ms = int(os.environ.get('LOG2_AT_MS', '0'))
        log3_at_ms = int(os.environ.get('LOG3_AT_MS', '0'))
        verify_at_ms = int(os.environ.get('VERIFY_AT_MS', '0'))

    # [4] 按 StaticPath 复用或生成 sg VM 缓存
    sp = init['StaticPath']
    from sg_cache import resolve_sg_vm
    vm_file, cache_hit = resolve_sg_vm(sp, UA)
    print('[4] sg VM ready:', os.path.basename(vm_file), '| cache:', 'hit' if cache_hit else 'miss')
    # [4.5] UploadLog（feilin 时序日志，浏览器 Init 后必发）
    upload_at_ms = int(os.environ.get('UPLOAD_AT_MS', '0'))
    log2_at_ms = int(os.environ.get('LOG2_AT_MS', '0'))
    log3_at_ms = int(os.environ.get('LOG3_AT_MS', '0'))
    if upload_at_ms:
        time.sleep(max(0, (init_ts + upload_at_ms - int(time.time() * 1000)) / 1000))
    try:
        if os.environ.get('SKIP_DEVICE_LOGS') == '1':
            print('[4.5] UploadLog: skipped')
        else:
            js_ts = int(time.time() * 1000) - random.randint(20, 80)
            js_rt = max(0, js_ts - (init_ts + init_rt))
            ul = upload_log(rd['sceneId'], certify_id, init_ts, init_rt, js_ts,
                            js_rt, server_ip)
            print('[4.5] UploadLog:', str(ul)[:70])
    except Exception as e:
        print('[4.5] UploadLog error:', str(e)[:100])

    # [5] deviceToken：默认由真实 FeiLin + Node 补环境动态产出。
    from runtime_support import resolve_gather_cost
    start_ts = int(seg1.rsplit('-', 2)[-2])
    runtime_result = run_feilin_runtime(init, certify_id)
    payload = runtime_result['zhiw'].encode('latin1')
    fields = payload.decode('latin1').split('#')
    if len(fields) != 127:
        raise RuntimeError(f'FeiLin payload field count={len(fields)}, expected 127')
    dt_sub1 = fields[21]
    tokens = (fields[71], fields[73])
    token1_ts = int(fields[72])
    device_token2_ts = int(fields[74])
    gather = resolve_gather_cost(runtime_result.get('gatherCost'))
    log2_sub1 = dt_sub1
    print('[5] FeiLin runtime: 127 fields | GatherCost:', gather)

    # [6] 轨迹 → pack → data
    replay = os.environ.get('TRACK_REPLAY')
    if replay:
        # 真迹重放：r9 通过 TrackList，仅平移时间字段 + 重新生成 arg（隔离轨迹内容变量）
        import base64 as _b, zlib as _z
        raw = open(replay).read().strip()
        if raw[:2] == 'eJ':
            raw = _z.decompress(_b.b64decode(raw))[32:].decode()
        old_start = re.search(r'"startTime":(\d+)', raw).group(1)
        old_span = int(re.search(r'"VerifyTime":(\d+)', raw).group(1)) - int(old_start)
        track_start = (init_ts + random.randint(2200, 2600)
                       if '/feilin004.' in feilin_path
                       else init_ts - random.randint(0, 1500))
        raw = raw.replace(f'"startTime":{old_start}', f'"startTime":{track_start}')
        raw = raw.replace(f'"TrackStartTime":{old_start}', f'"TrackStartTime":{track_start}')
        raw = raw.replace(f'"VerifyTime":{int(old_start) + old_span}',
                          f'"VerifyTime":{track_start + old_span}')
        _, arg = build_track_json(rd, certify_id, init_ts,
                                  init_ts + verify_at_ms)
        old_arg = re.search(r'"arg":"([^"]+)"', raw).group(1)
        track_json = raw.replace(old_arg, arg)
        print('[6] TRACK_REPLAY 模式：真迹时间平移 + 新 arg')
    else:
        track_json, arg = build_track_json(rd, certify_id, init_ts,
                                           init_ts + verify_at_ms)
    debug_write('track.json', track_json)
    prefix = vm_call('R2', vm_file, [track_json, '0000'])
    blob = base64.b64encode(zlib.compress(prefix.encode() + track_json.encode())).decode()
    data = vm_call('R1', vm_file, [blob, '3e627e1b4c63f913'])  # sg 系列常量（r4/r5 实测一致，非随机）
    debug_write('track-prefix.txt', prefix)
    debug_write('track-blob.txt', blob)
    debug_write('verify-data.txt', data)
    print('[6] arg:', arg[:20], '| prefix:', prefix[:16], '| data len:', len(data))

    # [6.5] 设备上报 Log2/Log3（全新生成：Init 后、Verify 前，与浏览器时序一致）
    from device_upload import build_log2_data, build_log3_data, build_log2_payload, post_log
    _tok1, _tok2 = tokens
    # FeiLin004 reuses the complete token pair, including both timestamps, in
    # Log2 and DeviceToken. Keep f74 after f72 even when requests are submitted
    # immediately; these are collector timestamps, not transport wall time.
    if '/feilin004.' in feilin_path:
        # 004 stamps the shared second token at two collector milestones
        # (native samples: Log2 f74 at start+10099..11518, DeviceToken f74 at
        # start+11483..15082). Token bytes are shared, timestamps are not.
        log2_token2_ts = start_ts + random.randint(9900, 12300)
        device_token2_ts = start_ts + random.randint(11200, 15600)
    else:
        log2_token2_ts = max(token1_ts + 1000,
                            init_ts + log2_at_ms - random.randint(100, 250))
        device_token2_ts = log2_token2_ts
    log2_token2_ts = device_token2_ts
    log2_payload = build_log2_payload(log2_sub1, _tok1, token1_ts,
                                      _tok2, log2_token2_ts,
                                      start_ts, init_ts, device_ip=server_ip,
                                      config_ts=config_ts,
                                      feilin_version=feilin_path,
                                      template_payload=(runtime_result or {}).get('zhiw'),
                                      preserve_template_timing=runtime_result is not None)
    log2_timing_prefix = log2_payload.split('#')[43]
    if log2_at_ms:
        time.sleep(max(0, (init_ts + log2_at_ms - int(time.time() * 1000)) / 1000))
    now = int(time.time() * 1000)
    d2 = build_log2_data(aes_cbc, session_key, rd['sceneId'], gather, seg1, log2_payload, now)
    debug_write('log2-payload.txt', log2_payload)
    debug_write('log2-data.txt', d2)
    print('[6.5] Log2 Data len:', len(d2))
    try:
        if os.environ.get('SKIP_DEVICE_LOGS') == '1':
            print('[6.5] device Log2: skipped')
        else:
            print('[6.5] device Log2:', str(post_log(aes_cbc, 'Log2', d2))[:90])
    except Exception as e:
        print('[6.5] device Log2 error:', str(e)[:100])
    if log3_at_ms:
        time.sleep(max(0, (init_ts + log3_at_ms - int(time.time() * 1000)) / 1000))
    now = int(time.time() * 1000)
    seq_cost = random.randint(300, 600)
    d3 = build_log3_data(aes_cbc, session_key, rd['sceneId'],
                         seq_cost, seg1, start_ts, now,
                         config_ts=config_ts, feilin_version=feilin_path)
    debug_write('log3-data.txt', d3)
    print('[6.5] Log3 Data len:', len(d3))
    try:
        if os.environ.get('SKIP_DEVICE_LOGS') == '1':
            print('[6.5] device Log3: skipped')
        else:
            print('[6.5] device Log3:', str(post_log(aes_cbc, 'Log3', d3))[:90])
    except Exception as e:
        print('[6.5] device Log3 error:', str(e)[:100])

    # [7] VerifyCaptchaV2：当前 FeiLin003 首轮为 Init 后约 12.5s，紧跟 Log3。
    if verify_at_ms:
        time.sleep(max(0, (init_ts + verify_at_ms
                           - int(time.time() * 1000)) / 1000))
    device_token = build_device_token(session_key, seg1, payload, gather)
    debug_write('device-payload.txt', payload)
    debug_write('device-token.txt', device_token)
    print('[7] deviceToken len:', len(device_token), '| f21:', dt_sub1)
    cvp = json.dumps({'sceneId': rd['sceneId'], 'certifyId': certify_id,
                      'deviceToken': device_token, 'data': data}, separators=(',', ':'))
    debug_write('captcha-verify-param.json', cvp)
    resp = captcha_post(CAPTCHA_VERIFY_HOST, {
        'Action': 'VerifyCaptchaV2', 'Version': '2023-03-05', 'SceneId': rd['sceneId'],
        'CertifyId': certify_id, 'CaptchaVerifyParam': cvp, 'UserUserId': rd['userUserId']})
    result = resp.get('Result') or {}
    print('[7] VerifyCaptchaV2:', json.dumps(resp, ensure_ascii=False)[:300])
    print('==== VerifyCode:', result.get('VerifyCode'), '| VerifyResult:', result.get('VerifyResult'))
