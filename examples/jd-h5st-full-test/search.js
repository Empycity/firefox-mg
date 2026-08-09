const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRiskRuntime, TOKEN_KEY } = require("./risk");
const { createDefaultBrowserEnv, createSigner, sha256Hex } = require("./signer");

const ROOT = __dirname;
const STATE_DIR = path.join(__dirname, "state");
const STATE_FILE = path.join(STATE_DIR, "search_state.json");
const DEFAULT_COOKIE_FILE = path.join(__dirname, "config", "search_cookie.json");

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

function cookieObjectToString(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function readCookieFile() {
  const filePath = process.env.JD_SEARCH_COOKIE_FILE || argValue("--cookie-file", DEFAULT_COOKIE_FILE);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing login cookie file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) throw new Error(`Empty login cookie file: ${filePath}`);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : parsed.cookie || "";
  } catch {
    return raw;
  }
}

function searchUuid(cookieFields) {
  const jda = cookieFields.__jda || "";
  const fromJda = jda.split(".")[1];
  return fromJda || cookieFields.__jdu || "";
}

function randomPvid() {
  return crypto.randomBytes(16).toString("hex");
}

function searchOffset(page, explicitValue) {
  if (explicitValue !== undefined && explicitValue !== null && explicitValue !== "") return Number(explicitValue);
  return page <= 1 ? 1 : (page - 1) * 20;
}

function buildSearchBody({ cookieFields, keyword, page, pvid, s }) {
  const area = (cookieFields["ipLoc-djd"] || "21-1911-1915-26809").replaceAll("-", "_");
  return {
    enc: "utf-8",
    pvid,
    from: "home",
    area,
    page,
    mode: "",
    concise: false,
    hoverPictures: false,
    newAdvRepeat: true,
    mixerParam: true,
    new_interval: true,
    s,
  };
}

function createSearchSigner(state) {
  state.browserEnv ||= createDefaultBrowserEnv({
    location: {
      href: "https://search.jd.com/Search",
      origin: "https://search.jd.com",
      host: "search.jd.com",
      hostname: "search.jd.com",
      protocol: "https:",
      pathname: "/Search",
      search: "",
    },
    referrer: "https://www.jd.com/",
  });
  state.h5stStorage ||= {};
  return createSigner({
    sdkPath: path.join(ROOT, "analysis/js_security_v3_0.1.4.beautified.js"),
    browserEnv: state.browserEnv,
    storage: state.h5stStorage,
    enableNetwork: true,
    appId: "f06cc",
  });
}

async function ensureRiskTokenIfNeeded(state, cookieFields) {
  if (cookieFields[TOKEN_KEY]) return cookieFields[TOKEN_KEY];
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
  return risk.jsToken;
}

function buildHeaders({ cookie, keyword }) {
  const referer = `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}&enc=utf-8`;
  return {
    accept: "application/json, text/plain, */*",
    origin: "https://search.jd.com",
    referer,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "x-referer-page": "https://search.jd.com/Search",
    "x-rp-client": "h5_2.1.0",
    cookie,
  };
}

async function main() {
  const keyword = argValue("--keyword", process.env.JD_SEARCH_KEYWORD || "ipad pro keyboard");
  const page = Number(argValue("--page", process.env.JD_SEARCH_PAGE || "1"));
  const pvid = argValue("--pvid", process.env.JD_SEARCH_PVID || randomPvid());
  const s = searchOffset(page, argValue("--s", process.env.JD_SEARCH_S));
  const functionId = argValue("--function-id", "pc_search_searchWare");

  const cookie = readCookieFile();
  const cookieFields = pickCookieFields(cookie);
  if (!cookieFields.thor && !cookieFields.pin) {
    throw new Error("Login cookie is required for search; missing thor/pin");
  }
  const uuid = argValue("--uuid", process.env.JD_UUID || searchUuid(cookieFields));
  if (!uuid) throw new Error("Cannot derive uuid from login cookie");

  const state = readState();
  const signerRuntime = createSearchSigner(state);
  const tokenState = await signerRuntime.ensureToken({
    force: process.env.JD_FORCE_H5ST_INIT === "1",
    timeoutMs: Number(argValue("--h5st-timeout", process.env.JD_H5ST_TIMEOUT || "30000")),
  });
  state.browserEnv = signerRuntime.browserEnv;
  state.h5stStorage = tokenState.storage;

  const jsToken = await ensureRiskTokenIfNeeded(state, cookieFields);
  if (!jsToken) throw new Error("Cannot get x-api-eid-token from login cookie or pc-tk.js");
  if (!cookieFields[TOKEN_KEY] && jsToken) cookieFields[TOKEN_KEY] = jsToken;
  const effectiveCookie = cookieFields[TOKEN_KEY] ? cookieObjectToString(cookieFields) : cookie;

  const body = buildSearchBody({ cookieFields, keyword, page, pvid, s });
  const bodyText = JSON.stringify(body);
  const t = Date.now();
  const signInput = {
    appid: "search-pc-java",
    functionId,
    client: "pc",
    clientVersion: "1.0.0",
    t,
    body: sha256Hex(bodyText),
  };
  const signed = signerRuntime.signer.signSync({ ...signInput });
  writeState(state);

  const params = new URLSearchParams();
  params.append("appid", "search-pc-java");
  params.append("t", String(t));
  params.append("client", "pc");
  params.append("clientVersion", "1.0.0");
  params.append("cthr", "1");
  params.append("uuid", uuid);
  params.append("loginType", "3");
  if (keyword) params.append("keyword", keyword);
  params.append("functionId", functionId);
  params.append("body", bodyText);
  params.append("x-api-eid-token", jsToken);
  params.append("h5st", signed.h5st);
  params.append("t", String(Date.now()));

  const url = `https://api.m.jd.com/api?${params.toString()}`;
  const output = {
    diagnostics: {
      sdkAppId: "f06cc",
      queryAppId: "search-pc-java",
      functionId,
      page,
      s,
      pvid,
      uuid,
      tokenLength: signerRuntime.signer._token ? signerRuntime.signer._token.length : 0,
      jsTokenLength: jsToken.length,
      h5stSegmentLengths: signed.h5st.split(";").map((part) => part.length),
      cookieKeys: Object.keys(cookieFields),
    },
    signInput,
    params: Object.fromEntries(params.entries()),
    url,
    headers: buildHeaders({ cookie: effectiveCookie, keyword }),
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
