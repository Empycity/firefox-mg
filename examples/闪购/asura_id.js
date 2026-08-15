"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createAsuraEnvironment } = require("./asura_env");

const VENDOR_DIR = path.join(__dirname, "vendor");

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

async function createFields(options = {}, includeUmid = false) {
  const sandbox = createAsuraEnvironment(options);
  const context = vm.createContext(sandbox);
  runScript(context, "awsc-napos-puzzle-0.0.4.js");

  const bridge = sandbox.__napos_awsc_uab__;
  if (!bridge || typeof bridge.getUabModule !== "function") {
    throw new Error("AWSC UAB bridge was not exported");
  }
  const modulePromise = bridge.getUabModule();
  let fyPromise = null;
  if (includeUmid) {
    if (!sandbox.AWSC || typeof sandbox.AWSC.configFY !== "function") {
      throw new Error("AWSC configFY was not exported");
    }
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
  return { asuraId, fireUa, fireUmid };
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

module.exports = {
  createAsuraId,
  createFireUa,
  createFireUmid,
  createUabFields,
  createLoginSecurityFields,
};
