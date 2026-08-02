'use strict';

/**
 * JD h5st 动态生成器。
 *
 * 目标：脱离 trace JSONL 日志运行；只使用本目录固定的 js_security_v3 SDK。
 * - 输入 page/body/functionId
 * - t / h5st 时间默认 Date.now() 动态
 * - tk03 不从 trace 复制，启动时通过 ParamsSign 的 request_algo 流程动态拉取/刷新
 * - localStorage token 状态持久化到 state.json，后续可复用；加 --force-token 强制刷新 tk03
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const DEFAULT_SDK = path.join(ROOT, 'js_security_v3_0.1.4.js');
const DEFAULT_STATE = path.join(ROOT, 'state.json');
const DEFAULT_RISK_SDK = path.join(path.dirname(ROOT), 'analysis', 'pc-tk.js');

function parseArgs(argv) {
  const out = {
    page: '3',
    pagesize: '25',
    area: '',
    source: 'pc-home',
    functionId: 'pc_home_feed',
    appid: 'www-jd-com',
    client: 'pc',
    clientVersion: '1.0.0',
    appId: 'b5216',
    uuid: '',
    bodyJson: '',
    t: '',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    state: DEFAULT_STATE,
    sdk: DEFAULT_SDK,
    forceToken: true,
    riskToken: true,
    forceRiskToken: true,
    riskSdk: DEFAULT_RISK_SDK,
    riskTimeoutMs: 8000,
    printUrl: false,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--page') out.page = next();
    else if (arg.startsWith('--page=')) out.page = arg.slice(7);
    else if (arg === '--pagesize') out.pagesize = next();
    else if (arg.startsWith('--pagesize=')) out.pagesize = arg.slice(11);
    else if (arg === '--area') out.area = next();
    else if (arg.startsWith('--area=')) out.area = arg.slice(7);
    else if (arg === '--source') out.source = next();
    else if (arg.startsWith('--source=')) out.source = arg.slice(9);
    else if (arg === '--function-id') out.functionId = next();
    else if (arg.startsWith('--function-id=')) out.functionId = arg.slice(14);
    else if (arg === '--appid') out.appid = next();
    else if (arg.startsWith('--appid=')) out.appid = arg.slice(8);
    else if (arg === '--client') out.client = next();
    else if (arg.startsWith('--client=')) out.client = arg.slice(9);
    else if (arg === '--client-version') out.clientVersion = next();
    else if (arg.startsWith('--client-version=')) out.clientVersion = arg.slice(17);
    else if (arg === '--app-id') out.appId = next();
    else if (arg.startsWith('--app-id=')) out.appId = arg.slice(9);
    else if (arg === '--uuid') out.uuid = next();
    else if (arg.startsWith('--uuid=')) out.uuid = arg.slice(7);
    else if (arg === '--body-json') out.bodyJson = next();
    else if (arg.startsWith('--body-json=')) out.bodyJson = arg.slice(12);
    else if (arg === '--t') out.t = next();
    else if (arg.startsWith('--t=')) out.t = arg.slice(4);
    else if (arg === '--ua') out.ua = next();
    else if (arg.startsWith('--ua=')) out.ua = arg.slice(5);
    else if (arg === '--state') out.state = next();
    else if (arg.startsWith('--state=')) out.state = arg.slice(8);
    else if (arg === '--sdk') out.sdk = next();
    else if (arg.startsWith('--sdk=')) out.sdk = arg.slice(6);
    else if (arg === '--risk-sdk') out.riskSdk = next();
    else if (arg.startsWith('--risk-sdk=')) out.riskSdk = arg.slice(11);
    else if (arg === '--risk-timeout-ms') out.riskTimeoutMs = Number(next());
    else if (arg.startsWith('--risk-timeout-ms=')) out.riskTimeoutMs = Number(arg.slice(18));
    else if (arg === '--risk-token') out.riskToken = true;
    else if (arg === '--no-risk-token') out.riskToken = false;
    else if (arg === '--force-risk-token') out.forceRiskToken = true;
    else if (arg === '--reuse-risk-token') out.forceRiskToken = false;
    else if (arg === '--force-token') out.forceToken = true;
    else if (arg === '--reuse-token') out.forceToken = false;
    else if (arg === '--print-url') out.printUrl = true;
    else if (arg === '--pretty') out.pretty = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node jd_h5st_dynamic/generate_h5st.js --page=3 --print-url',
    '  node jd_h5st_dynamic/generate_h5st.js --body-json \'{"page":3,"pagesize":25,"area":"","source":"pc-home","kuangjia":1,"notJsonp":true}\'',
    '  node jd_h5st_dynamic/generate_h5st.js --page=3 --reuse-token --pretty',
    '',
    'Key flags:',
    '  --page N              默认构造 pc_home_feed body.page',
    '  --body-json JSON      直接指定 body JSON',
    '  --t MS                指定请求 t；不传就是 Date.now()',
    '  --force-token         默认行为：清掉 WQ_dy1_* 并重新请求算法 token，让 tk03 刷新',
    '  --reuse-token         复用 state.json 里的 WQ_dy1_*，速度更快但 tk03 可能保持上一轮',
    '  --risk-token          默认行为：动态生成 x-api-eid-token 并按浏览器请求结构放入 URL',
    '  --no-risk-token       只生成 h5st，不生成 x-api-eid-token',
    '  --force-risk-token    默认行为：清掉旧风控 token 并重新请求 jsTk.do',
    '  --reuse-risk-token    复用 state.json 里的风控 token',
    '  --print-url           输出完整 api.m.jd.com URL',
  ].join('\n');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function randomDigits(length) {
  let value = '';
  while (value.length < length) value += String(Math.floor(Math.random() * 10));
  return value.slice(0, length);
}

function randomBase64Url(length) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString('base64url').slice(0, length);
}

function randomTokenAlphabet(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] || null; },
    getItem(k) { k = String(k); return m.has(k) ? String(m.get(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    clear() { m.clear(); },
    dump() { return Object.fromEntries(m.entries()); },
  };
}

function makeElement(tag) {
  const lower = String(tag || '').toLowerCase();
  const el = {
    tagName: lower.toUpperCase(),
    style: {},
    children: [],
    parentNode: null,
    setAttribute(k, v) { this[k] = String(v); },
    getAttribute(k) { return this[k] || null; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (typeof child.onload === 'function') setTimeout(() => child.onload({ type: 'load' }), 0);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((x) => x !== child);
      child.parentNode = null;
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
    },
  };
  if (lower === 'canvas') {
    el.width = 300;
    el.height = 150;
    el.getContext = function getContext(type) {
      if (String(type).includes('webgl')) {
        return {
          canvas: el,
          getParameter(p) {
            const values = new Map([
              [0x1f00, 'Mozilla'],
              [0x1f01, 'Mozilla Firefox WebGL fixture'],
              [0x8b8c, 'WebGL GLSL ES 1.0'],
              [0x1f02, 'WebGL 1.0'],
              [0x846e, [1, 1]],
              [0x846d, [1, 1024]],
              [0x0d3a, [16384, 16384]],
            ]);
            return values.get(p) ?? 8;
          },
          getExtension() { return null; },
          getSupportedExtensions() { return []; },
          getShaderPrecisionFormat() { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
          createBuffer() { return {}; },
          bindBuffer() {},
          bufferData() {},
          createProgram() { return {}; },
          createShader(type) { return { type }; },
          shaderSource() {},
          compileShader() {},
          attachShader() {},
          linkProgram() {},
          useProgram() {},
          getAttribLocation() { return 0; },
          getUniformLocation() { return {}; },
          enableVertexAttribArray() {},
          vertexAttribPointer() {},
          uniform2f() {},
          drawArrays() {},
          clearColor() {},
          enable() {},
          depthFunc() {},
          clear() {},
        };
      }
      return {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        lineCap: '',
        font: '',
        textBaseline: '',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        shadowColor: '',
        fillRect() {},
        clearRect() {},
        arc() {},
        stroke() {},
        fillText() {},
        beginPath() {},
        closePath() {},
        measureText(t) { return { width: String(t).length * 7 }; },
        getImageData() { return { data: new Uint8ClampedArray(16) }; },
        putImageData() {},
      };
    };
    el.toDataURL = () => 'data:image/png;base64,TRACE_CANVAS_FIXTURE';
  }
  return el;
}

function parseCookieString(cookieString = '') {
  const jar = new Map();
  for (const part of String(cookieString).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return jar;
}

function cookieJarToString(jar) {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function installCookieJar(document, initialCookie = '') {
  const jar = parseCookieString(initialCookie);
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() { return cookieJarToString(jar); },
    set(value) {
      const firstPart = String(value).split(';')[0];
      const index = firstPart.indexOf('=');
      if (index > 0) jar.set(firstPart.slice(0, index).trim(), firstPart.slice(index + 1).trim());
    },
  });
  return {
    set(name, value) { jar.set(name, value); },
    get(name) { return jar.get(name); },
    toString() { return cookieJarToString(jar); },
    dump() { return Object.fromEntries(jar.entries()); },
  };
}

function buildEnvSnapshot(browserEnv, fingerprint) {
  return {
    sua: browserEnv.sua || 'Macintosh; Intel Mac OS X 10_15_7',
    pp: {},
    extend: {
      wd: 0,
      l: 0,
      ls: 5,
      wk: 0,
      bu1: '0.1.4',
      bu3: 30 + Math.floor(Math.random() * 16),
      bu4: 0,
      bu5: 0,
      bu6: 22 + Math.floor(Math.random() * 10),
      bu7: 0,
      bu8: 0,
      random: randomTokenAlphabet(11),
      bu12: -8,
      bu10: 14,
      bu11: 4,
      bu13: browserEnv.behaviorFlag || 'Fd',
    },
    pf: browserEnv.platform || 'MacIntel',
    random: randomTokenAlphabet(10),
    v: 'h5_file_v5.3.4',
    bu4: '0',
    canvas: browserEnv.canvasFp || 'd1ca903d434427d0d7c07327168be7f3',
    webglFp: browserEnv.webglFp || '94708105d29400ce907bc6226f651222',
    ccn: 12,
    bu14: browserEnv.pFlag || 'mtAjLmVELq',
    t: Date.now(),
    fp: fingerprint || '',
  };
}

function patchSdkSource(source) {
  const ptStart = source.indexOf('function _$PT(');
  const ptNext = source.indexOf('function _$PI(', ptStart);
  if (ptStart < 0 || ptNext < 0) {
    throw new Error('SDK patch anchor not found: function _$PT / _$PI');
  }
  source = source.slice(0, ptStart) +
    'function _$PT(_$Pd){var e=window.__jdBuildEnvSnapshot(_$Pd);return e;}' +
    source.slice(ptNext);

  // 原 SDK 的时间格式函数在 Node VM 下会保留 yyyy，占位替换一次性补稳。
  const f6Start = source.indexOf('function _$f6(');
  const f7Next = source.indexOf('function _$f7(', f6Start);
  if (f6Start < 0 || f7Next < 0) {
    throw new Error('SDK patch anchor not found: function _$f6 / _$f7');
  }
  const f6 =
    "function _$f6(_$Pd,_$Px){var d=new Date(Number(_$Pd)+5000),p=function(v,n){return String(v).padStart(n,'0');},y=d.getFullYear(),M=p(d.getMonth()+1,2),D=p(d.getDate(),2),h=p(d.getHours(),2),m=p(d.getMinutes(),2),s=p(d.getSeconds(),2),S=p(d.getMilliseconds(),3),fmt=String(_$Px||'yyyyMMddhhmmssSSS');return fmt.replace('yyyy',String(y)).replace('MM',M).replace('dd',D).replace('hh',h).replace('mm',m).replace('ss',s).replace('SSS',S);}";
  return source.slice(0, f6Start) + f6 + source.slice(f7Next);
}

const RISK_TOKEN_KEY = '3AB9D23F7A4B3CSS';
const RISK_EID_KEY = '3AB9D23F7A4B3C9B';
const RISK_FP_KEY = 'PCA9D23F7A4B3CSS';

function createRiskRuntime({ scriptPath, state, forceToken = false }) {
  const browserEnv = state.browserEnv || {};
  const localStorage = makeStorage(state.riskLocalStorage || {});
  if (forceToken) {
    localStorage.removeItem(RISK_TOKEN_KEY);
    localStorage.removeItem(RISK_EID_KEY);
    localStorage.removeItem(RISK_FP_KEY);
  }
  const sessionStorage = makeStorage(state.riskSessionStorage || {});
  const navigator = {
    userAgent: browserEnv.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
    appVersion: browserEnv.appVersion || '5.0 (Macintosh)',
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    product: 'Gecko',
    language: browserEnv.language || 'zh-CN',
    languages: browserEnv.languages || ['zh-CN', 'zh', 'en-US', 'en'],
    platform: browserEnv.platform || 'MacIntel',
    hardwareConcurrency: browserEnv.hardwareConcurrency || 8,
    cookieEnabled: true,
    webdriver: false,
    vendor: browserEnv.vendor || '',
    plugins: [],
    mimeTypes: [],
    maxTouchPoints: 0,
    javaEnabled: () => false,
    doNotTrack: null,
  };
  const document = {
    URL: 'https://www.jd.com/',
    documentURI: 'https://www.jd.com/',
    referrer: '',
    title: '京东',
    domain: 'jd.com',
    compatMode: 'CSS1Compat',
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    currentScript: { parentNode: { insertBefore() { return null; } } },
    createElement: makeElement,
    getElementsByTagName(name) {
      if (name === 'head') return [this.head];
      if (name === 'body') return [this.body];
      return [];
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    hasFocus() { return true; },
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };
  const cookieJar = installCookieJar(document, browserEnv.cookie || state.riskCookie || '');

  class RiskXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.timeout = 0;
      this.withCredentials = false;
    }
    open(method, url, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
    }
    setRequestHeader(key, value) { this.headers[key] = value; }
    getAllResponseHeaders() { return this.responseHeadersText || ''; }
    getResponseHeader(name) {
      const lower = String(name || '').toLowerCase();
      for (const line of String(this.responseHeadersText || '').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0 && line.slice(0, i).toLowerCase() === lower) return line.slice(i + 1).trim();
      }
      return '';
    }
    abort() {
      this.aborted = true;
      if (typeof this.onabort === 'function') this.onabort();
    }
    async send(data) {
      const controller = new AbortController();
      let timer = null;
      if (this.timeout > 0) timer = setTimeout(() => controller.abort(), this.timeout);
      const traceRequest = {
        method: this.method,
        url: this.url,
        requestBody: typeof data === 'string' ? data : String(data || ''),
      };
      ctx.__jdRiskRequests.push(traceRequest);
      try {
        const response = await fetch(this.url, {
          method: this.method,
          headers: {
            ...this.headers,
            origin: 'https://www.jd.com',
            referer: 'https://www.jd.com/',
            cookie: cookieJar.toString(),
            'user-agent': navigator.userAgent,
          },
          body: data,
          signal: controller.signal,
        });
        this.status = response.status;
        this.statusText = response.statusText;
        this.responseText = await response.text();
        this.response = this.responseText;
        this.responseHeadersText = Array.from(response.headers.entries()).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        traceRequest.status = this.status;
        traceRequest.responseText = this.responseText.slice(0, 1000);
      } catch (error) {
        this.statusText = error.message;
        traceRequest.error = error.message;
        if (typeof this.onerror === 'function') this.onerror(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.readyState = 4;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
      if (typeof this.onloadend === 'function') this.onloadend();
    }
  }

  const URLWithBlob = URL;
  URLWithBlob.createObjectURL = URLWithBlob.createObjectURL || (() => 'blob:https://www.jd.com/local-risk-worker');
  URLWithBlob.revokeObjectURL = URLWithBlob.revokeObjectURL || (() => {});

  const ctx = {
    console: { ...console, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Symbol,
    RegExp,
    Error,
    TypeError,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Function,
    Date,
    Uint8ClampedArray,
    Buffer,
    decodeURIComponent,
    encodeURIComponent,
    escape,
    unescape,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL: URLWithBlob,
    URLSearchParams,
    window: null,
    self: null,
    globalThis: null,
    document,
    navigator,
    location: new URL('https://www.jd.com/'),
    localStorage,
    sessionStorage,
    XMLHttpRequest: RiskXMLHttpRequest,
    fetch,
    screen: {
      width: browserEnv.screenWidth || 1728,
      height: browserEnv.screenHeight || 1117,
      colorDepth: browserEnv.colorDepth || 30,
      pixelDepth: browserEnv.pixelDepth || 30,
      availWidth: browserEnv.screenWidth || 1728,
      availHeight: browserEnv.availHeight || 1084,
    },
    devicePixelRatio: browserEnv.devicePixelRatio || 2,
    performance: { now: () => 0, timing: {}, navigation: {}, getEntriesByType: () => [] },
    crypto: crypto.webcrypto,
    history: { length: 1 },
    Image: function Image() { return makeElement('img'); },
    Blob: function Blob(parts = [], options = {}) { this.parts = parts; this.type = options.type || ''; },
    Worker: undefined,
    ActiveXObject: function ActiveXObject() { throw new Error('ActiveXObject unavailable'); },
    external: {},
    AudioContext: undefined,
    webkitAudioContext: undefined,
    Element: function Element() {},
    HTMLElement: function HTMLElement() {},
    Document: function Document() {},
    HTMLCanvasElement: function HTMLCanvasElement() {},
    CanvasRenderingContext2D: function CanvasRenderingContext2D() {},
    bp_bizid: 'JDLS-PC-HOME',
    _riskFpMode: 'strict',
    orderId: '',
    pin: '',
    jd_jr_td_risk_pin: '',
    jdfp_pinenp_ext: undefined,
    gia_fp_qd_uuid: '',
    __jdRiskRequests: [],
  };
  ctx.window = ctx.self = ctx.globalThis = ctx;
  ctx.top = ctx.parent = ctx;
  ctx.location.toString = function toString() { return this.href; };
  ctx.document.location = ctx.location;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.getComputedStyle = () => ({ getPropertyValue: () => '16px' });
  ctx.open = () => null;
  ctx.rawWindow = ctx;
  ctx.__MICRO_APP_ENVIRONMENT_TEMPORARY__ = false;

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), ctx, { filename: scriptPath, timeout: 5000 });

  async function ensureRiskToken({ timeoutMs = 8000 } = {}) {
    const cachedToken = localStorage.dump()[RISK_TOKEN_KEY] || '';
    const cachedEid = localStorage.dump()[RISK_EID_KEY] || '';
    const cachedFp = localStorage.dump()[RISK_FP_KEY] || '';
    if (cachedToken && cachedEid && cachedFp) {
      cookieJar.set(RISK_TOKEN_KEY, cachedToken);
      cookieJar.set(RISK_EID_KEY, cachedEid);
      return { jsToken: cachedToken, eid: cachedEid, fp: cachedFp, storage: localStorage.dump(), cookie: cookieJar.toString(), refreshed: false };
    }
    if (typeof ctx.getJsToken !== 'function' || typeof ctx.getJdEid !== 'function') {
      throw new Error('pc-tk.js did not export getJsToken/getJdEid');
    }
    const jsTokenResult = await new Promise((resolve) => {
      ctx.getJsToken((result) => resolve(result || {}), timeoutMs);
    });
    const eidResult = await new Promise((resolve) => {
      ctx.getJdEid((eid, fp, detail) => resolve({ eid, fp, detail }), null, Math.ceil(timeoutMs / 50));
    });
    const storage = localStorage.dump();
    const jsToken = jsTokenResult.jsToken || storage[RISK_TOKEN_KEY] || '';
    const eid = eidResult.eid || storage[RISK_EID_KEY] || '';
    const fp = jsTokenResult.fp || eidResult.fp || storage[RISK_FP_KEY] || '';
    if (jsToken) cookieJar.set(RISK_TOKEN_KEY, jsToken);
    if (eid) cookieJar.set(RISK_EID_KEY, eid);
    return { jsToken, eid, fp, storage, cookie: cookieJar.toString(), refreshed: true };
  }

  return { ctx, localStorage, sessionStorage, cookieJar, ensureRiskToken };
}

function createRuntime({ sdkPath, state, forceToken, appId }) {
  const browserEnv = state.browserEnv || {};
  const localStorage = makeStorage(state.localStorage || {});
  if (forceToken) {
    localStorage.removeItem('WQ_dy1_vk');
    localStorage.removeItem('WQ_dy1_tk_algo');
  }
  const sessionStorage = makeStorage(state.sessionStorage || {});
  const navigator = {
    userAgent: browserEnv.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
    appVersion: browserEnv.appVersion || '5.0 (Macintosh)',
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    product: 'Gecko',
    language: browserEnv.language || 'zh-CN',
    languages: browserEnv.languages || ['zh-CN', 'zh', 'en-US', 'en'],
    platform: browserEnv.platform || 'MacIntel',
    hardwareConcurrency: browserEnv.hardwareConcurrency || 8,
    cookieEnabled: true,
    webdriver: false,
    plugins: [],
    mimeTypes: [],
    maxTouchPoints: 0,
    permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
  };
  const document = {
    URL: 'https://www.jd.com/',
    documentURI: 'https://www.jd.com/',
    referrer: '',
    cookie: browserEnv.cookie || '',
    readyState: 'complete',
    currentScript: { parentNode: { insertBefore() { return null; } } },
    createElement: makeElement,
    getElementsByTagName(name) {
      if (name === 'head') return [this.head];
      if (name === 'body') return [this.body];
      return [];
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };

  class NodeXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.timeout = 0;
      this.withCredentials = false;
    }
    open(method, url, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
    }
    setRequestHeader(key, value) { this.headers[key] = value; }
    getAllResponseHeaders() { return this.responseHeadersText || ''; }
    getResponseHeader(name) {
      const lower = String(name || '').toLowerCase();
      for (const line of String(this.responseHeadersText || '').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0 && line.slice(0, i).toLowerCase() === lower) return line.slice(i + 1).trim();
      }
      return '';
    }
    abort() {
      this.aborted = true;
      if (typeof this.onabort === 'function') this.onabort();
    }
    async send(data) {
      const controller = new AbortController();
      let timer = null;
      if (this.timeout > 0) {
        timer = setTimeout(() => controller.abort(), this.timeout);
      }
      try {
        const traceRequest = {
          method: this.method,
          url: this.url,
          requestBody: typeof data === 'string' ? data : String(data || ''),
        };
        const response = await fetch(this.url, {
          method: this.method,
          headers: {
            ...this.headers,
            origin: 'https://www.jd.com',
            referer: 'https://www.jd.com/',
            'user-agent': navigator.userAgent,
          },
          body: data,
          signal: controller.signal,
        });
        this.status = response.status;
        this.statusText = response.statusText;
        this.responseText = await response.text();
        this.response = this.responseText;
        this.responseHeadersText = Array.from(response.headers.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        if (String(this.url).includes('request_algo')) {
          ctx.__jdRequestAlgo = {
            ...traceRequest,
            status: this.status,
            responseText: this.responseText,
            responseJson: (() => {
              try { return JSON.parse(this.responseText); } catch (_) { return null; }
            })(),
          };
        }
      } catch (error) {
        this.statusText = error.message;
        if (typeof this.onerror === 'function') this.onerror(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.readyState = 4;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
      if (typeof this.onloadend === 'function') this.onloadend();
    }
  }

  const ctx = {
    console: { ...console, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Symbol,
    RegExp,
    Error,
    TypeError,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Function,
    Date,
    decodeURIComponent,
    encodeURIComponent,
    escape,
    unescape,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL,
    URLSearchParams,
    window: null,
    self: null,
    globalThis: null,
    document,
    navigator,
    location: new URL('https://www.jd.com/'),
    localStorage,
    sessionStorage,
    XMLHttpRequest: NodeXMLHttpRequest,
    fetch,
    screen: {
      width: browserEnv.screenWidth || 1728,
      height: browserEnv.screenHeight || 1117,
      colorDepth: browserEnv.colorDepth || 30,
      pixelDepth: browserEnv.pixelDepth || 30,
      availWidth: browserEnv.screenWidth || 1728,
      availHeight: browserEnv.availHeight || 1084,
    },
    devicePixelRatio: browserEnv.devicePixelRatio || 2,
    performance: { now: () => 0, timing: {}, navigation: {}, getEntriesByType: () => [] },
    crypto: {
      getRandomValues(arr) { return crypto.webcrypto.getRandomValues(arr); },
      subtle: crypto.webcrypto.subtle,
    },
    history: { length: 1 },
    WebSocket: function WebSocket() {},
    Image: function Image() { return makeElement('img'); },
    Element: function Element() {},
    Document: function Document() {},
    HTMLCanvasElement: function HTMLCanvasElement() {},
    CanvasRenderingContext2D: function CanvasRenderingContext2D() {},
  };
  ctx.window = ctx.self = ctx.globalThis = ctx;
  ctx.top = ctx.parent = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.getComputedStyle = () => ({ getPropertyValue: () => '16px' });
  ctx.open = () => null;
  ctx.rawWindow = ctx;
  ctx.__MICRO_APP_ENVIRONMENT_TEMPORARY__ = false;
  ctx.__jdBuildEnvSnapshot = () => {
    const fingerprint = ctx.__jdFingerprint || '';
    ctx.__jdLastEnvSnapshot = buildEnvSnapshot(browserEnv, fingerprint);
    return { ...ctx.__jdLastEnvSnapshot };
  };

  vm.createContext(ctx);
  const source = patchSdkSource(fs.readFileSync(sdkPath, 'utf8'));
  vm.runInContext(source, ctx, { filename: sdkPath, timeout: 5000 });
  if (!ctx.ParamsSign) throw new Error('ParamsSign not exported by SDK');
  const signer = new ctx.ParamsSign({ appId, preRequest: false });

  return { ctx, signer, localStorage, sessionStorage, browserEnv };
}

function hasAlgoStorage(storage, appId) {
  const vk = storage.WQ_dy1_vk || '';
  const algo = storage.WQ_dy1_tk_algo || '';
  return vk.includes(appId) && algo.includes(appId);
}

async function ensureToken(runtime, { timeoutMs = 20000, force = false, appId }) {
  if (!force && runtime.signer._fingerprint && hasAlgoStorage(runtime.localStorage.dump(), appId)) {
    runtime.ctx.__jdFingerprint = runtime.signer._fingerprint;
    return { refreshed: false };
  }
  if (typeof runtime.signer._$rds !== 'function') {
    throw new Error('ParamsSign._$rds not found');
  }
  runtime.signer._$rds();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const storage = runtime.localStorage.dump();
    if (runtime.signer._fingerprint && hasAlgoStorage(storage, appId)) {
      runtime.ctx.__jdFingerprint = runtime.signer._fingerprint;
      return { refreshed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`request_algo timeout; storage keys=${Object.keys(runtime.localStorage.dump()).join(',')}`);
}

function buildBody(opts) {
  if (opts.bodyJson) return JSON.stringify(JSON.parse(opts.bodyJson));
  return JSON.stringify({
    page: Number(opts.page),
    pagesize: Number(opts.pagesize),
    area: opts.area,
    source: opts.source,
    kuangjia: 1,
    notJsonp: true,
  });
}

function buildUuid(state) {
  const visit = ensureVisitState(state);
  return `95931165.${visit.jdu}.${visit.firstVisitSec}.${visit.previousVisitSec}.${visit.currentVisitSec}.${visit.sessionCount}`;
}

function ensureVisitState(state) {
  if (state.visit) return state.visit;
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  state.visit = {
    jdu: `${now}${randomDigits(9)}`,
    firstVisitSec: sec,
    previousVisitSec: sec,
    currentVisitSec: sec,
    sessionCount: 1,
  };
  return state.visit;
}

function ensureProtocolCookieState(state) {
  if (state.protocolCookies) return state.protocolCookies;
  const sec = Math.floor(Date.now() / 1000);
  const shshId = crypto.randomUUID();
  state.protocolCookies = {
    areaId: '21',
    ipLocDjd: '21-1911-0-0',
    pcsyCityId: 'CN_360000_360700_0',
    shshshfpa: `${shshId}-${sec}`,
    shshshfpx: `${shshId}-${sec}`,
    shshshfpb: randomBase64Url(80),
    wlfstkSmdl: randomBase64Url(32).toLowerCase(),
    sdtoken: '',
  };
  return state.protocolCookies;
}

function pickCookieFields(cookieString) {
  const result = {};
  for (const part of String(cookieString || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

function buildCookieHeader({ state, uuid, risk }) {
  const visit = ensureVisitState(state);
  const protocol = ensureProtocolCookieState(state);
  const riskCookies = pickCookieFields(risk?.cookie || '');
  const nowSec = Math.floor(Date.now() / 1000);
  const pairs = {
    __jdv: `76161171|direct|-|none|-|${Date.now()}`,
    __jdu: visit.jdu,
    [RISK_TOKEN_KEY]: risk?.jsToken || riskCookies[RISK_TOKEN_KEY],
    [RISK_EID_KEY]: risk?.eid || riskCookies[RISK_EID_KEY],
    areaId: protocol.areaId,
    'ipLoc-djd': protocol.ipLocDjd,
    PCSYCityID: protocol.pcsyCityId,
    shshshfpa: protocol.shshshfpa,
    shshshfpx: protocol.shshshfpx,
    __jda: uuid,
    __jdb: `95931165.1.${visit.jdu}|1.${nowSec}`,
    __jdc: '95931165',
    wlfstk_smdl: protocol.wlfstkSmdl,
    shshshfpb: protocol.shshshfpb,
  };
  if (protocol.sdtoken) pairs.sdtoken = protocol.sdtoken;
  return Object.entries(pairs)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function buildApiHeaders({ state, cookie, ua }) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: 'https://www.jd.com',
    referer: 'https://www.jd.com/',
    'user-agent': ua || state.browserEnv?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
    'x-referer-page': 'https://www.jd.com/',
    'x-rp-client': 'h5_2.2.0',
    cookie,
  };
  const m = String(headers['user-agent']).match(/Chrome\/(\d+)/);
  if (m) {
    const v = m[1];
    headers['sec-ch-ua'] = `"Not_A Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"macOS"';
  }
  return headers;
}

function encodeTraceQueryValue(key, value) {
  const encoded = encodeURIComponent(String(value));
  // 浏览器 trace 里的 body 参数保留了 JSON 的 ":" 和 ","，这里按同样形态输出。
  if (key === 'body') return encoded.replace(/%3A/g, ':').replace(/%2C/g, ',');
  return encoded;
}

function buildApiUrl(params) {
  const order = [
    'appid',
    'client',
    'clientVersion',
    't',
    'uuid',
    'body',
    'functionId',
    'h5st',
    'x-api-eid-token',
    'loginType',
  ];
  const query = order
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeTraceQueryValue(key, params[key])}`)
    .join('&');
  return `https://api.m.jd.com/?${query}`;
}

async function generate(opts) {
  const sdkPath = path.resolve(opts.sdk);
  const statePath = path.resolve(opts.state);
  const riskSdkPath = path.resolve(opts.riskSdk);
  if (!fs.existsSync(sdkPath)) throw new Error(`SDK not found: ${sdkPath}`);
  const state = readJsonSafe(statePath, {});
  state.browserEnv ||= {};
  if (opts.ua) {
    state.browserEnv.userAgent = opts.ua;
    state.browserEnv.appVersion = opts.ua.replace(/^Mozilla\//, '');
  }
  ensureVisitState(state);
  ensureProtocolCookieState(state);
  const runtime = createRuntime({
    sdkPath,
    state,
    forceToken: opts.forceToken,
    appId: opts.appId,
  });
  const tokenInfo = await ensureToken(runtime, {
    timeoutMs: 20000,
    force: opts.forceToken,
    appId: opts.appId,
  });
  runtime.ctx.__jdFingerprint = runtime.signer._fingerprint || '';

  const bodyText = buildBody(opts);
  const t = opts.t ? Number(opts.t) : Date.now();
  const signInput = {
    appid: opts.appid,
    body: sha256Hex(bodyText),
    client: opts.client,
    clientVersion: opts.clientVersion,
    functionId: opts.functionId,
    t,
  };
  const signed = runtime.signer.signSync({ ...signInput });
  const h5st = signed.h5st || '';
  const uuid = opts.uuid || buildUuid(state);
  let riskInfo = null;
  if (opts.riskToken && fs.existsSync(riskSdkPath)) {
    const riskRuntime = createRiskRuntime({ scriptPath: riskSdkPath, state, forceToken: opts.forceRiskToken });
    riskInfo = await riskRuntime.ensureRiskToken({ timeoutMs: opts.riskTimeoutMs || 8000 });
    state.riskLocalStorage = riskRuntime.localStorage.dump();
    state.riskSessionStorage = riskRuntime.sessionStorage.dump();
    state.riskCookie = riskRuntime.cookieJar.toString();
    state.lastRiskFp = riskInfo.fp || '';
    state.lastRiskRunAt = Date.now();
    riskInfo.requests = riskRuntime.ctx.__jdRiskRequests || [];
  }
  const params = {
    appid: opts.appid,
    client: opts.client,
    clientVersion: opts.clientVersion,
    t: String(t),
    uuid,
    body: bodyText,
    functionId: opts.functionId,
    h5st,
  };
  if (riskInfo?.jsToken) params['x-api-eid-token'] = riskInfo.jsToken;
  params.loginType = '3';
  const url = buildApiUrl(params);
  const cookie = buildCookieHeader({ state, uuid, risk: riskInfo });
  const headers = buildApiHeaders({ state, cookie, ua: state.browserEnv.userAgent });

  state.localStorage = runtime.localStorage.dump();
  state.sessionStorage = runtime.sessionStorage.dump();
  state.browserEnv = runtime.browserEnv;
  state.lastFingerprint = runtime.signer._fingerprint || '';
  state.lastRunAt = Date.now();
  writeJson(statePath, state);

  const parts = h5st.split(';');
  return {
    ok: parts.length === 10 && parts[3]?.startsWith('tk03'),
    h5st,
    url: opts.printUrl ? url : undefined,
    params,
    headers,
    signInput,
    diagnostics: {
      appId: opts.appId,
      fingerprint: runtime.signer._fingerprint || '',
      tokenRefreshed: tokenInfo.refreshed,
      tk03: parts[3] || '',
      requestAlgo: runtime.ctx.__jdRequestAlgo || null,
      risk: riskInfo ? {
        jsTokenLen: riskInfo.jsToken?.length || 0,
        jsTokenPrefix: riskInfo.jsToken ? riskInfo.jsToken.slice(0, 20) : '',
        eidLen: riskInfo.eid?.length || 0,
        eidPrefix: riskInfo.eid ? riskInfo.eid.slice(0, 24) : '',
        fp: riskInfo.fp || '',
        refreshed: riskInfo.refreshed,
        requests: (riskInfo.requests || []).map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          requestBodyLen: r.requestBody ? r.requestBody.length : 0,
          responseTextPrefix: r.responseText ? r.responseText.slice(0, 120) : '',
          error: r.error,
        })),
        sdkPath: fs.existsSync(riskSdkPath) ? riskSdkPath : '',
      } : null,
      h5stSegmentLengths: parts.map((part) => part.length),
      h5stSha256: sha256Hex(h5st),
      envSnapshot: runtime.ctx.__jdLastEnvSnapshot,
      statePath,
      sdkPath,
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const result = await generate(opts);
  console.log(JSON.stringify(result, null, opts.pretty ? 2 : 0));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || String(error));
    process.exit(1);
  });
}

module.exports = { generate };
