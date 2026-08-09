const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

const DEFAULT_ENV_PATCH = {
  extend: {
    wk: 0,
    bu3: 43,
    bu5: 0,
    bu6: 32,
    bu7: 0,
    bu8: 0,
    bu13: "Fz",
  },
  top: {},
};

function randomDigits(length) {
  let value = "";
  while (value.length < length) {
    value += String(Math.floor(Math.random() * 10));
  }
  return value.slice(0, length);
}

function createDefaultBrowserEnv(overrides = {}) {
  const width = overrides.width || 1510;
  const height = overrides.height || 1080;
  const screenWidth = overrides.screenWidth || 1728;
  const screenHeight = overrides.screenHeight || 1117;
  const ua =
    overrides.ua ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

  return {
    ua,
    appVersion: ua.replace(/^Mozilla\//, ""),
    platform: overrides.platform || "MacIntel",
    language: overrides.language || "zh-CN",
    languages: overrides.languages || ["zh-CN", "zh"],
    pluginsLen: overrides.pluginsLen ?? 5,
    mimeTypesLen: overrides.mimeTypesLen ?? 2,
    webdriver: false,
    hardwareConcurrency: overrides.hardwareConcurrency || 12,
    deviceMemory: overrides.deviceMemory || 8,
    devicePixelRatio: overrides.devicePixelRatio || 2,
    outerWidth: width,
    outerHeight: height,
    innerWidth: overrides.innerWidth || Math.max(1280, width - 70),
    innerHeight: overrides.innerHeight || Math.max(720, height - 180),
    screen: {
      width: screenWidth,
      height: screenHeight,
      availWidth: screenWidth,
      availHeight: overrides.availHeight || screenHeight - 33,
      colorDepth: overrides.colorDepth || 30,
      pixelDepth: overrides.pixelDepth || 30,
    },
    location: {
      href: "https://www.jd.com/",
      origin: "https://www.jd.com",
      host: "www.jd.com",
      hostname: "www.jd.com",
      protocol: "https:",
      pathname: "/",
      search: "",
    },
    referrer: overrides.referrer || "",
    chrome: true,
    canvas: overrides.canvas || "data:image/png;base64,",
    profileId: overrides.profileId || `${Date.now()}${randomDigits(6)}`,
  };
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function patchSdkSource(source) {
  const needle = `        },
        _$fG,
      ),
      _$fG
    );
  }
  function _$fP() {`;
  const replacement = `        },
        _$fG,
      ),
      (window.__jdEnvPatch && window.__jdEnvPatch.extend && _$fG.extend && Object.assign(_$fG.extend, window.__jdEnvPatch.extend),
       window.__jdEnvPatch && window.__jdEnvPatch.top && Object.assign(_$fG, window.__jdEnvPatch.top)),
      _$fG
    );
  }
  function _$fP() {`;

  if (!source.includes(needle)) {
    throw new Error("SDK patch anchor not found; js_security_v3 source changed");
  }
  return source.replace(needle, replacement);
}

function makeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
    key(index) {
      return Array.from(entries.keys())[index] ?? null;
    },
    get length() {
      return entries.size;
    },
    dump() {
      return Object.fromEntries(entries);
    },
  };
}

function installDomStubs(ctx, browserEnv) {
  function FakeElement(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.children = [];
  }

  FakeElement.prototype.setAttribute = function setAttribute(key, value) {
    this[key] = String(value);
  };
  FakeElement.prototype.getAttribute = function getAttribute(key) {
    return this[key] || null;
  };
  FakeElement.prototype.appendChild = function appendChild(node) {
    this.children.push(node);
    return node;
  };
  FakeElement.prototype.removeChild = function removeChild(node) {
    return node;
  };
  FakeElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  };
  Object.defineProperties(FakeElement.prototype, {
    offsetWidth: { get() { return 100; } },
    offsetHeight: { get() { return 20; } },
    clientWidth: { get() { return 100; } },
    clientHeight: { get() { return 20; } },
  });

  function FakeCanvas() {
    FakeElement.call(this, "canvas");
    this.width = 300;
    this.height = 150;
  }
  FakeCanvas.prototype = Object.create(FakeElement.prototype);
  FakeCanvas.prototype.constructor = FakeCanvas;
  function create2dContext() {
    return {
      fillStyle: "#000",
      font: "10px sans-serif",
      textBaseline: "alphabetic",
      globalCompositeOperation: "source-over",
      fillRect() {},
      clearRect() {},
      fillText() {},
      measureText() {
        return { width: 42 };
      },
      getImageData() {
        return { data: new Uint8ClampedArray(4) };
      },
      putImageData() {},
      createImageData() {
        return { data: new Uint8ClampedArray(4) };
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      rect() {},
      closePath() {},
      stroke() {},
      arc() {},
      fill() {},
      isPointInPath() {
        return false;
      },
      save() {},
      restore() {},
      translate() {},
      scale() {},
      rotate() {},
    };
  }
  function createWebglContext(canvas) {
    return {
      canvas,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
      FLOAT: 0x1406,
      TRIANGLE_STRIP: 0x0005,
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      DEPTH_TEST: 0x0b71,
      LEQUAL: 0x0203,
      ALIASED_LINE_WIDTH_RANGE: 0x846e,
      ALIASED_POINT_SIZE_RANGE: 0x846d,
      ALPHA_BITS: 0x0d55,
      BLUE_BITS: 0x0d54,
      DEPTH_BITS: 0x0d56,
      GREEN_BITS: 0x0d53,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
      MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      MAX_TEXTURE_IMAGE_UNITS: 0x8872,
      MAX_TEXTURE_SIZE: 0x0d33,
      MAX_VARYING_VECTORS: 0x8dfc,
      MAX_VERTEX_ATTRIBS: 0x8869,
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
      MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
      MAX_VIEWPORT_DIMS: 0x0d3a,
      RED_BITS: 0x0d52,
      RENDERER: 0x1f01,
      SHADING_LANGUAGE_VERSION: 0x8b8c,
      STENCIL_BITS: 0x0d57,
      VENDOR: 0x1f00,
      VERSION: 0x1f02,
      createBuffer() {
        return {};
      },
      bindBuffer() {},
      bufferData() {},
      createProgram() {
        return {};
      },
      createShader(type) {
        return { type };
      },
      shaderSource() {},
      compileShader() {},
      attachShader() {},
      linkProgram() {},
      useProgram() {},
      getAttribLocation() {
        return 0;
      },
      getUniformLocation() {
        return {};
      },
      enableVertexAttribArray() {},
      vertexAttribPointer() {},
      uniform2f() {},
      drawArrays() {},
      clearColor() {},
      enable() {},
      depthFunc() {},
      clear() {},
      getContextAttributes() {
        return { antialias: true };
      },
      getSupportedExtensions() {
        return ["EXT_texture_filter_anisotropic", "WEBGL_debug_renderer_info"];
      },
      getExtension(name) {
        if (name === "WEBGL_debug_renderer_info") {
          return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
        }
        if (String(name).includes("texture_filter_anisotropic")) {
          return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff };
        }
        return null;
      },
      getParameter(parameter) {
        const values = new Map([
          [0x1f00, "Google Inc. (Apple)"],
          [0x1f01, "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"],
          [0x8b8c, "WebGL GLSL ES 1.0"],
          [0x1f02, "WebGL 1.0"],
          [0x846e, [1, 1]],
          [0x846d, [1, 1024]],
          [0x0d3a, [16384, 16384]],
          [0x9245, "Google Inc. (Apple)"],
          [0x9246, "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"],
        ]);
        return values.get(parameter) ?? 8;
      },
      getShaderPrecisionFormat() {
        return { rangeMin: 127, rangeMax: 127, precision: 23 };
      },
    };
  }
  FakeCanvas.prototype.getContext = function getContext(type) {
    if (String(type).includes("webgl")) return createWebglContext(this);
    return create2dContext();
  };
  FakeCanvas.prototype.toDataURL = function toDataURL() {
    return browserEnv.canvas || "data:image/png;base64,";
  };

  ctx.Window = function Window() {};
  ctx.Element = FakeElement;
  ctx.HTMLElement = FakeElement;
  ctx.HTMLCanvasElement = FakeCanvas;
  ctx.HTMLDivElement = FakeElement;
  ctx.Node = FakeElement;
  ctx.HTMLAllCollection = function HTMLAllCollection() {};
  ctx.WebGLRenderingContext = function WebGLRenderingContext() {};

  ctx.document = {
    cookie: browserEnv.cookie || "",
    referrer: browserEnv.referrer || "",
    title: "京东",
    domain: "jd.com",
    compatMode: "CSS1Compat",
    hidden: false,
    visibilityState: "visible",
    location: ctx.location,
    createElement(tag) {
      return String(tag).toLowerCase() === "canvas" ? new FakeCanvas() : new FakeElement(tag);
    },
    getElementsByTagName() {
      return [];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    hasFocus() {
      return true;
    },
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
  };
}

function createContext({ browserEnv, storage, envPatch }) {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    Uint8ClampedArray,
  };

  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;

  const location = browserEnv.location || {
    href: "https://www.jd.com/",
    origin: "https://www.jd.com",
    host: "www.jd.com",
    protocol: "https:",
    pathname: "/",
  };
  ctx.location = { ...location, search: location.search || "", hostname: location.hostname || location.host };
  ctx.location.toString = function toString() {
    return this.href;
  };

  ctx.navigator = {
    userAgent: browserEnv.ua,
    appVersion: browserEnv.appVersion,
    appName: "Netscape",
    appCodeName: "Mozilla",
    product: "Gecko",
    language: browserEnv.language,
    languages: browserEnv.languages,
    platform: browserEnv.platform,
    hardwareConcurrency: browserEnv.hardwareConcurrency,
    deviceMemory: browserEnv.deviceMemory || 8,
    cookieEnabled: true,
    webdriver: browserEnv.webdriver,
    plugins: Array.from({ length: browserEnv.pluginsLen || 0 }, (_, index) => ({
      name: `Plugin ${index}`,
      filename: `plugin${index}`,
      description: "",
    })),
    mimeTypes: Array.from({ length: browserEnv.mimeTypesLen || 0 }, (_, index) => ({
      type: `application/x-${index}`,
    })),
  };

  ctx.screen = { ...(browserEnv.screen || {}) };
  ctx.screenLeft = 0;
  ctx.screenTop = 0;
  ctx.outerWidth = browserEnv.outerWidth;
  ctx.outerHeight = browserEnv.outerHeight;
  ctx.innerWidth = browserEnv.innerWidth || 1440;
  ctx.innerHeight = browserEnv.innerHeight || 900;
  ctx.devicePixelRatio = browserEnv.devicePixelRatio;
  ctx.chrome = browserEnv.chrome ? { runtime: {} } : undefined;
  ctx.getComputedStyle = function getComputedStyle() {
    return {
      getPropertyValue() {
        return "16px";
      },
    };
  };
  ctx.localStorage = makeStorage(storage);
  ctx.sessionStorage = makeStorage();
  ctx.crypto = crypto.webcrypto;
  ctx.performance = { now: () => 0, timing: {}, navigation: {} };
  ctx.XMLHttpRequest = function XMLHttpRequest() {
    throw new Error("XHR disabled in signer VM");
  };
  ctx.__jdEnvPatch = envPatch || DEFAULT_ENV_PATCH;

  installDomStubs(ctx, browserEnv);
  return ctx;
}

function createNodeXMLHttpRequest({ browserEnv, extraHeaders = {} }) {
  return class NodeXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = "";
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.ontimeout = null;
      this.onabort = null;
      this.timeout = 0;
      this.withCredentials = false;
    }

    open(method, url, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
      this._emitReadyStateChange();
    }

    setRequestHeader(key, value) {
      this.headers[key] = value;
    }

    getAllResponseHeaders() {
      return this.responseHeadersText || "";
    }

    abort() {
      this.aborted = true;
      if (typeof this.onabort === "function") this.onabort();
    }

    async send(data) {
      const controller = new AbortController();
      let timeoutId = null;
      if (this.timeout > 0) {
        timeoutId = setTimeout(() => {
          controller.abort();
          if (typeof this.ontimeout === "function") this.ontimeout();
        }, this.timeout);
      }

      try {
        const headers = {
          ...this.headers,
          origin: browserEnv.location?.origin || "https://www.jd.com",
          referer: browserEnv.location?.href || "https://www.jd.com/",
          "user-agent": browserEnv.ua,
          ...extraHeaders,
        };

        const response = await fetch(this.url, {
          method: this.method,
          headers,
          body: data,
          signal: controller.signal,
        });

        this.status = response.status;
        this.statusText = response.statusText;
        this.responseText = await response.text();
        this.response = this.responseText;
        this.responseHeadersText = Array.from(response.headers.entries())
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n");
        this.readyState = 4;
        this._emitReadyStateChange();
        if (typeof this.onload === "function") this.onload();
      } catch (error) {
        this.statusText = error.message;
        this.readyState = 4;
        this._emitReadyStateChange();
        if (typeof this.onerror === "function") this.onerror(error);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    _emitReadyStateChange() {
      if (typeof this.onreadystatechange === "function") {
        this.onreadystatechange();
      }
    }
  };
}

function createSigner(options) {
  const sdkSource = patchSdkSource(fs.readFileSync(options.sdkPath, "utf8"));
  const browserEnv = options.browserEnv || createDefaultBrowserEnv();
  const ctx = createContext({
    browserEnv,
    storage: options.storage,
    envPatch: options.envPatch || DEFAULT_ENV_PATCH,
  });

  if (options.enableNetwork) {
    ctx.XMLHttpRequest = createNodeXMLHttpRequest({
      browserEnv,
      extraHeaders: options.requestHeaders || {},
    });
  }

  vm.createContext(ctx);
  vm.runInContext(sdkSource, ctx, { filename: "js_security_v3_0.1.4.js", timeout: 5000 });

  const signer = new ctx.ParamsSign({ appId: options.appId || "b5216", preRequest: false });

  function dumpStorage() {
    return ctx.localStorage.dump();
  }

  function hasUsableToken() {
    return Boolean(signer._token && signer._fingerprint);
  }

  async function ensureToken({ force = false, timeoutMs = 15000 } = {}) {
    if (!force && hasUsableToken()) {
      return {
        fingerprint: signer._fingerprint,
        tokenLength: signer._token.length,
        storage: dumpStorage(),
      };
    }
    if (typeof signer._$rds !== "function") {
      throw new Error("ParamsSign._$rds not found; js_security_v3 source changed");
    }

    signer._$rds();
    const startedAt = Date.now();
    let reloadedFromCache = false;
    while (Date.now() - startedAt < timeoutMs) {
      if (hasUsableToken()) {
        return {
          fingerprint: signer._fingerprint,
          tokenLength: signer._token.length,
          storage: dumpStorage(),
        };
      }
      if (!reloadedFromCache && dumpStorage().WQ_dy1_tk_algo) {
        reloadedFromCache = true;
        signer._$rds();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const storageKeys = Object.keys(dumpStorage());
    throw new Error(`Timed out waiting for request_algo token; storage keys=${storageKeys.join(",")}`);
  }

  function signRequest({ body, functionId, uuid, t = Date.now(), appid = "www-jd-com", signInput: customSignInput }) {
    const bodyText = typeof body === "string" ? body : JSON.stringify(body);
    const signInput =
      customSignInput ||
      {
        appid,
        body: sha256Hex(bodyText),
        client: "pc",
        clientVersion: "1.0.0",
        functionId,
        t,
        uuid,
      };
    const signed = signer.signSync({ ...signInput });
    return {
      signInput,
      h5st: signed.h5st,
      _stk: signed._stk,
      _ste: signed._ste,
      params: {
        appid,
        client: "pc",
        clientVersion: "1.0.0",
        t: String(t),
        uuid,
        body: bodyText,
        functionId,
        h5st: signed.h5st,
        loginType: "3",
      },
      diagnostics: {
        appId: signer._appId,
        version: signer._version,
        fingerprint: signer._fingerprint,
        tokenLength: signer._token ? signer._token.length : 0,
        h5stSegmentLengths: signed.h5st.split(";").map((part) => part.length),
      },
    };
  }

  return { signRequest, ensureToken, dumpStorage, signer, context: ctx, browserEnv };
}

module.exports = {
  DEFAULT_ENV_PATCH,
  createNodeXMLHttpRequest,
  createDefaultBrowserEnv,
  createVmContext: createContext,
  createSigner,
  sha256Hex,
};
