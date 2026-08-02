'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRiskRuntime, EID_KEY, TOKEN_KEY } = require('./risk_compat');
const { createDefaultBrowserEnv, createSigner } = require('./signer_compat');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state_compat.json');
const DEFAULT_SDK = path.join(ROOT, 'analysis', 'js_security_v3_0.1.4.compat.js');
const DEFAULT_RISK = path.join(ROOT, 'analysis', 'pc-tk.js');
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function randomDigits(length) {
  let value = '';
  while (value.length < length) value += String(Math.floor(Math.random() * 10));
  return value.slice(0, length);
}

function randomBase64Url(length) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString('base64url').slice(0, length);
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

function buildUuid(visit) {
  return `95931165.${visit.jdu}.${visit.firstVisitSec}.${visit.previousVisitSec}.${visit.currentVisitSec}.${visit.sessionCount}`;
}

function ensureProtocolCookieState(state) {
  if (state.protocolCookies) return state.protocolCookies;
  const sec = Math.floor(Date.now() / 1000);
  const shshId = crypto.randomUUID();
  state.protocolCookies = {
    areaId: '21',
    ipLocDjd: '21-1911-0-0',
    pcsyCityId: 'CN_360000_360700_0',
    shshshfpa: `${shshId}-${sec}`,
    shshshfpx: `${shshId}-${sec}`,
    shshshfpb: randomBase64Url(80),
    wlfstkSmdl: randomBase64Url(32).toLowerCase(),
    sdtoken: '',
  };
  return state.protocolCookies;
}

function pickCookieFields(cookieString) {
  const result = {};
  for (const part of String(cookieString || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index > 0) result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
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
    'ipLoc-djd': protocol.ipLocDjd,
    PCSYCityID: protocol.pcsyCityId,
    shshshfpa: protocol.shshshfpa,
    shshshfpx: protocol.shshshfpx,
    __jda: uuid,
    __jdb: `95931165.1.${visit.jdu}|1.${nowSec}`,
    __jdc: '95931165',
    wlfstk_smdl: protocol.wlfstkSmdl,
    shshshfpb: protocol.shshshfpb,
  };
  if (protocol.sdtoken) pairs.sdtoken = protocol.sdtoken;
  return Object.entries(pairs)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function buildApiHeaders({ state, cookie }) {
  const ua = state.browserEnv.ua;
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    origin: 'https://www.jd.com',
    referer: 'https://www.jd.com/',
    'user-agent': ua,
    'x-referer-page': 'https://www.jd.com/',
    'x-rp-client': 'h5_2.2.0',
    cookie,
  };
  if (/Chrome\/\d+/.test(ua)) {
    const version = (ua.match(/Chrome\/(\d+)/) || [null, '149'])[1];
    headers['sec-ch-ua'] = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not)A;Brand";v="24"`;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"macOS"';
  }
  return headers;
}

async function buildSignedRequest() {
  const state = readState();
  const page = Number(argValue('--page', '3'));
  const browser = argValue('--browser', process.env.JD_BROWSER || 'firefox').toLowerCase();
  const uaArg = argValue('--ua', '');
  const timeoutMs = Number(argValue('--h5st-timeout', '30000'));
  const force = process.env.JD_FORCE_H5ST_INIT !== '0';
  const visit = ensureVisitState(state);
  ensureProtocolCookieState(state);
  const uuid = argValue('--uuid', buildUuid(visit));
  const body = {
    page,
    pagesize: 25,
    area: '',
    source: 'pc-home',
    kuangjia: 1,
    notJsonp: true,
  };

  const ua = uaArg || (browser.startsWith('chrome') ? CHROME_UA : FIREFOX_UA);
  state.browserEnv = createDefaultBrowserEnv({ ua });
  if (browser.startsWith('firefox')) {
    state.browserEnv.chrome = false;
    state.browserEnv.pluginsLen = 0;
    state.browserEnv.mimeTypesLen = 0;
  }
  state.riskStorage ||= {};
  const riskRuntime = createRiskRuntime({
    scriptPath: DEFAULT_RISK,
    browserEnv: state.browserEnv,
    storage: state.riskStorage,
  });
  const risk = await riskRuntime.ensureRiskToken({
    timeoutMs: Number(argValue('--risk-timeout', '8000')),
    force,
  });
  state.riskStorage = risk.storage;

  const signerRuntime = createSigner({
    sdkPath: DEFAULT_SDK,
    browserEnv: state.browserEnv,
    storage: state.h5stStorage || {},
    enableNetwork: true,
    appId: 'b5216',
  });
  const tokenState = await signerRuntime.ensureToken({ force, timeoutMs });
  state.h5stStorage = tokenState.storage;
  state.browserEnv = signerRuntime.browserEnv;

  const signed = signerRuntime.signRequest({ body, functionId: 'pc_home_feed', uuid });
  signed.params['x-api-eid-token'] = risk.jsToken;
  const url = `https://api.m.jd.com/?${new URLSearchParams(signed.params).toString()}`;
  const cookie = buildCookieHeader({ state, uuid, risk });
  const output = {
    ok: true,
    diagnostics: {
      ...signed.diagnostics,
      risk: {
        jsTokenLength: risk.jsToken.length,
        eidLength: risk.eid.length,
        fpLength: risk.fp.length,
      },
      cookieKeys: cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean),
      sdkPath: DEFAULT_SDK,
      riskSdkPath: DEFAULT_RISK,
      browser,
      transportImpersonate: browser.startsWith('firefox') ? 'firefox135' : 'chrome120',
    },
    signInput: signed.signInput,
    params: signed.params,
    url,
    headers: buildApiHeaders({ state, cookie }),
  };
  writeState(state);
  return output;
}

if (require.main === module) {
  buildSignedRequest()
    .then((result) => {
      if (process.argv.includes('--print-url')) {
        console.log(result.url);
        return;
      }
      console.log(JSON.stringify(result, null, process.argv.includes('--pretty') ? 2 : 0));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

module.exports = { buildSignedRequest };
