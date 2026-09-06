"""Concurrency-safe cache for extracted Aliyun sg VM programs."""
import atexit
import fcntl
import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.request


HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = os.environ.get('ALIV2_RUNTIME_DIR', os.path.join(HERE, 'runtime'))
CACHE_DIR = os.environ.get('SG_CACHE_DIR', os.path.join(RUNTIME_DIR, 'cache', 'sg'))
INDEX_PATH = os.path.join(CACHE_DIR, 'index.json')
LOCK_PATH = os.path.join(CACHE_DIR, '.lock')
EXTRACTOR = os.path.join(HERE, 'extract_sg_vm.py')
BASE_URL = 'https://g.alicdn.com/captcha-frontend/dynamicJS/'


def _atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.index-', suffix='.tmp', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _load_index():
    try:
        with open(INDEX_PATH, encoding='utf-8') as fh:
            value = json.load(fh)
            return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _cache_name(static_path):
    leaf = static_path.rsplit('/', 1)[-1]
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in leaf)
    return safe + '.vm.js'


def _remove_on_exit(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def resolve_sg_vm(static_path, user_agent):
    """Return an extracted VM path, downloading once per StaticPath.

    SG_CACHE_POLICY=keep (default) persists files, session removes newly
    downloaded files at process exit, and off always creates a temporary VM.
    """
    policy = os.environ.get('SG_CACHE_POLICY', 'keep').lower()
    if policy not in ('keep', 'session', 'off'):
        raise ValueError('SG_CACHE_POLICY must be keep, session, or off')
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(LOCK_PATH, 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        index = _load_index()
        entry = index.get(static_path, {})
        cached = os.path.join(CACHE_DIR, entry.get('file', '')) if entry.get('file') else None
        if policy != 'off' and cached and os.path.isfile(cached):
            if entry.get('sha256') == _digest(cached):
                return cached, True

        fd, raw_path = tempfile.mkstemp(prefix='.sg-raw-', suffix='.js', dir=CACHE_DIR)
        os.close(fd)
        fd, vm_tmp = tempfile.mkstemp(prefix='.sg-vm-', suffix='.js', dir=CACHE_DIR)
        os.close(fd)
        try:
            url = BASE_URL + static_path + '.js'
            request = urllib.request.Request(url, headers={'User-Agent': user_agent})
            with urllib.request.urlopen(request, timeout=15) as response, open(raw_path, 'wb') as out:
                out.write(response.read())
            result = subprocess.run(
                [os.environ.get('PYTHON', os.sys.executable), EXTRACTOR, raw_path, vm_tmp],
                capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError('sg extraction failed: ' + result.stderr[-500:])
            if policy == 'off':
                atexit.register(_remove_on_exit, vm_tmp)
                return vm_tmp, False
            final_path = os.path.join(CACHE_DIR, _cache_name(static_path))
            os.replace(vm_tmp, final_path)
            index[static_path] = {
                'file': os.path.basename(final_path),
                'sha256': _digest(final_path),
                'source_url': url,
                'updated_at_ms': int(time.time() * 1000),
            }
            _atomic_json(INDEX_PATH, index)
            if policy == 'session':
                atexit.register(_remove_on_exit, final_path)
            return final_path, False
        finally:
            for path in (raw_path,):
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
