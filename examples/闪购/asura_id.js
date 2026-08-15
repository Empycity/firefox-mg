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

async function createAsuraId(options = {}) {
  const sandbox = createAsuraEnvironment(options);
  const context = vm.createContext(sandbox);
  runScript(context, "awsc-napos-puzzle-0.0.4.js");

  const bridge = sandbox.__napos_awsc_uab__;
  if (!bridge || typeof bridge.getUabModule !== "function") {
    throw new Error("AWSC UAB bridge was not exported");
  }
  const modulePromise = bridge.getUabModule();
  const collinaScript = sandbox.document
    .getElementsByTagName("script")
    .find((script) => /\/AWSC\/uab\/1\.140\.0\/collina\.js(?:[?#]|$)/.test(script.src || ""));
  if (!collinaScript) {
    throw new Error("AWSC did not append the collina script");
  }
  sandbox.document.__setCurrentScript(collinaScript);
  runScript(context, "collina-1.140.0.js");
  sandbox.document.__setCurrentScript(null);
  await sandbox.__emitTraceInput();
  const module = await modulePromise;
  const value = callGetUA(context, module);
  if (typeof value !== "string" || !value.startsWith("140#")) {
    throw new Error("UAB getUA returned an invalid value");
  }
  return value;
}

module.exports = { createAsuraId };
