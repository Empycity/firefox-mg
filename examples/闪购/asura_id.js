"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createAsuraEnvironment } = require("./asura_env");

const VENDOR_DIR = path.join(__dirname, "vendor");
const FIRE_EYE_CONFIG = Object.freeze({
  timeout: 100,
  noProxy: false,
  MaxMTLog: 20,
  MaxNGPLog: 10,
  MaxKS: 5,
  MaxFocusLog: 3,
  location: "cn",
});
const UMID_SCRIPT_PATTERN = /^https:\/\/ynuf\.aliapp\.org\/w\/wu\.json(?:[?#]|$)/;

function runScript(context, filename) {
  const source = fs.readFileSync(path.join(VENDOR_DIR, filename), "utf8");
  vm.runInContext(source, context, { filename, timeout: 10000 });
}

function callGetUA(context, module) {
  vm.runInContext(`{
    globalThis.__asuraOriginalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = function(target, property) {
      if (target == null && property === "head") return undefined;
      return globalThis.__asuraOriginalGetOwnPropertyDescriptor(target, property);
    };
  }`, context);
  try {
    return module.getUA();
  } finally {
    vm.runInContext(`{
      Object.getOwnPropertyDescriptor = globalThis.__asuraOriginalGetOwnPropertyDescriptor;
      delete globalThis.__asuraOriginalGetOwnPropertyDescriptor;
    }`, context);
  }
}

function findDynamicScript(sandbox, pattern, description) {
  const script = sandbox.document
    .getElementsByTagName("script")
    .find((entry) => pattern.test(entry.src || ""));
  if (!script) throw new Error(`AWSC did not append the ${description} script`);
  return script;
}

async function loadUmidCallbackScripts(sandbox, context, fetchImpl) {
  const loadedScripts = new Set();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scripts = sandbox.document
      .getElementsByTagName("script")
      .filter((entry) => UMID_SCRIPT_PATTERN.test(entry.src || ""));
    const pending = scripts.filter((entry) => !loadedScripts.has(entry));
    for (const script of pending) {
      const response = await fetchImpl(script.src, {
        headers: {
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.5",
          Referer: "https://melody.shop.ele.me/",
        },
      });
      if (!response.ok) {
        throw new Error(`WebUMID callback script returned HTTP ${response.status}`);
      }
      const source = await response.text();
      if (!source.includes("umx.wu") && !source.includes("__fycb")) {
        throw new Error("WebUMID callback script had an unexpected response");
      }
      sandbox.document.__setCurrentScript(script);
      vm.runInContext(source, context, { filename: script.src, timeout: 10000 });
      loadedScripts.add(script);
    }
    if (sandbox.localStorage.getItem("lswucn")) return;
  }
}

async function createFields(options = {}, includeUmid = false) {
  const sandbox = createAsuraEnvironment(options);
  const context = vm.createContext(sandbox);
  const fetchImpl = options.fetch || globalThis.fetch;
  runScript(context, "awsc-napos-puzzle-0.0.4.js");

  const bridge = sandbox.__napos_awsc_uab__;
  if (!bridge || typeof bridge.getUabModule !== "function") {
    throw new Error("AWSC UAB bridge was not exported");
  }
  const modulePromise = bridge.getUabModule();
  let fyPromise = null;
  let fireEye = null;
  if (includeUmid) {
    if (!sandbox.AWSC || typeof sandbox.AWSC.configFY !== "function") {
      throw new Error("AWSC configFY was not exported");
    }
    runScript(context, "fireyejs-1.231.13.js");
    if (typeof sandbox.AWSC.configFYSyncEx !== "function") {
      throw new Error("AWSC configFYSyncEx was not exported");
    }
    fireEye = sandbox.AWSC.configFYSyncEx({ ...FIRE_EYE_CONFIG });
    fyPromise = new Promise((resolve) => {
      sandbox.AWSC.configFY(resolve, { appName: "eleme-napos-pc" });
    });
    const umidScript = findDynamicScript(
      sandbox,
      /\/AWSC\/WebUMID\/1\.93\.0\/um\.js(?:[?#]|$)/,
      "WebUMID"
    );
    sandbox.document.__setCurrentScript(umidScript);
    runScript(context, "web-umid-1.93.0.js");
  }
  const collinaScript = findDynamicScript(
    sandbox,
    /\/AWSC\/uab\/1\.140\.0\/collina\.js(?:[?#]|$)/,
    "collina"
  );
  sandbox.document.__setCurrentScript(collinaScript);
  runScript(context, "collina-1.140.0.js");
  sandbox.document.__setCurrentScript(null);
  const [module, fyObject] = await Promise.all([modulePromise, fyPromise]);
  if (includeUmid && fyObject.uabModule !== module) {
    throw new Error("AWSC configFY and Napos did not share the UAB module");
  }
  if (includeUmid) {
    await loadUmidCallbackScripts(sandbox, context, fetchImpl);
    sandbox.document.__setCurrentScript(null);
  }
  await sandbox.__emitTraceInput();
  const asuraId = callGetUA(context, module);
  const fireUa = callGetUA(context, module);
  for (const [name, value] of Object.entries({ asuraId, fireUa })) {
    if (typeof value !== "string" || !value.startsWith("140#")) {
      throw new Error(`UAB getUA returned an invalid ${name} value`);
    }
  }
  if (!includeUmid) return { asuraId, fireUa };
  const fireUmid = fyObject && fyObject.umidToken;
  if (typeof fireUmid !== "string" || !/^T2gA[A-Za-z0-9_-]{63}=$/.test(fireUmid)) {
    throw new Error("WebUMID returned an invalid fireUmid value");
  }
  const bxUmidToken = fireEye && fireEye.getUidToken();
  if (typeof bxUmidToken !== "string" || !/^T2gA[A-Za-z0-9_-]{63}=$/.test(bxUmidToken)) {
    const storedToken = sandbox.localStorage.getItem("lswucn");
    throw new Error(
      `FireEye returned an invalid bxUmidToken value (lswucn=${storedToken || "empty"})`
    );
  }
  return { asuraId, fireUa, fireUmid, bxUmidToken };
}

async function createUabFields(options = {}) {
  return createFields(options, false);
}

async function createLoginSecurityFields(options = {}) {
  return createFields(options, true);
}

async function createAsuraId(options = {}) {
  return (await createUabFields(options)).asuraId;
}

async function createFireUa(options = {}) {
  return (await createUabFields(options)).fireUa;
}

async function createFireUmid(options = {}) {
  return (await createLoginSecurityFields(options)).fireUmid;
}

async function createBxUmidToken(options = {}) {
  return (await createLoginSecurityFields(options)).bxUmidToken;
}

module.exports = {
  createAsuraId,
  createFireUa,
  createFireUmid,
  createBxUmidToken,
  createUabFields,
  createLoginSecurityFields,
};
