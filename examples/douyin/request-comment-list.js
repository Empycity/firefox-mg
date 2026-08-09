#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

const [contractPath, runnerPath, ...args] = process.argv.slice(2);
const cookieDbIndex = args.indexOf("--cookie-db");
const cookieDb = cookieDbIndex >= 0 ? args[cookieDbIndex + 1] : "";
if (!contractPath || !runnerPath) {
  process.stderr.write("Usage: request-comment-list.js RUNTIME_CONTRACT RUNNER_OUTPUT [--cookie-db COOKIES_SQLITE]\n");
  process.exit(2);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function profileCookies(dbPath, hostname) {
  if (!dbPath) return "";
  const result = spawnSync("sqlite3", ["-separator", "\t", dbPath,
    "select name, value, host from moz_cookies"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "cookie database read failed");
  return result.stdout.split("\n").flatMap((line) => {
    const [name, value, host] = line.split("\t");
    const domain = String(host || "").replace(/^\./, "");
    return name && domain && (hostname === domain || hostname.endsWith(`.${domain}`))
      ? [`${name}=${value || ""}`]
      : [];
  }).join("; ");
}

function generatedUrl(output) {
  const request = [...(output.xhr || [])].reverse().find(
    (item) => item.phase === "send" && typeof item.url === "string"
  );
  if (!request) throw new Error("runner output does not contain a generated request");
  return new URL(request.url);
}

async function main() {
  const contract = readJson(contractPath);
  const output = readJson(runnerPath);
  const url = generatedUrl(output);
  const expected = new URL(contract.request.unsigned_url);
  const targetField = contract.request.target_field;
  const headers = { ...(contract.request.headers || {}) };
  const cookie = profileCookies(cookieDb, url.hostname);
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    method: contract.request.method,
    headers,
    body: contract.request.body,
    redirect: "follow",
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const report = {
    method: contract.request.method,
    body_kind: contract.request.body === null ? "null" : typeof contract.request.body,
    request_shape: {
      same_origin_and_path: url.origin === expected.origin && url.pathname === expected.pathname,
      target_field: targetField,
      target_field_length: url.searchParams.get(targetField)?.length || 0,
      profile_cookie_loaded: Boolean(cookie),
      explicit_header_count: Object.keys(contract.request.headers || {}).length,
    },
    response: {
      http_status: response.status,
      json_status_code: data?.status_code ?? null,
      has_comments: Array.isArray(data?.comments) && data.comments.length > 0,
      body_bytes: Buffer.byteLength(text),
    },
  };
  report.accepted = response.ok && report.response.json_status_code === 0 && report.response.has_comments;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.accepted ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`request-comment-list: ${error.message}\n`);
  process.exit(1);
});
