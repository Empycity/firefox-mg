#!/usr/bin/env python3
"""feilin009 v78d98s 真实 32 位 rand 探针矩阵.

输入 = DeviceConfig.sessionId 尾部 32 hex（伪造重加密），
输出 = rawResult.v78d98s (b64 -> 8 字节)。
阶段 1: 固定 rand[:24]='a'*24, 扫 rand[24:32] 每位 16 hex -> 128 runs
阶段 2: 固定 rand[24:32]='a'*8,   扫 rand[0:24]  每位 16 hex -> 384 runs
结果落盘 v78_009_real32_matrix.json
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

from Crypto.Cipher import AES

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = b'87f879f135f27da7'
IV = b'0123456789ABCDEF'
FEILIN009 = '1.5.1/feilin009.c2e94bf647e1302e42d332d77bc5d6f1e5970d4e79cdd6496b0218667d88bbd2'

_init = json.load(open(os.path.join(HERE, 'init_input.json')))
_d = AES.new(KEY, AES.MODE_CBC, IV)
_plain = _d.decrypt(base64.b64decode(_init['DeviceConfig'])).decode().rstrip('\x00')
_CHUNKS = _plain.split('#')
_CHUNKS[3] = FEILIN009
_TS = _CHUNKS[7]
_SID_PREFIX = _CHUNKS[2].replace('WEB#', '').rsplit('-', 1)[0]


def make_device_config(rand32):
    ch = list(_CHUNKS)
    ch[2] = _SID_PREFIX + '-' + rand32
    p = '#'.join(ch).encode()
    pad = 16 - len(p) % 16
    enc = AES.new(KEY, AES.MODE_CBC, IV).encrypt(p + bytes([pad]) * pad)
    return base64.b64encode(enc).decode()


def probe(rand32):
    cfg = make_device_config(rand32)
    fd, path = tempfile.mkstemp(suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump({'DeviceConfig': cfg, 'CertifyId': _init['CertifyId']}, f)
    try:
        out = subprocess.run(
            ['node', os.path.join(HERE, 'run_feilin.js'), path],
            capture_output=True, text=True, cwd=HERE, timeout=60)
    finally:
        os.unlink(path)
    m = re.search(r'__FEILIN_RESULT__(\{.*)', out.stdout, re.S)
    if not m:
        raise RuntimeError('no result; stderr=%s' % out.stderr[:400])
    raw = json.loads(m.group(1))['rawResult']
    v78 = base64.b64decode(raw['v78d98s'])
    return {
        'rand': rand32,
        'v78_bytes': list(v78),
        'v78_b64': raw['v78d98s'],
        'gdfhvcb6': raw.get('gdfhvcb6'),
    }


def main():
    jobs = []
    # 阶段 1: 扫尾 8
    for pos in range(24, 32):
        for c in '0123456789abcdef':
            r = list('a' * 32)
            r[pos] = c
            jobs.append(''.join(r))
    # 阶段 2: 扫前 24
    for pos in range(0, 24):
        for c in '0123456789abcdef':
            r = list('a' * 32)
            r[pos] = c
            jobs.append(''.join(r))
    jobs.append('a' * 32)  # baseline
    jobs = list(dict.fromkeys(jobs))

    results = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(probe, r): r for r in jobs}
        done = 0
        for fut, r in futs.items():
            pass
        for fut in list(futs):
            pass
        for fut, r in futs.items():
            results[r] = fut.result()
            done += 1
            if done % 64 == 0:
                print('  %d/%d' % (done, len(jobs)), file=sys.stderr)

    baseline = results['a' * 32]
    out_path = os.path.join(HERE, 'v78_009_real32_matrix.json')
    json.dump({'baseline': baseline, 'probes': results}, open(out_path, 'w'), indent=1)
    print('baseline v78:', baseline['v78_bytes'], baseline['v78_b64'])

    # 分析: 每个输入位影响哪些输出字节
    base_b = baseline['v78_bytes']
    print('\n== input pos -> changed output bytes ==')
    for pos in range(32):
        changed = set()
        for c in '0123456789abcdef':
            r = list('a' * 32)
            r[pos] = c
            key = ''.join(r)
            if key in results:
                b = results[key]['v78_bytes']
                for j in range(8):
                    if b[j] != base_b[j]:
                        changed.add(j)
        print('pos %2d: %s' % (pos, sorted(changed) if changed else 'none'))


if __name__ == '__main__':
    main()
