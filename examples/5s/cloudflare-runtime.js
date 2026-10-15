#!/usr/bin/env node
'use strict';

/*
 * Cloudflare 5s trace runtime harness.
 *
 * Goal: run the captured browser scripts inside a supplemented Node browser
 * environment, keep time/random/session inputs live, and intercept generated
 * XHR/fetch requests for comparison with the Firefox trace vector.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const dgram = require('dgram');
const { webcrypto } = crypto;

function compactError(error) {
  return String(error && (error.stack || error.message) || error)
    .split('\n')
    .filter((line, index) => index === 0 || /^\s*at\s/.test(line))
    .slice(0, 16)
    .join('\n');
}

process.on('uncaughtException', error => {
  console.error(`[uncaughtException] ${compactError(error)}`);
  if (/challenges\.cloudflare\.com\/turnstile\/.*api\.js/.test(String(error && (error.stack || error.message) || error))) return;
  process.exitCode = 1;
});
process.on('unhandledRejection', error => {
  console.error(`[unhandledRejection] ${compactError(error)}`);
  if (/challenges\.cloudflare\.com\/turnstile\/.*api\.js/.test(String(error && (error.stack || error.message) || error))) return;
  process.exitCode = 1;
});

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_VECTOR = path.join(__dirname, 'runtime-data/final-evidence-vector.json');
const DEFAULT_OUT = path.join(__dirname, 'runtime-data/runner-output.json');
const DEFAULT_ENVIRONMENT_PROFILE = path.join(__dirname, 'browser-environment-profile.json');
const BROWSER_CONSOLE_PROBE = path.join(__dirname, 'runtime-data/browser-console-target-probe-20260817.json');
const BROWSER_LIVE_RTC_PROBE = path.join(__dirname, 'runtime-data/browser-console-live-rtc-20260817.json');

function sha256Bytes(v) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8');
  return crypto.createHash('sha256').update(b).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function maybeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function maybeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function stunBinding(server, timeoutMs = 900) {
  return new Promise((resolve) => {
    const match = /^stun:([^:]+)(?::(\d+))?$/.exec(String(server));
    if (!match) return resolve(null);
    const host = match[1];
    const port = Number(match[2] || 3478);
    const transaction = crypto.randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112a442, 4);
    transaction.copy(request, 8);
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('error', () => finish(null));
    socket.on('message', (message) => {
      if (message.length < 20 || !message.subarray(8, 20).equals(transaction)) return;
      for (let offset = 20; offset + 4 <= message.length;) {
        const type = message.readUInt16BE(offset);
        const length = message.readUInt16BE(offset + 2);
        const value = offset + 4;
        if (type === 0x0020 && length >= 8 && message[value + 1] === 0x01) {
          const mappedPort = message.readUInt16BE(value + 2) ^ 0x2112;
          const address = [0, 1, 2, 3].map(index => message[value + 4 + index] ^ request[4 + index]).join('.');
          return finish({ address, port: mappedPort });
        }
        offset = value + ((length + 3) & ~3);
      }
    });
    socket.send(request, port, host, error => { if (error) finish(null); });
  });
}

async function discoverSrflx(servers) {
  for (const server of servers) {
    const result = await stunBinding(server);
    if (result) return result;
  }
  return null;
}

function rel(p) {
  if (!p) return p;
  const abs = path.resolve(p);
  return abs.startsWith(ROOT + path.sep) ? path.relative(ROOT, abs) : abs;
}

function parseArgs(argv) {
  const out = { vector: DEFAULT_VECTOR, bootstrap: '', output: DEFAULT_OUT, environmentProfile: DEFAULT_ENVIRONMENT_PROFILE, scenario: 'all', timeoutMs: 3000, settleMs: 8000, xhrBridge: '', navigationElapsedMs: 0, publicIp: '', noEvents: false, noInteractions: false, debugPatch: false, debugVm: false, captureOnly: false, diagnosticEncoder: false, bridgeResponseDelayMs: 0, xhrProgressMode: 'staged', forceFrameBranch: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vector') out.vector = argv[++i];
    else if (a === '--bootstrap') out.bootstrap = argv[++i];
    else if (a === '--environment-profile') out.environmentProfile = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--settle-ms') out.settleMs = Number(argv[++i]);
    else if (a === '--live-network') out.liveNetwork = true;
    else if (a === '--xhr-bridge') out.xhrBridge = argv[++i];
    else if (a === '--navigation-elapsed-ms') out.navigationElapsedMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--public-ip') out.publicIp = String(argv[++i] || '');
    else if (a === '--no-events') out.noEvents = true;
    else if (a === '--no-interactions') out.noInteractions = true;
    else if (a === '--debug-patch') out.debugPatch = true;
    else if (a === '--debug-vm') out.debugVm = true;
    else if (a === '--capture-only') out.captureOnly = true;
    else if (a === '--diagnostic-encoder') out.diagnosticEncoder = true;
    else if (a === '--bridge-response-delay-ms') out.bridgeResponseDelayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--xhr-progress-mode') {
      out.xhrProgressMode = String(argv[++i] || 'staged');
      if (!['staged', 'complete-only'].includes(out.xhrProgressMode)) throw new Error('--xhr-progress-mode must be staged or complete-only');
    }
    else if (a === '--force-frame-branch') {
      const raw = argv[++i];
      try {
        const spec = JSON.parse(raw);
        if (!spec || typeof spec !== 'object' || typeof spec.sha256 !== 'string' || typeof spec.anchor !== 'string' || typeof spec.replacement !== 'string') throw new Error('expected {sha256,anchor,replacement}');
        out.forceFrameBranch = { sha256: spec.sha256.toLowerCase(), anchor: spec.anchor, replacement: spec.replacement };
      } catch (error) { throw new Error(`--force-frame-branch JSON: ${error.message}`); }
    }
    else if (a === '--help') {
      console.log(`Usage: node examples/5s/cloudflare-runtime.js [--vector FILE] [--bootstrap FILE] [--output FILE] [--scenario all|orchestrate|turnstile|rocket|jsd] [--timeout-ms N] [--settle-ms N] [--live-network]`);
      process.exit(0);
    }
  }
  return out;
}

const eventTargetState = new WeakMap();

function installFirefoxErrorStack(context) {
  vm.runInContext(`(()=>{
    // Firefox exposes the complete page-script chain for this probe (roughly
    // thirty frames in current headed runs). Keep enough V8 frames to retain
    // that chain, while the filter below still removes runtime internals.
    Error.stackTraceLimit = 64;
    const internalFrame = file => !file
      || file === 'evalmachine.<anonymous>'
      || file.startsWith('node:')
      || file.includes('/cloudflare-runtime.js');
    Object.defineProperty(Error, 'prepareStackTrace', {
      configurable: true,
      value(error, callSites) {
        const lines = callSites
          .filter(site => !internalFrame(String(site.getFileName() || '')))
          .map(site => {
            const file = String(site.getFileName() || '');
            const line = site.getLineNumber();
            const column = site.getColumnNumber();
            const name = site.getFunctionName() || site.getMethodName() || '';
            return name + '@' + file + (line == null ? '' : ':' + line) + (column == null ? '' : ':' + column);
          });
        return lines.length ? lines.join('\\n') + '\\n' : '';
      },
    });
  })()`, context, { filename: 'firefox-error-stack.js' });
}

class EventTargetShim {
  constructor() { eventTargetState.set(this, new Map()); }
  static listenerCount(target, type) { return eventTargetState.get(target)?.get(type)?.length || 0; }
  addEventListener(type, fn) {
    if (EventTargetShim.eventLog) EventTargetShim.eventLog.push({ target: this.constructor?.name || 'EventTarget', op: 'add', type: String(type) });
    // Interactive widget corruption probe: a stringy "handler" here means a callback
    // registry got polluted upstream (the widget later calls registry entries).
    if (fn && typeof fn !== 'function' && typeof type === 'string' && /mouse|pointer|click|key/i.test(type)) {
      try { (this.ownerDocument?.__cfElementSink || globalThis.__cfElementSink || function() {})({ op: 'element.stringy-listener', type: String(type), handlerType: typeof fn, handlerPreview: String(fn).slice(0, 80), stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700) }); } catch {}
    }
    if (!fn) return;
    const listeners = eventTargetState.get(this);
    const arr = listeners.get(type) || [];
    arr.push(fn);
    listeners.set(type, arr);
  }
  removeEventListener(type, fn) {
    const listeners = eventTargetState.get(this);
    const arr = listeners.get(type) || [];
    listeners.set(type, arr.filter(x => x !== fn));
  }
  dispatchEvent(evt) {
    if (!evt || !evt.type) throw new TypeError('event.type required');
    if (EventTargetShim.eventLog) EventTargetShim.eventLog.push({ target: this.constructor?.name || 'EventTarget', op: 'dispatch', type: String(evt && evt.type) });
    evt.target = evt.target || this;
    evt.currentTarget = this;
    if (evt.bubbles === undefined) evt.bubbles = false;
    if (evt.cancelable === undefined) evt.cancelable = false;
    if (evt.composed === undefined) evt.composed = false;
    if (evt.defaultPrevented === undefined) evt.defaultPrevented = false;
    if (evt.isTrusted === undefined) evt.isTrusted = false;
    if (evt.timeStamp === undefined) evt.timeStamp = (globalThis.performance?.now?.() || 0);
    const prop = this['on' + evt.type];
    if (typeof prop === 'function') {
      const runtime = this.__runtime || this.ownerDocument?.__runtime
        || (typeof documentState !== 'undefined' && documentState.has(this) ? documentState.get(this)?.runtime : null);
      try { prop.call(this, evt); }
      catch (error) {
        if (runtime) runtime.recordError(`event.${evt.type}.handler`, error);
      }
    }
    // DOM dispatch works from a candidate snapshot.  Listener additions made
    // by a handler take effect on the next event, not midway through this one.
    for (const fn of (eventTargetState.get(this).get(evt.type) || []).slice()) {
      try {
        if (typeof fn === 'function') fn.call(this, evt);
        else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
      } catch (error) {
        const runtime = this.__runtime || this.ownerDocument?.__runtime
          || (typeof documentState !== 'undefined' && documentState.has(this) ? documentState.get(this)?.runtime : null);
        if (runtime) runtime.recordError(`event.${evt.type}.listener`, error);
      }
    }
    return !evt.defaultPrevented;
  }
}

// The page-visible constructor is EventTarget in Firefox.  Keeping the
// implementation name out of the realm is part of the object contract.
Object.defineProperty(EventTargetShim, 'name', { value: 'EventTarget', configurable: true });

class WindowShim extends EventTargetShim {
  get [Symbol.toStringTag]() { return 'Window'; }
}
Object.defineProperty(WindowShim, 'name', { value: 'Window', configurable: true });
const windowPropertiesPrototype = Object.create(EventTargetShim.prototype);
Object.setPrototypeOf(WindowShim.prototype, windowPropertiesPrototype);

const domTokenListState = new WeakMap();

class DOMTokenListShim {
  constructor(owner) { domTokenListState.set(this, { owner, values: new Set() }); }
  add(...xs) { const state = domTokenListState.get(this); xs.forEach(x => state.values.add(String(x))); this._sync(); }
  remove(...xs) { const state = domTokenListState.get(this); xs.forEach(x => state.values.delete(String(x))); this._sync(); }
  contains(x) { return domTokenListState.get(this).values.has(String(x)); }
  toggle(x, force) {
    const state = domTokenListState.get(this);
    x = String(x);
    const on = force === undefined ? !state.values.has(x) : !!force;
    on ? state.values.add(x) : state.values.delete(x);
    this._sync();
    return on;
  }
  replace(a, b) {
    const state = domTokenListState.get(this);
    if (!state.values.has(String(a))) return false;
    state.values.delete(String(a)); state.values.add(String(b)); this._sync(); return true;
  }
  get value() { return Array.from(domTokenListState.get(this).values).join(' '); }
  toString() { return this.value; }
  _sync() { const owner = domTokenListState.get(this).owner; if (owner) owner.className = this.value; }
  _load(value) {
    const state = domTokenListState.get(this);
    state.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
    if (state.owner) state.owner.className = this.value;
  }
}

const cssStyleState = new WeakMap();

class CSSStyleDeclarationShim {
  constructor(initial = {}) {
    cssStyleState.set(this, new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)])));
  }
  get cssText() {
    return Array.from(cssStyleState.get(this) || [], ([name, value]) => `${name}: ${value};`).join(' ');
  }
  set cssText(value) {
    const state = cssStyleState.get(this);
    state.clear();
    for (const item of String(value || '').split(';')) {
      const index = item.indexOf(':');
      if (index < 0) continue;
      const name = item.slice(0, index).trim();
      const propertyValue = item.slice(index + 1).trim();
      if (name) state.set(name, propertyValue);
    }
  }
  get length() { return (cssStyleState.get(this) || new Map()).size; }
  item(index) { return Array.from(cssStyleState.get(this)?.keys() || [])[Number(index)] || ''; }
  getPropertyValue(name) {
    const key = String(name);
    const camel = key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return cssStyleState.get(this)?.get(key) ?? cssStyleState.get(this)?.get(camel) ?? '';
  }
  getPropertyPriority() { return ''; }
  setProperty(name, value) { cssStyleState.get(this)?.set(String(name), String(value)); }
  removeProperty(name) {
    const key = String(name);
    const previous = this.getPropertyValue(key);
    cssStyleState.get(this)?.delete(key);
    return previous;
  }
  get [Symbol.toStringTag]() { return 'CSSStyleDeclaration'; }
}

class CSS2PropertiesShim extends CSSStyleDeclarationShim {
  get [Symbol.toStringTag]() { return 'CSS2Properties'; }
}

function createCSS2Properties(initial = {}) {
  const target = new CSS2PropertiesShim(initial);
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property in object) {
        const value = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      }
      return object.getPropertyValue(property);
    },
    set(object, property, value, receiver) {
      if (typeof property === 'symbol' || property in object) return Reflect.set(object, property, value, object);
      cssStyleState.get(object).set(String(property), String(value));
      return true;
    },
  });
}

function createComputedStyle(element) {
  const tag = String(element?.localName || '').toLowerCase();
  const rect = element?.getBoundingClientRect?.() || new DOMRectShim();
  const defaults = {
    display: tag === 'iframe' ? 'inline' : tag === 'html' || tag === 'body' || tag === 'div' ? 'block' : 'inline',
    visibility: 'visible',
    opacity: '1',
    position: 'static',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    MozAnimation: '',
  };
  Object.assign(defaults, resolveStyleForNode(element));
  const computed = createCSS2Properties(defaults);
  const source = element?.style;
  if (source) {
    for (const name of ['display', 'visibility', 'opacity', 'position', 'width', 'height', 'overflow', 'pointerEvents', 'MozAnimation']) {
      const value = source[name] || source.getPropertyValue?.(name);
      if (value !== undefined && value !== '') computed[name] = value;
    }
  }
  return computed;
}

const domRectState = new WeakMap();

class DOMRectReadOnlyShim {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    domRectState.set(this, { x: Number(x), y: Number(y), width: Number(width), height: Number(height) });
  }
  get x() { return domRectState.get(this).x; }
  get y() { return domRectState.get(this).y; }
  get width() { return domRectState.get(this).width; }
  get height() { return domRectState.get(this).height; }
  get top() { return Math.min(this.y, this.y + this.height); }
  get right() { return Math.max(this.x, this.x + this.width); }
  get bottom() { return Math.max(this.y, this.y + this.height); }
  get left() { return Math.min(this.x, this.x + this.width); }
  toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; }
  get [Symbol.toStringTag]() { return 'DOMRectReadOnly'; }
}

class DOMRectShim extends DOMRectReadOnlyShim {
  set x(value) { domRectState.get(this).x = Number(value); }
  set y(value) { domRectState.get(this).y = Number(value); }
  set width(value) { domRectState.get(this).width = Number(value); }
  set height(value) { domRectState.get(this).height = Number(value); }
  get x() { return super.x; }
  get y() { return super.y; }
  get width() { return super.width; }
  get height() { return super.height; }
  get [Symbol.toStringTag]() { return 'DOMRect'; }
}

class LocationShim extends URL {
  assign(value) { this.href = new URL(String(value), this.href).href; }
  replace(value) { this.href = new URL(String(value), this.href).href; }
  reload() {}
  toString() { return this.href; }
  get [Symbol.toStringTag]() { return 'Location'; }
}
Object.defineProperty(LocationShim, 'name', { value: 'Location', configurable: true });
for (const name of Reflect.ownKeys(LocationShim.prototype)) {
  if (name === 'constructor') continue;
  const descriptor = Object.getOwnPropertyDescriptor(LocationShim.prototype, name);
  Object.defineProperty(LocationShim.prototype, name, { ...descriptor, enumerable: true });
}

const shadowRootState = new WeakMap();
const iframeState = new WeakMap();
const canvasContextState = new WeakMap();
const nodeState = new WeakMap();

function getNodeState(node) {
  const state = nodeState.get(node);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function setNodeField(node, name, value) {
  getNodeState(node)[name] = value;
  return value;
}

class NodeShim extends EventTargetShim {
  constructor(nodeType = 0, nodeName = '') {
    super();
    nodeState.set(this, {
      nodeType: Number(nodeType), nodeName: String(nodeName), parentNode: null,
      childNodes: [], ownerDocument: null, textContent: '',
    });
  }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (!n) return n;
    if (n.parentNode && n.parentNode !== this && typeof n.parentNode.removeChild === 'function') n.parentNode.removeChild(n);
    setNodeField(n, 'parentNode', this);
    if (!n.ownerDocument && this.ownerDocument) setNodeField(n, 'ownerDocument', this.ownerDocument);
    if (ref && this.childNodes.includes(ref)) this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    else this.childNodes.push(n);
    if (this.ownerDocument) documentNodeInserted(this.ownerDocument, n, this);
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (n) setNodeField(n, 'parentNode', null);
    return n;
  }
  replaceChild(n, old) {
    const i = this.childNodes.indexOf(old);
    if (i >= 0) this.childNodes[i] = n; else this.childNodes.push(n);
    setNodeField(n, 'parentNode', this);
    setNodeField(old, 'parentNode', null);
    return old;
  }
  setAttribute(k, v) {
    // Diagnose the interactive VM's "[object HTMLInputElement]" callback corruption: a
    // non-primitive attribute value would be stringified here and, via this[k] = v, leak
    // that string into a property slot the widget later calls.
    if (v !== null && typeof v === 'object') {
      try { (this.ownerDocument?.__cfElementSink || globalThis.__cfElementSink || function() {})({ op: 'element.attr-object-value', attr: String(k), valueType: Object.prototype.toString.call(v), stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700) }); } catch {}
    }
    v = String(v);
    const old = this.attributes.find(a => a.name === k);
    if (old) old.value = v; else this.attributes.push({ name: k, value: v, namespaceURI: null });
    if (k === 'style') this.style.cssText = v;
    else this[k === 'class' ? 'className' : k] = v;
    if (k === 'class') this.classList._load(v);
  }
  getAttribute(k) {
    const a = this.attributes.find(x => x.name === k);
    return a ? a.value : null;
  }
  hasAttribute(k) { return this.attributes.some(x => x.name === k); }
  removeAttribute(k) { this.attributes = this.attributes.filter(x => x.name !== k); delete this[k]; }
  cloneNode() {
    const n = this.nodeType === 1 ? new this.constructor(this.localName || '') : new TextShim(this.textContent || '');
    for (const a of this.attributes) n.setAttribute(a.name, a.value);
    n.text = this.text; n.textContent = this.textContent; n.innerHTML = this.innerHTML;
    return n;
  }
  get innerHTML() {
    // Live serialization: appendChild-built children must be visible to the challenge's
    // DOM-integrity probes (documentElement.outerHTML etc).
    if ((this.childNodes || []).length) return serializeNodeToHtml(this);
    return getNodeState(this).innerHTML || '';
  }
  get outerHTML() { return serializeNodeToHtml(this); }
  set innerHTML(value) {
    getNodeState(this).innerHTML = String(value ?? '');
    parseHTMLFragment(this, getNodeState(this).innerHTML);
    const document = this.ownerDocument;
    const documentInternal = document && documentState.get(document);
    const runtime = documentInternal?.runtime;
    if (runtime && documentInternal.isFrameDocument) {
      runtime.context.__workerLog.push({
        op: 'frame.node.innerHTML.set', tag: this.localName || this.nodeName,
        id: this.id || '', size: getNodeState(this).innerHTML.length, preview: getNodeState(this).innerHTML.slice(0, 1200),
      });
    }
  }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = String(value ?? ''); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.childNodes.find(x => x.nodeType === 1) || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n) {
      if (n.nodeType === 9) return true;
      if (n.localName === 'html' && !n.parentNode && n.ownerDocument) return true;
      n = n.parentNode;
    }
    return false;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  compareDocumentPosition(other) {
    if (!other || (typeof other !== 'object' && typeof other !== 'function')) {
      throw new TypeError('Node.compareDocumentPosition: Argument 1 does not implement interface Node.');
    }
    if (other === this) return 0;
    if (this.contains(other)) return NodeShim.DOCUMENT_POSITION_FOLLOWING | NodeShim.DOCUMENT_POSITION_CONTAINED_BY;
    if (typeof other.contains === 'function' && other.contains(this)) {
      return NodeShim.DOCUMENT_POSITION_PRECEDING | NodeShim.DOCUMENT_POSITION_CONTAINS;
    }
    const rootOf = node => {
      let root = node;
      while (root && root.parentNode) root = root.parentNode;
      return root;
    };
    const root = rootOf(this);
    if (!root || root !== rootOf(other)) {
      return NodeShim.DOCUMENT_POSITION_DISCONNECTED |
        NodeShim.DOCUMENT_POSITION_FOLLOWING |
        NodeShim.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
    }
    const order = [];
    const visit = node => {
      order.push(node);
      for (const child of node.childNodes || []) visit(child);
    };
    visit(root);
    return order.indexOf(this) < order.indexOf(other)
      ? NodeShim.DOCUMENT_POSITION_FOLLOWING
      : NodeShim.DOCUMENT_POSITION_PRECEDING;
  }
  matches(sel) { return selectorMatches(this, sel); }
  closest(sel) {
    for (let n = this; n; n = n.parentElement) if (n.matches && n.matches(sel)) return n;
    return null;
  }
  get previousElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const i = p.childNodes.indexOf(this);
    for (let j = i - 1; j >= 0; j--) if (p.childNodes[j].nodeType === 1) return p.childNodes[j];
    return null;
  }
  getBoundingClientRect() {
    const parseDimension = value => {
      if (value === undefined || value === null || value === '') return null;
      const parsed = Number.parseFloat(String(value));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const tag = String(this.localName || '').toLowerCase();
    const resolved = resolveStyleForNode(this);
    const explicitWidth = parseDimension(resolved.width || this.style.width || this.width || this.getAttribute?.('width'));
    const explicitHeight = parseDimension(resolved.height || this.style.height || this.height || this.getAttribute?.('height'));
    const fontSize = parseDimension(resolved.fontSize || resolved['font-size']) || 16;
    const ownText = String(this.textContent || collectNodeText(this) || '');
    let width = explicitWidth ?? (tag === 'iframe' ? 300 : tag === 'html' || tag === 'body' ? 1280 : tag === 'div' ? Math.max(16, ownText.length * fontSize * 0.61) : Math.max(16, ownText.length * fontSize * 0.61));
    let height = explicitHeight ?? (tag === 'iframe' ? 65 : tag === 'html' || tag === 'body' ? 891 : Math.max(fontSize * 1.2, 16));
    let left = tag === 'html' || tag === 'body' ? 0 : parseDimension(resolved.left) ?? parseDimension(resolved.marginLeft || resolved['margin-left']) ?? 0;
    let top = tag === 'html' || tag === 'body' ? 0 : parseDimension(resolved.top) ?? parseDimension(resolved.marginTop || resolved['margin-top']) ?? 0;
    const border = parseDimension(resolved.borderWidth || resolved['border-width'] || resolved.border) || 0;
    const padding = parseDimension(resolved.padding) || 0;
    width += 2 * (border + padding);
    height += 2 * (border + padding);
    const transform = String(resolved.transform || resolved.MozTransform || resolved.WebkitTransform || '');
    const matrix = transform.match(/matrix\(\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*\)/i);
    if (matrix) {
      const [, a, b, c, d, tx, ty] = matrix.map(Number);
      const nextWidth = Math.abs(a * width) + Math.abs(c * height);
      const nextHeight = Math.abs(b * width) + Math.abs(d * height);
      width = nextWidth; height = nextHeight; left += tx; top += ty;
    }
    const scale = transform.match(/scale\(\s*([-+\d.e]+)(?:\s*,\s*([-+\d.e]+))?/i);
    if (scale) {
      const sx = Math.max(-1e6, Math.min(1e6, Number(scale[1]) || 1));
      const sy = Math.max(-1e6, Math.min(1e6, Number(scale[2] ?? scale[1]) || 1));
      width = Math.abs(width * sx); height = Math.abs(height * sy);
    }
    return new DOMRectShim(left, top, width, height);
  }
  querySelector(sel) { return querySelectorFrom(this, sel, false)[0] || null; }
  querySelectorAll(sel) { return makeNodeList(querySelectorFrom(this, sel, false)); }
  getElementsByTagName(tag) { return makeNodeList(findDescendants(this, n => tag === '*' || (n.localName || '').toLowerCase() === String(tag).toLowerCase())); }
  attachShadow(init = {}) {
    const root = new ShadowRootShim(this.ownerDocument || null, this, String(init.mode || 'open'));
    shadowRootState.set(this, { root, open: root.mode === 'open' ? root : null });
    return root;
  }
  get shadowRoot() { return shadowRootState.get(this)?.open || null; }
}

function defineStateAccessor(prototype, name, options = {}) {
  const getter = function() { return getNodeState(this)[name]; };
  Object.defineProperty(getter, 'name', { value: `get ${name}`, configurable: true });
  const descriptor = { configurable: true, enumerable: true, get: getter };
  if (!options.readonly) {
    const setter = function(value) { getNodeState(this)[name] = value; };
    Object.defineProperty(setter, 'name', { value: `set ${name}`, configurable: true });
    descriptor.set = setter;
  }
  Object.defineProperty(prototype, name, descriptor);
}

for (const name of ['nodeType', 'nodeName', 'parentNode', 'childNodes', 'ownerDocument']) {
  defineStateAccessor(NodeShim.prototype, name, { readonly: true });
}
defineStateAccessor(NodeShim.prototype, 'textContent');
for (const name of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'cloneNode', 'contains', 'compareDocumentPosition', 'firstChild', 'parentElement', 'isConnected']) {
  const descriptor = Object.getOwnPropertyDescriptor(NodeShim.prototype, name);
  if (descriptor) Object.defineProperty(NodeShim.prototype, name, { ...descriptor, enumerable: true });
}
Object.defineProperty(NodeShim, 'name', { value: 'Node', configurable: true });

// Live DOM serialization: the interactive probe reads documentElement.outerHTML to
// verify the rendered widget markup. appendChild-built children must appear here, so
// serialize the live childNodes instead of returning the stored innerHTML string.
function serializeNodeToHtml(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (node.nodeType === 8) return `<!--${node.textContent || ''}-->`;
  if (node.nodeType !== 1) return '';
  const tag = String(node.localName || node.nodeName || 'div').toLowerCase();
  let attrs = '';
  for (const a of node.attributes || []) {
    attrs += a.name === 'class'
      ? ` class="${String(node.className || a.value || '')}"`
      : ` ${a.name}="${String(a.value ?? '').replace(/"/g, '&quot;')}"`;
  }
  const inner = (node.childNodes || []).map(serializeNodeToHtml).join('');
  const voidTags = /^(br|img|input|hr|meta|link|area|base|col|embed|source|track|wbr)$/i;
  return voidTags.test(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;
}

// The challenge frame writes generated markup through innerHTML and then
// queries the resulting nodes. Keep this parser deliberately small: it
// restores the DOM contracts used by the captured frame without attempting
// to emulate a general browser HTML parser.
function parseHTMLFragment(parent, source) {
  if (!parent || !source || !parent.childNodes) return;
  parent.childNodes.splice(0);
  const stack = [parent];
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]*>/g;
  let cursor = 0;
  const appendText = text => {
    if (!text) return;
    const node = new TextShim(text);
    setNodeField(node, 'ownerDocument', parent.ownerDocument);
    stack[stack.length - 1].appendChild(node);
  };
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let match;
  while ((match = tokenPattern.exec(source))) {
    appendText(source.slice(cursor, match.index));
    const token = match[0];
    cursor = match.index + token.length;
    if (token.startsWith('<!--')) continue;
    if (/^<\//.test(token)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = token.match(/^<\s*([A-Za-z][\w:-]*)([\s\S]*?)\/?\s*>$/);
    if (!open) continue;
    const tag = open[1].toLowerCase();
    const element = parent.ownerDocument?.createElement?.(tag) || new HTMLElementShim(tag);
    const attrs = open[2] || '';
    const attrPattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attr;
    while ((attr = attrPattern.exec(attrs))) {
      element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    stack[stack.length - 1].appendChild(element);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(element);
  }
  appendText(source.slice(cursor));
}

for (const [name, value] of Object.entries({
  DOCUMENT_POSITION_DISCONNECTED: 1,
  DOCUMENT_POSITION_PRECEDING: 2,
  DOCUMENT_POSITION_FOLLOWING: 4,
  DOCUMENT_POSITION_CONTAINS: 8,
  DOCUMENT_POSITION_CONTAINED_BY: 16,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
})) {
  Object.defineProperty(NodeShim, name, { value, writable: false, enumerable: true, configurable: false });
  Object.defineProperty(NodeShim.prototype, name, { value, writable: false, enumerable: true, configurable: false });
}
Object.defineProperty(NodeShim.prototype, 'compareDocumentPosition', {
  ...Object.getOwnPropertyDescriptor(NodeShim.prototype, 'compareDocumentPosition'),
  enumerable: true,
});

class CharacterDataShim extends NodeShim {
  constructor(data = '') {
    super(3, '#text');
    this.textContent = String(data);
  }
  get data() { return this.textContent; }
  set data(value) { this.textContent = String(value); }
  get length() { return this.data.length; }
  get [Symbol.toStringTag]() { return 'CharacterData'; }
}
class TextShim extends CharacterDataShim {
  get [Symbol.toStringTag]() { return 'Text'; }
}
Object.defineProperty(CharacterDataShim, 'name', { value: 'CharacterData', configurable: true });
Object.defineProperty(TextShim, 'name', { value: 'Text', configurable: true });
for (const prototype of [CharacterDataShim.prototype, TextShim.prototype]) {
  for (const name of Reflect.ownKeys(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    Object.defineProperty(prototype, name, { ...descriptor, enumerable: true });
  }
}

class DocumentFragmentShim extends NodeShim {
  constructor(ownerDocument = null) {
    super(11, '#document-fragment');
    setNodeField(this, 'ownerDocument', ownerDocument);
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  querySelector(sel) { return querySelectorFrom(this, sel, false)[0] || null; }
  querySelectorAll(sel) { return makeNodeList(querySelectorFrom(this, sel, false)); }
  getElementById(id) { return querySelectorFrom(this, `#${String(id)}`, false)[0] || null; }
  get isConnected() { return false; }
  get [Symbol.toStringTag]() { return 'DocumentFragment'; }
}
Object.defineProperty(DocumentFragmentShim, 'name', { value: 'DocumentFragment', configurable: true });
for (const name of Reflect.ownKeys(DocumentFragmentShim.prototype)) {
  if (name === 'constructor') continue;
  const descriptor = Object.getOwnPropertyDescriptor(DocumentFragmentShim.prototype, name);
  Object.defineProperty(DocumentFragmentShim.prototype, name, { ...descriptor, enumerable: true });
}

class ShadowRootShim extends DocumentFragmentShim {
  constructor(ownerDocument, host, mode) {
    super(ownerDocument);
    shadowRootState.set(this, { host, mode });
  }
  get host() { return shadowRootState.get(this).host; }
  get mode() { return shadowRootState.get(this).mode; }
  get isConnected() { return !!this.host?.isConnected; }
  get [Symbol.toStringTag]() { return 'ShadowRoot'; }
}

class ElementShim extends NodeShim {
  [Symbol.toPrimitive](hint) {
    if (String(process.env.CLOUDFLARE_TRACE_TOSTRING || '') === '1') {
      try { (globalThis.__cfRuntimeSink || console.error)({ op: 'element.toPrimitive', hint, stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700) }); } catch {}
    }
    return `[object ${this.constructor?.name || 'Object'}]`;
  }
  constructor(tagName = 'div') {
    const localName = String(tagName || 'div').toLowerCase();
    super(1, localName.toUpperCase());
    Object.assign(getNodeState(this), {
      tagName: localName.toUpperCase(), localName,
      namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: [],
      style: createCSS2Properties(), dataset: {}, className: '', id: '', text: '',
      innerHTML: '', readyState: '', async: false, defer: false,
      onload: null, onerror: null, src: '', srcdoc: '', width: 0, height: 0, sandbox: null,
      allow: '', referrerPolicy: '', loading: '',
    });
    getNodeState(this).classList = new DOMTokenListShim(this);
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  // Interactive challenge widgets call pointer-capture, fullscreen and focus APIs on the
  // checkbox target right after a trusted pointerdown. Absent members surface as
  // "X is not a function" inside the widget's own try/catch and count as a failed probe.
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  requestPointerLock() {}
  scrollIntoView() {}
  scroll() {}
  scrollTo() {}
  focus() {}
  blur() {}
  requestFullscreen() { return Promise.resolve(); }
  animate(keyframes, options) {
    // Widgets animate the checkbox; return a minimal Animation-shaped object.
    return {
      cancel() {}, finish() {}, pause() {}, play() {}, reverse() {},
      addEventListener() {}, removeEventListener() {},
      set onfinish(v) {}, get onfinish() { return null; },
      currentTime: 0, startTime: null, playState: 'finished', id: '',
    };
  }
  getAnimations() { return []; }
  get [Symbol.toStringTag]() { return 'Element'; }
}
class HTMLElementShim extends ElementShim {
  get [Symbol.toStringTag]() { return 'HTMLElement'; }
}
class HTMLDivElementShim extends HTMLElementShim {
  get [Symbol.toStringTag]() { return 'HTMLDivElement'; }
}
class HTMLBodyElementShim extends HTMLElementShim {
  get [Symbol.toStringTag]() { return 'HTMLBodyElement'; }
}
class HTMLHeadElementShim extends HTMLElementShim {
  get [Symbol.toStringTag]() { return 'HTMLHeadElement'; }
}
class HTMLHtmlElementShim extends HTMLElementShim {
  get [Symbol.toStringTag]() { return 'HTMLHtmlElement'; }
}
class HTMLInputElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLInputElement'; } }
class HTMLFormControlsCollectionShim extends Array {
  item(index) { return this[Number(index)] || null; }
  namedItem(name) { return this.find(item => item?.name === String(name)) || null; }
  get [Symbol.toStringTag]() { return 'HTMLFormControlsCollection'; }
}
class HTMLFormElementShim extends HTMLElementShim {
  get elements() { return new HTMLFormControlsCollectionShim(...findDescendants(this, node => ['input','button','select','textarea'].includes(String(node?.localName || '').toLowerCase()))); }
  get length() { return this.elements.length; }
  submit() { this.__submit(false); }
  requestSubmit() { this.__submit(true); }
  __submit(requestSubmit) {
    const runtime = getDocumentState(this.ownerDocument).runtime;
    runtime.context.__workerLog.push({ op: 'form.submit.enter', action: String(this.action || ''), method: String(this.method || ''), input_count: findDescendants(this, node => String(node?.localName || '').toLowerCase() === 'input').length });
    runtime.formSubmitCalls = (runtime.formSubmitCalls || 0) + 1;
    const controls = findDescendants(this, node => String(node?.localName || '').toLowerCase() === 'input');
    const params = new URLSearchParams();
    for (const control of controls) {
      if (!control.name || control.disabled) continue;
      params.append(String(control.name), String(control.value ?? ''));
    }
    const action = new URL(this.action || this.getAttribute('action') || runtime.location.href, runtime.location.href).href;
    const method = String(this.method || this.getAttribute('method') || 'get').toUpperCase();
    const body = params.toString();
    const navigation = {
      op: requestSubmit ? 'requestSubmit' : 'submit', action, method,
      enctype: String(this.enctype || this.getAttribute('enctype') || 'application/x-www-form-urlencoded'),
      body, body_size: Buffer.byteLength(body), body_sha256: sha256Bytes(body),
      control_count: controls.length,
      referer: runtime.location.href,
    };
    runtime.navigationLog.push(navigation);
    runtime.context.__navigationLog.push(navigation);
  }
  get [Symbol.toStringTag]() { return 'HTMLFormElement'; }
}
class HTMLIFrameElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLIFrameElement'; } }
class HTMLImageElementShim extends HTMLElementShim {
  get [Symbol.toStringTag]() { return 'HTMLImageElement'; }
  decode() { return Promise.resolve(); }
}
Object.defineProperties(HTMLIFrameElementShim.prototype, {
  contentWindow: {
    enumerable: true,
    configurable: true,
    get() {
      let state = iframeState.get(this);
      if (!state) {
        state = { window: null };
        iframeState.set(this, state);
      }
      const runtime = documentState.get(this.ownerDocument)?.runtime;
      if (!state.window && runtime) state.window = runtime.makeIframeWindow(this);
      return state.window;
    },
  },
  contentDocument: {
    enumerable: true,
    configurable: true,
    get() { return this.contentWindow?.document || null; },
  },
});
class HTMLScriptElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLScriptElement'; } }
class HTMLCanvasElementShim extends HTMLElementShim {
  getContext(kind) { return getDocumentState(this.ownerDocument).runtime.makeCanvasContext(kind, this); }
  toDataURL() { return 'data:image/png;base64,'; }
  get [Symbol.toStringTag]() { return 'HTMLCanvasElement'; }
}
class HTMLAnchorElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLAnchorElement'; } }
class HTMLHeadingElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLHeadingElement'; } }
class HTMLParagraphElementShim extends HTMLElementShim { get [Symbol.toStringTag]() { return 'HTMLParagraphElement'; } }

class CSSRuleShim {
  constructor(cssText = '') {
    this.cssText = String(cssText);
    const match = this.cssText.match(/^([^{}]+)\{([\s\S]*)\}$/);
    this.selectorText = match ? match[1].trim() : '';
    this.style = createCSS2Properties(match ? parseCSSDeclarations(match[2]) : {});
  }
  get [Symbol.toStringTag]() { return 'CSSStyleRule'; }
}

function parseCSSDeclarations(source) {
  const declarations = {};
  for (const part of String(source || '').split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    declarations[name] = value;
    declarations[name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
  }
  return declarations;
}

function resolveStyleForNode(node) {
  const resolved = {};
  for (const sheet of node?.ownerDocument?.styleSheets || []) {
    for (const rule of sheet.cssRules || []) {
      if (!rule.selectorText) continue;
      const selectors = rule.selectorText.split(',').map(value => value.trim());
      if (!selectors.some(selector => selectorMatches(node, selector))) continue;
      Object.assign(resolved, parseCSSDeclarations(rule.cssText.slice(rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'))));
    }
  }
  const inline = cssStyleState.get(node?.style);
  if (inline) for (const [name, value] of inline) {
    resolved[name] = value;
    resolved[name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
  }
  return resolved;
}

function makeCSSRuleList(rules) {
  const list = Array.from(rules || []);
  list.item = index => list[Number(index)] || null;
  Object.defineProperty(list, Symbol.toStringTag, { value: 'CSSRuleList' });
  return list;
}

function collectNodeText(node) {
  let text = typeof node?.textContent === 'string' ? node.textContent : '';
  for (const child of node?.childNodes || []) text += collectNodeText(child);
  return text;
}

class CSSStyleSheetShim {
  constructor(ownerNode) {
    this.ownerNode = ownerNode;
    this.disabled = false;
    this.href = null;
    this.media = { length: 0, mediaText: '', item: () => null };
    this._inserted = [];
  }
  _rules() {
    const source = `${this.ownerNode?.innerHTML || ''}\n${collectNodeText(this.ownerNode)}`;
    const parsed = [];
    const pattern = /(?:@[^;{}]+;|[^{}]+\{[^{}]*\})/g;
    for (const match of source.matchAll(pattern)) {
      const cssText = match[0].trim();
      if (cssText) parsed.push(new CSSRuleShim(cssText));
    }
    return [...this._inserted, ...parsed];
  }
  get cssRules() { return makeCSSRuleList(this._rules()); }
  get rules() { return this.cssRules; }
  insertRule(rule, index = this._inserted.length) {
    const at = Math.max(0, Math.min(Number(index) || 0, this._inserted.length));
    this._inserted.splice(at, 0, new CSSRuleShim(rule));
    return at;
  }
  deleteRule(index) { this._inserted.splice(Number(index) || 0, 1); }
  get [Symbol.toStringTag]() { return 'CSSStyleSheet'; }
}

const styleElementState = new WeakMap();

class HTMLStyleElementShim extends HTMLElementShim {
  constructor(...args) {
    super(...args);
    styleElementState.set(this, { sheet: new CSSStyleSheetShim(this) });
  }
  get sheet() { return styleElementState.get(this).sheet; }
  get [Symbol.toStringTag]() { return 'HTMLStyleElement'; }
}

for (const name of ['tagName', 'localName', 'namespaceURI', 'attributes']) defineStateAccessor(ElementShim.prototype, name, { readonly: true });
for (const name of ['id', 'className', 'classList']) defineStateAccessor(ElementShim.prototype, name);
for (const name of ['style']) defineStateAccessor(HTMLElementShim.prototype, name);
for (const name of ['dataset']) defineStateAccessor(HTMLElementShim.prototype, name, { readonly: true });
for (const name of ['onload', 'onerror']) defineStateAccessor(HTMLElementShim.prototype, name);
for (const name of ['src', 'async', 'defer', 'text', 'readyState']) defineStateAccessor(HTMLScriptElementShim.prototype, name);
Object.defineProperties(HTMLImageElementShim.prototype, {
  src: {
    configurable: true, enumerable: true,
    get() { return getNodeState(this).src; },
    set(value) {
      const state = getNodeState(this);
      state.src = String(value ?? '');
      const document = state.ownerDocument;
      const runtime = document && documentState.get(document)?.runtime;
      if (runtime && state.src && !state.resourceStarted) runtime.onImageSourceChanged(this, state.src);
    },
  },
  alt: { configurable: true, enumerable: true, get() { return getNodeState(this).alt || ''; }, set(value) { getNodeState(this).alt = String(value ?? ''); } },
  currentSrc: { configurable: true, enumerable: true, get() { return getNodeState(this).currentSrc || ''; } },
  width: { configurable: true, enumerable: true, get() { return Number(getNodeState(this).width || 0); }, set(value) { getNodeState(this).width = Number(value) || 0; } },
  height: { configurable: true, enumerable: true, get() { return Number(getNodeState(this).height || 0); }, set(value) { getNodeState(this).height = Number(value) || 0; } },
  complete: { configurable: true, enumerable: true, get() { return !!getNodeState(this).complete; } },
  naturalWidth: { configurable: true, enumerable: true, get() { return Number(getNodeState(this).naturalWidth || 0); } },
  naturalHeight: { configurable: true, enumerable: true, get() { return Number(getNodeState(this).naturalHeight || 0); } },
});
for (const name of ['src', 'srcdoc', 'sandbox', 'width', 'height', 'allow', 'referrerPolicy', 'loading']) defineStateAccessor(HTMLIFrameElementShim.prototype, name);
for (const name of ['width', 'height']) defineStateAccessor(HTMLCanvasElementShim.prototype, name);
for (const name of ['type', 'name', 'value']) defineStateAccessor(HTMLInputElementShim.prototype, name);
for (const name of ['action', 'method', 'enctype', 'target']) defineStateAccessor(HTMLFormElementShim.prototype, name);
for (const name of ['href']) defineStateAccessor(HTMLAnchorElementShim.prototype, name);

for (const name of ['setAttribute', 'getAttribute', 'hasAttribute', 'removeAttribute', 'innerHTML', 'firstElementChild', 'matches', 'closest', 'previousElementSibling', 'getBoundingClientRect', 'querySelector', 'querySelectorAll', 'getElementsByTagName', 'attachShadow', 'shadowRoot', 'remove']) {
  const descriptor = Object.getOwnPropertyDescriptor(NodeShim.prototype, name);
  if (!descriptor) continue;
  Object.defineProperty(ElementShim.prototype, name, { ...descriptor, enumerable: true });
  delete NodeShim.prototype[name];
}
for (const name of ['innerText']) {
  const descriptor = Object.getOwnPropertyDescriptor(NodeShim.prototype, name);
  if (!descriptor) continue;
  Object.defineProperty(HTMLElementShim.prototype, name, { ...descriptor, enumerable: true });
  delete NodeShim.prototype[name];
}

for (const [Ctor, name] of [
  [ElementShim, 'Element'], [HTMLElementShim, 'HTMLElement'], [HTMLDivElementShim, 'HTMLDivElement'],
  [HTMLBodyElementShim, 'HTMLBodyElement'], [HTMLHeadElementShim, 'HTMLHeadElement'], [HTMLHtmlElementShim, 'HTMLHtmlElement'],
  [HTMLInputElementShim, 'HTMLInputElement'], [HTMLFormElementShim, 'HTMLFormElement'], [HTMLIFrameElementShim, 'HTMLIFrameElement'], [HTMLImageElementShim, 'HTMLImageElement'], [HTMLScriptElementShim, 'HTMLScriptElement'],
  [HTMLCanvasElementShim, 'HTMLCanvasElement'], [HTMLAnchorElementShim, 'HTMLAnchorElement'], [HTMLHeadingElementShim, 'HTMLHeadingElement'],
  [HTMLParagraphElementShim, 'HTMLParagraphElement'], [HTMLStyleElementShim, 'HTMLStyleElement'],
]) Object.defineProperty(Ctor, 'name', { value: name, configurable: true });

for (const prototype of [ElementShim.prototype, HTMLElementShim.prototype, HTMLDivElementShim.prototype, HTMLBodyElementShim.prototype, HTMLHeadElementShim.prototype, HTMLHtmlElementShim.prototype, HTMLInputElementShim.prototype, HTMLFormElementShim.prototype, HTMLIFrameElementShim.prototype, HTMLImageElementShim.prototype, HTMLScriptElementShim.prototype, HTMLCanvasElementShim.prototype, HTMLAnchorElementShim.prototype, HTMLHeadingElementShim.prototype, HTMLParagraphElementShim.prototype, HTMLStyleElementShim.prototype]) {
  for (const name of Reflect.ownKeys(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    Object.defineProperty(prototype, name, { ...descriptor, enumerable: true });
  }
}

function makeNodeList(items) {
  const arr = Array.from(items || []);
  arr.item = (i) => arr[i] || null;
  arr.entries = Array.prototype.entries.bind(arr);
  arr.keys = Array.prototype.keys.bind(arr);
  arr.values = Array.prototype.values.bind(arr);
  arr.forEach = Array.prototype.forEach.bind(arr);
  return arr;
}

function findDescendants(root, pred) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.nodeType === 1 && pred(c)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function selectorMatches(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  const groups = String(selector || '').split(',').map(s => s.trim()).filter(Boolean);
  return groups.some((sel) => {
    if (sel === '*') return true;
    const attributeMatch = sel.match(/^(.*)\[([\w:-]+)(?:=(["']?)(.*?)\3)?\]$/);
    let attributeName = '';
    let attributeValue;
    if (attributeMatch) {
      sel = attributeMatch[1] || '*';
      attributeName = attributeMatch[2];
      attributeValue = attributeMatch[4];
    }
    const m = sel.match(/^(?:\*|(\w+)|)(?:#([\w:-]+)|)(?:\.([\w.-]+)|)$/);
    if (!m) return false;
    const [, tag, id, cls] = m;
    if (tag && (node.localName || '').toLowerCase() !== tag.toLowerCase()) return false;
    if (id && node.id !== id) return false;
    if (cls) {
      const classes = cls.split('.').filter(Boolean);
      const have = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
      if (!classes.every(c => have.has(c))) return false;
    }
    if (attributeName) {
      if (!node.hasAttribute?.(attributeName)) return false;
      if (attributeValue !== undefined && node.getAttribute(attributeName) !== attributeValue) return false;
    }
    return true;
  });
}

function querySelectorFrom(root, selector, includeRoot) {
  const out = [];
  const groups = String(selector || '').split(',').map(s => s.trim()).filter(Boolean);
  const visit = (n, include) => {
    if (include && n.nodeType === 1 && groups.some(g => selectorMatches(n, g))) out.push(n);
    for (const c of n.childNodes || []) visit(c, true);
  };
  visit(root, includeRoot);
  return out;
}

class NodeIteratorShim {
  constructor(root, whatToShow = 0xffffffff, filter = null) {
    this.__root = root;
    this.__whatToShow = Number(whatToShow) >>> 0;
    this.__filter = filter;
    this.__nodes = [];
    const visit = node => {
      if (!node) return;
      const mask = node.nodeType > 0 && node.nodeType <= 32 ? (1 << (node.nodeType - 1)) >>> 0 : 0;
      if ((this.__whatToShow & mask) !== 0) {
        let decision = NodeFilterShim.FILTER_ACCEPT;
        if (typeof filter === 'function') decision = filter(node);
        else if (filter && typeof filter.acceptNode === 'function') decision = filter.acceptNode(node);
        if (decision === NodeFilterShim.FILTER_ACCEPT) this.__nodes.push(node);
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(root);
    this.__index = -1;
  }
  nextNode() {
    if (this.__index + 1 >= this.__nodes.length) return null;
    return this.__nodes[++this.__index];
  }
  previousNode() {
    if (this.__index - 1 < 0) return null;
    return this.__nodes[--this.__index];
  }
  detach() {}
  get root() { return this.__root; }
  get referenceNode() { return this.__index >= 0 ? this.__nodes[this.__index] : this.__root; }
  get pointerBeforeReferenceNode() { return this.__index < 0; }
  get whatToShow() { return this.__whatToShow; }
  get filter() { return this.__filter; }
  get [Symbol.toStringTag]() { return 'NodeIterator'; }
}
for (const key of ['nextNode', 'previousNode', 'detach', 'root', 'referenceNode', 'pointerBeforeReferenceNode', 'whatToShow', 'filter']) {
  const descriptor = Object.getOwnPropertyDescriptor(NodeIteratorShim.prototype, key);
  Object.defineProperty(NodeIteratorShim.prototype, key, { ...descriptor, enumerable: true });
}

class StorageShim {
  constructor(seed = {}) { this._m = new Map(Object.entries(seed)); }
  get length() { return this._m.size; }
  key(i) { return Array.from(this._m.keys())[i] ?? null; }
  getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(String(k)); }
  clear() { this._m.clear(); }
}

class FileSystemFileHandleShim {
  constructor(name, store) { this.name = String(name); this.kind = 'file'; this.__store = store; }
  async createSyncAccessHandle() {
    const store = this.__store;
    const name = this.name;
    let bytes = Buffer.from(store.get(name) || Buffer.alloc(0));
    let closed = false;
    return {
      write(value, options = {}) {
        if (closed) throw new DOMExceptionShim('InvalidStateError', 'InvalidStateError');
        const input = Buffer.isBuffer(value)
          ? value
          : value instanceof ArrayBuffer
            ? Buffer.from(value)
            : ArrayBuffer.isView(value)
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.from(String(value ?? ''), 'utf8');
        const at = Math.max(0, Number(options.at) || 0);
        const end = at + input.length;
        if (end > bytes.length) bytes = Buffer.concat([bytes, Buffer.alloc(end - bytes.length)]);
        input.copy(bytes, at);
        return input.length;
      },
      flush() { if (closed) throw new DOMExceptionShim('InvalidStateError', 'InvalidStateError'); store.set(name, Buffer.from(bytes)); },
      close() { if (!closed) { store.set(name, Buffer.from(bytes)); closed = true; } },
      get [Symbol.toStringTag]() { return 'FileSystemSyncAccessHandle'; },
    };
  }
  async getFile() {
    const bytes = this.__store.get(this.name) || Buffer.alloc(0);
    return new BlobShim([bytes], { type: 'application/octet-stream' });
  }
  async createWritable() {
    const store = this.__store; const name = this.name; let chunks = [];
    return { write: value => { chunks.push(value); }, close: async () => {
      const parts = chunks.map(value => Buffer.isBuffer(value) ? value : value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value ?? ''), 'utf8'));
      store.set(name, Buffer.concat(parts));
    }, abort: async () => { chunks = []; } };
  }
  get [Symbol.toStringTag]() { return 'FileSystemFileHandle'; }
}

class FileSystemDirectoryHandleShim {
  constructor(name = '', store = new Map()) { this.name = String(name); this.kind = 'directory'; this.__store = store; this.__dirs = new Map(); }
  async getFileHandle(name, options = {}) { const key = String(name); if (!this.__store.has(key) && options.create !== true) throw new DOMExceptionShim('NotFoundError', 'NotFoundError'); return new FileSystemFileHandleShim(key, this.__store); }
  async getDirectoryHandle(name, options = {}) { const key = String(name); if (!this.__dirs.has(key) && options.create !== true) throw new DOMExceptionShim('NotFoundError', 'NotFoundError'); if (!this.__dirs.has(key)) this.__dirs.set(key, new FileSystemDirectoryHandleShim(key)); return this.__dirs.get(key); }
  async removeEntry(name) { this.__store.delete(String(name)); this.__dirs.delete(String(name)); }
  async *entries() { for (const [key] of this.__store) yield [key, new FileSystemFileHandleShim(key, this.__store)]; for (const [key, value] of this.__dirs) yield [key, value]; }
  async *keys() { for await (const [key] of this.entries()) yield key; }
  async *values() { for await (const [, value] of this.entries()) yield value; }
  get [Symbol.toStringTag]() { return 'FileSystemDirectoryHandle'; }
}

class BarPropShim {
  constructor(visible = true) { this.__visible = !!visible; }
  get visible() { return this.__visible; }
  get [Symbol.toStringTag]() { return 'BarProp'; }
}

class VisualViewportShim extends EventTargetShim {
  constructor(width = 300, height = 65) {
    super();
    this.__width = Number(width); this.__height = Number(height);
    this.__offsetLeft = 0; this.__offsetTop = 0; this.__pageLeft = 0; this.__pageTop = 0; this.__scale = 1;
    this.onresize = null; this.onscroll = null;
  }
  get offsetLeft() { return this.__offsetLeft; }
  get offsetTop() { return this.__offsetTop; }
  get pageLeft() { return this.__pageLeft; }
  get pageTop() { return this.__pageTop; }
  get width() { return this.__width; }
  get height() { return this.__height; }
  get scale() { return this.__scale; }
  get [Symbol.toStringTag]() { return 'VisualViewport'; }
}

class CacheShim {
  constructor() { this.__entries = new Map(); }
  __key(request) { return request instanceof URL ? request.href : String(request?.url || request); }
  match(request) { return Promise.resolve(this.__entries.get(this.__key(request)) || undefined); }
  matchAll(request) { return this.match(request).then(value => value ? [value] : []); }
  add(request) { return Promise.resolve().then(() => this.put(request, new ResponseShim(''))); }
  addAll(requests) { return Promise.all(Array.from(requests || [], request => this.add(request))).then(() => undefined); }
  put(request, response) { return Promise.resolve().then(() => { this.__entries.set(this.__key(request), response); }); }
  delete(request) { return Promise.resolve(this.__entries.delete(this.__key(request))); }
  keys() { return Promise.resolve(Array.from(this.__entries.keys(), url => new RequestShim(url))); }
  get [Symbol.toStringTag]() { return 'Cache'; }
}

class CacheStorageShim {
  constructor() { this.__caches = new Map(); }
  match(request) { return Promise.all(Array.from(this.__caches.values(), cache => cache.match(request))).then(values => values.find(Boolean)); }
  has(name) { return Promise.resolve(this.__caches.has(String(name))); }
  open(name) { const key = String(name); if (!this.__caches.has(key)) this.__caches.set(key, new CacheShim()); return Promise.resolve(this.__caches.get(key)); }
  delete(name) { return Promise.resolve(this.__caches.delete(String(name))); }
  keys() { return Promise.resolve(Array.from(this.__caches.keys())); }
  get [Symbol.toStringTag]() { return 'CacheStorage'; }
}

class CookieStoreShim extends EventTargetShim {
  get(name) { const key = String(name); const found = String(this.__document?.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${key}=`)); return Promise.resolve(found ? { name: key, value: found.slice(key.length + 1) } : null); }
  getAll(name) { return this.get(name).then(value => value ? [value] : []); }
  set() { return Promise.resolve(); }
  delete() { return Promise.resolve(); }
  get [Symbol.toStringTag]() { return 'CookieStore'; }
}

class SchedulerShim {
  postTask(callback) { return Promise.resolve().then(() => typeof callback === 'function' ? callback() : undefined); }
  yield() { return Promise.resolve(); }
  get [Symbol.toStringTag]() { return 'Scheduler'; }
}

class FontFaceSetShim extends EventTargetShim {
  constructor() { super(); this.status = 'loaded'; this.onloading = null; this.onloadingdone = null; this.onloadingerror = null; this.ready = Promise.resolve(this); }
  check() { return true; }
  load() { return Promise.resolve([]); }
  add(value) { return this; }
  delete() { return false; }
  clear() {}
  has() { return false; }
  entries() { return [][Symbol.iterator](); }
  keys() { return [][Symbol.iterator](); }
  values() { return [][Symbol.iterator](); }
  forEach() {}
  [Symbol.iterator]() { return this.values(); }
  get size() { return 0; }
  get [Symbol.toStringTag]() { return 'FontFaceSet'; }
}

class MediaDevicesShim extends EventTargetShim {
  constructor() { super(); this.ondevicechange = null; }
  getSupportedConstraints() { return {}; }
  enumerateDevices() { return Promise.resolve([]); }
  getUserMedia() { return Promise.reject(new DOMExceptionShim('The request is not allowed by the user agent.', 'NotAllowedError')); }
  getDisplayMedia() { return Promise.reject(new DOMExceptionShim('The request is not allowed by the user agent.', 'NotAllowedError')); }
  selectAudioOutput() { return Promise.reject(new DOMExceptionShim('The request is not allowed by the user agent.', 'NotAllowedError')); }
  get [Symbol.toStringTag]() { return 'MediaDevices'; }
}

class CustomElementRegistryShim {
  constructor() { this.__definitions = new Map(); this.__pending = new Map(); }
  define(name, constructor) { const key = String(name); if (this.__definitions.has(key)) throw new DOMExceptionShim(`the name "${key}" has already been used`, 'NotSupportedError'); this.__definitions.set(key, constructor); this.__pending.get(key)?.forEach(resolve => resolve(constructor)); this.__pending.delete(key); }
  get(name) { return this.__definitions.get(String(name)); }
  getName(constructor) { for (const [name, value] of this.__definitions) if (value === constructor) return name; return undefined; }
  whenDefined(name) { const key = String(name); const current = this.get(key); if (current) return Promise.resolve(current); return new Promise(resolve => { const list = this.__pending.get(key) || []; list.push(resolve); this.__pending.set(key, list); }); }
  upgrade() {}
  get [Symbol.toStringTag]() { return 'CustomElementRegistry'; }
}

class RTCDataChannelShim extends EventTargetShim {
  constructor(label = '', options = {}) { super(); rtcDataChannelState.set(this, { label: String(label), ordered: options.ordered !== false, maxPacketLifeTime: options.maxPacketLifeTime ?? null, maxRetransmits: options.maxRetransmits ?? null, protocol: String(options.protocol || ''), negotiated: !!options.negotiated, id: options.id ?? null, readyState: 'connecting', bufferedAmount: 0, bufferedAmountLowThreshold: 0, binaryType: 'blob', onopen: null, onerror: null, onclose: null, onmessage: null, onbufferedamountlow: null }); }
  close() { const s = rtcDataChannelState.get(this); s.readyState = 'closed'; this.dispatchEvent({ type: 'close' }); }
  send() { if (rtcDataChannelState.get(this).readyState === 'closed') throw new DOMExceptionShim('RTCDataChannel is closed', 'InvalidStateError'); }
  get label() { return rtcDataChannelState.get(this).label; } get negotiated() { return rtcDataChannelState.get(this).negotiated; } get ordered() { return rtcDataChannelState.get(this).ordered; }
  get maxPacketLifeTime() { return rtcDataChannelState.get(this).maxPacketLifeTime; } get maxRetransmits() { return rtcDataChannelState.get(this).maxRetransmits; } get protocol() { return rtcDataChannelState.get(this).protocol; }
  get id() { return rtcDataChannelState.get(this).id; } get readyState() { return rtcDataChannelState.get(this).readyState; } get bufferedAmount() { return rtcDataChannelState.get(this).bufferedAmount; }
  get bufferedAmountLowThreshold() { return rtcDataChannelState.get(this).bufferedAmountLowThreshold; } set bufferedAmountLowThreshold(value) { rtcDataChannelState.get(this).bufferedAmountLowThreshold = Number(value); }
  get binaryType() { return rtcDataChannelState.get(this).binaryType; } set binaryType(value) { const next = String(value); if (next !== 'blob' && next !== 'arraybuffer') throw new TypeError('Invalid binaryType'); rtcDataChannelState.get(this).binaryType = next; }
  get onopen() { return rtcDataChannelState.get(this).onopen; } set onopen(v) { rtcDataChannelState.get(this).onopen = v; }
  get onerror() { return rtcDataChannelState.get(this).onerror; } set onerror(v) { rtcDataChannelState.get(this).onerror = v; }
  get onclose() { return rtcDataChannelState.get(this).onclose; } set onclose(v) { rtcDataChannelState.get(this).onclose = v; }
  get onmessage() { return rtcDataChannelState.get(this).onmessage; } set onmessage(v) { rtcDataChannelState.get(this).onmessage = v; }
  get onbufferedamountlow() { return rtcDataChannelState.get(this).onbufferedamountlow; } set onbufferedamountlow(v) { rtcDataChannelState.get(this).onbufferedamountlow = v; }
  get [Symbol.toStringTag]() { return 'RTCDataChannel'; }
}
const rtcDataChannelState = new WeakMap();
Object.defineProperty(RTCDataChannelShim, 'name', { value: 'RTCDataChannel', configurable: true });
for (const name of Reflect.ownKeys(RTCDataChannelShim.prototype)) {
  if (name === 'constructor') continue;
  const descriptor = Object.getOwnPropertyDescriptor(RTCDataChannelShim.prototype, name);
  Object.defineProperty(RTCDataChannelShim.prototype, name, { ...descriptor, enumerable: true });
}

const documentState = new WeakMap();

function getDocumentState(document) {
  const state = documentState.get(document);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function setDocumentField(document, name, value) {
  getDocumentState(document)[name] = value;
  return value;
}

class DocumentShim extends NodeShim {
  constructor(runtime, options = {}) {
    super(9, '#document');
    const location = options.location || runtime.location;
    documentState.set(this, {
      runtime, isFrameDocument: !!options.isFrameDocument, onNodeInserted: options.onNodeInserted || null,
      URL: location.href, documentURI: location.href, baseURI: location.href, location, domain: location.hostname,
      referrer: options.referrer || '', characterSet: 'UTF-8', compatMode: 'CSS1Compat',
      readyState: options.readyState || 'interactive', visibilityState: 'visible', hidden: false,
      title: options.title ?? 'Checking your Browser…', cookie: '', currentScript: null,
      documentElement: null, head: null, body: null, scripts: [], forms: [], images: [], links: [], styleSheets: [],
      fonts: new FontFaceSetShim(),
      defaultView: null,
    });
    setNodeField(this, 'ownerDocument', null);
    Object.defineProperty(this, 'location', {
      enumerable: true, configurable: false,
      get: () => getDocumentState(this).location,
      set: value => { getDocumentState(this).location.href = String(value); },
    });
    const state = getDocumentState(this);
    // Firefox 142 exposes neither document.permissionsPolicy nor the legacy
    // document.featurePolicy in the top page or Turnstile frame.  Supplying a
    // synthetic policy object changes Cloudflare's capability branch.
    state.permissionsPolicy = null;
    state.featurePolicy = null;
    state.documentElement = this.createElement('html');
    state.head = this.createElement('head');
    state.body = this.createElement('body');
    state.documentElement.appendChild(state.head);
    state.documentElement.appendChild(state.body);
    if (options.seed !== false) documentSeedInitialDom(this);
  }
  createElement(tag) {
    tag = String(tag).toLowerCase();
    const runtime = getDocumentState(this).runtime;
    if (runtime.afterFinalResponse && ['form', 'input'].includes(tag)) {
      try { runtime.context.__workerLog.push({ op: 'document.createElement.after-final', tag }); } catch {}
    }
    const Ctor = ({
      div: HTMLDivElementShim,
      body: HTMLBodyElementShim,
      head: HTMLHeadElementShim,
      html: HTMLHtmlElementShim,
      input: HTMLInputElementShim,
      form: HTMLFormElementShim,
      iframe: HTMLIFrameElementShim,
      img: HTMLImageElementShim,
      script: HTMLScriptElementShim,
      canvas: HTMLCanvasElementShim,
      a: HTMLAnchorElementShim,
      h1: HTMLHeadingElementShim,
      h2: HTMLHeadingElementShim,
      h3: HTMLHeadingElementShim,
      p: HTMLParagraphElementShim,
      style: HTMLStyleElementShim,
    })[tag] || HTMLElementShim;
    const n = new Ctor(tag);
    setNodeField(n, 'ownerDocument', this);
    if (tag === 'img') {
      try { runtime.context.__workerLog.push({ op: 'document.createElement', tag: 'img', realm: getDocumentState(this).isFrameDocument ? 'frame' : 'main' }); } catch {}
    }
    if (tag === 'input') {
      n.type = 'text';
      n.name = '';
      n.value = '';
    }
    if (tag === 'form') {
      n.action = '';
      n.method = 'get';
      n.enctype = 'application/x-www-form-urlencoded';
      n.target = '';
    }
    if (tag === 'iframe') {
      n.width = 0; n.height = 0;
      n.sandbox = new DOMTokenListShim(n);
      iframeState.set(n, { window: null });
    }
    if (tag === 'img') {
      Object.assign(getNodeState(n), { alt: '', complete: true, naturalWidth: 0, naturalHeight: 0, currentSrc: '', width: 0, height: 0 });
      getDocumentState(this).images.push(n);
    }
    if (tag === 'canvas') { n.width = 1; n.height = 1; }
    return n;
  }
  hasStorageAccess() { return Promise.resolve(true); }
  requestStorageAccess() { return Promise.resolve(); }
  createElementNS(ns, tag) { const n = this.createElement(tag); getNodeState(n).namespaceURI = String(ns); return n; }
  createTextNode(text) { const n = new TextShim(text); setNodeField(n, 'ownerDocument', this); return n; }
  createDocumentFragment() { return new DocumentFragmentShim(this); }
  createNodeIterator(root, whatToShow = 0xffffffff, filter = null) { return new NodeIteratorShim(root, whatToShow, filter); }
  getElementById(id) {
    id = String(id);
    return querySelectorFrom(this.documentElement, `#${id}`, true)[0] || null;
  }
  getElementsByTagName(tag) {
    tag = String(tag).toLowerCase();
    if (tag === 'head') return makeNodeList([this.head]);
    if (tag === 'body') return makeNodeList([this.body]);
    if (tag === 'script') return makeNodeList(this.scripts);
    return makeNodeList(findDescendants(this.documentElement, n => tag === '*' || (n.localName || '').toLowerCase() === tag));
  }
  querySelector(sel) {
    if (sel === 'head') return this.head;
    if (sel === 'body') return this.body;
    if (sel === 'script') return this.scripts[0] || null;
    return querySelectorFrom(this.documentElement, sel, true)[0] || null;
  }
  querySelectorAll(sel) { return makeNodeList(querySelectorFrom(this.documentElement, sel, true)); }
  get [Symbol.toStringTag]() { return 'Document'; }
}

class HTMLDocumentShim extends DocumentShim {
  get [Symbol.toStringTag]() { return 'HTMLDocument'; }
}

function documentSeedInitialDom(document) {
  const mainWrapper = document.createElement('div');
  mainWrapper.className = 'main-wrapper';
  mainWrapper.classList._load('main-wrapper');
  const mainContent = document.createElement('div');
  mainContent.className = 'main-content';
  mainContent.classList._load('main-content');
  mainWrapper.appendChild(mainContent);
  document.body.appendChild(mainWrapper);
}

function documentNodeInserted(document, node) {
  const state = documentState.get(document);
  if (!state) return;
  if (typeof state.onNodeInserted === 'function') state.onNodeInserted(node);
  const runtime = state.runtime;
  try { runtime.context.__workerLog.push({ op: 'node.inserted', tag: node.localName || node.tagName, src: node.src || node.getAttribute?.('src') || '', id: node.id || '', ...(String(node.localName || '').toLowerCase() === 'iframe' ? { allow: String(node.allow || ''), sandbox: String(node.sandbox || '') } : {}) }); } catch {}
  if ((node.localName || '').toLowerCase() === 'script') {
    state.scripts.push(node);
    runtime.onScriptInserted(node);
  }
  if ((node.localName || '').toLowerCase() === 'style' && node.sheet && !state.styleSheets.includes(node.sheet)) state.styleSheets.push(node.sheet);
  if ((node.localName || '').toLowerCase() === 'iframe') runtime.executeFrameScript(node);
  if ((node.localName || '').toLowerCase() === 'img' && node.src) runtime.onImageSourceChanged(node, node.src);
}

for (const name of ['URL', 'documentURI', 'baseURI', 'domain', 'referrer', 'characterSet', 'compatMode', 'readyState', 'visibilityState', 'hidden', 'currentScript', 'documentElement', 'head', 'scripts', 'forms', 'images', 'links', 'styleSheets', 'fonts', 'defaultView', 'permissionsPolicy', 'featurePolicy']) {
  const getter = function() { return getDocumentState(this)[name]; };
  Object.defineProperty(getter, 'name', { value: `get ${name}`, configurable: true });
  Object.defineProperty(DocumentShim.prototype, name, { get: getter, enumerable: true, configurable: true });
}
for (const name of ['title', 'body']) {
  const getter = function() { return getDocumentState(this)[name]; };
  const setter = function(value) { getDocumentState(this)[name] = value; };
  Object.defineProperty(getter, 'name', { value: `get ${name}`, configurable: true });
  Object.defineProperty(setter, 'name', { value: `set ${name}`, configurable: true });
  Object.defineProperty(DocumentShim.prototype, name, { get: getter, set: setter, enumerable: true, configurable: true });
}
Object.defineProperty(DocumentShim.prototype, 'cookie', {
  enumerable: true, configurable: true,
  get() { return getDocumentState(this).cookie; },
  set(value) {
    const state = getDocumentState(this);
    const parts = String(value || '').split(';').map(item => item.trim());
    const separator = parts[0].indexOf('=');
    if (separator < 1) return;
    const name = parts[0].slice(0, separator);
    const nextValue = parts[0].slice(separator + 1);
    const deleting = parts.slice(1).some(item => /^max-age\s*=\s*-\d+/i.test(item));
    const cookies = new Map(String(state.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
      const index = item.indexOf('=');
      return index > 0 ? [item.slice(0, index), item.slice(index + 1)] : [item, ''];
    }));
    if (deleting || nextValue === '') cookies.delete(name);
    else cookies.set(name, nextValue);
    state.cookie = Array.from(cookies, ([key, item]) => `${key}=${item}`).join('; ');
  },
});
for (const name of Reflect.ownKeys(DocumentShim.prototype)) {
  if (name === 'constructor') continue;
  const descriptor = Object.getOwnPropertyDescriptor(DocumentShim.prototype, name);
  Object.defineProperty(DocumentShim.prototype, name, { ...descriptor, enumerable: true });
}
Object.defineProperty(DocumentShim, 'name', { value: 'Document', configurable: true });
Object.defineProperty(HTMLDocumentShim, 'name', { value: 'HTMLDocument', configurable: true });


class BlobShim {
  constructor(parts = [], opts = {}) {
    this.__parts = Array.from(parts || []);
    this.type = String(opts.type || '').toLowerCase();
    const buffers = this.__parts.map((part) => {
      if (part == null) return Buffer.alloc(0);
      if (Buffer.isBuffer(part)) return part;
      if (part instanceof ArrayBuffer) return Buffer.from(part);
      if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      if (part && typeof part.__buffer === 'function') return part.__buffer();
      return Buffer.from(String(part), 'utf8');
    });
    this.__buf = Buffer.concat(buffers);
    this.size = this.__buf.length;
  }
  __buffer() { return this.__buf; }
  text() { return Promise.resolve(this.__buf.toString('utf8')); }
  arrayBuffer() { return Promise.resolve(this.__buf.buffer.slice(this.__buf.byteOffset, this.__buf.byteOffset + this.__buf.byteLength)); }
  slice(start = 0, end = this.size, type = '') {
    const b = this.__buf.slice(start, end);
    return new BlobShim([b], { type });
  }
  stream() {
    const b = this.__buf;
    return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(b)); controller.close(); } });
  }
  get [Symbol.toStringTag]() { return 'Blob'; }
}

function cloneIntoVmContext(value, context, seen = new WeakMap()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (!context) return structuredClone(value);
  if (seen.has(value)) return seen.get(value);
  const realm = name => vm.runInContext(name, context);
  if (value instanceof ArrayBuffer) {
    const RealmUint8Array = realm('Uint8Array');
    const copy = new RealmUint8Array(value.byteLength);
    copy.set(new Uint8Array(value));
    return copy.buffer;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const RealmDataView = realm('DataView');
      return new RealmDataView(cloneIntoVmContext(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), context, seen,
      ));
    }
    const RealmTypedArray = realm(value.constructor.name);
    return new RealmTypedArray(Array.from(value));
  }
  if (Array.isArray(value)) {
    const RealmArray = realm('Array');
    const copy = new RealmArray(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) if (i in value) copy[i] = cloneIntoVmContext(value[i], context, seen);
    return copy;
  }
  if (value instanceof Date) return new (realm('Date'))(value.getTime());
  if (value instanceof Map) {
    const copy = new (realm('Map'))();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(cloneIntoVmContext(key, context, seen), cloneIntoVmContext(item, context, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new (realm('Set'))();
    seen.set(value, copy);
    for (const item of value) copy.add(cloneIntoVmContext(item, context, seen));
    return copy;
  }
  const copy = new (realm('Object'))();
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    Object.defineProperty(copy, key, {
      ...descriptor,
      value: cloneIntoVmContext(descriptor.value, context, seen),
    });
  }
  return copy;
}

class WorkerShim extends EventTargetShim {
  constructor(url, options = {}) {
    super();
    const runtime = WorkerShim.__runtime;
    if (!runtime) throw new TypeError('Worker runtime not initialized');
    this.__baseUrl = options.__baseUrl || runtime.location.href;
    this.__ownerContext = options.__ownerContext || runtime.context;
    this.url = new URL(String(url), this.__baseUrl).href;
    this.__ownerOrigin = new URL(this.__baseUrl).origin;
    this.name = String(options.name || '');
    this.type = String(options.type || 'classic');
    this.onmessage = null;
    this.onmessageerror = null;
    this.onerror = null;
    this.__terminated = false;
    this.__runtime = runtime;
    this.__messageQueue = [];
    this.__ready = false;
    this.__timers = new Set();
    runtime.context.__workerLog.push({ op: 'construct', url: this.url, type: this.type, name: this.name });
    this.__start();
    // Native Worker instances expose their state through prototype accessors;
    // Reflect.ownKeys(instance) is empty. Keep the implementation state on the
    // backing object while presenting the browser-visible instance surface.
    const proxy = new Proxy(this, {
      ownKeys() { return []; },
      getOwnPropertyDescriptor() { return undefined; },
    });
    eventTargetState.set(proxy, eventTargetState.get(this));
    return proxy;
  }
  __start() {
    const runtime = this.__runtime;
    const code = runtime.blobUrlStore.get(this.url)?.code || '';
    this.__code = code;
    const worker = this;
    // Cross-realm delivery is a later task, but it is not tied to worker
    // startup latency. Messages posted before startup are held by __ready.
    // The browser schedules an ordinary task here; any larger interval before
    // the next command is produced by the dynamic page script itself.  Do not
    // turn one observed interval into a fixed per-message delay.
    const queueWorkerTask = callback => setTimeout(callback, 0);
    const listeners = new Map();
    const workerNavigator = runtime.makeNavigator({ worker: true });
    const workerPerformance = runtime.makePerformance({ kind: 'worker', url: this.url });
    const workerCaches = new CacheStorageShim();
    class WorkerGlobalScope {}
    class DedicatedWorkerGlobalScope extends WorkerGlobalScope {
      get [Symbol.toStringTag]() { return 'DedicatedWorkerGlobalScope'; }
    }
    class WorkerLocation {
      constructor(href, origin) { this.href = href; this.origin = origin; this.protocol = 'blob:'; }
      toString() { return this.href; }
      get [Symbol.toStringTag]() { return 'WorkerLocation'; }
    }
    const workerGlobal = {
      self: null, globalThis: null, navigator: workerNavigator, performance: workerPerformance,
      isSecureContext: true,
      PublicKeyCredential: PublicKeyCredentialShim,
      location: new WorkerLocation(this.url, this.__ownerOrigin),
      console, crypto: webcrypto, caches: workerCaches,
      indexedDB: new runtime.context.indexedDB.constructor(), scheduler: new SchedulerShim(),
      atob: runtime.context.atob, btoa: runtime.context.btoa,
      TextEncoder, TextDecoder, URL, URLSearchParams, Blob: BlobShim, WebAssembly,
      Event: runtime.context.Event,
      ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
      // Leave Promise undefined here so vm.createContext supplies the worker
      // realm intrinsic. Host Promise jobs do not reliably enter the worker
      // realm's microtask queue after an async bridge fetch resolves.
      Math: runtime.context.Math, Date: runtime.context.Date, JSON, Object, Reflect, Symbol, Error, TypeError, RangeError, SyntaxError, RegExp, Map, Set, WeakMap, WeakSet, BigInt,
      onmessage: null, onmessageerror: null, onerror: null,
      postMessage(data) {
        if (worker.__terminated) return;
        const cloned = cloneIntoVmContext(data, worker.__ownerContext);
        runtime.context.__workerLog.push({
          op: 'worker.postMessage', url: worker.url,
          preview: runtime.previewValue(cloned), message: runtime.messageSnapshot(cloned),
        });
        runtime.context.__workerLog.push({
          op: 'worker.main-message.schedule', url: worker.url,
          onmessage_type: typeof worker.onmessage,
          listener_count: EventTargetShim.listenerCount(worker, 'message'),
        });
        queueWorkerTask(() => worker.__dispatchToMain(new runtime.context.MessageEvent('message', {
          data: cloned, origin: '', source: null, ports: [], isTrusted: true,
        })));
      },
      close() { worker.terminate(); },
      addEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        arr.push(fn); listeners.set(type, arr);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        listeners.set(type, arr.filter(x => x !== fn));
      },
      dispatchEvent(evt) {
        if (!evt || !evt.type) return true;
        evt.target = evt.target || workerGlobal;
        evt.currentTarget = workerGlobal;
        const prop = workerGlobal['on' + evt.type];
        if (typeof prop === 'function') prop.call(workerGlobal, evt);
        for (const fn of (listeners.get(evt.type) || []).slice()) {
          if (typeof fn === 'function') fn.call(workerGlobal, evt);
          else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
        }
        return !evt.defaultPrevented;
      },
      setTimeout: (fn, delay, ...args) => {
        const delayMs = Math.max(0, Number(delay) || 0);
        runtime.context.__workerLog.push({ op: 'worker.timer.schedule', url: worker.url, kind: 'setTimeout', delay: delayMs });
        const handle = setTimeout(() => {
          worker.__timers.delete(handle);
          if (worker.__terminated) return;
          runtime.context.__workerLog.push({ op: 'worker.timer.fire', url: worker.url, kind: 'setTimeout', delay: delayMs });
          try { typeof fn === 'function' ? fn.apply(workerGlobal, args) : vm.runInContext(String(fn), worker.__vmContext); }
          catch (e) { worker.__handleError('worker.setTimeout', e); }
        }, delayMs);
        worker.__timers.add(handle);
        return handle;
      },
      setInterval: (fn, delay, ...args) => {
        const delayMs = Math.max(1, Number(delay) || 0);
        runtime.context.__workerLog.push({ op: 'worker.timer.schedule', url: worker.url, kind: 'setInterval', delay: delayMs });
        const handle = setInterval(() => {
          if (worker.__terminated) return;
          try { typeof fn === 'function' ? fn.apply(workerGlobal, args) : vm.runInContext(String(fn), worker.__vmContext); }
          catch (e) { worker.__handleError('worker.setInterval', e); }
        }, delayMs);
        worker.__timers.add(handle);
        return handle;
      },
      clearTimeout: handle => { clearTimeout(handle); worker.__timers.delete(handle); },
      clearInterval: handle => { clearInterval(handle); worker.__timers.delete(handle); },
      queueMicrotask,
      importScripts: (...urls) => {
        for (const u of urls) {
          const abs = new URL(String(u), runtime.location.href).href;
          const script = runtime.scriptByUrl.get(abs);
          if (script?.code) vm.runInContext(script.code, worker.__vmContext, { filename: abs, timeout: runtime.opts.timeoutMs });
        }
      },
      fetch: (...args) => {
        const requestUrl = String(args[0]?.url || args[0] || '');
        const requestInit = args[1] || {};
        const requestOrigin = (() => { try { return new URL(requestUrl, worker.__baseUrl).origin; } catch { return ''; } })();
        const promise = runtime.makeFetch(this.__baseUrl)(...args);
        return promise.then(response => {
          runtime.context.__workerLog.push({ op: 'worker.fetch.resolve', url: worker.url, request_url: requestUrl, status: response?.status });
          return response;
        }, error => {
          runtime.context.__workerLog.push({ op: 'worker.fetch.reject', url: worker.url, request_url: requestUrl, message: String(error?.message || error) });
          throw error;
        });
      },
      XMLHttpRequest: runtime.makeXHRClass(this.__baseUrl),
    };
    Object.setPrototypeOf(workerGlobal, DedicatedWorkerGlobalScope.prototype);
    workerGlobal.self = workerGlobal;
    workerGlobal.globalThis = workerGlobal;
    this.__workerGlobal = workerGlobal;
    this.__vmContext = vm.createContext(workerGlobal, { name: 'firefox-like-worker' });
    installFirefoxErrorStack(this.__vmContext);
    runtime.installRealmJobPump(this.__vmContext, 'worker');
    // Message delivery belongs to the receiving worker realm.  Constructing
    // the event with the parent realm's constructor changes instanceof and
    // prototype checks in challenge code even when the visible fields match.
    this.__workerGlobal.MessageEvent = vm.runInContext(`(() => {
      class MessageEvent extends Event {
        constructor(type, init = {}) {
          super(type, init);
          this.__data = init.data ?? null;
          this.__origin = String(init.origin || '');
          this.__lastEventId = String(init.lastEventId || '');
          this.__source = init.source ?? null;
          this.__ports = Array.from(init.ports || []);
        }
        get data() { return this.__data; }
        get origin() { return this.__origin; }
        get lastEventId() { return this.__lastEventId; }
        get source() { return this.__source; }
        get ports() { return this.__ports; }
        get [Symbol.toStringTag]() { return 'MessageEvent'; }
      }
      return MessageEvent;
    })()`, this.__vmContext);
    setTimeout(() => {
      if (this.__terminated || !code) return;
      try {
        vm.runInContext(code, this.__vmContext, { filename: this.url, timeout: runtime.opts.timeoutMs });
        this.__ready = true;
        runtime.context.__workerLog.push({ op: 'script.ok', url: this.url, code_size: code.length });
        // DedicatedWorker messages posted while its top-level script is still
        // evaluating are queued by the browser.  Creating the global object is
        // not the readiness boundary: the script must first install onmessage.
        for (const data of this.__messageQueue.splice(0)) {
          setTimeout(() => this.__dispatchToWorker(data), 0);
        }
      } catch (e) { this.__handleError('worker.script', e); }
    }, 100);
  }
  __handleError(where, e) {
    this.__runtime.recordError(where, e);
    this.__runtime.context.__workerLog.push({ op: 'error', where, name: e?.name, message: String(e?.message || e).slice(0, 240), stack: String(e?.stack || '').split('\n').slice(0, 3).join('\n') });
    this.__dispatchToMain({ type: 'error', message: String(e?.message || e), error: e, target: this, currentTarget: this });
  }
  __dispatchToMain(evt) {
    const runtime = this.__runtime;
    const message = runtime.messageSnapshot(evt?.data);
    const frameMessageCount = () => runtime.context.__workerLog.reduce(
      (count, item) => count + (item?.op === 'frame.parent.postMessage' ? 1 : 0), 0,
    );
    const before = {
      request_count: runtime.generatedRequests.length,
      frame_message_count: frameMessageCount(),
      listener_count: EventTargetShim.listenerCount(this, evt?.type),
      terminated: this.__terminated,
    };
    this.__runtime.context.__workerLog.push({
      op: 'worker.main-message.dispatch', url: this.url, type: evt?.type,
      terminated: this.__terminated,
      onmessage_type: typeof this.onmessage,
      listener_count: before.listener_count,
      message,
    });
    if (this.__terminated) return;
    try {
      this.dispatchEvent(evt);
      runtime.context.__workerLog.push({
        op: 'worker.main-message.complete', url: this.url, type: evt?.type,
        message,
        request_delta: runtime.generatedRequests.length - before.request_count,
        frame_message_delta: frameMessageCount() - before.frame_message_count,
        listener_count_before: before.listener_count,
        listener_count_after: EventTargetShim.listenerCount(this, evt?.type),
        terminated_before: before.terminated,
        terminated_after: this.__terminated,
      });
    } catch (error) {
      runtime.context.__workerLog.push({
        op: 'worker.main-message.error', url: this.url, type: evt?.type,
        message,
        name: error?.name,
        error_message: String(error?.message || error).slice(0, 500),
        request_delta: runtime.generatedRequests.length - before.request_count,
        frame_message_delta: frameMessageCount() - before.frame_message_count,
      });
      runtime.recordError('worker.main-message', error);
      throw error;
    }
  }
  __dispatchToWorker(data) {
    if (this.__terminated) return;
    const cloned = cloneIntoVmContext(data, this.__vmContext);
    this.__runtime.context.__workerLog.push({ op: 'worker.message.in', url: this.url, preview: this.__runtime.previewValue(cloned) });
    const evt = new this.__workerGlobal.MessageEvent('message', {
      data: cloned, origin: '', source: null, ports: [], isTrusted: true,
    });
    this.__workerGlobal.dispatchEvent(evt);
  }
  postMessage(data) {
    const cloned = structuredClone(data);
    this.__runtime.context.__workerLog.push({
      op: 'main.postMessage', url: this.url, preview: this.__runtime.previewValue(cloned),
      stack: String(new Error().stack || '').split('\n').slice(1, 5),
    });
    if (!this.__ready) this.__messageQueue.push(cloned);
    else setTimeout(() => this.__dispatchToWorker(cloned), 0);
  }
  terminate() {
    this.__terminated = true;
    this.__messageQueue.length = 0;
    for (const handle of this.__timers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    this.__timers.clear();
    this.__runtime.context.__workerLog.push({ op: 'terminate', url: this.url });
  }
  get [Symbol.toStringTag]() { return 'Worker'; }
}
Object.defineProperty(WorkerShim, 'name', { value: 'Worker', configurable: true });

class DOMExceptionShim extends Error {
  constructor(message = '', name = 'DOMException') { super(message); this.name = name; }
}

class PublicKeyCredentialShim {
  static isConditionalMediationAvailable() { return Promise.resolve(false); }
  static isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(false); }
  get [Symbol.toStringTag]() { return 'PublicKeyCredential'; }
}
Object.defineProperty(PublicKeyCredentialShim, 'name', { value: 'PublicKeyCredential', configurable: true });
class CredentialsContainerShim { get [Symbol.toStringTag]() { return 'CredentialsContainer'; } get() { return Promise.resolve(null); } create() { return Promise.resolve(null); } preventSilentAccess() { return Promise.resolve(); } }

class HeadersShim {
  constructor(init) {
    this._h = new Map();
    if (init) {
      if (init instanceof HeadersShim) {
        for (const [name, value] of init) this.set(name, value);
        return;
      }
      if (Array.isArray(init)) for (const [k, v] of init) this.set(k, v);
      else for (const [k, v] of Object.entries(init)) this.set(k, v);
    }
  }
  set(k, v) { this._h.set(String(k).toLowerCase(), [String(k), String(v)]); }
  append(k, v) { this.set(k, this.has(k) ? this.get(k) + ', ' + v : v); }
  get(k) { const v = this._h.get(String(k).toLowerCase()); return v ? v[1] : null; }
  has(k) { return this._h.has(String(k).toLowerCase()); }
  entries() { return Array.from(this._h.values())[Symbol.iterator](); }
  keys() { return Array.from(this._h.values(), ([name]) => name)[Symbol.iterator](); }
  values() { return Array.from(this._h.values(), ([, value]) => value)[Symbol.iterator](); }
  forEach(callback, thisArg = undefined) {
    if (typeof callback !== 'function') throw new TypeError('Headers.forEach callback must be callable');
    for (const [name, value] of this._h.values()) callback.call(thisArg, value, name, this);
  }
  [Symbol.iterator]() { return this.entries(); }
  toJSON() { return Object.fromEntries(Array.from(this._h.values())); }
}

class RequestShim {
  constructor(input, init = {}) {
    this.url = input instanceof RequestShim ? input.url : String(input?.url || input);
    this.method = String(init.method || input?.method || 'GET').toUpperCase();
    this.headers = new HeadersShim(init.headers || input?.headers || {});
    this.mode = init.mode || input?.mode || 'cors';
    this.credentials = init.credentials || input?.credentials || 'same-origin';
  }
  clone() { return new RequestShim(this, this); }
  get [Symbol.toStringTag]() { return 'Request'; }
}

class ResponseShim {
  constructor(body = '', init = {}) {
    this._bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body ?? ''), 'utf8');
    this._body = this._bytes.toString('utf8');
    this.status = Number.isFinite(Number(init.status)) ? Number(init.status) : 200;
    this.statusText = init.statusText || 'OK';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new HeadersShim(init.headers || {});
    this.url = init.url || '';
    this.type = String(init.type || 'basic');
    this.redirected = !!init.redirected;
    this.bodyUsed = false;
  }
  _consume() { if (this.bodyUsed) return false; this.bodyUsed = true; return true; }
  text() { if (!this._consume()) return Promise.reject(new TypeError('Response body is already used')); return Promise.resolve(this._body); }
  json() { if (!this._consume()) return Promise.reject(new TypeError('Response body is already used')); return Promise.resolve(JSON.parse(this._body)); }
  arrayBuffer() { if (!this._consume()) return Promise.reject(new TypeError('Response body is already used')); return Promise.resolve(this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength)); }
  blob() { if (!this._consume()) return Promise.reject(new TypeError('Response body is already used')); return Promise.resolve(new BlobShim([this._bytes], { type: this.headers.get('content-type') || '' })); }
  clone() {
    if (this.bodyUsed) throw new TypeError('Response body is already used');
    return new ResponseShim(this._bytes, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, type: this.type, redirected: this.redirected });
  }
}

class CanvasGradientShim {
  constructor() { this.stops = []; }
  addColorStop(offset, color) { this.stops.push([Number(offset), String(color)]); }
  get [Symbol.toStringTag]() { return 'CanvasGradient'; }
}

class TextMetricsShim {
  constructor(width, observed = {}) {
    Object.assign(this, {
      width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
      fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4,
      actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3,
      emHeightAscent: 14, emHeightDescent: 4,
      hangingBaseline: 11.2, alphabeticBaseline: 0, ideographicBaseline: -4,
    }, observed);
  }
  get [Symbol.toStringTag]() { return 'TextMetrics'; }
}

class ImageDataShim {
  constructor(data, width, height) { this.data = data; this.width = Number(width); this.height = Number(height); }
  get [Symbol.toStringTag]() { return 'ImageData'; }
}

class OffscreenCanvasRenderingContext2DShim {
  constructor(canvas) {
    this.canvas = canvas;
    this.filter = 'none'; this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.font = '10px sans-serif'; this.globalCompositeOperation = 'source-over';
    this.shadowBlur = 0; this.shadowColor = 'rgba(0, 0, 0, 0)'; this.lineWidth = 1;
    this.__ops = [];
  }
  __record(name, args) { this.__ops.push([name, ...Array.from(args)]); }
  save() { this.__record('save', arguments); } restore() { this.__record('restore', arguments); }
  scale() { this.__record('scale', arguments); } rotate() { this.__record('rotate', arguments); }
  translate() { this.__record('translate', arguments); } transform() { this.__record('transform', arguments); }
  setTransform() { this.__record('setTransform', arguments); } resetTransform() { this.__record('resetTransform', arguments); }
  beginPath() { this.__record('beginPath', arguments); } closePath() { this.__record('closePath', arguments); }
  moveTo() { this.__record('moveTo', arguments); } lineTo() { this.__record('lineTo', arguments); }
  bezierCurveTo() { this.__record('bezierCurveTo', arguments); } quadraticCurveTo() { this.__record('quadraticCurveTo', arguments); }
  arc() { this.__record('arc', arguments); } arcTo() { this.__record('arcTo', arguments); }
  ellipse() { this.__record('ellipse', arguments); } rect() { this.__record('rect', arguments); }
  fill() { this.__record('fill', arguments); } stroke() { this.__record('stroke', arguments); }
  clip() { this.__record('clip', arguments); } fillRect() { this.__record('fillRect', arguments); }
  strokeRect() { this.__record('strokeRect', arguments); } clearRect() { this.__record('clearRect', arguments); }
  fillText() { this.__record('fillText', arguments); } strokeText() { this.__record('strokeText', arguments); }
  drawImage() { this.__record('drawImage', arguments); } putImageData() { this.__record('putImageData', arguments); }
  createLinearGradient() { this.__record('createLinearGradient', arguments); return new CanvasGradientShim(); }
  createRadialGradient() { this.__record('createRadialGradient', arguments); return new CanvasGradientShim(); }
  createConicGradient() { this.__record('createConicGradient', arguments); return new CanvasGradientShim(); }
  measureText(text) {
    const observed = this.__environmentProfile?.knownTextMetrics?.[`${this.font}\u0000${String(text)}`];
    if (observed) return new TextMetricsShim(observed.width, observed);
    const px = Number.parseFloat(this.font) || 10;
    return new TextMetricsShim(Math.round(String(text).length * px * 0.61 * 1e6) / 1e6);
  }
  getImageData(x = 0, y = 0, width = 1, height = 1) {
    width = Math.max(1, Math.trunc(Number(width) || 1));
    height = Math.max(1, Math.trunc(Number(height) || 1));
    const data = new Uint8ClampedArray(width * height * 4);
    if (this.__environmentProfile?.blankImageDataIsZero && this.__ops.length === 0) {
      return new ImageDataShim(data, width, height);
    }
    const seed = Buffer.from(sha256Bytes(JSON.stringify({ width, height, ops: this.__ops, fillStyle: String(this.fillStyle), font: this.font })), 'hex');
    for (let i = 0; i < data.length; i++) data[i] = seed[i % seed.length];
    return new ImageDataShim(data, width, height);
  }
  createImageData(width = 1, height = 1) {
    width = Math.max(1, Math.trunc(Number(width) || 1));
    height = Math.max(1, Math.trunc(Number(height) || 1));
    return new ImageDataShim(new Uint8ClampedArray(width * height * 4), width, height);
  }
  get [Symbol.toStringTag]() { return 'OffscreenCanvasRenderingContext2D'; }
}

const CanvasRenderingContext2DShim = class CanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.filter = 'none'; this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.font = '10px sans-serif'; this.globalCompositeOperation = 'source-over';
    this.shadowBlur = 0; this.shadowColor = 'rgba(0, 0, 0, 0)'; this.lineWidth = 1;
    this.__ops = [];
  }
  get [Symbol.toStringTag]() { return 'CanvasRenderingContext2D'; }
};
for (const name of Object.getOwnPropertyNames(OffscreenCanvasRenderingContext2DShim.prototype)) {
  if (name === 'constructor') continue;
  if (name === Symbol.toStringTag) continue;
  if (Object.prototype.hasOwnProperty.call(CanvasRenderingContext2DShim.prototype, name)) continue;
  Object.defineProperty(CanvasRenderingContext2DShim.prototype, name, Object.getOwnPropertyDescriptor(OffscreenCanvasRenderingContext2DShim.prototype, name));
}

class WebGLShaderShim {
  get [Symbol.toStringTag]() { return 'WebGLShader'; }
}
class WebGLBufferShim {
  get [Symbol.toStringTag]() { return 'WebGLBuffer'; }
}
class WebGLProgramShim {
  get [Symbol.toStringTag]() { return 'WebGLProgram'; }
}
class WebGLFramebufferShim {
  get [Symbol.toStringTag]() { return 'WebGLFramebuffer'; }
}
class WebGLRenderbufferShim {
  get [Symbol.toStringTag]() { return 'WebGLRenderbuffer'; }
}
class WebGLShaderPrecisionFormatShim {
  constructor() { this.rangeMin = 24; this.rangeMax = 24; this.precision = 0; }
  get [Symbol.toStringTag]() { return 'WebGLShaderPrecisionFormat'; }
}

class WebGLRenderingContextShim {
  constructor() {
    this.drawingBufferColorSpace = 'srgb';
    this.unpackColorSpace = 'srgb';
    this._shaderSources = new WeakMap();
    this._shaderCompiled = new WeakMap();
    this._programLinked = new WeakMap();
  }
  getSupportedExtensions() {
    return [
      'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_depth_clamp',
      'EXT_float_blend', 'EXT_frag_depth', 'EXT_shader_texture_lod', 'EXT_sRGB',
      'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 'OES_element_index_uint',
      'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float',
      'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear',
      'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders',
      'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_provoking_vertex',
    ];
  }
  getExtension(name) {
    const supported = new Set(this.getSupportedExtensions());
    return supported.has(String(name)) ? Object.create(null) : null;
  }
  getContextAttributes() {
    return {
      alpha: true, antialias: true, depth: true, failIfMajorPerformanceCaveat: false,
      powerPreference: 'default', premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false,
    };
  }
  getShaderPrecisionFormat() { return new WebGLShaderPrecisionFormatShim(); }
  getParameter(parameter) {
    const values = {
      7936: 'Mozilla', 7937: 'Apple M1, or similar', 7938: 'WebGL 1.0', 35724: 'WebGL GLSL ES 1.0',
      37445: 'Apple', 37446: 'Apple M1, or similar', 3379: 8192, 34024: 8192,
      34921: 16, 36348: 32, 36349: 1024, 36347: 1024, 34047: 16, 35723: 4352,
      35661: 80, 35660: 16, 34930: 16, 34076: 8192, 3408: 4, 3410: 8, 3411: 8,
      3412: 8, 3413: 8, 3414: 24, 3415: 0, 32936: 1, 32937: 4,
      2963: 4294967295, 2968: 4294967295, 36004: 4294967295, 36005: 4294967295,
    };
    if (parameter === 3386) return new Int32Array([16384, 16384]);
    if (parameter === 34467) return new Uint32Array([5121, 5123, 5125]);
    if (parameter === 33901) return new Float32Array([1, 1]);
    if (parameter === 33902) return new Float32Array([1, 1]);
    return Object.prototype.hasOwnProperty.call(values, parameter) ? values[parameter] : 0;
  }
  createShader() { const shader = new WebGLShaderShim(); this._shaderCompiled.set(shader, true); return shader; }
  shaderSource(shader, source) { if (shader) this._shaderSources.set(shader, String(source)); }
  compileShader(shader) { if (shader) this._shaderCompiled.set(shader, true); }
  getShaderParameter(shader, parameter) { return parameter === 35713 ? this._shaderCompiled.get(shader) !== false : true; }
  deleteShader() {}
  createProgram() { const program = new WebGLProgramShim(); this._programLinked.set(program, true); return program; }
  attachShader() {}
  linkProgram(program) { if (program) this._programLinked.set(program, true); }
  getProgramParameter(program, parameter) { return parameter === 35714 ? this._programLinked.get(program) !== false : true; }
  deleteProgram() {}
  useProgram() {}
  getAttribLocation() { return 0; }
  createBuffer() { return new WebGLBufferShim(); }
  bindBuffer() {}
  bufferData() {}
  deleteBuffer() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  viewport() {}
  drawArrays() {}
  readPixels(x, y, width, height, format, type, pixels) { if (pixels && typeof pixels.fill === 'function') pixels.fill(0); }
}

class WebGL2RenderingContextShim extends WebGLRenderingContextShim {
  getExtension(name) {
    if (String(name) === 'EXT_color_buffer_half_float') return null;
    if (String(name) === 'EXT_color_buffer_float' || String(name) === 'WEBGL_lose_context') return Object.create(null);
    return super.getExtension(name);
  }
  getParameter(parameter) {
    const values = {
      7938: 'WebGL 2.0', 35724: 'WebGL GLSL ES 3.00', 35739: 6408, 35738: 5121,
      32883: 2048, 33000: 1048575, 33001: 150000, 34045: 16, 34852: 8,
      35657: 4096, 35658: 4096, 35071: 2048, 35077: 7, 35659: 124, 35968: 4,
      35978: 64, 35979: 4, 36063: 8, 36183: 4, 35371: 16, 35373: 16,
      35374: 80, 35375: 80, 35376: 65536, 35377: 266240, 35379: 266240,
      37154: 64, 37157: 128, 37137: 1.8446744073709552e19, 36203: 4294967295,
      35380: 256, 35076: -8, 37447: 1000000000,
    };
    return Object.prototype.hasOwnProperty.call(values, parameter) ? values[parameter] : super.getParameter(parameter);
  }
  createFramebuffer() { return new WebGLFramebufferShim(); }
  deleteFramebuffer() {}
  bindFramebuffer() {}
  createRenderbuffer() { return new WebGLRenderbufferShim(); }
  deleteRenderbuffer() {}
  bindRenderbuffer() {}
  framebufferRenderbuffer() {}
  renderbufferStorage() {}
  checkFramebufferStatus() { return 36053; }
  getInternalformatParameter() { return new Int32Array([4, 2, 1]); }
  get [Symbol.toStringTag]() { return 'WebGL2RenderingContext'; }
}

const performanceEntryState = new WeakMap();

class PerformanceEntryShim {
  constructor(init) { performanceEntryState.set(this, { ...init }); }
  get name() { return performanceEntryState.get(this).name; }
  get entryType() { return performanceEntryState.get(this).entryType; }
  get startTime() { return performanceEntryState.get(this).startTime; }
  get duration() { return performanceEntryState.get(this).duration; }
  toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }
  get [Symbol.toStringTag]() { return 'PerformanceEntry'; }
}

class PerformanceResourceTimingShim extends PerformanceEntryShim {
  constructor(init) {
    super({
      entryType: 'resource', initiatorType: 'other', nextHopProtocol: 'h2',
      workerStart: 0, redirectStart: 0, redirectEnd: 0,
      domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0,
      connectEnd: 0, secureConnectionStart: 0, fetchStart: init.startTime || 0,
      decodedBodySize: init.encodedBodySize || 0, responseStatus: 200,
      contentType: '', serverTiming: [], ...init,
    });
  }
  get initiatorType() { return performanceEntryState.get(this).initiatorType; }
  get nextHopProtocol() { return performanceEntryState.get(this).nextHopProtocol; }
  get workerStart() { return performanceEntryState.get(this).workerStart; }
  get redirectStart() { return performanceEntryState.get(this).redirectStart; }
  get redirectEnd() { return performanceEntryState.get(this).redirectEnd; }
  get fetchStart() { return performanceEntryState.get(this).fetchStart; }
  get domainLookupStart() { return performanceEntryState.get(this).domainLookupStart; }
  get domainLookupEnd() { return performanceEntryState.get(this).domainLookupEnd; }
  get connectStart() { return performanceEntryState.get(this).connectStart; }
  get secureConnectionStart() { return performanceEntryState.get(this).secureConnectionStart; }
  get connectEnd() { return performanceEntryState.get(this).connectEnd; }
  get requestStart() { return performanceEntryState.get(this).requestStart; }
  get responseStart() { return performanceEntryState.get(this).responseStart; }
  get responseEnd() { return performanceEntryState.get(this).responseEnd; }
  get transferSize() { return performanceEntryState.get(this).transferSize; }
  get encodedBodySize() { return performanceEntryState.get(this).encodedBodySize; }
  get decodedBodySize() { return performanceEntryState.get(this).decodedBodySize; }
  get responseStatus() { return performanceEntryState.get(this).responseStatus; }
  get contentType() { return performanceEntryState.get(this).contentType; }
  get serverTiming() { return performanceEntryState.get(this).serverTiming; }
  toJSON() {
    return {
      ...super.toJSON(), initiatorType: this.initiatorType, nextHopProtocol: this.nextHopProtocol,
      workerStart: this.workerStart, redirectStart: this.redirectStart, redirectEnd: this.redirectEnd,
      fetchStart: this.fetchStart, domainLookupStart: this.domainLookupStart, domainLookupEnd: this.domainLookupEnd,
      connectStart: this.connectStart, secureConnectionStart: this.secureConnectionStart, connectEnd: this.connectEnd,
      requestStart: this.requestStart, responseStart: this.responseStart, responseEnd: this.responseEnd,
      transferSize: this.transferSize, encodedBodySize: this.encodedBodySize, decodedBodySize: this.decodedBodySize,
      responseStatus: this.responseStatus, contentType: this.contentType, serverTiming: this.serverTiming,
    };
  }
  get [Symbol.toStringTag]() { return 'PerformanceResourceTiming'; }
}

class PerformanceNavigationTimingShim extends PerformanceResourceTimingShim {
  constructor(init) {
    super({ initiatorType: 'navigation', ...init, entryType: 'navigation' });
    Object.assign(performanceEntryState.get(this), { type: init.type || 'navigate', redirectCount: init.redirectCount || 0 });
  }
  get type() { return performanceEntryState.get(this).type; }
  get redirectCount() { return performanceEntryState.get(this).redirectCount; }
  toJSON() { return { ...super.toJSON(), type: this.type, redirectCount: this.redirectCount }; }
  get [Symbol.toStringTag]() { return 'PerformanceNavigationTiming'; }
}

class PerformanceObserverEntryListShim {
  constructor(entries) { this.entries = entries.slice(); }
  getEntries() { return this.entries.slice(); }
  getEntriesByType(type) { return this.entries.filter((entry) => entry.entryType === String(type)); }
  getEntriesByName(name, type) {
    return this.entries.filter((entry) => entry.name === String(name) && (type === undefined || entry.entryType === String(type)));
  }
  get [Symbol.toStringTag]() { return 'PerformanceObserverEntryList'; }
}

// Script-visible clock dilation. The challenge scripts enforce an execution
// time budget ("overrunBegin" then a downgrade to the /eb/ error-report flow
// instead of the second /fo/ submission) when milestones take too long. The
// Node VM plus bridge round trips are far slower than a real browser, so all
// realms share this one dilated clock: virtual = anchor + realDelta * scale.
const virtualTime = { scale: 1, anchorRealMs: 0, anchorDateMs: 0 };

function virtualNowMs() {
  if (!(virtualTime.scale < 1)) return Date.now();
  return virtualTime.anchorDateMs + (Date.now() - virtualTime.anchorRealMs) * virtualTime.scale;
}

const performanceState = new WeakMap();

class PerformanceShim extends EventTargetShim {
  constructor(entries, timeOrigin = virtualNowMs(), elapsedMs = 0) {
    super();
    const elapsedNs = BigInt(Math.round(Math.max(0, Number(elapsedMs) || 0) * 1e6));
    performanceState.set(this, { entries: entries.slice(), observers: new Set(), timeOrigin: virtualNowMs() - Number(elapsedMs || 0), start: process.hrtime.bigint() - elapsedNs, leadMs: Math.max(0, Number(elapsedMs) || 0) });
  }
  now() {
    const state = performanceState.get(this);
    const raw = (Number(process.hrtime.bigint() - state.start) / 1e6);
    const advance = Math.max(0, raw - state.leadMs);
    return Math.floor((state.leadMs + advance * virtualTime.scale) * 50) / 50;
  }
  toJSON() { return { timeOrigin: this.timeOrigin }; }
  getEntries() { return performanceState.get(this).entries.slice(); }
  getEntriesByType(type) { return performanceState.get(this).entries.filter(entry => entry.entryType === String(type)); }
  getEntriesByName(name, type) { return performanceState.get(this).entries.filter(entry => entry.name === String(name) && (type === undefined || entry.entryType === String(type))); }
  clearResourceTimings() {
    const state = performanceState.get(this);
    state.entries = state.entries.filter(entry => entry.entryType !== 'resource');
  }
  setResourceTimingBufferSize() {}
  mark() {}
  clearMarks() {}
  measure() {}
  clearMeasures() {}
  get timeOrigin() { return performanceState.get(this).timeOrigin; }
  get [Symbol.toStringTag]() { return 'Performance'; }
}

function appendPerformanceEntry(performance, entry) {
  const state = performanceState.get(performance);
  if (!state) return;
  state.entries.push(entry);
  for (const observer of state.observers) observer.enqueue(entry);
}

function updateNavigationTiming(performance, values) {
  const state = performanceState.get(performance);
  const navigation = state?.entries.find(entry => entry.entryType === 'navigation');
  if (navigation) Object.assign(performanceEntryState.get(navigation), values);
}

function makePerformanceObserverClass(performance) {
  return class PerformanceObserver {
    constructor(callback) { this.cb = callback; this.records = []; this.entryTypes = []; this.disconnected = false; }
    observe(options = {}) {
      if (this.disconnected || typeof this.cb !== 'function') return;
      this.entryTypes = (options.entryTypes || (options.type ? [options.type] : [])).map(String);
      const state = performanceState.get(performance);
      state.observers.add(this);
      // Firefox does not replay existing entries for entryTypes. Buffered delivery
      // is opt-in and only applies to the explicitly requested entry type.
      if (options.buffered && options.type) {
        for (const entry of state.entries) this.enqueue(entry);
      }
    }
    enqueue(entry) {
      if (this.disconnected || (this.entryTypes.length && !this.entryTypes.includes(entry.entryType))) return;
      this.records.push(entry);
      setTimeout(() => {
        if (this.disconnected || !this.records.length) return;
        const records = this.records.splice(0);
        this.cb(new PerformanceObserverEntryListShim(records), this);
      }, 0);
    }
    disconnect() { this.disconnected = true; this.records.length = 0; performanceState.get(performance).observers.delete(this); }
    takeRecords() { return this.records.splice(0); }
    static get supportedEntryTypes() { return ['event', 'first-input', 'largest-contentful-paint', 'mark', 'measure', 'navigation', 'paint', 'resource']; }
  };
}

for (const name of Object.getOwnPropertyNames(PerformanceShim.prototype)) {
  if (name === 'constructor') continue;
  const descriptor = Object.getOwnPropertyDescriptor(PerformanceShim.prototype, name);
  Object.defineProperty(PerformanceShim.prototype, name, { ...descriptor, enumerable: true });
}

const gpuState = new WeakMap();

class GPUAdapterInfoShim {
  constructor(values) { gpuState.set(this, values); }
  get vendor() { return gpuState.get(this).vendor; }
  get architecture() { return gpuState.get(this).architecture; }
  get device() { return gpuState.get(this).device; }
  get description() { return gpuState.get(this).description; }
  get subgroupMinSize() { return gpuState.get(this).subgroupMinSize; }
  get subgroupMaxSize() { return gpuState.get(this).subgroupMaxSize; }
  get isFallbackAdapter() { return gpuState.get(this).isFallbackAdapter; }
  get [Symbol.toStringTag]() { return 'GPUAdapterInfo'; }
}

class GPUSupportedFeaturesShim {
  constructor(values) { gpuState.set(this, new Set(values)); }
  get size() { return gpuState.get(this).size; }
  has(value) { return gpuState.get(this).has(String(value)); }
  entries() { return gpuState.get(this).entries(); }
  keys() { return gpuState.get(this).keys(); }
  values() { return gpuState.get(this).values(); }
  forEach(callback, thisArg) { return gpuState.get(this).forEach(value => callback.call(thisArg, value, value, this)); }
  [Symbol.iterator]() { return this.values(); }
  get [Symbol.toStringTag]() { return 'GPUSupportedFeatures'; }
}

class GPUSupportedLimitsShim {
  constructor(values) { gpuState.set(this, values); }
  get [Symbol.toStringTag]() { return 'GPUSupportedLimits'; }
}

const gpuLimitNames = [
  'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
  'maxTextureArrayLayers', 'maxBindGroups', 'maxBindGroupsPlusVertexBuffers',
  'maxBindingsPerBindGroup', 'maxDynamicUniformBuffersPerPipelineLayout',
  'maxDynamicStorageBuffersPerPipelineLayout', 'maxSampledTexturesPerShaderStage',
  'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize',
  'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
  'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes',
  'maxVertexBufferArrayStride', 'maxInterStageShaderVariables',
  'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension',
];
for (const name of gpuLimitNames) {
  Object.defineProperty(GPUSupportedLimitsShim.prototype, name, {
    configurable: true, enumerable: true,
    get() { return gpuState.get(this)[name]; },
  });
}

class GPUAdapterShim {
  constructor({ info, features, limits }) { gpuState.set(this, { info, features, limits }); }
  requestDevice() { return Promise.resolve({ limits: this.limits, features: this.features, queue: {} }); }
  get features() { return gpuState.get(this).features; }
  get limits() { return gpuState.get(this).limits; }
  get info() { return gpuState.get(this).info; }
  get [Symbol.toStringTag]() { return 'GPUAdapter'; }
}

class GPUShim {
  constructor(adapter) { gpuState.set(this, { adapter, wgslLanguageFeatures: new Set() }); }
  requestAdapter() { return Promise.resolve(gpuState.get(this).adapter); }
  getPreferredCanvasFormat() { return 'bgra8unorm'; }
  get wgslLanguageFeatures() { return gpuState.get(this).wgslLanguageFeatures; }
  get [Symbol.toStringTag]() { return 'GPU'; }
}

for (const prototype of [GPUAdapterInfoShim.prototype, GPUSupportedFeaturesShim.prototype, GPUAdapterShim.prototype, GPUShim.prototype]) {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    Object.defineProperty(prototype, name, { ...descriptor, enumerable: true });
  }
}
for (const [Ctor, name] of [
  [GPUAdapterInfoShim, 'GPUAdapterInfo'], [GPUSupportedFeaturesShim, 'GPUSupportedFeatures'],
  [GPUSupportedLimitsShim, 'GPUSupportedLimits'], [GPUAdapterShim, 'GPUAdapter'], [GPUShim, 'GPU'],
  [PerformanceShim, 'Performance'], [PerformanceEntryShim, 'PerformanceEntry'],
  [PerformanceResourceTimingShim, 'PerformanceResourceTiming'], [PerformanceNavigationTimingShim, 'PerformanceNavigationTiming'],
]) Object.defineProperty(Ctor, 'name', { value: name, configurable: true });

function NodeFilterShim() {
  throw new TypeError('Illegal constructor.');
}
for (const [name, value] of Object.entries({
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4,
  SHOW_CDATA_SECTION: 8, SHOW_ENTITY_REFERENCE: 16, SHOW_ENTITY: 32,
  SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128, SHOW_DOCUMENT: 256,
  SHOW_DOCUMENT_TYPE: 512, SHOW_DOCUMENT_FRAGMENT: 1024, SHOW_NOTATION: 2048,
})) {
  Object.defineProperty(NodeFilterShim, name, {
    value, writable: false, enumerable: true, configurable: false,
  });
}

class FirefoxLikeRuntime {
  constructor(vector, opts) {
    this.vector = vector;
    this.opts = opts;
    this.environmentProfilePath = path.resolve(opts.environmentProfile || DEFAULT_ENVIRONMENT_PROFILE);
    this.environmentProfile = readJson(this.environmentProfilePath);
    if (this.environmentProfile.schema !== 'firefox_trace.browser_environment_profile.v1') {
      throw new Error(`unsupported environment profile schema: ${this.environmentProfile.schema || 'missing'}`);
    }
    const transportUserAgent = String(process.env.CLOUDFLARE_USER_AGENT || '').trim();
    if (transportUserAgent) {
      this.environmentProfile.device = { ...(this.environmentProfile.device || {}), userAgent: transportUserAgent };
    }
    this.traceDir = vector.trace_dir;
    this.generatedRequests = [];
    this.navigationLog = [];
    this.formSubmitCalls = 0;
    this.scriptLoads = [];
    this.vmProbePatches = [];
    this.errors = [];
    this.timers = [];
    this.timerCallbackCount = 0;
    this.scenarioDeadline = 0;
    this.pendingAsync = new Set();
    this.randomLedger = [];
    this.timeLedger = [];
    this.virtualClockOffsetMs = 0;
    this.submitEndpointOverride = String(process.env.CLOUDFLARE_SUBMIT_ENDPOINT || '').trim().toLowerCase() || null;
    this.interactiveClickEnabled = String(process.env.CLOUDFLARE_AUTO_INTERACTIVE_CLICK || '') === '1';
    this.frameSubmitFoUrl = null;
    this.cfEpochSetCount = 0;
    this.virtualClockLedger = [];
    this.virtualTimeScale = Math.min(1, Math.max(0.005, Number(process.env.CLOUDFLARE_VIRTUAL_TIME_SCALE) || 1));
    this.virtualTimeAnchorRealMs = Date.now();
    this.virtualTimeAnchorDateMs = this.virtualTimeAnchorRealMs;
    virtualTime.scale = this.virtualTimeScale;
    virtualTime.anchorRealMs = this.virtualTimeAnchorRealMs;
    virtualTime.anchorDateMs = this.virtualTimeAnchorDateMs;
    if (this.virtualTimeScale < 1) {
      this.virtualClockLedger.push({ reason: 'dilation-enabled', scale: this.virtualTimeScale, anchor_real_ms: this.virtualTimeAnchorRealMs, offset_ms: 0 });
    }
    this.envFidelity = [];
    this.envFidelity.push({ api: 'browser-environment-profile', status: 'loaded', source: rel(this.environmentProfilePath), detail: { schema: this.environmentProfile.schema } });
    if (transportUserAgent) {
      this.envFidelity.push({ api: 'Navigator.userAgent', status: 'transport-aligned', source: 'CLOUDFLARE_USER_AGENT', detail: { value: transportUserAgent } });
    }
    this.scriptByUrl = new Map();
    this.scriptByName = new Map();
    this.executedScripts = new Set();
    this.frameContexts = new WeakMap();
    this.realmContexts = new WeakMap();
    this.blobUrlStore = new Map();
    this.blobSeq = 0;
    this.timerSeq = 0;
    this.recursiveTimerFns = new WeakSet();
    this.turnstileFrameScriptPath = path.join(__dirname, 'runtime-data/turnstile-frame-live.js');
    this.turnstileFrameScript = maybeRead(this.turnstileFrameScriptPath);
    this.liveBootstrap = opts.bootstrap ? readJson(path.resolve(opts.bootstrap)) : null;
    this.hadClearanceAtBootstrap = !!this.liveBootstrap?.cookies_after_initial?.some(cookie => cookie?.name === 'cf_clearance' && cookie?.value);
    for (const s of vector.scripts || []) {
      const item = {
        url: s.final_url || s.url,
        original_url: s.url,
        sha256: s.sha256,
        artifact_path: s.artifact_path,
        code: maybeRead(s.artifact_path),
      };
      this.scriptByUrl.set(item.url, item);
      this.scriptByUrl.set(item.original_url, item);
      if (item.url.includes('/orchestrate/')) this.scriptByName.set('orchestrate', item);
      else if (item.url.includes('/turnstile/') && item.url.includes('/api.js')) this.scriptByName.set('turnstile', item);
      else if (item.url.includes('/rocket-loader')) this.scriptByName.set('rocket', item);
      else if (item.url.includes('/scripts/jsd/') || item.original_url.includes('/scripts/jsd/')) this.scriptByName.set('jsd', item);
    }
    if (this.liveBootstrap?.orchestrate?.artifact_path) {
      const live = this.liveBootstrap.orchestrate;
      const item = {
        url: live.url,
        original_url: live.url,
        sha256: live.sha256,
        artifact_path: live.artifact_path,
        code: maybeRead(live.artifact_path),
      };
      if (!item.code) throw new Error(`live orchestrate artifact not found: ${live.artifact_path}`);
      if (sha256Bytes(item.code) !== live.sha256) throw new Error('live orchestrate artifact sha256 mismatch');
      this.scriptByUrl.set(item.url, item);
      this.scriptByName.set('orchestrate', item);
    }
    const targetLocation = vector.manifest?.target_url || 'https://simple.ripley.com.pe/';
    // cUPMDTk is challenge bootstrap data, not the active document URL.  The
    // headed page remains at the originally requested URL while the token is
    // passed through _cf_chl_opt and the generated challenge requests.
    this.location = new LocationShim(targetLocation);
    this.context = this.makeContext();
  }

  // Native async completions (WebAssembly.instantiate, WebAssembly.compile, crypto.subtle,
  // TextDecoder streams) resolve their promise on the HOST job queue. The receiving realm's
  // `.then` callbacks only run when that realm's microtask queue is pumped; microtaskMode
  // 'afterEvaluate' drains once at script end, before the native completion lands. Pumping a
  // no-op through the realm keeps those continuations alive for the script's lifetime.
  installRealmJobPump(context, label) {
    if (String(process.env.CLOUDFLARE_REALM_PUMP || '1') === '0') return;
    // In-flight evidence flush: timer-driven VM bursts run between event-loop ticks, so
    // this pump is the reliable point to persist the worker log while the scenario runs.
    const flushInFlight = () => {
      try {
        const log = this.context?.__workerLog;
        if (!log || !log.length) return;
        const dir = path.join(__dirname, 'runtime-data');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `inflight-worker-log-${process.pid}.json`),
          JSON.stringify(log.slice(-4000)));
      } catch {}
    };
    const flushTimer = setInterval(flushInFlight, 2000);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
    const pump = () => {
      try { vm.runInContext('void 0;', context, { timeout: 500 }); }
      catch { return; }
      if (this.scenarioDeadline && Date.now() >= this.scenarioDeadline) { clearInterval(flushTimer); return; }
      setTimeout(pump, 20);
    };
    pump();
    this.realmPumps = this.realmPumps || [];
    this.realmPumps.push({ label, stop: () => {} });
  }

  advanceVirtualClock(reason, bytes, throughputBytesPerMs) {
    const size = Math.max(0, Number(bytes) || 0);
    const rate = Math.max(1, Number(throughputBytesPerMs) || 1);
    const cost = Math.max(0, Math.round(size / rate));
    if (!cost) return;
    this.virtualClockOffsetMs += cost;
    this.virtualClockLedger.push({ reason, bytes: size, throughput_bytes_per_ms: rate, cost_ms: cost, offset_ms: this.virtualClockOffsetMs });
  }


  noteEnv(api, status, source, detail = {}) {
    this.envFidelity.push({ api, status, source, detail });
  }


  buildChallengeSeed() {
    if (this.liveBootstrap?.bootstrap) {
      this.noteEnv('_cf_chl_opt', 'firefox-bidi-document-start', this.opts.bootstrap, {
        reason: 'captured before the page challenge mutates or deletes the bootstrap object',
      });
      return structuredClone(this.liveBootstrap.bootstrap);
    }
    const first = (this.vector.xhr_vectors || []).find(v => v.url && v.url.includes('simple.ripley.com.pe/cdn-cgi/challenge-platform/') && v.headers && v.headers['cf-chl']);
    if (!first) return {};
    const u = new URL(first.url);
    const parts = u.pathname.split('/').filter(Boolean);
    const hIdx = parts.indexOf('h');
    const fpw = hIdx >= 0 ? parts[hIdx + 1] : 'g';
    const endpoint = hIdx >= 0 ? parts[hIdx + 2] : 'fo';
    const tuple = hIdx >= 0 ? parts[hIdx + 3] : '';
    const ray = hIdx >= 0 ? parts[hIdx + 4] : '';
    const cfChl = first.headers['cf-chl'];
    const tupleParts = tuple.split(':');
    const referer = this.vector.http_channels?.find(h => h.url && h.url.includes('/orchestrate/'))?.headers?.Referer || '';
    let chlTk = '';
    try { chlTk = new URL(referer).searchParams.get('__cf_chl_rt_tk') || new URL(referer).searchParams.get('__cf_chl_tk') || ''; } catch {}
    const cUPMDTk = chlTk ? `/?__cf_chl_tk=${chlTk}` : '/';
    const mdHint = this.vector.bootstrap_hints?.md?.value || '';
    if (mdHint) {
      this.noteEnv('_cf_chl_opt.md', 'trace-derived-value-artifact', this.vector.bootstrap_hints.md.source_artifact, {
        sha256: this.vector.bootstrap_hints.md.sha256,
        reason: 'restored into the original bootstrap slot; the orchestrate script maps it to its current randomized field',
      });
    }
    return {
      cvId: '3', cZone: u.hostname, cType: 'managed', cRay: ray, cHash: cfChl,
      cUPMDTk, cFPWv: fpw, STupN6: fpw,
      // The script reads cH for the final /fo path segment and cf-chl header.
      // The numeric tuple prefix remains part of fa; it is not the cH value.
      cH: cfChl, cITimeS: tupleParts[1] || String(Math.floor(Date.now()/1000)), cN: tupleParts[2] || '',
      cOgUHash: this.location.hash || '', cOgUQuery: '',
      cTplC: 0, cTplV: 5, cTplB: '0', fa: `/cdn-cgi/challenge-platform/h/${fpw}/${endpoint}/${tuple}/${ray}/${cfChl}`,
      cRq: { ru: this.location.href, ra: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0', rm: 'GET', d: '', t: tupleParts[1] || '', m: tupleParts[2] || '' },
      pp: { r: ray, t: Buffer.from(tupleParts[1] || '').toString('base64'), m: tupleParts[2] || '', e: null },
      md: mdHint,
      __trace_tuple: tuple, __trace_ray: ray, __trace_cf_chl: cfChl,
    };
  }

  makeNavigator({ worker = false } = {}) {
    const opfsRoot = new FileSystemDirectoryHandleShim('');
    const device = this.environmentProfile.device || {};
    const storageProfile = this.environmentProfile.storage || {};
    const plugins = this.makePluginArray();
    const mimeTypes = this.makeMimeTypeArray(plugins);
    const values = {
      userAgent: device.userAgent,
      appVersion: device.appVersion,
      platform: device.platform,
      vendor: device.vendor,
      product: device.product,
      productSub: device.productSub,
      language: device.language,
      languages: structuredClone(device.languages),
      cookieEnabled: true,
      onLine: true,
      maxTouchPoints: device.maxTouchPoints,
      hardwareConcurrency: device.hardwareConcurrency,
      webdriver: false,
      getGamepads: () => [],
      plugins,
      mimeTypes,
      permissions: { query: () => Promise.resolve({ state: 'prompt', onchange: null }) },
      storage: {
        estimate: () => Promise.resolve({ quota: storageProfile.quota, usage: storageProfile.usage }),
        getDirectory: () => {
          this.context?.__workerLog?.push({ op: 'storage.getDirectory', worker, realm: worker ? 'worker' : 'window' });
          return Promise.resolve(opfsRoot);
        },
      },
      locks: { request: (name, cb) => Promise.resolve(typeof cb === 'function' ? cb({ name, mode: 'exclusive' }) : undefined) },
      mediaDevices: new MediaDevicesShim(),
      mediaCapabilities: { decodingInfo: () => Promise.resolve({ supported: true, smooth: true, powerEfficient: true }) },
      gpu: this.makeGPU(), credentials: new CredentialsContainerShim(),
    };
    if (worker) {
      for (const key of ['cookieEnabled', 'maxTouchPoints', 'webdriver', 'getGamepads', 'plugins', 'mimeTypes', 'permissions', 'mediaDevices', 'mediaCapabilities']) delete values[key];
    }
    const NavigatorClass = worker ? class WorkerNavigator {} : class Navigator {};
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(NavigatorClass.prototype, key, {
        configurable: true,
        enumerable: true,
        get() { return value; },
      });
    }
    Object.defineProperty(NavigatorClass.prototype, Symbol.toStringTag, {
      configurable: true,
      value: worker ? 'WorkerNavigator' : 'Navigator',
    });
    return new NavigatorClass();
  }

  makePluginArray() {
    const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    const mime = {
      type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format',
    };
    const textMime = {
      type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format',
    };
    const makePlugin = (name) => {
      const plugin = Object.create(null);
      Object.defineProperties(plugin, {
        0: { value: mime, enumerable: true },
        1: { value: textMime, enumerable: true },
        length: { value: 2, enumerable: false },
        name: { value: name, enumerable: true },
        filename: { value: 'internal-pdf-viewer', enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
      });
      Object.defineProperties(plugin, {
        item: { value: (index) => plugin[index] || null, enumerable: false },
        namedItem: { value: (type) => [mime, textMime].find((entry) => entry.type === type) || null, enumerable: false },
      });
      Object.defineProperties(plugin, {
        'application/pdf': { value: mime, enumerable: false },
        'text/pdf': { value: textMime, enumerable: false },
      });
      return plugin;
    };
    const plugins = Object.create(null);
    names.forEach((name, index) => Object.defineProperty(plugins, index, {
      value: makePlugin(name), enumerable: true, configurable: false,
    }));
    Object.defineProperty(plugins, 'length', { value: names.length, enumerable: false });
    Object.defineProperties(plugins, {
      item: { value: (index) => plugins[index] || null, enumerable: false },
      namedItem: { value: (name) => names.map((_n, i) => plugins[i]).find((plugin) => plugin.name === name) || null, enumerable: false },
      refresh: { value: () => undefined, enumerable: false },
    });
    names.forEach((name, index) => Object.defineProperty(plugins, name, {
      value: plugins[index], enumerable: false, configurable: false,
    }));
    return plugins;
  }

  makeMimeTypeArray(plugins) {
    const mimeTypes = Object.create(null);
    const seen = new Set();
    const entries = [];
    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      for (const mime of [plugin[0], plugin[1]]) {
        if (seen.has(mime.type)) continue;
        seen.add(mime.type);
        mime.enabledPlugin = plugin;
        entries.push(mime);
      }
    }
    entries.forEach((mime, index) => Object.defineProperty(mimeTypes, index, { value: mime, enumerable: true }));
    Object.defineProperty(mimeTypes, 'length', { value: entries.length, enumerable: false });
    Object.defineProperties(mimeTypes, {
      item: { value: (index) => mimeTypes[index] || null, enumerable: false },
      namedItem: { value: (type) => entries.find((mime) => mime.type === type) || null, enumerable: false },
    });
    for (const mime of entries) Object.defineProperty(mimeTypes, mime.type, { value: mime, enumerable: false });
    return mimeTypes;
  }

  makeGPU() {
    const limits = {
      maxTextureDimension1D: 16384, maxTextureDimension2D: 16384, maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 2048, maxBindGroups: 8, maxBindingsPerBindGroup: 65535,
      maxDynamicUniformBuffersPerPipelineLayout: 8, maxDynamicStorageBuffersPerPipelineLayout: 4,
      maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16,
      maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4,
      maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 134217728, minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256, maxVertexBuffers: 8, maxBufferSize: 1073741824,
      maxVertexAttributes: 16, maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 16,
      maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
      maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 1024,
      maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64,
      maxComputeWorkgroupsPerDimension: 65535,
    };
    const features = new GPUSupportedFeaturesShim([
      'depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc',
      'texture-compression-bc-sliced-3d', 'texture-compression-etc2',
      'texture-compression-astc', 'texture-compression-astc-sliced-3d',
      'timestamp-query', 'indirect-first-instance', 'shader-f16',
      'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable',
      'core-features-and-limits',
    ]);
    const supportedLimits = new GPUSupportedLimitsShim({ maxBindGroupsPlusVertexBuffers: 24, ...limits });
    const info = new GPUAdapterInfoShim({
      vendor: '', architecture: '', device: '', description: '',
      subgroupMinSize: 4, subgroupMaxSize: 128, isFallbackAdapter: false,
    });
    return new GPUShim(new GPUAdapterShim({ info, limits: supportedLimits, features }));
  }

  makePerformance({ kind = 'main', url = this.location.href } = {}) {
    const timeOrigin = Date.now();
    if (kind === 'worker') return new PerformanceShim([], timeOrigin);
    if (kind === 'frame') {
      return new PerformanceShim([new PerformanceNavigationTimingShim({
        name: url, startTime: 0, duration: 0,
        requestStart: 0, responseStart: 0, responseEnd: 0,
        transferSize: 0, encodedBodySize: 0, decodedBodySize: 0,
      })], timeOrigin, this.opts.navigationElapsedMs);
    }
    const navigation = new PerformanceNavigationTimingShim({
      name: url, startTime: 0, duration: 0,
      requestStart: 0, responseStart: 0, responseEnd: 0,
      transferSize: 0, encodedBodySize: 0, decodedBodySize: 0,
    });
    // Resource timing is populated only by resources actually loaded by the
    // current replay. Do not seed it with values from a previous browser run.
    const entries = [navigation];
    return new PerformanceShim(entries, timeOrigin, kind === 'main' ? this.opts.navigationElapsedMs : 0);
  }

  makeCanvasContext(kind, canvas = null) {
    const requested = String(kind).toLowerCase();
    const mode = requested === '2d' ? '2d' : requested === 'webgl2' ? 'webgl2' : requested.includes('webgl') ? 'webgl' : null;
    if (!mode) return null;
    let state = canvasContextState.get(canvas);
    if (!state) {
      state = { mode: null, context: null };
      canvasContextState.set(canvas, state);
    }
    if (state.mode && state.mode !== mode) return null;
    if (state.context) return state.context;
    state.mode = mode;
    state.context = mode === 'webgl2'
      ? new WebGL2RenderingContextShim()
      : mode === 'webgl'
        ? new WebGLRenderingContextShim()
        : canvas instanceof HTMLCanvasElementShim
          ? new CanvasRenderingContext2DShim(canvas)
          : new OffscreenCanvasRenderingContext2DShim(canvas);
    if (mode === '2d') state.context.__environmentProfile = this.environmentProfile.canvas2d || {};
    return state.context;
  }

  makeIframeWindow(node) {
    class FrameWindow extends WindowShim {}
    class FrameHTMLDocument extends DocumentShim {
      get [Symbol.toStringTag]() { return 'HTMLDocument'; }
    }
    Object.defineProperty(FrameWindow, 'name', { value: 'Window', configurable: true });
    Object.defineProperty(FrameHTMLDocument, 'name', { value: 'HTMLDocument', configurable: true });
    const ownerDocument = node.ownerDocument || this.context.document;
    const ownerState = documentState.get(ownerDocument);
    const ownerLocation = ownerState?.location || this.location;
    const ownerWindow = this.realmContexts.get(ownerDocument)?.global
      || ownerState?.defaultView
      || this.context;
    const rawFrameUrl = node.src || node.getAttribute('src') || '';
    // about:blank/srcdoc inherit the embedding document's origin and use its
    // URL as the relative-URL base.  Using the top-level page here made nested
    // Turnstile probe frames look like simple.ripley.com.pe frames even though
    // their owner document belongs to challenges.cloudflare.com.
    const frameUrl = (() => {
      try {
        if (!rawFrameUrl || rawFrameUrl === 'about:blank' || rawFrameUrl === 'about:srcdoc') {
          return new URL(ownerLocation.href);
        }
        return new URL(rawFrameUrl, ownerLocation.href);
      } catch {
        return new URL(ownerLocation.href);
      }
    })();
    let document;
    const onNodeInserted = inserted => {
      if ((inserted.localName || '').toLowerCase() === 'iframe') {
        // The captured Turnstile frame creates same-origin srcdoc iframes and
        // waits for their load event before continuing its environment probes.
        // Preserve the browser lifecycle rather than leaving a detached node.
        const childWindow = inserted.contentWindow;
        const childDocument = inserted.contentDocument;
        if (childWindow && childDocument) {
          setDocumentField(childDocument, 'readyState', 'loading');
          setTimeout(() => {
            setDocumentField(childDocument, 'readyState', 'complete');
            childDocument.dispatchEvent({ type: 'DOMContentLoaded', isTrusted: true });
            childWindow.dispatchEvent({ type: 'load', isTrusted: true });
            inserted.dispatchEvent({ type: 'load', isTrusted: true });
          }, 0);
        }
      }
      // The interactive stage inserts its checkbox after announcing interactiveBegin.
      // Once the checkbox input exists, deliver the trusted pointer sequence to it.
      if ((inserted.localName || '').toLowerCase() === 'input' && this.interactiveClickEnabled === true) {
        const clickTarget = inserted;
        setTimeout(() => {
          try {
            const rect = typeof clickTarget.getBoundingClientRect === 'function' ? clickTarget.getBoundingClientRect() : null;
            const x = rect ? rect.x + rect.width / 2 : 24;
            const y = rect ? rect.y + rect.height / 2 : 32;
            const common = { bubbles: true, cancelable: true, composed: true, isTrusted: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: 1 };
            const chain = [clickTarget];
            const label = clickTarget.closest ? clickTarget.closest('label') : null;
            if (label) chain.push(label);
            for (const el of chain) {
              for (const type of ['pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                const Ctor = /pointer/.test(type) ? this.context.PointerEvent || this.context.MouseEvent : this.context.MouseEvent;
                el.dispatchEvent(new Ctor(type, common));
              }
            }
            if (typeof clickTarget.click === 'function') { try { clickTarget.click(); } catch {} }
            this.context.__workerLog.push({ op: 'frame.interactive-click', target: 'input.checkbox', x, y });
          } catch (error) {
            this.context.__workerLog.push({ op: 'frame.interactive-click-error', message: String(error?.message || error) });
          }
        }, 60);
      }
    };
    document = new FrameHTMLDocument(this, {
      location: frameUrl,
      referrer: ownerLocation.href,
      readyState: 'loading',
      isFrameDocument: true,
      frameElement: node,
      onNodeInserted,
      seed: false,
    });
    let frameGlobal = null;
    const parentProxy = {
      postMessage: (data, targetOrigin = '*') => {
        const clonedData = structuredClone(data);
        const message = this.messageSnapshot(clonedData);
        this.context.__workerLog.push({ op: 'frame.parent.postMessage', frame: frameUrl.href, targetOrigin, preview: this.previewValue(data), message });
        // The interactive stage renders the Turnstile checkbox inside the frame and waits for a
        // trusted pointer sequence on it. Deliver the same gesture into the frame realm once the
        // widget announces itself, matching the headed-browser interaction path.
        if (message && typeof message === 'object' && message.event === 'interactiveBegin') {
          try {
            const dEl = document.documentElement;
            this.context.__workerLog.push({
              op: 'frame.dom-state',
              docElementChildren: dEl ? dEl.childNodes.length : -1,
              headChildren: document.head ? document.head.childNodes.length : -1,
              bodyChildren: document.body ? document.body.childNodes.length : -1,
              outerHTMLLen: dEl && dEl.outerHTML !== undefined ? String(dEl.outerHTML).length : -1,
              outerHTMLHead: dEl ? String(dEl.outerHTML).slice(0, 200) : '',
            });
          } catch (err) {
            this.context.__workerLog.push({ op: 'frame.dom-state-error', message: String(err && err.message) });
          }
        }
        if (message && typeof message === 'object' && message.event === 'interactiveBegin' && this.interactiveClickEnabled === true) {
          setTimeout(() => {
            try {
              const target = document.querySelector('[type="checkbox"], .ctp-checkbox-label, #challenge-stage input, label');
              const host = target || document.body || document.documentElement;
              const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
              const x = rect ? rect.x + rect.width / 2 : 24;
              const y = rect ? rect.y + rect.height / 2 : 32;
              const common = { bubbles: true, cancelable: true, composed: true, isTrusted: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: 1 };
              const dispatchInto = el => {
                for (const type of ['pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                  const Ctor = /pointer/.test(type) ? this.context.PointerEvent || this.context.MouseEvent : this.context.MouseEvent;
                  el.dispatchEvent(new Ctor(type, common));
                }
              };
              dispatchInto(host);
              this.context.__workerLog.push({ op: 'frame.interactive-click', target: host.tagName, id: host.id || null, x, y });
            } catch (error) {
              this.context.__workerLog.push({ op: 'frame.interactive-click-error', message: String(error?.message || error) });
            }
          }, 120);
        }
        setTimeout(() => {
          const source = frameGlobal || iframeWindow;
          const parentWindow = ownerWindow;
          const requestCountBefore = this.generatedRequests.length;
          const frameMessageCountBefore = this.context.__workerLog.reduce(
            (count, item) => count + (item?.op === 'frame.parent.postMessage' ? 1 : 0), 0,
          );
          this.context.__workerLog.push({
            op: 'frame.parent.message.dispatch',
            frame: frameUrl.href,
            origin: frameUrl.origin,
            listener_count: EventTargetShim.listenerCount(parentWindow, 'message'),
            source_matches_content_window: source === node.contentWindow,
            message,
          });
          parentWindow.dispatchEvent({ type: 'message', data: clonedData, origin: frameUrl.origin, source, isTrusted: true });
          this.context.__workerLog.push({
            op: 'frame.parent.message.complete', frame: frameUrl.href,
            message, request_delta: this.generatedRequests.length - requestCountBefore,
            frame_message_delta: this.context.__workerLog.reduce(
              (count, item) => count + (item?.op === 'frame.parent.postMessage' ? 1 : 0), 0,
            ) - frameMessageCountBefore,
          });
        }, 0);
      },
      location: ownerLocation, Location: LocationShim,
      origin: ownerLocation.origin,
    };
    const iframeWindow = new FrameWindow();
    const framePerformance = this.makePerformance({ kind: 'frame', url: frameUrl.href });
    const frameCaches = new CacheStorageShim();
    const frameCookieStore = new CookieStoreShim(); frameCookieStore.__document = document;
    const frameCustomElements = new CustomElementRegistryShim();
    const frameScheduler = new SchedulerShim();
    const frameVisualViewport = new VisualViewportShim(300, 65);
    const frameBars = Object.fromEntries(['toolbar', 'statusbar', 'scrollbars', 'personalbar', 'menubar', 'locationbar'].map(name => [name, new BarPropShim(true)]));
    class FrameNotification extends EventTargetShim {
      static get permission() { return 'denied'; }
      get [Symbol.toStringTag]() { return 'Notification'; }
    }
    const NativeURL = URL;
    const FrameURLShim = function FrameURLShim(url, base) { return new NativeURL(url, base); };
    FrameURLShim.prototype = NativeURL.prototype;
    for (const key of Object.getOwnPropertyNames(NativeURL)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      try { Object.defineProperty(FrameURLShim, key, Object.getOwnPropertyDescriptor(NativeURL, key)); } catch {}
    }
    FrameURLShim.createObjectURL = blob => {
      const id = `blob:${frameUrl.origin}/${crypto.randomUUID ? crypto.randomUUID() : (++this.blobSeq).toString(16)}`;
      let code = '';
      try { code = blob && typeof blob.__buffer === 'function' ? blob.__buffer().toString('utf8') : String(blob ?? ''); } catch {}
      this.blobUrlStore.set(id, { blob, code, created_at: Date.now() });
      this.context.__workerLog.push({ op: 'createObjectURL', url: id, code_size: code.length, code_preview: code.slice(0, 1200) });
      return id;
    };
    FrameURLShim.revokeObjectURL = url => this.context.__workerLog.push({ op: 'revokeObjectURL', url: String(url) });
    const runtime = this;
    const frameProfile = this.environmentProfile.frame || {};
    class FrameWorkerShim extends WorkerShim {
      constructor(url, options = {}) {
        super(url, { ...options, __baseUrl: frameUrl.href, __ownerContext: frameContext });
      }
    }
    Object.defineProperty(FrameWorkerShim, 'name', { value: 'Worker', configurable: true });
    Object.assign(iframeWindow, {
      window: iframeWindow, self: iframeWindow, globalThis: iframeWindow, frames: iframeWindow,
      top: ownerDocument === this.context.document ? parentProxy : (ownerWindow.top || parentProxy),
      parent: parentProxy,
      document,
      navigator: this.makeNavigator(),
      clientInformation: null,
      location: frameUrl,
      origin: frameUrl.origin,
      frameElement: node,
      name: '',
      innerWidth: frameProfile.innerWidth, innerHeight: frameProfile.innerHeight,
      outerWidth: frameProfile.outerWidth, outerHeight: frameProfile.outerHeight,
      screenX: frameProfile.screenX, screenY: frameProfile.screenY,
      screenLeft: frameProfile.screenX, screenTop: frameProfile.screenY,
      mozInnerScreenX: 196, mozInnerScreenY: 421.5,
      scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, scrollMaxX: 0, scrollMaxY: 0,
      length: 0, closed: false, fullScreen: false, originAgentCluster: true, crossOriginIsolated: true,
      devicePixelRatio: (this.environmentProfile.device || {}).devicePixelRatio,
      screen: this.context.screen,
      history: { length: 1, state: null, pushState(){}, replaceState(){}, back(){}, forward(){}, go(){} },
      console,
      __runtimeWorkerLog: this.context.__workerLog,
      crypto: webcrypto,
      performance: framePerformance,
      localStorage: new StorageShim(), sessionStorage: new StorageShim(),
      indexedDB: new this.context.indexedDB.constructor(), caches: frameCaches, cookieStore: frameCookieStore,
      customElements: frameCustomElements, scheduler: frameScheduler, visualViewport: frameVisualViewport,
      ...frameBars, external: new this.context.external.constructor(), Notification: FrameNotification,
      isSecureContext: true,
      atob: this.context.atob, btoa: this.context.btoa,
      TextEncoder, TextDecoder, URL: FrameURLShim, URLSearchParams, Headers: HeadersShim, Response: ResponseShim,
      ReadableStream: this.context.ReadableStream,
      WritableStream: this.context.WritableStream,
      TransformStream: this.context.TransformStream,
      ByteLengthQueuingStrategy: this.context.ByteLengthQueuingStrategy,
      CountQueuingStrategy: this.context.CountQueuingStrategy,
      TextEncoderStream: this.context.TextEncoderStream,
      TextDecoderStream: this.context.TextDecoderStream,
      Blob: BlobShim, Request: RequestShim, FormData: global.FormData, AbortController: global.AbortController, DOMException: DOMExceptionShim,
      PublicKeyCredential: PublicKeyCredentialShim,
      CredentialsContainer: CredentialsContainerShim,
      structuredClone: global.structuredClone,
      createImageBitmap: (source) => Promise.resolve({ width: Number(source?.width) || 1, height: Number(source?.height) || 1, close() {} }),
      Event: this.context.Event, ProgressEvent: this.context.ProgressEvent, MessageEvent: this.context.MessageEvent,
      Node: NodeShim, CharacterData: CharacterDataShim, Text: TextShim,
      Element: ElementShim, HTMLElement: HTMLElementShim,
      HTMLScriptElement: HTMLScriptElementShim, HTMLIFrameElement: HTMLIFrameElementShim, HTMLImageElement: HTMLImageElementShim, HTMLCanvasElement: HTMLCanvasElementShim,
      HTMLDivElement: HTMLDivElementShim, HTMLBodyElement: HTMLBodyElementShim,
      HTMLHeadElement: HTMLHeadElementShim, HTMLHtmlElement: HTMLHtmlElementShim,
      HTMLInputElement: HTMLInputElementShim, HTMLFormElement: HTMLFormElementShim, HTMLFormControlsCollection: HTMLFormControlsCollectionShim, HTMLAnchorElement: HTMLAnchorElementShim,
      HTMLHeadingElement: HTMLHeadingElementShim, HTMLParagraphElement: HTMLParagraphElementShim,
      HTMLStyleElement: HTMLStyleElementShim,
      NodeFilter: NodeFilterShim, NodeIterator: NodeIteratorShim,
      Document: DocumentShim, HTMLDocument: FrameHTMLDocument, DocumentFragment: DocumentFragmentShim, ShadowRoot: ShadowRootShim,
      DOMRectReadOnly: DOMRectReadOnlyShim, DOMRect: DOMRectShim,
      CSSStyleDeclaration: CSSStyleDeclarationShim, CSS2Properties: CSS2PropertiesShim,
      CSSStyleSheet: CSSStyleSheetShim, CSSRule: CSSRuleShim,
      CanvasGradient: CanvasGradientShim, TextMetrics: TextMetricsShim, ImageData: ImageDataShim,
      OffscreenCanvasRenderingContext2D: OffscreenCanvasRenderingContext2DShim,
      Storage: StorageShim, Window: FrameWindow,
      Worker: FrameWorkerShim,
      XMLHttpRequest: this.makeXHRClass(frameUrl.href, framePerformance), fetch: this.makeFetch(frameUrl.href),
      Math: this.context.Math, Date: this.context.Date,
      requestAnimationFrame: this.context.requestAnimationFrame, cancelAnimationFrame: this.context.cancelAnimationFrame,
      matchMedia: this.context.matchMedia, getComputedStyle: this.context.getComputedStyle,
      MutationObserver: this.context.MutationObserver, IntersectionObserver: this.context.IntersectionObserver,
      ResizeObserver: this.context.ResizeObserver, PerformanceObserver: makePerformanceObserverClass(framePerformance),
      AudioContext: this.context.AudioContext, OfflineAudioContext: this.context.OfflineAudioContext,
      RTCPeerConnection: this.context.RTCPeerConnection, OffscreenCanvas: this.context.OffscreenCanvas,
      BroadcastChannel: this.context.BroadcastChannel,
      speechSynthesis: new this.context.speechSynthesis.constructor(),
      setTimeout: this.context.setTimeout, clearTimeout, setInterval: this.context.setInterval, clearInterval, queueMicrotask,
      postMessage: (data, targetOrigin = '*') => {
        const clonedData = structuredClone(data);
        const message = this.messageSnapshot(clonedData);
        if (message && typeof message === 'object' && Array.isArray(message.cs)) {
          try {
            for (const csEntry of message.cs) {
              const codeStr = Array.isArray(csEntry) ? csEntry.find(p => p && p.type === 'string') : null;
              if (codeStr && codeStr.prefix !== undefined) {
                this.context.__workerLog.push({ op: 'frame.execute-cs-meta', prefix: String(codeStr.prefix).slice(0, 200), suffix: String(codeStr.suffix).slice(0, 200), length: codeStr.length });
              }
            }
          } catch {}
        }
        this.context.__workerLog.push({
          op: 'frame.message.in', frame: frameUrl.href,
          targetOrigin: String(targetOrigin || '*'), message,
        });
        setTimeout(() => {
          const target = frameGlobal || iframeWindow;
          this.context.__workerLog.push({
            op: 'frame.message.dispatch', frame: frameUrl.href,
            listener_count: EventTargetShim.listenerCount(target, 'message'), message,
          });
          target.dispatchEvent({ type: 'message', data: clonedData, origin: ownerLocation.origin, source: parentProxy, isTrusted: true });
        }, 0);
      },
      __captureEncoderInput: this.context.__captureEncoderInput,
      __captureProducerState: this.context.__captureProducerState,
      close() {}, stop() {}, focus() {}, blur() {}, open() { return null; }, alert() {}, confirm() { return false; }, prompt() { return null; }, print() {},
    });
    iframeWindow.Image = function Image(width = 0, height = 0) {
      try { this.__runtimeWorkerLog?.push?.({ op: 'Image.construct', realm: 'frame', width: Number(width) || 0, height: Number(height) || 0 }); } catch {}
      const image = document.createElement('img');
      image.width = Number(width) || 0;
      image.height = Number(height) || 0;
      return image;
    };
    iframeWindow.Image.prototype = HTMLImageElementShim.prototype;
    iframeWindow.addEventListener = EventTargetShim.prototype.addEventListener.bind(iframeWindow);
    iframeWindow.removeEventListener = EventTargetShim.prototype.removeEventListener.bind(iframeWindow);
    iframeWindow.dispatchEvent = EventTargetShim.prototype.dispatchEvent.bind(iframeWindow);
    iframeWindow.clientInformation = iframeWindow.navigator;
    iframeWindow.__frameElement = node;
    const frameContext = vm.createContext(iframeWindow, {
      name: 'firefox-like-turnstile-frame',
      microtaskMode: 'afterEvaluate',
    });
    installFirefoxErrorStack(frameContext);
    this.installRealmJobPump(frameContext, 'frame');
    this.frameContexts.set(node, frameContext);
    vm.runInContext(`(()=>{
      const rt = ${JSON.stringify(null)}; void rt;
      const sink = globalThis.__cfFrameErrorSink;
      if (!sink) return;
      const logErr = tag => err => {
        try {
          sink({
            op: 'frame.error-event', tag,
            message: String(err && err.message || err).slice(0, 300),
            stack: String(err && err.stack || '').split('\\n').slice(0, 4).join(' | ').slice(0, 600),
          });
        } catch {}
      };
      window.addEventListener('error', logErr('window.error'));
      window.addEventListener('unhandledrejection', logErr('window.unhandledrejection'));
      document.addEventListener('error', logErr('document.error'));
    })()`, frameContext, { filename: 'cf-frame-error-probe.js', timeout: 2000 });
    iframeWindow.__cfFrameErrorSink = e => {
      try { this.context.__workerLog.push(e); } catch {}
    };
    iframeWindow.__cfRuntimeSink = iframeWindow.__cfFrameErrorSink;
    iframeWindow.__cfElementSink = iframeWindow.__cfFrameErrorSink;
    document.__cfElementSink = iframeWindow.__cfFrameErrorSink;
    iframeWindow.__cfMapHit = (op, key, size) => {
      try { this.context.__workerLog.push({ op: 'frame.map-html-key', kind: op, key, map_size: size, stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700) }); } catch {}
    };
    iframeWindow.__cfProgOOB = (tbl, idx, site) => {
      try {
        try { process.stderr.write(`[prog-oob] site=${site} idx=${idx} len=${typeof tbl === 'string' ? tbl.length : (tbl && tbl.length) || 0}\n`); } catch {}
        this.context.__workerLog.push({
          op: 'frame.prog-oob', site, index: idx,
          table_type: Object.prototype.toString.call(tbl),
          table_len: typeof tbl === 'string' ? tbl.length : (tbl && tbl.length) || 0,
          stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700),
        });
      } catch {}
    };
    frameGlobal = vm.runInContext(`(()=>{
      const aliases = {};
      for (const name of ['window', 'self', 'globalThis', 'frames']) {
        aliases[name] = { value: globalThis, writable: true, enumerable: true, configurable: true };
      }
      Object.defineProperties(globalThis, aliases);
      // Do NOT shadow the realm's intrinsic eval with the host eval. The widget
      // decodes its interactive payload and direct-evals it; the intrinsic eval
      // keeps both the VM realm identity AND the caller's scope (exactly like a
      // browser). Shadowing it with the host eval made indirect eval run in the
      // Node module realm, breaking every realm check in the decoded script.
      return globalThis;
    })()`, frameContext);
    setDocumentField(document, 'defaultView', frameGlobal);
    // VM globalThis is a distinct proxy from the host WindowShim. The frame's
    // bound EventTarget methods store listeners on iframeWindow, so both
    // identities must share the same listener registry for postMessage.
    eventTargetState.set(frameGlobal, eventTargetState.get(iframeWindow));
    this.realmContexts.set(document, { context: frameContext, global: frameGlobal });
    return frameGlobal;
  }

  executeFrameScript(node) {
    const src = node.src || node.getAttribute('src') || '';
    if (!src || !src.includes('/turnstile/f/')) return;
    const frame = node.contentWindow;
    if (frame.__executedTurnstileFrame) return;
    frame.__executedTurnstileFrame = true;
    const hydrateDocument = snapshot => {
      if (!snapshot || snapshot.node_type !== 1) return;
      const build = item => {
        if (item.node_type === 3) return frame.document.createTextNode(item.text || '');
        const element = frame.document.createElement(item.tag || 'div');
        for (const [name, value] of item.attributes || []) element.setAttribute(name, value);
        for (const child of item.children || []) element.appendChild(build(child));
        return element;
      };
      const root = build(snapshot);
      setDocumentField(frame.document, 'documentElement', root);
      setDocumentField(frame.document, 'head', root.querySelector('head') || frame.document.createElement('head'));
      setDocumentField(frame.document, 'body', root.querySelector('body') || frame.document.createElement('body'));
    };
    const execute = (code, reason, artifactPath = '') => {
      try {
        if (this.opts.forceFrameBranch) {
          const spec = this.opts.forceFrameBranch;
          const actualSha = sha256Bytes(Buffer.from(code, 'utf8'));
          const count = code.split(spec.anchor).length - 1;
          const receipt = { name: 'force-frame-branch', script: src, script_sha256: actualSha, expected_sha256: spec.sha256, anchor: spec.anchor, match_count: count, replacement: spec.replacement, applied: false };
          if (actualSha !== spec.sha256) throw new Error(`force-frame-branch script sha mismatch: ${actualSha}`);
          if (count !== 1) throw new Error(`force-frame-branch anchor count ${count}, expected 1`);
          code = code.replace(spec.anchor, spec.replacement);
          receipt.applied = true;
          this.vmProbePatches.push(receipt);
        }
        const framePerformanceState = performanceState.get(frame.performance);
        updateNavigationTiming(frame.performance, {
          duration: Math.max(frame.performance.now(), framePerformanceState.bridgeLoadEnd || 0),
        });
        if (this.opts.diagnosticEncoder) {
          // The telemetry object is built as `Rc={...}` and immediately passed
          // to the timer scheduler. Capture that object by its structural tail,
          // not by any per-session obfuscated property names.
          const telemetryPattern = /(R\[ah\(ii\.Ow\)\]\(setTimeout,Ju,100,n,Rc\))/;
          const telemetryMatch = code.match(telemetryPattern);
          if (telemetryMatch) {
            code = code.replace(telemetryPattern, 'globalThis.__captureEncoderInput(Rc,{kind:`telemetry-builder`});$1');
          }
          const probe = `(()=>{const O=Object;if(O.__cf49KeysProbe)return;const nativeKeys=O.keys;Object.defineProperty(O,"__cf49KeysProbe",{value:true});Object.defineProperty(O,"keys",{configurable:true,writable:true,value:function(value){const keys=Reflect.apply(nativeKeys,O,arguments);if(value&&Object.prototype.toString.call(value)==="[object Object]"){const numeric=keys.filter(k=>/^\\d+$/.test(k));if((keys.length===49)||(numeric.length>0&&keys.includes("cpza4")))globalThis.__captureEncoderInput(value,{kind:keys.length===49?"frame-object-keys-49":"frame-object-numeric",numeric_count:numeric.length});}return keys;}});})();`;
          code = probe + code;
          this.vmProbePatches.push({
            name: 'frame.telemetry.object-keys-49',
            count: telemetryMatch ? 1 : 0,
            applied: !!telemetryMatch,
            script: src,
          });
        }
        setDocumentField(frame.document, 'readyState', 'loading');
        // Structural probe: the frame VM's dynamic-call helpers read
        // `function(a,b){return a(b)}` with per-session parameter names. Wrap every such
        // helper so a non-callable first argument is logged with the attempted value
        // (usually the missing member name) instead of surfacing as an opaque TypeError.
        try {
          const dynamicCallPattern = /function\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(?:,([A-Za-z_$][\w$]*))?\)\{return \1\(\2(?:,\3)?\)\}/g;
          // Member-get probe: `function(a,b){return a[b]}` helpers reveal which object's
          // property lookup returned a string where the browser returns a method.
          const memberGetPattern = /function\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return \1\[\2\]\}/g;
          let memberGetCount = 0;
          code = code.replace(memberGetPattern, (_, o, k) => {
            memberGetCount += 1;
            return `function(${o},${k}){var __mv=${o}[${k}];if(typeof __mv==='string'&&__mv.length>2&&globalThis.__cfLogBadCall){globalThis.__cfLogBadCall('member-string:'+Object.prototype.toString.call(${o})+':'+String(${k}).slice(0,30),__mv.slice(0,40)+' host='+(typeof ${o}[${k}]));}return __mv;}`;
          });
          if (memberGetCount) {
            this.vmProbePatches.push({ name: 'frame.member-get-probe', count: memberGetCount, applied: true, script: src });
          }
          let dynamicCallCount = 0;
          // Experiment (env-gated): when the VM's dynamic-call helper receives a stringified
          // element ("[object HTML…Element]") — a register that should hold a callback —
          // return undefined instead of throwing so the interactive flow keeps running.
          const tolerate = String(process.env.CLOUDFLARE_TOLERATE_BAD_CALL || '') === '1';
          const traceCalls = String(process.env.CLOUDFLARE_TRACE_CALLS || '') === '1';
          code = code.replace(dynamicCallPattern, (_, p1, p2, p3) => {
            dynamicCallCount += 1;
            const inner = p3 ? `${p1}(${p2},${p3})` : `${p1}(${p2})`;
            const guard = tolerate
              ? `if(typeof ${p1}!=='function'){if(globalThis.__cfLogBadCall)globalThis.__cfLogBadCall(typeof ${p1},String(${p1}).slice(0,60)+' || ' + String(${p2}).slice(0,60) + ' || info=' + (function(v){try{if(v&&v.nodeType)return 'tag='+v.tagName+' id='+v.id+' parent='+(v.parentNode&&v.parentNode.tagName)+' html='+String(v.innerHTML||'').slice(0,80);if(typeof v==='string')return 'len='+v.length;}catch(e){}return '';}(${p2})));if(${p2}&&typeof ${p2}==='object'&&typeof ${p2}[${p1}]==='function'){return ${p2}[${p1}].call(${p2});}return void 0;}`
              : `if(typeof ${p1}!=='function'&&globalThis.__cfLogBadCall){globalThis.__cfLogBadCall(typeof ${p1},String(${p1}).slice(0,60)+' || ' + String(${p2}).slice(0,60));}`;
            const trace = traceCalls
              ? `if(globalThis.__cfTraceCall)globalThis.__cfTraceCall(typeof ${p1}==='function'?'fn':String(${p1}).slice(0,50),typeof ${p2}==='object'&&${p2}?Object.prototype.toString.call(${p2}):String(${p2}).slice(0,40));`
              : '';
            return `function(${p1},${p2}${p3 ? ',' + p3 : ''}){${trace}${guard}return ${inner};}`;
          });
          if (dynamicCallCount) {
            this.vmProbePatches.push({ name: 'frame.dynamic-call-probe', count: dynamicCallCount, applied: true, script: src });
          }
        } catch {}
        // Interpreter run-away probe: the challenge VM dispatch loops are
        // `for(;;){switch(T[i++]){...}}`. When the program table ends without a break
        // token (or a register misalignment shifts the opcode window), the switch value
        // becomes undefined and the loop spins forever at 100% CPU. Log the offending
        // table and index once per site via a host-side guard injected INSIDE the switch
        // expression: default-case-free loops get a logging default clause appended.
        try {
          const switchPat = String(process.env.CLOUDFLARE_SWITCH_PROBE || '0') === '1'
            ? /switch\(([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)\+\+\]\)/g
            : /__cfNoSwitchProbeNeverMatches__/g;
          let switchCount = 0;
          code = code.replace(switchPat, (whole, tbl, idx) => {
            switchCount += 1;
            return `switch(__cfSw(${tbl},${idx}-1,${switchCount})?${tbl}[${idx}++]:(${tbl}[${idx}++],undefined))`;
          });
          if (switchCount) {
            this.vmProbePatches.push({ name: 'frame.interpreter-switch-probe', count: switchCount, applied: true, script: src });
          }
        } catch {}
        const frameContext = this.frameContexts.get(node);
        if (!frameContext) throw new Error('iframe vm context was not initialized');
        vm.runInContext(`(function(){
  if(globalThis.__cfMapProbe) return;
  var OM = Map, OS = Set;
  globalThis.__cfMapProbe = true;
  var OPD = Object.getOwnPropertyDescriptor(OM.prototype, 'get');
  OM.prototype.get = function(k){ if(typeof k==='string' && k.indexOf('[object HTML')===0 && globalThis.__cfMapHit) globalThis.__cfMapHit('get', k, this.size); return OPD.value.call(this, k); };
  var OPS = Object.getOwnPropertyDescriptor(OM.prototype, 'set');
  OM.prototype.set = function(k, v){ if(typeof k==='string' && k.indexOf('[object HTML')===0 && globalThis.__cfMapHit) globalThis.__cfMapHit('set', k, this.size); return OPS.value.call(this, k, v); };
  var OHD = Object.getOwnPropertyDescriptor(OS.prototype, 'has');
  OS.prototype.has = function(k){ if(typeof k==='string' && k.indexOf('[object HTML')===0 && globalThis.__cfMapHit) globalThis.__cfMapHit('has', k, this.size); return OHD.value.call(this, k); };
})();`, frameContext, { filename: 'cf-frame-map-probe.js', timeout: 2000 });
    vm.runInContext(`globalThis.__cfSw=function(tbl,idx,site){var v=tbl[idx];if(v===undefined&&globalThis.__cfProgOOB)globalThis.__cfProgOOB(tbl,idx,site);return true;};`, frameContext, { filename: 'cf-frame-switch-probe.js', timeout: 2000 });
        vm.runInContext(`if(globalThis.__cfTraceCall===undefined){globalThis.__cfTraceCall=function(fn, arg){(globalThis.__cfRuntimeSink||function(){})({op:'frame.call-trace', fn, arg});};}
if(!globalThis.__cfLogBadCall){globalThis.__cfLogBadCall=function(type,arg){(globalThis.__cfRuntimeSink||function(){})(__cfBadCallRecord(type,arg));};globalThis.__cfBadCallRecord=function(type,arg){return {op:'frame.bad-call',arg_type:type,arg_preview:(typeof arg==='string'?arg.slice(0,80):String(arg).slice(0,80)),stack:String(new Error().stack||'').split('\\n').slice(1,24).join(' | ').slice(0,2400)};};}`, frameContext, { filename: 'cf-frame-badcall-probe.js', timeout: 2000 });
        const frameExecStartedAt = process.hrtime.bigint();
        this.scriptByUrl.set(src, { url: src, code });
        vm.runInContext(code, frameContext, { filename: src, timeout: this.opts.timeoutMs });
        if (this.opts.debugVm) process.stderr.write(`[phase] ${Math.round(Number(process.hrtime.bigint() - frameExecStartedAt) / 1e6)}ms execute:frame:done bytes=${code.length}\n`);
        this.scriptLoads.push({ seq: this.scriptLoads.length + 1, src, reason, status: 'ok', sha256: sha256Bytes(code), ...(artifactPath ? { artifact_path: artifactPath } : {}) });
        setDocumentField(frame.document, 'readyState', 'interactive');
        frame.document.dispatchEvent({ type: 'DOMContentLoaded', isTrusted: true });
        setDocumentField(frame.document, 'readyState', 'complete');
        frame.dispatchEvent({ type: 'load', isTrusted: true });
        node.dispatchEvent({ type: 'load', isTrusted: true });
        updateNavigationTiming(frame.performance, { duration: frame.performance.now() });
      } catch (error) {
        try { process.stderr.write(`[iframe-script-error] ${error && error.name}: ${error && error.message}\n${error && error.stack}\n`); } catch {}
        this.recordError(`iframe-script:${src}`, error);
      }
    };
    if (this.opts.xhrBridge) {
      const operation = global.fetch(this.opts.xhrBridge, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'frame-script', url: src }),
      }).then(response => response.json()).then(result => {
        if (!result.code) throw new Error(result.error || 'Firefox bridge returned an empty iframe script');
        const state = performanceState.get(frame.performance);
        const responseEnd = Math.max(0, Number(result.timing?.document_response_ms) || frame.performance.now());
        const loadEnd = Math.max(responseEnd, Number(result.timing?.load_end_ms) || responseEnd);
        state.bridgeLoadEnd = loadEnd;
        updateNavigationTiming(frame.performance, { responseEnd, duration: loadEnd });
        hydrateDocument(result.dom);
        execute(result.code, 'iframe-firefox-bridge');
      }).catch(error => this.recordError(`iframe-bridge:${src}`, error));
      this.pendingAsync.add(operation);
      operation.finally(() => this.pendingAsync.delete(operation));
      return;
    }
    if (this.turnstileFrameScript) execute(this.turnstileFrameScript, 'iframe-live-fetched', rel(this.turnstileFrameScriptPath));
  }


  makeContext() {
    const runtime = this;
    const deviceProfile = this.environmentProfile.device || {};
    const screenProfile = structuredClone(this.environmentProfile.screen || {});
    const windowProfile = this.environmentProfile.window || {};
    const window = new WindowShim();
    const document = new HTMLDocumentShim(this);
    const scriptVisibleCookies = (this.liveBootstrap?.cookies_after_initial || [])
      .filter(cookie => cookie && !cookie.httpOnly && cookie.name && cookie.value)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (scriptVisibleCookies) getDocumentState(document).cookie = scriptVisibleCookies;
    const navigator = this.makeNavigator();
    const performance = this.makePerformance();
    const localStorage = new StorageShim();
    const sessionStorage = new StorageShim();
    const screen = screenProfile;
    const caches = new CacheStorageShim();
    const cookieStore = new CookieStoreShim(); cookieStore.__document = document;
    const customElements = new CustomElementRegistryShim();
    const scheduler = new SchedulerShim();
    const visualViewport = new VisualViewportShim(1280, 890.5);
    const bars = Object.fromEntries(['toolbar', 'statusbar', 'scrollbars', 'personalbar', 'menubar', 'locationbar'].map(name => [name, new BarPropShim(true)]));
    const audioProbe = maybeReadJson(BROWSER_CONSOLE_PROBE);
    const liveRtcProbe = maybeReadJson(BROWSER_LIVE_RTC_PROBE);
    class AudioParamShim {
      constructor(value = 0) { this.__value = Math.fround(Number(value)); }
      get value() { return this.__value; }
      set value(value) { this.__value = Math.fround(Number(value)); }
      get [Symbol.toStringTag]() { return 'AudioParam'; }
    }
    class AudioNodeShim {
      constructor(context) { this.context = context; this.__connections = []; }
      connect(destination) { this.__connections.push(destination); return destination; }
      disconnect() { this.__connections.length = 0; }
      get [Symbol.toStringTag]() { return 'AudioNode'; }
    }
    class AudioDestinationNodeShim extends AudioNodeShim {
      constructor() { super(null); }
      get [Symbol.toStringTag]() { return 'AudioDestinationNode'; }
    }
    class OscillatorNodeShim extends AudioNodeShim {
      constructor(context) { super(context); this.type = 'sine'; this.frequency = new AudioParamShim(440); this.__started = false; }
      start() { this.__started = true; }
      stop() { this.__started = false; }
      get [Symbol.toStringTag]() { return 'OscillatorNode'; }
    }
    class DynamicsCompressorNodeShim extends AudioNodeShim {
      constructor(context) {
        super(context);
        this.threshold = new AudioParamShim(-24); this.knee = new AudioParamShim(30);
        this.ratio = new AudioParamShim(12); this.attack = new AudioParamShim(0.003); this.release = new AudioParamShim(0.25);
      }
      get [Symbol.toStringTag]() { return 'DynamicsCompressorNode'; }
    }
    class AudioBufferShim {
      constructor(channels = 1, length = 1, sampleRate = 44100) {
        this.numberOfChannels = Math.max(1, Number(channels)); this.length = Math.max(1, Number(length)); this.sampleRate = Number(sampleRate);
        this.duration = this.length / this.sampleRate;
        this.__channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
      }
      getChannelData(channel) { return this.__channels[Number(channel)]; }
      get [Symbol.toStringTag]() { return 'AudioBuffer'; }
    }
    class AudioBufferSourceNodeShim extends AudioNodeShim {
      constructor(context) { super(context); this.buffer = null; this.__started = false; }
      start() { this.__started = true; }
      stop() { this.__started = false; }
      get [Symbol.toStringTag]() { return 'AudioBufferSourceNode'; }
    }
    class HistoryShim {
      constructor() { this.length = 1; this.state = null; }
      pushState(state, _unused, url) {
        this.state = state;
        if (url !== undefined && url !== null) runtime.location.href = new URL(String(url), runtime.location.href).href;
        this.length++;
      }
      replaceState(state, _unused, url) {
        this.state = state;
        if (url !== undefined && url !== null) runtime.location.href = new URL(String(url), runtime.location.href).href;
      }
      back() {} forward() {} go() {}
      get [Symbol.toStringTag]() { return 'History'; }
    }
    Object.defineProperty(HistoryShim, 'name', { value: 'History', configurable: true });
    for (const name of Reflect.ownKeys(HistoryShim.prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(HistoryShim.prototype, name);
      Object.defineProperty(HistoryShim.prototype, name, { ...descriptor, enumerable: true });
    }
    const history = new HistoryShim();
    class Event {
      constructor(type, init = {}) {
        this.type = String(type);
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.composed = !!init.composed;
        this.defaultPrevented = false;
        this.isTrusted = init.isTrusted !== undefined ? !!init.isTrusted : false;
        this.timeStamp = performance.now();
        if (new.target === Event) Object.assign(this, init);
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
      stopPropagation() { this.cancelBubble = true; }
      stopImmediatePropagation() { this.cancelBubble = true; this.__immediateStopped = true; }
      composedPath() { return [this.target || null, document, window].filter(Boolean); }
      get [Symbol.toStringTag]() { return 'Event'; }
    }
    class ProgressEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.lengthComputable = !!init.lengthComputable;
        this.loaded = Number(init.loaded) || 0;
        this.total = Number(init.total) || 0;
      }
      get [Symbol.toStringTag]() { return 'ProgressEvent'; }
    }
    class RTCIceCandidate {
      constructor(init = {}) {
        Object.defineProperty(this, '__init', {
          value: {
            candidate: String(init.candidate || ''),
            sdpMid: init.sdpMid == null ? null : String(init.sdpMid),
            sdpMLineIndex: init.sdpMLineIndex == null ? null : Number(init.sdpMLineIndex),
            usernameFragment: init.usernameFragment == null ? null : String(init.usernameFragment),
          },
          enumerable: false,
        });
      }
      get candidate() { return this.__init.candidate; }
      get sdpMid() { return this.__init.sdpMid; }
      get sdpMLineIndex() { return this.__init.sdpMLineIndex; }
      get usernameFragment() { return this.__init.usernameFragment; }
      toJSON() {
        return {
          candidate: this.candidate,
          sdpMid: this.sdpMid,
          sdpMLineIndex: this.sdpMLineIndex,
          usernameFragment: this.usernameFragment,
        };
      }
      get [Symbol.toStringTag]() { return 'RTCIceCandidate'; }
    }
    class RTCPeerConnectionIceEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        Object.defineProperty(this, '__candidate', {
          value: init.candidate == null || init.candidate instanceof RTCIceCandidate
            ? init.candidate ?? null
            : new RTCIceCandidate(init.candidate),
          enumerable: false,
        });
      }
      get candidate() { return this.__candidate; }
      get [Symbol.toStringTag]() { return 'RTCPeerConnectionIceEvent'; }
    }
    class MessageEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.__data = init.data ?? null; this.__origin = String(init.origin || '');
        this.__lastEventId = String(init.lastEventId || ''); this.__source = init.source ?? null;
        this.__ports = Array.from(init.ports || []);
      }
      get data() { return this.__data; } get origin() { return this.__origin; }
      get lastEventId() { return this.__lastEventId; } get source() { return this.__source; }
      get ports() { return this.__ports; }
      get [Symbol.toStringTag]() { return 'MessageEvent'; }
    }
    const broadcastChannels = new Map();
    const broadcastState = new WeakMap();
    class BroadcastChannel extends EventTargetShim {
      constructor(name) {
        super();
        broadcastState.set(this, { name: String(name), closed: false, onmessage: null, onmessageerror: null });
        const channels = broadcastChannels.get(String(name)) || new Set(); channels.add(this); broadcastChannels.set(String(name), channels);
      }
      postMessage(data) {
        const state = broadcastState.get(this);
        if (state.closed) throw new DOMExceptionShim('BroadcastChannel is closed', 'InvalidStateError');
        for (const channel of broadcastChannels.get(state.name) || []) if (channel !== this && !broadcastState.get(channel).closed) {
          setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: structuredClone(data), origin: runtime.location.origin, source: null })), 0);
        }
      }
      close() { const state = broadcastState.get(this); state.closed = true; broadcastChannels.get(state.name)?.delete(this); }
      get name() { return broadcastState.get(this).name; }
      get onmessage() { return broadcastState.get(this).onmessage; }
      set onmessage(value) { broadcastState.get(this).onmessage = value; }
      get onmessageerror() { return broadcastState.get(this).onmessageerror; }
      set onmessageerror(value) { broadcastState.get(this).onmessageerror = value; }
      get [Symbol.toStringTag]() { return 'BroadcastChannel'; }
    }
    Object.defineProperty(BroadcastChannel, 'name', { value: 'BroadcastChannel', configurable: true });
    const speechState = new WeakMap();
    class SpeechSynthesis extends EventTargetShim {
      constructor() { super(); speechState.set(this, { pending: false, speaking: false, paused: false, onvoiceschanged: null }); }
      speak(utterance) { if (utterance && typeof utterance === 'object') { try { utterance.dispatchEvent?.({ type: 'start' }); } catch {} } speechState.get(this).speaking = true; }
      cancel() { const state = speechState.get(this); state.pending = false; state.speaking = false; state.paused = false; }
      pause() { speechState.get(this).paused = true; }
      resume() { speechState.get(this).paused = false; }
      getVoices() { return []; }
      get pending() { return speechState.get(this).pending; }
      get speaking() { return speechState.get(this).speaking; }
      get paused() { return speechState.get(this).paused; }
      get onvoiceschanged() { return speechState.get(this).onvoiceschanged; }
      set onvoiceschanged(value) { speechState.get(this).onvoiceschanged = value; }
      get [Symbol.toStringTag]() { return 'SpeechSynthesis'; }
    }
    Object.defineProperty(SpeechSynthesis, 'name', { value: 'SpeechSynthesis', configurable: true });
    for (const prototype of [BroadcastChannel.prototype, SpeechSynthesis.prototype]) {
      for (const name of Reflect.ownKeys(prototype)) {
        if (name === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        Object.defineProperty(prototype, name, { ...descriptor, enumerable: true });
      }
    }
    class IDBFactory {
      open() { return { readyState: 'pending', result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }; }
      deleteDatabase() { return { readyState: 'pending', result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null }; }
      databases() { return Promise.resolve([]); }
      cmp(first, second) { if (first === second) return 0; return first < second ? -1 : 1; }
      get [Symbol.toStringTag]() { return 'IDBFactory'; }
    }
    class External {
      AddSearchProvider() {}
      IsSearchProviderInstalled() { return 0; }
      get [Symbol.toStringTag]() { return 'External'; }
    }
    class Notification extends EventTargetShim {
      static get permission() { return 'default'; }
      get [Symbol.toStringTag]() { return 'Notification'; }
    }
    window.__eventLog = [];
    window.__xhrLog = [];
    window.__missingGlobalLog = [];
    window.__workerLog = [];
    window.__cfOptLog = [];
    window.__cfDebugLog = [];
    window.__cfVmLog = [];
    window.__jsonStringifyLog = [];
    window.__encoderInputLog = [];
    window.__encoderProducerLog = [];
    window.__debugVmEnabled = !!runtime.opts.debugVm;
    window.__timerFns = new Map();
    window.__navigationLog = [];
    window.__cfDebug = (entry) => {
      try { window.__cfDebugLog.push({ ...entry, preview: runtime.previewValue(entry?.ti), type: typeof entry?.ti, ctor: entry?.ti?.constructor?.name || null }); } catch {}
    };
    window.__cfResolveCallable = (name) => {
      if (typeof name === 'function') return name;
      if (typeof name !== 'string') return name;
      const direct = window[name];
      if (typeof direct === 'function') return direct;
      const doc = window.document && window.document[name];
      if (typeof doc === 'function') return doc.bind(window.document);
      const loc = window.location && window.location[name];
      if (typeof loc === 'function') return loc.bind(window.location);
      return direct;
    };
    window.__captureEncoderInput = (value, meta = {}) => {
      const seen = new WeakSet();
      const snapshot = (item, depth = 0) => {
        if (item == null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return item;
        if (typeof item === 'bigint') return { type: 'bigint', value: String(item) };
        if (typeof item === 'function') return { type: 'function', name: item.name || '' };
        if (typeof item !== 'object') return { type: typeof item, value: String(item) };
        if (seen.has(item)) return { type: 'circular' };
        if (depth >= 5) return { type: Object.prototype.toString.call(item), keys: Object.keys(item) };
        seen.add(item);
        if (Array.isArray(item)) return item.map(entry => snapshot(entry, depth + 1));
        if (ArrayBuffer.isView(item)) return Array.from(item, entry => snapshot(entry, depth + 1));
        const result = {};
        for (const key of Object.keys(item)) {
          try { result[key] = snapshot(item[key], depth + 1); }
          catch (error) { result[key] = { type: 'snapshot-error', message: String(error && error.message || error) }; }
        }
        return result;
      };
      window.__encoderInputLog.push({
        meta: snapshot(meta),
        key_count: value && typeof value === 'object' ? Object.keys(value).length : 0,
        keys: value && typeof value === 'object' ? Object.keys(value) : [],
        value: snapshot(value),
      });
      if (window.__encoderInputLog.length > 512) window.__encoderInputLog.shift();
    };
    window.__captureProducerState = (state) => {
      if (!state || typeof state !== 'object') return;
      const scalars = {};
      for (const key of Object.keys(state)) {
        try {
          const value = state[key];
          if (value == null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 160)) scalars[key] = value;
          else if (value && typeof value === 'object') {
            const nested = {};
            for (const nestedKey of Object.keys(value)) {
              const nestedValue = value[nestedKey];
              if (nestedValue == null || typeof nestedValue === 'number' || typeof nestedValue === 'boolean' || (typeof nestedValue === 'string' && nestedValue.length <= 160)) nested[nestedKey] = nestedValue;
            }
            if (Object.keys(nested).length) scalars[key] = nested;
          }
        } catch {}
      }
      window.__encoderProducerLog.push(scalars);
    };
    window.__captureProducerValue = (value, label) => {
      let snapshot = value;
      try {
        if (value && typeof value === 'object') {
          snapshot = { type: Object.prototype.toString.call(value), keys: Object.keys(value).slice(0, 24) };
        }
      } catch {}
      window.__encoderProducerLog.push({ label: String(label), value: snapshot });
      return value;
    };
    EventTargetShim.eventLog = window.__eventLog;
    runtime.noteEnv('Blob/URL.createObjectURL/Worker', 'trace-derived-minimal', 'trace:dom lines 272-276/525-526', { reason: 'orchestrate and turnstile construct Blob URL workers' });
    runtime.noteEnv('Document.location/domain', 'trace-derived-scalar', 'trace:dom Document.location before call_13403', { reason: 'script reads document.location.hostname' });
    runtime.noteEnv('iframe.contentWindow', 'firefox-bidi-object-contract', 'runtime-data/browser-console-observed-20260817.json', {
      reason: 'descriptor ownership, realm aliases, frameElement and constructor separation were observed in Firefox 142.0a1',
    });
    runtime.noteEnv('Canvas2D/WebGL', 'firefox-bidi-object-contract', 'runtime-data/browser-console-observed-20260817.json', {
      reason: 'context brands, context locking, metrics shape, extensions and WebGL parameters were observed in Firefox 142.0a1',
    });
    runtime.noteEnv('Audio/RTC', audioProbe && liveRtcProbe ? 'firefox-bidi-target-observed' : 'missing', audioProbe && liveRtcProbe ? 'runtime-data/browser-console-target-probe-20260817.json + browser-console-live-rtc-20260817.json' : 'not available', {
      reason: audioProbe && liveRtcProbe ? 'target-origin BiDi probes captured Firefox AudioParam Float32 coercion, rendered sample bytes, target RTCPeerConnection configuration and live host/srflx event ordering' : 'target-origin browser probes are required before implementing this surface',
      audio_sha256: audioProbe?.audio?.value?.sha256 || null,
      rtc_event_count: liveRtcProbe?.contexts?.reduce((count, context) => count + (context.observed?.log?.filter(entry => entry.op === 'icecandidate').length || 0), 0) || null,
    });
    runtime.noteEnv('manual DOM events', 'firefox-bidi-target-observed', 'runtime-data/browser-console-target-probe-20260817.json', {
      reason: 'target-origin BiDi probe captured iframe/Worker realm separation and task order; local event injection remains scoped to replay orchestration',
      order: audioProbe?.taskOrder?.value?.order || null,
    });
    runtime.noteEnv('Turnstile iframe inline document script', runtime.turnstileFrameScript ? 'live-fetched-gap-fill' : 'missing', runtime.turnstileFrameScript ? 'examples/5s/runtime-data/turnstile-frame-live.js' : 'not available', { reason: 'trace contains JS events for iframe document but no script.resource artifact; this is not fixed-vector evidence' });
    runtime.noteEnv('NodeFilter', 'firefox-bidi-object-contract', 'runtime-data/live-validation-bootstrap.json', {
      reason: 'Turnstile API reads NodeFilter after iframe message dispatch',
      prototype: 'Function.prototype',
      constants: Object.fromEntries(Object.keys(NodeFilterShim).map(key => [key, NodeFilterShim[key]])),
    });

    // The captured Turnstile document-start script creates these three
    // Trusted Types conversion functions before the challenge scripts run.
    // The same names are read from the parent realm by this challenge build;
    // keep the identity behavior from the captured fallback script instead of
    // resolving an unknown name to an empty callable.
    window.KQlAt3 = (value) => String(value);
    window.ZHfDS6 = (value) => String(value);
    window.MfEvo2 = (value) => String(value);
    runtime.noteEnv('TrustedTypes conversion globals', 'trace-derived', 'runtime-data/turnstile-frame-live.js', {
      members: ['KQlAt3', 'ZHfDS6', 'MfEvo2'],
      behavior: 'identity conversion from captured document-start script',
    });

    const rtcPeerState = new WeakMap();
    Object.assign(window, {
      window, self: window, globalThis: window, top: window, parent: window, frames: window,
      document, navigator, clientInformation: navigator, performance, localStorage, sessionStorage, screen, history, History: HistoryShim,
      location: this.location, Location: LocationShim,
      origin: this.location.origin,
      name: '',
      innerWidth: windowProfile.innerWidth, innerHeight: windowProfile.innerHeight,
      outerWidth: windowProfile.outerWidth, outerHeight: windowProfile.outerHeight,
      screenX: windowProfile.screenX, screenY: windowProfile.screenY,
      screenLeft: windowProfile.screenX, screenTop: windowProfile.screenY,
      mozInnerScreenX: 196, mozInnerScreenY: 421.5,
      devicePixelRatio: deviceProfile.devicePixelRatio,
      fullScreen: false,
      console,
      parseInt, parseFloat, isNaN, isFinite, encodeURI, encodeURIComponent, decodeURI, decodeURIComponent, escape, unescape,
      crypto: webcrypto,
      structuredClone: global.structuredClone,
      createImageBitmap: (source) => Promise.resolve({ width: Number(source?.width) || 1, height: Number(source?.height) || 1, close() {} }),
      isSecureContext: true,
      indexedDB: new IDBFactory(), caches, cookieStore, customElements, scheduler, visualViewport,
      ...bars, external: new External(), Notification,
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
      TextEncoder, TextDecoder, URL, URLSearchParams, Headers: HeadersShim, Response: ResponseShim,
      Blob: BlobShim, Request: RequestShim, FormData: global.FormData, AbortController: global.AbortController,
      DOMException: DOMExceptionShim,
      PublicKeyCredential: PublicKeyCredentialShim,
      CredentialsContainer: CredentialsContainerShim,
      NodeFilter: NodeFilterShim, NodeIterator: NodeIteratorShim,
      EventTarget: EventTargetShim, Event, ProgressEvent, MessageEvent, RTCIceCandidate, RTCPeerConnectionIceEvent, RTCDataChannel: RTCDataChannelShim,
      MouseEvent: class MouseEvent { constructor(type, init = {}) { this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.clientX = init.clientX || 0; this.clientY = init.clientY || 0; this.screenX = init.screenX || 0; this.screenY = init.screenY || 0; this.button = init.button || 0; this.buttons = init.buttons || 0; this.isTrusted = init.isTrusted !== undefined ? !!init.isTrusted : false; this.timeStamp = performance.now(); Object.assign(this, init); } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } stopPropagation() { this.cancelBubble = true; } stopImmediatePropagation() { this.cancelBubble = true; } composedPath() { return [this.target || null, document, window].filter(Boolean); } },
      PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.clientX = init.clientX || 0; this.clientY = init.clientY || 0; this.screenX = init.screenX || 0; this.screenY = init.screenY || 0; this.button = init.button || 0; this.buttons = init.buttons || 0; this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; this.isPrimary = init.isPrimary !== false; this.width = init.width || 1; this.height = init.height || 1; this.pressure = init.pressure || (init.buttons ? 0.5 : 0); this.tiltX = 0; this.tiltY = 0; this.twist = 0; this.isTrusted = init.isTrusted !== undefined ? !!init.isTrusted : false; this.timeStamp = performance.now(); Object.assign(this, init); } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } stopPropagation() { this.cancelBubble = true; } stopImmediatePropagation() { this.cancelBubble = true; } getCoalescedEvents() { return [this]; } getPredictedEvents() { return []; } composedPath() { return [this.target || null, document, window].filter(Boolean); } },
      KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.key = init.key || ''; this.code = init.code || ''; this.keyCode = init.keyCode || 0; this.which = init.which || this.keyCode; this.isTrusted = init.isTrusted !== undefined ? !!init.isTrusted : false; this.timeStamp = performance.now(); Object.assign(this, init); } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } stopPropagation() { this.cancelBubble = true; } composedPath() { return [this.target || null, document, window].filter(Boolean); } },
      postMessage: (data, origin) => setImmediate(() => window.dispatchEvent({ type: 'message', data, origin: origin || '*' })),
      requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
      cancelAnimationFrame: (id) => clearTimeout(id),
      matchMedia: () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }),
      getComputedStyle: element => createComputedStyle(element),
      MutationObserver: class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } },
      IntersectionObserver: class IntersectionObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
      ResizeObserver: class ResizeObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
      PerformanceEntry: PerformanceEntryShim,
      Performance: PerformanceShim,
      PerformanceResourceTiming: PerformanceResourceTimingShim,
      PerformanceNavigationTiming: PerformanceNavigationTimingShim,
      PerformanceObserverEntryList: PerformanceObserverEntryListShim,
      GPU: GPUShim, GPUAdapter: GPUAdapterShim, GPUAdapterInfo: GPUAdapterInfoShim,
      GPUSupportedFeatures: GPUSupportedFeaturesShim, GPUSupportedLimits: GPUSupportedLimitsShim,
      PerformanceObserver: makePerformanceObserverClass(performance),
      FontFace: class FontFace { constructor(family, source, descriptors) { this.family = family; this.source = source; this.descriptors = descriptors; } load() { return Promise.reject(new DOMExceptionShim('A network error occurred.')); } },
      AudioContext: class AudioContext {
        constructor() { this.destination = new AudioDestinationNodeShim(); }
        createOscillator() { return new OscillatorNodeShim(this); }
        createDynamicsCompressor() { return new DynamicsCompressorNodeShim(this); }
        createBuffer(channels, length, sampleRate) { return new AudioBufferShim(channels, length, sampleRate); }
        createBufferSource() { return new AudioBufferSourceNodeShim(this); }
        close() { return Promise.resolve(); }
      },
      OfflineAudioContext: class OfflineAudioContext {
        constructor(channels = 1, length = 1, sampleRate = 44100) {
          this.numberOfChannels = Number(channels); this.length = Number(length); this.sampleRate = Number(sampleRate);
          this.destination = new AudioDestinationNodeShim(); this.__sources = [];
        }
        createOscillator() { const node = new OscillatorNodeShim(this); this.__sources.push(node); return node; }
        createDynamicsCompressor() { return new DynamicsCompressorNodeShim(this); }
        createBuffer(channels, length, sampleRate) { return new AudioBufferShim(channels, length, sampleRate); }
        createBufferSource() { const node = new AudioBufferSourceNodeShim(this); this.__sources.push(node); return node; }
        startRendering() {
          const output = new AudioBufferShim(this.numberOfChannels, this.length, this.sampleRate);
          const probe = audioProbe?.audio?.value;
          const exactProbe = probe && this.numberOfChannels === 1 && this.length === probe.sampleLength && this.sampleRate === probe.parameters.sampleRate &&
            this.__sources.some(source => source instanceof OscillatorNodeShim && source.__started && source.type === probe.parameters.oscillatorType && source.frequency.value === probe.parameters.frequency);
          if (exactProbe) {
            const bytes = Buffer.from(probe.samplesBase64, 'base64');
            const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT));
            output.__channels[0].set(samples.subarray(0, output.length));
            return Promise.resolve(output);
          }
          for (const source of this.__sources) {
            if (!source.__started) continue;
            const target = output.getChannelData(0);
            if (source instanceof OscillatorNodeShim) {
              const frequency = source.frequency.value;
              for (let i = 0; i < target.length; i++) {
                const phase = (i * frequency / this.sampleRate) % 1;
                const sample = source.type === 'triangle' ? 1 - 4 * Math.abs(phase - 0.5) : Math.sin(phase * 2 * Math.PI);
                target[i] += sample;
              }
            } else if (source.buffer) {
              const input = source.buffer.getChannelData(0);
              for (let i = 0; i < Math.min(target.length, input.length); i++) target[i] += input[i];
            }
          }
          return Promise.resolve(output);
        }
      },
      RTCPeerConnection: class RTCPeerConnection extends EventTargetShim {
        constructor(configuration = {}) { super(); rtcPeerState.set(this, { configuration, localDescription: null, remoteDescription: null, iceGatheringState: 'new', iceConnectionState: 'new', connectionState: 'new', signalingState: 'stable', onicecandidate: null }); }
        createDataChannel(label = '', options = {}) { return new RTCDataChannelShim(label, options); }
        createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }); }
        setLocalDescription(desc) {
          const state = rtcPeerState.get(this);
          state.localDescription = desc || { type: 'offer', sdp: '' };
          state.iceGatheringState = 'gathering';
          queueMicrotask(() => {
            const dispatchCandidate = (value, mid = 0) => {
              const candidate = new RTCIceCandidate({ candidate: value, sdpMid: String(mid), sdpMLineIndex: mid });
              this.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate }));
            };
            const probeEvents = liveRtcProbe?.contexts?.flatMap(context => context.observed?.log || [])
              .filter(entry => entry.op === 'icecandidate') || [];
            const hostNames = new Map();
            let srflxPort = 49152 + Math.floor(Math.random() * 12000);
            const rewriteCandidate = raw => {
              if (!raw) return raw;
              const parts = String(raw).split(' ');
              const typeIndex = parts.indexOf('typ');
              const type = typeIndex >= 0 ? parts[typeIndex + 1] : '';
              if (type === 'host' && parts[4]?.endsWith('.local')) {
                if (!hostNames.has(parts[4])) hostNames.set(parts[4], `${crypto.randomUUID()}.local`);
                parts[4] = hostNames.get(parts[4]);
                if (parts[2]?.toUpperCase() === 'UDP') parts[5] = String(49152 + Math.floor(Math.random() * 16384));
              } else if (type === 'srflx' && this.__runtimePublicIp) {
                parts[4] = this.__runtimePublicIp;
                parts[5] = String(srflxPort++);
              }
              return parts.join(' ');
            };
            this.__runtimePublicIp = runtime.opts.publicIp;
            for (const entry of probeEvents) {
              setTimeout(() => {
                if (entry.candidate === null) {
                  state.iceGatheringState = 'complete';
                  this.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: null }));
                  return;
                }
                dispatchCandidate(rewriteCandidate(entry.candidate), Number(entry.sdpMLineIndex || 0));
              }, Math.max(0, Number(entry.deltaMs) || 0));
            }
          });
          return Promise.resolve();
        }
        getConfiguration() { return structuredClone(rtcPeerState.get(this).configuration); }
        get localDescription() { return rtcPeerState.get(this).localDescription; }
        get currentLocalDescription() { return rtcPeerState.get(this).localDescription; }
        get pendingLocalDescription() { return null; }
        get remoteDescription() { return rtcPeerState.get(this).remoteDescription; }
        get currentRemoteDescription() { return rtcPeerState.get(this).remoteDescription; }
        get pendingRemoteDescription() { return null; }
        get signalingState() { return rtcPeerState.get(this).signalingState; }
        get canTrickleIceCandidates() { return null; }
        get iceGatheringState() { return rtcPeerState.get(this).iceGatheringState; }
        get iceConnectionState() { return rtcPeerState.get(this).iceConnectionState; }
        get connectionState() { return rtcPeerState.get(this).connectionState; }
        get onicecandidate() { return rtcPeerState.get(this).onicecandidate; }
        set onicecandidate(value) { rtcPeerState.get(this).onicecandidate = value; }
        close() { rtcPeerState.get(this).connectionState = 'closed'; }
        get [Symbol.toStringTag]() { return 'RTCPeerConnection'; }
      },
      BroadcastChannel,
      speechSynthesis: new SpeechSynthesis(),
      OffscreenCanvas: class OffscreenCanvas {
        constructor(w, h) { this.width = w; this.height = h; this.__context2d = null; }
        getContext(k) {
          if (String(k) === '2d') return this.__context2d ||= runtime.makeCanvasContext(k, this);
          return runtime.makeCanvasContext(k, this);
        }
        convertToBlob() {
          const context = this.__context2d ||= runtime.makeCanvasContext('2d', this);
          return Promise.resolve(new BlobShim([context.getImageData(0, 0, this.width, this.height).data]));
        }
      },
    });
    for (const name of Reflect.ownKeys(window.RTCPeerConnection.prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(window.RTCPeerConnection.prototype, name);
      Object.defineProperty(window.RTCPeerConnection.prototype, name, { ...descriptor, enumerable: true });
    }

    const NativeURL = URL;
    const URLShim = function URLShim(url, base) { return new NativeURL(url, base); };
    URLShim.prototype = NativeURL.prototype;
    for (const key of Object.getOwnPropertyNames(NativeURL)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      try { Object.defineProperty(URLShim, key, Object.getOwnPropertyDescriptor(NativeURL, key)); } catch {}
    }
    URLShim.createObjectURL = (blob) => {
      const id = `blob:${runtime.location.origin}/${crypto.randomUUID ? crypto.randomUUID() : (++runtime.blobSeq).toString(16)}`;
      let code = '';
      try { code = blob && typeof blob.__buffer === 'function' ? blob.__buffer().toString('utf8') : String(blob ?? ''); } catch {}
      runtime.blobUrlStore.set(id, { blob, code, created_at: Date.now() });
      window.__workerLog.push({ op: 'createObjectURL', url: id, code_size: code.length, code_preview: code.slice(0, 1200) });
      return id;
    };
    URLShim.revokeObjectURL = (url) => { window.__workerLog.push({ op: 'revokeObjectURL', url: String(url) }); /* keep code available for already constructed workers */ };
    window.URL = URLShim;
    WorkerShim.__runtime = runtime;
    window.Worker = WorkerShim;

    const originalRandom = Math.random;
    window.Math = Object.create(Math);
    Object.getOwnPropertyNames(Math).forEach(k => {
      Object.defineProperty(window.Math, k, Object.getOwnPropertyDescriptor(Math, k));
    });
    window.Math.random = () => {
      const value = originalRandom();
      runtime.randomLedger.push({ seq: runtime.randomLedger.length + 1, value });
      return value;
    };
    const DateShim = class extends Date {
      constructor(...args) {
        if (args.length === 0) {
          const ms = Math.floor(virtualNowMs());
          runtime.timeLedger.push({ seq: runtime.timeLedger.length + 1, kind: 'new Date', ms });
          super(ms);
        } else super(...args);
      }
      static now() {
        const ms = Math.floor(virtualNowMs());
        runtime.timeLedger.push({ seq: runtime.timeLedger.length + 1, kind: 'Date.now', ms });
        return ms;
      }
    };
    DateShim.UTC = Date.UTC;
    DateShim.parse = Date.parse;
    window.Date = DateShim;

    const timerWrap = (kind, fn, delay, ...args) => {
      if (typeof fn === 'function' && this.recursiveTimerFns.has(fn)) return 0;
      if (runtime.opts.diagnosticEncoder) {
        for (let index = 0; index < args.length; index++) {
          let value = args[index];
          if (!value || Object.prototype.toString.call(value) !== '[object Object]') continue;
          const keyCount = Object.keys(value).length;
          if (keyCount >= 16 && keyCount <= 80) {
            window.__captureEncoderInput(value, { kind: 'timer-extra-argument', timerKind: kind, delay: Number(delay) || 0, argumentIndex: index });
            if (kind === 'setTimeout' && Number(delay) === 100) {
              value = new Proxy(value, {
                set(target, property, next, receiver) {
                  const keysBefore = Object.keys(target);
                  const propertyIndex = keysBefore.indexOf(String(property));
                  const previous = Reflect.get(target, property, receiver);
                  const result = Reflect.set(target, property, next, receiver);
                  if (propertyIndex >= 0 && (typeof previous === 'number' || typeof next === 'number') && previous !== next) {
                    window.__captureEncoderInput(target, {
                      kind: 'telemetry-value-write', property_index: propertyIndex,
                      previous, next, at_ms: window.performance.now(),
                    });
                  }
                  if (/^\d+$/.test(String(property))) {
                    window.__captureEncoderInput(target, { kind: 'telemetry-write', property: String(property), numeric_count: Object.keys(target).filter(key => /^\d+$/.test(key)).length });
                  }
                  return result;
                },
                defineProperty(target, property, descriptor) {
                  const result = Reflect.defineProperty(target, property, descriptor);
                  if (/^\d+$/.test(String(property))) {
                    window.__captureEncoderInput(target, { kind: 'telemetry-define', property: String(property), numeric_count: Object.keys(target).filter(key => /^\d+$/.test(key)).length });
                  }
                  return result;
                },
              });
              args[index] = value;
            }
          }
        }
      }
      const stack = String(new Error().stack || '').split('\n').slice(1, 6).join('\n');
      const tid = ++runtime.timerSeq;
      window.__timerFns.set(tid, { fn, args, kind });
      const delayMs = Math.max(0, Number(delay) || 0);
      let id;
      const invoke = () => {
        if (runtime.scenarioDeadline && Date.now() >= runtime.scenarioDeadline) {
          window.__timerFns.delete(tid);
          if (kind === 'setInterval') clearInterval(id);
          return;
        }
        runtime.timerCallbackCount += 1;
        if (runtime.afterFinalResponse && runtime.context?.__workerLog) {
          runtime.context.__workerLog.push({ op: 'timer.after-final.enter', tid, kind, delay_ms: delayMs });
        }
        const callbackStartedAt = Date.now();
        if (runtime.opts.debugVm && runtime.timerCallbackCount <= 12) {
          process.stderr.write(`[timer] start tid=${tid} kind=${kind} delay=${delayMs} fn=${String(fn).slice(0, 2400).replace(/\s+/g, ' ')}\n`);
        }
        if (runtime.timerCallbackCount > 2000) {
          runtime.recordError(`${kind}#${tid}.callback`, new Error('timer callback fuse exceeded'));
          return;
        }
        let record = null;
        try {
          record = window.__timerFns.get(tid);
          if (!record) return;
          if (kind === 'setTimeout') window.__timerFns.delete(tid);
          // The frame's 100ms submit timer carries the /fo/ target URL as its first string
          // argument. Remember it so the endpoint-override experiment can restore it.
          if (kind === 'setTimeout' && delayMs === 100) {
            for (const value of args) {
              if (typeof value === 'string' && value.startsWith('/cdn-cgi/challenge-platform/') && value.includes('/fo/')) {
                runtime.frameSubmitFoUrl = value;
              }
            }
          }
          const telemetryArgument = runtime.opts.diagnosticEncoder && kind === 'setTimeout' && delayMs === 100
            ? record.args.find(value => {
                if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
                const keys = Object.keys(value);
                return keys.length >= 16 && keys.length <= 80 && keys.some(key => typeof value[key] === 'number');
              })
            : null;
          if (telemetryArgument) window.__captureEncoderInput(telemetryArgument, { kind: 'telemetry-timer-enter', tid, timerArgs: (record.args || []).map(a => typeof a === 'string' ? a.slice(0, 120) : typeof a) });
          if (typeof record.fn === 'function') record.fn.apply(window, record.args);
          else vm.runInContext(String(record.fn), runtime.vmContext, {
            filename: runtime.location.href,
            timeout: Math.min(runtime.opts.timeoutMs || 3000, 5000),
          });
          if (telemetryArgument) {
            window.__captureEncoderInput(telemetryArgument, { kind: 'telemetry-timer-return', tid });
            queueMicrotask(() => window.__captureEncoderInput(telemetryArgument, { kind: 'telemetry-after-microtask', tid }));
            setTimeout(() => window.__captureEncoderInput(telemetryArgument, { kind: 'telemetry-after-250ms', tid }), 250);
          }
        }
        catch (e) {
          if (e && e.__cfTargetCaptured) runtime.targetRequestCaptured = true;
          else {
            e.__timerStack = stack;
            if (e instanceof RangeError || /Maximum call stack/i.test(String(e && e.message || ''))) {
              if (typeof record?.fn === 'function') runtime.recursiveTimerFns.add(record.fn);
              const preview = String(record?.fn || '');
              if (preview) {
                for (const timer of runtime.timers) {
                  if (timer.kind === 'setTimeout' && timer.id) clearTimeout(timer.id);
                }
              }
              runtime.context.__workerLog.push({ op: 'timer.range-error', tid, kind, delay_ms: delayMs, callback_preview: String(record?.fn || '').slice(0, 2000) });
            }
            runtime.recordError(`${kind}#${tid}.callback`, e);
            // For "X is not a function" inside challenge scripts, slice the executing source
            // around the failing column so the missing member call is directly visible.
            if (/ is not a function/.test(String(e && e.message || ''))) {
              try {
                const frame = String(e && e.stack || '').split('\n').find(l => /:\d+:\d+\)?$/.test(l.trim()) && !l.includes('node:'));
                const m = frame ? frame.match(/(.+?):(\d+):(\d+)\)?$/) : null;
                if (m) {
                  const file = m[1];
                  const col = Number(m[3]);
                  let local = runtime.scriptByUrl?.get?.(file);
                  if (!local) {
                    const noQuery = file.split('?')[0];
                    for (const [key, value] of runtime.scriptByUrl || []) {
                      if (key.split('?')[0] === noQuery) { local = value; break; }
                    }
                  }
                  let source = local?.code || null;
                  const excerpt = source ? source.slice(Math.max(0, col - 160), col + 160) : null;
                  runtime.context.__workerLog.push({
                    op: 'timer.member-error', tid, kind, url: file, column: col,
                    message: String(e.message).slice(0, 120),
                    excerpt,
                  });
                }
              } catch {}
            }
          }
        }
        if (runtime.opts.debugVm && runtime.timerCallbackCount <= 12) {
          process.stderr.write(`[timer] done tid=${tid} elapsed=${Date.now() - callbackStartedAt}\n`);
        }
      };
      id = kind === 'setInterval' ? setInterval(invoke, delayMs) : setTimeout(invoke, delayMs);
      runtime.timers.push({ id, tid, kind, delay: delayMs, stack });
      return id;
    };
    window.setTimeout = (fn, delay, ...args) => timerWrap('setTimeout', fn, delay, ...args);
    window.setInterval = (fn, delay, ...args) => timerWrap('setInterval', fn, delay, ...args);
    window.clearTimeout = clearTimeout;
    window.clearInterval = clearInterval;
    window.queueMicrotask = queueMicrotask;

    window.XMLHttpRequest = this.makeXHRClass();
    window.fetch = this.makeFetch();

    // Cloudflare orchestrate writes into this object at top-level.
    const cfSeed = this.buildChallengeSeed();
    window._cf_chl_opt = new Proxy(cfSeed, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && !prop.startsWith('__')) window.__cfOptLog.push({ op: 'get', prop, preview: runtime.previewValue(value) });
        return value;
      },
      set(target, prop, value, receiver) {
        if (typeof prop === 'string' && !prop.startsWith('__')) window.__cfOptLog.push({ op: 'set', prop, preview: runtime.previewValue(value) });
        return Reflect.set(target, prop, value, receiver);
      }
    });
    window.__CF$cv$params = window._cf_chl_opt.pp;

    // Expose constructors for instanceof/brand-ish checks.
    Object.assign(window, {
      Node: NodeShim, CharacterData: CharacterDataShim, Text: TextShim,
      Element: ElementShim, HTMLElement: HTMLElementShim, HTMLScriptElement: HTMLScriptElementShim,
      HTMLDivElement: HTMLDivElementShim, HTMLBodyElement: HTMLBodyElementShim,
      HTMLHeadElement: HTMLHeadElementShim, HTMLHtmlElement: HTMLHtmlElementShim,
      HTMLInputElement: HTMLInputElementShim, HTMLFormElement: HTMLFormElementShim, HTMLFormControlsCollection: HTMLFormControlsCollectionShim,
      HTMLIFrameElement: HTMLIFrameElementShim, HTMLImageElement: HTMLImageElementShim, HTMLCanvasElement: HTMLCanvasElementShim,
      HTMLAnchorElement: HTMLAnchorElementShim, HTMLHeadingElement: HTMLHeadingElementShim,
      HTMLParagraphElement: HTMLParagraphElementShim, HTMLStyleElement: HTMLStyleElementShim,
      Document: DocumentShim, HTMLDocument: HTMLDocumentShim, DocumentFragment: DocumentFragmentShim, ShadowRoot: ShadowRootShim,
      DOMRectReadOnly: DOMRectReadOnlyShim, DOMRect: DOMRectShim,
      CSSStyleDeclaration: CSSStyleDeclarationShim, CSS2Properties: CSS2PropertiesShim,
      CSSStyleSheet: CSSStyleSheetShim, CSSRule: CSSRuleShim,
      CanvasGradient: CanvasGradientShim, TextMetrics: TextMetricsShim, ImageData: ImageDataShim,
      OffscreenCanvasRenderingContext2D: OffscreenCanvasRenderingContext2DShim,
      NodeIterator: NodeIteratorShim,
      Storage: StorageShim, Window: WindowShim, Worker: WorkerShim, Blob: BlobShim,
    });
    window.Image = function Image(width = 0, height = 0) {
      try { runtime.context.__workerLog.push({ op: 'Image.construct', realm: 'main', width: Number(width) || 0, height: Number(height) || 0 }); } catch {}
      const image = document.createElement('img');
      image.width = Number(width) || 0;
      image.height = Number(height) || 0;
      return image;
    };
    window.Image.prototype = HTMLImageElementShim.prototype;

    // Keep common globals directly addressable in the vm context.
    setDocumentField(document, 'defaultView', window);
    const winAdd = EventTargetShim.prototype.addEventListener.bind(window);
    window.addEventListener = (type, fn, opts) => { window.__eventLog.push({ target: 'window', op: 'add', type: String(type) }); return winAdd(type, fn, opts); };
    window.removeEventListener = EventTargetShim.prototype.removeEventListener.bind(window);
    window.dispatchEvent = (evt) => { window.__eventLog.push({ target: 'window', op: 'dispatch', type: String(evt && evt.type) }); return EventTargetShim.prototype.dispatchEvent.call(window, evt); };
    Object.defineProperty(window, '__hostWebStreams', {
      configurable: true,
      enumerable: false,
      value: {
        ReadableStream: globalThis.ReadableStream,
        WritableStream: globalThis.WritableStream,
        TransformStream: globalThis.TransformStream,
        ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
        CountQueuingStrategy: globalThis.CountQueuingStrategy,
        TextEncoderStream: globalThis.TextEncoderStream,
        TextDecoderStream: globalThis.TextDecoderStream,
      },
    });
    this.vmContext = vm.createContext(window, {
      name: 'firefox-like-cloudflare-runtime',
      microtaskMode: 'afterEvaluate',
    });
    installFirefoxErrorStack(this.vmContext);
    this.installRealmJobPump(this.vmContext, 'main');
    const realmWindow = vm.runInContext(`(()=>{
      const aliases = {};
      for (const name of ['window', 'self', 'globalThis', 'top', 'parent', 'frames']) {
        aliases[name] = { value: globalThis, writable: true, enumerable: true, configurable: true };
      }
      Object.defineProperties(globalThis, aliases);

      const wrapHostConstructor = (name, Host) => {
        if (typeof Host !== 'function') return undefined;
        const Ctor = { [name]: function(...args) {
          if (!new.target) throw new TypeError("Class constructor " + name + " cannot be invoked without 'new'");
          const instance = Reflect.construct(Host, args, Host);
          Object.setPrototypeOf(instance, new.target.prototype);
          return instance;
        } }[name];
        const descriptors = {};
        for (const key of Reflect.ownKeys(Host.prototype)) {
          if (key === 'constructor') continue;
          const source = Object.getOwnPropertyDescriptor(Host.prototype, key);
          const target = { configurable: source.configurable, enumerable: source.enumerable };
          if ('value' in source) {
            target.writable = source.writable;
            target.value = typeof source.value === 'function'
              ? function(...args) { return Reflect.apply(source.value, this, args); }
              : source.value;
          } else {
            if (source.get) target.get = function() { return Reflect.apply(source.get, this, []); };
            if (source.set) target.set = function(value) { return Reflect.apply(source.set, this, [value]); };
          }
          descriptors[key] = target;
        }
        Object.defineProperties(Ctor.prototype, descriptors);
        Object.defineProperty(Ctor.prototype, 'constructor', {
          value: Ctor, writable: true, configurable: true,
        });
        return Ctor;
      };
      for (const [name, Host] of Object.entries(__hostWebStreams)) {
        const Ctor = wrapHostConstructor(name, Host);
        if (Ctor) Object.defineProperty(globalThis, name, {
          value: Ctor, writable: true, enumerable: false, configurable: true,
        });
      }
      delete globalThis.__hostWebStreams;
      const nativeJSONStringify = JSON.stringify;
      Object.defineProperty(JSON, 'stringify', {
        configurable: true,
        writable: true,
        value: function stringify(value, replacer, space) {
          const result = Reflect.apply(nativeJSONStringify, JSON, arguments);
          if (typeof result === 'string' && result.length >= 256) {
            let keys = [];
            try {
              if (value && typeof value === 'object') keys = Object.keys(value);
            } catch {}
            if (keys.length === 49 && value && Object.prototype.toString.call(value) === '[object Object]') {
              try { globalThis.__captureEncoderInput(value, { kind: 'json-stringify-object-49', length: result.length }); } catch {}
            }
            __jsonStringifyLog.push({
              length: result.length,
              keys,
              valueType: value == null ? String(value) : Object.prototype.toString.call(value),
              result,
            });
            if (__jsonStringifyLog.length > 32) __jsonStringifyLog.shift();
          }
          return result;
        },
      });
      if (__debugVmEnabled) {
        const nativeEval = eval;
        const tracedEval = function eval(source) {
          try {
            const result = (0, nativeEval)(source);
            __cfVmLog.push({
              op: 'eval.call',
              sourceType: typeof source,
              sourceString: String(source).slice(0, 500),
              resultType: typeof result,
              resultString: String(result).slice(0, 500),
              resultTag: result == null ? String(result) : Object.prototype.toString.call(result),
            });
            return result;
          } catch (error) {
            __cfVmLog.push({
              op: 'eval.throw',
              sourceType: typeof source,
              sourceString: String(source).slice(0, 500),
              errorName: error && error.name,
              errorMessage: String(error && error.message || error).slice(0, 500),
            });
            throw error;
          }
        };
        Object.defineProperty(tracedEval, 'toString', {
          value: () => 'function eval() { [native code] }',
          configurable: true,
        });
        Object.defineProperty(globalThis, 'eval', {
          value: tracedEval, writable: true, enumerable: false, configurable: true,
        });
      }
      return globalThis;
    })()`, this.vmContext);
    setDocumentField(document, 'defaultView', realmWindow);
    // Calls made through the VM realm use realmWindow as `this`, while the
    // exposed addEventListener wrapper is bound to the host WindowShim.
    // Alias their EventTarget registry so dispatch crosses the realm boundary.
    eventTargetState.set(realmWindow, eventTargetState.get(window));
    this.realmContexts.set(document, { context: this.vmContext, global: realmWindow });
    runtime.noteEnv('Window global aliases', 'realm-defined', 'Node vm context initialization', {
      members: ['window', 'self', 'globalThis', 'top', 'parent', 'frames'],
      identity: 'all aliases reference the context realm global object',
    });
    runtime.noteEnv('WHATWG Streams', 'host-backed-realm-wrapper', 'Node standard Web Streams implementation', {
      constructors: ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream'],
      prototype: 'methods and accessors are defined on prototypes created in the page realm',
    });
    return realmWindow;
  }

  previewValue(value) {
    try {
      if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (Array.isArray(value)) return { type: 'array', length: value.length, first: value.slice(0, 3).map(v => this.previewValue(v)) };
      if (ArrayBuffer.isView(value)) return { type: value.constructor?.name, length: value.length, byteLength: value.byteLength };
      if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
      return { type: typeof value, ctor: value?.constructor?.name || null, keys: Object.keys(value).slice(0, 8) };
    } catch (e) { return { error: String(e?.message || e) }; }
  }

  messageSnapshot(value) {
    const snapshot = (item, depth = 0) => {
      // JSON.stringify omits object properties whose value is undefined. Keep
      // an explicit marker in trace snapshots so dynamic message slots remain
      // distinguishable from a missing own property.
      if (item === undefined) return { type: 'undefined' };
      if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
      if (typeof item === 'string') return item.length <= 256
        ? item
        : (() => {
          try { this.context.__workerLog.push({ op: 'message.long-string', length: item.length, text: item.slice(0, 4000) }); } catch {}
          return {
            type: 'string', length: item.length, sha256: sha256Bytes(item),
            prefix: item.slice(0, 80), suffix: item.slice(-80),
            line_count: item.split('\n').length,
          };
        })();
      if (depth >= 3) return this.previewValue(item);
      if (Array.isArray(item)) return item.slice(0, 16).map(value => snapshot(value, depth + 1));
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return this.previewValue(item);
      const out = {};
      // Challenge message objects currently carry more than sixteen fields.
      // Keep the snapshot structural and value-redacted, but retain all
      // ordinary message keys so missing browser contracts are diagnosable.
      for (const key of Object.keys(item).slice(0, 64)) {
        try { out[key] = snapshot(item[key], depth + 1); }
        catch (error) { out[key] = { error: String(error?.message || error) }; }
      }
      return out;
    };
    return snapshot(value);
  }

  makeXHRClass(baseUrl = this.location.href, realmPerformance = this.context && this.context.performance) {
    const runtime = this;
    return class XMLHttpRequestShim extends EventTargetShim {
      constructor() {
        super();
        this.__runtime = runtime;
        this.readyState = 0;
        this.status = 0;
        this.statusText = '';
        this.responseText = '';
        this.response = '';
        this.responseType = '';
        this.responseURL = '';
        this.responseHeaders = new Map();
        this.requestHeaders = {};
        this.onreadystatechange = null;
        this.onloadstart = null;
        this.onprogress = null;
        this.onload = null;
        this.onloadend = null;
        this.onerror = null;
        this.onabort = null;
        this.ontimeout = null;
        this.timeout = 0;
        this.withCredentials = false;
      }
      open(method, url, async = true, user, password) {
        const resolvedUrl = new URL(String(url), baseUrl).href;
        // Endpoint-override experiment: the frame's submit routine holds the /fo/ URL
        // (see frameSubmitFoUrl) but rewrites the XHR to /eb/.../chl_api_m before open.
        // Restore the /fo/ endpoint to test whether the server accepts the same body there.
        let effectiveUrl = resolvedUrl;
        if (runtime.submitEndpointOverride === 'fo' && /\/h\/b\/eb\/[^/]+\/[^/]+\/chl_api_m$/.test(new URL(resolvedUrl).pathname)) {
          const override = runtime.frameSubmitFoUrl;
          if (override) {
            effectiveUrl = new URL(override, baseUrl).href;
            runtime.context.__workerLog.push({ op: 'xhr.endpoint-override', from: resolvedUrl, to: effectiveUrl });
          }
        }
        runtime.context.__xhrLog.push({ op: 'open', method: String(method || 'GET').toUpperCase(), url: effectiveUrl, stack: String(new Error().stack || '').split('\n').slice(1, 5).join('\n') });
        runtime.context.__workerLog.push({ op: 'xhr.open', method: String(method || 'GET').toUpperCase(), url: effectiveUrl });
        this.method = String(method || 'GET').toUpperCase();
        this.url = effectiveUrl;
        this.async = async !== false;
        this.user = user;
        this.password = password;
        this.readyState = 1;
        this.dispatchEvent({ type: 'readystatechange' });
      }
      setRequestHeader(k, v) { this.requestHeaders[String(k)] = String(v); runtime.context.__xhrLog.push({ op: 'header', name: String(k), value: String(v) }); }
      getAllResponseHeaders() {
        if (this.readyState < 2) return '';
        return [...this.responseHeaders.entries()].map(([name, value]) => `${name}: ${value}\r\n`).join('');
      }
      getResponseHeader(name) {
        if (this.readyState < 2) return null;
        return this.responseHeaders.get(String(name).toLowerCase()) ?? null;
      }
      overrideMimeType() {}
      abort() {}
      send(body = '') {
        const requestStart = realmPerformance && typeof realmPerformance.now === 'function' ? realmPerformance.now() : 0;
        runtime.context.__xhrLog.push({ op: 'send', method: this.method, url: this.url, body_size: runtime.bodyInfo(body).size, header_names: Object.keys(this.requestHeaders) });
        if (/\/cdn-cgi\/challenge-platform\/.*\/(eb|fo)\//.test(new URL(this.url).pathname)) {
          runtime.context.__workerLog.push({
            op: 'xhr.request-body', url: this.url,
            body_text: typeof body === 'string' ? body : String(body),
          });
        }
        const rec = runtime.recordRequest('xhr', this.method, this.url, this.requestHeaders, body);
        if (runtime.opts.captureOnly && /\/cdn-cgi\/challenge-platform\/.*\/fo\//.test(new URL(this.url).pathname)) {
          runtime.scenarioDeadline = Date.now();
          const captured = new Error('target request captured');
          captured.__cfTargetCaptured = true;
          throw captured;
        }
        const vector = runtime.findVector(this.method, this.url);
        this.status = vector?.response?.status || 200;
        this.statusText = 'OK';
        this.responseURL = this.url;
        const vectorResponseBody = vector?.response?.store_path ? maybeRead(vector.response.store_path) : '';
        this.responseText = runtime.opts.xhrBridge ? '' : vectorResponseBody;
        this.response = this.responseText;
        const dispatchProgress = (type, loaded, total) => {
          const event = {
            type,
            // The challenge XHRs are chunked without a Content-Length. Firefox
            // therefore exposes total=0 and lengthComputable=false even after
            // the complete body has arrived.
            lengthComputable: Number.isFinite(total) && total > 0,
            loaded: Math.max(0, Number(loaded) || 0),
            total: Math.max(0, Number(total) || 0),
          };
          runtime.context.__xhrLog.push({
            op: type,
            method: this.method,
            url: this.url,
            loaded: event.loaded,
            total: event.total,
            length_computable: event.lengthComputable,
            response_size: Buffer.byteLength(this.responseText),
          });
          this.dispatchEvent(event);
        };
        const dispatchReadyState = readyState => {
          this.readyState = readyState;
          runtime.context.__xhrLog.push({
            op: 'readystatechange',
            method: this.method,
            url: this.url,
            ready_state: readyState,
            status: this.status,
            response_size: Buffer.byteLength(this.responseText),
            ...(readyState === 2 ? { response_headers: Object.fromEntries(this.responseHeaders) } : {}),
          });
          this.dispatchEvent({ type: 'readystatechange' });
        };
      const finish = () => {
          this.readyState = 4;
          rec.replay_response = vector
            ? { status: this.status, size: this.responseText.length, sha256: sha256Bytes(this.responseText), matched_trace_request_id: vector.request_id, matched_origin_call_id: vector.origin_call_id }
            : { status: this.status, size: 0, missing_vector: true };
          for (const type of ['readystatechange', 'load', 'loadend']) {
            try {
              if (type === 'readystatechange') dispatchReadyState(4);
              else dispatchProgress(type, Buffer.byteLength(this.responseText), Buffer.byteLength(this.responseText));
            } catch (error) {
              if (error && error.__cfTargetCaptured) runtime.targetRequestCaptured = true;
              else runtime.recordError(`xhr.${type}:${this.method} ${this.url}`, error);
              break;
            }
          }
        };
        if (runtime.opts.xhrBridge) {
          dispatchProgress('loadstart', 0, 0);
          let settled = false;
          let timeoutId = null;
          const timeoutMs = Math.max(0, Number(this.timeout) || 0);
          const settleOnce = callback => {
            if (settled) return false;
            settled = true;
            if (timeoutId !== null) clearTimeout(timeoutId);
            callback();
            return true;
          };
          if (timeoutMs > 0) {
            timeoutId = setTimeout(() => {
              settleOnce(() => {
                this.status = 0;
                this.statusText = '';
                this.responseText = '';
                this.response = '';
                this.readyState = 4;
                rec.bridge_response = { status: 0, size: 0, timeout: true, timeout_ms: timeoutMs };
                runtime.context.__xhrLog.push({
                  op: 'timeout', method: this.method, url: this.url,
                  timeout_ms: timeoutMs, ready_state: this.readyState,
                });
                this.dispatchEvent({ type: 'timeout' });
                dispatchProgress('loadend', 0, 0);
              });
            }, timeoutMs);
          }
          const bridgeBody = typeof body === 'string' ? body : Buffer.from(body || '').toString('utf8');
          const operation = global.fetch(runtime.opts.xhrBridge, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: this.method, url: this.url, realm_origin: new URL(baseUrl).origin, realm_url: new URL(baseUrl).href, headers: this.requestHeaders, body: bridgeBody }),
          }).then(response => response.json()).then(async result => {
            if (settled) return;
            this.status = Number(result.status || 0);
            this.statusText = String(result.statusText || '');
            this.responseURL = String(result.url || this.url);
            this.responseHeaders = new Map(Object.entries(result.headers || {}).map(([name, value]) => [String(name).toLowerCase(), String(value)]));
            const responseSetCookie = Array.isArray(result.setCookie)
              ? result.setCookie.map(String)
              : result.setCookie == null ? [] : [String(result.setCookie)];
            // A server may serialize multiple Set-Cookie values into one
            // captured header. Match the cookie token at a delimiter rather
            // than requiring it to be the first serialized value.
            const responseBody = String(result.body || '');
            const responseBytes = Buffer.byteLength(responseBody);
            const commitsNavigation = responseSetCookie.some(value => /(?:^|[,;]\s*)cf_clearance=/i.test(value));
            const responseDelay = Math.max(0, Number(runtime.opts.bridgeResponseDelayMs) || 0);
            const requestOrigin = (() => { try { return new URL(this.url).origin; } catch { return ''; } })();
            const realmOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();
            // The headed page applies the XHR timeout/retry contract based on
            // elapsed time, not decoded response size.  Challenge variants
            // routinely return sub-500KiB bodies, so gating the delay on size
            // skips the dynamic 5s/10s/15s retry sequence for those variants.
            // The headed trace's retry timing belongs to the parent/origin
            // challenge channel. Turnstile's cross-origin frame XHRs return
            // normally (including small bodies) and must not inherit that
            // artificial delay, otherwise their 5s/10s/15s XHR timers all
            // expire before the response can settle.
            const parentOrigin = (() => { try { return new URL(runtime.location.href).origin; } catch { return ''; } })();
            runtime.context.__xhrLog.push({ op: 'bridge-origin-classification', url: this.url, request_origin: requestOrigin, realm_origin: realmOrigin, parent_origin: parentOrigin, delayed: !!(responseDelay && requestOrigin === realmOrigin && realmOrigin === parentOrigin) });
            if (responseDelay && requestOrigin === realmOrigin && realmOrigin === parentOrigin) {
              runtime.context.__xhrLog.push({ op: 'bridge-response-delay', url: this.url, delay_ms: responseDelay, body_size: Buffer.byteLength(responseBody) });
              await new Promise(resolve => setTimeout(resolve, responseDelay));
            }
            if (settled) return;
            settleOnce(() => {
              try {
              dispatchReadyState(2);
              // Firefox exposes the first incremental response chunk followed by
              // the completed body for these challenge XHRs. Keep the contract
              // structural; the bytes remain bridge-provided and request-dynamic.
              const progressFractions = runtime.opts.xhrProgressMode === 'complete-only'
                ? [1]
                : [1 / 3, 2 / 3, 1];
              for (const fraction of progressFractions) {
                this.responseText = responseBody.slice(0, Math.ceil(responseBody.length * fraction));
                this.response = this.responseText;
                dispatchReadyState(3);
                dispatchProgress('progress', Buffer.byteLength(this.responseText), 0);
              }
              if (realmPerformance && performanceState.has(realmPerformance)) {
                const responseEnd = realmPerformance.now();
                const entry = new PerformanceResourceTimingShim({
                  name: this.url,
                  initiatorType: 'xmlhttprequest',
                  startTime: requestStart,
                  duration: Math.max(0, responseEnd - requestStart),
                  requestStart,
                  responseStart: responseEnd,
                  responseEnd,
                  transferSize: Buffer.byteLength(this.responseText) + 300,
                  encodedBodySize: Buffer.byteLength(this.responseText),
                });
                appendPerformanceEntry(realmPerformance, entry);
              }
              rec.bridge_response = { status: this.status, size: Buffer.byteLength(this.responseText), sha256: sha256Bytes(this.responseText) };
              runtime.context.__workerLog.push({ op: 'xhr.final-response', url: this.url, body_size: responseBytes, has_clearance: commitsNavigation });
              if (commitsNavigation) {
                runtime.afterFinalResponse = true;
                // In the headed Firefox chain the successful second-round
                // response clears the retry marker before the completion
                // continuation builds its navigation form. Mirror that
                // cookie transition using the live cookie name only.
                try { runtime.context.document.cookie = 'cf_chl_rc_ni=; Max-Age=-99999999; Secure; SameSite=None; Partitioned'; } catch {}
                // Completion is evaluated by the page's continuation after
                // the XHR event has settled. Do not let a stale retry marker
                // or delayed Turnstile diagnostic keep the realm in retry.
                runtime.context.__workerLog.push({ op: 'clearance-completion-ready', cookie: String(runtime.context.document.cookie || '') });
              }
              // Native XHR completion events are dispatched as a later task,
              // after the bridge Promise continuation has returned. Keeping
              // them synchronous can make the challenge's response state
              // machine observe a re-entrant XHR callback and skip navigation.
              setTimeout(finish, 0);
              // The native page commits a top-level navigation after the
              // clearance response. Its old realm is then destroyed, so
              // callbacks queued by the completed challenge document do not
              // execute in that realm. Model that lifecycle boundary from the
              // response cookie contract rather than any generated identifier.
              if (commitsNavigation && !runtime.hadClearanceAtBootstrap) {
                runtime.context.__xhrLog.push({ op: 'navigation-commit', url: runtime.location.href, reason: 'clearance-response' });
                // Keep the current realm alive long enough for the completion
                // continuation to build and submit its dynamic form.  The
                // browser tears down the old document only after navigation;
                // setting scenarioDeadline here races that continuation.
              }
              } catch (error) {
                runtime.recordError(`xhr.completion:${this.method} ${this.url}`, error);
                runtime.context.__workerLog.push({ op: 'xhr.completion-error', message: String(error?.message || error), stack: String(error?.stack || '').slice(0, 2000) });
              }
            });
          }).catch(error => {
            if (settled) return;
            settleOnce(() => {
              this.status = 0;
              this.statusText = '';
              this.responseText = '';
              this.response = '';
              try {
                this.dispatchEvent({ type: 'error' });
                dispatchProgress('loadend', 0, 0);
              } catch (eventError) {
                runtime.recordError(`xhr.error:${this.method} ${this.url}`, eventError);
              }
              runtime.recordError(`xhr.bridge:${this.method} ${this.url}`, error);
            });
          });
          runtime.pendingAsync.add(operation);
          operation.finally(() => runtime.pendingAsync.delete(operation));
          return;
        }
        setTimeout(finish, 0);
      }
    };
  }

  makeFetch(baseUrl = this.location.href) {
    const runtime = this;
    return async function fetchShim(input, init = {}) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
      const headers = init.headers instanceof HeadersShim ? init.headers.toJSON() : (init.headers || {});
      const body = init.body || '';
      const abs = new URL(url, baseUrl).href;
      const rec = runtime.recordRequest('fetch', method, abs, headers, body);
      if (runtime.opts.xhrBridge) {
        const operation = global.fetch(runtime.opts.xhrBridge, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            method, url: abs, realm_origin: new URL(baseUrl).origin, realm_url: new URL(baseUrl).href, headers,
            body: typeof body === 'string' ? body : Buffer.from(body || '').toString('utf8'),
            mode: init.mode,
            credentials: init.credentials,
            cache: init.cache,
            redirect: init.redirect,
            referrerPolicy: init.referrerPolicy,
          }),
        }).then(response => response.json());
        runtime.pendingAsync.add(operation);
        try {
          const result = await operation;
          if (result.error) throw new TypeError(String(result.error));
          const bytes = result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : Buffer.from(String(result.body || ''), 'utf8');
          rec.bridge_response = { status: Number(result.status || 0), size: bytes.length, sha256: sha256Bytes(bytes) };
          return new ResponseShim(bytes, {
            status: Number(result.status || 0),
            statusText: String(result.statusText || ''),
            headers: result.headers || {},
            url: String(result.url || abs),
            type: String(result.type || (new URL(abs).origin === new URL(baseUrl).origin ? 'basic' : 'cors')),
            redirected: !!result.redirected || String(result.url || abs) !== abs,
          });
        } finally {
          runtime.pendingAsync.delete(operation);
        }
      }
      if (runtime.opts.liveNetwork && global.fetch) {
        const resp = await global.fetch(abs, init);
        rec.live_status = resp.status;
        return resp;
      }
      return new ResponseShim('', { status: 200, url: abs });
    };
  }

  bodyInfo(body) {
    let raw;
    if (body == null) raw = Buffer.alloc(0);
    else if (Buffer.isBuffer(body)) raw = body;
    else if (body instanceof ArrayBuffer) raw = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) raw = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else raw = Buffer.from(String(body), 'utf8');
    return { size: raw.length, sha256: sha256Bytes(raw), preview: raw.toString('utf8', 0, Math.min(raw.length, 180)) };
  }

  recordRequest(transport, method, url, headers, body) {
    const bodyInfo = this.bodyInfo(body);
    if (this.opts.captureOnly) {
      if (typeof body === 'string') bodyInfo.value = body;
      else if (Buffer.isBuffer(body)) bodyInfo.base64 = body.toString('base64');
      else if (body instanceof ArrayBuffer) bodyInfo.base64 = Buffer.from(body).toString('base64');
      else if (ArrayBuffer.isView(body)) bodyInfo.base64 = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
      else bodyInfo.value = String(body ?? '');
    }
    const rec = {
      seq: this.generatedRequests.length + 1,
      transport, method, url,
      path: new URL(url).pathname,
      headers: { ...headers },
      body: bodyInfo,
      cf_chl: headers['cf-chl'] || headers['CF-CHL'] || null,
      cf_chl_ra: headers['cf-chl-ra'] || headers['CF-CHL-RA'] || null,
      idempotency_key: headers['Idempotency-Key'] || headers['idempotency-key'] || null,
      matched_trace: this.matchTraceShape(method, url, headers, bodyInfo),
    };
    this.generatedRequests.push(rec);
    return rec;
  }

  findVector(method, url) {
    const u = new URL(url);
    return (this.vector.xhr_vectors || []).find(v => v.method === method && v.url === url)
      || (this.vector.xhr_vectors || []).find(v => v.method === method && new URL(v.url).pathname === u.pathname)
      || null;
  }

  matchTraceShape(method, url, headers, bodyInfo) {
    const u = new URL(url);
    let best = null;
    for (const v of this.vector.xhr_vectors || []) {
      const vu = new URL(v.url);
      let score = 0;
      if (v.method === method) score += 2;
      if (vu.origin === u.origin) score += 2;
      if (vu.pathname === u.pathname) score += 4;
      if (headers['cf-chl'] && headers['cf-chl'] === v.headers?.['cf-chl']) score += 2;
      if (headers['cf-chl-ra'] && headers['cf-chl-ra'] === v.headers?.['cf-chl-ra']) score += 1;
      if (v.body?.size && Math.abs(v.body.size - bodyInfo.size) < Math.max(256, v.body.size * 0.25)) score += 1;
      if (!best || score > best.score) best = { score, request_id: v.request_id, origin_call_id: v.origin_call_id, trace_url: v.url, trace_body_size: v.body?.size, trace_cf_chl_len: v.headers?.['cf-chl']?.length };
    }
    return best;
  }

  onScriptInserted(node) {
    const src = node.src || node.getAttribute('src') || '';
    this.scriptLoads.push({ seq: this.scriptLoads.length + 1, src, tag: node.tagName });
    if (!src) return;
    const document = node.ownerDocument || this.context.document;
    const realm = this.realmContexts.get(document) || { context: this.vmContext, global: this.context };
    const documentUrl = document.location?.href || this.location.href;
    const abs = new URL(src, documentUrl).href;
    const exact = this.scriptByUrl.get(abs);
    const loose = exact || Array.from(this.scriptByUrl.values()).find(s => abs.includes(new URL(s.url).pathname) || s.url.includes(abs));
    const finish = script => {
      this.executeScript(script, 'inserted', { ...realm, document, currentScript: node });
      setTimeout(() => node.dispatchEvent({ type: 'load' }), 0);
    };
    if (this.opts.xhrBridge) {
      const realmPerformance = document.defaultView?.performance;
      const resourceStart = realmPerformance && performanceState.has(realmPerformance)
        ? realmPerformance.now()
        : 0;
      const operation = global.fetch(this.opts.xhrBridge, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'script-resource', url: abs, document_url: documentUrl }),
      }).then(response => response.json()).then(result => {
        if (result.error) throw new Error(result.error);
        const code = result.bodyBase64
          ? Buffer.from(result.bodyBase64, 'base64').toString('utf8')
          : String(result.body || '');
        if (!code) throw new Error('Firefox bridge returned an empty script resource');
        let scriptResourceEntry = null;
        if (realmPerformance && performanceState.has(realmPerformance)) {
          const responseEnd = realmPerformance.now();
          const encodedBodySize = Math.max(0, Number(result.encodedBodySize) || Buffer.byteLength(code));
          const decodedBodySize = Buffer.byteLength(code);
          scriptResourceEntry = new PerformanceResourceTimingShim({
            name: String(result.url || abs), initiatorType: 'script', startTime: resourceStart,
            duration: Math.max(0, responseEnd - resourceStart), fetchStart: resourceStart,
            requestStart: 0,
            responseStart: 0,
            responseEnd,
            transferSize: encodedBodySize + 300,
            encodedBodySize,
            decodedBodySize,
            responseStatus: Number(result.status || 0),
            contentType: String(result.headers?.['content-type'] || ''),
          });
          appendPerformanceEntry(realmPerformance, scriptResourceEntry);
        }
        const bytes = Buffer.from(code, 'utf8');
        finish({
          url: String(result.url || abs), original_url: abs,
          code, sha256: result.sha256 || sha256Bytes(bytes),
          artifact_path: result.artifact_path || '',
        });
        if (scriptResourceEntry) {
          const state = performanceEntryState.get(scriptResourceEntry);
          const completedAt = realmPerformance.now();
          const completedDuration = Math.max(0, completedAt - resourceStart);
          if (completedDuration >= state.duration) {
            state.responseEnd = completedAt;
            state.duration = completedDuration;
          }
        }
      }).catch(error => {
        this.recordError(`script.bridge:${abs}`, error);
        node.dispatchEvent({ type: 'error' });
      });
      this.pendingAsync.add(operation);
      operation.finally(() => this.pendingAsync.delete(operation));
      return;
    }
    if (loose && !this.executedScripts.has(loose.sha256)) setTimeout(() => finish(loose), 0);
    else setTimeout(() => node.dispatchEvent({ type: 'load' }), 0);
  }

  onImageSourceChanged(node, source) {
    const document = node?.ownerDocument;
    const documentUrl = document?.location?.href || this.location.href;
    const abs = new URL(String(source), documentUrl).href;
    const state = getNodeState(node);
    if (state.resourceStarted && state.currentSrc === abs) return;
    state.resourceStarted = true;
    state.currentSrc = abs;
    state.complete = false;
    const rec = this.recordRequest('resource', 'GET', abs, {
      accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
    }, '');
    const finish = (ok, result = {}) => {
      state.complete = true;
      let imageWidth = 0;
      let imageHeight = 0;
      const bodyBytes = result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : Buffer.alloc(0);
      // PNG dimensions are part of the native image decode contract. Keep the
      // parser format-generic and fall back only when the bridge omits bytes.
      if (bodyBytes.length >= 24 && bodyBytes.readUInt32BE(0) === 0x89504e47 && bodyBytes.toString('ascii', 12, 16) === 'IHDR') {
        imageWidth = bodyBytes.readUInt32BE(16);
        imageHeight = bodyBytes.readUInt32BE(20);
      }
      state.naturalWidth = ok ? (imageWidth || 1) : 0;
      state.naturalHeight = ok ? (imageHeight || 1) : 0;
      state.width = state.naturalWidth;
      state.height = state.naturalHeight;
      // Resource completion settles first; Firefox dispatches the element
      // event from a later DOM task instead of re-entering the bridge promise.
      setTimeout(() => {
        try {
          const EventCtor = document?.defaultView?.Event;
          const event = typeof EventCtor === 'function'
            ? new EventCtor(ok ? 'load' : 'error', { isTrusted: true })
            : { type: ok ? 'load' : 'error', isTrusted: true };
          node.dispatchEvent(event);
        } catch (error) { this.recordError(`image.${ok ? 'load' : 'error'}:${abs}`, error); }
      }, 0);
    };
    if (!this.opts.xhrBridge) return setTimeout(() => finish(true), 0);
    const operation = global.fetch(this.opts.xhrBridge, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'resource', method: 'GET', url: abs,
        realm_origin: new URL(documentUrl).origin, realm_url: documentUrl,
        headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
        body: '', mode: 'no-cors', credentials: 'include',
      }),
    }).then(response => response.json()).then(result => {
      if (result.error) throw new Error(result.error);
      const bytes = result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : Buffer.from(String(result.body || ''), 'utf8');
      rec.bridge_response = { status: Number(result.status || 0), size: bytes.length, sha256: sha256Bytes(bytes) };
      finish(Number(result.status || 0) >= 200 && Number(result.status || 0) < 400, result);
    }).catch(error => { this.recordError(`image.bridge:${abs}`, error); finish(false); });
    this.pendingAsync.add(operation);
    operation.finally(() => this.pendingAsync.delete(operation));
  }

  executeScript(script, reason = 'direct', realm = {}) {
    if (!script || !script.code) return;
    const document = realm.document || this.context.document;
    const previousCurrentScript = document.currentScript;
    try {
      const realmContext = realm.context || this.vmContext;
      const cs = realm.currentScript || document.createElement('script');
      if (!realm.currentScript) {
        cs.src = script.url;
        cs.setAttribute('src', script.url);
      }
      setDocumentField(document, 'currentScript', cs);
      if (!document.scripts.includes(cs)) document.scripts.push(cs);
      let code = script.code;
      if (script.url.includes('/orchestrate/') && this.opts.debugPatch) {
        code = code.replace(
          'void 0===tO?ti():ti[j2(BK.ti)](tO)',
          'void 0===tO?(typeof ti!==`function`&&K.__cfDebug&&K.__cfDebug({op:`badcall0`,ti:ti,tP:tP,tM:tM,tT:tT,th:th,to:to}),ti()):ti[j2(BK.ti)](tO)'
        );
        code = code.replace(
          'D[j2(BK.tp)](ti,to,tr):ti[j2(BK.ti)](tO,to,tr)',
          'D[j2(BK.tp)](ti,to,tr):((typeof ti!==`function`&&K.__cfDebug&&K.__cfDebug({op:`badcall2`,ti:ti,tP:tP,tM:tM,tT:tT,th:th,to:to})),ti[j2(BK.ti)](tO,to,tr))'
        );
        code = code.replace(
          '"aLQPH":function(tu,tF){return tu(tF)}',
          '"aLQPH":function(tu,tF){if(typeof tu!==`function`&&K.__cfDebug)K.__cfDebug({op:`aLQPH`,ti:tu,arg:tF});tu=typeof tu===`function`?tu:K.__cfResolveCallable(tu);return tu(tF)}'
        );
        code = code.replace(
          '"dEpzd":function(tu,tF){return tu(tF)}',
          '"dEpzd":function(tu,tF){if(typeof tu!==`function`&&K.__cfDebug)K.__cfDebug({op:`dEpzd`,ti:tu,arg:tF});tu=typeof tu===`function`?tu:K.__cfResolveCallable(tu);return tu(tF)}'
        );
        code = code.replace(
          'tr[tO]=ti,tr[to][tr[tM]]=tr[tV]}function tH',
          'tr[tO]=ti,(void 0===tr[to]&&K.__cfDebug&&K.__cfDebug({op:`qp.set-undef`,ti:tr[to],slot:to,key:tr[tM],val:tr[tV],baseSlot:tM,valSlot:tV})),void 0===tr[to]&&(tr[to]=K),tr[to][tr[tM]]=tr[tV]}function tH'
        );
        code = code.replace(
          'tr[tO]=ti,tr[to]=tr[tV][tM]}function i',
          'tr[tO]=ti,(void 0===tr[tV]&&K.__cfDebug&&K.__cfDebug({op:`qk.get-undef`,ti:tr[tV],slot:tV,key:tM,outSlot:to})),void 0===tr[tV]&&(tr[tV]=K),tr[to]=tr[tV][tM]}function i'
        );
        code = code.replace(
          'j[D[j9(RS.tF)](tO,tT)]=ti===void 0?to():to[j9(RS.tE)](ti)}',
          'j[D[j9(RS.tF)](tO,tT)]=ti===void 0?((typeof to!==`function`&&K.__cfDebug&&K.__cfDebug({op:`ty.call0`,ti:to})),to=typeof to===`function`?to:K.__cfResolveCallable(to),to()):to[j9(RS.tE)](ti)}'
        );
        code = code.replace(
          'j[D[j9(RS.tT)](tO,tT)]=D[j9(RS.tu)](ti,void 0)?D[j9(RS.tJ)](to,tr):to[j9(RS.tL)](ti,tr)',
          'j[D[j9(RS.tT)](tO,tT)]=D[j9(RS.tu)](ti,void 0)?((typeof to!==`function`&&K.__cfDebug&&K.__cfDebug({op:`ty.call1`,ti:to,arg:tr})),to=typeof to===`function`?to:K.__cfResolveCallable(to),D[j9(RS.tJ)](to,tr)):to[j9(RS.tL)](ti,tr)'
        );
      }
      if (script.url.includes('/orchestrate/') && this.opts.debugVm) {
        const replaceVmProbe = (name, needle, replacement) => {
          const count = code.split(needle).length - 1;
          if (count === 1) code = code.replace(needle, replacement);
          this.vmProbePatches.push({ name, count, applied: count === 1, script: script.url });
        };
        const zeroArgHelperPattern = /(["'`])([^"'`]+)\1:function\(([A-Za-z_$][\w$]*)\)\{return \3\(\)\}/g;
        let zeroArgHelperCount = 0;
        code = code.replace(zeroArgHelperPattern, (match, quote, key, argument) => {
          zeroArgHelperCount += 1;
          return `${quote}${key}${quote}:function(${argument}){typeof ${argument}!==\`function\`&&globalThis.__cfVmLog.push({op:\`call.zero-arg\`,pc:globalThis.__cfVmCurrentPc,helperKey:${JSON.stringify(key)},callableType:typeof ${argument},callableString:String(${argument}).slice(0,160),callableTag:${argument}==null?String(${argument}):Object.prototype.toString.call(${argument}),registerWrites:(globalThis.__cfVmRegisterWrites||[]).slice(-160),stack:(new Error).stack.split(\`\\n\`).slice(1,10).join(\`\\n\`)});return ${argument}()}`;
        });
        this.vmProbePatches.push({
          name: 'call.zero-arg-helpers',
          count: zeroArgHelperCount,
          applied: zeroArgHelperCount > 0,
          script: script.url,
        });
        const dispatcherStateDecode = 'uI=this.g,uF=this.h,uq=this.j';
        const dispatcherStateProbe = 'this.g&&this.g.__cfVmRegisterProxy||(this.g=new Proxy(this.g,{get:function(t,p,r){return Reflect.get(t,p,r)},set:function(t,p,v,r){if(globalThis.__cfVmRegisterWrites){let s;try{s=v==null?String(v):typeof v===`string`?v.slice(0,160):typeof v===`object`||typeof v===`function`?Object.prototype.toString.call(v)+` keys=`+Object.getOwnPropertyNames(v).slice(0,16).join(`,`):String(v)}catch(e){s=`<preview-error>`}globalThis.__cfVmRegisterWrites.push({pc:globalThis.__cfVmCurrentPc,slot:String(p),type:typeof v,preview:s,stack:(new Error).stack.split(`\\n`).slice(2,6).join(`\\n`)}),globalThis.__cfVmRegisterWrites.length>2000&&globalThis.__cfVmRegisterWrites.shift()}return Reflect.set(t,p,v,r)}}),Object.defineProperty(this.g,`__cfVmRegisterProxy`,{value:true}),globalThis.__cfVmRegisterWrites=globalThis.__cfVmRegisterWrites||[]),uI=this.g,uF=this.h,uq=this.j';
        replaceVmProbe('dispatcher.register-writes', dispatcherStateDecode, dispatcherStateProbe);
        replaceVmProbe(
          'dispatcher.pc.fast',
          'if(uN=uI[uq],uN!==uN)return uI[ug];switch(',
          'if(uN=uI[uq],globalThis.__cfVmCurrentPc=uN,uN!==uN)return uI[ug];switch('
        );
        replaceVmProbe(
          'dispatcher.pc.try',
          'if(uS=uI[uq],uS!==uS)return uI[ug];switch(',
          'if(uS=uI[uq],globalThis.__cfVmCurrentPc=uS,uS!==uS)return uI[ug];switch('
        );
        const propertyGetDecode = 'uE[uF]=uq,uE[un]=uE[uo][uE[uX]]}function s(';
        const propertyGetProbe = 'uE[uF]=uq,(void 0===uE[uo][uE[uX]]&&globalThis.__cfVmLog.push({op:`o.get`,pc:globalThis.__cfVmCurrentPc,destSlot:un,sourceSlot:uo,keySlot:uX,keyType:typeof uE[uX],keyString:String(uE[uX]).slice(0,160),sourceType:typeof uE[uo],sourceTag:uE[uo]==null?String(uE[uo]):Object.prototype.toString.call(uE[uo]),sourceString:String(uE[uo]).slice(0,160),sourceKeys:uE[uo]&&(typeof uE[uo]===`object`||typeof uE[uo]===`function`)?Object.getOwnPropertyNames(uE[uo]).slice(0,96):[],sourceIsGlobalThis:uE[uo]===globalThis,sourceHasOwnKey:uE[uo]!=null&&Object.prototype.hasOwnProperty.call(uE[uo],uE[uX]),sourceOwnDescriptor:uE[uo]==null?null:Object.getOwnPropertyDescriptor(uE[uo],uE[uX]),sourceProtoDescriptor:uE[uo]==null||Object.getPrototypeOf(uE[uo])==null?null:Object.getOwnPropertyDescriptor(Object.getPrototypeOf(uE[uo]),uE[uX]),globalValueType:typeof globalThis[uE[uX]],sourceProto:uE[uo]==null?null:Object.prototype.toString.call(Object.getPrototypeOf(uE[uo]))})),uE[un]=uE[uo][uE[uX]]}function s(';
        replaceVmProbe('o.get', propertyGetDecode, propertyGetProbe);
        const capabilityPrototypeDecode = 'return O[yQ(Wo.uA)][yQ(Wo.um)][yQ(Wo.uP)]===undefined?';
        const capabilityPrototypeProbe = 'return globalThis.__cfVmLog.push({op:`rH.prototype`,ctorKey:yQ(Wo.uA),prototypeKey:yQ(Wo.um),memberKey:yQ(Wo.uP),ctorType:typeof O[yQ(Wo.uA)],globalKeys:Object.getOwnPropertyNames(O).slice(0,96)}),O[yQ(Wo.uA)][yQ(Wo.um)][yQ(Wo.uP)]===undefined?';
        replaceVmProbe('rH.prototype', capabilityPrototypeDecode, capabilityPrototypeProbe);
        const callDecode = 'HA=Ht===void 0?HA:Ht[HA],H[zC(bT.Hv)](Hk,0)';
        const callProbe = 'globalThis.__cfVmPending={op:`H5.decode`,pc:HW,base:Hw,keySlot:HL,receiverSlot:HI^Ht,callableSlot:HA^HI,registerLength:T.length,receiverRegisterType:typeof T[HI^Ht],receiverRegisterString:String(T[HI^Ht]).slice(0,160),callableRegisterType:typeof T[HA^HI],callableRegisterString:String(T[HA^HI]).slice(0,160),receiverRaw:T[HI^Ht],keyRaw:T[HA^HI]},HA=Ht===void 0?HA:Ht[HA],typeof HA!==`function`&&globalThis.__cfVmLog.push({...globalThis.__cfVmPending,op:`H5.call`,argc:Hk,decodedReceiver:Ht,decodedKey:HA,callableType:typeof HA,callableString:String(HA).slice(0,160),receiverType:typeof Ht,receiverTag:Ht==null?String(Ht):Object.prototype.toString.call(Ht),receiverKeys:Ht&&typeof Ht===`object`?Object.getOwnPropertyNames(Ht).slice(0,24):[],callableProto:HA==null?null:typeof Object.getPrototypeOf(HA),registerValue:HA,registerValueTag:HA==null?String(HA):Object.prototype.toString.call(HA)}),H[zC(bT.Hv)](Hk,0)';
        replaceVmProbe('H5.call', callDecode, callProbe);
        const liveCallDecode = 'sw=U[s[U0(y1.sI)](sw,sa)],sw=s[U0(y1.sw)](st,void 0)?sw:st[sw],s[U0(y1.sl)](sl,0)';
        const liveCallProbe = 'sw=U[s[U0(y1.sI)](sw,sa)],sw=s[U0(y1.sw)](st,void 0)?sw:st[sw],typeof sw!==`function`&&globalThis.__cfVmLog.push({op:`Sk.call`,argc:sl,callableType:typeof sw,callableString:String(sw).slice(0,160),receiverType:typeof st,receiverTag:st==null?String(st):Object.prototype.toString.call(st),receiverKeys:st&&typeof st===`object`?Object.getOwnPropertyNames(st).slice(0,24):[],callableProto:sw==null?null:typeof Object.getPrototypeOf(sw),pc:sE,base:sa,keySlot:sI,registerValue:sw,registerValueTag:sw==null?String(sw):Object.prototype.toString.call(sw)}),s[U0(y1.sl)](sl,0)';
        replaceVmProbe('Sk.call', liveCallDecode, liveCallProbe);
        const xdCallDecode = 'kr=kh[I[xA(je.kf)](kr,kO)],ks=kh[I[xA(je.ko)](ks,kO)],ks=void 0===kr?ks:kr[ks],kC===0';
        const xdCallProbe = 'globalThis.__cfVmPending={op:`XD.decode`,pc:kT,base:kO,receiverSlot:I[xA(je.kf)](kr,kO),keySlot:I[xA(je.ko)](ks,kO),receiverRegisterType:typeof kh[I[xA(je.kf)](kr,kO)],receiverRegisterTag:kh[I[xA(je.kf)](kr,kO)]==null?String(kh[I[xA(je.kf)](kr,kO)]):Object.prototype.toString.call(kh[I[xA(je.kf)](kr,kO)]),keyRegisterType:typeof kh[I[xA(je.ko)](ks,kO)],keyRegisterString:String(kh[I[xA(je.ko)](ks,kO)]).slice(0,160)},kr=kh[I[xA(je.kf)](kr,kO)],ks=kh[I[xA(je.ko)](ks,kO)],ks=void 0===kr?ks:kr[ks],typeof ks!==`function`&&globalThis.__cfVmLog.push({...globalThis.__cfVmPending,op:`XD.call`,mode:kC,callableType:typeof ks,callableString:String(ks).slice(0,160),callableTag:ks==null?String(ks):Object.prototype.toString.call(ks),callableProto:ks==null?null:Object.prototype.toString.call(Object.getPrototypeOf(ks)),receiverType:typeof kr,receiverTag:kr==null?String(kr):Object.prototype.toString.call(kr),receiverKeys:kr&&(typeof kr===`object`||typeof kr===`function`)?Object.getOwnPropertyNames(kr).slice(0,32):[]}),kC===0';
        replaceVmProbe('XD.call', xdCallDecode, xdCallProbe);
        const r5PcDecode = 'uh=this.j,uI=uH[uh],uF=';
        const r5PcProbe = 'uh=this.j,uI=uH[uh],globalThis.__cfVmPc=uI,uF=';
        replaceVmProbe('r5.pc', r5PcDecode, r5PcProbe);
        const r5CallDecode = 'uq=uH[uq^uN],uF=uH[uN^uF],uF=void 0===uq?uF:uq[uF],Q[xm(R3.uX)](uX,0)';
        const r5CallProbe = 'globalThis.__cfVmPending={op:`r5.decode`,pc:globalThis.__cfVmPc,nextPc:uI,base:uN,receiverSlot:uq^uN,keySlot:uN^uF,resultSlot:un^uN,argc:uX,receiverRegisterType:typeof uH[uq^uN],receiverRegisterString:String(uH[uq^uN]).slice(0,160),keyRegisterType:typeof uH[uN^uF],keyRegisterString:String(uH[uN^uF]).slice(0,160)},uq=uH[uq^uN],uF=uH[uN^uF],uF=void 0===uq?uF:uq[uF],typeof uF!==`function`&&globalThis.__cfVmLog.push({...globalThis.__cfVmPending,op:`r5.call`,callableType:typeof uF,callableString:String(uF).slice(0,160),callableTag:uF==null?String(uF):Object.prototype.toString.call(uF),receiverType:typeof uq,receiverString:String(uq).slice(0,160),receiverTag:uq==null?String(uq):Object.prototype.toString.call(uq),receiverKeys:uq&&(typeof uq===`object`||typeof uq===`function`)?Object.getOwnPropertyNames(uq).slice(0,32):[],registerWrites:(globalThis.__cfVmRegisterWrites||[]).slice(-160)}),Q[xm(R3.uX)](uX,0)';
        replaceVmProbe('r5.call', r5CallDecode, r5CallProbe);
        const variadicCallDecode = 'uq=uH[Q[xz(YP.uN)](uq,uN)],uX=Q[xz(YP.uP)](uq,void 0)?uA:uq[uA],un!==0';
        const variadicCallProbe = 'globalThis.__cfVmPending={op:`call.variadic.decode`,pc:globalThis.__cfVmCurrentPc,nextPc:uI,base:uN,receiverSlot:Q[xz(YP.uN)](uq,uN),keyString:String(uA).slice(0,160),receiverRegisterType:typeof uH[Q[xz(YP.uN)](uq,uN)],receiverRegisterString:String(uH[Q[xz(YP.uN)](uq,uN)]).slice(0,160)},uq=uH[Q[xz(YP.uN)](uq,uN)],uX=Q[xz(YP.uP)](uq,void 0)?uA:uq[uA],typeof uX!==`function`&&globalThis.__cfVmLog.push({...globalThis.__cfVmPending,op:`call.variadic`,argc:un,callableType:typeof uX,callableString:String(uX).slice(0,160),callableTag:uX==null?String(uX):Object.prototype.toString.call(uX),receiverType:typeof uq,receiverString:String(uq).slice(0,160),receiverTag:uq==null?String(uq):Object.prototype.toString.call(uq),registerWrites:(globalThis.__cfVmRegisterWrites||[]).slice(-160)}),un!==0';
        replaceVmProbe('call.variadic', variadicCallDecode, variadicCallProbe);
      }
      const realmExecStartedAt = process.hrtime.bigint();
      vm.runInContext(code, realmContext, { filename: script.url, timeout: this.opts.timeoutMs });
      if (this.opts.debugVm) process.stderr.write(`[phase] ${Math.round(Number(process.hrtime.bigint() - realmExecStartedAt) / 1e6)}ms execute:realm:done bytes=${code.length} url=${String(script.url).slice(0, 80)}\n`);
      this.executedScripts.add(script.sha256 || script.url);
      this.scriptLoads.push({ seq: this.scriptLoads.length + 1, src: script.url, reason, status: 'ok', sha256: script.sha256 });
    } catch (e) {
      this.recordError(`script:${script.url}`, e);
    } finally {
      setDocumentField(document, 'currentScript', previousCurrentScript || null);
    }
  }

  recordError(where, e) {
    const compactStack = value => String(value || '')
      .split('\n')
      .filter((line, index) => index === 0 || /^\s*at\s/.test(line))
      .slice(0, 12)
      .join('\n');
    this.errors.push({
      where,
      name: e && e.name,
      message: String(e && e.message || e).slice(0, 500),
      stack: compactStack(e && e.stack),
      timer_stack: compactStack(e && e.__timerStack),
    });
  }

  async runScenario(name) {
    this.scenarioDeadline = Date.now() + Math.max(3000, this.opts.timeoutMs + 2500, this.opts.settleMs + 2500, this.opts.xhrBridge ? 60000 : 0);
    const phase = label => { if (this.opts.debugVm) process.stderr.write(`[phase] ${Math.round(Number(process.hrtime.bigint() - runStartedAt) / 1e6)}ms ${label}\n`); };
    const runStartedAt = process.hrtime.bigint();
    const order = name === 'all'
      ? ['orchestrate', 'turnstile', 'rocket', 'jsd']
      : name === 'orchestrate-turnstile'
        // A live orchestrate response inserts its own versioned Turnstile API
        // URL.  Executing the trace fixture's older API as well races two
        // independent onload callbacks and changes the iframe challenge
        // branch.  Keep the fixture fallback for offline vectors, but let the
        // current generated script select and load the current API itself.
        ? ['orchestrate']
        : [name];
    for (const key of order) {
      const s = this.scriptByName.get(key);
      if (!s) { this.errors.push({ where: `scenario:${key}`, name: 'MissingScript', message: 'script not present in vector' }); continue; }
      if (key === 'orchestrate' && !this.context._cf_chl_opt) this.context._cf_chl_opt = {};
      phase(`execute:${key}:start`);
      this.executeScript(s, `scenario:${key}`);
      phase(`execute:${key}:done`);
      await this.drain(200);
      phase(`execute:${key}:drained`);
    }
    const firePageEvents = ({ lifecycle, interactions }) => {
      if (lifecycle) {
        setDocumentField(this.context.document, 'readyState', 'interactive');
        this.context.document.dispatchEvent(new this.context.Event('readystatechange', { isTrusted: true }));
        this.context.document.dispatchEvent(new this.context.Event('DOMContentLoaded', { isTrusted: true, bubbles: true }));
        this.context.window.dispatchEvent(new this.context.Event('DOMContentLoaded', { isTrusted: true }));
        setDocumentField(this.context.document, 'readyState', 'complete');
        this.context.document.dispatchEvent(new this.context.Event('readystatechange', { isTrusted: true }));
        this.context.window.dispatchEvent(new this.context.Event('load', { isTrusted: true }));
      }
      if (interactions) {
        for (const type of ['mousemove','pointermove','pointerover','click']) {
          const evt = new this.context.MouseEvent(type, { clientX: 42, clientY: 17, screenX: 46, screenY: 50, bubbles: true, cancelable: true, isTrusted: true });
          this.context.document.dispatchEvent(evt);
          this.context.window.dispatchEvent(new this.context.MouseEvent(type, { clientX: 42, clientY: 17, screenX: 46, screenY: 50, bubbles: true, cancelable: true, isTrusted: true }));
        }
        // Human-like pointer traffic: the challenge collects mousemove samples for the
        // whole widget lifetime. A real session produces hundreds of spaced samples with
        // jittered coordinates; a handful of instantaneous fixed-position events is a
        // strong automation signal. Stream randomized moves for ~20s at human cadence.
        if (String(process.env.CLOUDFLARE_HUMAN_POINTER || '1') === '1') {
          const mk = (type, x, y) => new this.context.MouseEvent(type, { clientX: x, clientY: y, screenX: x + 20, screenY: y + 30, bubbles: true, cancelable: true, isTrusted: true });
          let px = 700 + Math.floor(Math.random() * 200);
          let py = 300 + Math.floor(Math.random() * 200);
          let moves = 0;
          const humanTimer = setInterval(() => {
            try {
              px = Math.max(4, Math.min(1270, px + Math.floor(Math.random() * 41) - 20));
              py = Math.max(4, Math.min(880, py + Math.floor(Math.random() * 31) - 15));
              this.context.document.dispatchEvent(mk('mousemove', px, py));
              this.context.document.dispatchEvent(mk('pointermove', px, py));
              moves += 1;
              if (moves >= 260) clearInterval(humanTimer);
            } catch {}
          }, 70);
          this.timers.push({ id: humanTimer, tid: ++this.timerSeq, kind: 'setInterval', delay: 70 });
        }
        this.context.document.dispatchEvent(new this.context.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true, isTrusted: true }));
        this.context.window.dispatchEvent(new this.context.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true, isTrusted: true }));
        this.context.document.dispatchEvent(new this.context.Event('touchstart', { bubbles: true, cancelable: true, isTrusted: true, touches: [] }));
        this.context.document.dispatchEvent(new this.context.Event('wheel', { bubbles: true, cancelable: true, isTrusted: true, deltaY: 1 }));
      }
    };
    phase('page-events:first:before-drain');
    await this.drain(400);
    phase('page-events:first:after-drain');
    if (!this.opts.noEvents) firePageEvents({ lifecycle: true, interactions: !this.opts.noInteractions });
    phase('page-events:first:fired');
    await this.drain(400);
    phase('page-events:second:after-drain');
    if (!this.opts.noEvents && !this.opts.noInteractions) firePageEvents({ lifecycle: false, interactions: true });
    phase('page-events:second:fired');
    await this.drain(Math.max(1200, this.opts.settleMs));
    phase('page-events:final:drained');
    await this.drainPendingAsync(this.opts.xhrBridge ? 90000 : 0);
    phase('pending-async:drained');
    for (const timer of this.timers) {
      if (timer.kind === 'setInterval') clearInterval(timer.id);
      else clearTimeout(timer.id);
      this.context.__timerFns.delete(timer.tid);
    }
  }

  drain(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async drainPendingAsync(maxMs) {
    if (!maxMs) return;
    const deadline = Date.now() + maxMs;
    let quietSince = 0;
    while (Date.now() < deadline) {
      if (this.pendingAsync.size === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 12000) return;
        await this.drain(25);
        continue;
      }
      quietSince = 0;
      await Promise.race([...this.pendingAsync, this.drain(100)]);
    }
    if (this.pendingAsync.size) {
      this.recordError('scenario.pending-async', new Error(`pending bridge operations did not settle: ${this.pendingAsync.size}`));
    }
  }

  buildOutput() {
    const runtimeContracts = vm.runInContext(`(() => {
      const describe = value => ({
        type: typeof value,
        tag: value == null ? String(value) : Object.prototype.toString.call(value),
        constructor: value?.constructor?.name || null,
        ownKeys: value == null ? [] : Reflect.ownKeys(value).map(String),
        prototypeChain: (() => { const out = []; for (let current = value, i = 0; current && i < 8; current = Object.getPrototypeOf(current), i++) out.push(current.constructor?.name || Object.prototype.toString.call(current)); return out; })(),
        prototypeKeys: value == null ? [] : Reflect.ownKeys(Object.getPrototypeOf(value) || {}).map(String),
      });
      return {
        window: describe(window), document: describe(document), navigator: describe(navigator), performance: describe(performance),
        gpu: describe(navigator.gpu), speechSynthesis: describe(speechSynthesis),
        rtc: describe(new RTCPeerConnection({ iceServers: [] })), broadcast: describe(new BroadcastChannel('contract-snapshot')),
      };
    })()`, this.vmContext);
    return {
      schema: 'firefox_trace.cloudflare_5s_runner.v1',
      generated_at: new Date().toISOString(),
      trace_dir: this.vector.trace_dir,
      scenario: this.opts.scenario,
      scripts: Array.from(this.scriptByName.entries()).map(([name, s]) => ({ name, url: s.url, sha256: s.sha256, artifact_path: rel(s.artifact_path), size: s.code.length })),
      observed_dynamic_requests: this.generatedRequests,
      script_loads: this.scriptLoads,
      event_log: this.context.__eventLog.slice(0, 400),
      xhr_log: this.context.__xhrLog.slice(0, 200),
      missing_global_log: this.context.__missingGlobalLog.slice(0, 200),
      env_fidelity: this.envFidelity,
      worker_log: this.context.__workerLog.slice(0, 2000),
      cf_opt_log: this.context.__cfOptLog.slice(0, 400),
      cf_debug_log: this.context.__cfDebugLog.slice(0, 200),
      cf_vm_log: this.context.__cfVmLog.slice(0, 400),
      json_stringify_log: this.context.__jsonStringifyLog.slice(-32),
      encoder_input_log: this.context.__encoderInputLog.slice(-512),
      encoder_producer_log: this.context.__encoderProducerLog.slice(-32),
      navigation_log: this.navigationLog.slice(-16),
      form_submit_calls: this.formSubmitCalls,
      virtual_clock_ledger: this.virtualClockLedger.slice(-32),
      vm_probe_patches: this.vmProbePatches,
      runtime_state: { selected_globals: Object.fromEntries(['KQlAt3','ZHfDS6','MfEvo2','aQQUn1','EH','ET','Ex','El','cE','turnstile','mlyM5'].map(k => [k, { type: typeof this.context[k], ctor: this.context[k]?.constructor?.name || null }])), cf_chl_opt_keys: Object.keys(this.context._cf_chl_opt || {}), cf_chl_opt_preview: Object.fromEntries(Object.entries(this.context._cf_chl_opt || {}).map(([k,v]) => [k, typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null ? v : Array.isArray(v) ? {type:'array', length:v.length} : {type: typeof v, keys: Object.keys(v).slice(0,8)}])), document_cookie: String(this.context.document.cookie || ''), timer_count: this.timers.length },
      runtime_contracts: runtimeContracts,
      dynamic_inputs: {
        random_count: this.randomLedger.length,
        time_count: this.timeLedger.length,
        random_preview: this.randomLedger.slice(0, 10),
        time_preview: this.timeLedger.slice(0, 10),
        timer_preview: this.timers.slice(0, 40).map(({ tid, kind, delay }) => ({ tid, kind, delay })),
      },
      trace_alignment_summary: this.summarizeAlignment(),
      env_gaps_errors: this.errors,
      acceptance: {
        fixed_vector_gate: this.generatedRequests.some(r => r.matched_trace && r.matched_trace.score >= 8) ? 'partial-structure' : 'pending',
        dynamic_gate: this.generatedRequests.length ? 'candidate-generated-by-original-script-or-shimmed-runtime' : 'pending-no-request',
        browser_patch_gate: this.opts.forceFrameBranch ? (this.vmProbePatches.some(p => p.name === 'force-frame-branch' && p.applied) ? 'applied' : 'failed') : 'not-entered',
      },
    };
  }

  summarizeAlignment() {
    const rows = [];
    for (const r of this.generatedRequests) {
      rows.push({
        seq: r.seq,
        transport: r.transport,
        method: r.method,
        path: r.path,
        header_names: Object.keys(r.headers).sort(),
        body_size: r.body.size,
        cf_chl_len: r.cf_chl ? r.cf_chl.length : 0,
        cf_chl_ra: r.cf_chl_ra,
        best_trace: r.matched_trace,
      });
    }
    return rows;
  }
}

async function main() {
  if (String(process.env.CLOUDFLARE_CAPTURE_SCRIPTS || '') === '1') {
    process.stderr.write('[capture] enabled\n');
    // Capture every parsed script source (incl. direct-eval'd decoded payloads) so the
    // interactive VM can be analyzed statically.
    const inspector = require('inspector');
    const session = new inspector.Session();
    session.connect();
    const capDir = path.join(__dirname, 'runtime-data', 'captured-scripts');
    fs.mkdirSync(capDir, { recursive: true });
    let capSeq = 0;
    let parsedCount = 0;
    session.on('Debugger.scriptParsed', raw => {
      // Node inspector delivers the full message ({method, params}) to session.on
      // handlers — unwrap params before use.
      const params = raw && raw.params ? raw.params : raw;
      parsedCount += 1;
      if (parsedCount % 25 === 1) { try { process.stderr.write(`[capture] parsed #${parsedCount} url=${String(params.url||'').slice(0,80)} len=${params.length}\n`); } catch {} }
      session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (err, res) => {
        if (err || !res || !res.scriptSource) {
          setTimeout(() => session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (err2, res2) => {
            if (err2 || !res2 || !res2.scriptSource) return;
            const src2 = res2.scriptSource;
            if (src2.length < 3000) return;
            try {
              capSeq += 1;
              const base2 = `script-${String(capSeq).padStart(3, '0')}-${params.scriptId}`;
              fs.writeFileSync(path.join(capDir, base2 + '.js'), src2);
              fs.writeFileSync(path.join(capDir, base2 + '.meta.json'), JSON.stringify({ url: params.url || '', length: src2.length }, null, 2));
            } catch {}
          }), 300);
          return;
        }
        const src = res.scriptSource || '';
        if (capSeq === 0) { try { process.stderr.write(`[capture] first src len=${src.length} url=${String(params.url||'').slice(0,60)}\n`); } catch {} }
        if (src.length < 3000) return;
        try {
          capSeq += 1;
          const base = `script-${String(capSeq).padStart(3, '0')}-${String(params.scriptId).replace(/[^\w.-]/g, '_')}`;
          if (capSeq <= 3 || capSeq % 50 === 0) { try { process.stderr.write(`[capture] writing ${base} len=${src.length}\n`); } catch {} }
          fs.writeFileSync(path.join(capDir, base + '.js'), src);
          fs.writeFileSync(path.join(capDir, base + '.meta.json'), JSON.stringify({
            url: params.url || '', length: src.length,
            hasAppendChild: src.includes('appendChild'),
          }, null, 2));
        } catch {}
      });
    });
    session.post('Debugger.enable');
  }
  const opts = parseArgs(process.argv);
  let rtcProbeTimer = null;
  try {
    const controller = new AbortController();
    rtcProbeTimer = setTimeout(() => controller.abort(), 1500);
    const response = await globalThis.fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: controller.signal });
    const text = await response.text();
    const address = text.match(/^ip=([^\n\r]+)/m)?.[1]?.trim();
    opts.rtcAddresses = address ? [address] : [];
  } catch {
    opts.rtcAddresses = [];
  } finally {
    if (rtcProbeTimer) clearTimeout(rtcProbeTimer);
  }
  const vector = readJson(opts.vector);
  const rt = new FirefoxLikeRuntime(vector, opts);
  await rt.runScenario(opts.scenario);
  const output = rt.buildOutput();
  for (const t of rt.timers) { try { clearTimeout(t.id); clearInterval(t.id); } catch {} }
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({
    output: opts.output,
    requests: output.observed_dynamic_requests.length,
    scripts_ok: output.script_loads.filter(x => x.status === 'ok').length,
    errors: output.env_gaps_errors.length,
    acceptance: output.acceptance,
  }, null, 2));
  if (output.env_gaps_errors.length) {
    for (const e of output.env_gaps_errors.slice(0, 8)) console.error(`[gap] ${e.where}: ${e.name} ${e.message}`);
  }
}

main().catch(e => {
  console.error(compactError(e));
  process.exitCode = 1;
});
