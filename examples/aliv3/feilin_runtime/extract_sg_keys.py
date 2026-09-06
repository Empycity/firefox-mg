#!/usr/bin/env python3
"""sg/SDK 密钥动态提取 + 本地缓存（跨版本）。

原理（自验证，无需人工标注）：
1. 用 feilin_runtime/env.js 同款沙箱加载目标 JS（feilin/sg/AliyunCaptcha），
   hook `decodeURIComponent` / `atob` / `String.fromCharCode` 抓全部解码字符串
   （混淆器多层字符串表都会经过这三个出口）。
2. 对抓到的 16 位字母数字候选 key × 28+ 位 b64 候选密文做 AES-128-CBC 解密
   （IV 候选：'0123456789ABCDEF' + 抓到的 16 位大写hex串），
   解出"可打印 ASCII 明文"的 (key, iv, ct, plaintext) 四元组即可信密钥对。
3. 以脚本 sha256 为 key 写入本地缓存 cache/sg_keys/index.json；
   命中缓存直接返回，不重复跑 Node。

用法:
  python3 extract_sg_keys.py <script.js> [more.js ...]
  python3 extract_sg_keys.py --from-trace <TRACE_DIR>   # 自动取 web-assets 下全部 js
"""
import base64, hashlib, json, os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, 'cache', 'sg_keys')
INDEX = os.path.join(CACHE_DIR, 'index.json')
ENV_JS = os.path.join(HERE, 'env.js')
NODE = os.environ.get('NODE', 'node')
IV_DEFAULT = '0123456789ABCDEF'

HOOK = """
(function(){
  const seen = new Set();
  const add = s => { if (typeof s === 'string' && s.length >= 8 && s.length <= 4096) seen.add(s); };
  const dU = decodeURIComponent, ue = unescape, Oatob = globalThis.atob;
  globalThis.decodeURIComponent = function (s) { try { const r = dU(s); add(r); return r; } catch (e) { return dU(s); } };
  // CryptoJS Utf8.parse 内部走 unescape(encodeURIComponent(x)) —— AES key/消息的精确入口
  globalThis.unescape = function (s) { const r = ue(s); add(r); return r; };
  // CryptoJS Base64.parse 走 atob —— b64 密文的入口
  globalThis.__atobRaw = globalThis.__atobRaw || new Set();
  globalThis.atob = function (s) { add(s); const r = Oatob(s); if (typeof r === 'string' && r.length >= 16) globalThis.__atobRaw.add(r); return r; };
  const fcc = String.fromCharCode;
  String.fromCharCode = function (...a) { const r = fcc.apply(String, a); if (r.length >= 8) add(r); return r; };
  globalThis.__capturedStrings = seen;
})();
"""


def sha256_file(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def run_node_capture(script_path):
    """Load target JS in the env shim; return all captured strings."""
    harness = (
        'const fs=require("fs");\n'
        'const code=fs.readFileSync(%r,"utf8");\n' % script_path +
        'eval(require("fs").readFileSync(%r,"utf8"));\n' % ENV_JS and '' or ''
    )
    # 直接复用 env.js 沙箱成本高且它会执行 feilin 流程；这里用轻量浏览器桩。
    stub = (
        'globalThis.window=globalThis;globalThis.self=globalThis;'
        'globalThis.navigator=globalThis.navigator||{userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",platform:"MacIntel",language:"zh-CN",languages:["zh-CN"],hardwareConcurrency:8,deviceMemory:8,maxTouchPoints:0,vendor:"",plugins:{length:0},mimeTypes:{length:0},userAgentData:void 0,webdriver:false};'
        'globalThis.location=globalThis.location||{href:"https://resource.51xf.cn/",protocol:"https:",host:"resource.51xf.cn",hostname:"resource.51xf.cn",origin:"https://resource.51xf.cn",pathname:"/H5/captcha.html"};'
        'globalThis.screen=globalThis.screen||{width:1728,height:1117,availWidth:1728,availHeight:1055,colorDepth:30,pixelDepth:30};'
        'globalThis.document=globalThis.document||{createElement:()=>({style:{},setAttribute(){},appendChild(){}}),getElementsByTagName:()=>[],addEventListener(){},cookie:""};'
        'globalThis.atob=globalThis.atob||(s=>Buffer.from(s,"base64").toString("binary"));'
        'globalThis.btoa=globalThis.btoa||(s=>Buffer.from(s,"binary").toString("base64"));'
        'globalThis.crypto=globalThis.crypto||require("crypto").webcrypto;'
        'globalThis.performance=globalThis.performance||{now:()=>Date.now()};'
        'globalThis.addEventListener=()=>{};'
        'globalThis.history=globalThis.history||{length:1,back(){},pushState(){}};'
        'globalThis.HTMLElement=function(){};globalThis.Window=function(){};'
        'globalThis.Element=globalThis.HTMLElement;globalThis.Node=globalThis.HTMLElement;'
        'globalThis.document.createElement=()=>({style:{},setAttribute(){},appendChild(){},attachEvent(){},getContext:()=>null});'
        # SDK init 会起定时器轮询 → 定时器全部静默，模块顶层同步初始化照常完成
        'globalThis.setTimeout=()=>0;globalThis.setInterval=()=>0;globalThis.setImmediate=()=>0;'
        'globalThis.requestAnimationFrame=()=>0;globalThis.clearTimeout=()=>{};globalThis.clearInterval=()=>{};'
        # 每 500ms 增量 flush（父进程到点强杀后仍能拿到已捕获字符串）
        'setInterval.real ? null : null;'
        'const flush=()=>{ try{ process.stdout.write("__STRINGS__"+JSON.stringify({strings:[...globalThis.__capturedStrings],atobRaw:[...(globalThis.__atobRaw||[])]})+"\\n"); }catch(e){} };'
        'const t0=Date.now(); const _fcc2=String.fromCharCode;'
        'globalThis.__maybeFlush=()=>{ if(Date.now()-t0>400){ flush(); process.exit(0);} };'
    )
    script = stub + HOOK + (
        '\nconst __code = require("fs").readFileSync(%r, "utf8");\n' % script_path +
        'try { eval(__code); } catch (e) { console.error("eval:", e.message); }\n'
        'flush();\n'
    )
    try:
        r = subprocess.run([NODE, '-e', script], capture_output=True, timeout=25)
        out = r.stdout.decode('utf8', 'replace')
    except subprocess.TimeoutExpired as te:
        out = (te.stdout or b'').decode('utf8', 'replace')
    if '__STRINGS__' not in out:
        raise RuntimeError('no capture: ' + (r.stderr.decode() if 'r' in dir() else '') + out[-200:])
    best = ''
    for line in out.split('__STRINGS__')[1:]:
        if len(line) > len(best):
            best = line
    data = json.loads(best.strip().splitlines()[0])
    # flush 只输出 seen；atob 原文在第二次 flush 里附带 —— 解析同一 JSON 行之后的扩展字段
    return data


def printable(b):
    try:
        s = b.decode('ascii')
    except UnicodeDecodeError:
        return None
    return s if s and all(32 <= ord(c) < 127 for c in s) else None


def extract_constants(strings, atob_raw):
    """key候选(unescape/decodeURIComponent 捕获) × 密文池(atob原文+b64串) → AES-CBC 可打印自验证。"""
    from Crypto.Cipher import AES
    keys = sorted({s for s in strings if 8 <= len(s) <= 32 and s.isalnum()})
    ivs = [IV_DEFAULT] + sorted({s for s in strings if len(s) == 16 and s == s.upper() and s.isalnum()})
    raws = []
    for r in atob_raw:
        b = r.encode('latin1', 'replace')
        b = b[:len(b) // 16 * 16]
        if len(b) >= 16:
            raws.append(b)

    def b64cands(seq):
        out = set()
        for s in seq:
            if len(s) >= 28 and all(c.isalnum() or c in '+/=' for c in s):
                out.add(s)
        # 混淆器把常量切成片段用 '+' 拼接 —— 片段两两/三三组合重建完整密文
        frags = [s for s in seq if 4 <= len(s) <= 64 and all(c.isalnum() or c in '+/=' for c in s)]
        import itertools
        for a, b in itertools.product(frags, repeat=2):
            if len(a) + len(b) >= 28:
                out.add(a + b)
        return out

    for s in b64cands(strings):
        if len(s) >= 28 and all(c.isalnum() or c in '+/=' for c in s):
            try:
                b = base64.b64decode(s + '==')
            except Exception:
                continue
            b = b[:len(b) // 16 * 16]          # gr 用 NoPadding 语义，尾部半块截断
            if len(b) >= 16:
                raws.append(b)
    found, seen = [], set()
    for k in keys:
        for iv in ivs:
            try:
                cipher = AES.new(k.encode(), AES.MODE_CBC, iv.encode())
            except Exception:
                continue
            for raw in raws:
                full = cipher.decrypt(raw)
                pt = printable(full[:16])       # 只要求首块可打印（NoPadding 截断语义）
                if pt and sum(c.isalnum() or c in '#-_=+/.&' for c in pt) / len(pt) > 0.95:
                    kk = (k, iv, pt)
                    if kk not in seen:
                        seen.add(kk)
                        found.append({'key': k, 'iv': iv, 'plaintext': pt})
    return found


def load_index():
    try:
        return json.load(open(INDEX))
    except Exception:
        return {}


def save_index(idx):
    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump(idx, open(INDEX, 'w'), ensure_ascii=False, indent=1)


def resolve(scripts):
    out = {}
    for p in scripts:
        digest = sha256_file(p)
        idx = load_index()
        entry = idx.get(digest)
        if entry and entry.get('sha256') == digest:
            print(f'[cache] {os.path.basename(p)} -> {digest[:12]} ({len(entry["constants"])} constants)')
            out[p] = entry
            continue
        cap = run_node_capture(p)
        strings = cap['strings']
        constants = extract_constants(strings, cap.get('atobRaw', []))
        entry = {'file': os.path.basename(p), 'sha256': digest,
                 'extracted_at': int(time.time()), 'strings_captured': len(strings),
                 'atob_raw_captured': len(cap.get('atobRaw', [])),
                 'constants': constants}
        idx[digest] = entry
        save_index(idx)
        print(f'[fresh] {os.path.basename(p)} -> {digest[:12]}: captured={len(strings)} constants={len(constants)}')
        for c in constants:
            print(f'    key={c["key"]}  iv={c["iv"]}  -> {c["plaintext"][:60]}')
        out[p] = entry
    return out


if __name__ == '__main__':
    args = sys.argv[1:]
    paths = []
    if args and args[0] == '--from-trace':
        import glob
        root = args[1]
        paths = sorted(glob.glob(os.path.join(root, 'web-assets', 'js', '*.js')))
    else:
        paths = args
    if not paths:
        sys.exit(__doc__)
    resolve(paths)
