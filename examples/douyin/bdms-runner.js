#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { performance } = require("perf_hooks");

const configFlag = process.argv.indexOf("--config");
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : "";
const runtimeContract = configPath ? readJson(path.resolve(configPath)) : null;
const contractDir = configPath ? path.dirname(path.resolve(configPath)) : "";
const traceDir = runtimeContract?.generated_from || process.argv[2] || "";
const assetsDir = path.join(traceDir, "web-assets", "js");
const ledgerPath = path.join(traceDir, "environment-ledger.json");
const legacyLedger = !runtimeContract && fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, "utf8"))
  : null;
const environmentContract = runtimeContract?.environment_contract || readJson(
  path.join(traceDir, "index", "environment-contract.json")
) || { coverage: {}, values: {} };
const targetCandidates = runtimeContract ? null : readJson(path.join(traceDir, "index", "target-candidates.json"));
const bdmsPath = findAsset("bdms_1.0.1.19_fix.js");
const ledger = legacyLedger || { restore_seed: {} };
const seed = runtimeContract?.restore_seed || legacyLedger?.restore_seed || traceRestoreSeed();
const xhrLog = [];
const diagnostics = [];
const fixedNowMs = Number.parseInt(process.env.BDMS_RUNNER_FIXED_NOW_MS || "", 10);
const fixedPerformanceMs = Number.parseFloat(process.env.BDMS_RUNNER_FIXED_PERFORMANCE_MS || "");
const randomSeed = Number.parseInt(process.env.BDMS_RUNNER_RANDOM_SEED || "", 10);
const overridePageId = Number.parseInt(process.env.BDMS_RUNNER_PAGE_ID || "", 10);
const aBogusInputMode = process.env.BDMS_RUNNER_A_BOGUS_INPUT || "delete";
const hostAuditEnabled = /^(1|true|yes)$/i.test(process.env.BDMS_RUNNER_AUDIT || "");
const dynamicMode = ["live", "seeded", "trace"].includes(process.env.BDMS_RUNNER_DYNAMIC)
  ? process.env.BDMS_RUNNER_DYNAMIC
  : "live";
const dynamicVector = readDynamicVector(process.env.BDMS_RUNNER_VECTOR || "");
const traceRandomValues = dynamicMode === "trace"
  ? (dynamicVector.random.length ? dynamicVector.random : traceMathRandomValues())
  : [];
const traceTimeValues = dynamicMode === "trace"
  ? (dynamicVector.time.length ? dynamicVector.time : traceDateValues())
  : [];
const traceBdmsInitConfig = traceBdmsInitOptions();

function findAsset(suffix) {
  if (runtimeContract?.script_path) {
    const scriptPath = path.resolve(contractDir, runtimeContract.script_path);
    if (fs.existsSync(scriptPath)) return scriptPath;
    throw new Error(`Runtime contract script is missing: ${scriptPath}`);
  }
  if (fs.existsSync(assetsDir)) {
    const match = fs.readdirSync(assetsDir).find((name) => name.endsWith(suffix));
    if (match) return path.join(assetsDir, match);
  }

  // New trace bundles store script artifacts by SHA-256.  The index retains
  // the original filename and identifies the SDK selected by correlation.
  const candidates = Array.isArray(targetCandidates)
    ? targetCandidates
    : (targetCandidates?.candidates || targetCandidates?.targets || []);
  const sdk = candidates.find((candidate) =>
    candidate.script_match === "webmssdk.es5.js" && candidate.script_sha256
  );
  if (sdk) {
    const scriptPath = path.join(traceDir, "scripts", `${sdk.script_sha256}.js`);
    if (fs.existsSync(scriptPath)) return scriptPath;
  }
  throw new Error(`Trace asset not found: ${suffix}`);
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function environmentValue(key, fallback) {
  const entry = environmentContract.values?.[key];
  return entry?.restorable ? entry.value : fallback;
}

function environmentNumber(key, fallback) {
  const value = Number(environmentValue(key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function readDynamicVector(filePath) {
  if (!filePath) return { random: [], time: [] };
  const report = readJson(filePath);
  const inputs = Array.isArray(report?.dynamic_inputs) ? report.dynamic_inputs : [];
  return {
    random: inputs.filter((item) => item.type === "js.random").map((item) => Number(item.value)),
    time: inputs.filter((item) => item.type === "js.time").map((item) => Number(item.value)),
  };
}

function targetRequestFields() {
  if (runtimeContract?.request?.unsigned_url) {
    return [{
      request_id: runtimeContract.request.request_id || "runtime-contract",
      url: runtimeContract.request.unsigned_url,
      origin_call_id: null,
    }];
  }
  const fieldsPath = path.join(traceDir, "categorized", "request-fields.jsonl");
  if (!fs.existsSync(fieldsPath)) return [];
  const seen = new Set();
  const fields = [];
  for (const line of fs.readFileSync(fieldsPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.field_name !== "a_bogus" || !/\/comment\/list(?:\/|\?)/.test(event.url || "")) continue;
    if (seen.has(event.request_id)) continue;
    seen.add(event.request_id);
    fields.push(event);
  }
  return fields;
}

function traceRestoreSeed() {
  if (runtimeContract?.restore_seed) return runtimeContract.restore_seed;
  const statePath = path.join(traceDir, "categorized", "state.jsonl");
  if (!fs.existsSync(statePath)) return {};

  const targetTs = targetRequestFields()[0]?.ts_us ?? Number.POSITIVE_INFINITY;
  let cookieHeader = "";
  const localStorage = {};
  const sessionStorage = {};
  for (const line of fs.readFileSync(statePath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if ((event.ts_us ?? 0) > targetTs) continue;
    if (event.type === "cookie.get" && event.source === "document.cookie" && event.value_preview) {
      cookieHeader = event.value_preview;
      continue;
    }
    const target = event.storage_type === "sessionStorage" ? sessionStorage : localStorage;
    if (event.type === "storage.set" && event.key && event.value_preview !== undefined) {
      target[event.key] = event.value_preview;
    } else if (event.type === "storage.remove" && event.key) {
      delete target[event.key];
    } else if (event.type === "storage.clear") {
      for (const key of Object.keys(target)) delete target[key];
    }
  }
  const cookies = {};
  for (const part of cookieHeader.split(/;\s*/)) {
    const split = part.indexOf("=");
    if (split > 0) cookies[part.slice(0, split)] = part.slice(split + 1);
  }
  return { cookies, localStorage, sessionStorage };
}

function traceMathRandomValues() {
  const jsPath = path.join(traceDir, "categorized", "js.jsonl");
  if (!fs.existsSync(jsPath)) return [];
  const bdmsCallIds = new Set();
  const randomEvents = [];
  forEachJsonLine(jsPath, (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if ((event.type === "js.call.enter" || event.type === "js.script.enter") &&
        /bdms_1\.0\.1\.19_fix\.js/.test(event.script_url || "")) {
      bdmsCallIds.add(String(event.call_id || ""));
    }
    if (event.type === "js.random" && Number.isFinite(Number(event.value))) {
      randomEvents.push(event);
    }
  });
  // The native hook carries the active scripted call id.  Keeping only calls
  // rooted in the SDK prevents unrelated page randomness from shifting replay.
  return randomEvents
    .filter((event) => bdmsCallIds.has(String(event.call_id || "")))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .map((event) => Number(event.value));
}

function traceDateValues() {
  const jsPath = path.join(traceDir, "categorized", "js.jsonl");
  if (!fs.existsSync(jsPath)) return [];
  const bdmsCallIds = new Set();
  const timeEvents = [];
  forEachJsonLine(jsPath, (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if ((event.type === "js.call.enter" || event.type === "js.script.enter") &&
        /bdms_1\.0\.1\.19_fix\.js/.test(event.script_url || "")) {
      bdmsCallIds.add(String(event.call_id || ""));
    }
    if (event.type === "js.time" && Number.isFinite(Number(event.value_ms))) {
      timeEvents.push(event);
    }
  });
  return timeEvents
    .filter((event) => bdmsCallIds.has(String(event.call_id || "")))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .map((event) => Number(event.value_ms));
}

function traceBdmsInitOptions() {
  if (runtimeContract?.init) return runtimeContract.init;
  const jsPath = path.join(traceDir, "categorized", "js.jsonl");
  if (!fs.existsSync(jsPath)) return {};
  let selected = {};
  forEachJsonLine(jsPath, (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type !== "js.call.enter" || event.function_name !== "init" ||
        !/sdk-glue\.js/.test(event.script_url || "")) return;
    const props = event.data?.args?.[0]?.props;
    if (!Array.isArray(props)) return;
    const values = Object.fromEntries(props
      .filter((entry) => entry?.key && entry.value && "preview" in entry.value)
      .map((entry) => [entry.key, entry.value.preview]));
    if (values.aid !== undefined && values.pageId !== undefined) selected = values;
  });
  return selected;
}

function forEachJsonLine(filePath, visit) {
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let carry = "";
  try {
    for (;;) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      const lines = (carry + chunk.toString("utf8", 0, size)).split("\n");
      carry = lines.pop() || "";
      for (const line of lines) visit(line);
    }
    if (carry) visit(carry);
  } finally {
    fs.closeSync(fd);
  }
}

function createRandomSource(seedValue, recordedValues) {
  let state = dynamicMode === "seeded" && Number.isFinite(seedValue) ? (seedValue >>> 0) : null;
  let cursor = 0;
  let calls = 0;
  const next = () => {
    calls += 1;
    if (cursor < recordedValues.length) return recordedValues[cursor++];
    if (state === null) return Math.random();
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return { next, usage: () => ({ calls, recorded_consumed: cursor, mode: state === null ? "live" : "seeded" }) };
}

function createClock(nowMs, recordedValues) {
  let cursor = 0;
  let calls = 0;
  const next = () => {
    calls += 1;
    if (cursor < recordedValues.length) return recordedValues[cursor++];
    return Number.isFinite(nowMs) ? nowMs : Date.now();
  };
  class TraceDate extends Date {
    constructor(...args) { super(...(args.length ? args : [next()])); }
    static now() { return next(); }
  }
  return { Clock: TraceDate, usage: () => ({ calls, recorded_consumed: cursor, mode: Number.isFinite(nowMs) ? "fixed" : recordedValues.length ? "trace" : "live" }) };
}

class Storage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]));
  }

  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

function createBrowserContext() {
  const randomSource = createRandomSource(randomSeed, traceRandomValues);
  const clockSource = createClock(fixedNowMs, traceTimeValues);
  const math = Object.create(Math);
  math.random = randomSource.next;
  const tracePerformance = {
    now: () => Number.isFinite(fixedPerformanceMs) ? fixedPerformanceMs : performance.now(),
    timeOrigin: Number.isFinite(fixedNowMs) ? fixedNowMs : performance.timeOrigin,
    getEntriesByType: (...args) => performance.getEntriesByType(...args),
    mark: (...args) => performance.mark(...args),
    clearMarks: (...args) => performance.clearMarks(...args),
  };
  const hostAccesses = new Map();
  const trackHostObject = (name, value) => {
    if (!hostAuditEnabled || !value || typeof value !== "object") return value;
    return new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === "string") {
          hostAccesses.set(`${name}.${property}`, (hostAccesses.get(`${name}.${property}`) || 0) + 1);
        }
        const member = Reflect.get(target, property, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  };
  const cookies = new Map(Object.entries(seed.cookies || {}));
  const location = {
    href: String(environmentValue("Location.href", "https://www.douyin.com/?recommend=1")),
    origin: String(environmentValue("Location.origin", "https://www.douyin.com")),
    protocol: String(environmentValue("Location.protocol", "https:")),
    host: String(environmentValue("Location.host", "www.douyin.com")),
    hostname: String(environmentValue("Location.hostname", "www.douyin.com")),
    pathname: String(environmentValue("Location.pathname", "/")),
    search: String(environmentValue("Location.search", "?recommend=1")),
  };
  const document = {
    readyState: "complete",
    referrer: String(environmentValue("Document.referrer", "")),
    title: "",
    hidden: environmentValue("Document.hidden", false) === true || environmentValue("Document.hidden", false) === "true",
    visibilityState: String(environmentValue("Document.visibilityState", "visible")),
    characterSet: String(environmentValue("Document.characterSet", "UTF-8")),
    documentElement: { clientWidth: 1728, clientHeight: 1117, style: {} },
    body: { appendChild() {}, removeChild() {}, style: {} },
    head: { appendChild() {}, removeChild() {}, style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        style: {},
        setAttribute() {},
        getAttribute() { return null; },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        getContext() { return null; },
      };
    },
    getElementsByTagName() { return []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(document, "cookie", {
    get() { return [...cookies].map(([key, value]) => `${key}=${value}`).join("; "); },
    set(value) {
      const first = String(value).split(";")[0];
      const split = first.indexOf("=");
      if (split > 0) cookies.set(first.slice(0, split), first.slice(split + 1));
    },
  });

  class XMLHttpRequest {
    constructor() {
      this.headers = {};
      this.readyState = 0;
      this.status = 200;
      this.response = "";
      this.responseText = "";
      this.onreadystatechange = null;
      this.onload = null;
    }

    open(method, url, async = true) {
      this.method = method;
      this.url = String(url);
      this.async = async;
      this.readyState = 1;
      xhrLog.push({ phase: "open", method, url: this.url, async });
    }

    setRequestHeader(name, value) {
      this.headers[String(name)] = String(value);
      xhrLog.push({ phase: "header", name: String(name), value: String(value) });
    }

    send(body = null) {
      this.body = body;
      this.readyState = 4;
      xhrLog.push({ phase: "send", method: this.method, url: this.url, headers: this.headers, body });
      if (typeof this.onreadystatechange === "function") this.onreadystatechange();
      if (typeof this.onload === "function") this.onload();
    }

    abort() {}
    addEventListener() {}
    removeEventListener() {}
  }

  const sandbox = {
    console: {
      log: (...args) => diagnostics.push({ level: "log", text: args.map(String).join(" ") }),
      warn: (...args) => diagnostics.push({ level: "warn", text: args.map(String).join(" ") }),
      error: (...args) => diagnostics.push({ level: "error", text: args.map(String).join(" ") }),
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Math: math,
    Date: clockSource.Clock,
    JSON,
    Promise,
    performance: trackHostObject("performance", tracePerformance),
    RegExp,
    Error,
    TypeError,
    Symbol,
    Proxy,
    Reflect,
    Object,
    Array,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    atob(value) { return Buffer.from(String(value), "base64").toString("latin1"); },
    btoa(value) { return Buffer.from(String(value), "latin1").toString("base64"); },
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    crypto: webcrypto,
    document: trackHostObject("document", document),
    localStorage: new Storage(seed.localStorage),
    sessionStorage: new Storage(seed.sessionStorage),
    navigator: trackHostObject("navigator", {
      userAgent: String(environmentValue("Navigator.userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0")),
      language: String(environmentValue("Navigator.language", "en-US")),
      languages: [String(environmentValue("Navigator.language", "en-US")), "en"],
      platform: String(environmentValue("Navigator.platform", "MacIntel")),
      vendor: String(environmentValue("Navigator.vendor", "")),
      hardwareConcurrency: environmentNumber("Navigator.hardwareConcurrency", 12),
      cookieEnabled: environmentValue("Navigator.cookieEnabled", true) !== false,
      onLine: environmentValue("Navigator.onLine", true) !== false,
      webdriver: environmentValue("Navigator.webdriver", false) === true,
      plugins: [],
    }),
    location: trackHostObject("location", location),
    screen: trackHostObject("screen", {
      width: environmentNumber("Screen.width", 1728),
      height: environmentNumber("Screen.height", 1117),
      availWidth: environmentNumber("Screen.availWidth", 1728),
      availHeight: environmentNumber("Screen.availHeight", 1117),
      colorDepth: environmentNumber("Screen.colorDepth", 24),
      pixelDepth: environmentNumber("Screen.pixelDepth", 24),
    }),
    innerWidth: environmentNumber("Window.innerWidth", 1728),
    innerHeight: environmentNumber("Window.innerHeight", 1117),
    outerWidth: environmentNumber("Window.outerWidth", 1728),
    outerHeight: environmentNumber("Window.outerHeight", 1117),
    screenX: environmentNumber("Window.screenX", 0),
    screenY: environmentNumber("Window.screenY", 0),
    devicePixelRatio: environmentNumber("Window.devicePixelRatio", 2),
    XMLHttpRequest,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    getComputedStyle() { return {}; },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__hostAccesses = hostAccesses;
  sandbox.__dynamicUsage = {
    random: randomSource.usage,
    time: clockSource.usage,
  };
  return vm.createContext(sandbox, { name: "firefox-trace-bdms" });
}

function describeExport(value) {
  if (value === null || value === undefined) return { type: String(value) };
  const names = Object.getOwnPropertyNames(value);
  return {
    type: typeof value,
    names,
    descriptors: Object.fromEntries(names.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return [name, {
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        writable: "writable" in descriptor ? descriptor.writable : undefined,
        value_type: "value" in descriptor ? typeof descriptor.value : undefined,
        getter: typeof descriptor.get === "function",
        setter: typeof descriptor.set === "function",
      }];
    })),
  };
}

function findUnsignedTargetUrl() {
  if (runtimeContract?.request?.unsigned_url) return runtimeContract.request.unsigned_url;
  const fields = targetRequestFields();
  for (const event of fields) {
    if (aBogusInputMode === "blank") {
      return event.url.replace(/([?&])a_bogus=[^&]*/, "$1a_bogus=");
    }
    const target = new URL(event.url);
    target.searchParams.delete("a_bogus");
    return target.href;
  }
  throw new Error("No comment/list a_bogus request was found in request-fields.jsonl");
}

function runtimeRequestBody() {
  const body = runtimeContract?.request?.body;
  if (body === null || body === undefined || typeof body === "string") return body ?? null;
  return JSON.stringify(body);
}

function summarizeValue(value) {
  if (value === null || value === undefined) return { type: String(value) };
  if (typeof value === "object") return { type: value.constructor?.name || "object" };
  return { type: typeof value, value: String(value) };
}

function currentDynamicUsage(context) {
  return {
    math_random: context.__dynamicUsage.random(),
    date_now_or_no_arg_date: context.__dynamicUsage.time(),
  };
}

function usageDelta(after, before) {
  const subtract = (key) => ({
    calls: after[key].calls - before[key].calls,
    recorded_consumed: after[key].recorded_consumed - before[key].recorded_consumed,
    mode: after[key].mode,
  });
  return {
    math_random: subtract("math_random"),
    date_now_or_no_arg_date: subtract("date_now_or_no_arg_date"),
  };
}

function main() {
  const context = createBrowserContext();
  const source = fs.readFileSync(bdmsPath, "utf8");
  const instrumentedSource = source.replace(
    'if("function"!=typeof n)return f=3,void(l=new TypeError(typeof n+" is not a function"));',
    'if("function"!=typeof n){globalThis.__bdmsVmFailure={pc:a,program_ops:o.slice(Math.max(0,a-24),a+8),global_name:Z[132],property_name:Z[184],callee_type:typeof n,receiver_type:typeof d,receiver_keys:d?Object.getOwnPropertyNames(d).slice(0,128):[],arguments_length:e.length,argument_types:e.map(function(x){return typeof x}),argument_names:e.map(function(x){return x&&x.name||null}),unprovided_string_candidates:Z.filter(function(x){return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(x)&&!(x in globalThis)}).slice(0,256)};return f=3,void(l=new TypeError(typeof n+" is not a function"));}'
  );
  const result = {
    runtime_contract: configPath ? path.resolve(configPath) : null,
    trace_dir: runtimeContract ? null : traceDir,
    asset: bdmsPath,
    runtime_controls: {
      fixed_now_ms: Number.isFinite(fixedNowMs) ? fixedNowMs : null,
      fixed_performance_ms: Number.isFinite(fixedPerformanceMs) ? fixedPerformanceMs : null,
      random_seed: Number.isFinite(randomSeed) ? randomSeed : null,
      page_id_override: Number.isFinite(overridePageId) ? overridePageId : null,
      recorded_math_random_values: traceRandomValues.length,
      recorded_date_values: traceTimeValues.length,
      dynamic_vector: process.env.BDMS_RUNNER_VECTOR || null,
      trace_bdms_init: traceBdmsInitConfig,
      a_bogus_input: aBogusInputMode,
      dynamic_mode: dynamicMode,
      host_audit: hostAuditEnabled,
      environment_contract: {
        path: configPath ? "runtime-contract.json" : "index/environment-contract.json",
        coverage: environmentContract.coverage || {},
      },
    },
    target_requests: runtimeContract?.request
      ? [{ request_id: runtimeContract.request.request_id, endpoint: new URL(runtimeContract.request.unsigned_url).pathname, origin_call_id: null }]
      : legacyLedger?.target_summary?.field === "a_bogus"
      ? legacyLedger.target_summary.requests.map(({ request_id, endpoint, origin_call_id }) => ({ request_id, endpoint, origin_call_id }))
      : targetRequestFields().map(({ request_id, url, origin_call_id }) => ({
        request_id,
        endpoint: new URL(url).pathname,
        origin_call_id,
      })),
  };
  try {
    vm.runInContext(instrumentedSource, context, { filename: bdmsPath, timeout: 5000 });
    result.load = "ok";
  } catch (error) {
    result.load = "error";
    result.error = {
      name: error.name,
      message: error.message,
      location: String(error.stack || "").split("\n").slice(-10),
    };
  }
  result.bdms = describeExport(context.bdms);
  result.vm_failure = context.__bdmsVmFailure || null;
  let beforeReplayUsage = currentDynamicUsage(context);
  if (result.load === "ok") {
    try {
      result.get_referer = summarizeValue(context.bdms.getReferer());
      const initConfig = {
        aid: Number(traceBdmsInitConfig.aid || 6383),
        pageId: Number.isFinite(overridePageId)
          ? overridePageId
          : Number(traceBdmsInitConfig.pageId || 1),
        paths: traceBdmsInitConfig.paths || ["/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/"],
      };
      for (const key of ["boe", "ddrt", "ic"]) {
        if (traceBdmsInitConfig[key] === undefined) continue;
        const value = traceBdmsInitConfig[key];
        initConfig[key] = value === "true" ? true : value === "false" ? false : Number(value);
      }
      result.init = {
        config: { aid: initConfig.aid, pageId: initConfig.pageId, paths: initConfig.paths },
        return: summarizeValue(context.bdms.init(initConfig)),
      };
    } catch (error) {
      result.init_error = { name: error.name, message: error.message };
    }

    beforeReplayUsage = currentDynamicUsage(context);

    try {
      const unsignedUrl = findUnsignedTargetUrl();
      const expectedPath = new URL(unsignedUrl).pathname;
      const method = String(runtimeContract?.request?.method || "GET").toUpperCase();
      const body = runtimeRequestBody();
      const request = new context.XMLHttpRequest();
      request.open(method, unsignedUrl, true);
      for (const [name, value] of Object.entries(runtimeContract?.request?.headers || {})) {
        request.setRequestHeader(name, value);
      }
      request.send(body);
      const finalRequest = xhrLog.findLast((entry) => {
        if (entry.phase !== "send" || !entry.url) return false;
        return new URL(entry.url).pathname === expectedPath;
      });
      const finalUrl = finalRequest?.url ? new URL(finalRequest.url) : null;
      result.replay = {
        method,
        request_body_kind: body === null ? "null" : typeof body,
        request_body_bytes: body === null ? 0 : Buffer.byteLength(body),
        unsigned_url_has_a_bogus: new URL(unsignedUrl).searchParams.has("a_bogus"),
        sent_url_has_a_bogus: Boolean(finalUrl?.searchParams.has("a_bogus")),
        sent_a_bogus_length: finalUrl?.searchParams.get("a_bogus")?.length || 0,
        dynamic_usage: usageDelta(currentDynamicUsage(context), beforeReplayUsage),
      };
    } catch (error) {
      result.replay_error = { name: error.name, message: error.message };
    }
  }
  result.xhr = xhrLog;
  result.sdk_console = diagnostics;
  result.dynamic_usage = currentDynamicUsage(context);
  if (hostAuditEnabled) {
    result.host_accesses = Object.fromEntries(
      [...context.__hostAccesses.entries()].sort(([left], [right]) => left.localeCompare(right))
    );
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.load === "ok" ? 0 : 1;
}

main();
