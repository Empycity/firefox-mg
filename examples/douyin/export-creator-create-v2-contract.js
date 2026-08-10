#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const traceDir = path.resolve(process.argv[2] || "");
const outputPath = path.resolve(process.argv[3] || path.join(__dirname, "creator-runtime-contract.json"));
const environmentTraceDir = path.resolve(process.argv[4] || traceDir);
if (!process.argv[2]) {
  process.stderr.write("Usage: export-creator-create-v2-contract.js TRACE_DIR [OUTPUT] [ENVIRONMENT_TRACE_DIR]\n");
  process.exit(2);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function storedValue(event, previewKey = "value_preview", sourceDir = traceDir) {
  const relativePath = event.value_store_path || event.request_body_store_path;
  if (relativePath) {
    const artifact = path.join(sourceDir, relativePath);
    if (fs.existsSync(artifact)) return fs.readFileSync(artifact, "utf8");
  }
  return event[previewKey] ?? "";
}

function parseCookies(value) {
  return Object.fromEntries(String(value).split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return [];
    return [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
  }));
}

const endpoint = "/web/api/media/aweme/create_v2/";
const network = jsonLines(path.join(traceDir, "categorized", "network.jsonl"));
const open = network.find((event) => event.type === "xhr.open" && new URL(event.url).pathname === endpoint);
if (!open) throw new Error(`No ${endpoint} xhr.open was found`);

const requestEvents = network.filter((event) => event.request_id === open.request_id);
const bodyEvent = requestEvents.find((event) => event.type === "xhr.body");
const headers = Object.fromEntries(requestEvents
  .filter((event) => event.type === "xhr.header" && event.detail_name)
  .map((event) => [event.detail_name, event.detail_value]));
const unsignedUrl = new URL(open.url);
unsignedUrl.searchParams.delete("a_bogus");

const environment = readJson(path.join(environmentTraceDir, "index", "environment-contract.json"));
const environmentKeys = [
  "Location.href", "Location.origin", "Location.protocol", "Location.host",
  "Location.hostname", "Location.pathname", "Location.search",
  "Document.referrer", "Document.hidden", "Document.visibilityState", "Document.characterSet",
  "Navigator.userAgent", "Navigator.language", "Navigator.platform", "Navigator.vendor",
  "Navigator.hardwareConcurrency", "Navigator.cookieEnabled", "Navigator.onLine", "Navigator.webdriver",
  "Screen.width", "Screen.height", "Screen.availWidth", "Screen.availHeight",
  "Screen.colorDepth", "Screen.pixelDepth", "Window.innerWidth", "Window.innerHeight",
  "Window.outerWidth", "Window.outerHeight", "Window.screenX", "Window.screenY",
  "Window.devicePixelRatio"
];
const values = Object.fromEntries(environmentKeys.flatMap((key) =>
  environment.values?.[key] ? [[key, environment.values[key]]] : []
));

let cookies = {};
const localStorage = {};
const sessionStorage = {};
for (const event of jsonLines(path.join(environmentTraceDir, "categorized", "state.jsonl"))) {
  if (Number(event.ts_us || 0) > Number(open.ts_us || 0)) continue;
  if (event.type === "cookie.get" && event.source === "document.cookie") {
    cookies = parseCookies(storedValue(event, "value_preview", environmentTraceDir));
    continue;
  }
  const target = event.storage_type === "sessionStorage" ? sessionStorage : localStorage;
  if (event.type === "storage.set" && event.key) {
    target[event.key] = storedValue(event, "value_preview", environmentTraceDir);
  }
  if (event.type === "storage.remove" && event.key) delete target[event.key];
  if (event.type === "storage.clear") for (const key of Object.keys(target)) delete target[key];
}

const bodyText = bodyEvent ? storedValue(bodyEvent, "request_body_preview") : "";
let body = bodyText || null;
try { body = JSON.parse(bodyText); } catch {}
const contract = {
  schema: "douyin.runtime_contract.v1",
  generated_from: traceDir,
  environment_generated_from: environmentTraceDir,
  script_path: "assets/bdms_1.0.1.16.js",
  request: {
    request_id: open.request_id,
    method: open.method,
    unsigned_url: unsignedUrl.href,
    headers,
    body,
    target_field: "a_bogus",
  },
  init: {
    aid: 2906,
    pageId: 33638,
    paths: {
      include: ["/aweme", "/web/api", "/passport", "/bind_mobile", "/live/api/room/create_media_room"],
    },
  },
  environment_contract: {
    schema: environment.schema,
    coverage: environment.coverage,
    values,
  },
  restore_seed: { cookies, localStorage, sessionStorage },
  dynamic_contract: {
    time: "live Date.now/no-arg Date",
    random: "live Math.random",
    msToken: "current session value in request.unsigned_url",
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
process.stdout.write(`${outputPath}\n`);
