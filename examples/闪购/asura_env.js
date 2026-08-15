"use strict";

const fs = require("fs");
const path = require("path");

const TRACE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0";

const PLUGIN_NAMES = [
  "PDF Viewer",
  "Chrome PDF Viewer",
  "Chromium PDF Viewer",
  "Microsoft Edge PDF Viewer",
  "WebKit built-in PDF",
];

function nativeFunction(name, implementation) {
  Object.defineProperty(implementation, "name", { value: name, configurable: true });
  implementation.toString = () => `function ${name}() {\n    [native code]\n}`;
  return implementation;
}

function makePlugins() {
  const applicationPdf = { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" };
  const textPdf = { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" };
  const plugins = PLUGIN_NAMES.map((name) => {
    const plugin = [applicationPdf, textPdf];
    Object.assign(plugin, {
      name,
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
      item: nativeFunction("item", (index) => plugin[index] || null),
      namedItem: nativeFunction("namedItem", (type) =>
        plugin.find((entry) => entry.type === type) || null
      ),
    });
    plugin["application/pdf"] = applicationPdf;
    plugin["text/pdf"] = textPdf;
    return plugin;
  });
  plugins.item = nativeFunction("item", (index) => plugins[index] || null);
  plugins.namedItem = nativeFunction("namedItem", (name) =>
    plugins.find((plugin) => plugin.name === name) || null
  );
  for (const plugin of plugins) plugins[plugin.name] = plugin;
  return plugins;
}

class EventTargetFixture {
  constructor() {
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    this._listeners.set(type, listeners.filter((entry) => entry !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this._listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class ElementFixture extends EventTargetFixture {
  constructor(tagName, dimensions) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.id = "";
    this.className = "";
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.clientLeft = 0;
    this.clientTop = 0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.clientWidth = dimensions.innerWidth;
    this.clientHeight = dimensions.innerHeight;
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument || null;
    this.children.push(child);
    if (this.ownerDocument && typeof this.ownerDocument.__recordAppend === "function") {
      this.ownerDocument.__recordAppend(child);
    }
    if (typeof child.onload === "function") queueMicrotask(() => child.onload());
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument || null;
    const index = this.children.indexOf(reference);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    if (this.ownerDocument && typeof this.ownerDocument.__recordAppend === "function") {
      this.ownerDocument.__recordAppend(child, reference);
    }
    if (typeof child.onload === "function") queueMicrotask(() => child.onload());
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  getAttribute(name) {
    return this[name] == null ? null : String(this[name]);
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

class NodeFixture extends EventTargetFixture {}

class DocumentNodeFixture extends NodeFixture {
  get body() {
    return this._body;
  }

  get head() {
    return this._head;
  }

  get documentElement() {
    return this._documentElement;
  }

  get currentScript() {
    return this._currentScript;
  }
}

class HTMLDocumentFixture extends DocumentNodeFixture {}

function makeCanvas(dimensions, canvasDataUrl) {
  const canvas = new ElementFixture("canvas", dimensions);
  canvas.width = 300;
  canvas.height = 150;
  const context2d = {
    fillStyle: "#000000",
    font: "10px sans-serif",
    textBaseline: "alphabetic",
    fillRect: nativeFunction("fillRect", () => undefined),
    fillText: nativeFunction("fillText", () => undefined),
  };
  const webgl = {
    getExtension: nativeFunction("getExtension", (name) =>
      name === "WEBGL_debug_renderer_info"
        ? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 }
        : null
    ),
    getParameter: nativeFunction("getParameter", (parameter) => {
      if (parameter === 37445) return "Apple";
      if (parameter === 37446) return "Apple M1, or similar";
      return null;
    }),
  };
  canvas.getContext = nativeFunction("getContext", (type) => {
    if (type === "2d") return context2d;
    if (type === "webgl" || type === "experimental-webgl") return webgl;
    return null;
  });
  canvas.toDataURL = nativeFunction("toDataURL", () => canvasDataUrl);
  return canvas;
}

class AudioNodeFixture {
  connect(target) {
    return target;
  }

  disconnect() {}
}

class ImageFixture extends EventTargetFixture {
  constructor(width, height) {
    super();
    this.tagName = "IMG";
    this.nodeName = "IMG";
    this.nodeType = 1;
    this.width = width === undefined ? 0 : Number(width);
    this.height = height === undefined ? 0 : Number(height);
    this.complete = false;
    this.onload = null;
    this.onerror = null;
    this._src = "";
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value);
  }
}

class AudioContextFixture {
  constructor() {
    AudioContextFixture.created = (AudioContextFixture.created || 0) + 1;
    this.state = "suspended";
    this.baseLatency = 0;
    this.destination = new AudioNodeFixture();
  }

  createOscillator() {
    const node = new AudioNodeFixture();
    node.type = "sine";
    node.start = nativeFunction("start", () => undefined);
    return node;
  }

  createAnalyser() {
    const node = new AudioNodeFixture();
    node.frequencyBinCount = 1024;
    node.getFloatFrequencyData = nativeFunction("getFloatFrequencyData", (values) => values.fill(-Infinity));
    return node;
  }

  createGain() {
    const node = new AudioNodeFixture();
    node.gain = { value: 1 };
    return node;
  }

  createScriptProcessor() {
    const node = new AudioNodeFixture();
    let audioProcess = null;
    Object.defineProperty(node, "onaudioprocess", {
      configurable: true,
      enumerable: true,
      get: () => audioProcess,
      set(listener) {
        audioProcess = listener;
        if (typeof listener === "function") queueMicrotask(() => {
          AudioContextFixture.processed = (AudioContextFixture.processed || 0) + 1;
          listener.call(node, { type: "audioprocess" });
        });
      },
    });
    return node;
  }
}

function makeStorage() {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  };
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property in target) return Reflect.get(target, property, receiver);
      return values.has(property) ? values.get(property) : undefined;
    },
    set(target, property, value, receiver) {
      if (typeof property !== "string" || property in target) return Reflect.set(target, property, value, receiver);
      values.set(property, String(value));
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property === "string" && !(property in target)) return values.delete(property);
      return Reflect.deleteProperty(target, property);
    },
  });
}

function makeXMLHttpRequest(fetchImpl, baseUrl, userAgent) {
  return class XMLHttpRequestFixture extends EventTargetFixture {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.response = "";
      this.responseText = "";
      this.responseType = "";
      this.timeout = 0;
      this.withCredentials = false;
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.onloadend = null;
      this._headers = {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        Origin: new URL(baseUrl).origin,
        Referer: `${new URL(baseUrl).origin}/`,
        "User-Agent": userAgent,
      };
    }

    open(method, url) {
      this._method = String(method).toUpperCase();
      this._url = new URL(String(url), baseUrl).href;
      this.readyState = 1;
      this._notifyReadyState();
    }

    setRequestHeader(name, value) {
      this._headers[String(name)] = String(value);
    }

    getAllResponseHeaders() {
      return this._responseHeaders || "";
    }

    getResponseHeader(name) {
      return this._responseHeaderMap?.get(String(name).toLowerCase()) ?? null;
    }

    send(body = null) {
      const controller = new AbortController();
      const timer = this.timeout > 0 ? setTimeout(() => controller.abort(), this.timeout) : null;
      fetchImpl(this._url, {
        method: this._method,
        headers: this._headers,
        body: this._method === "GET" || this._method === "HEAD" ? undefined : body,
        signal: controller.signal,
      }).then(async (response) => {
        this.status = response.status;
        this.responseURL = response.url;
        this._responseHeaderMap = response.headers;
        this._responseHeaders = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\r\n");
        this.responseText = await response.text();
        this.response = this.responseType === "json" ? JSON.parse(this.responseText) : this.responseText;
        this.readyState = 4;
        this._notifyReadyState();
        this._notify("load");
      }).catch((error) => {
        this._error = error;
        this.readyState = 4;
        this._notifyReadyState();
        this._notify("error");
      }).finally(() => {
        if (timer) clearTimeout(timer);
        this._notify("loadend");
      });
    }

    _notifyReadyState() {
      if (typeof this.onreadystatechange === "function") this.onreadystatechange({ type: "readystatechange", target: this });
      this.dispatchEvent({ type: "readystatechange", target: this });
    }

    _notify(type) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") handler({ type, target: this });
      this.dispatchEvent({ type, target: this });
    }
  };
}

function createAsuraEnvironment(options = {}) {
  const missing = new Set();
  const observed = (name, value) => options.debugMissing
    ? new Proxy(value, {
        get(target, property, receiver) {
          if (typeof property === "string" && !(property in target)) missing.add(`${name}.${property}`);
          return Reflect.get(target, property, receiver);
        },
        has(target, property) {
          return Reflect.has(target, property);
        },
      })
    : value;
  const fixtureDir = path.join(__dirname, "fixtures");
  const canvasDataUrl = fs.readFileSync(path.join(fixtureDir, "canvas-data-url.txt"), "utf8").trim();
  const resourceNames = JSON.parse(fs.readFileSync(path.join(fixtureDir, "resource-names.json"), "utf8"));
  const dimensions = {
    screenLeft: options.screenLeft ?? 196,
    screenTop: options.screenTop ?? 77,
    innerWidth: 1280,
    innerHeight: 891,
    outerWidth: 1280,
    outerHeight: 975,
  };
  const eventRoot = new EventTargetFixture();
  const body = new ElementFixture("body", dimensions);
  const head = new ElementFixture("head", dimensions);
  const documentElement = new ElementFixture("html", dimensions);
  const scripts = [];
  const etScript = new ElementFixture("script", dimensions);
  etScript.id = "AWSC_etModule";
  etScript.src = "https://g.alicdn.com/AWSC/et/1.83.41/et_f.js";
  etScript.async = false;
  head.children.push(etScript);
  etScript.parentNode = head;
  scripts.push(etScript);
  const documentBase = Object.assign(new HTMLDocumentFixture(), {
    _body: body,
    _head: head,
    _documentElement: documentElement,
    _currentScript: etScript,
    hidden: false,
    visibilityState: "visible",
    readyState: "interactive",
    referrer: "",
    cookie: "",
    createElement(tagName) {
      if (String(tagName).toLowerCase() === "canvas") return makeCanvas(dimensions, canvasDataUrl);
      const element = new ElementFixture(tagName, dimensions);
      element.ownerDocument = document;
      return element;
    },
    getElementsByTagName(tagName) {
      const name = String(tagName).toLowerCase();
      if (name === "script") return scripts.slice();
      if (name === "head") return [head];
      if (name === "body") return [body];
      if (name === "html") return [documentElement];
      return [];
    },
    getElementById: () => null,
    querySelector: () => null,
    hasFocus: () => true,
  });
  Object.defineProperty(documentBase, "__recordAppend", {
    configurable: true,
    value(child) {
      if (child && child.tagName === "SCRIPT" && !scripts.includes(child)) scripts.push(child);
    },
  });
  Object.defineProperty(documentBase, "__setCurrentScript", {
    configurable: true,
    value(script) {
      this._currentScript = script || null;
    },
  });
  const document = observed("Document", documentBase);
  body.ownerDocument = document;
  head.ownerDocument = document;
  documentElement.ownerDocument = document;
  etScript.ownerDocument = document;

  const plugins = makePlugins();
  const navigator = observed("Navigator", {
    userAgent: TRACE_USER_AGENT,
    appCodeName: "Mozilla",
    appName: "Netscape",
    product: "Gecko",
    platform: "MacIntel",
    oscpu: "Intel Mac OS X 10.15",
    buildID: "20181001000000",
    vendor: "",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 12,
    maxTouchPoints: 0,
    cookieEnabled: true,
    webdriver: false,
    plugins,
    mimeTypes: [plugins[0][0], plugins[0][1]],
  });
  const screen = observed("Screen", { width: 1728, height: 1117, availWidth: 1728, availHeight: 1084 });
  const location = observed("Location", {
    href: "https://melody.shop.ele.me/login",
    protocol: "https:",
    host: "melody.shop.ele.me",
    hostname: "melody.shop.ele.me",
    pathname: "/login",
    search: "",
    hash: "",
    origin: "https://melody.shop.ele.me",
    toString() { return this.href; },
  });
  const performance = observed("Performance", {
    timeOrigin: options.timeOrigin ?? Date.now() - 6500,
    now: nativeFunction("now", () => Date.now() - performance.timeOrigin),
    getEntriesByName: nativeFunction("getEntriesByName", (name) =>
      scripts.some((script) => script.src === name) ? [{ name, decodedBodySize: 0 }] : []
    ),
    getEntriesByType: nativeFunction("getEntriesByType", (type) =>
      type === "resource" ? resourceNames.map((name) => ({ name })) : []
    ),
  });
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const fetchImpl = options.fetch || globalThis.fetch;
  const XMLHttpRequest = makeXMLHttpRequest(fetchImpl, location.href, TRACE_USER_AGENT);

  const windowBase = Object.assign(eventRoot, {
    window: null,
    self: null,
    globalThis: null,
    top: null,
    parent: null,
    document,
    navigator,
    screen,
    location,
    performance,
    localStorage,
    sessionStorage,
    XMLHttpRequest,
    screenLeft: dimensions.screenLeft,
    screenX: dimensions.screenLeft,
    mozInnerScreenX: dimensions.screenLeft,
    screenTop: dimensions.screenTop,
    screenY: dimensions.screenTop,
    innerWidth: dimensions.innerWidth,
    innerHeight: dimensions.innerHeight,
    outerWidth: dimensions.outerWidth,
    outerHeight: dimensions.outerHeight,
    AudioContext: AudioContextFixture,
    webkitAudioContext: AudioContextFixture,
    Image: ImageFixture,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    __traceMissing: missing,
    __traceDiagnostics: () => ({
      listeners: [...document._listeners.keys()],
      audioCreated: AudioContextFixture.created || 0,
      audioProcessed: AudioContextFixture.processed || 0,
    }),
  });
  const window = windowBase;
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.top = window;
  window.parent = window;
  document.defaultView = window;
  window.__emitTraceInput = async () => {
    const offsetX = Math.floor(Math.random() * 5) - 2;
    const offsetY = Math.floor(Math.random() * 5) - 2;
    let elapsed = Math.max(1, performance.now());
    const makeTarget = (tagName, id, className, rect, parentClass) => {
      const parent = new ElementFixture("div", dimensions);
      parent.className = parentClass || "cook-form-item-control-input-content";
      const target = new ElementFixture(tagName, dimensions);
      target.id = id || "";
      target.className = className || "";
      target.parentNode = parent;
      target.getBoundingClientRect = () => {
        const [x, y, width, height] = rect;
        return { x, y, top: y, left: x, right: x + width, bottom: y + height, width, height };
      };
      return target;
    };
    const username = makeTarget("input", "username_login_username", "cook-input cook-input-lg", [722, 338.41668701171875, 300, 25.149993896484375]);
    const password = makeTarget("input", "username_login_password", "cook-input cook-input-lg", [722, 402.566650390625, 276, 25.149993896484375]);
    const privacy = makeTarget("input", "", "cook-checkbox-input", [710, 510.51666259765625, 14, 14], "cook-checkbox");
    const button = makeTarget("button", "", "cook-btn cook-btn-primary cook-btn-round cook-btn-lg cook-btn-block", [710, 459.2166748046875, 340, 40]);
    const auxiliary = {
      input: password,
      span: makeTarget("span", "", "cook-input-suffix", [998, 402, 24, 26]),
      form: makeTarget("form", "", "login-form", [710, 322, 340, 230]),
      div: makeTarget("div", "", "cook-form-item", [710, 450, 340, 70]),
      label: makeTarget("label", "", "cook-checkbox-wrapper", [710, 507, 300, 20]),
      button,
    };
    const emit = async (type, target, x, y, extra = {}) => {
      const delay = 10 + Math.floor(Math.random() * 13);
      elapsed += delay;
      document.dispatchEvent({
        type,
        target,
        isTrusted: true,
        pageX: x == null ? 0 : x + offsetX,
        pageY: y == null ? 0 : y + offsetY,
        clientX: x == null ? 0 : x + offsetX,
        clientY: y == null ? 0 : y + offsetY,
        buttons: type === "mousedown" ? 1 : 0,
        which: type === "mousedown" || type === "mouseup" ? 1 : 0,
        isPrimary: type === "click",
        pointerId: type === "click" ? 0 : undefined,
        timeStamp: elapsed,
        ...extra,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    };
    const clickCycle = async (target, x, y, blurTarget) => {
      await emit("mousedown", target, x, y);
      if (blurTarget) await emit("blur", blurTarget);
      await emit("focus", target);
      await emit("mouseup", target, x, y);
      await emit("click", target, x, y);
    };
    const keyups = async (target, count) => {
      for (let index = 0; index < count; index += 1) await emit("keyup", target);
    };
    const moves = async (points) => {
      for (const [x, y, targetName = "input"] of points) await emit("mousemove", auxiliary[targetName], x, y);
    };

    await clickCycle(username, 793, 352);
    await keyups(username, 10);
    await moves([
      [793,353],[796,363],[798,366,"span"],[810,387,"form"],[815,393,"form"],
      [817,396,"span"],[818,397,"span"],[818,399,"span"],[818,399,"span"],
      [818,400,"span"],[819,401,"span"],[819,402,"span"],[819,402,"span"],
      [819,403],[819,405],[819,406],
    ]);
    await clickCycle(password, 819, 406, username);
    await keyups(password, 5);
    await moves([
      [819,407],[819,409],[818,411],[817,412],[816,414],[815,416],[813,418],
      [805,430,"span"],[799,439,"form"],[764,470,"button"],[753,477,"button"],
      [742,484,"button"],[707,513,"div"],[706,514,"div"],[705,515,"div"],
      [708,512,"div"],[709,512,"div"],[711,511],[714,510,"label"],
      [715,510,"label"],[717,509,"label"],[718,508,"label"],[719,508,"div"],
      [719,507,"div"],[718,509,"label"],[717,510,"label"],[717,511,"label"],
      [716,511],[716,512],[716,512],
    ]);
    await keyups(password, 4);
    await clickCycle(privacy, 716, 512, password);
    await moves([
      [745,499,"button"],[773,487,"button"],[785,483,"button"],[804,473,"button"],
      [811,472,"button"],[822,468,"button"],[823,468,"button"],[826,467,"button"],
      [827,466,"button"],[827,466,"button"],[828,466,"button"],[828,466,"button"],
      [828,465,"button"],[828,465,"button"],
    ]);
    await clickCycle(button, 828, 465, privacy);
  };
  return window;
}

module.exports = { createAsuraEnvironment, TRACE_USER_AGENT };
