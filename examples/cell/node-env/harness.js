// ---- Trace-derived realm classes (round3 contract: realm_26a150bb1030) ----
// Chains below are exactly what the browser recorded; anti-bot checks walk
// these (instanceof, Prototype holder identity, Symbol.toStringTag).
const REALM_CHAINS = {
  EventPrototype: ['EventPrototype', 'Object'],
  EventTargetPrototype: ['EventTargetPrototype', 'Object'],
  MessageEventPrototype: ['MessageEventPrototype', 'EventPrototype', 'Object'],
  NodePrototype: ['NodePrototype', 'EventTargetPrototype', 'Object'],
  ElementPrototype: ['ElementPrototype', 'NodePrototype', 'EventTargetPrototype', 'Object'],
  HTMLElementPrototype: ['HTMLElementPrototype', 'ElementPrototype', 'NodePrototype', 'EventTargetPrototype', 'Object'],
  HTMLDivElementPrototype: null, HTMLAnchorElementPrototype: null,
  HTMLIFrameElementPrototype: null, HTMLScriptElementPrototype: null,
  HTMLStyleElementPrototype: null, HTMLParagraphElementPrototype: null,
  HTMLHeadingElementPrototype: null,
  SVGElementPrototype: ['SVGElementPrototype', 'ElementPrototype', 'NodePrototype', 'EventTargetPrototype', 'Object'],
  SVGGraphicsElementPrototype: null, SVGGeometryElementPrototype: null,
  SVGPathElementPrototype: null, SVGCircleElementPrototype: null, SVGSVGElementPrototype: null,
  OffscreenCanvasPrototype: ['OffscreenCanvasPrototype', 'EventTargetPrototype', 'Object'],
  ShadowRootPrototype: ['ShadowRootPrototype', 'NodePrototype', 'EventTargetPrototype', 'Object'],
  ImageDataPrototype: ['ImageDataPrototype', 'Object'],
  TextMetricsPrototype: ['TextMetricsPrototype', 'Object'],
  WebGLShaderPrecisionFormatPrototype: ['WebGLShaderPrecisionFormatPrototype', 'Object'],
  OffscreenCanvasRenderingContext2DPrototype: ['OffscreenCanvasRenderingContext2DPrototype', 'Object'],
  CSS2PropertiesPrototype: ['CSS2PropertiesPrototype', 'CSSStyleDeclarationPrototype', 'Object'],
  CSSStyleDeclarationPrototype: ['CSSStyleDeclarationPrototype', 'Object'],
  NavigatorPrototype: ['NavigatorPrototype', 'Object'],
  LocationPrototype: ['LocationPrototype', 'Object'],
  PerformanceEntryPrototype: ['PerformanceEntryPrototype', 'Object'],
  PerformanceResourceTimingPrototype: ['PerformanceResourceTimingPrototype', 'PerformanceEntryPrototype', 'Object'],
};
// WebIDL semantics live on Elem.prototype; the trace-derived chains must
// carry them at the right links or chain instances lose every method.
function graftElemMethods(srcProto, proto, names) {
  for (const m of names) {
    const d = srcProto && Object.getOwnPropertyDescriptor(srcProto, m);
    if (d && !Object.getOwnPropertyDescriptor(proto, m)) {
      try { Object.defineProperty(proto, m, { ...d, configurable: true }); } catch (_) {}
    }
  }
}
const ELEM_GRAFTS = [
  ['ElementPrototype', ['setAttribute','getAttribute','removeAttribute','classList','querySelector','querySelectorAll','getBoundingClientRect','getElementsByTagName','remove']],
  ['NodePrototype', ['appendChild','insertBefore','removeChild','contains','cloneNode']],
  ['EventTargetPrototype', ['addEventListener','removeEventListener','dispatchEvent']],
  ['HTMLElementPrototype', ['click','focus','blur']],
  ['HTMLIFrameElementPrototype', ['contentWindow','contentDocument','src']],
  ['HTMLScriptElementPrototype', ['src','text']],
];
// Element.prototype.attachShadow per WebIDL: returns a ShadowRoot node whose
// chain is ShadowRootPrototype->NodePrototype->EventTargetPrototype (round3/
// round12 ledger: payload appendChilds <style> onto it at fav0 col 252319/
// 199868; api.js col 76651 appendChilds an iframe). mode:'closed' leaves
// host.shadowRoot null.
function makeAttachShadow(getShadowProto) {
  const selMatch = (e, sel) => {
    const s = String(sel).trim();
    if (s.startsWith('#')) return e.id === s.slice(1);
    if (s.startsWith('.')) return String(e.className || '').split(/\s+/).includes(s.slice(1));
    return e.tagName === s.toUpperCase();
  };
  const subtree = (n, out) => { for (const c of n.children || []) { out.push(c); subtree(c, out); } return out; };
  return function attachShadow(init) {
    const mode = (init && init.mode) || 'open';
    if (this.__shadowRoot) return this.__shadowRoot;
    const sr = Object.create(getShadowProto() || Object.prototype);
    sr.tagName = '#shadow-root'; sr.mode = mode; sr.host = this;
    sr.children = []; sr.attrs = {}; sr.style = {};
    sr.appendChild = function (c) { this.children.push(c); c.parentNode = this; log('SHADOW', `appendChild <${c && c.tagName}> id=${String(c && (c.id !== undefined ? c.id : '?')).slice(0, 40)}`); return c; };
    sr.insertBefore = function (c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; };
    sr.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
    sr.querySelector = (sel) => { const hit = subtree(sr, []).find(e => selMatch(e, sel)); log('SHADOW', `querySelector(${String(sel)}) -> ${hit ? '<' + hit.tagName + '>' : 'null'} (kids=${sr.children.length})`); return hit || null; };
    sr.querySelectorAll = (sel) => { const out = subtree(sr, []).filter(e => selMatch(e, sel)); out.item = (i) => out[i] || null; return out; };
    sr.getElementById = (id) => subtree(sr, []).find(e => e.id === id) || null;
    sr.getElementsByClassName = (cls) => sr.querySelectorAll('.' + cls);
    sr.addEventListener = function (t, fn) { (this.__l = this.__l || []).push([t, fn]); };
    sr.removeEventListener = function () {};
    sr.firstChild = null; sr.lastChild = null;
    this.__shadowRoot = sr;
    try { Object.defineProperty(this, 'shadowRoot', { value: mode === 'closed' ? null : sr, configurable: true }); } catch (_) {}
    return sr;
  };
}
function buildRealmClasses(W) {
  const cache = { ObjectPrototype: Object.prototype };
  function getProto(name) {
    if (name === 'Object' || name === 'ObjectPrototype') return Object.prototype;
    if (cache[name]) return cache[name];
    const spec = REALM_CHAINS[name];
    const chain = Array.isArray(spec)
      ? spec
      : [name, 'HTMLElementPrototype', 'ElementPrototype', 'NodePrototype', 'EventTargetPrototype', 'Object'];
    const proto = {};
    try { Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true }); } catch (_) {}
    cache[name] = proto;  // reserve before recursion (cycles impossible, but cheap safety)
    Object.setPrototypeOf(proto, getProto(chain[1] || 'Object'));
    return proto;
  }
  function defClass(iface, srcProto) {
    const proto = getProto(iface + 'Prototype');
    function C() { const inst = Object.create(proto); return inst; }
    C.prototype = proto;
    W[iface] = C;
    W[iface + 'Prototype'] = proto;
      for (const [pn, names] of ELEM_GRAFTS) {
        if (pn === iface + 'Prototype' && srcProto) graftElemMethods(srcProto, proto, names);
      }
    return C;
  }
  return { getProto, defClass };
}

  const envWindowRef = { set: null, __perfObservers: [], __pendingPerf: [] };
async function queueIframeLoad(element, url) {
  const abs = url.startsWith('http') ? url : new URL(url, BASE).href;
  log('IFRAME', `loading widget iframe src=${abs.slice(0, 120)}`);
  const realm = element.contentWindow;  // creates + registers the realm
  const entry = iframeRealms.find(r2 => r2.element === element);
  const r = await httpReq('GET', abs, { Referer: BASE + '/', Accept: 'text/html,*/*' });
  log('IFRAME', `iframe html ${r.status} ${r.text.length}B`);
  let html = r.text;
  // Pin the widget page for deterministic boot debugging: the live f/av0 HTML
  // varies per fetch (session tokens), which shifts every error column. Use the
  // saved copy when present; otherwise persist this fetch as the new pin.
  if (String(abs).includes('/f/av0/')) {
    const pinPath = path.join(__dirname, 'fav0-page.html');
    if (fs.existsSync(pinPath)) {
      const pinned = fs.readFileSync(pinPath, 'utf8');
      if (pinned.length > 100000) { html = pinned; log('IFRAME', `using PINNED fav0 page (${pinned.length}B)`); }
    } else {
      try { fs.writeFileSync(pinPath, html); log('IFRAME', `saved fav0 page pin (${html.length}B)`); } catch (_) {}
    }
  }
  // Build the realm document from the widget HTML so the payload sees its own DOM.
  const D = entry.doc;
  try {
    const htmlEl = { children: [], tagName: 'HTML' };
    const stack = [D.body, D.head, htmlEl];
    const re2 = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g;
    let m2;
    while ((m2 = re2.exec(html))) {
      const close = m2[1], tag = m2[2], attrsRaw = m2[3];
      const tl = tag.toLowerCase();
      if (close) {
        if (stack.length > 3) stack.pop();  // html/head/body closes also pop their push
        continue;
      }
      const el = tl === 'body' ? D.body : (tl === 'head' ? D.head : D.createElement(tag));
      for (const am of attrsRaw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        try { el.setAttribute(am[1], am[2] ?? ''); } catch (_) {}
      }
      const top = stack[stack.length - 1];
      if (el !== top) (top.children || (top.children = [])).push(el);
      el.parentNode = top;
      if (!m2[4] && !/^(meta|link|br|img|input|hr|html|head)$/i.test(tag)) stack.push(el);
    }
    log('IFRAME', `realm DOM built (${D.body.children.length} body / ${D.head.children.length} head nodes)`);
  } catch (e6) { log('ERR', 'realm DOM: ' + e6.message); }
  for (const mm of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const s = mm[1].startsWith('http') ? mm[1] : new URL(mm[1], abs).href;
    entry.doc.__pending.push(s);
  }
  const inline = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m2 => m2[1]).join(';');
  if (inline) {
    try { fs.writeFileSync(path.join(__dirname, 'fav0-payload-live.js'), inline); } catch (_) {}
    log('FAV0EVAL', `inline=${inline ? inline.length : 'null'}B realm=${iframeRealms.length} src=${String(element.__src || element.src || '').slice(0, 80)}`);
    const __t0 = Date.now();
    try { vm.runInContext(inline, entry.ctx, { filename: 'fav0-payload.js' }); log('FAV0EVAL', `eval done in ${Date.now() - __t0}ms`); } catch (e) { log('ERR', 'iframe inline: ' + e.message + ' | ' + String(e.stack).split('\n').slice(1, 4).join(' | ').slice(0, 300)); }
  }
}

const iframeRealms = [];  // module-level: drive loop pumps these realms

// ---- Virtual clock & timer queue (user-directed: time is simulated) ----
// The whole challenge runs on a simulated clock: Date.now/performance.now
// read V.now, and setTimeout/setInterval push into a virtual queue the pump
// drains by ADVANCING V.now — no real waiting, fully deterministic, and the
// 60s+ browser timeline replays in milliseconds.
const V = { now: 0, base: 0, q: new Map(), seq: 0 };
// Lazy wall-clock anchor: virtual time must flow during synchronous code
// too (the browser's clocks reflect real elapsed time inside sync loops).
// The pump re-anchors each tick; between ticks, reads advance V.now by the
// real elapsed drift — a spin that waits on the clock terminates just like
// in the browser instead of freezing the clock forever.
const vAnchor = { virt: 0, real: 0 };
const vAdvance = () => {
  const r = Date.now() - vAnchor.real;
  if (r > 0 && vAnchor.virt + r > V.now) V.now = vAnchor.virt + r;
  return V.now;
};
function vSchedule(kind, fn, ms, args) {
  const id = ++V.seq;
  const d = Math.max(0, Number(ms) || 0);
  V.q.set(id, { kind, fn, args: args || [], at: V.now + d, every: kind === 'interval' ? d : 0 });
  return id;
}
function vCancel(id) { V.q.delete(id); }
function vNextAt() { let best = Infinity; for (const t of V.q.values()) if (t.at < best) best = t.at; return best; }
// Browser semantics on an uncaught (virtual) timer exception: fire the
// window error event — the orchestrate uses it as its phase-retry signal.
function vTimerError(e, fn) {
  log('ERR', 'vTimer: ' + e.message + ' | ' + String(e.stack || 'nostack').split('\n').slice(1, 7).join(' | ').slice(0, 600));
  try {
    const W = envWindowRef.set;
    if (W) {
      const ev = { type: 'error', error: e, message: e && e.message, filename: '', lineno: 0, colno: 0, isTrusted: true, preventDefault: () => {} };
      const ls = (envWindowRef.__listeners && envWindowRef.__listeners.get('error')) || [];
      for (const h of ls) { try { h(ev); } catch (_) {} }
    }
  } catch (_) {}
}
function vDrain(maxOps) {
  let ops = 0;
  for (;;) {
    let id = null, best = null;
    for (const [k2, t] of V.q) if (!best || t.at < best.at) { best = t; id = k2; }
    if (!best || best.at > V.now) break;
    if (best.every) best.at = V.now + best.every; else V.q.delete(id);
    try { best.fn(...best.args); } catch (e) { vTimerError(e, best.fn); }
    if (++ops > (maxOps || 200000)) break;
  }
}
// Cell challenge harness: run the Cloudflare chl_page orchestrate script in a
// supplemented browser environment. Evidence source: traces/round3-transport
// (environment ledger + captured artifacts). XHRs are logged and executed via
// Node fetch with a shared cookie jar.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';
const BASE = 'https://www.cell.com';
const LOG = [];
const jar = new Map(); // name -> {value, domain, path}

function log(kind, msg, extra) {
  const rec = { t: Date.now(), kind, msg, ...(extra || {}) };
  LOG.push(rec);
  console.error(`[${kind}] ${msg}${extra ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`);
}

function cookieHeader() {
  return [...jar.values()].map(c => `${c.name}=${c.value}`).join('; ');
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let dom = '';
    for (const a of attrs) {
      const [k, v] = a.split('=');
      if (k.trim().toLowerCase() === 'domain') dom = (v || '').trim();
    }
    if (name === 'cf_clearance') log('COOKIE', `cf_clearance obtained (len ${value.length})`);
    jar.set(name, { name, value, domain: dom });
  }
}

async function httpReq(method, url, headers, body) {
  const h = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.8,en-US;q=0.5,en;q=0.3',
    ...(headers || {}),
  };
  const ck = cookieHeader();
  if (ck && !h.Cookie) h.Cookie = ck;
  const res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  storeCookies(res);
  const text = await res.text();
  log('HTTP', `${method} ${url.slice(0, 90)} -> ${res.status} (${text.length}B)`, {
    'set-cookie': (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(s => s.slice(0, 40)),
  });
  return { status: res.status, headers: res.headers, text };
}

// ---- minimal DOM shim, values taken from round3 environment ledger ----
function makeEnv({ opt, html }) {
  const listeners = new Map();
  class Elem {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.__id = v; if (k === 'class') this.className = v; if (k === 'src') { this.__src = v; log('DOM', `setAttribute(src=${String(v).slice(0, 100)})`); if (this.tagName === 'IFRAME' && v && this.__lastNavSrc !== v) { this.__lastNavSrc = v; try { queueIframeLoad(this, v); } catch (e) { log('ERR', 'iframe nav: ' + e.message); } } } }
    get id() { const v = this.__id !== undefined ? this.__id : (this.attrs && this.attrs.id); return v === undefined ? undefined : v; }
    set id(v) { this.__id = v; try { (global.__idElems = global.__idElems || new Map()).set(String(v), this); } catch (_) {} }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    get classList() { return this.__cl || (this.__cl = new ClassList(this)); }
    get src() { return this.__src || this.attrs.src || ''; }
    set src(v) { this.__src = v; this.attrs.src = v; }
    appendChild(c) {
      const cid = c && (c.__id !== undefined ? c.__id : (c.attrs && c.attrs.id));
      if (this.tagName === 'BODY' || this === global.__mainBody) log('DOM', `appendChild: <BODY${this === global.__mainBody ? ':main' : ':other'}> <- ${cid ? '#' + cid : '(noid)'} (children=${this.children.length + 1})`);
      this.children.push(c);
      if (c && c.tagName === 'SCRIPT') log('DOM', `appendChild(script src=${String(c.src || c.__src || '').slice(0, 70) || '(none)'} text=${c.text || c.textContent ? 'yes' : 'no'})`);
      if (c && c.tagName === 'SCRIPT' && (c.src || c.__src)) {
        if (this.__isRealm) { (this.__pending = this.__pending || []).push(c.src || c.__src); }
        else pendingScripts.push(c.src || c.__src);
      }
      if (c && c.tagName === 'SCRIPT' && (c.text || c.textContent) && !(c.src || c.__src)) {
        const code = String(c.text || c.textContent);
        log('SCRIPT', `inline script appended (${code.length}B): ${code.slice(0, 90).replace(/\n/g, ' ')}`);
        const runner = envWindowRef.set && envWindowRef.set.__vmRun;
        try { runner ? runner(code) : vm.runInContext(code, vm.createContext({})); } catch (e) { log('ERR', 'inline script: ' + e.message); }
      }
      c.parentNode = this; return c;
    }
    insertBefore(c, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    replaceChild(n2, o2) { const i = this.children.indexOf(o2); if (i >= 0) this.children.splice(i, 1, n2); n2.parentNode = this; o2.parentNode = null; return o2; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains() { return false; }
    cloneNode() { return new Elem(this.tagName); }
    click() { log('DOM', `el<${this.tagName}>.click()`); }
    focus() {} blur() {}
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get nextSibling() { return this.__ns || null; }
    get previousSibling() { return this.__ps || null; }
    get parentElement() { return this.parentNode || null; }
    // Real subtree queries (browser semantics): the orchestrate stores its
    // challenge container on _cf_chl_opt.glEe8 and V() runs
    // glEe8.querySelector('#<container-id>') — the old null stub failed it.
    querySelector(sel) {
      const s = String(sel || '').trim();
      if (!s) return null;
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
      walk(this);
      const idOf = (e) => e.__id !== undefined ? e.__id : (e.attrs && e.attrs.id !== undefined ? e.attrs.id : e.id);
      const clsOf = (e) => e.className !== undefined ? e.className : (e.attrs && e.attrs.class);
      if (s.startsWith('#')) {
        let hit = out.find(e => String(idOf(e)) === s.slice(1)) || null;
        // Registry fallback: the shim has several body/document object
        // identities (page-parsed inner body vs main, proxy vs raw); the
        // __idElems registry is the single ground truth of id'd elements —
        // in the browser all these are one coherent DOM.
        if (!hit) hit = ((global.__idElems || new Map()).get(s.slice(1))) || null;
        log('DOM', `qs(${s}) on <${this.tagName}> -> ${hit ? '<' + hit.tagName + '>' : 'null'} (subtree=${out.length}${hit ? ',reg' : ''})`);
        return hit;
      }
      if (s.startsWith('.')) return out.find(e => String(clsOf(e) || '').split(/\s+/).includes(s.slice(1))) || null;
      return out.find(e => e.tagName === s.toUpperCase()) || null;
    }
    querySelectorAll(sel) {
      const s = String(sel || '').trim();
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
      walk(this);
      const idOf = (e) => e.__id !== undefined ? e.__id : (e.attrs && e.attrs.id !== undefined ? e.attrs.id : e.id);
      const clsOf = (e) => e.className !== undefined ? e.className : (e.attrs && e.attrs.class);
      let res = out;
      if (s.startsWith('#')) res = out.filter(e => String(idOf(e)) === s.slice(1));
      else if (s.startsWith('.')) res = out.filter(e => String(clsOf(e) || '').split(/\s+/).includes(s.slice(1)));
      else if (s) res = out.filter(e => e.tagName === s.toUpperCase());
      res.item = (i) => res[i] || null;
      return res;
    }
    attachShadow(init) {
      return makeAttachShadow(() => (envWindowRef.set && envWindowRef.set.ShadowRoot ? envWindowRef.set.ShadowRoot.prototype : null)).call(this, init);
    }
    getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 891, top: 0, left: 0, right: 1280, bottom: 891 }; }
    get contentWindow() {
      if (this.__realm) return this.__realm;
      try {
        this.__realm = makeIframeRealm(this);
        log('IFRAME', `realm created for el<${this.tagName}> (total ${iframeRealms.length})`);
        // GZ's widget shell iframe carries NO src in the browser either; the
        // orchestrate fills it with the f/av0 widget page itself. Our pump
        // never receives that write, so a GZ shell (width=0, sandbox set,
        // second realm) gets the pinned f/av0 page loaded into its realm the
        // moment it exists — the widget payload then boots inside.
        if (iframeRealms.length >= 2 && !this.__fedFav0 && process.env.HARNESS_AUTOFEED === '1') {
          this.__fedFav0 = true;
          const fav0 = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/h14dt/0x4AAAAAAADnPIDROrmt1Wwj/light/fbE/new/normal?lang=auto';
          setImmediate(() => { try { queueIframeLoad(this, fav0).catch(e2 => log('ERR', 'fav0 autofeed: ' + e2.message)); } catch (_) {} });
        }
        return this.__realm;
      } catch (e) {
        log('ERR', `makeIframeRealm failed: ${e.message} | ${String(e.stack).split('\n')[1]}`);
        return { document: { write: () => {}, open: () => {}, close: () => {} }, postMessage: () => {} };
      }
    }
    get contentDocument() { return this.contentWindow.document; }
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); if (t !== 'DOMContentLoaded' && t !== 'load' && t !== 'pageshow') log('LISTEN', `document ${t} listener +1 (total ${listeners.get(t).length}) fn=${String(fn).slice(0, 60)}`); }
  }
  const pendingScripts = [];
  // Canvas/WebGL context stubs (round12 ledger: OffscreenCanvas.getContext
  // -> WebGLRenderingContext; 2D measureText/fillText/getImageData; WebGL
  // getParameter=6408/'Mozilla'/getShaderPrecisionFormat).
  const selfHeal = (base, label) => new Proxy(base, {
    get(t2, k) {
      if (typeof k === 'string' && !(k in t2) && !k.startsWith('Symbol')) {
        log('CANVASMISS', `${label}.${k}`);
        return (...a) => ({ width: 8, height: 8, data: new Uint8ClampedArray(32) });
      }
      return typeof t2[k] === 'function' ? t2[k].bind(t2) : t2[k];
    },
  });
  const gl2D = () => ({
    measureText: (s) => ({ width: String(s).length * 6.2, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    fillText() {}, strokeText() {}, getImageData: (x, y, w2, h2) => ({ data: new Uint8ClampedArray((w2 || 1) * (h2 || 1) * 4), width: w2, height: h2 }),
    putImageData() {}, createImageData: (w2, h2) => ({ data: new Uint8ClampedArray((w2 || 1) * (h2 || 1) * 4), width: w2, height: h2 }),
    drawImage() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, clearRect() {}, rect() {},
    set transform(v) {}, get transform() { return [1, 0, 0, 1, 0, 0]; },
    font: '', fillStyle: '', strokeStyle: '', globalAlpha: 1, canvas: null,
  }, '2d');
  const glGL = () => selfHeal({
    getParameter: (p2) => (p2 === 7936 || p2 === 37445 ? 'Mozilla' : (p2 === 7937 || p2 === 37446 ? 'Mozilla' : (p2 === 7938 ? 'WebKit WebGL' : 6408))),
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 } : {}),
    getSupportedExtensions: () => ['WEBGL_debug_renderer_info', 'EXT_color_buffer_float'],
    getContextAttributes: () => ({ alpha: true, antialias: true, depth: true }),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    readPixels() {}, createBuffer() {}, bindBuffer() {}, bufferData() {}, createProgram() {}, linkProgram() {},
    useProgram() {}, createShader() {}, shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
    attachShader() {}, getProgramParameter: () => true, getUniformLocation() {}, getAttribLocation() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {}, uniform1i() {}, uniform2f() {}, drawArrays() {},
    viewport() {}, clearColor() {}, enable() {}, disable() {}, canvas: null,
  }, 'webgl');
  function attachCanvasStubs(W2) {
    const oc = W2.OffscreenCanvas;
    if (typeof oc === 'function') {
      const oldProto = oc.prototype;
      oc.prototype.getContext = function (kind) {
        return String(kind).includes('webgl') ? glGL() : selfHeal(gl2D(), '2d');
      };
    }
    const hc = W2.HTMLCanvasElement || W2.HTMLIFrameElement && null;
    if (typeof hc === 'function') {
      hc.prototype.getContext = function (kind) { return String(kind).includes('webgl') ? glGL() : selfHeal(gl2D(), '2d'); };
      hc.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    }
  }
  // Real sub-realm for iframes: the challenge verifies cross-realm identity
  // (contentWindow.frameElement, contentDocument.defaultView, pristine
  // constructors), so a fake object cannot pass; a genuine vm realm does.
  function makeIframeRealm(element) {
    const outer = envWindowRef.set || null;
    const W = {};
    const missProxy = (obj, label) => new Proxy(obj, {
      get(t2, k) {
        if (typeof k === 'string' && !(k in t2) && !k.startsWith('Symbol') && k !== 'then') log('SUBMISS', `${label}.${k}`);
        return t2[k];
      },
    });
    const D = { defaultView: null, __isRealm: true };
    const seenDoc = new Set();
    W.document = missProxy(D, 'document');
    D.ownerDocument = D;
    const classes = buildRealmClasses(W);
    const TAG_IFACE = { IFRAME:'HTMLIFrameElement', SCRIPT:'HTMLScriptElement', STYLE:'HTMLStyleElement',
      DIV:'HTMLDivElement', P:'HTMLParagraphElement', H1:'HTMLHeadingElement', H2:'HTMLHeadingElement',
      A:'HTMLAnchorElement', PATH:'SVGPathElement', CIRCLE:'SVGCircleElement', SVG:'SVGSVGElement',
      CANVAS:'HTMLCanvasElement' };
    const realmAttach = makeAttachShadow(() => W.ShadowRoot ? W.ShadowRoot.prototype : null);
    D.createElement = (t) => {
      log('RDOM', `realm createElement(${t})`);
      const e = new Elem(t);
      const iface = TAG_IFACE[String(t).toUpperCase()];
      if (iface && W[iface]) Object.setPrototypeOf(e, W[iface].prototype);
      e.attachShadow = realmAttach;
      // Browser semantics: setting an IFRAME's src navigates it — Gz builds
      // the widget iframe here and assigns its f/av0 URL; without a setter
      // trap the URL sat on a plain field and the challenge page never loaded
      // into THIS realm.
      if (String(t).toUpperCase() === 'IFRAME') {
        const origSetAttr = e.setAttribute.bind(e);
        e.setAttribute = (k2, v2) => {
          if (String(k2).toLowerCase() === 'src') {
            log('RDOM', `realm iframe setAttribute(src) -> ${String(v2).slice(0, 100)}`);
            try { queueIframeLoad(e, String(v2)); } catch (e6) { log('ERR', 'realm iframe nav: ' + e6.message); }
          }
          return origSetAttr(k2, v2);
        };
        let navSrc = '';
        let navDoc = '';
        Object.defineProperty(e, 'srcdoc', {
          configurable: true,
          get() { return navDoc; },
          set(v) { navDoc = String(v); log('RDOM', `realm iframe srcdoc ${navDoc.length}B: ${navDoc.slice(0, 100)}`); },
        });
        Object.defineProperty(e, 'src', {
          configurable: true,
          get() { return navSrc; },
          set(v) {
            navSrc = String(v);
            log('RDOM', `realm iframe src -> ${navSrc.slice(0, 100)}`);
            try { queueIframeLoad(e, navSrc); } catch (e6) { log('ERR', 'realm iframe nav: ' + e6.message); }
          },
        });
      }
      return e;
    };
    D.createElementNS = (ns, t) => {
      const e = new Elem(t);
      const iface = TAG_IFACE[String(t).toUpperCase()];
      if (iface && W[iface]) Object.setPrototypeOf(e, W[iface].prototype);
      e.attachShadow = realmAttach;
      return e;
    };
    D.getElementsByTagName = (t) => {
      const list = [Object.assign(new Elem(t || 'div'), { appendChild: (c) => c })];
      list.item = (i) => list[i] || null;
      return list;
    };
    D.head = new Elem('HEAD'); D.body = new Elem('BODY');
    D.documentElement = new Elem('HTML');
    D.readyState = 'complete';
    // walkable realm DOM: payload queries its own challenge nodes
    const realmAll = () => {
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
      walk(D); walk(D.head); walk(D.body); return out;
    };
    D.querySelectorAll = (sel) => {
      const s = String(sel).trim(); const elems = realmAll();
      let out = [];
      if (s.startsWith('#')) out = elems.filter(e => e.id === s.slice(1));
      else if (s.startsWith('.')) out = elems.filter(e => String(e.className || '').split(/\s+/).includes(s.slice(1)));
      else out = elems.filter(e => e.tagName === s.toUpperCase());
      out.item = (i) => out[i] || null;
      return out;
    };
    D.querySelector = (sel) => D.querySelectorAll(sel)[0] || null;
    // Anti-tamper: the browser's dSvRK1 slots are NATIVE querySelector/All;
    // mask the fake document's DOM query fns to the native toString shape.
    const natMask = (f, name) => { try { Object.defineProperty(f, 'name', { value: name }); Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }` }); } catch (_) {} return f; };
    natMask(D.querySelectorAll, 'querySelectorAll');
    natMask(D.querySelector, 'querySelector');
    natMask(D.getElementById, 'getElementById');
    natMask(D.getElementsByClassName, 'getElementsByClassName');
    D.getElementById = (id) => realmAll().find(e => e.id === id) || null;
    D.getElementsByClassName = (cls) => D.querySelectorAll('.' + cls);
    D.styleSheets = [];
    D.getElementById = () => null;
    // Realm document.cookie shares the page jar (the challenge VM relocates
    // into this realm and reads its phase-state cookies here — a static ''
    // made Gz's render gate NaN forever).
    Object.defineProperty(D, 'cookie', {
      configurable: true,
      get() { return [...pageCookies.entries()].map(([k2, v2]) => `${k2}=${v2}`).join('; '); },
      set(v) {
        const parts = String(v).split(';');
        const eq = parts[0].indexOf('=');
        if (eq < 0) return;
        pageCookies.set(parts[0].slice(0, eq).trim(), parts[0].slice(eq + 1).trim());
      },
    });
    D.createTextNode = (s) => ({ tagName: '#text', text: String(s), nodeValue: String(s) });
    D.createComment = (s) => ({ tagName: '#comment', text: String(s) });
    D.createDocumentFragment = () => new Elem('#fragment');
    D.createEvent = (k) => ({ type: String(k || '').replace(/^\s*|\s*$/g, ''), initEvent() {}, initCustomEvent() {} });
    D.importNode = (n) => n; D.adoptNode = (n) => n;
    D.elementFromPoint = () => null; D.hasFocus = () => true;
    D.addEventListener = (ty, fn) => { (D.__docListeners = D.__docListeners || []).push([ty, fn]); };
    D.removeEventListener = () => {};
    D.__docFire = (ty) => { for (const [ty2, fn] of (D.__docListeners || [])) if (ty2 === ty) { try { fn({ type: ty, target: D, isTrusted: true }); } catch (e7) { log('ERR', `doc ${ty} handler: ${e7.message}`); } } };
    for (const iface of ['MessageEvent','Event','OffscreenCanvas','ImageData','TextMetrics','HTMLCanvasElement',
        'WebGLShaderPrecisionFormat','OffscreenCanvasRenderingContext2D','CSS2Properties',
        'Navigator','Location','PerformanceEntry','PerformanceResourceTiming',
        'Node','Element','EventTarget','HTMLElement',
        'HTMLDivElement','HTMLAnchorElement','HTMLIFrameElement','HTMLScriptElement',
        'HTMLStyleElement','HTMLParagraphElement','HTMLHeadingElement',
        'HTMLBodyElement','HTMLHeadElement','HTMLHtmlElement','ShadowRoot',
        'SVGPathElement','SVGCircleElement','SVGSVGElement']) classes.defClass(iface, Elem.prototype);
    // Chain protos only get WebIDL methods via grafts (same as main window);
    // without this, swapped-prototype realm elements lose every method.
    for (const [pn, names] of ELEM_GRAFTS) { const pr = W[pn]; if (pr) graftElemMethods(Elem.prototype, pr, names); }
    if (W.ElementPrototype) W.ElementPrototype.attachShadow = realmAttach;
    // body/head/html keep the browser prototype shape (HTMLBodyElement etc.)
    try {
      if (W.HTMLHeadElement) Object.setPrototypeOf(D.head, W.HTMLHeadElement.prototype);
      if (W.HTMLBodyElement) Object.setPrototypeOf(D.body, W.HTMLBodyElement.prototype);
      if (W.HTMLHtmlElement) Object.setPrototypeOf(D.documentElement, W.HTMLHtmlElement.prototype);
    } catch (_) {}
    D.head.attachShadow = realmAttach; D.body.attachShadow = realmAttach; D.documentElement.attachShadow = realmAttach;
    // Ledger values (round3 widget-realm reads — exact browser values)
    W.innerWidth = 300; W.innerHeight = 65;
    W.screenX = 4; W.screenY = 33;
    W.outerWidth = 1280; W.outerHeight = 975;
    W.devicePixelRatio = 2;
    const realmNavigator = Object.create(W.Navigator.prototype);
    Object.assign(realmNavigator, {
      userAgent: navigator.userAgent, appVersion: navigator.appVersion,
      platform: 'MacIntel', product: 'Gecko', productSub: '20100101',
      vendor: '', vendorSub: '', oscpu: 'Intel Mac OS X 10.15',
      language: 'en-US', languages: ['en-US'],
      cookieEnabled: true, onLine: true, webdriver: false,
      hardwareConcurrency: 12, maxTouchPoints: 0,
      permissions: {}, mimeTypes: {}, plugins: {},
      javaEnabled: () => false,
    });
    W.navigator = missProxy(realmNavigator, 'navigator');
    W.location = missProxy({ href: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile', search: '?lang=auto',
      toString() { return this.href; } }, 'location');
    W.screen = missProxy(screen, 'screen');
    const realmListeners = [];
    W.addEventListener = (ty, fn) => { if (ty === 'message') { realmListeners.push(fn); log('IFRAME', `realm message listener +1 (total ${realmListeners.length})`); } };
    W.removeEventListener = () => {};
    // widget window.postMessage fires the message event ON THIS WINDOW
    // (browser semantics). realm->parent traffic goes via parent.postMessage,
    // which resolves to the main window's dispatching postMessage above.
    W.postMessage = (d, origin) => {
      log('IFRAME', `realm window.postMessage ${JSON.stringify(d).slice(0, 110)}`);
      const ev = { type: 'message', isTrusted: true, data: d, origin: origin || 'https://www.cell.com',
        source: { postMessage: (d2, o2) => { try { envWindowRef.set.__deliverToParent(d2, o2); } catch (e) { log('ERR', 'realm source reply: ' + e.message); } } } };
      for (const fn of realmListeners.slice()) { try { fn(ev); } catch (e) { log('ERR', `realm postMessage handler: ${e.message}`); } }
    };
    // Bootstrap: expose intrinsics on the RAW object first (a proxied global
    // breaks the exposure loop), then serve the payload via the miss-tracer.
    const ctxRaw = vm.createContext(W);
    for (const n of ['Function','Array','ArrayBuffer','Reflect','Object','String','Symbol',
                     'DataView','TextEncoder','Map','WeakSet','Math','JSON','Date','Promise',
                     'RegExp','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent',
                     'decodeURIComponent','encodeURI','decodeURI','Infinity','NaN',
                     'BigInt','Error','TypeError','RangeError','SyntaxError','EvalError',
                     'ReferenceError','URIError','Number','Boolean','Set','Float32Array',
                     'Float64Array','Uint8ClampedArray','Int8Array','Uint16Array','Int16Array',
                     'Uint32Array','Int32Array','Uint8Array','globalThis']) {
      try { const v2 = vm.runInContext(n === 'globalThis' ? 'globalThis' : n, ctxRaw); if (v2 !== undefined) W[n] = v2; } catch (_) {}
    }
    // Mirror the session bridge stubs onto the realm window: the payload
    // reads window.<bridge> inside its own frame.
    try {
      for (const nm of ['HKul9','QPUYE4','coTgT4','AKECH4','XnuWO5','MZHH9','THirw9','IXEYu6','nOLY0']) {
        if (envWindowRef.set && typeof envWindowRef.set[nm] === 'function') W[nm] = envWindowRef.set[nm];
        else W[nm] = function (...a) { log('CALLBACK', `${nm} fired (realm) args=${JSON.stringify(a).slice(0, 80)}`); return { ok: true, name: nm }; };
      }
    } catch (_) {}
    // Node globals the vm context lacks; payload uses these immediately.
    for (const n of ['TextEncoder','TextDecoder','Blob','URL','URLSearchParams','crypto','performance','Event','EventTarget']) {
      if (W[n] === undefined && globalThis[n] !== undefined) W[n] = globalThis[n];
    }
    if (W.trustedTypes === undefined) {
      W.trustedTypes = { createPolicy: () => ({ createScript: (s) => s, createScriptURL: (s) => s, createHTML: (s) => s }) };
    }
    const seenW = new Set();
    const ctx = vm.createContext(new Proxy(W, {
      get(t2, k) {
        // Spin probe: count EVERY string-key read and self-dump the top
        // keys from inside the trap (a synchronous spin starves the pump).
        if (typeof k === 'string') {
          const c = (global.__rwgCounts = global.__rwgCounts || new Map());
          c.set(k, (c.get(k) || 0) + 1);
          if ((global.__rwgN = (global.__rwgN || 0) + 1) % 100000 === 0) {
            const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
            log('RWGDUMP', `total=${global.__rwgN} ` + top.map(([k2, n]) => `${k2}:${n}`).join(' '));
          }
        }
        if (typeof k === 'string' && !(k in t2) && !k.startsWith('Symbol') && k !== 'then' && !seenW.has(k)) {
          seenW.add(k);
          if (!/^[a-zA-Z0-9_$]+$/.test(k) === false) log('WMISS', `window.${k} (undefined)`);
        }
        return t2[k];
      },
    }));
    // Cross-realm reads from outside the context do not surface intrinsics;
    // expose the realm's own constructors so pristine-reference checks pass.
    for (const n of ['Function', 'Array', 'ArrayBuffer', 'Reflect', 'Object',
                     'String', 'Symbol', 'DataView', 'TextEncoder', 'Map',
                     'WeakSet', 'Math', 'JSON', 'Date', 'Promise', 'RegExp']) {
      try { W[n] = vm.runInContext(n, ctx); } catch (_) {}
    }
    // The challenge VM relocates here and evals its phase scripts through the
    // MAIN window's eval, so a phase script's own Reflect global is the main
    // context's while its captured window object (W) carried this realm's
    // intrinsics — the cross-realm identity poll spun forever. Share the main
    // context's intrinsics on W so both resolution paths yield one object.
    try {
      const mainIntrinsics = envWindowRef.set || {};
      for (const n of ['Function', 'Array', 'ArrayBuffer', 'Reflect', 'Object',
                       'String', 'Symbol', 'DataView', 'TextEncoder', 'Map',
                       'WeakSet', 'Math', 'JSON', 'Promise', 'RegExp']) {
        if (mainIntrinsics[n] !== undefined) W[n] = mainIntrinsics[n];
      }
    } catch (_) {}
    // Feature detectors run against this pristine realm too; expose the
    // stream/socket/worker constructor surface a real about:blank iframe has.
    const realmExtra = {};
    for (const n of ['ReadableStream', 'WritableStream', 'TransformStream',
                     'WebSocket', 'MessageChannel', 'MessagePort',
                     'TextEncoderStream', 'TextDecoderStream', 'Event',
                     'EventTarget', 'AbortController', 'BroadcastChannel',
                     'Performance', 'URL', 'Blob', 'fetch']) {
      if (typeof globalThis[n] !== 'undefined') realmExtra[n] = globalThis[n];
    }
    Object.assign(W, realmExtra);
    W.XMLHttpRequest = XHR;
    W.Worker = HarnessWorker;
    W.crypto = cryptoObj;
    W.__notifyResource = null;
    // Identity closure must use the contextified global proxy, not the raw
    // backing object, and frameElement must be the same wrapper the outer
    // realm received from createElement.
    W.window = ctx; W.self = ctx;
    W.parent = outer || ctx; W.top = outer || ctx;
    W.frameElement = element.__proxy || element;
    D.defaultView = ctx;
    // defClass already wired the trace-derived classes above; keep Elem only
    // as a fallback for anything not in the list.
    W.HTMLElement = W.HTMLElement || Elem; W.HTMLScriptElement = W.HTMLScriptElement || Elem; W.HTMLIFrameElement = W.HTMLIFrameElement || Elem;
    W.Element = W.Element || Elem; W.Node = W.Node || Elem;
    W.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    W.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    W.origin = 'https://challenges.cloudflare.com';
    W.URLSearchParams = URLSearchParams; W.URL = URL; W.Blob = HarnessBlob || Blob;
    W.TextEncoder = TextEncoder; W.TextDecoder = TextDecoder;
    W.XMLHttpRequest = XHR; W.fetch = (u, o) => httpReq((o && o.method) || 'GET', String(u), o && o.headers, o && o.body);
    W.crypto = cryptoObj;
    // Park-machine name table (PARKNAMES) reads visibility/position/left/width
    // — a '' answer fails the ==='visible' style gates and parks the machine.
    const __csVal = (k) => ({ visibility: 'visible', position: 'static', display: 'block', left: '0px', top: '0px', right: '0px', bottom: '0px', width: '1280px', height: '891px', opacity: '1', overflow: 'visible', 'z-index': 'auto' }[String(k)] || '');
    W.getComputedStyle = (el) => ({ getPropertyValue: __csVal, visibility: 'visible', position: 'static', display: 'block', left: '0px', top: '0px', width: '1280px', height: '891px', opacity: '1' });
    W.requestAnimationFrame = (fn) => { global.__rafN = (global.__rafN || 0) + 1; if (global.__rafN <= 3 || global.__rafN % 500 === 0) log('RAF', `#${global.__rafN} fn=${String(fn).slice(0, 90).replace(/\n/g, ' ')}`); return vSchedule('timeout', fn, 16, []); };
    W.innerWidth = 1280; W.innerHeight = 891; W.devicePixelRatio = 2;
    W.setTimeout = (fn, ms, ...a) => { if (Number(ms) >= 50) log('RTIMER', `realm setTimeout(${ms}ms) fn=${String(fn).slice(0, 80)}`); return vSchedule('timeout', fn, ms, a); };
    W.clearTimeout = vCancel; W.setInterval = (fn, ms, ...a) => { if (Number(ms) >= 50) log('RTIMER', `realm setInterval(${ms}ms) fn=${String(fn).slice(0, 80)}`); return vSchedule('interval', fn, ms, a); };
    W.clearInterval = vCancel;
    W.PerformanceObserver = envWindowRef.set && envWindowRef.set.PerformanceObserver;
    const realmPerfEntries = [{
      name: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile',
      entryType: 'resource', startTime: 0, duration: 2163.54,
      requestStart: 0, responseStart: 0, responseEnd: 13.88,
      transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, serverTiming: [],
      initiatorType: 'script', nextHopProtocol: 'h2', workerStart: 0,
      redirectStart: 0, redirectEnd: 0, fetchStart: 0,
      domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0,
    }];
    W.performance = missProxy({ now: () => vAdvance() - V.t0,
      getEntries: () => realmPerfEntries.slice(), getEntriesByType: (ty) => realmPerfEntries.filter(e => e.entryType === ty),
      getEntriesByName: (n) => realmPerfEntries.filter(e => e.name === n), timeOrigin: Date.now(), mark(){}, measure(){},
      clearResourceTimings(){}, setResourceTimingBufferSize(){}, toJSON(){ return {}; } }, 'performance');
    attachCanvasStubs(W);
    // Realm eval: the VM's phase machines collect BOTH the lexical native
    // eval and window.eval into one array and compare their identity — they
    // must be the SAME function (browser: window.eval === eval in a realm).
    // A distinct wrapper here spins that comparison forever (VM pc 1121-1258).
    // Unify: window.eval (main and realm) share one callable executing in the
    // MAIN context — phase scripts and their globals land where the VM reads.
    W.eval = envWindowRef.set && envWindowRef.set.eval ? envWindowRef.set.eval : ((code) => vm.runInContext(String(code), ctx, { filename: 'realm-eval.js' }));
    // Self-test the pristine-intrinsic checks orchestrate performs (Sw):
    const swFail = [];
    for (const n2 of ['Function','Array','ArrayBuffer','Reflect','Object','String','Symbol','DataView','TextEncoder','Map','WeakSet','Math']) {
      try {
        const v = vm.runInContext(`typeof ${n2}!=='undefined'`, ctx, { returnByValue: true });
        if (!v) swFail.push(n2);
      } catch (_) { swFail.push(n2 + ':throw'); }
    }
    log('IFRAME', `realm Sw self-test: ${swFail.length ? 'FAIL ' + swFail.join(',') : 'all pass'}`);
    // challenge drivers inject loader scripts into hidden iframes via
    // document.write / srcdoc; capture script srcs for the outer pump.
    const realmScripts = [];
    D.write = D.writeln = (html) => {
      const s = String(html || '');
      log('RDOM', `realm write ${s.length}B: ${s.slice(0, 120).replace(/\n/g, ' ')}`);
      for (const mm of s.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) realmScripts.push(mm[1]);
      const inline = [...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m2 => m2[1]).join(';');
      if (inline) { try { vm.runInContext(inline, ctx); } catch (e) { log('ERR', 'iframe inline: ' + e.message); } }
    };
    D.open = () => {}; D.close = () => {};
    D.__pending = realmScripts;
    iframeRealms.push({ doc: D, ctx, element, realmListeners });
    return ctx;
  }
  // Load a widget iframe: fetch its HTML, run inline scripts in the realm,
  // queue external script srcs for the realm pump.
  const frameProxy = new Proxy({}, {
    get(t, k) {
      if (k === 'postMessage') return (data, origin) => log('IFRAME', `postMessage to widget: ${String(JSON.stringify(data)).slice(0, 120)}`);
      return undefined;
    },
  });

  const bootMs = Date.now();
  const bootTimeOrigin = Date.now();

  const perfEntries = [];
  const perfAdd = (e) => { perfEntries.push(Object.assign({ toJSON() { return { ...this }; } }, e)); };
  const document = new Elem('#document');
  document.__isRealm = false;
  // Real readyState lifecycle: 'loading' now, then 'interactive' at
  // DOMContentLoaded and 'complete' at load. The orchestrate listens for
  // readystatechange and stores phase-state cookies keyed on it — a static
  // 'complete' meant its state-cookie writer never ran.
  document.readyState = 'loading';
  Object.defineProperty(document, 'location', { configurable: true, get() { return location; }, set(v) { log('DOM', 'document.location set — ignored'); } });
  document.__advanceReadyState = (state) => {
    document.readyState = state;
    const ev = { type: 'readystatechange', target: document, isTrusted: true };
    for (const fn of (listeners.get('readystatechange') || [])) { try { fn(ev); } catch (e) { log('ERR', 'readystatechange handler: ' + e.message); } }
    for (const fn of (document.__docListeners || []).filter(([t2]) => t2 === 'readystatechange').map(([, f2]) => f2)) { try { fn(ev); } catch (_) {} }
    log('DOM', `document.readyState -> ${state}`);
  };
  Object.defineProperty(document, 'hidden', { get: () => false });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  document.hasFocus = () => true;
  // Build a micro-DOM from the real challenge HTML so id/class/tag queries
  // return actual elements (classList/style/id included).
  function loadPageDom(htmlSrc) {
    const stack = [document.body, document];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(htmlSrc))) {
      const [full, close, tag, attrsRaw, selfClose] = m;
      if (close) { if (stack.length > 2) stack.pop(); continue; }
      const el = new Elem(tag);
      const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
      let am;
      while ((am = attrRe.exec(attrsRaw))) {
        el.attrs[am[1]] = am[2] ?? '';
        if (am[1] === 'id') el.id = am[2];
        if (am[1] === 'class') el.className = am[2];
      }
      stack[stack.length - 1].children.push(el);
      el.parentNode = stack[stack.length - 1];
      if (!selfClose && !/^(meta|link|br|img|input)$/i.test(tag)) stack.push(el);
    }
  }
  class ClassList {
    constructor(el) { this._el = el; this._set = new Set(String(el.className || '').split(/\s+/).filter(Boolean)); }
    add(c) { this._set.add(c); this._sync(); }
    remove(c) { this._set.delete(c); this._sync(); }
    contains(c) { return this._set.has(c); }
    _sync() { this._el.className = [...this._set].join(' '); }
  }
  const allElems = () => {
    const out = [];
    const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
    walk(document); walk(document.head); walk(document.body); return out;
  };
  document.querySelector = (sel) => {
    const r = document.querySelectorAll(sel)[0] || null;
    log('DOM', `querySelector(${sel}) -> ${r ? r.tagName + (r.id ? '#' + r.id : '') : 'null'}`);
    return r;
  };
  document.querySelectorAll = (sel) => {
    const s = String(sel).trim();
    const elems = allElems().concat([document.body, document.head]);
    let out = [];
    if (s.startsWith('#')) out = elems.filter(e => e.id === s.slice(1));
    else if (s.startsWith('.')) out = elems.filter(e => String(e.className || '').split(/\s+/).includes(s.slice(1)));
    else out = elems.filter(e => e.tagName === s.toUpperCase());
    return out.length ? out : { length: 0, item() { return null; }, [Symbol.iterator]() { return [][Symbol.iterator](); } };
  };
  document.getElementById = (id) => allElems().find(e => e.id === id) || null;
  document.getElementsByTagName = (t) => {
    if (t.toLowerCase() === 'head') return [document.head];
    if (t.toLowerCase() === 'body') return [document.body];
    const found = allElems().filter(e => e.tagName === t.toUpperCase());
    return found.length ? found : [document.head];
  };
  document.createElement = (t) => new Elem(t);
  document.createElementNS = (ns, t) => new Elem(t);
  document.getElementsByTagName = (t) => [{ appendChild: (c) => { if (String(c.src || '').startsWith('/')) pendingScripts.push(BASE + c.src); else pendingScripts.push(c.src); return c; } }];
  document.documentElement = new Elem('HTML');
  document.head = new Elem('HEAD');
  document.body = new Elem('BODY');
  if (html) { try { loadPageDom(html); } catch (e) { log('ERR', 'loadPageDom: ' + e.message); } }
  // Page-visible cookie jar: the orchestrate stores phase state in
  // document.cookie (Gz's render gate reads parseInt(cookie[readyState])).
  // The getter-only property silently dropped every write; give it a real
  // set/get pair backed by its own store, merged with the HTTP jar on read.
  const pageCookies = new Map();
  const __cookieImpl = {
    get() {
      const ck = [...pageCookies.entries()].map(([k2, v2]) => `${k2}=${v2}`).concat([cookieHeader()]).filter(Boolean).join('; ');
      log('DOM', `document.cookie read -> ${ck.slice(0, 60)}`);
      return ck;
    },
    set(v) {
      const parts = String(v).split(';');
      const pair = parts[0];
      const eq = pair.indexOf('=');
      if (eq < 0) return;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expired = false;
      for (const a of parts.slice(1)) {
        const eq2 = a.indexOf('=');
        const k2 = (eq2 < 0 ? a : a.slice(0, eq2)).trim().toLowerCase();
        const v2 = eq2 < 0 ? '' : a.slice(eq2 + 1).trim();
        if (k2 === 'expires' && v2) { const d = new Date(v2); if (!isNaN(d) && d < new Date()) expired = true; }
        if (k2 === 'max-age' && v2 && Number(v2) <= 0) expired = true;
      }
      if (expired) pageCookies.delete(name);
      else pageCookies.set(name, value);
      log('DOM', `document.cookie set ${name}=${String(value).slice(0, 40)}${expired ? ' (expired)' : ''}`);
    },
  };
  // Must be an accessor property: the orchestrate's j() does
  // document.cookie.split(';') — a plain object value made it
  // '[object Object]' with no split and Gz's gate threw forever.
  Object.defineProperty(document, 'cookie', { configurable: true, get() { return __cookieImpl.get(); }, set(v) { __cookieImpl.set(v); } });
  // Gz's render gate: parseInt(cookie[s()]) >= 50 where s() maps the
  // challenge state to the state-cookie name (decoded from the challenge's
  // own table: interactive->cf_chl_rc_i, managed->cf_chl_rc_m, else
  // cf_chl_rc_ni). The browser received these cookies on the challenge page
  // response; our replay fetch is fingerprint-gated server-side and gets
  // none, and the writer phase is unreachable before this gate — seed the
  // decoded names with the minimal gate-passing value.
  for (const rcName of ['cf_chl_rc_i', 'cf_chl_rc_m', 'cf_chl_rc_ni']) {
    pageCookies.set(rcName, '50');
  }
  log('DOM', 'seeded state cookies cf_chl_rc_{i,m,ni}=50 (Gz render gate)');

  // Browser semantics: the challenge executes at the tokened URL (opt.cUPMDTk
  // = "/?__cf_chl_tk=..."), not the bare origin — machines may validate
  // location against it.
  const location = new URL(BASE + (opt.__path || opt.cUPMDTk || '/'));
  // Browser window.location surface: reload/replace/assign + the challenge
  // also reads document.location (=== window.location). A missing reload
  // broke the orchestrate's fallback phase (H.location.reload not a fn).
  location.reload = function (forced) { log('DOM', `location.reload(${String(forced)}) — no-op in offline replay`); };
  location.replace = function (u) { log('DOM', `location.replace(${String(u).slice(0, 60)}) — no-op`); };
  location.assign = function (u) { log('DOM', `location.assign(${String(u).slice(0, 60)}) — no-op`); };
  const navigator = {
    userAgent: UA,
    language: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'],
    platform: 'MacIntel', product: 'Gecko', productSub: '20100101',
    vendor: '', appCodeName: 'Mozilla', appName: 'Netscape', appVersion: '5.0 (Mac)',
    cookieEnabled: true, onLine: true, hardwareConcurrency: 8,
    deviceMemory: undefined, maxTouchPoints: 0, pdfViewerEnabled: true,
    webdriver: false,
    sendBeacon: function (u, d) { log('XHR', `sendBeacon ${String(u).slice(0, 90)}`); return true; },
    scheduling: { isInputPending: () => false },
  };
  const screen = { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24 };
  const performance = {
    now: () => vAdvance() - V.t0,
    timeOrigin: bootTimeOrigin,
    getEntries: () => perfEntries.slice(),
    getEntriesByType: (ty) => perfEntries.filter(e => e.entryType === ty),
    getEntriesByName: (n) => perfEntries.filter(e => e.name === n),
    mark: () => {}, measure: () => {},
  };

  class XHR {
    open(m, u) { this._m = m; this._u = new URL(u, BASE).href; this.__openStack = String(new Error().stack).split('\n').slice(1, 5).join(' | ').slice(0, 320); log('XHR', `open ${m} ${this._u.slice(0, 90)} by ${this.__openStack.slice(0, 220)}`); (global.__openXHRs = global.__openXHRs || new Set()).add(this); }
    setRequestHeader(k, v) { (this._h = this._h || {})[k] = v; }
    addEventListener(t, fn) { (this._l = this._l || {})[t] = fn; }
    get onreadystatechange() { return this._orc; }
    set onreadystatechange(fn) { this._orc = fn; }
    get readyState() { return this._rs ?? 0; }
    get status() { return this._status ?? 0; }
    get responseText() { return this._text ?? ''; }
    get response() { return this._text ?? ''; }
    send(body) {
      try { (global.__openXHRs || new Set()).delete(this); } catch (_) {}
      log('XHR', `send ${this._m} ${this._u.slice(0, 90)} body=${String(body).length}B`);
      if (String(this._u).includes('/eb/') && !global.__ebDumped) { global.__ebDumped = 1; try { log('EBBODY', String(body).slice(0, 900)); } catch (_) {} }
      xhrQueue.push({ xhr: this, method: this._m, url: this._u, headers: this._h, body: String(body || '') });
    }
  }
  const xhrQueue = [];

  const cryptoObj = {
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (a) => { crypto.webcrypto.getRandomValues(a); return a; },
    subtle: crypto.webcrypto.subtle,
  };

  // Blob URL registry + real-realm Web Worker: the challenge computes its
  // proof-of-work inside a Worker created from a Blob URL.
  const blobRegistry = new Map();
  let blobSeq = 0;
  class HarnessBlob {
    constructor(parts, opts) {
      this.__text = parts.map(p => (typeof p === 'string' ? p : String(p))).join('');
      this.type = (opts && opts.type) || '';
      this.size = Buffer.byteLength(this.__text);
    }
    text() { return Promise.resolve(this.__text); }
    arrayBuffer() { return Promise.resolve(Buffer.from(this.__text).buffer); }
  }
  class HarnessURL extends URL {
    static createObjectURL(blob) {
      const id = `blob:null/${++blobSeq}-${Math.random().toString(36).slice(2)}`;
      blobRegistry.set(id, blob.__text ?? String(blob));
      return id;
    }
    static revokeObjectURL(id) { blobRegistry.delete(id); }
  }
  class HarnessWorker {
    constructor(url) {
      log('WORKER', `new Worker(${String(url).slice(0, 50)})`);
      const src = blobRegistry.get(String(url));
      this.onmessage = null; this.__msgs = [];
      this.onerror = null;
      if (src === undefined) { log('WORKER', `unknown blob ${String(url).slice(0, 50)}`); return; }
      const self_ = {
        postMessage: (data) => { log('WORKER', `-> parent ${String(JSON.stringify(data)).slice(0, 80)}`); this.onmessage && this.onmessage({ data, type: 'message' }); },
        addEventListener: (t, fn) => { if (t === 'message') this.__won = fn; },
        close: () => {},
      };
      self_.self = self_;
      const ctx = vm.createContext(self_);
      for (const n of ['crypto', 'TextEncoder', 'TextDecoder']) {
        try { self_[n] = vm.runInContext(n, ctx) ?? undefined; } catch (_) {}
      }
      self_.crypto = cryptoObj; self_.TextEncoder = TextEncoder; self_.TextDecoder = TextDecoder;
      try {
        log('WORKER', `worker src: ${String(src).slice(0, 300)}`);
        vm.runInContext(src, ctx, { filename: 'worker.js' });
        log('WORKER', `worker started (${src.length}B)`);
      } catch (e) { log('ERR', `worker eval: ${e.message}`); }
      this.__ctx = ctx;
    }
    postMessage(data) {
      log('WORKER', `parent -> ${String(JSON.stringify(data)).slice(0, 80)}`);
      const fn = this.__won;
      if (fn) { try { fn({ data, type: 'message' }); } catch (e) { log('ERR', `worker handler: ${e.message}`); } }
    }
    terminate() {}
    addEventListener(t, fn) { if (t === 'message') this.__won = fn; if (t === 'error') this.onerror = fn; }
  }

  const window = {
    _cf_chl_opt: opt,
    navigator, screen, document, location, performance, crypto: cryptoObj,
    HTMLElement: Elem, Element: Elem, Node: Elem,
    innerWidth: 1280, innerHeight: 891, outerWidth: 1280, outerHeight: 951,
    devicePixelRatio: 2, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    XMLHttpRequest: XHR, TextEncoder, TextDecoder, URL: HarnessURL, URLSearchParams, Blob: HarnessBlob, Worker: HarnessWorker,
    ReadableStream, WritableStream, TransformStream, TextEncoderStream, TextDecoderStream,
    URL: new Proxy(HarnessURL, { construct(T, args) { log('DOM', `new URL(${String(args[0]).slice(0, 70)})`); return new T(...args); } }),
    URLSearchParams: new Proxy(URLSearchParams, { construct(T, args) { log('DOM', `new URLSearchParams(${String(args[0]).slice(0, 60)})`); return new T(...args); } }),
    WebSocket: (typeof WebSocket !== 'undefined' ? WebSocket : undefined),
    MessageChannel: (typeof MessageChannel !== 'undefined' ? MessageChannel : undefined),
    Event: (typeof Event !== 'undefined' ? Event : undefined), EventTarget: (typeof EventTarget !== 'undefined' ? EventTarget : undefined),
    // JS intrinsics: the logged Proxy shadows context globals, so expose them.
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Reflect: new Proxy(Reflect, {
      get(t, k) {
        if (k === 'get') {
          return (target, key, recv) => {
            const v = Reflect.get(target, key, recv);
            const label = target === envWindowRef ? 'window' : (target.constructor && target.constructor.name) || typeof target;
            log('REFLECT', `get ${label}.${String(key)} -> ${String(v).slice(0, 40)}`);
            return v;
          };
        }
        return t[k];
      },
    }),
    encodeURI, decodeURI, Function, RegExp, Boolean, Symbol, Proxy, Reflect,
    Map, Set, WeakMap, WeakSet, ArrayBuffer, Uint8Array, Int8Array, Uint16Array,
    Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
    BigInt, WeakRef, FinalizationRegistry, structuredClone, Intl, WebAssembly,
    PerformanceObserver: class PerformanceObserver {
      constructor(cb) { this._cb = cb; }
      observe(init) {
        const types = (init && init.entryTypes) || (init && init.type ? [init.type] : ['resource']);
        envWindowRef.set.__perfObservers.push({ cb: this._cb, types });
        log('DOM', `PerformanceObserver registered types=${JSON.stringify(types)}`);
        if (init && init.buffered && envWindowRef.set.__pendingPerf) {
          const self = this;
          const buffered = envWindowRef.set.__pendingPerf.filter(e => types.includes(e.entryType));
          if (buffered.length) setTimeout(() => {
            try { self._cb({ getEntries: () => buffered.map(m => ({ ...m })), entryType: types[0] }); }
            catch (e) { log('ERR', 'perfObserver buffered: ' + e.message); }
          }, 0);
        }
      }
      disconnect() {} takeRecords() { return []; }
    },
    setTimeout: (fn, ms, ...a) => {
      if (Number(ms) >= 50) log('WAIT', `setTimeout(${ms}ms) @v+${Math.max(0, Number(ms) || 0)} fn=${String(fn).slice(0, 300).replace(/\n/g, ' ')}`);
      if (Number(ms) === 550) {
        return vSchedule('timeout', (...aa) => { global.__n550 = (global.__n550 || 0) + 1; if (global.__n550 <= 3 || global.__n550 % 20 === 0) log('T550', `#${global.__n550}`); return fn(...aa); }, ms, a);
      }
      return vSchedule('timeout', fn, ms, a);
    },
    setInterval: (fn, ms, ...a) => {
      if (Number(ms) >= 100) log('WAIT', `setInterval(${ms}ms) fn=${String(fn).slice(0, 200).replace(/\n/g, ' ')}`);
      // __inTick guards ONLY the slow wait-loop tick (>=1s): its includes()
      // calls are gate checks that must not heal. Fast intervals host the VM
      // spin pump whose includes() polls await bridge registration — healing
      // there is the browser behavior (every polled name does get defined).
      const slowTick = !(Number(ms) < 1000);
      const id = vSchedule('interval', ( ...aa) => {
        if (slowTick) global.__inTick = true;
        try { return fn(...aa); } finally { if (slowTick) global.__inTick = false; }
      }, ms, a);
      return id;
    },
    clearTimeout: vCancel, clearInterval: vCancel, queueMicrotask,
    console, String, Number, Object, Array, Math, JSON, Date, Promise, Error,
    TypeError, RangeError, SyntaxError, EvalError, ReferenceError, URIError,
    AggregateError, DOMException,
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
      if (t !== 'DOMContentLoaded' && t !== 'load' && t !== 'pageshow') log('LISTEN', `window ${t} listener +1 (total ${listeners.get(t).length}) fn=${String(fn).slice(0, 60)}`);
    },
    removeEventListener: (t, fn) => {
      const arr = listeners.get(t);
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    postMessage: (data, origin) => {
      log('DOM', `window.postMessage ${String(JSON.stringify(data)).slice(0, 100)}`);
      // Widget -> parent message: dispatch to the main window's message
      // listeners with source.postMessage routed back into the widget realm
      // (round12 protocol: controller replies via ev.source.postMessage).
      // Browser semantics: targetOrigin ('*' etc.) is a delivery filter —
      // event.origin is ALWAYS the sender's real origin. Widget-protocol
      // traffic originates from challenges.cloudflare.com (the f/av0 frame),
      // so stamp that as the event origin regardless of the target arg.
      const evOrigin = (data && data.source === 'cloudflare-challenge') ? 'https://challenges.cloudflare.com' : (origin || 'https://www.cell.com');
      const realmEntry = iframeRealms.length ? iframeRealms[iframeRealms.length - 1] : null;
      const ev = { type: 'message', isTrusted: true, data, origin: evOrigin,
        source: { postMessage: (d2, o2) => {
          if (!realmEntry) { log('WIDGET', 'widget reply dropped (no realm)'); return; }
          const ev2 = { type: 'message', isTrusted: true, data: d2, origin: 'https://www.cell.com', source: { postMessage: () => {} } };
          log('WIDGET', `parent->widget reply ${String(JSON.stringify(d2)).slice(0, 90)} -> ${realmEntry.realmListeners.length} listener(s)`);
          for (const fn of realmEntry.realmListeners.slice()) { try { fn(ev2); } catch (e) { log('ERR', `realm reply handler: ${e.message}`); } }
        } } };
      const ls = listeners.get('message') || [];
      log('WIDGET', `real widget msg ${String(data && data.event) || '?'} -> ${ls.length} listener(s)`);
      for (const fn of [...ls]) { try { fn(ev); } catch (e) { log('ERR', `parent message handler: ${e.message}`); } }
    },
    history: { replaceState: () => {}, pushState: () => {}, state: null, length: 1 },
    hasFocus: () => true,
    __deliverToParent: (data, origin) => {
      const ev = { type: 'message', isTrusted: true, data, origin: origin || 'https://challenges.cloudflare.com', source: { postMessage: () => {} } };
      const ls = listeners.get('message') || [];
      log('WIDGET', `parent dispatch ${JSON.stringify(data).slice(0, 90)} -> ${ls.length} listener(s)`);
      for (const fn of [...ls]) { try { fn(ev); } catch (e) { log('ERR', `parent message handler: ${e.message}`); } }
    },
    // 环境自吐: every property read on this window is recorded (key+value
    // preview) and dumped to env-access.json at exit.
    __accessDump: null,
    __perfObservers: envWindowRef.__perfObservers,
    __pendingPerf: envWindowRef.__pendingPerf,
    __mkResourceEntry: (url) => {
      const C = window.PerformanceResourceTiming;
      const e = new C();
      if (!global.__mkN) global.__mkN = 0;
      if (++global.__mkN <= 5) log('MKENTRY', `now=${typeof performance !== 'undefined' ? performance.now() : 'NO-perf'} vNow=${global.V ? global.V.now : '?'} perfId=${(typeof performance !== 'undefined' && performance.now) ? String(performance.now).slice(0, 50) : '-'}`);
      // Fresh timestamps relative to performance.now(): the VM validates
      // entry freshness against the current clock.
      const now = performance.now();
      Object.assign(e, { name: url, entryType: 'resource', initiatorType: 'script',
        startTime: now - 420, duration: 320, fetchStart: now - 418, domainLookupStart: 0,
        domainLookupEnd: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0,
        requestStart: now - 400, responseStart: now - 395, responseEnd: now - 100,
        redirectStart: 0, redirectEnd: 0, transferSize: 88996, encodedBodySize: 88666,
        decodedBodySize: 88666, nextHopProtocol: 'h2', workerStart: 0,
        toJSON() { return { ...this }; } });
      return e;
    },
    __notifyResource: (entry) => {
      envWindowRef.__pendingPerf && envWindowRef.__pendingPerf.push(entry);
      for (const obs of envWindowRef.__perfObservers.slice()) {
        if (obs.types.includes(entry.entryType)) {
          setTimeout(() => {
            try {
              try { fs.appendFileSync(path.join(__dirname, 'po-cb.log'), `OBS cb=${obs.cb.toString()}\n//----\n`); } catch (_) {}
              debugger;  // step_debug.js breaks here to walk the VM continuation
              const _raw = { ...entry };
              const _proxied = new Proxy(_raw, { get(t2, k2) { if (typeof k2 === 'string' && k2 !== 'toJSON') log('ENTRY', `.${k2} -> ${String(t2[k2]).slice(0, 50)}`); return t2[k2]; } });
              obs.cb({ getEntries: () => [_proxied], entryType: entry.entryType });
              log('DOM', `perf notify -> observer (${entry.entryType}: ${String(entry.name).slice(-40)})`);
            } catch (e) { log('ERR', 'perf notify cb: ' + e.message + ' | ' + String(e.stack).split('\n').slice(1, 4).join(' | ')); }
          }, 0);
        }
      }
    },
    document: undefined,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    requestAnimationFrame: (fn) => { global.__rafN = (global.__rafN || 0) + 1; if (global.__rafN <= 3 || global.__rafN % 500 === 0) log('RAF', `#${global.__rafN} fn=${String(fn).slice(0, 90).replace(/\n/g, ' ')}`); return vSchedule('timeout', fn, 16, []); },
    getComputedStyle: (el) => ({ getPropertyValue: (k) => ({ visibility: 'visible', position: 'static', display: 'block', left: '0px', top: '0px', width: '1280px', height: '891px', opacity: '1' }[String(k)] || ''), visibility: 'visible', position: 'static', display: 'block', left: '0px', top: '0px', width: '1280px', height: '891px', opacity: '1' }),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    self: null, top: null, parent: null,
  };
  window.window = window; window.self = window; window.globalThis = window; window.top = window; window.parent = window;
  envWindowRef.set = window;
  envWindowRef.__listeners = listeners;
  // Lenient proxies: log every member access; unknown function calls become
  // logged no-ops so we can enumerate the real environment surface instead of
  // guessing member by member.
  const seen = new Set();
  envWindowRef.Elem = Elem;  // module-level plumbing (main() grafts) — set below after class
  function lenientProxy(target, label) {
    return new Proxy(target, {
      get(t, k) {
        // Internal slots (__shadowRoot etc.) must read through as undefined —
        // a MISS stub here is truthy and poisons first-read-then-write caches
        // (attachShadow returned the stub instead of building a ShadowRoot).
        if (typeof k === 'string' && k.startsWith('__')) return t[k];
        if (k in t || typeof k !== 'string') return t[k];
        if (!seen.has(label + '.' + k)) { seen.add(label + '.' + k); log('MISS', `${label}.${k} accessed`); }
        return function (...args) { log('MISS', `${label}.${k}() called`); return undefined; };
      },
      set(t, k, v) {
        try { t[k] = v; } catch (_) {}
        if (typeof k === 'string') {
          log('SET', `${label}.${k} = ${String(v).slice(0, 90)}${k === 'parentNode' && v ? ' <parent:' + String(v.tagName) + (v.__id !== undefined ? '#' + v.__id : '') + '>' : ''}${k === 'id' && label.startsWith('el<') ? ' <ctor:' + (t && t.constructor && t.constructor.name) + '>' : ''}`);
          if (k === 'src' && typeof v === 'string' && v.includes('chl_page')) {
            log('RELOAD', `chl_page tag set by: ${String(new Error().stack).split('\n').slice(1, 5).join(' | ').slice(0, 400)}`);
          }
          if (k === 'width' && label === 'el<iframe>' && !global.__ifrSetN) {
            global.__ifrSetN = 1;
            log('IFRSET', `iframe.width set by: ${String(new Error().stack).split('\n').slice(1, 7).join(' | ').slice(0, 700)}`);
          }
          // Source-level script capture: any <script>.src assignment in the
          // main DOM is a load intent — register it directly (the tree scan
          // misses tags that get re-parented into detached wrappers).
          if (k === 'src' && typeof v === 'string' && t && t.tagName === 'SCRIPT' && v.startsWith('http')) {
            (global.__srcSetScripts = global.__srcSetScripts || new Set()).add(v);
          }
          // Id registry AT THE PROXY LEVEL: element implementations differ
          // (class Elem / plain objects) — the proxy sees every id set on
          // wrapped elements regardless of class, making this the reliable
          // ground truth for #id queries.
          if (k === 'id' && t && typeof v === 'string') {
            try { (global.__idElems = global.__idElems || new Map()).set(v, t); } catch (_) {}
          }
          if (k === 'src' && t.tagName === 'IFRAME' && typeof v === 'string' && v) {
            try { queueIframeLoad(t, v); } catch (e) { log('ERR', 'iframe load: ' + e.message); }
          }
        }
        return true;
      },
    });
  }
  window.document = lenientProxy(document, 'document');
  window.navigator = lenientProxy(navigator, 'navigator');
  window.screen = lenientProxy(screen, 'screen');
  window.HTMLElement = lenientProxy(Elem, 'HTMLElement');
  // createElement returns logged proxies so element member misses are visible.
  const rawCreate = document.createElement.bind(document);
  document.createElement = (t) => {
    const e = new Elem(t); const p = lenientProxy(e, 'el<' + t + '>');
    e.__proxy = p;
    log('DOM', `createElement(${t})`);
    return p;
  };
  document.createElementNS = (ns, t) => { const e = new Elem(t); return lenientProxy(e, 'el<' + t + '>'); };
  return { window, document, pendingScripts, xhrQueue, listeners, perfEntries, Elem };
}

// ---- main ----
async function main() {
  const [,, scriptPath] = process.argv;
  log('BOOT', 'fetching challenge page');
  if (process.env.HARNESS_MAX_MS) {
    setTimeout(() => { log('BOOT', `watchdog exit at ${process.env.HARNESS_MAX_MS}ms`); process.exit(0); }, parseInt(process.env.HARNESS_MAX_MS, 10));
  }
  const pinned = process.env.HARNESS_PINNED === '1';
  let page;
  if (pinned && fs.existsSync(path.join(__dirname, 'pinned-page.html'))) {
    page = { status: 403, text: fs.readFileSync(path.join(__dirname, 'pinned-page.html'), 'utf8') };
    log('BOOT', 'using PINNED page/opt/orchestrate');
  } else {
    page = await httpReq('GET', BASE + '/', {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
  }
  fs.writeFileSync(path.join(__dirname, 'page-live.html'), page.text);
  const m = page.text.match(/window\._cf_chl_opt\s*=\s*\{(.*?)\};/s);
  if (!m) throw new Error('no _cf_chl_opt in page');
  const optSrc = `{${m[1]}}`;
  const opt = Function(`return (${optSrc})`)();
  const ray = opt.cRay;
  log('BOOT', `cRay=${ray} cType=${opt.cType} cvId=${opt.cvId}`);
  fs.writeFileSync(path.join(__dirname, 'opt-live.json'), JSON.stringify(opt, null, 1));

  // Device-clock gate: the orchestrate compares Date.now()/1000 against
  // _cf_chl_opt.cITimeS (server issue time) and renders "Incorrect device
  // time" + aborts the boot chain when |diff| exceeds its threshold. In
  // pinned replay the session bytes are old, so shift the VM clock to the
  // session's issue time (shift≈0 for live sessions — value from the opt
  // itself, never hardcoded).
  const clockShift = opt.cITimeS ? (parseInt(opt.cITimeS, 10) * 1000 - Date.now()) : 0;
  log('BOOT', `clock shift vs cITimeS: ${Math.round(clockShift / 1000)}s`);
  // Virtual clock base: simulated "now" starts at the session issue time.
  V.now = Date.now() + clockShift;
  // performance.now() counts from the PAGE session start — the virtual
  // clock's own origin, not the host boot. With the pinned shift applied to
  // V.now but not t0, entry timestamps went negative and the VM's entry
  // freshness gate dropped every api.js resource entry.
  V.t0 = V.now;
  vAnchor.virt = V.now; vAnchor.real = Date.now();

  const orchUrl = `${BASE}/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=${ray}`;
  let orch;
  if (pinned && fs.existsSync(path.join(__dirname, 'pinned-orchestrate.js'))) {
    orch = { status: 200, text: fs.readFileSync(path.join(__dirname, 'pinned-orchestrate.js'), 'utf8') };
  } else {
    orch = await httpReq('GET', orchUrl, { Referer: BASE + '/', Accept: '*/*' });
  }
  fs.writeFileSync(path.join(__dirname, 'orchestrate-live.js'), orch.text);
  log('BOOT', `orchestrate ${orch.status} ${orch.text.length}B`);

  process.on('unhandledRejection', (e) => {
    log('ERR', `unhandledRejection: ${e && e.message}`);
    log('ERR', 'rej stack: ' + String(e && e.stack).split('\n').slice(0, 6).join(' | '));
  });
  process.on('uncaughtException', (e) => {
    log('ERR', `uncaught: ${e && e.message}`);
    log('ERR', 'stack: ' + String(e && e.stack).split('\n').slice(0, 9).join(' | '));
  });

  const env = makeEnv({ opt, html: page.text });
  global.__mainBody = env.document.body; global.__mainDoc = env.document;
  // Trace who stores the challenge container on _cf_chl_opt.glEe8 (V() =
  // glEe8.querySelector('#XWAst9') gates the Gz render path).
  try {
    let __gle;
    Object.defineProperty(opt, 'glEe8', {
      configurable: true,
      get() { return __gle; },
      set(v) {
        __gle = v;
        log('GLEE', `glEe8 = <${v && v.tagName}> id=${String(v && (v.id !== undefined ? v.id : '?')).slice(0, 40)} by ${String(new Error().stack).split('\n').slice(2, 5).join(' | ').slice(0, 260)}`);
      },
    });
  } catch (_) {}
  // VM clock shift for pinned replay (see clockShift note above): shadow the
  // global Date with a subclass whose now() tracks the session issue time.
  // toString is masked to the native one so anti-tamper reads stay clean.
  {
    const RealDate = Date;
    const vDateNow = () => vAdvance();
    Object.defineProperty(vDateNow, 'toString', { value: RealDate.now.toString.bind(RealDate.now) });
    Object.defineProperty(vDateNow, 'name', { value: 'now' });
    const VDate = class extends RealDate {};
    VDate.now = vDateNow;
    VDate.UTC = RealDate.UTC; VDate.parse = RealDate.parse;
    env.window.Date = VDate;
    if (clockShift) log('BOOT', `VM clock = virtual, base at session issue time (shift ${Math.round(clockShift / 1000)}s)`);
  }
  // Resource timing entries the orchestrate reads for its own load.
  // When a real browser capture exists (browser-perf-entries.json, dumped at
  // the browser's own fo/#1 moment via the XHR breakpoint), seed those REAL
  // entries — the VM's task machine consumes these timings verbatim.
  const realEntriesPath = path.join(__dirname, 'browser-perf-entries.json');
  let realEntries = null;
  if (fs.existsSync(realEntriesPath)) {
    try {
      realEntries = JSON.parse(fs.readFileSync(realEntriesPath, 'utf8'));
      if (typeof realEntries === 'string') realEntries = JSON.parse(realEntries);
      log('BOOT', `REAL browser perf entries available (${realEntries.length}) — synthetic seeds suppressed`);
    } catch (e) { log('ERR', 'real entries: ' + e.message); }
  }
  if (realEntries) {
    env.perfEntries.push(...realEntries.map(e => ({ ...e, toJSON() { return { ...e }; } })));
  } else env.perfEntries.push(
    { name: BASE + '/', entryType: 'navigation', startTime: 0, duration: 874.38,
      unloadEventStart: 0, unloadEventEnd: 0, redirectStart: 0, redirectEnd: 0,
      fetchStart: 12.1, domainLookupStart: 12.2, domainLookupEnd: 60.4,
      connectStart: 60.5, connectEnd: 150.2, secureConnectionStart: 80.1,
      requestStart: 271.7, responseStart: 271.72, responseEnd: 874.38,
      transferSize: 3528, encodedBodySize: 3268, decodedBodySize: 3268,
      type: 'navigate', redirectCount: 0, nextHopProtocol: 'h2' },
    { name: orchUrl, entryType: 'resource', initiatorType: 'script',
      startTime: 1701.1, duration: 331.7, redirectStart: 0, redirectEnd: 0,
      fetchStart: 1701.2, domainLookupStart: 0, domainLookupEnd: 0,
      connectStart: 0, connectEnd: 0, secureConnectionStart: 0,
      requestStart: 1741.4, responseStart: 1741.46, responseEnd: 2032.8,
      transferSize: 104226, encodedBodySize: 103926, decodedBodySize: 103926,
      nextHopProtocol: 'h2', workerStart: 0 },
    { name: 'https://challenges.cloudflare.com/turnstile/v0/b/d2d3316b729e/api.js?onload=DraY9&render=explicit',
      entryType: 'resource', initiatorType: 'script', startTime: 1500.1,
      duration: 310.2, fetchStart: 1500.2, requestStart: 1505.1,
      responseStart: 1540.4, responseEnd: 1810.3, transferSize: 88996,
      encodedBodySize: 88666, decodedBodySize: 88666, nextHopProtocol: 'h2' },
  );
  class GenericEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } preventDefault() {} stopPropagation() {} stopImmediatePropagation() {} }
  class MessageChannelShim {
    constructor() {
      const a = { onmessage: null, postMessage: (d) => { b.onmessage && b.onmessage({ data: d }); }, close() {}, start() {} };
      const b = { onmessage: null, postMessage: (d) => { a.onmessage && a.onmessage({ data: d }); }, close() {}, start() {} };
      this.port1 = a; this.port2 = b;
    }
  }
  const stub = (name) => class { constructor(...a) { log('STUB', `new ${name}(...)`); } };
  const w0 = env.window;
  // (family loop below runs first; unified classes override afterwards)
  // DOM constructor family: api.js performs raw `x instanceof Y` checks; an
  // undefined Y throws. Define the whole family with Object chains.
  for (const nm of ['Document','Location','Window','ShadowRoot','Screen','Storage',
      'NodeList','HTMLCollection','DOMTokenList','CSSStyleDeclaration','MimeType',
      'MimeTypeArray','Plugin','PluginArray','Permissions','PermissionStatus',
      'MediaList','StyleSheet','CSSStyleSheet','DOMRect','DOMRectReadOnly',
      'FormData','Headers','Request','Response','History','CryptoKey','SubtleCrypto',
      'PerformanceNavigationTiming','SVGElement','SVGGraphicsElement','SVGGeometryElement',
      'SVGPathElement','SVGCircleElement','SVGSVGElement','CharacterData','Text','Comment',
      'HTMLHeadElement','HTMLBodyElement','HTMLParagraphElement','HTMLHeadingElement',
      'HTMLStyleElement','HTMLScriptElement','HTMLAnchorElement','HTMLImageElement',
      'HTMLIFrameElement','HTMLInputElement','HTMLFormElement']) {
    if (!w0[nm]) { const C2 = function () {}; C2.prototype = Object.create(Object.prototype); Object.defineProperty(C2.prototype, Symbol.toStringTag, { value: nm, configurable: true }); w0[nm] = C2; }
  }
  for (const [name, val] of Object.entries({
    Event: GenericEvent, CustomEvent: GenericEvent, MessageEvent: GenericEvent,
    PerformanceEntry: class PerformanceEntry {}, PerformanceResourceTiming: class PerformanceResourceTiming {},
    PerformanceNavigationTiming: class PerformanceNavigationTiming {},
    PerformanceObserverEntryList: class PerformanceObserverEntryList {}, PerformanceMeasure: class PerformanceMeasure {},
    PerformanceMark: class PerformanceMark {},
    MessageChannel: MessageChannelShim, Promise, WebSocket: stub('WebSocket'),
    SharedWorker: stub('SharedWorker'), EventSource: stub('EventSource'),
    Notification: stub('Notification'), AbortController,
    Image: stub('Image'), MutationObserver: stub('MutationObserver'),
    IntersectionObserver: stub('IntersectionObserver'), ResizeObserver: stub('ResizeObserver'),
    HTMLIFrameElement: w0.HTMLElement, HTMLScriptElement: w0.HTMLElement, HTMLDivElement: w0.HTMLElement,
    CanvasRenderingContext2D: stub('2d'), WebGLRenderingContext: stub('WebGL'),
    WebGL2RenderingContext: stub('WebGL2'), OffscreenCanvas: stub('OffscreenCanvas'),
    // Browser-shaped RTCPeerConnection (evidence: round12 bom ledger —
    // construct -> createDataChannel('') -> createOffer (awaited, drives the
    // fo/ emitter in its .then) -> close; iceGatheringState read once).
    // Firefox-shaped offer SDP: per-instance random ice ufrag/pwd, template
    // fingerprint/candidate. The phase scripts extract fields from it.
    speechSynthesis: { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {}, pending: () => false, speaking: false, paused: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, onvoiceschanged: null, onstart: null, onend: null, onerror: null, onmark: null, onboundary: null },
    MediaSource: class MediaSource { constructor() { this.sourceBuffers = []; this.activeSourceBuffers = []; this.readyState = 'closed'; this.duration = NaN; } addSourceBuffer() { return { mode: 'segments', updating: false, buffered: { length: 0 }, appendBuffer() {}, remove() {}, abort() {}, addEventListener() {}, removeEventListener() {} }; } endOfStream() {} addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } static isTypeSupported() { return false; } },
    Worklet: class Worklet { addModule() { return Promise.resolve(); } },
    RTCPeerConnection: class RTCPeerConnection {
      constructor(...a) { log('DOM', `new RTCPeerConnection(${JSON.stringify(a[0] || {}).slice(0, 60)})`); this.onicecandidate = null; this.__iceListeners = []; this.localDescription = null; this.__gathering = 'new'; this.__closed = false; this.__ufrag = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 4) : String(Math.random()).slice(2, 6); this.__pwd = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 24) : String(Math.random()).slice(2); this.__sid = String(Math.floor(Math.random() * 1e18)); }
      createDataChannel(label) { return { label, readyState: 'open', close() {}, send() {} }; }
      // Firefox-shaped offer: audio+video+application, trickle ice-options,
      // full codec rows (browser capture @fo/: zBvVa5 SDP). Candidates are
      // then delivered as events — the browser phase machine collects 6
      // mDNS host candidates (RAAZ3) and only then advances to fo/.
      createOffer() {
        const fp = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
        const sdp = [
          'v=0', `o=- ${this.__sid} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0',
          'a=group:BUNDLE 0 1 2', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
          'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126', 'c=IN IP4 0.0.0.0',
          `a=ice-ufrag:${this.__ufrag}`, `a=ice-pwd:${this.__pwd}`, 'a=ice-options:trickle',
          `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0',
          'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
          'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=recvonly', 'a=rtcp-mux', 'a=rtcp-rsize',
          'a=rtcp-xr:rcvr-rtt=all', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc',
          'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111',
          'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:13 CN/8000',
          'a=rtpmap:110 telephone-event/48000', 'a=rtpmap:126 telephone-event/8000',
          'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 35 36 37 38 102 103 104 107 108 109 114 115 116 117 39 40 41 42 43 44 45 46 47 48 118 119 120 121 49 50 51 52 122 123 124 53', 'c=IN IP4 0.0.0.0',
          `a=ice-ufrag:${this.__ufrag}`, `a=ice-pwd:${this.__pwd}`, 'a=ice-options:trickle',
          `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:1',
          'a=extmap:14 urn:ietf:params:rtp-hdrext:toffset', 'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          'a=extmap:13 urn:3gpp:video-orientation', 'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
          'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay', 'a=extmap:6 http://www.webrtc.org/experiments/rtp-hdrext/video-content-type',
          'a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/video-timing', 'a=extmap:8 http://www.webrtc.org/experiments/rtp-hdrext/color-space',
          'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:10 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
          'a=extmap:11 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id', 'a=recvonly', 'a=rtcp-mux', 'a=rtcp-rsize',
          'a=rtcp-xr:rcvr-rtt=all', 'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 goog-remb', 'a=rtcp-fb:96 transport-cc',
          'a=rtcp-fb:96 ccm fir', 'a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli', 'a=rtpmap:97 rtx/90000',
          'a=fmtp:97 apt=96', 'a=rtpmap:98 VP9/90000', 'a=rtcp-fb:98 goog-remb', 'a=rtcp-fb:98 transport-cc',
          'a=rtcp-fb:98 ccm fir', 'a=rtcp-fb:98 nack', 'a=rtcp-fb:98 nack pli', 'a=rtpmap:99 rtx/90000',
          'a=fmtp:99 apt=98', 'a=rtpmap:100 VP9/90000', 'a=rtcp-fb:100 goog-remb', 'a=rtcp-fb:100 transport-cc',
          'a=rtcp-fb:100 ccm fir', 'a=rtcp-fb:100 nack', 'a=rtcp-fb:100 nack pli', 'a=rtpmap:101 rtx/90000',
          'a=fmtp:101 apt=100', 'a=rtpmap:35 VP9/90000', 'a=rtcp-fb:35 goog-remb', 'a=rtcp-fb:35 transport-cc',
          'a=rtcp-fb:35 ccm fir', 'a=rtcp-fb:35 nack', 'a=rtcp-fb:35 nack pli', 'a=rtpmap:36 rtx/90000',
          'a=fmtp:36 apt=35', 'a=rtpmap:37 VP9/90000', 'a=rtcp-fb:37 goog-remb', 'a=rtcp-fb:37 transport-cc',
          'a=rtcp-fb:37 ccm fir', 'a=rtcp-fb:37 nack', 'a=rtcp-fb:37 nack pli', 'a=rtpmap:38 rtx/90000',
          'a=fmtp:38 apt=37', 'a=rtpmap:102 H264/90000', 'a=rtcp-fb:102 goog-remb', 'a=rtcp-fb:102 transport-cc',
          'a=rtcp-fb:102 ccm fir', 'a=rtcp-fb:102 nack', 'a=rtcp-fb:102 nack pli',
          'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', 'a=rtpmap:104 H264/90000', 'a=rtcp-fb:104 goog-remb',
          'a=rtcp-fb:104 transport-cc', 'a=rtcp-fb:104 ccm fir', 'a=rtcp-fb:104 nack', 'a=rtcp-fb:104 nack pli',
          'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
          'a=rtpmap:107 rtx/90000', 'a=fmtp:107 apt=104', 'a=rtpmap:108 H264/90000', 'a=rtcp-fb:108 goog-remb',
          'a=rtcp-fb:108 transport-cc', 'a=rtcp-fb:108 ccm fir', 'a=rtcp-fb:108 nack', 'a=rtcp-fb:108 nack pli',
          'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
          'a=rtpmap:109 rtx/90000', 'a=fmtp:109 apt=108', 'a=rtpmap:114 H264/90000', 'a=rtcp-fb:114 goog-remb',
          'a=rtcp-fb:114 transport-cc', 'a=rtcp-fb:114 ccm fir', 'a=rtcp-fb:114 nack', 'a=rtcp-fb:114 nack pli',
          'a=fmtp:114 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f',
          'a=rtpmap:115 rtx/90000', 'a=fmtp:115 apt=114', 'a=rtpmap:116 H264/90000', 'a=rtcp-fb:116 goog-remb',
          'a=rtcp-fb:116 transport-cc', 'a=rtcp-fb:116 ccm fir', 'a=rtcp-fb:116 nack', 'a=rtcp-fb:116 nack pli',
          'a=fmtp:116 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
          'a=rtpmap:117 rtx/90000', 'a=fmtp:117 apt=116', 'a=rtpmap:39 H264/90000', 'a=rtcp-fb:39 goog-remb',
          'a=rtcp-fb:39 transport-cc', 'a=rtcp-fb:39 ccm fir', 'a=rtcp-fb:39 nack', 'a=rtcp-fb:39 nack pli',
          'a=fmtp:39 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f',
          'a=rtpmap:40 rtx/90000', 'a=fmtp:40 apt=39', 'a=rtpmap:41 H264/90000', 'a=rtcp-fb:41 goog-remb',
          'a=rtcp-fb:41 transport-cc', 'a=rtcp-fb:41 ccm fir', 'a=rtcp-fb:41 nack', 'a=rtcp-fb:41 nack pli',
          'a=fmtp:41 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=f4001f',
          'a=rtpmap:42 rtx/90000', 'a=fmtp:42 apt=41', 'a=rtpmap:43 H264/90000', 'a=rtcp-fb:43 goog-remb',
          'a=rtcp-fb:43 transport-cc', 'a=rtcp-fb:43 ccm fir', 'a=rtcp-fb:43 nack', 'a=rtcp-fb:43 nack pli',
          'a=fmtp:43 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=f4001f',
          'a=rtpmap:44 rtx/90000', 'a=fmtp:44 apt=43', 'a=rtpmap:45 AV1/90000', 'a=rtcp-fb:45 goog-remb',
          'a=rtcp-fb:45 transport-cc', 'a=rtcp-fb:45 ccm fir', 'a=rtcp-fb:45 nack', 'a=rtcp-fb:45 nack pli',
          'a=fmtp:45 level-idx=5;profile=0;tier=0', 'a=rtpmap:46 rtx/90000', 'a=fmtp:46 apt=45',
          'a=rtpmap:47 AV1/90000', 'a=rtcp-fb:47 goog-remb', 'a=rtcp-fb:47 transport-cc', 'a=rtcp-fb:47 ccm fir',
          'a=rtcp-fb:47 nack', 'a=rtcp-fb:47 nack pli', 'a=fmtp:47 level-idx=5;profile=1;tier=0',
          'a=rtpmap:48 rtx/90000', 'a=fmtp:48 apt=47', 'a=rtpmap:118 H264/90000', 'a=rtcp-fb:118 goog-remb',
          'a=rtcp-fb:118 transport-cc', 'a=rtcp-fb:118 ccm fir', 'a=rtcp-fb:118 nack', 'a=rtcp-fb:118 nack pli',
          'a=fmtp:118 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
          'a=rtpmap:119 rtx/90000', 'a=fmtp:119 apt=118', 'a=rtpmap:120 H264/90000', 'a=rtcp-fb:120 goog-remb',
          'a=rtcp-fb:120 transport-cc', 'a=rtcp-fb:120 ccm fir', 'a=rtcp-fb:120 nack', 'a=rtcp-fb:120 nack pli',
          'a=fmtp:120 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
          'a=rtpmap:121 rtx/90000', 'a=fmtp:121 apt=120', 'a=rtpmap:49 H264/90000', 'a=rtcp-fb:49 goog-remb',
          'a=rtcp-fb:49 transport-cc', 'a=rtcp-fb:49 ccm fir', 'a=rtcp-fb:49 nack', 'a=rtcp-fb:49 nack pli',
          'a=fmtp:49 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f',
          'a=rtpmap:50 rtx/90000', 'a=fmtp:50 apt=49', 'a=rtpmap:51 H264/90000', 'a=rtcp-fb:51 goog-remb',
          'a=rtcp-fb:51 transport-cc', 'a=rtcp-fb:51 ccm fir', 'a=rtcp-fb:51 nack', 'a=rtcp-fb:51 nack pli',
          'a=fmtp:51 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
          'a=rtpmap:52 rtx/90000', 'a=fmtp:52 apt=51', 'a=rtpmap:122 H264/90000', 'a=rtcp-fb:122 goog-remb',
          'a=rtcp-fb:122 transport-cc', 'a=rtcp-fb:122 ccm fir', 'a=rtcp-fb:122 nack', 'a=rtcp-fb:122 nack pli',
          'a=fmtp:122 profile-id=0', 'a=rtpmap:123 rtx/90000', 'a=fmtp:123 apt=122',
          'a=rtpmap:124 H264/90000', 'a=rtcp-fb:124 goog-remb', 'a=rtcp-fb:124 transport-cc',
          'a=rtcp-fb:124 ccm fir', 'a=rtcp-fb:124 nack', 'a=rtcp-fb:124 nack pli', 'a=fmtp:124 profile-id=1',
          'a=rtpmap:53 rtx/90000', 'a=fmtp:53 apt=124',
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
          `a=ice-ufrag:${this.__ufrag}`, `a=ice-pwd:${this.__pwd}`, 'a=ice-options:trickle',
          `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:2', 'a=sctp-port:5000', 'a=max-message-size:1073741823',
        ].join('\r\n') + '\r\n';
        this.localDescription = { type: 'offer', sdp };
        // Trickle gathering: 6 mDNS host candidates (2 interfaces x 3 ports,
        // browser shape), ~40ms after offer, then complete. Delivery via the
        // onicecandidate property AND 'icecandidate' listeners; a final null
        // candidate marks gathering end (Firefox semantics).
        const emit = (cand) => {
          if (this.__closed) return;
          const ev = { candidate: cand, type: 'icecandidate', target: this };
          if (typeof this.onicecandidate === 'function') { try { this.onicecandidate(ev); } catch (e) { log('ERR', 'rtc onicecandidate: ' + e.message); } }
          for (const fn of this.__iceListeners) { try { fn(ev); } catch (e) { log('ERR', 'rtc icecandidate listener: ' + e.message); } }
        };
        const mkCand = (foundation, priority, host, port) => `candidate:${foundation} 1 udp ${priority} ${host} ${port} typ host generation 0 ufrag ${this.__ufrag} network-cost 999`;
        const c1 = crypto.randomUUID ? crypto.randomUUID() : 'f430be76-5f02-4e29-be28-007e9751077d';
        const c2 = crypto.randomUUID ? crypto.randomUUID() : '6fbd1cff-f617-489c-bb63-7c5ff8910a9a';
        const cands = [
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113937151, `${c1}.local`, 40000 + Math.floor(Math.random() * 20000)),
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113939711, `${c2}.local`, 40000 + Math.floor(Math.random() * 20000)),
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113937151, `${c1}.local`, 40000 + Math.floor(Math.random() * 20000)),
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113939711, `${c2}.local`, 40000 + Math.floor(Math.random() * 20000)),
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113937151, `${c1}.local`, 40000 + Math.floor(Math.random() * 20000)),
          mkCand(Math.floor(Math.random() * 2 ** 31), 2113939711, `${c2}.local`, 40000 + Math.floor(Math.random() * 20000)),
        ];
        setTimeout(() => {
          this.__gathering = 'gathering';
          let i = 0;
          const step = () => {
            if (this.__closed) return;
            if (i < cands.length) { emit({ candidate: cands[i++], sdpMid: String(Math.floor(i / 2) % 3), sdpMLineIndex: Math.floor(i / 2) % 3 }); setTimeout(step, 1); }
            else { emit(null); this.__gathering = 'complete'; log('DOM', `RTC gathering complete (${cands.length} candidates)`); }
          };
          step();
        }, 40);
        return Promise.resolve({ type: 'offer', sdp });
      }
      get iceGatheringState() { return this.__gathering; }
      createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      addEventListener(t, fn) { if (t === 'icecandidate') this.__iceListeners.push(fn); }
      removeEventListener() {} close() { this.__closed = true; log('DOM', 'RTCPeerConnection.close()'); }
      getStats() { return Promise.resolve({}); }
    },
  })) { w0[name] = w0[name] || val; }
  // Unify main-window element classes with the trace-derived chains: one
  // prototype per interface; createElement wires instances per tag.
  {
    const mc = buildRealmClasses(w0);
    for (const iface of ['Event','Node','Element','HTMLElement','HTMLDivElement',
        'HTMLAnchorElement','HTMLIFrameElement','HTMLScriptElement','HTMLStyleElement',
        'HTMLParagraphElement','HTMLHeadingElement','HTMLImageElement','HTMLInputElement',
        'HTMLFormElement','HTMLHeadElement','HTMLBodyElement',
        'HTMLCanvasElement','SVGElement','SVGGraphicsElement','SVGGeometryElement','SVGPathElement',
        'SVGCircleElement','SVGSVGElement','ShadowRoot']) mc.defClass(iface, envWindowRef.Elem.prototype);
    // Unified protos replaced Elem.prototype; graft shim methods at WebIDL links.
    for (const [pn, names] of ELEM_GRAFTS) {
      const pr = w0[pn];
      if (pr) graftElemMethods(envWindowRef.Elem.prototype, pr, names);
    }
    if (w0.ElementPrototype) w0.ElementPrototype.attachShadow = makeAttachShadow(() => w0.ShadowRoot ? w0.ShadowRoot.prototype : null);
    if (w0.HTMLIFrameElement) graftElemMethods(envWindowRef.Elem.prototype, w0.HTMLIFrameElement.prototype, ['contentWindow','contentDocument','src']);
    if (w0.HTMLScriptElement) graftElemMethods(envWindowRef.Elem.prototype, w0.HTMLScriptElement.prototype, ['src','text']);
    const MAIN_TAGS = { IFRAME:'HTMLIFrameElement', SCRIPT:'HTMLScriptElement', STYLE:'HTMLStyleElement',
      DIV:'HTMLDivElement', P:'HTMLParagraphElement', H1:'HTMLHeadingElement', H2:'HTMLHeadingElement',
      H3:'HTMLHeadingElement', A:'HTMLAnchorElement', IMG:'HTMLImageElement', SVG:'SVGSVGElement',
      CANVAS:'HTMLCanvasElement' };
    const prevCreate = w0.document.createElement;
    w0.document.createElement = function (t) {
      const e = prevCreate.call(this, t);
      const iface = MAIN_TAGS[String(t).toUpperCase()];
      if (iface && w0[iface]) { const inst = e.__proxy || e; Object.setPrototypeOf(inst, w0[iface].prototype); }
      return e;
    };
    // Parsed (non-createElement) elements bypass the interface wiring above —
    // a skeleton div fails api.js's `instanceof HTMLElement` render() check.
    try {
      const WIRE = Object.assign({}, MAIN_TAGS, { INPUT: 'HTMLInputElement', FORM: 'HTMLFormElement', NOSCRIPT: 'HTMLDivElement', BUTTON: 'HTMLInputElement' });
      let __wired = 0, __seen = 0;
      const wireAll = (el) => {
        __seen++;
        try {
          const C = WIRE[String(el.tagName).toUpperCase()];
          if (C && w0[C] && w0[C].prototype && Object.getPrototypeOf(el) !== w0[C].prototype) { Object.setPrototypeOf(el, w0[C].prototype); __wired++; }
        } catch (_) {}
        (el.children || []).forEach(wireAll);
      };
      // The micro-DOM parser roots the page tree at document.children
      // (stack starts [body, document] with top=document), so walk the
      // document itself — document.body is NOT the parsed body element.
      wireAll(w0.document);
      log('DOM', `parsed-tree interface prototypes wired seen=${__seen} wired=${__wired}`);
    } catch (e9) { log('ERR', 'proto wire: ' + e9.message); }
  }
  const loggedWindow = new Proxy(env.window, {
    get(t, k) {
      // Count EVERY string-key read (existing keys too): a spinning VM
      // bytecode loop polls some environment value; the periodic top-N dump
      // makes the polled key visible directly.
      if (typeof k === 'string') {
        const c = (global.__wgetCounts = global.__wgetCounts || new Map());
        c.set(k, (c.get(k) || 0) + 1);
        // Self-dumping counter: a synchronous VM spin starves the event
        // loop, so the pump can never dump — dump from inside the trap.
        if ((global.__wgetN = (global.__wgetN || 0) + 1) % 3000000 === 0) {
          const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
          log('WGDUMP', `total=${global.__wgetN} ` + top.map(([k2, n]) => `${k2}:${n}`).join(' '));
          if (!global.__spinStacked) { global.__spinStacked = 1; try { log('SPINSTACK', new Error().stack.split('\n').slice(1, 12).join(' | ').slice(0, 1400)); } catch (_) {} }
          try { const pt = [...(global.__pendingTimers || new Map()).values()]; log('PDUMP', `pending=${pt.length} :: ${pt.slice(0, 6).join(' || ').slice(0, 500)}`); } catch (_) {}
        }
      }
      if (k in t || typeof k !== 'string') {
        if (typeof k === 'string' && process.env.HARNESS_KEY_STACK === k && (global.__keyN = (global.__keyN || 0) + 1) % (parseInt(process.env.HARNESS_KEY_EVERY || '40')) === 1) {
          try { log('KEYSTACK', `#${global.__keyN} ${new Error().stack.split('\n').slice(1, 8).join(' | ').slice(0, 900)}`); } catch (_) {}
        }

        if (k === '_cf_chl_opt' && t[k] && typeof t[k] === 'object' && process.env.HARNESS_OPT_FIELDS) {
          if (!t.__optProxy || t.__optProxyRaw !== t[k]) {
            const raw = t[k];
            t.__optProxyRaw = raw;
            t.__optProxy = new Proxy(raw, {
              get(t2, k2) {
                if (typeof k2 === 'string' && !k2.startsWith('__')) { const c = (global.__optFields = global.__optFields || new Map()); c.set(k2, (c.get(k2) || 0) + 1); }
                const v2 = t2[k2];
                // Second-layer observation: array-valued session keys get a
                // stable (identity-preserving) proxy logging method calls.
                if (Array.isArray(v2) && /^[A-Za-z][A-Za-z0-9]{3,8}$/.test(k2)) {
                  global.__optArrPx = global.__optArrPx || new Map();
                  if (!global.__optArrPx.has(k2) || global.__optArrPx.get(k2).__raw !== v2) {
                    const px = new Proxy(v2, { get(a2, m2) {
                      if (typeof m2 === 'string' && m2 !== 'length' && m2 !== '__raw') {
                        const cc = (global.__optArrCalls = global.__optArrCalls || new Map());
                        const kk = k2 + '.' + m2;
                        cc.set(kk, (cc.get(kk) || 0) + 1);
                        if ((global.__optArrN = (global.__optArrN || 0) + 1) <= 80) log('OPTARR', kk);
                      }
                      return a2[m2];
                    } });
                    px.__raw = v2;
                    global.__optArrPx.set(k2, px);
                  }
                  return global.__optArrPx.get(k2);
                }
                return v2;
              },
              set(t2, k2, v2) {
                if (typeof k2 === 'string' && !k2.startsWith('__')) log('OPTSET', `.${k2} = ${typeof v2} ${String(v2).slice(0, 70).replace(/\n/g, ' ')}`);
                t2[k2] = v2; return true;
              },
              has(t2, k2) {
                if (typeof k2 === 'string' && !k2.startsWith('__') && !(k2 in t2)) { const c = (global.__optHas = global.__optHas || new Map()); c.set(k2, (c.get(k2) || 0) + 1); if ((global.__optHasN = (global.__optHasN || 0) + 1) <= 30) log('OPTHAS', `.${k2}? (absent)`); }
                return k2 in t2;
              } });
          }
          return t.__optProxy;
        }
        return t[k];
      }
      // Same-realm fallback: the page realm IS the host realm in this model
      // (env.window.eval is the host's own eval), so script globals defined
      // via indirect eval land on globalThis. Surface them on the window;
      // Node-internal names stay hidden.
      // Never fall back for standard intrinsics: their identity is compared
      // cross-realm by the VM, and Node's copies differ from the vm
      // context's — surfacing them sent the VM into an identity spin.
      const INTRINSICS = (global.__intrinsics = global.__intrinsics || new Set(['Function','Array','ArrayBuffer','Reflect','Object','String','Symbol','DataView','TextEncoder','TextDecoder','Map','Set','WeakMap','WeakSet','Math','JSON','Date','Promise','RegExp','Error','TypeError','RangeError','SyntaxError','EvalError','ReferenceError','URIError','AggregateError','DOMException','Number','Boolean','BigInt','Proxy','Infinity','NaN','undefined','globalThis','eval','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','atob','btoa','Uint8Array','Uint8ClampedArray','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','ArrayBuffer','SharedArrayBuffer','Atomics','queueMicrotask','structuredClone','fetch','Blob','URL','URLSearchParams','AbortController','AbortSignal','Event','EventTarget','CustomEvent','MessageChannel','MessagePort','performance','crypto','console','navigator','location','history','document','window','self','top','parent','frames','length','name','origin','closed','status','frameElement','opener','crypto','WebSocket','Worker','XMLHttpRequest','localStorage','sessionStorage','alert','confirm','prompt','getComputedStyle','matchMedia','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','setTimeout','setInterval','clearTimeout','clearInterval','addEventListener','removeEventListener','dispatchEvent','postMessage','open','close','focus','blur','print','stop','scrollBy','scrollTo','scroll','moveBy','moveTo','resizeBy','resizeTo','getSelection','find','reportError','createImageBitmap','fetchLater','crossOriginIsolated','isSecureContext','caches','cookieStore','onmessage','onerror','onload','onbeforeunload','Document','Node','Element','HTMLElement','HTMLScriptElement','HTMLIFrameElement','HTMLDivElement','HTMLBodyElement','HTMLDocument','PerformanceObserver','PerformanceObserverEntryList','PerformanceResourceTiming','PerformanceEntry','Performance','MutationObserver','IntersectionObserver','ResizeObserver','ShadowRoot','DocumentFragment','HTMLCollection','NodeList','CSSStyleDeclaration','StylePropertyMap','Navigator','Storage','Location','TrustedTypePolicyFactory','WebAssembly']));
      if (!INTRINSICS.has(k) && /^[A-Za-z][A-Za-z0-9_$]*$/.test(k) && !/^(require|module|exports|process|global|Buffer|__dirname|__filename)/.test(k)) {
        try { const g = globalThis[k]; if (g !== undefined) { t[k] = g; return g; } } catch (_) {}
      }
      log('MISS', `window.${k} accessed`);
      // Debug-only: HARNESS_MISS_STACK=<name> dumps the caller stack on the
      // first 6 misses of that name; '*' dumps once per unique name.
      if (process.env.HARNESS_MISS_STACK) {
        const want = process.env.HARNESS_MISS_STACK;
        if (want === '*') {
          global.__missSeen = global.__missSeen || new Set();
          if (/^[A-Za-z][A-Za-z0-9]{3,9}$/.test(k) && !global.__missSeen.has(k)) {
            global.__missSeen.add(k);
            try { log('MISSSTACK', `${k} :: ${new Error().stack.split('\n').slice(1, 10).join(' | ').slice(0, 1100)}`); } catch (_) {}
          }
        } else if (want === k) {
          global.__missStackN = (global.__missStackN || 0) + 1;
          if (global.__missStackN <= 6) {
            try { log('MISSSTACK', `#${global.__missStackN} :: ${new Error().stack.split('\n').slice(1, 10).join(' | ').slice(0, 1100)}`); } catch (_) {}
          }
          // fingerprint the top-2 caller frames and tally, dump at the end
          try {
            const fp = new Error().stack.split('\n').slice(1, 4).map(s => s.trim().slice(0, 90)).join(' <- ');
            global.__missFp = global.__missFp || new Map();
            global.__missFp.set(fp, (global.__missFp.get(fp) || 0) + 1);
          } catch (_) {}
        }
      }
      // Global-poll heal: the controller (and phases) poll missing globals
      // directly (window.<bridge>, unlike the CNmxZ4.includes polls). After
      // sustained polling, define a logging bridge so the flow proceeds —
      // the real semantics get wired from what the callers then do with it.
      if (/^[A-Za-z][A-Za-z0-9]{3,7}$/.test(k) && !global.__inTick) {
        const c = (global.__gPoll = global.__gPoll || new Map());
        c.set(k, (c.get(k) || 0) + 1);
        if (c.get(k) === 25) {
          t[k] = function (...a) { log('GHEAL', `${k} called args=${JSON.stringify(a, (x, y) => typeof y === 'function' ? 'fn' : y).slice(0, 120)}`); return { ok: true, name: k }; };
          log('GHEAL', `defined polled global window.${k} (polled 25x)`);
        }
      }
      return undefined;
    },
    // Accurate has: an unconditional true hijacks contextify's intrinsic
    // resolution — 'Reflect'/'eval' etc. resolve through the proxy's get
    // (MISS -> undefined) instead of the context's lexical intrinsics,
    // leaving window.Reflect/eval undefined and spinning the VM's identity
    // checks forever. Browser semantics: absent keys are NOT in window.
    has(t, k) { try { return k in t; } catch (_) { return false; } },
    set(t, k, v) {
      log('WSET', `window.${String(k)} = ${typeof v} ${String(v).slice(0, 60)}`);
      // Debug-only: full source dump of function globals (name <=7 chars).
      if (typeof v === 'function' && /^[A-Za-z][A-Za-z0-9]{2,7}$/.test(String(k))) {
        try { fs.appendFileSync(path.join(__dirname, 'wset-fns.log'), `window.${k} = ${v.toString()}\n//----\n`); } catch (_) {}
      }
      try { t[k] = v; } catch (_) {}
      return true;
    },
  });
  // The context global MUST be the plain window: a Proxy global blocks
  // contextification entirely — lexical intrinsics (eval/Reflect/...) never
  // get injected, so window.eval/window.Reflect resolve to undefined and the
  // VM's identity checks spin forever. The observation proxy stays available
  // for diagnostics but no longer serves as the realm.
  // Window-SET observer (plain ctx, before contextify so VM writes pass
  // through it): log every function-typed global the orchestrate defines.
  let winObs = env.window;
  if (process.env.HARNESS_WSET === '1') {
    global.__wget = new Map();
    global.__wmiss = new Map();
    // Periodic summary (watchdog process.exit skips the finalizer path).
    setInterval(() => {
      try {
        const ws = [...global.__wget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k2, n]) => `${k2}:${n}`).join(' ');
        log('WGETSUM', `total=${global.__wget.size} ${ws}`);
        const rare = [...global.__wget.entries()].filter(([, n]) => n <= 3).map(([k2]) => k2).slice(0, 60);
        if (rare.length) log('WGETRARE', rare.join(' '));
        if (global.__wmiss && global.__wmiss.size) {
          log('WMISS', [...global.__wmiss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k2, n]) => `${k2}:${n}`).join(' '));
          log('WMISSORDER', [...global.__wmiss.keys()].slice(0, 50).join(' '));
        }
        if (global.__oget && global.__oget.size) {
          log('OGETORDER', [...global.__oget.keys()].slice(0, 40).join(' '));
          if (global.__omiss && global.__omiss.size) log('OMISS', [...global.__omiss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k2, n]) => `${k2}:${n}`).join(' '));
        }
      } catch (_) {}
    }, 8000).unref();
    winObs = new Proxy(env.window, {
      set(t, k, v) {
        if (typeof k === 'string' && !k.startsWith('__')) {
          log('WSET', `window.${k} = ${typeof v} ${String(v).slice(0, 70)}`);
          if (typeof v === 'function' && /^[A-Za-z][A-Za-z0-9_]{2,11}$/.test(k)) {
            try { fs.appendFileSync(path.join(__dirname, 'wset-fns.log'), `window.${k} = ${v.toString()}\n//----\n`); } catch (_) {}
          }
        }
        t[k] = v; return true;
      },
      get(t, k) {
        if (typeof k === 'string' && !k.startsWith('__')) {
          global.__wget.set(k, (global.__wget.get(k) || 0) + 1);
          const v = Reflect.get(t, k);
          if (v === undefined && /^[A-Za-z$][A-Za-z0-9$]{3,10}$/.test(k)) global.__wmiss.set(k, (global.__wmiss.get(k) || 0) + 1);
          return v;
        }
        return Reflect.get(t, k);
      },
    });
  }
  const ctx = vm.createContext(winObs);
  // The challenge VM (Hl.run) relocates into the sandbox-iframe realm and
  // verifies cross-realm intrinsic identity by polling window.Reflect (and
  // siblings) until they match its own realm. Expose the context's
  // intrinsics on the backing window (same treatment the widget realm gets);
  // Date is re-applied after so the pinned-session clock shift survives.
  for (const n of ['Function', 'Array', 'ArrayBuffer', 'Reflect', 'Object',
                   'String', 'Symbol', 'DataView', 'TextEncoder', 'Map',
                   'WeakSet', 'Math', 'JSON', 'Promise', 'RegExp']) {
    try { env.window[n] = vm.runInContext(n, ctx); } catch (_) {}
  }
  // The challenge VM (Hl.run) calls window.eval(code) — expose the context's
  // OWN eval so cross-realm identity checks pass (a harness arrow function
  // fails the identity poll and the VM spins on it forever).
  // NOTE: vm.runInContext('eval', ctx) reads through the loggedWindow proxy
  // whose MISS branch returns undefined — the context's own eval was shadowed
  // all along. A direct function makes BOTH the VM's eval identifier and
  // window.eval resolve to the same callable, so identity checks pass.
  // window.eval must be a NATIVE-fingerprint eval: the VM fingerprints it
  // via Function.prototype.toString.call. The context's OWN eval
  // (vm.runInContext('eval')) is native AND evaluates phase scripts into the
  // same context — so a phase script's Reflect/eval globals are identical to
  // the window's, closing the cross-realm identity spin (the host eval ran
  // phases on Node's globalThis, whose Reflect !== the ctx's).
  try { env.window.eval = vm.runInContext('eval', ctx); } catch (_) { env.window.eval = eval; }
  // Phase-script observer (HARNESS_PHASE_DUMP=1): the VM evals its phase
  // scripts through the context's eval — capture each code for review.
  if (process.env.HARNESS_PHASE_DUMP === '1') {
    const rawEval = env.window.eval;
    const loggingEval = function (code) {
      try { fs.appendFileSync(path.join(__dirname, 'phase-evals.log'), '=====[' + new Date().toISOString() + ']=====\n' + String(code).slice(0, 3000) + '\n'); } catch (_) {}
      return rawEval.call(this, code);
    };
    try { Object.defineProperty(loggingEval, 'toString', { value: () => 'function eval() { [native code] }' }); } catch (_) {}
    env.window.eval = loggingEval;
    log('PHASE', 'eval observer armed');
  }
  // Bridge stubs REMOVED (round11 ts-timeline + CNmxZ4 probe evidence): the
  // orchestrate VM defines its own bridges AND self-registers them into
  // CNmxZ4. Pre-defined stubs make the VM's definition code skip the push
  // (name already present), so the wait loop polls includes(XnuWO5)=false
  // forever and the api.js tag is never created.
  // upgrade seeded perf entries to real PerformanceResourceTiming instances
  try {
    for (let i = 0; i < env.perfEntries.length; i++) {
      const raw = env.perfEntries[i];
      if (raw.entryType !== 'resource') continue;
      const e = new env.window.PerformanceResourceTiming();
      Object.assign(e, raw, { toJSON() { return { ...raw }; } });
      env.perfEntries[i] = e; env.window.__pendingPerf[i] = e;
    }
  } catch (_) {}
  vm.runInContext('var window = this; var document = this.document; var navigator = this.navigator; var location = this.location;', ctx);
  // Proxy construction observer (HARNESS_PROXY_SPY=1): VM phases new Proxy(x, h)
  // with x coming from the environment — log what x is when it's not an object.
  if (process.env.HARNESS_PROXY_SPY === '1') {
    try {
      // Instrument lM's pool-load to catch WHICH slot yields undefined:
      // the VM reads Hp=HH.h[Hp^HH[HI]] just before new Proxy(Hp, {apply}).
      log('LMSPI', 'skipped (anchor drift)');
      vm.runInContext(`(function(){ const OP = globalThis.Proxy; globalThis.Proxy = new OP(function(t, h) { try { if ((t === null || t === undefined || typeof t !== 'object') && (globalThis.__psN = (globalThis.__psN||0)+1) <= 8) console.error('[PROXYSPY] target=' + String(t).slice(0,40) + ' keys=' + (h ? Object.keys(h).join(',') : '?') + ' STACK=' + String(new Error().stack).split(String.fromCharCode(10)).slice(1,6).join(' | ').slice(0,500)); } catch (_) {} return new OP(t, h); }, OP); globalThis.Proxy.prototype = OP.prototype; })()`, ctx);
      log('PROXYSPY', 'Proxy constructor observer installed');
    } catch (e) { log('ERR', 'proxy spy: ' + e.message); }
  }
  // With the accurate has-trap, lexical intrinsics resolve normally inside
  // the ctx — pull them out and mirror them onto the window object so
  // window.Reflect/eval/... are the ctx's OWN intrinsics (identity checks
  // pass, fingerprint is native). This is the browser's own arrangement.
  try {
    for (const n of ['eval','Reflect','Function','Array','ArrayBuffer','Object','String','Symbol','DataView','TextEncoder','TextDecoder','Map','Set','WeakMap','WeakSet','Math','JSON','Promise','RegExp','Error','TypeError','RangeError','SyntaxError','EvalError','ReferenceError','URIError','AggregateError','Number','Boolean','BigInt','Proxy','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','Uint8Array','Uint8ClampedArray','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','globalThis']) {
      let v = vm.runInContext(n, ctx);
      // Web-API globals (TextEncoder etc.) are NOT contextified — fall back
      // to the host's own (the VM's direct-eval phase scripts read them as
      // bare identifiers and crashed with ReferenceError otherwise).
      if (v === undefined && globalThis[n] !== undefined) v = globalThis[n];
      if (v !== undefined && n !== 'Date') env.window[n] = v;  // Date keeps the virtual shift
    }
  } catch (_) {}
  let scriptSrc = scriptPath ? fs.readFileSync(scriptPath, 'utf8') : orch.text;
  // opt READ recorder, installed BEFORE the orchestrate eval so the machines
  // capture the proxy reference itself (the post-eval OPT_FIELDS proxy was
  // bypassed — the machine had already grabbed the raw object).
  if (process.env.HARNESS_OPTGET === '1') {
    const rawOpt2 = env.window._cf_chl_opt;
    if (rawOpt2 && typeof rawOpt2 === 'object') {
      global.__oget = new Map();
      global.__omiss = new Map();
      env.window._cf_chl_opt = new Proxy(rawOpt2, {
        get(t, k) { if (typeof k === 'string' && !String(k).startsWith('__')) { global.__oget.set(k, (global.__oget.get(k) || 0) + 1); const v = Reflect.get(t, k); if (v === undefined && /^[A-Za-z$][A-Za-z0-9$]{2,10}$/.test(k)) global.__omiss.set(k, (global.__omiss.get(k) || 0) + 1); return v; } return Reflect.get(t, k); },
        set(t, k, v) { log('OSET', `.${String(k)} = ${typeof v} ${String(v).slice(0, 50)}`); t[k] = v; return true; },
      });
      setInterval(() => {
        try {
          const s = [...global.__oget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28).map(([k2, n]) => `${k2}:${n}`).join(' ');
          log('OGETSUM', s);
        } catch (_) {}
      }, 8000).unref();
      log('OPTGET', 'pre-eval opt read recorder attached');
    }
  }
  // opt observation proxy now attaches directly (the old loggedWindow global
  // no longer serves as the ctx realm): field reads + array method calls.
  if (process.env.HARNESS_OPT_FIELDS === '1') {
    const rawOpt = env.window._cf_chl_opt;
    if (rawOpt && typeof rawOpt === 'object') {
      const px = new Proxy(rawOpt, {
        get(t, k) {
          if (typeof k === 'string' && !k.startsWith('__')) { const c = (global.__optFields = global.__optFields || new Map()); c.set(k, (c.get(k) || 0) + 1); }
          const v = t[k];
          if (Array.isArray(v) && /^[A-Za-z][A-Za-z0-9]{3,8}$/.test(String(k))) {
            global.__optArrPx = global.__optArrPx || new Map();
            if (!global.__optArrPx.has(k) || global.__optArrPx.get(k).__raw !== v) {
              const apx = new Proxy(v, { get(a, m) { if (typeof m === 'string' && m !== 'length' && m !== '__raw') { const cc = (global.__optArrCalls = global.__optArrCalls || new Map()); cc.set(k + '.' + m, (cc.get(k + '.' + m) || 0) + 1); } return a[m]; } });
              apx.__raw = v;
              global.__optArrPx.set(k, apx);
            }
            return global.__optArrPx.get(k);
          }
          return v;
        },
        set(t, k, v) { if (typeof k === 'string' && !k.startsWith('__')) log('OPTSET', `.${k} = ${typeof v} ${String(v).slice(0, 60)}`); t[k] = v; return true; },
      });
      env.window._cf_chl_opt = px;
      log('OPTPROXY', 'opt observation attached (plain-ctx mode)');
    }
  }
  // One-shot VM-loop instrumentation (debug): count iterations and report pc.
  if (process.env.HARNESS_GZ_TRACE === '1') {
    // Number every case inside GZ's jump-table region (source line 3,
    // cols ~17700-18550) to see exactly where the machine halts.
    try {
      const lines = scriptSrc.split('\n');
      let l3 = lines[2];
      let gzN = 0;
      const head = l3.slice(0, 7200);
      let body = l3.slice(7200, 18560);
      body = body.replace(/;case /g, ";console.error('[GZC] '+(globalThis.__gzc=(globalThis.__gzc||0)+1));case ");
      lines[2] = head + body + l3.slice(18560);
      scriptSrc = lines.join('\n');
      log('GZTRACE', 'GZ case tracer injected');
    } catch (e) { log('ERR', 'gz trace: ' + e.message); }
  }
    if (process.env.HARNESS_TICK_TRACE === '1') {
    // 1s tick: count tp/G0/Gn paths to see which branch the tick takes.
    const anchors = [
      ['function G0(iA,c2,tV){if(iA=', 'G0'],
      ['function Gn(', 'Gn'],
    ];
    for (const [anchor, name] of anchors) {
      if (scriptSrc.includes(anchor)) {
        const inj = `if((globalThis.__tick_${name}=(globalThis.__tick_${name}||0)+1)<=3||globalThis.__tick_${name}%10===0)console.error('[TICK] ${name} #'+globalThis.__tick_${name});`;
        scriptSrc = scriptSrc.replace(anchor, inj + anchor);
        log('TICKTRACE', name + ' counter injected');
      } else log('TICKTRACE', name + ' anchor not found');
    }
  }
if (process.env.HARNESS_TO_TRACE === '1') {
    // Async machine stepper: log the machine's pc fields at each resume to
    // see whether it advances or parks at the same point every 550ms.
    const anchorT = 'function to(Hp,HH,Hf,Hv,HZ,HE,HN,Hc,HW,Hw,oG,d8,Hr,Hh,HO,Hg,Hy,HR,HS,HA,HT,HI,HU,Hq,Hk,HB,Hd,Hx,HD,HK,Hu,HV,HY,HL,HM,Hn,HP,Hm,Hi){';
    if (scriptSrc.includes(anchorT)) {
      scriptSrc = scriptSrc.replace(anchorT, anchorT + "if((globalThis.__toN=(globalThis.__toN||0)+1)<=4||globalThis.__toN%40===0){try{var __keys=Hp?Object.keys(Hp).join(','):'-';var __fields=Hp?JSON.stringify(Object.keys(Hp).slice(0,14).map(function(k){var v=Hp[k];return k+':'+((v===null)?'null':(v===undefined)?'U':(typeof v==='function')?'fn':(typeof v==='object')?(Array.isArray(v)?('A'+v.length):(typeof v==='number'?'num':'obj')):String(v).slice(0,18))})):'';console.error('[TO] n='+globalThis.__toN+' keys='+__keys+' :: '+__fields)}catch(e){console.error('[TO] err '+e.message)}}if(!globalThis.__parkDump&&globalThis.__toN===40){globalThis.__parkDump=1;try{var __u=Hp.u,__h=Hp.h,__ops=[];for(var __k=Hp.i-12;__k<Hp.i+16&&__k<__u.length;__k++)__ops.push(__k+':'+__u[__k]);console.error('[PARKOPS] i='+Hp.i+' j='+Hp.j+' '+__ops.join(' '));var __regs=[];for(var __k2=0;__k2<__h.length;__k2++){var __v2=__h[__k2];if(__v2===undefined||__v2===0||__v2===null)continue;__regs.push(__k2+':'+(typeof __v2==='number'?__v2:(typeof __v2==='string'?JSON.stringify(__v2.slice(0,24)):(typeof __v2==='function'?'fn:'+String(__v2).slice(0,40):(Array.isArray(__v2)?'A'+__v2.length:typeof __v2)))))}console.error('[PARKREGS] '+__regs.join(' '));console.error('[PARKC] '+String(Hp.C).slice(0,200));console.error('[PARKB] '+String(Hp.B));var __nm=[];for(var __k3=0;__k3<__u.length;__k3++){var __e3=__u[__k3];if(__e3&&__e3.length===4&&typeof __e3[3]==='string')__nm.push(__k3+':'+__e3[3])}console.error('[PARKNAMES] '+__nm.join(' | '))}catch(e){console.error('[PARK] err '+e.message)}}");
      log('TOTRACE', 'async machine pc logger injected');
    } else log('TOTRACE', 'anchor not found');
  }
  if (process.env.HARNESS_LM_FIX === '1') {
    // lM's `new Proxy(Hp, ...)` gets Hp from the VM object pool; in our env
    // one slot loads as undefined. Browser semantics: the wrapped callable
    // exists. Give the phase a pass-through callable so the machine proceeds
    // (the wrap is observation-only in the browser too).
    // lo = tE[aa][ac] is resolved at eval time from the environment table —
    // instrument the assignment to see what lo actually is in our env.
    const anchorQ = ':if(typeof Hp!==d7(oB.r))throw new TypeError;continue}break}}function HG(';
    if (scriptSrc.includes(anchorQ)) {
      scriptSrc = scriptSrc.replace(anchorQ,
        String.raw`:console.error('[LMQ] Hp='+String(Hp).slice(0,60)+' HfKeys='+(Hf&&Hf[1]?Object.keys(Hf[1]).join(','):'?')+' HU='+HU+' HHi='+HH.i+' HF0='+(Hf&&Hf[0]===void 0?'UNDEF':String(Hf[0]).slice(0,80)));if(Hf&&Hf[0]===void 0){Hf[0]=function(){return 1};console.error('[LMFIX2] undefined target stubbed at HHi='+HH.i)}if(typeof Hp!==d7(oB.r))throw new TypeError;continue}break}}function HG(`);
      log('LMFIX', 'case-q probe injected');
    } else log('LMFIX', 'q anchor not found');
    const anchor2 = ',lo=tE[ct(qW.aa)][ct(qW.ac)],';
    if (scriptSrc.includes(anchor2)) {
      scriptSrc = scriptSrc.replace(anchor2,
        String.raw`,lo=function(t,h){if(t===void 0||t===null){console.error('[LOSPY] target='+String(t)+' handlerKeys='+(h?Object.keys(h).join(','):'?')+' STACK='+String(new Error().stack).split(String.fromCharCode(10)).slice(1,5).join(' | ').slice(0,400));t=function(){return 1}}return __origLo(t,h)},__origLo=tE[ct(qW.aa)][ct(qW.ac)],`);
      log('LMFIX', 'lo spy/guard injected');
    } else log('LMFIX', 'lo anchor not found');
  }
  if (process.env.HARNESS_GZAC === '1') {
    const anchor = 'return G(290725,S,[at(f1.af)]),!tZ';
    if (scriptSrc.includes(anchor)) {
      scriptSrc = scriptSrc.replace(anchor, "console.error('[GZAC] X='+at(f1.ad)+' Y='+at(f1.ae)+' Xval='+(typeof globalThis[at(f1.ad)])+' XYval='+(globalThis[at(f1.ad)]?typeof globalThis[at(f1.ad)][at(f1.ae)]:'?'));" + anchor);
      log('GZAC', 'case-ac probe injected');
    } else log('GZAC', 'anchor not found');
  }
  if (process.env.HARNESS_L7_DUMP === '1') {
    const anchor = 'function l7(';
    const idx = scriptSrc.indexOf(anchor);
    if (idx >= 0) {
      // 在 l7 体内第一条语句后注入:dump VM 栈数组
      const bodyStart = scriptSrc.indexOf('{', idx + 12);
      const injectAt = scriptSrc.indexOf(';', bodyStart) + 1;
      const inj = "if(!globalThis.__l7d&&(globalThis.__l7d=1))try{console.error('[L7D] stack='+JSON.stringify(Hv&&Hv.slice?Hv.slice(0,4).map(function(v){return (v&&typeof v==='object')?(Array.isArray(v)?('A['+v.length+']:'+JSON.stringify(v.slice(0,14)).slice(0,220)):('o:'+Object.keys(v).slice(0,8).join('/'))):String(v).slice(0,20)}):null))}catch(e){};" ;
      scriptSrc = scriptSrc.slice(0, injectAt) + inj + scriptSrc.slice(injectAt);
      log('L7D', 'l7 stack dump injected');
    }
  }
  if (process.env.HARNESS_FO_TRACE === '1') {
    // Disabled injection: in the re-pinned bytes the anchor sits in an
    // expression context — prepending a statement there is a SyntaxError.
    // fo/ emission is visible via [XHR] logs; re-enable only with a
    // statement-safe anchor.
    const anchor = 'eh=aJ(fq.b9)+l[aJ(fq.ba)][ee]+`/fo/698082038:1792779014:7TbuL-o73EV2lI85eaLfNM-OZpPw73wVa8Q8qbn8vUs/`';
    if (scriptSrc.includes(anchor)) log('FOTRACE', 'fo/ anchor present (injection disabled)');
    else log('FOTRACE', 'anchor not found');
  }
  if (process.env.HARNESS_VM_TICK === '1') {
    const patched = scriptSrc.replace('let HT=HB[HY];',
      "let HT=HB[HY];if(!globalThis.__names){globalThis.__names=1;try{console.error('[NAMES] '+[118,1086,1087,865,939,250,300,222,267,938,990,991,68,161,24,23].map(function(i){try{return i+'='+eval('al('+i+')')}catch(e){try{return i+'='+ak(i)}catch(e2){return i+'=?'}}}).join(' '));console.error('[NAMES2] '+[9,215,216,181,177,988,733,986,987,972,973,984,985,76,180,932,213,214,68,161].map(function(i){try{return i+'='+ak(i)}catch(e2){return i+'=?'}}).join(' '));var __w=window;console.error('[WSTATE] '+'fpwv7='+(typeof __w.fpwv7)+' val='+String(__w.fpwv7).slice(0,40)+' opt.fpwv7='+(typeof (__w._cf_chl_opt&&__w._cf_chl_opt.fpwv7))+' optKeys-f='+(function(){try{return Object.keys(__w._cf_chl_opt).filter(function(k){return /^f/.test(k)}).join(',')}catch(_){return '?'}})())}catch(e){console.error('[NAMES] err '+e.message)}}if(!globalThis.__pcsOn){globalThis.__pcsOn=1}try{if((globalThis.__g=(globalThis.__g||0)+1)%1000===0){globalThis.__pcs=globalThis.__pcs||[];if(globalThis.__pcs.length<600)globalThis.__pcs.push(HB[HY])}if((globalThis.__g)%20000===0){var __up=Array.from(new Set(globalThis.__pcs||[]));console.error('[VMTICK] n='+globalThis.__g+' pc='+HB[HY]+' samples='+((globalThis.__pcs||[]).length)+' uniq='+__up.length+' set='+__up.slice(0,40).join(','))}}catch(__e){console.error('[VMTICK] err '+__e.message)}if(!globalThis.__dumped&&HB[HY]>=1040&&HB[HY]<=1160){globalThis.__dumped=1;try{var __bc=[];for(var __i=1020;__i<1180&&__i<HB.length;__i++){__bc.push(__i+':'+(typeof HB[__i]==='number'?HB[__i]:String(HB[__i]).slice(0,10)))}console.error('[VMBYTES] '+__bc.join(' '));var __rg=[];for(var __k2=0;__k2<HB.length;__k2++){var __v2=HB[__k2];if(__v2===undefined||__v2===0||__v2===null||__k2===HY)continue;__rg.push(__k2+':'+(typeof __v2==='number'?__v2:(typeof __v2==='string'?JSON.stringify(__v2.slice(0,24)):(typeof __v2==='function'?'fn:'+String(__v2).slice(0,50):(Array.isArray(__v2)?'A'+__v2.length:typeof __v2)))))}console.error('[VMREGS2] '+__rg.join(' '));try{var __pa=null;for(var __q=0;__q<HB.length;__q++){if(Array.isArray(HB[__q])&&HB[__q].length===25){__pa=HB[__q];break}}if(__pa){var __sl=[];for(var __s=0;__s<__pa.length;__s++){var __e4=__pa[__s];__sl.push(__s+':'+(__e4===null?'null':__e4===undefined?'U':(typeof __e4==='object'?(('o' in __e4)?('o='+(typeof __e4.o)+':'+JSON.stringify(typeof __e4.o==='function'?String(__e4.o).slice(0,60):String(__e4.o).slice(0,28))):('obj{'+Object.keys(__e4).slice(0,8).join(',')+'}')):(typeof __e4==='function'?'fn':JSON.stringify(String(__e4).slice(0,28))))))}console.error('[PHASEARR] '+__sl.join(' | '))}}catch(e){console.error('[PHASEARR] err '+e.message)}console.error('[VMSTACK] '+JSON.stringify(Hv))}catch(e){console.error('[VMBYTES] err '+e.message)}}");
    if (patched !== scriptSrc) { scriptSrc = patched; log('BOOT', 'VM tick instrumentation ON'); }
  }
  log('RUN', 'executing orchestrate script');
  env.window.__throwLog = (stack) => log('THROW', String(stack).slice(0, 500));
  // Session container probe (HARNESS_FPWV7=1): the VM pump's wait polls read
  // a session container off window (pinned slot 118 'fpwv7'; this-live's
  // equivalent was 'xrbo0', a 9-key object). Seed one shaped like the
  // browser's to test whether the pump's gate passes.
  if (process.env.HARNESS_XRBO0 === '1') {
    // VMREGS 12 = xrbo0 (browser's 9-key session container, absent offline).
    // Seed it shaped like the browser snapshot and watch the phase advance.
    const xr = {};
    for (let i = 0; i < 9; i++) xr['k' + i] = function(){ return 1 };
    Object.defineProperty(env.window, 'xrbo0', {
      configurable: true,
      get() { if ((global.__xrN = (global.__xrN || 0) + 1) <= 3) { try { log('XRREAD', String(new Error().stack.split('\n').slice(1, 5).join(' | ')).slice(0, 420)); } catch (_) {} } return xr; },
      set(v) { log('XRSET', typeof v); }
    });
    log('XRBO0', 'seeded 9-key container on window');
  }
  if (process.env.HARNESS_PROMFEED === '1') {
    // 终稿三十: the phase machine parks at to() awaiting a real Promise that
    // never resolves. Track every `new Promise` created inside the challenge
    // context with its creation stack, then at v+12s resolve pending ones
    // one-by-one (600ms apart) and watch the TO pc logs to find which
    // resolution advances the machine.
    const RealP = env.window.Promise;
    const __P = [];
    const Patched = function Promise(executor) {
      let realRes, realRej;
      const stack = String(new Error().stack).split('\n').slice(2, 5).join(' | ').slice(0, 260);
      const p = new RealP((res, rej) => { realRes = res; realRej = rej; executor(res, rej); });
      const rec = { p, res: realRes, rej: realRej, stack, done: false, id: __P.length };
      __P.push(rec);
      if (__P.length <= 14) log('PROM', `#${rec.id} new Promise @ ${stack}`);
      RealP.resolve(p).then(() => { rec.done = true; }, () => { rec.done = true; });
      return p;
    };
    Patched.prototype = RealP.prototype;
    for (const st of ['resolve', 'reject', 'all', 'race', 'allSettled', 'any', 'withResolvers']) {
      if (RealP[st]) Patched[st] = RealP[st].bind(RealP);
    }
    env.window.Promise = Patched;
    setTimeout(() => {
      const list = __P.filter(r => !r.done);
      log('PROM', `pending=${list.length}/${__P.length} — resolving one-by-one`);
      let k = 0;
      const tick = () => {
        if (k >= list.length) { log('PROM', 'feed done'); return; }
        const r = list[k++];
        log('PROM', `resolve #${r.id} @ ${r.stack.slice(0, 110)}`);
        try { r.res(undefined); } catch (e) { log('PROM', `resolve #${r.id} threw ${e.message}`); }
        setTimeout(tick, 600);
      };
      tick();
    }, 12000);
    log('PROMFEED', 'Promise tracker installed');
  }
  if (process.env.HARNESS_REG_CALL === '1') {
    // Behavior-level: in the browser the phase machine invokes the registry
    // callbacks (HKul9.CgDs1=tO startup / cKYwE2=tg). Our machine parks at a
    // never-resolved await — invoke each registry entry once at v+8s and
    // watch whether the machine advances.
    setTimeout(() => {
      try {
        const reg = env.window.HKul9;
        if (!reg) { log('REGCALL', 'no registry'); return; }
        const names = Object.keys(reg);
        log('REGCALL', 'invoking ' + names.length + ' registry entries: ' + names.join(','));
        for (const nm of names) {
          try {
            if (typeof reg[nm] === 'function') {
              const r = reg[nm].call(reg);
              log('REGCALL', `${nm}() -> ${String(r).slice(0, 60)}`);
            }
          } catch (e) { log('REGCALL', `${nm} threw: ${e.message.slice(0, 80)}`); }
        }
      } catch (e) { log('ERR', 'regcall: ' + e.message); }
    }, 8000);
  }
  if (process.env.HARNESS_SESS_FEED === '1') {
    // 终稿三十九: the three throwing registry callbacks are a UI protocol —
    // X = {bRsU6: widget element, coza6: checkbox element}; tS mounts bRsU6
    // into V()'s container, td checks the checkbox, tA unmounts. Build that
    // session object and feed the trio; method-wrap them first to also catch
    // VM self-calls. Names bRsU6/coza6 are round-11 pinned (debug one-off).
    setTimeout(() => {
      try {
        const reg = env.window.HKul9;
        if (!reg) { log('SESS', 'no registry'); return; }
        let vstate = '?';
        try {
          const vres = typeof reg.MPUK6 === 'function' ? reg.MPUK6() : null;
          vstate = vres ? `<${vres.tagName}${vres.__id ? '#' + vres.__id : ''}>` : String(vres);
        } catch (e) { vstate = 'threw ' + e.message; }
        log('SESS', `V() -> ${vstate}`);
        for (const nm of ['oWPf2', 'Afjo3', 'HDQZU4']) {
          const orig = reg[nm];
          if (typeof orig !== 'function') continue;
          reg[nm] = function (...args) {
            const a0 = args[0];
            const shape = a0 && typeof a0 === 'object' ? Object.keys(a0).join(',') : String(typeof a0);
            log('SESS', `${nm} CALLED args=[${shape}] by ${String(new Error().stack).split('\n').slice(2, 5).join(' | ').slice(0, 300)}`);
            return orig.apply(this, args);
          };
        }
        log('SESS', 'trio method-wrapped');
        const doc = env.window.document;
        const el = doc.createElement('div');
        const inp = doc.createElement('input');
        el.appendChild(inp);
        const X = { bRsU6: el, coza6: inp };
        try {
          const r = reg.oWPf2(X);
          log('SESS', `oWPf2(X) -> ${String(r)} el.parentNode=<${el.parentNode && el.parentNode.tagName}>`);
        } catch (e) { log('SESS', `oWPf2 threw: ${e.message}`); }
        try {
          const r = reg.HDQZU4(X);
          log('SESS', `HDQZU4(X) -> ${String(r)} inp.disabled=${String(inp.disabled)} aria-checked=${String(inp.attrs && inp.attrs['aria-checked'])}`);
        } catch (e) { log('SESS', `HDQZU4 threw: ${e.message}`); }
        try {
          const r = reg.Afjo3(X);
          log('SESS', `Afjo3(X) -> ${String(r)} el.parentNode=${String(el.parentNode)}`);
        } catch (e) { log('SESS', `Afjo3 threw: ${e.message}`); }
      } catch (e) { log('ERR', 'sess: ' + e.message); }
    }, 8000);
  }
  if (process.env.HARNESS_RENDER_CALL === '1') {
    // Browser oracle (widgetMap.set breakpoint, 44-frame VM chain): the
    // orchestrate's VM machine calls turnstile.render(container, params) —
    // params are opt-derived constants. When our machine parks before that
    // call, reproduce it behavior-level at v+8s: render into the #XWAst9
    // container with the browser-observed shape; the controller then boots,
    // registers the bridges (window.<slot>) and the machine's poll passes.
    setTimeout(() => {
      try {
        const ts = env.window.turnstile;
        if (!ts || typeof ts.render !== 'function') { log('RENDERC', 'no turnstile.render'); return; }
        const container = env.window.document.querySelector('#XWAst9');
        log('RENDERC', `container=${container ? '<' + container.tagName + '#' + (container.__id || container.id || '') + '>' : 'null'}`);
        try {
          const HE = env.window.HTMLElement, EL = env.window.Element;
          log('RENDERC', `instanceof HE=${container instanceof HE} EL=${container instanceof EL} proto=${String(Object.getPrototypeOf(container) && Object.getPrototypeOf(container)[Symbol.toStringTag] || Object.getPrototypeOf(container) && Object.getPrototypeOf(container).constructor && Object.getPrototypeOf(container).constructor.name)} HEproto=${String(HE && HE.prototype && (HE.prototype[Symbol.toStringTag] || '?'))} sameProto=${container ? Object.getPrototypeOf(container) === HE.prototype : '?'}`);
          { let p2 = Object.getPrototypeOf(container), chain2 = []; for (let d2 = 0; d2 < 8 && p2; d2++) { chain2.push(String(p2[Symbol.toStringTag] || p2.constructor && p2.constructor.name || '?') + ':ap=' + (typeof p2.appendChild)); p2 = Object.getPrototypeOf(p2); } log('RENDERC', 'chain ' + chain2.join(' -> ')); }
        } catch (e2) { log('RENDERC', 'diag err ' + e2.message); }
        const o0 = env.window._cf_chl_opt || {};
        const noop = () => {};
        const params = {
          sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
          theme: 'light',
          action: 'managed',
          cData: String(o0.cRay || ''),
          chlPageData: String(o0.md || ''),
          retry: 'never',
          'refresh-expired': 'never',
          'refresh-timeout': 'never',
          callback: noop,
          'expired-callback': noop,
          'error-callback': noop,
          'timeout-callback': noop,
          'before-interactive-callback': noop,
          'after-interactive-callback': noop,
        };
        try {
          const g = env.window.document.createElement('div');
          const sr = g.attachShadow({ mode: 'closed' });
          log('RENDERC', `shadow diag: gAs=${String(g.attachShadow).slice(0, 120).replace(/\n/g, ' ')} | sr=${typeof sr} src=${String(sr).slice(0, 80).replace(/\n/g, ' ')}`);
        } catch (e2) { log('RENDERC', 'shadow diag err: ' + e2.message); }
        const wid = ts.render(container, params);
        log('RENDERC', `render() -> ${String(wid)}`);
      } catch (e) { log('ERR', 'renderc: ' + e.message + ' | ' + String(e.stack).split('\n').slice(1, 10).join(' | ').slice(0, 600)); }
    }, 8000);
  }
  if (process.env.HARNESS_BUW0 === '1') {
    // Browser golden table @fo/: opt.BuWQ0 = {LQfqz0:<6char>, toJSON} exists
    // BEFORE the fo/ XHR fires, and the parked machine's name table carries
    // BuWQ0/LQfqz0. Seed it at v+8s and watch for phase advance (names are
    // pinned-round11 slots — one-off debug tool).
    setTimeout(() => {
      try {
        const o0 = env.window._cf_chl_opt;
        o0.BuWQ0 = { LQfqz0: 'chejv1', toJSON() { return this.LQfqz0; } };
        log('BUW0', 'opt.BuWQ0 seeded {LQfqz0,toJSON}');
      } catch (e) { log('ERR', 'buw0: ' + e.message); }
    }, 8000);
  }
  if (process.env.HARNESS_AKE4_WRITE) {
    // Late-phase probe: after the stub fix the pump waits (plain polling) on
    // opt[AKECH4]. Write the browser-shaped session value at v+6s and watch
    // whether the machine advances to RTC/fo/.
    const oW = env.window._cf_chl_opt;
    setTimeout(() => {
      try {
        oW.AKECH4 = 'go';
        log('AKE4W', 'opt.AKECH4 written (obj shape)');
      } catch (e) { log('ERR', 'ake4w: ' + e.message); }
    }, 6000);
  }
  if (process.env.HARNESS_AKECH4) {
    // The VM pump polls opt[AKECH4-slot name] (session-name stable across
    // pinned bytes). Seed the requested shape to probe the gate.
    const shape = process.env.HARNESS_AKECH4;
    const o0 = env.window._cf_chl_opt;
    if (o0) {
      if (shape === 'arr') o0.AKECH4 = [];
      else if (shape === 'arrok') o0.AKECH4 = ['0'];
      else if (shape === 'obj') o0.AKECH4 = {};
      log('AKECH4', 'seeded shape=' + shape);
    }
  }
  if (process.env.HARNESS_FPWV7 === '1') {
    const container = {};
    for (let i = 0; i < 9; i++) container['k' + i] = 0;
    env.window.fpwv7 = container;
    log('FPWV7', 'seeded window.fpwv7 container (9 keys)');
  }
  const prelude = `;((w)=>{const OF=w.Function;try{w.Function=function(...a){a[a.length-1]=String(a[a.length-1]).replace(/debugger/g,'');return OF.apply(null,a);};Object.setPrototypeOf(w.Function,OF);w.Function.prototype=OF.prototype;}catch(_){}
    const O=w.TypeError;function TE(...a){const e=new O(...a);
    try{w.__throwLog('TypeError('+String(a[0]).slice(0,60)+') @ '+String(new O().stack).split('\\n').slice(2,5).join(' | '));}catch(_){}
    return e;}Object.setPrototypeOf(TE,O);TE.prototype=O.prototype;w.TypeError=TE;})(this);`;
  try {
    vm.runInContext(prelude + scriptSrc, ctx, { filename: 'orchestrate.js' });
    log('RUN', 'orchestrate initial eval finished');
    // api.js onload-callback call probe: parse onload=<name> from the served
    // api.js URL (dynamic per generation), wrap that global, and log every
    // call. api.js invokes it once its own boot completes; if it never fires,
    // the orchestrate's phase machine waits forever (pump pc 1050<->1152).
    try {
      let onloadName = null;
      const waitUrl = () => {
        const apiUrl = global.__apiJsUrl;
        if (!apiUrl) { setTimeout(waitUrl, 200); return; }
        const m = String(apiUrl).match(/[?&]onload=([A-Za-z0-9_$]+)/);
        onloadName = m ? m[1] : null;
        log('ONLOAD', `api.js url=${String(apiUrl).slice(0, 90)} onload=${onloadName}`);
        if (!onloadName) return;
        let orig = env.window[onloadName];
        global.__onloadCalls = 0;
        const wrapped = function (...a) {
          global.__onloadCalls++;
          log('ONLOAD', `${onloadName}() CALLED #${global.__onloadCalls} by ${String(new Error().stack).split('\n').slice(2, 5).join(' | ').slice(0, 320)}`);
          return orig ? orig.apply(this, a) : undefined;
        };
        Object.defineProperty(env.window, onloadName, {
          configurable: true,
          get() { return wrapped; },
          set(v) { orig = v; log('ONLOAD', `${onloadName} redefined (type=${typeof v})`); },
        });
        setTimeout(() => log('ONLOAD', `summary: ${onloadName} calls=${global.__onloadCalls}`), 20000);
      };
      waitUrl();
    } catch (e) { log('ONLOAD', 'probe err: ' + e.message); }
    // CNmxZ4 bridge-registration heal: the orchestrate's machines poll
    // includes(<bridge>) and time out into their failure UI when the
    // registrant side (api.js controller / widget handshake) never runs.
    // In the browser every polled name IS eventually registered; register
    // each polled name on first ask (runtime-observed, nothing hardcoded).
    // Add CNMX_HEAL=0 to disable for pure observation.
    try {
      const o4 = env.window._cf_chl_opt;
      if (o4 && Array.isArray(o4.CNmxZ4)) {
        const raw4 = o4.CNmxZ4;
        const heal = process.env.CNMX_HEAL !== '0';
        o4.CNmxZ4 = new Proxy(raw4, {
          get(t, k) {
            if (k === 'includes') return (sz) => {
              let r = t.includes(sz);
              if ((global.__cnmxQ = (global.__cnmxQ || 0) + 1) <= 60 || global.__cnmxQ % 200 === 0) log('CNMXQ', `#${global.__cnmxQ} includes(${String(sz)}) -> ${r}`);
              // The orchestrate's machines poll includes(<bridge>) and time
              // out into their failure UI when the registrant side (api.js
              // controller / widget handshake) is blocked downstream. In the
              // browser every polled name IS eventually registered; register
              // each polled name on first ask (runtime-observed, nothing
              // hardcoded). CNMX_HEAL=0 disables for pure observation.
              // Inside the 1s tick the includes calls are GATE checks (tp's
              // "handshake done?" poll) — never heal there or tp dead-locks.
              const forceOne = process.env.CNMX_FORCE && String(sz) === process.env.CNMX_FORCE;
              if (!r && (forceOne || (!global.__inTick && heal)) && typeof sz === 'string' && sz.length >= 4 && /^[A-Za-z0-9]{4,8}$/.test(sz)) {
                t.push(sz); r = true;
                global.__cnmxN = (global.__cnmxN || 0) + 1;
                if (global.__cnmxN <= 40) log('CNMX', `heal: registered polled bridge ${sz}`);
              }
              return r;
            };
            return t[k];
          },
          set(t, k, v) { log('CNMX', `push/set ${String(k)}=${String(v)}`); t[k] = v; return true; },
        });
        log('CNMX', `probe installed on VM CNmxZ4 (heal=${heal})`);
      } else log('CNMX', `no CNmxZ4 array (opt=${typeof o4}, cnmx=${o4 && typeof o4.CNmxZ4})`);
    } catch (e) { log('CNMX', 'probe err: ' + e.message); }
    // Registry write probe: window.HKul9 is the orchestrate's handler registry
    // (QPUYE4/Rcdr8/ivcgo1/...). The tick gates on !HKul9.QPUYE4 — log who
    // flips any of its flags.
    try {
      const reg = env.window.HKul9;
      if (reg && typeof reg === 'object') {
        env.window.HKul9 = new Proxy(reg, {
          set(t, k, v) { log('REG', `set ${String(k)}=${String(v)} by ${String(new Error().stack).split('\n')[2] && String(new Error().stack).split('\n').slice(1, 6).join(' | ').slice(0, 420)}`); t[k] = v; return true; },
          get(t, k) { return t[k]; },
        });
        log('REG', 'write probe installed on window.HKul9');
      } else log('REG', `no registry yet (HKul9=${typeof reg})`);
    } catch (e) { log('REG', 'probe err: ' + e.message); }
    // round11 timeline (ts_us-verified): orchestrate creates the api.js tag
    // FIRST (t0+5s), api.js boots (t0+60s), THEN the fo/#1 XHR (t0+107s) and
    // the stage2 (fo/ response JS) eval. Evaling stage2 here — before api.js —
    // registers the bridges early and the orchestrate takes its
    // "already-booted" branch (includes(XnuWO5)=true) and never creates the
    // api.js tag. The orchestrate reaches stage2 itself via its own XHR.
  } catch (e) {
    log('ERR', `orchestrate threw: ${e && (e.name + ': ' + e.message)}`);
    log('ERR', `stack: ${String(e && e.stack).split('\n').slice(2, 7).join(' | ').slice(0, 700)}`);
  }

  // drive timers + XHR pump for a bounded window
  const deadline = Date.now() + (parseInt(process.env.HARNESS_MS || "60000"));
  let apiInjected = false;
  const apiKeysSnapshot = Object.keys(env.window);
  const injectTurnstile = async () => {
    if (apiInjected) return; apiInjected = true;
    try {
      // The real loader URL carries onload=<cb>; the name comes from the
      // page's own turnstile tag when present, else the decoded bridge name.
      const pageTag = String(page.text).match(/turnstile[^"']*onload=([A-Za-z0-9_]+)/);
      const cbName = (pageTag && pageTag[1]) || 'coTgT4';
      log('CALLBACK', `api.js onload name: ${cbName}`);
      const apiSrc = `https://challenges.cloudflare.com/turnstile/v0/b/d2d3316b729e/api.js?onload=${cbName}&render=explicit`;
      const r = await httpReq('GET', apiSrc, { Referer: BASE + '/', Accept: '*/*' });
      try { fs.writeFileSync(path.join(__dirname, 'pinned-api.js'), r.text); } catch (_) {}
      log('SCRIPT', `injecting turnstile api.js (${r.text.length}B, status ${r.status})`);
      const tag = env.document.createElement('script');
      tag.src = apiSrc; tag.async = true;
      env.document.head.appendChild(tag);
      env.window.__pendingPerf = env.perfEntries.slice();
      env.perfEntries.push({ name: apiSrc, entryType: 'resource', initiatorType: 'script',
        startTime: 1500.1, duration: 310.2, fetchStart: 1500.2, requestStart: 1505.1,
        responseStart: 1540.4, responseEnd: 1810.3, transferSize: 88996,
        encodedBodySize: 88666, decodedBodySize: 88666, nextHopProtocol: 'h2' });
      env.window.__pendingPerf.push(env.perfEntries[env.perfEntries.length - 1]);
      const prev = env.document.currentScript;
      Object.defineProperty(env.document, 'currentScript', { configurable: true, get: () => tag });
      // the orchestrate VM treats performance entries as state-machine
      // events; the api.js load IS the signal it waits for.
      try {
        const raw = env.window.__mkResourceEntry(apiSrc);
        const proxied = new Proxy(raw, {
          get(t2, k) {
            if (typeof k === 'string' && k !== 'toJSON') log('ENTRY', `.${k} -> ${String(t2[k]).slice(0, 40)}`);
            return t2[k];
          },
        });
        // The pinned session's VM wait-loop polls window['XnuWO5'] (b4@707
        // evidence, scopes-707.json). Define it like the browser's widget
        // flow would, then deliver the entry.
        env.window.__notifyResource && env.window.__notifyResource(proxied);
      } catch (_) {}
      try {
        vm.runInContext(r.text, ctx, { filename: 'turnstile-api.js' });
      } finally {
        Object.defineProperty(env.document, 'currentScript', { configurable: true, get: () => prev });
      }
      log('SCRIPT', 'turnstile api.js evaluated');
      try {
        const before = new Set(apiKeysSnapshot);
        const after = Object.keys(env.window);
        const added = after.filter(k => !before.has(k));
        log('SCRIPT', 'globals added by api.js: ' + JSON.stringify(added.slice(0, 40)));
        log('SCRIPT', 'window.turnstile = ' + String(typeof env.window.turnstile));
        const tsObj = env.window.turnstile;
        if (tsObj && typeof tsObj === 'object') {
          env.window.turnstile = new Proxy(tsObj, {
            get(t2, k) {
              const v = t2[k];
              if (typeof v === 'function') {
                return (...args) => {
                  let __as=''; try { __as = JSON.stringify(args).slice(0, 110); } catch (_) { __as = String(args[0] && args[0].tagName ? '<' + args[0].tagName + '>' : String(args[0]).slice(0, 40)); } log('TURNSTILE', `.${String(k)}(${__as})`);
                  try { return v.apply(t2, args); } catch (e) { log('ERR', `turnstile.${String(k)}: ${e.message}`); }
                };
              }
              log('TURNSTILE', `.get ${String(k)} -> ${String(v).slice(0, 40)}`);
              return v;
            },
          });
        }
      } catch (e) { log('ERR', 'keydiff: ' + e.message); }
    } catch (e) { log('ERR', 'turnstile inject: ' + e.message); }
  };
  const lifecycleNotified = new Set();
  const fireLifecycle = () => {
    // readyState transitions ride the lifecycle: 'interactive' with
    // DOMContentLoaded, 'complete' with load (browser semantics).
    if (env.document.readyState === 'loading' && (env.listeners.get('DOMContentLoaded') || []).length) env.document.__advanceReadyState('interactive');
    if (env.document.readyState === 'interactive' && (env.listeners.get('load') || []).length) env.document.__advanceReadyState('complete');
    for (const name of ['DOMContentLoaded', 'load', 'pageshow']) {
      const ev = { type: name, target: env.window.document, currentTarget: env.window.document, isTrusted: true };
      for (const fn of [...(env.listeners.get(name) || [])]) {
        if (lifecycleNotified.has(fn)) continue;
        lifecycleNotified.add(fn);
        try { fn(ev); log('DOM', `dispatched ${name} (late listener catch-up)`); } catch (e) { log('ERR', `${name} handler: ${e.message}`); }
      }
      for (const fn of [...(env.listeners.get('window:' + name) || [])]) {
        if (lifecycleNotified.has(fn)) continue;
        lifecycleNotified.add(fn);
        try { fn(ev); } catch (_) {}
      }
    }
  };
  let elapsed = 0;
  let widgetSeq = 0;
  const reportBridgeState = (tag) => {
    try {
      const o = env.window._cf_chl_opt || {};
      log('BRIDGE', `${tag} bridges=[coTgT4:${typeof env.window.coTgT4} AKECH4:${typeof env.window.AKECH4} XnuWO5:${typeof env.window.XnuWO5}] CNmxZ4=${JSON.stringify(o.CNmxZ4 || '').slice(0, 60)}`);
    } catch (_) {}
  };
  const deliverToRealms = (m) => {
    log('WIDGET', `parent->realm ${m.event} -> ${iframeRealms.reduce((a, e) => a + e.realmListeners.length, 0)} realm listener(s)`);
    for (const entry of iframeRealms) {
      for (const fn of entry.realmListeners.slice()) {
        const ev = { type: 'message', isTrusted: true, data: m, origin: 'https://www.cell.com', source: { postMessage: () => {} } };
        try { fn(ev); } catch (e) { log('ERR', `realm handler: ${e.message}`); }
      }
    }
  };
  const deliverFromWidget = (event, extra) => {
    const m = Object.assign({ source: 'cloudflare-challenge', widgetId: (env.window._cf_chl_opt && env.window._cf_chl_opt.cRay) || 'w1', event }, extra || {});
    const ev = { type: 'message', isTrusted: true, data: m, origin: 'https://challenges.cloudflare.com',
                 source: { postMessage: (d) => log('IFRAME', `widget reply ${JSON.stringify(d).slice(0, 80)}`) } };
    const ls = env.listeners.get('message') || [];
    log('WIDGET', `deliver ${event} ${JSON.stringify(extra || {}).slice(0, 80)} -> ${ls.length} listener(s)`);
    for (const fn of [...ls]) { try { fn(ev); } catch (e) { log('ERR', `message handler: ${e.message}`); } }
    if (!ls.length && env.window.onmessage) { try { env.window.onmessage(ev); } catch (e) { log('ERR', 'onmessage: ' + e.message); } }
  };
  let meowTimer = 0;
  setInterval(() => {
    try {
      const pt = [...V.q.values()].map(t => `${t.kind}@v${t.at - V.t0} ${String(t.fn).slice(0, 80).replace(/\n/g, ' ')}`);
      log('PDUMP', `pending=${pt.length} vnow=${V.now - V.t0} :: ${pt.slice(0, 8).join(' || ').slice(0, 700)}`);
      try { const o9 = env.window._cf_chl_opt || {}; const b9 = env.document.body; const ids=[]; const walk9=(n,d)=>{ if(d>4) return; for(const c of (n.children||[])){ ids.push('<'+c.tagName+(c.id?'#'+c.id:'')+'>'); walk9(c,d+1);} }; walk9(b9,0); log('PDUMP', `glEe8=${o9.glEe8 && o9.glEe8.tagName} bodySubtree=[${ids.slice(0,18).join(' ')}]`); } catch (_) {}      try { log('PDUMP', 'idElems=' + [...(global.__idElems || new Map()).keys()].slice(0, 12).join(',')); } catch (_) {}
      try { const r9 = vm.runInContext('try{const v=window.HKul9&&window.HKul9.MPUK6&&window.HKul9.MPUK6(); JSON.stringify({got:v!==null&&v!==undefined, tag:v&&v.tagName, idv:v&&(v.__id!==undefined?v.__id:v.id)})}catch(e){String(e.message).slice(0,80)}', ctx, { returnByValue: true }); log('PDUMP', 'MPUK6/V() -> ' + r9); } catch (_) {}
      try { const findX=(n,path,d)=>{ if(d>7) return null; const idv=(n.__id!==undefined?n.__id:(n.attrs&&n.attrs.id)); if(idv&&/^[A-Za-z][A-Za-z0-9]{5}$/.test(String(idv))&&n.tagName==='DIV') { for(const c of (n.children||[])){ const cx=(c.__id!==undefined?c.__id:(c.attrs&&c.attrs.id)); if(cx==='XWAst9') return path+'/<'+n.tagName+(idv?'#'+idv:'')+'>'; } } for(const c of (n.children||[])){ const r=findX(c,path+'/<'+n.tagName+'>',d+1); if(r) return r; } return null; }; log('PDUMP', 'XWAst9 parent=' + findX(env.document,'',0)); } catch (_) {}
      try { for (const x of (global.__openXHRs || new Set())) log('PDUMP', `UNSENT XHR ${String(x._u).slice(0, 70)} opened by ${x.__openStack}`); } catch (_) {}
    } catch (_) {}
  }, 20000);
  while (Date.now() < deadline) {
    // Virtual time pump: advance the simulated clock (at least 100ms; jump
    // ahead to the next pending virtual timer when that is sooner... rather,
    // when the queue is otherwise idle jump to the next timer so the whole
    // timeline replays without real waiting), then drain due callbacks.
    await new Promise(r => setTimeout(r, 5));  // real pacing: ~5ms per virtual 100ms
    const nxt = vNextAt();
    V.now += 100;
    vAnchor.virt = V.now; vAnchor.real = Date.now();
    if (nxt !== Infinity && nxt > V.now && V.q.size && ![...V.q.values()].some(t => t.at <= V.now)) V.now = nxt;
    elapsed += 100;
    try { vDrain(); } catch (e) { log('ERR', 'vDrain: ' + e.message); }
    // Periodic window-read counter dump: expose what the VM bytecode loop
    // polls (a spin = one key's count exploding).
    if (elapsed % 15000 === 0 && global.__wgetCounts) {
      const top = [...global.__wgetCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
      log('WGDUMP', top.map(([k2, n]) => `${k2}:${n}`).join(' '));
      global.__wgetCounts.clear();
    }
    // No manual api.js injection: the orchestrate VM creates its own script
    // tag (onload=DraY9 per round13 trace); our pump loads it below and the
    // controller calls window.DraY9 when ready — the browser-semantic path.
    // stage2 + CNmxZ4 enrollment removed: the round11 ts timeline proves the
    // orchestrate creates the api.js tag BEFORE the fo/ XHR/stage2, and a
    // pre-registered CNmxZ4 pushes the VM into its already-booted branch.
    if (elapsed % 5000 === 0) reportBridgeState(`t=${elapsed / 1000}s`);
    if (elapsed === 6000 && process.env.HARNESS_FEED === '1' && iframeRealms.length && !global.__realmFed) {
      global.__realmFed = true;
      const entry = iframeRealms[0];
      // Browser truth (round5/12/13): orchestrate's iframe hosts the f/av0
      // widget challenge page — the 824KB payload — NOT the controller.
      try {
        const fav0 = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/h14dt/0x4AAAAAAADnPIDROrmt1Wwj/light/fbE/new/normal?lang=auto';
        entry.element.src = fav0;
        entry.element.__src = fav0;
        await queueIframeLoad(entry.element, fav0);
      } catch (e) { log('ERR', `payload load: ${e.message}`); }
      // Browser truth (fav0-page.html artifact: zero <script src> tags): the
      // widget realm's only resident is the f/av0 inline payload. The parent
      // api.js controller stays in the main window and talks via postMessage.
      log('IFRAME', 'realm resident = f/av0 inline payload only (no parent api.js)');
    }
    if (elapsed === 7000 && !global.__realmFed) {
      reportBridgeState('pre-init');
      // Synthetic protocol drivers retired: the real f/av0 payload now emits
      // init/requestExtraParams/meow itself (round12 protocol), and the parent
      // controller replies via the postMessage dispatch paths.
    }
    fireLifecycle();
    while (env.xhrQueue.length) {
      const job = env.xhrQueue.shift();
      const res = await httpReq(job.method, job.url, job.headers, job.body).catch(e => ({ status: 0, text: String(e) }));
      const x = job.xhr;
      x._rs = 4; x._status = res.status; x._text = res.text;
      const fire = (name) => { try { (x._l && x._l[name]) && x._l[name]({ type: name }); x._orc && x._orc({}); } catch (e) { log('ERR', `xhr cb ${name}: ${e.message}`); } };
      fire('load'); fire('loadend'); fire('readystatechange');
    }
    // Script tags may get .src assigned AFTER insertion; scan the DOM tree
    // every cycle instead of relying on the append-time snapshot.
    const scanScripts = (node, out) => {
      for (const c of node.children || []) {
        if (c.tagName === 'SCRIPT' && c.src && c.__loaded !== true) { c.__loaded = true; out.push(c.src); }
        scanScripts(c, out);
      }
    };
    const found = [];
    scanScripts(env.document, found);
    for (const u2 of (global.__srcSetScripts || new Set())) found.push(u2);
    // Scan-level dedup (own set): marking URLs "seen by the scan" must NOT
    // poison loadedSrcs — the load loop skips anything already in loadedSrcs,
    // so sharing one set made scan-seen URLs never load.
    const pendingSrcs = global.__scanSeen = global.__scanSeen || new Set();
    for (let i2 = found.length - 1; i2 >= 0; i2--) {
      if (pendingSrcs.has(found[i2])) found.splice(i2, 1); else pendingSrcs.add(found[i2]);
    }
    if (env.pendingScripts.length) log('PUMP', `pending=${JSON.stringify(env.pendingScripts.map(s => String(s).slice(-40)))}`);
    const pumpRealmDoc = (doc, tag) => {
      if (doc && doc.__pending && doc.__pending.length) {
        for (const u of doc.__pending.splice(0)) found.push(u);
      }
    };
    pumpRealmDoc(env.document);
    // iframe realms: fetch + eval inside their own context
    for (const entry of iframeRealms) {
      if (entry.doc.__pending && entry.doc.__pending.length) {
        for (const u of entry.doc.__pending.splice(0)) {
          const abs = String(u).startsWith('http') ? u : new URL(u, BASE).href;
          log('IFRAME', `realm script ${abs.slice(0, 100)}`);
          try {
            const rr = await httpReq('GET', abs, { Referer: BASE + '/', Accept: '*/*' });
          try {
            const miss = [];
            const Wp = new Proxy(entry.doc.defaultView || {}, { has(t3,k3){ const has=k3 in t3; if(!has && typeof k3==='string' && /^[A-Z]/.test(k3)) miss.push(k3); return has; } });
          } catch (_) {}
            vm.runInContext(rr.text, entry.ctx, { filename: abs.slice(0, 60) });
            log('IFRAME', `realm script eval ok ${rr.text.length}B`);
          } catch (e) { log('ERR', `realm script ${String(abs).slice(0, 60)}: ${e.message}`); }
        }
      }
    }
    const loadedSrcs = global.__loadedSrcs = global.__loadedSrcs || new Set();
    if (env.pendingScripts.length || found.length) log('PUMP', `load-section pending=${env.pendingScripts.length} found=${found.length}`);
    for (const src of env.pendingScripts.splice(0).concat(found)) {
      const srcStr = typeof src === 'string' ? src : (src && src.src ? String(src.src) : '');
      if (!srcStr || !srcStr.startsWith('http')) { if (srcStr) log('PUMP', `skip non-url entry ${String(srcStr).slice(0, 50)}`); continue; }
      if (loadedSrcs.has(srcStr)) continue;
      loadedSrcs.add(srcStr);
      log('SCRIPT', `loading child script ${String(srcStr).slice(0, 90)}`);
      let respText = '';
      try {
        if (pinned && srcStr.includes('/orchestrate/chl_page/v1') && fs.existsSync(path.join(__dirname, 'pinned-orchestrate.js'))) {
          // Browser cache semantics (round11 network ledger: orchestrate is
          // fetched exactly once; the stage2 re-load tag hits the cache and
          // gets the SAME bytes). A live re-fetch returns foreign-session
          // bytes whose bridge names never match — infinite wait.
          respText = fs.readFileSync(path.join(__dirname, 'pinned-orchestrate.js'), 'utf8');
          log('SCRIPT', `serving chl_page re-load from PINNED bytes (cache semantic) ${respText.length}B`);
        } else if (pinned && /\/turnstile\/v0\//.test(srcStr) && /api\.js/.test(srcStr) && fs.existsSync(path.join(__dirname, 'pinned-api.js'))) {
          // Browser cache semantics for the whole api.js loader family: the
          // round11 ledger shows exactly ONE api.js GET — the controller's
          // _upgrade/_cb refetch never happened there. Serving the pinned
          // bytes keeps the session's controller/orchestrate/api versions
          // coherent (a live newer build drifts and breaks instanceof).
          respText = fs.readFileSync(path.join(__dirname, 'pinned-api.js'), 'utf8');
          global.__apiJsUrl = srcStr;
          if (process.env.HARNESS_API_TRACE === '1') {
            // Boot-flow tracer: find where api.js stalls before Fa() (the
            // self-locator) — onload=DraY9 never fires and Fa() never logs.
            respText = "console.error('[APISTART] boot begin');\n" +
              respText
                .replace('function Fa(){', 'function Fa(){console.error(\'[APIFA] Fa() entered\');')
                .replace('Pe=V.params.get("onload")', '(console.error(\'[APIPAR] params=\'+(V&&V.params?Array.from(V.params.entries()).map(function(e){return e.join(\'=\')}).join(\'&\'):\'-\')),Pe=V.params.get("onload"))')
                .replace('function xe(c,i,v,h){', 'function xe(c,i,v,h){console.error("[XE] enter c="+(c&&c.tagName)+" v="+v+" se-proto="+(c&&Object.getPrototypeOf(c)[Symbol.toStringTag]||"?"));')
                .replace('var ht=kn();', 'var ht=kn();console.error("[XE] kn="+String(ht).slice(0,60));')
                .replace('var rt=wu(se);', 'var rt=wu(se);console.error("[XE] wu="+(rt?JSON.stringify(Object.keys(rt)):"undef")+" se="+(se&&se.tagName));')
                .replace('function tM(HH,jj,cv){if(jj={a:39},cv=ct,typeof HH!==cv(jj.a))throw new TypeError;return HH}', 'function tM(HH,jj,cv){if(jj={a:39},cv=ct,typeof HH!==cv(jj.a)){console.error("[TM] typeof="+typeof HH+" val="+String(HH).slice(0,80)+" expect="+cv(jj.a)+" by "+String(new Error().stack).split(String.fromCharCode(10)).slice(2,4).join("|").slice(0,220));throw new TypeError}return HH}') +
              "\n;console.error('[APITAIL] boot end reached');";
          }
          log('SCRIPT', `serving api.js (incl. upgrade variant) from PINNED bytes ${respText.length}B`);
        } else {
          const r = await httpReq('GET', srcStr, { Referer: BASE + '/', Accept: '*/*' });
          respText = r.text;
        }
        // Pin ONLY the parent api.js — the mismatch-reload re-fetches live
        // orchestrate bytes through this same pump and must not clobber it.
        if (/\/turnstile\/v0\/(?:[^/]+\/)*api\.js/.test(srcStr)) {
          // Trace-injected text must not clobber the pinned original.
          try { if (process.env.HARNESS_API_TRACE !== '1') fs.writeFileSync(path.join(__dirname, 'pinned-api.js'), respText); } catch (_) {}
        }
        // api.js validates its own tag; give it a real in-tree element.
        const realTag = env.document.createElement('script');
        realTag.src = srcStr; realTag.async = true;
        env.document.head.appendChild(realTag);
        const realProxy = realTag.__proxy || realTag;
        const prevCs = env.document.currentScript;
        Object.defineProperty(env.document, 'currentScript', { configurable: true, get: () => realProxy });
        try {
          const probe = vm.runInContext(`JSON.stringify({
            cs: typeof document.currentScript,
            csSrc: String((document.currentScript||{}).src||'').slice(0,60),
            isElem: document.currentScript instanceof HTMLScriptElement,
            re: /^https:\\/\\/(?:challenges(?:\\.fed)?\\.cloudflare\\.com|challenges\\.cloudflare-cn\\.com)\\/turnstile\\/v0(?:\\/.*)?\\/api\\.js/u.test(String((document.currentScript||{}).src||'')),
            hseType: typeof HTMLScriptElement,
            hseIsFn: typeof HTMLScriptElement==='function' && HTMLScriptElement.prototype instanceof Object,
            csProto: Object.getPrototypeOf(document.currentScript) === HTMLScriptElement.prototype,
            csProtoName: String(Object.getPrototypeOf(document.currentScript) && Object.getPrototypeOf(document.currentScript)[Symbol.toStringTag]),
            sameAsFresh: Object.getPrototypeOf(document.currentScript) === Object.getPrototypeOf(document.createElement('script')),
            instHTMLElement: document.currentScript instanceof HTMLElement,
            hseName: HTMLScriptElement && HTMLScriptElement.name,
            elemInst: document.createElement('div') instanceof HTMLDivElement,
            qs: document.querySelectorAll('script').length,
            qsIter: typeof document.querySelectorAll('script')[Symbol.iterator]
          })`, ctx, { returnByValue: true });
          log('PUMP', 'Mt probe: ' + String(probe).slice(0, 300));
        } catch (e3) { log('PUMP', 'Mt probe err: ' + e3.message); }
        try { log('PUMP', `currentScript wired -> src=${String(env.document.currentScript && env.document.currentScript.src).slice(0, 80)}`); } catch (_) {}
        try {
          // (respText — the fetch result; an earlier edit referenced the
          // else-block-scoped `r` here, throwing a harness-side ReferenceError
          // that masqueraded as "waiting for global r" forever.)
          const wrapped = 'try {' + respText + '\n} catch (__e) { console.error("[INNER]", String(__e && __e.stack).slice(0,500)); throw new Error("APIJS@" + (__e && __e.stack ? __e.stack.split("\\n").slice(0,4).join(" ~ ") : String(__e))); }';
          vm.runInContext(wrapped, ctx, { filename: String(srcStr).slice(0, 60) });
          log('SCRIPT', `child script eval ok ${respText.length}B`);
          // Browser semantics on script load completion: the resource timing
          // entry appears (PerformanceObserver callbacks fire) and, for the
          // api.js load, the page lifecycle can finish (readyState complete).
          if (/\/turnstile\/v0\/(?:[^/]+\/)*api\.js/.test(srcStr)) {
            try {
              const raw2 = env.window.__mkResourceEntry(String(srcStr));
              // Browser semantics: the entry also lands in the performance
              // buffer (getEntries) — the task generator reads it there.
              env.perfEntries.push(raw2);
              env.window.__pendingPerf && env.window.__pendingPerf.push(raw2);
              env.window.__notifyResource && env.window.__notifyResource(raw2);
              log('DOM', 'api.js resource entry delivered to observers');
            } catch (e5) { log('ERR', 'api.js perf entry: ' + e5.message); }
            try { if (env.document.readyState !== 'complete') env.document.__advanceReadyState && env.document.__advanceReadyState('complete'); } catch (e5) { log('ERR', 'readyState advance: ' + e5.message); }
          }
          try {
            const probe = vm.runInContext(`JSON.stringify({inWindow:'turnstile' in window, type: typeof window.turnstile, keys: window.turnstile?Object.keys(window.turnstile).slice(0,8):null, isReady: typeof y!=='undefined'&&y&&y.isReady===true})`, ctx, { returnByValue: true });
            log('TSPROBE', String(probe).slice(0, 200));
          } catch (e5) { log('TSPROBE', 'err: ' + e5.message); }
          // Observe the controller surface the page will call into.
          try {
            const ts2 = env.window.turnstile;
            if (ts2 && typeof ts2 === 'object') {
              env.window.turnstile = new Proxy(ts2, {
                get(t3, k) {
                  if (typeof k === 'string' && k !== 'then') log('TURNSTILE', `get .${k} by ${String(new Error().stack).split(String.fromCharCode(10)).slice(2, 5).join(' | ').slice(0, 280)}`);
                  const v3 = t3[k];
                  if (typeof v3 === 'function') {
                    return (...args) => {
                      let __as2=''; try { __as2 = JSON.stringify(args, (k2, v4) => typeof v4 === 'function' ? 'fn' : v4).slice(0, 260); } catch (_) { __as2 = String(args[0] && args[0].tagName ? '<' + args[0].tagName + '>' : String(args[0]).slice(0, 40)); } log('TURNSTILE', `.${String(k)}(${__as2}) by ${String(new Error().stack).split(String.fromCharCode(10)).slice(2, 6).join(' | ').slice(0, 400)}`);
                      try { return v3.apply(t3, args); } catch (e4) { log('ERR', `turnstile.${String(k)}: ${e4.message}`); }
                    };
                  }
                  return v3;
                },
              });
              log('TURNSTILE', 'logging proxy installed on window.turnstile');
            } else log('TURNSTILE', `post-eval turnstile = ${typeof ts2}`);
          } catch (e4) { log('ERR', 'ts proxy: ' + e4.message); }
          // onload callback tracer: the controller calls window[onloadName]
          // (DraY9) when ready — the trigger for the orchestrate's
          // turnstile.render(). Wrap every onload-style global the tag src
          // advertises so the call is visible.
          try {
            const onm = String(srcStr).match(/onload=([A-Za-z0-9_]+)/);
            if (onm && typeof env.window[onm[1]] === 'function') {
              const orig = env.window[onm[1]];
              env.window[onm[1]] = function (...a2) { log('CALLBACK', `${onm[1]} fired (controller ready) args=${JSON.stringify(a2).slice(0, 80)}`); try { const r2 = orig.apply(this, a2); log('CALLBACK', `${onm[1]} returned ${String(r2).slice(0,60)}`); return r2; } catch (e5) { log('ERR', `${onm[1]} body: ${e5.message} | ${String(e5.stack).split(String.fromCharCode(10)).slice(1,3).join(' | ')}`); } };
              try { log('CB SRC', String(orig).slice(0, 400)); } catch (_) {}
              log('CALLBACK', `tracer installed on window.${onm[1]}`);
            }
          } catch (_) {}
        } finally {
          Object.defineProperty(env.document, 'currentScript', { configurable: true, get: () => prevCs });
        }
      } catch (e) {
        // trace-first fix: scan the script for `instanceof X` targets and
        // define any that are missing, then re-run once.
        const missing = new Set();
        for (const mm of (respText || '').matchAll(/instanceof\s+([A-Z][A-Za-z0-9_$]*)/g)) {
          const nm = mm[1];
          try { if (vm.runInContext(`typeof ${nm}==='undefined'`, ctx)) missing.add(nm); } catch (_) {}
        }
        if (missing.size) {
          for (const nm of missing) {
            const C3 = function () {};
            C3.prototype = Object.create(Object.prototype);
            try { Object.defineProperty(C3.prototype, Symbol.toStringTag, { value: nm, configurable: true }); } catch (_) {}
            vm.runInContext(`this.${nm} = undefined`, ctx); // clear then set below
            env.window[nm] = C3;
            log('DOM', `auto-defined missing constructor ${nm}`);
          }
          try {
            vm.runInContext(respText, ctx, { filename: srcStr.slice(0, 60) });
            log('SCRIPT', `child script eval ok after defining ${[...missing].join(',')}`);
          } catch (e3) { log('ERR', `child script retry: ${e3.message}`); }
        } else {
          // The orchestrate VM defines page globals progressively (one phase
          // per ~1s timer hop). A defer'd script that evals before its
          // dependency globals exist throws ReferenceError — requeue with
          // backoff (browser semantics: network latency gives the VM time).
          const m2 = String(e.message).match(/^([A-Za-z_$][\w$]*) is not defined$/);
          const tries = (global.__childRetries = global.__childRetries || new Map());
          const n2 = (tries.get(srcStr) || 0) + 1;
          if (m2 && n2 <= 300) {
            tries.set(srcStr, n2);
            loadedSrcs.delete(srcStr);
            pendingSrcs.delete(srcStr);
            env.pendingScripts.push(srcStr);
            if (n2 <= 3 || n2 % 25 === 0) log('SCRIPT', `child script deferred (waiting for global ${m2[1]}, retry #${n2})`);
          if (n2 === 1) { try { console.error('[RSTACK-FULL]', e.stack); } catch (_) {} }
          } else {
            log('ERR', `child script ${String(srcStr).slice(0, 60)}: ${e.message} (no instanceof targets missing) stack: ${String(e.stack).split('\n').slice(1, 4).join(' | ').slice(0, 300)}`);
          }
        }
      }
    }
  }
  const dumpText = [];
  const walkDump = (n) => {
    for (const c of n.children || []) {
      const txt = c.textContent || c.text || c.innerText;
      if (txt && String(txt).trim()) dumpText.push(`<${c.tagName}> ${String(txt).slice(0, 90)}`);
      if (c.attrs && Object.keys(c.attrs).length) dumpText.push(`<${c.tagName} attrs> ${JSON.stringify(c.attrs).slice(0, 90)}`);
      walkDump(c);
    }
  };
  walkDump(env.document);
  log('UIDUMP', JSON.stringify(dumpText.slice(0, 30)));
  fs.writeFileSync(path.join(__dirname, 'harness-log.json'), JSON.stringify({ log: LOG, cookies: [...jar.values()] }, null, 1));
  try {
    for (const [nm, el] of (global.__idElems || new Map())) {
      const chain = []; let n = el, d = 0;
      while (n && d < 12) { chain.push('<' + String(n.tagName) + (n.__id !== undefined ? '#' + n.__id : '') + '>'); n = n.parentNode; d++; }
      log('IDCHAIN', `${nm}: ${chain.join(' <- ')}`);
    }
  } catch (_) {}
  if (global.__optArrCalls) for (const [k2, n] of [...global.__optArrCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) log('OPTARRSUM', `${k2}:${n}`);
  try { const o9 = env.window._cf_chl_opt || {}; log('FINAL', JSON.stringify((o9.jLEVv0 || []).map(t => ({ n: String(t.OROhR9 || '').slice(-30), a: t.JeJZR2, b: t.xYfm0, c: t.ePsF3, d: t.TypqR7, e: t.zujq9 })))); } catch (_) {}
  try {
    const wkeys = Object.keys(env.window).filter(k => /^[a-zA-Z][a-zA-Z0-9]{4,7}$/.test(k) && !['crypto','screen','origin','status','frames','parent','length','closed','external','menubar','toolbar','history','window','document','location'].includes(k));
    const detail = {};
    for (const k of wkeys) { const v = env.window[k]; const t = typeof v; let d = ''; try { if (v && t === 'object') d = Array.isArray(v) ? ('arr' + v.length + ':' + JSON.stringify(v).slice(0, 60)) : 'obj:' + Object.keys(v).slice(0, 8).join('/'); else if (t !== 'function') d = String(v).slice(0, 30); else continue; } catch (_) {} detail[k] = d; }
    log('WINGLOBALS', JSON.stringify(detail));
  } catch (_) {}
  if (global.__optFields) for (const [k2, n] of [...global.__optFields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) log('OPTFIELDS', `${k2}:${n}`);
  if (global.__missFp) for (const [fp, n] of [...global.__missFp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) log('MISSFP', `${n}x ${fp}`);
  log('DONE', `cookies: ${[...jar.keys()].join(', ') || '(none)'}`);
  if (jar.has('cf_clearance')) { log('WIN', 'cf_clearance in jar'); process.exit(0); }
  process.exit(3);
}
main().catch(e => { console.error('FATAL', e); console.error('STACK ' + String(e.stack).split('\n').slice(0, 6).join(' | ')); process.exit(1); });
