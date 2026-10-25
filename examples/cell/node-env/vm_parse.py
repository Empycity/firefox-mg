#!/usr/bin/env python3
"""Parse a Firefox Trace VM window binary artifact (80-byte records)."""
import collections
import struct
import sys
from pathlib import Path

HDR = struct.Struct('<8sIIQQQQIIQ')
REC = struct.Struct('<QQQQQQIII B16sBBB')
assert REC.size == 80, REC.size
assert HDR.size == 64, HDR.size


def load(path):
    data = Path(path).read_bytes()
    magic, ver, rec_size, first_seq, last_seq, total, overw, cap, count, trig_ts = HDR.unpack_from(data, 0)
    recs = []
    off = HDR.size
    for i in range(count):
        if off + REC.size > len(data):
            break
        (seq, ts, origin, pc, sv0, sv1, op, bclen, depth,
         oplen, operands, st0, st1, sflags) = REC.unpack_from(data, off)
        recs.append({
            'seq': seq, 'ts': ts, 'origin': origin, 'pc': pc,
            'sv0': sv0, 'sv1': sv1, 'op': op, 'len': bclen, 'depth': depth,
            'oplen': oplen, 'operands': operands[:oplen] if oplen <= 16 else operands,
            'st0': st0, 'st1': st1, 'flags': sflags,
        })
        off += REC.size
    return {'magic': magic, 'version': ver, 'first': first_seq, 'last': last_seq,
            'total': total, 'overwritten': overw, 'capacity': cap,
            'count': len(recs), 'trigger_ts': trig_ts, 'records': recs}


def main():
    win = load(sys.argv[1])
    recs = win['records']
    print(f"magic={win['magic']} v{win['version']} records={win['count']}/{win['capacity']}"
          f" total_written={win['total']} overwritten={win['overwritten']}"
          f" seq=[{win['first']}..{win['last']}]")
    if not recs:
        return
    span = (recs[-1]['ts'] - recs[0]['ts']) / 1e6
    print(f"time span: {span:.3f}s  distinct_pcs={len({r['pc'] for r in recs})}"
          f"  origins={len({r['origin'] for r in recs})}")
    pcs = collections.Counter(r['pc'] for r in recs)
    print('\nTop 15 PCs:')
    for pc, n in pcs.most_common(15):
        ops = collections.Counter(r['op'] for r in recs if r['pc'] == pc)
        print(f"  pc={pc:6d} n={n:6d} ops={dict(ops.most_common(3))}")
    print('\nTop 8 opcodes:', dict(collections.Counter(r['op'] for r in recs).most_common(8)))
    print('Top origins:', dict(collections.Counter(r['origin'] for r in recs).most_common(5)))
    # dispatcher heuristic: highest-repetition tight loop = top PC that revisits
    # at high frequency with small operand variation
    top_pc = pcs.most_common(1)[0][0]
    samples = [r for r in recs if r['pc'] == top_pc][:8]
    print(f"\nSample records @pc={top_pc}:")
    for r in samples:
        print(f"  seq={r['seq']} sv0={r['sv0']:#x} sv1={r['sv1']:#x} depth={r['depth']}"
              f" ops={r['operands'].hex()}")
    # tail: last 12 records (freeze moment = payload being posted)
    print('\nLast 12 records (freeze moment):')
    for r in recs[-12:]:
        print(f"  seq={r['seq']} pc={r['pc']} op={r['op']} sv0={r['sv0']:#x}"
              f" sv1={r['sv1']:#x} operands={r['operands'].hex()}")


if __name__ == '__main__':
    main()
