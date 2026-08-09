#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function usage() {
  process.stderr.write(
    "Usage: request-vector-test.js TRACE_DIR --request-id ID --field NAME --runner-json FILE [--cookie-db FILE]\n"
  );
  process.exit(2);
}

const [traceDir, ...args] = process.argv.slice(2);
if (!traceDir) usage();

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

const requestId = option("--request-id");
const fieldName = option("--field");
const runnerPath = option("--runner-json");
const cookieDb = option("--cookie-db");
if (!requestId || !fieldName || !runnerPath) usage();

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function candidateUrl(runner) {
  const item = [...(runner.xhr || [])].reverse().find(
    (entry) => entry.phase === "send" && typeof entry.url === "string"
  );
  if (!item) throw new Error("runner output has no xhr send URL");
  return item.url;
}

function cookieBefore(stateRows, tsUs) {
  let cookie = "";
  for (const row of stateRows) {
    if ((row.ts_us || 0) > tsUs) continue;
    if (row.type === "cookie.get" && row.source === "document.cookie" && row.value_preview) {
      cookie = String(row.value_preview);
    }
  }
  return cookie;
}

function cookieFromDatabase(dbPath, hostname) {
  if (!dbPath) return { value: "", httpOnlyCount: 0 };
  const query = "select name, value, host, isHttpOnly from moz_cookies";
  const result = spawnSync("sqlite3", ["-separator", "\t", dbPath, query], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`cookie database read failed: ${result.stderr.trim()}`);
  const cookies = [];
  let httpOnlyCount = 0;
  for (const line of result.stdout.split("\n")) {
    const [name, value, host, httpOnly] = line.split("\t");
    const domain = String(host || "").replace(/^\./, "");
    if (!name || !domain || (hostname !== domain && !hostname.endsWith(`.${domain}`))) continue;
    cookies.push(`${name}=${value || ""}`);
    if (httpOnly === "1") httpOnlyCount += 1;
  }
  return { value: cookies.join("; "), httpOnlyCount };
}

function nonTargetEntries(url, field) {
  return [...new URL(url).searchParams.entries()]
    .filter(([name]) => name !== field)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );
}

function requestHeaders(rows, requestId, sendTsUs) {
  const headers = {};
  const forbidden = new Set(["host", "content-length", "connection", "transfer-encoding"]);
  for (const row of rows) {
    if (row.request_id !== requestId || row.type !== "xhr.header") continue;
    if (sendTsUs && Number(row.ts_us || 0) > sendTsUs) continue;
    const name = String(row.detail_name || "").trim();
    const value = String(row.detail_value || "");
    if (name && value && !forbidden.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

async function main() {
  const network = readJsonLines(path.join(traceDir, "categorized", "network.jsonl"));
  const state = readJsonLines(path.join(traceDir, "categorized", "state.jsonl"));
  const original = network.find(
    (row) => row.type === "xhr.send" && row.request_id === requestId && typeof row.url === "string"
  );
  if (!original) throw new Error(`No xhr.send for request_id=${requestId}`);

  const runner = JSON.parse(fs.readFileSync(runnerPath, "utf8"));
  const url = candidateUrl(runner);
  const originalUrl = new URL(original.url);
  const generatedUrl = new URL(url);
  const profileCookie = cookieFromDatabase(cookieDb, generatedUrl.hostname);
  const cookie = profileCookie.value || cookieBefore(state, Number(original.ts_us || 0));
  const headers = requestHeaders(network, requestId, Number(original.ts_us || 0));
  if (!headers.Accept) headers.Accept = "application/json, text/plain, */*";
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    method: original.method || "GET",
    headers,
    redirect: "follow",
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  const hasData = Boolean(
    payload && (payload.status_code === 0 || (Array.isArray(payload.comments) && payload.comments.length))
  );
  const report = {
    schema: "firefox_trace.request_vector_test.v1",
    request_id: requestId,
    field: fieldName,
    request_shape: {
      same_origin_and_path: originalUrl.origin === generatedUrl.origin && originalUrl.pathname === generatedUrl.pathname,
      non_target_query_equal:
        JSON.stringify(nonTargetEntries(original.url, fieldName)) ===
        JSON.stringify(nonTargetEntries(url, fieldName)),
      cookie_restored: Boolean(cookie),
      http_only_cookies_restored: profileCookie.httpOnlyCount,
      captured_header_count: Object.keys(headers).length,
    },
    generated_field: {
      length: generatedUrl.searchParams.get(fieldName)?.length || 0,
      differs_from_captured: generatedUrl.searchParams.get(fieldName) !== originalUrl.searchParams.get(fieldName),
    },
    response: {
      status: response.status,
      json_status_code: payload?.status_code ?? null,
      has_data: hasData,
      body_size: Buffer.byteLength(text),
    },
    status: response.ok && hasData ? "accepted_with_data" : "rejected_or_empty",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "accepted_with_data" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`request-vector-test: ${error.message}\n`);
  process.exit(1);
});
