#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => ({ ...JSON.parse(line), __line: index + 1 }));
}

function plainHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, entry]) => [
    name,
    entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')
      ? entry.value
      : entry,
  ]));
}

function main() {
  const traceDir = path.resolve(process.argv[2] || '');
  const output = path.resolve(process.argv[3] || path.join(__dirname, 'runtime-data/final-evidence-vector.json'));
  if (!fs.existsSync(path.join(traceDir, 'manifest.json'))) {
    throw new Error(`trace manifest not found: ${traceDir}`);
  }

  const manifest = readJson(path.join(traceDir, 'manifest.json'));
  const health = readJson(path.join(traceDir, 'index/trace-health.json'));
  const xhrFile = fs.readdirSync(traceDir).find(name => /^firefox-xhr-.*\.jsonl$/.test(name));
  if (!xhrFile) throw new Error('XHR trace file not found');
  const xhr = readJsonl(path.join(traceDir, xhrFile));
  const requests = new Map();

  for (const event of xhr) {
    if (!event.request_id) continue;
    const key = `${event.pid}:${event.request_id}`;
    let request = requests.get(key);
    if (!request) {
      request = { pid: event.pid, request_id: event.request_id, headers: {}, events: [] };
      requests.set(key, request);
    }
    request.events.push({
      type: event.type,
      line: event.__line,
      ts_us: event.ts_us,
      origin_call_id: event.origin_call_id || null,
    });
    if (event.type === 'xhr.open') {
      Object.assign(request, {
        origin_call_id: event.origin_call_id,
        method: event.method,
        url: event.url,
        caller_url: event.caller_url,
        caller_line: event.caller_line,
        caller_column: event.caller_column,
        segment_id: event.segment_id,
      });
    } else if (event.type === 'xhr.header') {
      request.headers[event.detail_name] = event.detail_value;
    } else if (event.type === 'xhr.body') {
      request.body = {
        size: event.request_body_size,
        sha256: event.request_body_sha256,
        store_path: event.request_body_store_path ? path.join(traceDir, event.request_body_store_path) : '',
        preview: event.request_body_preview,
      };
    } else if (event.type === 'xhr.response') {
      request.response = {
        status: event.status,
        size: event.response_body_size,
        sha256: event.response_body_sha256,
        store_path: event.response_body_store_path ? path.join(traceDir, event.response_body_store_path) : '',
      };
    }
  }

  const network = readJsonl(path.join(traceDir, 'categorized/network.jsonl'));
  const httpChannels = network
    .filter(event => event.type === 'http.request_headers' && event.stage === 'final_channel')
    .map(event => ({ method: event.method, url: event.url, headers: plainHeaders(event.headers), line: event._source_line }));

  const scriptRecords = readJsonl(path.join(traceDir, 'categorized/script.jsonl'));
  const wantedScript = record => record.url.includes('/orchestrate/')
    || (record.url.includes('/turnstile/') && record.url.includes('/api.js'))
    || record.url.includes('/rocket-loader')
    || record.url.includes('/scripts/jsd/');
  const scripts = [];
  const scriptKeys = new Set();
  for (const record of scriptRecords.filter(wantedScript)) {
    const key = `${record.url}:${record.script_sha256}`;
    if (scriptKeys.has(key)) continue;
    scriptKeys.add(key);
    scripts.push({
      url: record.url,
      final_url: record.final_url || record.url,
      sha256: record.script_sha256,
      artifact_path: path.join(traceDir, record.artifact_path),
      size: record.raw_size,
    });
  }

  const firstPageRequest = Array.from(requests.values())
    .filter(request => request.url && request.url.includes('simple.ripley.com.pe/cdn-cgi/challenge-platform/') && request.url.includes('/fo/'))
    .sort((a, b) => (a.events[0]?.ts_us || 0) - (b.events[0]?.ts_us || 0))[0];
  const bootstrapHints = {};
  if (firstPageRequest) {
    const requestStart = Math.min(...firstPageRequest.events.map(event => event.ts_us || Number.MAX_SAFE_INTEGER));
    const requestEnd = Math.max(...firstPageRequest.events.map(event => event.ts_us || 0));
    const jsRows = readJsonl(path.join(traceDir, 'categorized/js.jsonl'));
    const candidates = [];
    for (const event of jsRows) {
      if (event.type !== 'js.call.enter' || event.argc !== 1) continue;
      if (!String(event.script_url || '').includes('/orchestrate/')) continue;
      if ((event.ts_us || 0) < requestStart || (event.ts_us || 0) > requestEnd) continue;
      const arg = event.data?.args?.[0];
      if (arg?.type !== 'object' || !Array.isArray(arg.props)) continue;
      for (const prop of arg.props) {
        const value = prop?.value;
        if (value?.type !== 'string' || Number(value.size || 0) < 256 || !value.value_store_path) continue;
        const artifact = path.join(traceDir, value.value_store_path);
        const text = maybeReadArtifact(artifact);
        if (!text.includes('-1.2.1.1-')) continue;
        candidates.push({ text, size: Buffer.byteLength(text), artifact, sha256: value.sha256 || '' });
      }
    }
    candidates.sort((a, b) => b.size - a.size);
    if (candidates[0]) {
      bootstrapHints.md = {
        value: candidates[0].text,
        sha256: candidates[0].sha256,
        source_artifact: candidates[0].artifact,
        source: 'first-page-fo-encoder-argument',
      };
    }
  }

  const vector = {
    schema: 'firefox_trace.cloudflare_5s_vector.v1',
    trace_dir: traceDir,
    manifest: {
      campaign_id: manifest.campaign_id,
      run_label: manifest.run_label,
      target_url: manifest.target_url,
      capture_plan: manifest.env?.TRACE_CAPTURE_PLAN,
    },
    trace_health: {
      evidence_complete: health.evidence_complete,
      incomplete_reasons: health.incomplete_reasons,
      value_capture_complete: health.environment_coverage?.value_capture_complete,
      object_contract_complete: health.environment_coverage?.object_contract_complete,
      trace_degraded: health.counts?.trace_degraded,
    },
    target_header_fields: ['cf-chl', 'cf-chl-ra'],
    bootstrap_hints: bootstrapHints,
    http_channels: httpChannels,
    xhr_vectors: Array.from(requests.values()).filter(request => request.url && request.url.includes('/fo/')),
    scripts,
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`);
  console.log(JSON.stringify({ output, xhr_vectors: vector.xhr_vectors.length, scripts: vector.scripts.length, http_channels: vector.http_channels.length }, null, 2));
}

function maybeReadArtifact(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return ''; }
}

main();
