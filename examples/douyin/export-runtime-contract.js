#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const traceDir = process.argv[2];
const outputDir = process.argv[3] || path.join(process.cwd(), "douyin");
if (!traceDir) {
  process.stderr.write("Usage: export-runtime-contract.js TRACE_DIR [OUTPUT_DIR]\n");
  process.exit(2);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseCookieHeader(value) {
  const cookies = {};
  for (const item of String(value || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    cookies[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return cookies;
}

const network = jsonLines(path.join(traceDir, "categorized", "network.jsonl"));
const request = network.find(
  (row) => row.type === "xhr.send" && /\/comment\/list(?:\/|\?)/.test(row.url || "")
);
if (!request) throw new Error("No comment/list xhr.send was found");

const requestUrl = new URL(request.url);
requestUrl.searchParams.delete("a_bogus");
const headers = Object.fromEntries(
  network
    .filter((row) => row.request_id === request.request_id && row.type === "xhr.header")
    .map((row) => [String(row.detail_name || ""), String(row.detail_value || "")])
    .filter(([name, value]) => name && value)
);

const state = jsonLines(path.join(traceDir, "categorized", "state.jsonl"));
let cookieHeader = "";
const localStorage = {};
const sessionStorage = {};
for (const row of state) {
  if (Number(row.ts_us || 0) > Number(request.ts_us || 0)) continue;
  if (row.type === "cookie.get" && row.source === "document.cookie" && row.value_preview) {
    cookieHeader = row.value_preview;
    continue;
  }
  const target = row.storage_type === "sessionStorage" ? sessionStorage : localStorage;
  if (row.type === "storage.set" && row.key && row.value_preview !== undefined) target[row.key] = row.value_preview;
  if (row.type === "storage.remove" && row.key) delete target[row.key];
  if (row.type === "storage.clear") for (const key of Object.keys(target)) delete target[key];
}

const environmentContract = readJson(path.join(traceDir, "index", "environment-contract.json"));
const source = fs.readdirSync(path.join(traceDir, "web-assets", "js"))
  .find((name) => /bdms_1\.0\.1\.19_fix\.js$/.test(name));
if (!source) throw new Error("BDMS script artifact is missing");

const assetDir = path.join(outputDir, "assets");
fs.mkdirSync(assetDir, { recursive: true });
const assetName = "bdms_1.0.1.19_fix.js";
fs.copyFileSync(path.join(traceDir, "web-assets", "js", source), path.join(assetDir, assetName));

const contract = {
  schema: "douyin.runtime_contract.v1",
  generated_from: path.resolve(traceDir),
  script_path: path.join("assets", assetName),
  request: {
    request_id: request.request_id,
    method: request.method,
    unsigned_url: requestUrl.href,
    headers,
    body: null,
    target_field: "a_bogus",
  },
  init: {
    aid: Number(requestUrl.searchParams.get("aid") || 6383),
    pageId: 6241,
    paths: ["/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/"],
  },
  environment_contract: environmentContract,
  restore_seed: {
    cookies: parseCookieHeader(cookieHeader),
    localStorage,
    sessionStorage,
  },
  dynamic_contract: {
    time: "live Date.now/no-arg Date; never imported from trace",
    random: "live Math.random; never imported from trace",
    performance_now: "observed, but fixed-performance A/B did not change a_bogus",
  },
};
fs.writeFileSync(
  path.join(outputDir, "runtime-contract.json"),
  `${JSON.stringify(contract, null, 2)}\n`
);
process.stdout.write(`${path.join(outputDir, "runtime-contract.json")}\n`);
