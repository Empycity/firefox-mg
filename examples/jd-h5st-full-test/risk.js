const fs = require("node:fs");
const vm = require("node:vm");
const { createDefaultBrowserEnv, createNodeXMLHttpRequest, createVmContext } = require("./signer");

const TOKEN_KEY = "3AB9D23F7A4B3CSS";
const EID_KEY = "3AB9D23F7A4B3C9B";
const FP_KEY = "PCA9D23F7A4B3CSS";

function parseCookieString(cookieString = "") {
  const jar = new Map();
  for (const part of String(cookieString).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return jar;
}

function cookieJarToString(jar) {
  return Array.from(jar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function installCookieJar(ctx, initialCookie) {
  const jar = parseCookieString(initialCookie);
  Object.defineProperty(ctx.document, "cookie", {
    configurable: true,
    get() {
      return cookieJarToString(jar);
    },
    set(value) {
      const firstPart = String(value).split(";")[0];
      const index = firstPart.indexOf("=");
      if (index > 0) {
        jar.set(firstPart.slice(0, index).trim(), firstPart.slice(index + 1).trim());
      }
    },
  });
  return {
    set(name, value) {
      jar.set(name, value);
    },
    get(name) {
      return jar.get(name);
    },
    toString() {
      return cookieJarToString(jar);
    },
  };
}

function installRiskGlobals(ctx, browserEnv, initialCookie) {
  const cookieJar = installCookieJar(ctx, initialCookie);
  ctx.console = { ...console, debug() {} };
  ctx.bp_bizid = "JDLS-PC-HOME";
  ctx._riskFpMode = "strict";
  ctx.orderId = "";
  ctx.pin = "";
  ctx.jd_jr_td_risk_pin = "";
  ctx.jdfp_pinenp_ext = undefined;
  ctx.gia_fp_qd_uuid = "";

  ctx.navigator.vendor = "Google Inc.";
  ctx.navigator.javaEnabled = () => false;
  ctx.navigator.doNotTrack = null;
  ctx.navigator.maxTouchPoints = 0;

  ctx.ActiveXObject = function ActiveXObject() {
    throw new Error("ActiveXObject is unavailable");
  };
  ctx.Blob = function Blob(parts = [], options = {}) {
    this.parts = parts;
    this.type = options.type || "";
  };
  ctx.URL = {
    createObjectURL() {
      return "blob:https://www.jd.com/local-risk-worker";
    },
  };
  ctx.Worker = undefined;
  ctx.external = {};
  ctx.AudioContext = undefined;
  ctx.webkitAudioContext = undefined;

  ctx.XMLHttpRequest = createNodeXMLHttpRequest({
    browserEnv,
    extraHeaders: {
      origin: "https://www.jd.com",
      referer: "https://www.jd.com/",
      cookie: cookieJar.toString(),
    },
  });
  ctx.window.XMLHttpRequest = ctx.XMLHttpRequest;

  return cookieJar;
}

function createRiskRuntime(options) {
  const browserEnv = options.browserEnv || createDefaultBrowserEnv();
  const ctx = createVmContext({
    browserEnv,
    storage: options.storage || {},
    envPatch: {},
  });
  const cookieJar = installRiskGlobals(ctx, browserEnv, options.cookie || "");

  vm.createContext(ctx);
  const source = fs.readFileSync(options.scriptPath, "utf8");
  vm.runInContext(source, ctx, { filename: "pc-tk.js", timeout: 5000 });

  function dumpStorage() {
    return ctx.localStorage.dump();
  }

  async function ensureRiskToken({ timeoutMs = 5000 } = {}) {
    const cachedToken = dumpStorage()[TOKEN_KEY] || "";
    const cachedEid = dumpStorage()[EID_KEY] || "";
    const cachedFp = dumpStorage()[FP_KEY] || "";
    if (cachedToken && cachedEid && cachedFp) {
      cookieJar.set(TOKEN_KEY, cachedToken);
      cookieJar.set(EID_KEY, cachedEid);
      return {
        jsToken: cachedToken,
        eid: cachedEid,
        fp: cachedFp,
        storage: dumpStorage(),
        cookie: cookieJar.toString(),
      };
    }

    const jsTokenResult = await new Promise((resolve) => {
      ctx.getJsToken((result) => resolve(result || {}), timeoutMs);
    });
    const eidResult = await new Promise((resolve) => {
      ctx.getJdEid((eid, fp, detail) => resolve({ eid, fp, detail }), null, Math.ceil(timeoutMs / 50));
    });

    const storage = dumpStorage();
    const jsToken = jsTokenResult.jsToken || storage[TOKEN_KEY] || "";
    const eid = eidResult.eid || storage[EID_KEY] || "";
    const fp = jsTokenResult.fp || eidResult.fp || storage[FP_KEY] || "";

    if (jsToken) cookieJar.set(TOKEN_KEY, jsToken);
    if (eid) cookieJar.set(EID_KEY, eid);

    return {
      jsToken,
      eid,
      fp,
      storage,
      cookie: cookieJar.toString(),
    };
  }

  return {
    context: ctx,
    browserEnv,
    cookieJar,
    dumpStorage,
    ensureRiskToken,
  };
}

module.exports = {
  EID_KEY,
  FP_KEY,
  TOKEN_KEY,
  createRiskRuntime,
};
