"""Record FeiLin versions announced by Init without changing the algorithm path."""
import fcntl, json, os, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = os.environ.get('ALIV2_RUNTIME_DIR', os.path.join(HERE, 'runtime'))
DIR = os.path.join(RUNTIME_DIR, 'cache', 'feilin')
INDEX = os.path.join(DIR, 'index.json')

def record(path):
    os.makedirs(DIR, exist_ok=True)
    with open(INDEX + '.lock', 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(INDEX, encoding='utf-8') as fh:
                versions = json.load(fh)
        except (OSError, ValueError):
            versions = {}
        is_new = path not in versions
        item = versions.setdefault(path, {'first_seen_ms': int(time.time() * 1000), 'seen': 0})
        item['seen'] += 1
        item['last_seen_ms'] = int(time.time() * 1000)
        fd, tmp = tempfile.mkstemp(prefix='.feilin-index-', dir=DIR)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(versions, fh, ensure_ascii=False, indent=2, sort_keys=True)
                fh.write('\n')
            os.replace(tmp, INDEX)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
    return is_new
