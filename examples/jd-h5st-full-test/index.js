const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createRiskRuntime, EID_KEY, TOKEN_KEY } = require("./risk");
const { createDefaultBrowserEnv, createSigner } = require("./signer");

const ROOT = __dirname;
const STATE_DIR = path.join(__dirname, "state");
const STATE_FILE = path.join(STATE_DIR, "index_state.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return readJson(STATE_FILE);
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function randomDigits(length) {
  let value = "";
  while (value.length < length) value += String(Math.floor(Math.random() * 10));
  return value.slice(0, length);
}

function randomBase64Url(length) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString("base64url").slice(0, length);
}

function pickCookieFields(cookieString) {
  const result = {};
  for (const part of String(cookieString || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

function readExternalCookie() {
  const filePath = process.env.JD_COOKIE_FILE;
  if (!filePath) return "";
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : parsed.cookie || "";
  } catch {
    return raw;
  }
}

function buildUuid(visitState) {
  return `95931165.${visitState.jdu}.${visitState.firstVisitSec}.${visitState.previousVisitSec}.${visitState.currentVisitSec}.${visitState.sessionCount}`;
}

function ensureVisitState(state) {
  if (state.visit) return state.visit;
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  state.visit = {
    jdu: `${now}${randomDigits(9)}`,
    firstVisitSec: sec,
    previousVisitSec: sec,
    currentVisitSec: sec,
    sessionCount: 1,
  };
  return state.visit;
}

function ensureProtocolCookieState(state) {
  if (state.protocolCookies) return state.protocolCookies;
  const sec = Math.floor(Date.now() / 1000);
  const shshId = crypto.randomUUID();
  state.protocolCookies = {
    areaId: "21",
    ipLocDjd: "21-1911-0-0",
    pcsyCityId: "CN_360000_360700_0",
    shshshfpa: `${shshId}-${sec}`,
    shshshfpx: `${shshId}-${sec}`,
    shshshfpb: randomBase64Url(80),
    wlfstkSmdl: randomBase64Url(32).toLowerCase(),
    sdtoken: "",
  };
  return state.protocolCookies;
}

function buildSigner(state) {
  state.browserEnv ||= createDefaultBrowserEnv();
  state.h5stStorage ||= {};
  return createSigner({
    sdkPath: path.join(ROOT, "analysis/js_security_v3_0.1.4.beautified.js"),
    browserEnv: state.browserEnv,
    storage: state.h5stStorage,
    enableNetwork: true,
    appId: "b5216",
  });
}

function buildCookieHeader({ state, uuid, risk }) {
  const visit = state.visit;
  const protocol = ensureProtocolCookieState(state);
  const riskCookies = pickCookieFields(risk.cookie);
  const nowSec = Math.floor(Date.now() / 1000);
  const pairs = {
    __jdv: `76161171|direct|-|none|-|${Date.now()}`,
    __jdu: visit.jdu,
    [TOKEN_KEY]: risk.jsToken || riskCookies[TOKEN_KEY],
    [EID_KEY]: risk.eid || riskCookies[EID_KEY],
    areaId: protocol.areaId,
    "ipLoc-djd": protocol.ipLocDjd,
    PCSYCityID: protocol.pcsyCityId,
    shshshfpa: protocol.shshshfpa,
    shshshfpx: protocol.shshshfpx,
    __jda: uuid,
    __jdb: `95931165.1.${visit.jdu}|1.${nowSec}`,
    __jdc: "95931165",
    wlfstk_smdl: protocol.wlfstkSmdl,
    shshshfpb: protocol.shshshfpb,
  };
  if (protocol.sdtoken) pairs.sdtoken = protocol.sdtoken;
  return Object.entries(pairs)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function buildApiHeaders({ state, cookie }) {
  return {
    accept: "application/json, text/plain, */*",
    origin: "https://www.jd.com",
    referer: "https://www.jd.com/",
    "user-agent": state.browserEnv.ua,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "x-referer-page": "https://www.jd.com/",
    "x-rp-client": "h5_2.2.0",
    cookie,
  };
}

function persistSdtoken(state, headerValue) {
  if (!headerValue) return false;
  const [action, , token] = headerValue.split(";");
  if (action !== "set" || !token) return false;
  ensureProtocolCookieState(state).sdtoken = token;
  return true;
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value;
  }
  return "";
}

function fetchWithCurlCffi({ url, headers }) {
  const child = spawnSync("python3", [path.join(__dirname, "fetch_curl_cffi.py")], {
    input: JSON.stringify({ url, headers, impersonate: "chrome120", timeout: 20 }),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(child.stderr || `curl_cffi transport failed with exit ${child.status}`);
  }
  return JSON.parse(child.stdout);
}

async function main() {
  const state = readState();
  const visit = ensureVisitState(state);
  ensureProtocolCookieState(state);
  const externalCookie = readExternalCookie();
  const externalCookieFields = pickCookieFields(externalCookie);
  const page = Number(argValue("--page", "10"));
  const uuid = argValue("--uuid", process.env.JD_UUID || externalCookieFields.__jda || buildUuid(visit));
  const body = {
    page,
    pagesize: 25,
    area: "",
    source: "pc-home",
    kuangjia: 1,
    notJsonp: true,
  };

  state.browserEnv ||= createDefaultBrowserEnv();
  state.riskStorage ||= {};
  const riskRuntime = createRiskRuntime({
    scriptPath: path.join(ROOT, "analysis/pc-tk.js"),
    browserEnv: state.browserEnv,
    storage: state.riskStorage,
  });
  const risk = await riskRuntime.ensureRiskToken({
    timeoutMs: Number(argValue("--risk-timeout", "8000")),
  });
  state.riskStorage = risk.storage;

  const signerRuntime = buildSigner(state);
  const tokenState = await signerRuntime.ensureToken({
    force: process.env.JD_FORCE_H5ST_INIT === "1",
    timeoutMs: Number(argValue("--h5st-timeout", process.env.JD_H5ST_TIMEOUT || "30000")),
  });
  state.browserEnv = signerRuntime.browserEnv;
  state.h5stStorage = tokenState.storage;
  writeState(state);

  const { signRequest } = signerRuntime;
  const signed = signRequest({ body, functionId: "pc_home_feed", uuid });
  const effectiveRisk = {
    ...risk,
    jsToken: externalCookieFields[TOKEN_KEY] || risk.jsToken,
    eid: externalCookieFields[EID_KEY] || risk.eid,
  };
  signed.params["x-api-eid-token"] = effectiveRisk.jsToken;

  const url = `https://api.m.jd.com/?${new URLSearchParams(signed.params).toString()}`;
  const cookie = externalCookie || buildCookieHeader({ state, uuid, risk: effectiveRisk });
  const output = {
    diagnostics: {
      ...signed.diagnostics,
      risk: {
        jsTokenLength: effectiveRisk.jsToken.length,
        eidLength: effectiveRisk.eid.length,
        fpLength: risk.fp.length,
      },
      cookieKeys: cookie
        .split(";")
        .map((part) => part.trim().split("=")[0])
        .filter(Boolean),
    },
    params: signed.params,
    url,
  };
  if (process.env.JD_PRINT_HEADERS === "1") {
    output.headers = buildApiHeaders({ state, cookie });
  }

  console.log(JSON.stringify(output, null, 2));

  if (process.env.JD_FETCH === "1") {
    const headers = buildApiHeaders({ state, cookie });
    const response = fetchWithCurlCffi({ url, headers });
    if (persistSdtoken(state, getHeader(response.headers, "x-rp-sdtoken"))) {
      writeState(state);
    }
    console.error(`HTTP ${response.status}`);
    console.log(response.text);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
