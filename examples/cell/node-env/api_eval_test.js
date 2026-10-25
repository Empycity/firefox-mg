// Isolate the api.js eval failure: walk the missing globals one at a time.
'use strict';
const vm = require('vm');
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/pinned-api.js', 'utf8');
const mk = () => ({ style: {}, setAttribute() {}, getAttribute: () => null, appendChild(c) { return c; }, children: [], classList: { add() {}, remove() {} } });
const ctx = vm.createContext({
  window: { addEventListener() {}, postMessage() {}, removeEventListener() {} },
  document: {
    addEventListener() {}, removeEventListener() {}, createElement: () => mk(), createElementNS: () => mk(),
    readyState: 'complete', querySelector: () => null,
    querySelectorAll: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }),
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    head: Object.assign(mk(), { appendChild(c) { return c; } }), body: mk(), documentElement: mk(),
    cookie: '', createEvent: () => ({ initEvent() {} }), currentScript: null,
  },
  navigator: { userAgent: 'x', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, webdriver: false, plugins: {}, mimeTypes: {} },
  location: { href: 'https://challenges.cloudflare.com/', search: '', origin: 'https://challenges.cloudflare.com', protocol: 'https:' },
  addEventListener() {}, removeEventListener() {}, setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
  postMessage() {}, performance: { now: () => 0, getEntries: () => [], getEntriesByType: () => [], timeOrigin: 0 },
  console, Function, Array, Object, String, Symbol, Math, JSON, Promise, Reflect, Date, Error, TypeError, RangeError,
  Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray,
  WeakSet, WeakMap, Map, Set, TextEncoder, TextDecoder, URL, URLSearchParams, Infinity, NaN, parseInt, parseFloat, isNaN, isFinite,
  HTMLScriptElement: function HSE() {}, HTMLIFrameElement: function HIE() {}, HTMLElement: function HE() {},
  HTMLDivElement: function HDE() {}, Element: function E() {}, Node: function N() {}, EventTarget: function ET() {},
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
  MessageChannel: class { constructor() { this.port1 = { postMessage() {}, addEventListener() {}, start() {} }; this.port2 = { postMessage() {}, addEventListener() {}, start() {} }; } },
  Blob: class {}, Worker: class { postMessage() {} terminate() {} addEventListener() {} },
  crypto: { getRandomValues: (a) => a, subtle: {} },
});
try { vm.runInContext(s, ctx, { filename: 'api.js' }); console.log('EVAL OK in bare env'); }
catch (e) { console.log('ERR:', e.message); }
