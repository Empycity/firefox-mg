#!/usr/bin/env python3
"""从 sg JS 自动提取 JSVMP：按内容分类配对（数字数组=字节码，字符串数组=常量表）。

布局（各版本实测一致）: [R1 加密字节码][F1 其常量][R2 轨迹字节码][F2 其常量]
用法: python3 extract_sg_vm.py <in.js|-> <out.js>
"""
import re, sys

def extract(s: str):
    arrays = []
    for m in re.finditer(r'=\[((?:[^\[\]]){80,})\]', s):
        body = m.group(1)
        arrays.append((m.start(), body, m.group(0).lstrip('=')))
    def is_num_array(body):
        return all(re.fullmatch(r'-?\d+', x) for x in body.split(',') if x.strip())
    def is_str_array(body):
        return body.lstrip().startswith('"')
    pairs = []
    i = 0
    while i < len(arrays):
        pos, body, full = arrays[i]
        if len(body.split(',')) >= 500 and is_num_array(body):
            for j in range(i + 1, len(arrays)):
                if arrays[j][1].lstrip().startswith('"'):
                    pairs.append((full, arrays[j][2])); i = j; break
        i += 1
    if len(pairs) < 2: raise RuntimeError(f'expect 2 bytecode/consts pairs, got {len(pairs)}')
    (R1, F1), (R2, F2) = pairs[0], pairs[1]
    mi = re.search(r'function t\(n,e,r,i,a,o\)', s)
    if not mi: raise RuntimeError('interpreter not found')
    start = s.rfind('=', 0, mi.start())
    i2 = s.find('{', mi.start() - 1)
    d = 0; k = i2
    while k < len(s):
        c = s[k]
        if c == '{': d += 1
        elif c == '}':
            d -= 1
            if d == 0: break
        k += 1
    interp = s[start + 1:k + 1]
    n = lambda a: len(a[1:-1].split(','))
    return interp, R1, F1, R2, F2, (n(R1), n(F1), n(R2), n(F2))

if __name__ == '__main__':
    src = sys.stdin.read() if sys.argv[1] == '-' else open(sys.argv[1]).read()
    interp, R1, F1, R2, F2, sizes = extract(src)
    out = (f'var D={interp};\nvar R1={R1};\nvar F1={F1};\nvar R2={R2};\nvar F2={F2};\n'
           'globalThis.window=globalThis;\n'
           'globalThis.D=D;globalThis.R1=R1;globalThis.F1=F1;globalThis.R2=R2;globalThis.F2=F2;\n')
    open(sys.argv[2], 'w').write(out)
    print(f'R1={sizes[0]} F1={sizes[1]} R2={sizes[2]} F2={sizes[3]} -> {sys.argv[2]}', file=sys.stderr)
