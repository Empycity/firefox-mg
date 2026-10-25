#!/usr/bin/env python3
"""Map VM-window record origins to js-log call sites; hunt an object id's
constructor. Usage:
  vm_map.py TRACE_DIR [vm_bin_name] [--object jsobj_PID_N] [--around api.js]
"""
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vm_parse import load


def main():
    trace = Path(sys.argv[1])
    args = sys.argv[2:]
    obj_id = None
    if '--object' in args:
        obj_id = args[args.index('--object') + 1]

    bins = sorted(trace.glob('firefox-vm-window-*.bin'))
    if not bins:
        print('no vm bin'); return 1
    win = load(bins[0])
    recs = win['records']

    # ---- js log: call_id -> (fn, script tail, line); object first/last seen
    calls = {}
    obj_first = {}
    obj_roles = collections.Counter()
    js_files = sorted(trace.glob('firefox-js-*.jsonl'))
    if not js_files:
        print('no js log'); return 1
    with js_files[0].open() as f:
        for line in f:
            if '"js.call.enter"' not in line and '"js.call.return"' not in line:
                continue
            d = json.loads(line)
            cid = d.get('call_id')
            if d.get('type') == 'js.call.enter':
                calls[cid] = (str(d.get('function_name')), (d.get('script_url') or '')[-40:],
                              d.get('caller_line'), d.get('caller_column'), d.get('ts_us'))
                data = d.get('data') or {}
                this = (data.get('this') or {}).get('js_object_id')
                if this:
                    obj_first.setdefault(this, ('this', cid, d.get('ts_us')))
                    obj_roles[this + ':this'] += 1
                for role in ('args', 'ret'):
                    v = data.get(role)
                    ids = []
                    if isinstance(v, list):
                        ids = [x.get('js_object_id') for x in v if isinstance(x, dict)]
                    elif isinstance(v, dict):
                        ids = [v.get('js_object_id')]
                    for oid in ids:
                        if oid:
                            obj_first.setdefault(oid, (role, cid, d.get('ts_us')))
                            obj_roles[oid + ':' + role] += 1

    def show(cid):
        cid = cid if isinstance(cid, str) else f'call_{cid}'
        fn, su, ln, col, ts = calls.get(cid, ('?', '?', '?', '?', 0))
        return f"{cid} fn={fn} @{su}:{ln}:{col}"

    # ---- origin mapping for top VM origins
    top = collections.Counter(r['origin'] for r in recs)
    print(f"== top VM origins -> call sites ==")
    for o, n in top.most_common(10):
        print(f"{n:6d} {show(o)}")

    # ---- object hunt
    if obj_id:
        first = obj_first.get(obj_id)
        print(f"\n== object {obj_id} first seen: {first} ==")
        if first:
            cid = first[1]
            fn, su, ln, col, ts = calls.get(cid, ('?',)*5)
            print(f"  created/first at {show(cid)}")
            # parent chain
            cur = cid
            parents = {}
            # need enter rows: rebuild parent map quickly from calls in file? skip;
            # role counts
            print(f"  roles: this={obj_roles.get(obj_id+':this',0)} args={obj_roles.get(obj_id+':args',0)} ret={obj_roles.get(obj_id+':ret',0)}")
    else:
        # default: most-used this objects overall
        this_objs = collections.Counter()
        for k, n in obj_roles.items():
            oid, role = k.rsplit(':', 1)
            if role == 'this':
                this_objs[oid] += n
        print("\n== objects most used as this ==")
        for oid, n in this_objs.most_common(8):
            first = obj_first.get(oid)
            print(f"{n:6d} {oid} first={first and (first[0], show(first[1]))}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
