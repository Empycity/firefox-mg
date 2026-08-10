#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const snapshotPath = path.resolve(process.argv[2] || "");
const basePath = path.resolve(process.argv[3] || path.join(__dirname, "creator-runtime-contract.json"));
const outputPath = path.resolve(process.argv[4] || path.join(__dirname, "creator-live-contract.json"));
if (!process.argv[2]) {
  process.stderr.write("Usage: build-creator-live-contract.js SNAPSHOT [BASE_CONTRACT] [OUTPUT]\n");
  process.exit(2);
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const events = snapshot.events || [];
const urls = events.map((event) => event.url).filter(Boolean);
const getUrl = [...urls].reverse().find((url) => url.includes("/aweme/v1/creator/get/url/"));
if (!getUrl) throw new Error("Upload chain has not produced /aweme/v1/creator/get/url/ yet");

const sourceUrl = new URL(getUrl);
const uri = sourceUrl.searchParams.get("uri");
const allText = JSON.stringify(events);
const creationId = [...urls].reverse().map((value) => {
  try { return new URL(value).searchParams.get("creation_id"); } catch { return null; }
}).find(Boolean) || allText.match(/"creation_id"\s*:\s*"([^"]+)"/)?.[1];
if (!uri) throw new Error("No uploaded media uri was found in creator/get/url");
if (!creationId) throw new Error("No creation_id was found in the pre-publish request chain");

const matchingImage = [...(snapshot.images || [])]
  .filter((image) => image.src.includes(uri.split("/").at(-1)))
  .sort((left, right) => right.naturalWidth * right.naturalHeight - left.naturalWidth * left.naturalHeight)[0];
const previousImage = base.request.body?.item?.common?.images?.[0] || {};
const width = matchingImage?.naturalWidth || previousImage.width;
const height = matchingImage?.naturalHeight || previousImage.height;
if (!width || !height) throw new Error("No uploaded image dimensions were found");

const unsigned = new URL(base.request.unsigned_url);
unsigned.searchParams.set("screen_width", snapshot.environment.screenWidth);
unsigned.searchParams.set("screen_height", snapshot.environment.screenHeight);
unsigned.searchParams.set("browser_language", snapshot.environment.language);
unsigned.searchParams.set("browser_platform", snapshot.environment.platform);
unsigned.searchParams.set("browser_online", snapshot.environment.onLine);
unsigned.searchParams.set("timezone_name", Intl.DateTimeFormat().resolvedOptions().timeZone);
unsigned.searchParams.set("msToken", sourceUrl.searchParams.get("msToken"));
unsigned.searchParams.delete("a_bogus");

const body = structuredClone(base.request.body);
body.item.common.images = [{ uri, width, height }];
body.item.common.creation_id = creationId;
body.item.cover.poster = uri;

const e = snapshot.environment;
const value = (type, current) => ({ restorable: true, value_kind: type, value: current });
const values = {
  "Location.href": value("string", snapshot.href),
  "Location.origin": value("string", new URL(snapshot.href).origin),
  "Location.protocol": value("string", new URL(snapshot.href).protocol),
  "Location.host": value("string", new URL(snapshot.href).host),
  "Location.hostname": value("string", new URL(snapshot.href).hostname),
  "Location.pathname": value("string", new URL(snapshot.href).pathname),
  "Location.search": value("string", new URL(snapshot.href).search),
  "Document.referrer": value("string", snapshot.referrer),
  "Navigator.userAgent": value("string", e.userAgent),
  "Navigator.language": value("string", e.language),
  "Navigator.platform": value("string", e.platform),
  "Navigator.vendor": value("string", e.vendor),
  "Navigator.hardwareConcurrency": value("number", e.hardwareConcurrency),
  "Navigator.cookieEnabled": value("boolean", e.cookieEnabled),
  "Navigator.onLine": value("boolean", e.onLine),
  "Navigator.webdriver": value("boolean", e.webdriver),
  "Screen.width": value("number", e.screenWidth),
  "Screen.height": value("number", e.screenHeight),
  "Screen.availWidth": value("number", e.availWidth),
  "Screen.availHeight": value("number", e.availHeight),
  "Screen.colorDepth": value("number", e.colorDepth),
  "Screen.pixelDepth": value("number", e.pixelDepth),
  "Window.innerWidth": value("number", e.innerWidth),
  "Window.innerHeight": value("number", e.innerHeight),
  "Window.outerWidth": value("number", e.outerWidth),
  "Window.outerHeight": value("number", e.outerHeight),
  "Window.screenX": value("number", e.screenX),
  "Window.screenY": value("number", e.screenY),
  "Window.devicePixelRatio": value("number", e.devicePixelRatio),
};
base.request = {
  method: "POST",
  unsigned_url: unsigned.href,
  headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json" },
  body,
  target_field: "a_bogus",
};
base.environment_contract.values = { ...base.environment_contract.values, ...values };
base.restore_seed = {
  cookies: Object.fromEntries(snapshot.cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index), part.slice(index + 1)];
  })),
  localStorage: snapshot.localStorage,
  sessionStorage: snapshot.sessionStorage,
};
base.live_capture = { snapshot: snapshotPath, uri, creation_id: creationId, width, height };
fs.writeFileSync(outputPath, `${JSON.stringify(base, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(base.live_capture)}\n${outputPath}\n`);
