#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: trace-align.js TRACE_DIR --request-id ID --field NAME [--candidate-url URL | --runner-json FILE]\n"
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const traceDir = args.shift();
if (!traceDir) usage();

function option(name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) return "";
  return args[index + 1];
}

const requestId = option("--request-id");
const fieldName = option("--field");
const candidateUrl = option("--candidate-url");
const runnerJson = option("--runner-json");
if (!requestId || !fieldName || (!candidateUrl && !runnerJson)) usage();

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function forEachJsonLine(filePath, visit) {
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let carry = "";
  try {
    for (;;) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      const lines = (carry + chunk.toString("utf8", 0, size)).split("\n");
      carry = lines.pop() || "";
      for (const line of lines) visit(line);
    }
    if (carry) visit(carry);
  } finally {
    fs.closeSync(fd);
  }
}

function pickRunnerOutput(filePath) {
  const output = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const observed = [...(output.observed_dynamic_requests || [])].reverse().find(
    (item) => typeof item.url === "string"
  );
  if (observed) return { output, url: observed.url, request: observed };
  const send = [...(output.xhr || [])].reverse().find(
    (item) => item.phase === "send" && typeof item.url === "string"
  );
  if (!send) throw new Error("Runner JSON has no xhr send URL");
  return { output, url: send.url, request: send };
}

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

function rawQueryValue(url, field) {
  const marker = `${encodeURIComponent(field)}=`;
  const query = url.slice(url.indexOf("?") + 1).split("#", 1)[0];
  for (const pair of query.split("&")) {
    if (pair.startsWith(marker)) return pair.slice(marker.length);
  }
  return "";
}

function decodedValue(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function firstByteDiff(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? null : length;
}

function queryEntries(url, ignoredField) {
  const parsed = new URL(url);
  return [...parsed.searchParams.entries()]
    .filter(([key]) => key !== ignoredField)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    );
}

function dynamicInputs(filePath, originCallId) {
  const inputs = [];
  if (!originCallId || !fs.existsSync(filePath)) return inputs;
  forEachJsonLine(filePath, (line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (
      row.call_id === originCallId &&
      (row.type === "js.random" || row.type === "js.time")
    ) {
      inputs.push({
        type: row.type,
        sequence: row.sequence,
        value: row.type === "js.time" ? row.value_ms : row.value,
        ts_us: row.ts_us,
      });
    }
  });
  return inputs;
}

try {
  const networkRows = readJsonLines(path.join(traceDir, "categorized", "network.jsonl"));
  const request = networkRows.find(
    (row) => row.type === "xhr.send" && row.request_id === requestId && typeof row.url === "string"
  );
  if (!request) throw new Error(`No xhr.send event for request_id=${requestId}`);

  const fieldRows = readJsonLines(path.join(traceDir, "categorized", "request-fields.jsonl"));
  const field = fieldRows.find(
    (row) => row.request_id === requestId && row.field_name === fieldName
  );
  if (!field) throw new Error(`No ${fieldName} field record for request_id=${requestId}`);

  const runner = runnerJson ? pickRunnerOutput(runnerJson) : null;
  const candidate = candidateUrl || runner.url;
  const actualRaw = String(field.value_raw_preview || rawQueryValue(request.url, fieldName));
  const candidateRaw = field.location === "headers"
    ? headerValue(runner?.request?.headers, fieldName)
    : rawQueryValue(candidate, fieldName);
  const actualDecoded = decodedValue(actualRaw);
  const candidateDecoded = decodedValue(candidateRaw);
  const actualBytes = decodeBase64Url(actualDecoded);
  const candidateBytes = decodeBase64Url(candidateDecoded);

  const environmentCoverage = runner?.output?.runtime_controls?.environment_contract?.coverage || null;
  const scalarContractComplete = environmentCoverage
    ? environmentCoverage.value_capture_complete === true
    : null;
  const objectContractComplete = environmentCoverage
    ? environmentCoverage.object_contract_complete === true
    : null;
  const hostContractComplete = environmentCoverage
    ? scalarContractComplete === true && objectContractComplete === true
    : null;
  const bodyRow = networkRows.find(
    (row) => row.type === "xhr.body" && row.request_id === requestId
  );
  const actualBodySize = bodyRow?.request_body_size ?? bodyRow?.body_size ?? null;
  const actualBodySha256 = bodyRow?.request_body_sha256 || bodyRow?.body_sha256 || null;
  const candidateBodySize = runner?.request?.body?.size ?? null;
  const candidateBodySha256 = runner?.request?.body?.sha256 || null;
  const bodyComparable = actualBodySha256 !== null && candidateBodySha256 !== null;
  const bodyEqual = bodyComparable && actualBodySha256 === candidateBodySha256;
  const urlEqual =
    new URL(request.url).origin === new URL(candidate).origin &&
    new URL(request.url).pathname === new URL(candidate).pathname;
  const nonTargetQueryEqual =
    JSON.stringify(queryEntries(request.url, fieldName)) ===
    JSON.stringify(queryEntries(candidate, fieldName));
  const fieldEqual = actualRaw === candidateRaw;
  const report = {
    schema: "firefox_trace.alignment_report.v1",
    trace_dir: path.resolve(traceDir),
    request: {
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      origin_call_id: request.origin_call_id || null,
      ts_us: request.ts_us,
    },
    field: {
      name: fieldName,
      actual_raw_size: actualRaw.length,
      actual_decoded_size: actualDecoded.length,
      actual_sha256_raw: field.value_sha256_raw || null,
      actual_sha256_decoded: field.value_sha256_decoded || null,
      candidate_raw_size: candidateRaw.length,
      candidate_decoded_size: candidateDecoded.length,
      raw_equal: actualRaw === candidateRaw,
      decoded_equal: actualDecoded === candidateDecoded,
    },
    url: {
      same_origin_and_path: urlEqual,
      non_target_query_equal: nonTargetQueryEqual,
    },
    body: {
      actual_size: actualBodySize,
      actual_sha256: actualBodySha256,
      candidate_size: candidateBodySize,
      candidate_sha256: candidateBodySha256,
      comparable: bodyComparable,
      equal: bodyEqual,
    },
    base64url: {
      actual_bytes: actualBytes ? actualBytes.length : null,
      candidate_bytes: candidateBytes ? candidateBytes.length : null,
      first_diff_offset:
        actualBytes && candidateBytes ? firstByteDiff(actualBytes, candidateBytes) : null,
      equal: Boolean(actualBytes && candidateBytes && actualBytes.equals(candidateBytes)),
    },
    dynamic_inputs: dynamicInputs(
      path.join(traceDir, "categorized", "js.jsonl"), request.origin_call_id
    ),
    replay_preconditions: {
      environment_contract: environmentCoverage,
      host_contract_complete: hostContractComplete,
      scalar_contract_complete: scalarContractComplete,
      object_contract_complete: objectContractComplete,
      runner_host_audit: runner?.output?.host_accesses || null,
    },
    status:
      fieldEqual && urlEqual && nonTargetQueryEqual && (!bodyComparable || bodyEqual)
        ? "aligned"
        : hostContractComplete === false
          ? "host_contract_incomplete"
          : "mismatch",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`trace-align: ${error.message}\n`);
  process.exit(1);
}
