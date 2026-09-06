#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawn } = require('child_process');

const targetUrl = process.argv[2] || 'https://simple.ripley.com.pe/';
const runtimeData = path.join(__dirname, 'runtime-data');
const bootstrapPath = path.join(runtimeData, 'local-validation-bootstrap.json');
const runnerPath = path.join(runtimeData, 'local-validation-runner.json');
const resultPath = path.join(runtimeData, 'local-validation-result.json');
const nodeStderrPath = path.join(runtimeData, 'local-validation-node.stderr');
const transport = process.env.CLOUDFLARE_TRANSPORT || 'curl-cffi';
const userAgent = process.env.CLOUDFLARE_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';
let activeSession = null;

class PythonTransportClient {
  constructor({ python, helper, decoratePayload }) {
    const pythonPath = process.env.CURL_CFFI_PYTHONPATH || '';
    const env = { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
    this.child = spawn(python, [path.join(__dirname, helper), '--server'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = '';
    this.stderr = '';
    this.decoratePayload = decoratePayload;
    this.child.stdout.on('data', chunk => {
      this.stdout += chunk;
      for (;;) {
        const newline = this.stdout.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdout.slice(0, newline);
        this.stdout = this.stdout.slice(newline + 1);
        if (!line) continue;
        let result;
        try { result = JSON.parse(line); }
        catch (error) { this.failAll(new Error(`curl_cffi transport returned invalid JSON: ${error.message}`)); continue; }
        const pending = this.pending.get(result.id);
        if (!pending) continue;
        this.pending.delete(result.id);
        if (result.error) pending.reject(new Error(`curl_cffi transport failed: ${result.error}`));
        else pending.resolve(result);
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.once('error', error => this.failAll(error));
    this.child.once('close', code => {
      if (this.pending.size) this.failAll(new Error(`curl_cffi transport exited code=${code}: ${this.stderr.slice(-4096)}`));
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(url, { method, headers, body }) {
    const id = this.nextId++;
    const payload = {
      id,
      url,
      method,
      headers: Object.fromEntries(headers),
      body_base64: Buffer.from(body == null ? '' : body).toString('base64'),
      impersonate: process.env.CURL_CFFI_IMPERSONATE || 'firefox135',
      timeout: 30,
    };
    Object.assign(payload, this.decoratePayload?.() || {});
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
    const responseHeaders = new Headers(result.headers || {});
    if (result.set_cookie?.length) responseHeaders.set('set-cookie', result.set_cookie.join(', '));
    return {
      status: result.status,
      statusText: result.status_text || '',
      url: result.url || url,
      headers: responseHeaders,
      arrayBuffer: async () => Buffer.from(result.body_base64 || '', 'base64'),
    };
  }

  close() {
    if (!this.child.killed) this.child.kill();
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function freshIdempotencyKey() {
  // Firefox emits a fresh quoted decimal token for challenge POST channels.
  return `"${crypto.randomInt(0, 0x100000000).toString()}${crypto.randomInt(0, 0x100000000).toString().padStart(10, '0')}"`;
}

function bodyArtifact(prefix, bytes, extension = 'bin') {
  const digest = sha256(bytes);
  const artifactPath = path.join(runtimeData, `${prefix}-${digest}.${extension}`);
  fs.writeFileSync(artifactPath, bytes);
  return { artifact_path: artifactPath, size: bytes.length, sha256: digest };
}

function requestWithChallengeDns(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: Object.fromEntries(headers),
      servername: parsed.hostname,
      lookup(hostname, options, callback) {
        const address = hostname.endsWith('.challenges.cloudflare.com') ? '104.18.8.208' : hostname;
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        let bytes = Buffer.concat(chunks);
        const encoding = String(incoming.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding === 'br') bytes = zlib.brotliDecompressSync(bytes);
          else if (encoding === 'gzip') bytes = zlib.gunzipSync(bytes);
          else if (encoding === 'deflate') bytes = zlib.inflateSync(bytes);
        } catch (error) {
          reject(error);
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve({
          status: incoming.statusCode || 0,
          statusText: incoming.statusMessage || '',
          url,
          headers: responseHeaders,
          arrayBuffer: async () => bytes,
        });
      });
    });
    request.on('error', reject);
    if (body != null) request.write(body);
    request.end();
  });
}

function splitSetCookie(header) {
  if (!header) return [];
  return String(header).split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map(value => value.trim()).filter(Boolean);
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  set(url, headers) {
    const requestUrl = new URL(url);
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));
    for (const raw of values) {
      const parts = raw.split(';').map(value => value.trim());
      const separator = parts[0].indexOf('=');
      if (separator <= 0) continue;
      const cookie = {
        name: parts[0].slice(0, separator),
        value: parts[0].slice(separator + 1),
        domain: requestUrl.hostname,
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: null,
        partitioned: false,
        expires: null,
        sourceUrl: requestUrl.href,
      };
      for (const attribute of parts.slice(1)) {
        const index = attribute.indexOf('=');
        const name = (index < 0 ? attribute : attribute.slice(0, index)).toLowerCase();
        const value = index < 0 ? '' : attribute.slice(index + 1);
        if (name === 'domain') {
          cookie.domain = value.replace(/^\./, '').toLowerCase();
          cookie.hostOnly = false;
        } else if (name === 'path') cookie.path = value || '/';
        else if (name === 'secure') cookie.secure = true;
        else if (name === 'httponly') cookie.httpOnly = true;
        else if (name === 'samesite') cookie.sameSite = value.toLowerCase() || null;
        else if (name === 'partitioned') cookie.partitioned = true;
        else if (name === 'expires') cookie.expires = Date.parse(value) || null;
        else if (name === 'max-age') cookie.expires = Date.now() + Number(value) * 1000;
      }
      const key = `${cookie.domain}\0${cookie.path}\0${cookie.name}`;
      if (cookie.expires && cookie.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  header(url) {
    const requestUrl = new URL(url);
    const now = Date.now();
    const hasClearance = Array.from(this.cookies.values()).some(cookie => cookie.name === 'cf_clearance' && cookie.value);
    return Array.from(this.cookies.entries()).filter(([key, cookie]) => {
      if (cookie.expires && cookie.expires <= now) {
        this.cookies.delete(key);
        return false;
      }
      const domainMatch = cookie.hostOnly
        ? requestUrl.hostname === cookie.domain
        : requestUrl.hostname === cookie.domain || requestUrl.hostname.endsWith(`.${cookie.domain}`);
      if (hasClearance && !cookie.httpOnly && /^cf_/i.test(cookie.name) && cookie.name !== 'cf_clearance') return false;
      return domainMatch && requestUrl.pathname.startsWith(cookie.path) && (!cookie.secure || requestUrl.protocol === 'https:');
    }).map(([, cookie]) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  snapshot() {
    return Array.from(this.cookies.values()).map(cookie => ({ ...cookie }));
  }

  deleteVisibleAbsent(url, documentCookie) {
    const requestUrl = new URL(url);
    const visible = new Set(String(documentCookie || '').split(';').map(item => item.trim().split('=', 1)[0]).filter(Boolean));
    for (const [key, cookie] of this.cookies.entries()) {
      const sameDomain = cookie.hostOnly
        ? requestUrl.hostname === cookie.domain
        : requestUrl.hostname === cookie.domain || requestUrl.hostname.endsWith(`.${cookie.domain}`);
      if (sameDomain && !cookie.httpOnly && !visible.has(cookie.name)) this.cookies.delete(key);
    }
  }
}

class LocalSession {
  constructor() {
    this.jar = new CookieJar();
    this.sequence = 0;
    this.network = [];
    this.pythonTransport = transport === 'curl-cffi'
      ? new PythonTransportClient({
          python: process.env.CURL_CFFI_PYTHON || '/opt/miniconda3/envs/pythonProject/bin/python',
          helper: 'curl-cffi-request.py',
          decoratePayload: () => ({ impersonate: process.env.CURL_CFFI_IMPERSONATE || 'firefox135' }),
        })
      : transport === 'requests-go'
        ? new PythonTransportClient({
            python: process.env.REQUESTS_GO_PYTHON || '/opt/miniconda3/envs/feapder/bin/python',
            helper: 'requests-go-request.py',
            decoratePayload: () => ({ preset: process.env.REQUESTS_GO_PRESET || 'TLS_FIREFOX_145' }),
          })
        : null;
  }

  async request(url, init = {}) {
    let currentUrl = new URL(url).href;
    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    for (let redirectCount = 0; redirectCount <= 8; redirectCount++) {
      const headers = new Headers(init.headers || {});
      if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
      if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.5');
      if (!headers.has('accept')) headers.set('accept', '*/*');
      // Match the headed Firefox channel's advertised content codings.  Keep
      // this as a transport header; challenge-produced values remain dynamic.
      if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br, zstd');
      // Firefox's HTTP channel advertises trailers on these POSTs; retaining
      // it keeps the request vector aligned with the headed trace.
      if (!headers.has('te')) headers.set('te', 'trailers');
      if (method === 'POST' && body != null && !headers.has('content-type')) {
        headers.set('content-type', 'text/plain;charset=UTF-8');
      }
      if (method === 'POST' && body != null && !headers.has('idempotency-key')) {
        headers.set('idempotency-key', freshIdempotencyKey());
      }
      // Preserve the fetch/XHR metadata Firefox exposes on challenge channels.
      // These are transport context, not values from the generated script.
      if (method !== 'GET' || init.mode === 'cors') {
        if (!headers.has('sec-fetch-dest')) headers.set('sec-fetch-dest', 'empty');
        if (!headers.has('sec-fetch-mode')) headers.set('sec-fetch-mode', 'cors');
        if (!headers.has('sec-fetch-site')) headers.set('sec-fetch-site', 'same-origin');
      }
      try {
        const requestHost = new URL(currentUrl).host;
        if (!headers.has('alt-used') && requestHost.endsWith('challenges.cloudflare.com')) headers.set('alt-used', requestHost);
      } catch {}
      if (init.referer && !headers.has('referer')) headers.set('referer', init.referer);
      if (init.origin && !headers.has('origin')) headers.set('origin', init.origin);
      const cookie = this.jar.header(currentUrl);
      if (cookie) headers.set('cookie', cookie);
      let response;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = this.pythonTransport
            ? await this.pythonTransport.request(currentUrl, { method, headers, body })
            : await fetch(currentUrl, { method, headers, body, redirect: 'manual' });
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 300));
        }
      }
      if (!response) {
        const cause = lastError?.cause;
        if (cause?.code === 'ENOTFOUND' && new URL(currentUrl).hostname.endsWith('.challenges.cloudflare.com')) {
          response = await requestWithChallengeDns(currentUrl, { method, headers, body });
        } else {
          throw new Error(`local fetch failed after 3 attempts: ${method} ${currentUrl}: ${cause?.code || cause?.message || lastError?.message || lastError}`);
        }
      }
      this.jar.set(currentUrl, response.headers);
      const bytes = Buffer.from(await response.arrayBuffer());
      const entry = {
        seq: ++this.sequence,
        request: {
          url: currentUrl,
          method,
          headers: Object.fromEntries(headers),
          body_size: body == null ? 0 : Buffer.byteLength(body),
          body_sha256: sha256(body == null ? Buffer.alloc(0) : Buffer.from(body)),
        },
        response: {
          status: response.status,
          status_text: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers),
          set_cookie: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : splitSetCookie(response.headers.get('set-cookie')),
          body_size: bytes.length,
          body_sha256: sha256(bytes),
        },
      };
      Object.defineProperty(entry, 'bodyBytes', { value: bytes });
      this.network.push(entry);
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return entry;
      currentUrl = new URL(location, currentUrl).href;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
    throw new Error(`redirect limit exceeded: ${url}`);
  }

  close() {
    this.pythonTransport?.close();
  }
}

function extractChallengeBootstrap(html) {
  const marker = 'window._cf_chl_opt';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('_cf_chl_opt was not found in local challenge HTML');
  const start = html.indexOf('{', markerIndex);
  if (start < 0) throw new Error('_cf_chl_opt object start was not found');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return vm.runInNewContext(`(${html.slice(start, index + 1)})`, Object.create(null), { timeout: 1000 });
    }
  }
  throw new Error('_cf_chl_opt object end was not found');
}

function extractFrameScripts(html, baseUrl) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const src = match[1].match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    scripts.push({ url: src ? new URL(src, baseUrl).href : baseUrl, inline: src ? '' : match[2] });
  }
  return scripts;
}

function parseAttributes(raw) {
  const attributes = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of raw.matchAll(pattern)) {
    attributes.push([match[1], match[2] ?? match[3] ?? match[4] ?? '']);
  }
  return attributes;
}

function buildFrameDomSnapshot(html) {
  const element = (tag, attributes = [], children = []) => ({ node_type: 1, tag, attributes, children });
  const text = value => ({ node_type: 3, text: value });
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  // Scripts are fetched and executed separately. Strip their raw-text bodies
  // before tokenizing so '<' inside minified JavaScript cannot corrupt the DOM
  // tree. Keep style/title text because challenge selectors may inspect them.
  const source = String(html)
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, '<script$1></script>')
    .replace(/<!--[\s\S]*?-->/g, '');
  const root = element('html');
  const stack = [root];
  let sawHtml = false;
  const tokenPattern = /<![^>]*>|<\/\s*([A-Za-z][\w:-]*)\s*>|<\s*([A-Za-z][\w:-]*)([^>]*)>|([^<]+)/g;
  for (const match of source.matchAll(tokenPattern)) {
    if (match[1]) {
      const tag = match[1].toLowerCase();
      while (stack.length > 1) {
        const node = stack.pop();
        if (node.tag === tag) break;
      }
      continue;
    }
    if (match[2]) {
      const tag = match[2].toLowerCase();
      const attributes = parseAttributes((match[3] || '').replace(/\/\s*$/, ''));
      if (tag === 'html' && !sawHtml) {
        root.attributes = attributes;
        sawHtml = true;
        continue;
      }
      const node = element(tag, attributes);
      stack.at(-1).children.push(node);
      if (!voidTags.has(tag) && !/\/\s*$/.test(match[3] || '')) stack.push(node);
      continue;
    }
    if (match[4] && match[4].length) stack.at(-1).children.push(text(match[4]));
  }
  if (!root.children.some(node => node.node_type === 1 && node.tag === 'head')) root.children.unshift(element('head'));
  if (!root.children.some(node => node.node_type === 1 && node.tag === 'body')) root.children.push(element('body'));
  return root;
}

function responseSemantics(request, response) {
  const pathname = new URL(request.url).pathname;
  if (pathname.includes('/i/')) return response.status === 204 && !!response.headers['cf-chl-peek'];
  if (pathname.includes('/pat/')) return response.status === 401 && /^PrivateToken\b/.test(response.headers['www-authenticate'] || '');
  if (pathname.includes('/eb/') && pathname.endsWith('/chl_api_m')) return response.status === 200 && response.body_size === 2;
  if (pathname.includes('/fo/')) return response.status === 200 && response.body_size > 0;
  return response.status > 0;
}

async function runChallengeRound(session, initial, publicIp, roundIndex) {
  const navigationStartedAt = process.hrtime.bigint();
  const initialHtml = initial.bodyBytes.toString('utf8');
  const initialArtifact = bodyArtifact(`local-round-${roundIndex}-initial-response`, initial.bodyBytes, 'html');
  const bootstrapValue = extractChallengeBootstrap(initialHtml);
  const orchestrateUrl = new URL(`/cdn-cgi/challenge-platform/h/${bootstrapValue.cFPWv}/orchestrate/chl_page/v1?ray=${bootstrapValue.cRay}`, targetUrl).href;
  const orchestrateResponse = await session.request(orchestrateUrl, {
    headers: { accept: '*/*' }, referer: targetUrl,
  });
  if (orchestrateResponse.response.status !== 200) throw new Error(`local orchestrate status ${orchestrateResponse.response.status}`);
  const orchestrateArtifact = bodyArtifact('local-orchestrate', orchestrateResponse.bodyBytes, 'js');
  const bootstrap = {
    schema: 'firefox_trace.cloudflare_bootstrap.v1',
    captured_at: new Date().toISOString(),
    source: 'node-local-http',
    target_url: targetUrl,
    page_url: targetUrl,
    bootstrap: bootstrapValue,
    initial_response: { ...initial.response, artifact_path: initialArtifact.artifact_path },
    cookies_after_initial: session.jar.snapshot(),
    orchestrate: {
      url: orchestrateUrl,
      status: orchestrateResponse.response.status,
      sha256: orchestrateArtifact.sha256,
      size: orchestrateArtifact.size,
      artifact_path: orchestrateArtifact.artifact_path,
      response_headers: orchestrateResponse.response.headers,
    },
  };
  fs.writeFileSync(bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

  const bridgeLog = [];
  const bridge = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const candidate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (candidate.kind === 'frame-script') {
          const frameStartedAt = process.hrtime.bigint();
          const frameResponse = await session.request(candidate.url, {
            headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            referer: targetUrl,
          });
          const documentResponseMs = Number(process.hrtime.bigint() - frameStartedAt) / 1e6;
          const html = frameResponse.bodyBytes.toString('utf8');
          const htmlArtifact = bodyArtifact('local-turnstile-frame-document', frameResponse.bodyBytes, 'html');
          const scripts = extractFrameScripts(html, candidate.url);
          const codeParts = [];
          for (const script of scripts) {
            if (script.inline) codeParts.push(`${script.inline}\n//# sourceURL=${script.url}`);
            else {
              const scriptResponse = await session.request(script.url, { headers: { accept: '*/*' }, referer: candidate.url });
              codeParts.push(`${scriptResponse.bodyBytes.toString('utf8')}\n//# sourceURL=${script.url}`);
            }
          }
          const code = codeParts.join('\n');
          const loadEndMs = Number(process.hrtime.bigint() - frameStartedAt) / 1e6;
          const artifact = bodyArtifact('local-turnstile-frame', Buffer.from(code), 'js');
          bridgeLog.push({ kind: 'frame-script', url: candidate.url, status: frameResponse.response.status, script_count: scripts.length, html_size: frameResponse.bodyBytes.length, html_sha256: htmlArtifact.sha256, html_artifact_path: htmlArtifact.artifact_path, script_size: artifact.size, script_sha256: artifact.sha256, artifact_path: artifact.artifact_path });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            status: frameResponse.response.status,
            code,
            script_count: scripts.length,
            html_size: frameResponse.bodyBytes.length,
            timing: { document_response_ms: documentResponseMs, load_end_ms: loadEndMs },
            dom: buildFrameDomSnapshot(html),
          }));
          return;
        }
        if (candidate.kind === 'script-resource') {
          const startedAt = process.hrtime.bigint();
          const scriptResponse = await session.request(candidate.url, {
            headers: { accept: '*/*' },
            referer: candidate.document_url || targetUrl,
          });
          const responseDoneAt = process.hrtime.bigint();
          const artifact = bodyArtifact('local-dynamic-script', scriptResponse.bodyBytes, 'js');
          const contentLength = Number(scriptResponse.response.headers['content-length']);
          const contentEncoding = String(scriptResponse.response.headers['content-encoding'] || '').toLowerCase();
          let encodedBodySize = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : artifact.size;
          if (!Number.isFinite(contentLength) || contentLength < 0) {
            if (contentEncoding.includes('br')) {
              encodedBodySize = zlib.brotliCompressSync(scriptResponse.bodyBytes, {
                params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
              }).length;
            } else if (contentEncoding.includes('gzip')) {
              encodedBodySize = zlib.gzipSync(scriptResponse.bodyBytes).length;
            } else if (contentEncoding.includes('deflate')) {
              encodedBodySize = zlib.deflateSync(scriptResponse.bodyBytes).length;
            }
          }
          const entry = {
            kind: 'script-resource',
            url: candidate.url,
            response_url: scriptResponse.response.url,
            status: scriptResponse.response.status,
            response_headers: scriptResponse.response.headers,
            response_body_size: artifact.size,
            response_sha256: artifact.sha256,
            response_body_artifact: artifact.artifact_path,
            duration_ms: Number(responseDoneAt - startedAt) / 1e6,
          };
          bridgeLog.push(entry);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            status: entry.status,
            url: entry.response_url,
            headers: entry.response_headers,
            bodyBase64: scriptResponse.bodyBytes.toString('base64'),
            sha256: artifact.sha256,
            artifact_path: artifact.artifact_path,
            encodedBodySize,
            timing: { total_ms: entry.duration_ms },
          }));
          return;
        }
        if (candidate.kind === 'resource') {
          const startedAt = process.hrtime.bigint();
          const resourceResponse = await session.request(candidate.url, {
            method: 'GET', headers: candidate.headers || {},
            referer: candidate.realm_url || targetUrl,
            origin: candidate.realm_origin || new URL(targetUrl).origin,
          });
          const body = resourceResponse.bodyBytes || Buffer.alloc(0);
          const entry = {
            kind: 'resource', url: candidate.url, method: 'GET',
            status: resourceResponse.response.status,
            response_url: resourceResponse.response.url,
            response_headers: resourceResponse.response.headers,
            response_body_size: body.length,
            response_sha256: sha256(body),
            duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
          };
          bridgeLog.push(entry);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            status: entry.status, statusText: resourceResponse.response.status_text,
            url: entry.response_url, headers: entry.response_headers,
            bodyBase64: body.toString('base64'), timing: { total_ms: entry.duration_ms },
          }));
          return;
        }
        const localResponse = await session.request(candidate.url, {
          method: candidate.method,
          headers: candidate.headers,
          body: candidate.method === 'GET' || candidate.method === 'HEAD' ? undefined : candidate.body,
          referer: candidate.realm_url || (candidate.realm_origin ? `${candidate.realm_origin}/` : targetUrl),
          origin: candidate.realm_origin || new URL(targetUrl).origin,
        });
        // Optional A/B fixture injection for the final clearance response.
        // Disabled by default; it is only used to distinguish a producer/body
        // mismatch from a host-contract mismatch while keeping normal runs
        // fully dynamic.
        if (process.env.CLOUDFLARE_FINAL_RESPONSE_FIXTURE && /\/fo\//.test(candidate.url)) {
          const fixture = fs.readFileSync(process.env.CLOUDFLARE_FINAL_RESPONSE_FIXTURE);
          if (fixture.length === 3672 && localResponse.response.set_cookie.some(value => /(?:^|[,;]\s*)cf_clearance=/i.test(value))) {
            localResponse = { ...localResponse, bodyBytes: fixture };
          }
        }
        const artifact = bodyArtifact('local-stage-response', localResponse.bodyBytes, 'bin');
        const entry = {
          url: candidate.url,
          method: candidate.method,
          request_headers: localResponse.request.headers,
          request_body_size: Buffer.byteLength(candidate.body || ''),
          request_body_sha256: sha256(Buffer.from(candidate.body || '')),
          status: localResponse.response.status,
          status_text: localResponse.response.status_text,
          response_url: localResponse.response.url,
          response_headers: localResponse.response.headers,
          response_set_cookie: localResponse.response.set_cookie,
          response_content_type: localResponse.response.headers['content-type'] || null,
          response_body_size: artifact.size,
          response_sha256: artifact.sha256,
          response_body_artifact: artifact.artifact_path,
        };
        bridgeLog.push(entry);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: entry.status,
          statusText: entry.status_text,
          url: entry.response_url,
          headers: entry.response_headers,
          setCookie: entry.response_set_cookie,
          bodyBase64: localResponse.bodyBytes.toString('base64'),
          body: localResponse.bodyBytes.toString('utf8'),
        }));
      } catch (error) {
        bridgeLog.push({
          kind: 'bridge-error',
          message: String(error && error.message || error),
          stack: String(error && error.stack || error),
        });
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error && error.stack || error) }));
      }
    });
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}/xhr`;
  const nodeRun = spawn(process.execPath, [
    path.join(__dirname, 'cloudflare-runtime.js'),
    '--scenario', String(process.env.CLOUDFLARE_SCENARIO || 'orchestrate-turnstile'),
    '--bootstrap', bootstrapPath,
    '--xhr-bridge', bridgeUrl,
    '--navigation-elapsed-ms', String(Number(process.env.CLOUDFLARE_NAVIGATION_ELAPSED_MS || (Number(process.hrtime.bigint() - navigationStartedAt) / 1e6))),
    '--bridge-response-delay-ms', String(Number(process.env.CLOUDFLARE_BRIDGE_RESPONSE_DELAY_MS || 0)),
    '--xhr-progress-mode', String(process.env.CLOUDFLARE_XHR_PROGRESS_MODE || 'staged'),
    '--public-ip', publicIp,
    '--timeout-ms', '12000',
    '--settle-ms', String(process.env.CLOUDFLARE_SETTLE_MS || 30000),
    '--output', runnerPath,
    ...(process.env.CLOUDFLARE_DEBUG_VM === '1' ? ['--debug-vm'] : []),
    ...(process.env.CLOUDFLARE_DIAGNOSTIC_ENCODER === '1' ? ['--diagnostic-encoder'] : []),
  ], { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let nodeStdout = '';
  let nodeStderr = '';
  try { fs.writeFileSync(nodeStderrPath, ''); } catch {}
  nodeRun.stdout.on('data', chunk => { nodeStdout += chunk; });
  nodeRun.stderr.on('data', chunk => { nodeStderr += chunk; try { fs.appendFileSync(nodeStderrPath, chunk); } catch {} });
  const nodeExit = await new Promise((resolve, reject) => {
    nodeRun.once('error', reject);
    nodeRun.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => bridge.close(resolve));
  fs.writeFileSync(nodeStderrPath, nodeStderr);
  if (nodeExit.code !== 0) throw new Error(`Node runtime failed code=${nodeExit.code}: ${(nodeStderr || nodeStdout).slice(-8192)}`);

  const runner = JSON.parse(fs.readFileSync(runnerPath, 'utf8'));
  // Copy script-visible cookies written by the generated page into the HTTP
  // jar before committing its top-level navigation. Values remain generated
  // by the current script/session; no historical cookie is reused.
  const documentCookie = String(runner.runtime_state?.document_cookie || '').trim();
  if (/^[^=;\s]+=.*/.test(documentCookie)) {
    session.jar.set(targetUrl, new Headers({ 'set-cookie': documentCookie }));
  }
  // Reconcile script-visible cookie deletions without touching HttpOnly state.
  // Cookie names remain page/session-derived; no challenge cookie is fixed here.
  session.jar.deleteVisibleAbsent(targetUrl, documentCookie);
  // Only entries produced by a generated XHR/fetch are stage responses.
  // Script and iframe bridge resources are setup traffic and must not make the
  // stage count fail after the request vector itself has matched.
  const networkEntries = bridgeLog.filter(entry => !entry.kind || entry.kind === 'stage-response');
  const responseQueues = new Map();
  for (const entry of networkEntries) {
    const key = `${entry.url}\0${entry.request_body_size}`;
    const queue = responseQueues.get(key) || [];
    queue.push(entry);
    responseQueues.set(key, queue);
  }
  const matched = new Map();
  const stages = runner.observed_dynamic_requests.filter(request => request.transport !== 'resource').map(request => {
    const key = `${request.url}\0${request.body.size}`;
    const local = responseQueues.get(key)?.shift() || null;
    matched.set(request.seq, local);
    const semantics = !!local && responseSemantics(request, {
      status: local.status,
      headers: local.response_headers,
      body_size: local.response_body_size,
    });
    return {
      seq: request.seq,
      transport: request.transport,
      method: request.method,
      url: request.url,
      node_body_size: request.body.size,
      local_body_size: local?.request_body_size ?? null,
      exact_url: local?.url === request.url,
      exact_body_size: local?.request_body_size === request.body.size,
      response_status: local?.status ?? null,
      response_headers: local?.response_headers || {},
      response_body_size: local?.response_body_size ?? null,
      response_body_sha256: local?.response_sha256 ?? null,
      response_body_artifact: local?.response_body_artifact ?? null,
      response_semantics: semantics,
      passed: !!local && local.url === request.url && local.request_body_size === request.body.size && semantics,
    };
  });
  const unmatched = Array.from(responseQueues.values()).flat();
  // Optional Turnstile API/iframe resources can time out after the standalone
  // challenge has already produced the clearance response. They are not part
  // of the generated /fo/ request contract and must not invalidate that gate.
  const coreEnvErrors = runner.env_gaps_errors.filter(error => {
    const where = String(error.where || '');
    return !where.startsWith('script.bridge:https://challenges.cloudflare.com/turnstile/')
      && !where.startsWith('script:https://challenges.cloudflare.com/turnstile/');
  });
  const stageGate = !coreEnvErrors.length && unmatched.length === 0
    && stages.length === networkEntries.length && stages.every(stage => stage.passed);
  // The last generated challenge request is not necessarily the clearance
  // response: Turnstile may emit another /fo/ on the challenge origin after
  // PAT.  Bind the final gate to an origin /fo/ whose response actually sets
  // cf_clearance, instead of treating any last stage as final.
  const finalCandidates = runner.observed_dynamic_requests
    .filter(request => request.transport !== 'resource' && /\/fo\//.test(new URL(request.url).pathname))
    .map(request => ({ request, response: matched.get(request.seq) }))
    .filter(({ request, response }) => {
      if (!response || new URL(request.url).origin !== new URL(targetUrl).origin) return false;
      return (response.response_set_cookie || []).some(value => /(?:^|[,;]\s*)cf_clearance=/i.test(value));
    });
  const finalPair = finalCandidates.at(-1) || null;
  const finalRequest = finalPair?.request || null;
  const finalResponse = finalRequest ? matched.get(finalRequest.seq) : null;
  const clearanceCookie = session.jar.snapshot().find(cookie => cookie.name === 'cf_clearance') || null;
  const clearanceValue = clearanceCookie?.value || '';
  const clearanceUsable = !!clearanceCookie
    && clearanceValue !== ''
    && (clearanceCookie.domain === new URL(targetUrl).hostname
      || new URL(targetUrl).hostname.endsWith(`.${clearanceCookie.domain}`))
    && new URL(targetUrl).pathname.startsWith(clearanceCookie.path)
    && (!clearanceCookie.secure || new URL(targetUrl).protocol === 'https:')
    && (!clearanceCookie.expires || clearanceCookie.expires > Date.now());
  const clearanceContractMatches = clearanceUsable
    && clearanceCookie.httpOnly
    && clearanceCookie.sameSite === 'none'
    && clearanceCookie.partitioned;
  return {
    round: roundIndex,
    bootstrapValue,
    orchestrateArtifact,
    initial,
    initialArtifact,
    bridgeLog,
    runner,
    networkEntries,
    stages,
    stageGate,
    finalResponse,
    clearanceCookie,
    clearanceValue,
    clearanceUsable,
    clearanceContractMatches,
    navigation: runner.navigation_log?.at(-1) || null,
    coreEnvErrors,
  };
}

function inspectHomepage(entry, clearanceContractMatches, clearanceValue, roundCount) {
  const html = entry.bodyBytes.toString('utf8');
  const artifact = bodyArtifact('local-homepage-response', entry.bodyBytes, 'html');
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const challengeMarkers = ['_cf_chl_opt', '/cdn-cgi/challenge-platform/', 'Just a moment', 'Enable JavaScript and cookies to continue'].filter(marker => html.includes(marker));
  const cookieHeader = entry.request.headers.cookie || '';
  const sentClearance = cookieHeader.match(/(?:^|;\s*)cf_clearance=([^;]+)/)?.[1] || '';
  const hasClearance = clearanceContractMatches && sentClearance === clearanceValue;
  const passed = entry.response.status === 200
    && /^text\/html\b/i.test(entry.response.headers['content-type'] || '')
    && entry.bodyBytes.length > 10000
    && challengeMarkers.length === 0
    && hasClearance;
  return {
    request: entry.request, response: entry.response,
    body_artifact: artifact.artifact_path, body_size: artifact.size, body_sha256: artifact.sha256,
    title, challenge_markers: challengeMarkers, has_cf_clearance: hasClearance,
    challenge_rounds: roundCount, body_preview: html.slice(0, 1000), passed,
  };
}

async function main() {
  fs.mkdirSync(runtimeData, { recursive: true });
  const session = new LocalSession();
  activeSession = session;
  const ipResponse = await session.request('https://www.cloudflare.com/cdn-cgi/trace', { headers: { accept: 'text/plain' } });
  const publicIp = /^ip=(.+)$/m.exec(ipResponse.bodyBytes.toString('utf8'))?.[1]?.trim() || '';
  if (!publicIp) throw new Error('current public IP was not present in Cloudflare trace response');

  const navigationHeaders = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    priority: 'u=0, i',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'upgrade-insecure-requests': '1',
  };
  let page = await session.request(targetUrl, { headers: { ...navigationHeaders, 'sec-fetch-site': 'none', 'sec-fetch-user': '?1' } });
  const rounds = [];
  const maxRounds = Math.max(1, Number(process.env.CLOUDFLARE_MAX_CHALLENGE_ROUNDS || 4));
  for (let roundIndex = 1; roundIndex <= maxRounds; roundIndex++) {
    const html = page.bodyBytes.toString('utf8');
    if (!html.includes('window._cf_chl_opt')) break;
    const round = await runChallengeRound(session, page, publicIp, roundIndex);
    rounds.push(round);
    if (!round.stageGate) break;
    const navigation = round.navigation;
    if (round.finalResponse && round.clearanceContractMatches && navigation?.method === 'POST' && navigation.body) {
      page = await session.request(navigation.action || targetUrl, {
        method: 'POST', body: navigation.body,
        headers: { ...navigationHeaders, 'content-type': navigation.enctype || 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        referer: navigation.referer || targetUrl, origin: new URL(targetUrl).origin,
      });
    } else {
      page = await session.request(targetUrl, { headers: { ...navigationHeaders, 'sec-fetch-site': 'cross-site' } });
    }
  }

  // The final clearance response may arrive on the last allowed round without
  // a form/navigation callback. Revalidate the target once with the live jar.
  if (rounds.length && rounds.at(-1).clearanceContractMatches
      && page.bodyBytes.toString('utf8').includes('window._cf_chl_opt')) {
    session.jar.deleteVisibleAbsent(targetUrl, '');
    page = await session.request(targetUrl, {
      headers: { ...navigationHeaders, 'sec-fetch-site': 'cross-site' },
    });
  }

  const lastRound = rounds.at(-1) || null;
  const homepage = inspectHomepage(page, !!lastRound?.clearanceContractMatches, lastRound?.clearanceValue || '', rounds.length);
  const stageGate = rounds.length > 0 && rounds.every(round => round.stageGate);
  const finalResponseGate = !!lastRound?.finalResponse && lastRound.stages.at(-1)?.passed && lastRound.clearanceContractMatches;
  const result = {
    schema: 'firefox_trace.cloudflare_local_validation.v2',
    validated_at: new Date().toISOString(), target_url: targetUrl,
    transport: transport === 'curl-cffi' ? 'node-local-curl-cffi-firefox' : transport === 'requests-go' ? 'node-local-requests-go-firefox' : 'node-local-fetch',
    challenge_round_count: rounds.length,
    challenge_rounds: rounds.map(round => ({
      round: round.round,
      bootstrap: { ray: round.bootstrapValue.cRay, orchestrate_sha256: round.orchestrateArtifact.sha256 },
      initial_response: { ...round.initial.response, body_artifact: round.initialArtifact.artifact_path },
      local_stage_responses: round.bridgeLog,
      stage_comparison: round.stages,
      stage_gate: round.stageGate ? 'passed' : 'failed',
      final_response: round.finalResponse,
      navigation: round.navigation,
      runtime_errors: round.runner.env_gaps_errors,
    })),
    bootstrap: lastRound ? { ray: lastRound.bootstrapValue.cRay, orchestrate_sha256: lastRound.orchestrateArtifact.sha256 } : null,
    initial_response: rounds[0] ? { ...rounds[0].initial.response, body_artifact: rounds[0].initialArtifact.artifact_path } : { ...page.response },
    browser_responses: [],
    local_stage_responses: rounds.flatMap(round => round.bridgeLog),
    stage_comparison: rounds.flatMap(round => round.stages.map(stage => ({ round: round.round, ...stage }))),
    stage_gate: stageGate ? 'passed' : 'failed',
    final_response: lastRound?.finalResponse || null,
    final_response_gate: finalResponseGate ? 'passed' : 'failed',
    core_cookie: {
      name: 'cf_clearance', present: !!lastRound?.clearanceCookie, usable_for_target: !!lastRound?.clearanceUsable,
      value_length: lastRound?.clearanceValue.length || 0,
      value_sha256: lastRound?.clearanceValue ? sha256(lastRound.clearanceValue) : null,
      domain: lastRound?.clearanceCookie?.domain || null, path: lastRound?.clearanceCookie?.path || null,
      secure: lastRound?.clearanceCookie?.secure ?? null, http_only: lastRound?.clearanceCookie?.httpOnly ?? null,
      same_site: lastRound?.clearanceCookie?.sameSite || null, partitioned: lastRound?.clearanceCookie?.partitioned ?? null,
      expires: lastRound?.clearanceCookie?.expires || null, source_url: lastRound?.clearanceCookie?.sourceUrl || null,
      source_stage: lastRound?.networkEntries.find(entry => entry.response_set_cookie?.some(value => /(?:^|[,;]\s*)cf_clearance=/i.test(value)))?.url || null,
      contract_matches_browser: !!lastRound?.clearanceContractMatches,
      homepage_value_matches: homepage.has_cf_clearance,
    },
    homepage_response: Object.fromEntries(Object.entries(homepage).filter(([key]) => key !== 'passed')),
    homepage_response_gate: homepage.passed ? 'passed' : 'failed',
    cookies: session.jar.snapshot(),
    runtime_errors: rounds.flatMap(round => round.runner.env_gaps_errors.map(error => ({ round: round.round, ...error }))),
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ result: resultPath, challenge_round_count: result.challenge_round_count, stage_gate: result.stage_gate, final_response_gate: result.final_response_gate, homepage_response_gate: result.homepage_response_gate, homepage: result.homepage_response }, null, 2));
  if (!stageGate || !finalResponseGate || !homepage.passed || !homepage.has_cf_clearance) process.exitCode = 1;
  session.close();
  activeSession = null;
}

main().catch(error => {
  activeSession?.close();
  console.error(error.stack || error);
  process.exitCode = 1;
});
