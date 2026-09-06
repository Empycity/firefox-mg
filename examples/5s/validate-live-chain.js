#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const runtimeData = path.join(__dirname, 'runtime-data');
const bootstrapPath = path.join(runtimeData, 'live-validation-bootstrap.json');
const runnerPath = path.join(runtimeData, 'live-validation-runner.json');
const resultPath = path.join(runtimeData, 'live-validation-result.json');
const nodeStderrPath = path.join(runtimeData, 'live-validation-node.stderr');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bidiValue(result) {
  const value = result?.result || result;
  if (value?.type !== 'string') throw new Error(`unexpected BiDi result: ${JSON.stringify(value)}`);
  return JSON.parse(value.value);
}

async function main() {
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  const pending = new Map();
  const networkEvents = [];
  const networkWaiters = new Set();
  const networkUrl = params => params?.response?.url || params?.request?.url || '';
  const wakeNetworkWaiters = () => {
    for (const waiter of networkWaiters) waiter();
  };
  const waitForNetwork = async (url, startIndex, timeoutMs = 5000) => {
    const matching = () => networkEvents.slice(startIndex).filter(event => networkUrl(event.params) === url);
    const find = () => matching().find(event => event.method === 'network.responseCompleted') || null;
    const existing = find();
    if (existing) return existing;
    return new Promise(resolve => {
      let timer;
      const check = () => {
        const matched = find();
        if (!matched) return;
        clearTimeout(timer);
        networkWaiters.delete(check);
        resolve(matched);
      };
      timer = setTimeout(() => {
        networkWaiters.delete(check);
        resolve(matching().at(-1) || null);
      }, timeoutMs);
      networkWaiters.add(check);
    });
  };
  const networkHeaders = headers => Object.fromEntries((headers || []).map(header => [
    String(header.name || '').toLowerCase(),
    String(header.value?.value ?? header.value ?? ''),
  ]));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'network.responseCompleted' || message.method === 'network.fetchError') {
      networkEvents.push({ method: message.method, params: message.params });
      wakeNetworkWaiters();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const navigate = async (context, url) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await send('browsingContext.navigate', { context, url, wait: 'complete' });
      } catch (error) {
        lastError = error;
        if (!String(error && error.message || error).includes('NS_ERROR_NET_INTERRUPT')) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
      const state = bidiValue(await send('script.evaluate', {
        target: { context }, awaitPromise: true, resultOwnership: 'none',
        expression: 'JSON.stringify({ href: location.href, readyState: document.readyState })',
      }));
      if (!String(state.href || '').startsWith('about:neterror')) return state;
      lastError = new Error(`navigation reached ${state.href}`);
    }
    throw lastError || new Error(`navigation failed: ${url}`);
  };

  let userContext;
  const auxiliaryContexts = new Set();
  const transportContexts = new Map();
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    await send('session.subscribe', { events: ['network.responseCompleted', 'network.fetchError'] });
    ({ userContext } = await send('browser.createUserContext'));
    await send('script.addPreloadScript', {
      userContexts: [userContext],
      functionDeclaration: `() => {
        let captured = false;
        const appendChild = Node.prototype.appendChild;
        Node.prototype.appendChild = function(node) {
          const src = String(node && node.src || '');
          if (src.includes('/cdn-cgi/challenge-platform/') && src.includes('/orchestrate/')) {
            globalThis.__firefoxTraceBlockedOrchestrate = src;
            return node;
          }
          return appendChild.call(this, node);
        };
        Object.defineProperty(globalThis, '_cf_chl_opt', {
          configurable: true,
          get() { return undefined; },
          set(value) {
            if (!captured) {
              captured = true;
              globalThis.__firefoxTraceCfBootstrap = JSON.stringify(value);
            }
            Object.defineProperty(globalThis, '_cf_chl_opt', {
              value, writable: true, enumerable: true, configurable: true,
            });
          },
        });
      }`,
    });
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await navigate(context, targetUrl);

    const captured = bidiValue(await send('script.evaluate', {
      target: { context }, awaitPromise: true, resultOwnership: 'none',
      expression: `(async () => {
        const raw = globalThis.__firefoxTraceCfBootstrap;
        if (!raw) throw new Error('_cf_chl_opt bootstrap was not observed');
        const bootstrap = JSON.parse(raw);
        const orchestrateUrl = new URL('/cdn-cgi/challenge-platform/h/' + bootstrap.cFPWv + '/orchestrate/chl_page/v1?ray=' + bootstrap.cRay, location.href).href;
        const response = await fetch(orchestrateUrl);
        const nodeFilter = Object.fromEntries(Reflect.ownKeys(NodeFilter).map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(NodeFilter, key);
          return [String(key), {
            type: typeof descriptor.value,
            value: typeof descriptor.value === 'number' ? descriptor.value : undefined,
            writable: descriptor.writable,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
          }];
        }));
        const iteratorRoot = document.createElement('div');
        iteratorRoot.innerHTML = '<span>A</span><b>B</b>';
        const iterator = document.createNodeIterator(iteratorRoot, NodeFilter.SHOW_ELEMENT);
        const iteratorPrototype = Object.getPrototypeOf(iterator);
        const iteratorMembers = Object.fromEntries(Reflect.ownKeys(iteratorPrototype).map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(iteratorPrototype, key);
          return [String(key), {
            kind: 'value' in descriptor ? typeof descriptor.value : 'accessor',
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
            writable: descriptor.writable,
            has_get: typeof descriptor.get === 'function',
            has_set: typeof descriptor.set === 'function',
          }];
        }));
        const iteratorSequence = [];
        for (let node = iterator.nextNode(); node; node = iterator.nextNode()) iteratorSequence.push(node.tagName);
        return JSON.stringify({
          pageUrl: location.href, bootstrap, orchestrateUrl, status: response.status,
          script: await response.text(),
          environment: {
            nodeFilter: {
              type: typeof NodeFilter,
              prototype: Object.getPrototypeOf(NodeFilter) === Function.prototype ? 'Function.prototype' : Object.prototype.toString.call(Object.getPrototypeOf(NodeFilter)),
              own_properties: nodeFilter,
            },
            nodeIterator: {
              method_descriptor: (() => {
                const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'createNodeIterator');
                return { type: typeof descriptor.value, length: descriptor.value.length, writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable };
              })(),
              prototype_name: iteratorPrototype.constructor.name,
              prototype_members: iteratorMembers,
              sequence: iteratorSequence,
            },
          },
        });
      })()`,
    }));

    const orchestrateSha256 = sha256(captured.script);
    const orchestratePath = path.join(runtimeData, `orchestrate-${orchestrateSha256}.js`);
    const bootstrap = {
      schema: 'firefox_trace.cloudflare_bootstrap.v1',
      captured_at: new Date().toISOString(),
      source: 'firefox-bidi-live-validation',
      target_url: targetUrl,
      page_url: captured.pageUrl,
      bootstrap: captured.bootstrap,
      environment: captured.environment,
      orchestrate: {
        url: captured.orchestrateUrl,
        status: captured.status,
        sha256: orchestrateSha256,
        size: Buffer.byteLength(captured.script),
        artifact_path: orchestratePath,
      },
    };
    fs.mkdirSync(runtimeData, { recursive: true });
    fs.writeFileSync(orchestratePath, captured.script);
    fs.writeFileSync(bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

    const bridgeLog = [];
    const bridge = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', async () => {
        let candidate = null;
        try {
          candidate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (candidate.kind === 'frame-script') {
            const { context: frameContext } = await send('browsingContext.create', { type: 'tab', userContext });
            auxiliaryContexts.add(frameContext);
            let frameScript;
            try {
              await navigate(frameContext, candidate.url);
              transportContexts.set(new URL(candidate.url).origin, frameContext);
              frameScript = bidiValue(await send('script.evaluate', {
                target: { context: frameContext }, awaitPromise: true, resultOwnership: 'none',
                expression: `(async () => {
                  const fetchWithRetry = async url => {
                    let lastError;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                      try {
                        return await fetch(url, { credentials: 'include', cache: 'no-store' });
                      } catch (error) {
                        lastError = error;
                        await new Promise(resolve => setTimeout(resolve, attempt * 300));
                      }
                    }
                    throw lastError;
                  };
                  const response = await fetchWithRetry(location.href);
                  const html = await response.text();
                  const parsed = new DOMParser().parseFromString(html, 'text/html');
                  const serializeNode = node => {
                    if (node.nodeType === Node.TEXT_NODE) return { node_type: 3, text: node.nodeValue || '' };
                    if (node.nodeType !== Node.ELEMENT_NODE) return null;
                    return {
                      node_type: 1,
                      tag: node.localName,
                      attributes: Array.from(node.attributes, attr => [attr.name, attr.value]),
                      children: Array.from(node.childNodes, serializeNode).filter(Boolean),
                    };
                  };
                  const scripts = [];
                  for (const script of parsed.scripts) {
                    if (script.src) {
                      const url = new URL(script.getAttribute('src'), location.href).href;
                      const source = await (await fetchWithRetry(url)).text();
                      scripts.push({ url, code: source });
                    } else {
                      scripts.push({ url: location.href, code: script.textContent || '' });
                    }
                  }
                  return JSON.stringify({
                    status: response.status,
                    code: scripts.map(item => item.code + '\\n//# sourceURL=' + item.url).join('\\n'),
                    script_count: scripts.length,
                    html_size: html.length,
                    dom: serializeNode(parsed.documentElement),
                  });
                })()`,
              }));
            } catch (error) {
              auxiliaryContexts.delete(frameContext);
              await send('browsingContext.close', { context: frameContext }).catch(() => {});
              throw error;
            }
            const frameScriptSha256 = sha256(frameScript.code || '');
            const frameScriptPath = path.join(runtimeData, `turnstile-frame-${frameScriptSha256}.js`);
            fs.writeFileSync(frameScriptPath, frameScript.code || '');
            bridgeLog.push({ kind: 'frame-script', url: candidate.url, status: frameScript.status, script_count: frameScript.script_count, html_size: frameScript.html_size, script_size: Buffer.byteLength(frameScript.code || ''), script_sha256: frameScriptSha256, artifact_path: frameScriptPath });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(frameScript));
            return;
          }
          const payload = Buffer.from(JSON.stringify(candidate)).toString('base64');
          const requestOrigin = new URL(candidate.url).origin;
          const requestContext = transportContexts.get(candidate.realm_origin) || transportContexts.get(requestOrigin) || context;
          const networkStartIndex = networkEvents.length;
          const browserResponse = bidiValue(await send('script.evaluate', {
            target: { context: requestContext }, awaitPromise: true, resultOwnership: 'none',
            expression: `(async () => {
              const request = JSON.parse(atob(${JSON.stringify(payload)}));
              const init = {
                method: request.method,
                headers: request.headers,
                credentials: request.credentials || 'same-origin',
                mode: request.mode || 'cors',
                cache: request.cache || 'default',
              };
              if (request.redirect) init.redirect = request.redirect;
              if (request.referrerPolicy) init.referrerPolicy = request.referrerPolicy;
              if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
              try {
                const response = await fetch(request.url, init);
                const bytes = new Uint8Array(await response.arrayBuffer());
                let binary = '';
                for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                  binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
                }
                const bodyBase64 = btoa(binary);
                const body = new TextDecoder().decode(bytes);
                return JSON.stringify({
                  status: response.status,
                  statusText: response.statusText,
                  url: response.url,
                  headers: Object.fromEntries(response.headers),
                  bodyBase64,
                  body,
                });
              } catch (error) {
                return JSON.stringify({
                  bridgeError: {
                    name: String(error?.name || ''),
                    message: String(error?.message || error),
                    stack: String(error?.stack || ''),
                    pageUrl: location.href,
                    pageOrigin: location.origin,
                    requestUrl: request.url,
                    requestMode: init.mode,
                    requestCredentials: init.credentials,
                  },
                });
              }
            })()`,
          }));
          const nativeNetwork = await waitForNetwork(candidate.url, networkStartIndex);
          if (browserResponse.bridgeError && nativeNetwork?.method !== 'network.responseCompleted') {
            throw new Error(`browser fetch failed: ${JSON.stringify(browserResponse.bridgeError)}`);
          }
          const nativeResponse = nativeNetwork?.params?.response || null;
          const responseHeaders = {
            ...(browserResponse.bridgeError ? {} : (browserResponse.headers || {})),
            ...networkHeaders(nativeResponse?.headers),
          };
          const responseBytes = browserResponse.bridgeError
            ? Buffer.alloc(0)
            : Buffer.from(browserResponse.bodyBase64 || '', 'base64');
          const bridgeEntry = {
            url: candidate.url,
            realm_origin: candidate.realm_origin || null,
            request_origin: requestOrigin,
            request_mode: candidate.mode || 'cors',
            request_credentials: candidate.credentials || 'same-origin',
            request_body_size: Buffer.byteLength(candidate.body || ''),
            status: browserResponse.bridgeError ? Number(nativeResponse?.status || 0) : browserResponse.status,
            status_text: browserResponse.bridgeError ? String(nativeResponse?.statusText || '') : (browserResponse.statusText || ''),
            response_url: browserResponse.bridgeError ? (nativeResponse?.url || candidate.url) : (browserResponse.url || candidate.url),
            response_headers: responseHeaders,
            response_content_type: responseHeaders['content-type'] || null,
            response_body_size: browserResponse.bridgeError ? Number(nativeResponse?.bodySize || 0) : responseBytes.length,
            response_sha256: sha256(responseBytes),
            response_source: browserResponse.bridgeError ? 'bidi-network-responseCompleted' : 'fetch-response',
            fetch_visibility_error: browserResponse.bridgeError || null,
          };
          Object.defineProperty(bridgeEntry, 'response_body_bytes', { value: responseBytes });
          bridgeLog.push(bridgeEntry);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(browserResponse.bridgeError ? {
            status: bridgeEntry.status,
            statusText: bridgeEntry.status_text,
            url: bridgeEntry.response_url,
            headers: bridgeEntry.response_headers,
            bodyBase64: '',
            body: '',
            networkFallback: true,
          } : browserResponse));
        } catch (error) {
          const bridgeError = String(error && error.stack || error);
          if (candidate && candidate.kind !== 'frame-script') {
            bridgeLog.push({
              kind: 'request-error',
              url: candidate.url || null,
              realm_origin: candidate.realm_origin || null,
              request_origin: (() => {
                try { return new URL(candidate.url).origin; } catch { return null; }
              })(),
              request_mode: candidate.mode || 'cors',
              request_credentials: candidate.credentials || 'same-origin',
              request_body_size: Buffer.byteLength(candidate.body || ''),
              error: bridgeError,
            });
          }
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: bridgeError }));
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
      '--timeout-ms', '12000',
      '--settle-ms', '30000',
      '--output', runnerPath,
    ], { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let nodeStdout = '';
    let nodeStderr = '';
    nodeRun.stdout.on('data', chunk => { nodeStdout += chunk; });
    nodeRun.stderr.on('data', chunk => { nodeStderr += chunk; });
    const nodeExit = await new Promise((resolve, reject) => {
      nodeRun.once('error', reject);
      nodeRun.once('close', (code, signal) => resolve({ code, signal }));
    });
    await new Promise(resolve => bridge.close(resolve));
    fs.writeFileSync(nodeStderrPath, nodeStderr);
    if (nodeExit.code !== 0) {
      const diagnostic = nodeStderr || nodeStdout;
      throw new Error(`Node runtime failed with code=${nodeExit.code} signal=${nodeExit.signal || 'none'} (full stderr: ${nodeStderrPath}):\n${diagnostic.slice(-8192)}`);
    }
    const runner = JSON.parse(fs.readFileSync(runnerPath, 'utf8'));
    const candidate = runner.observed_dynamic_requests.find(request => request.url.includes('/cdn-cgi/challenge-platform/') && request.url.includes('/fo/'));
    if (!candidate) throw new Error('Node runtime did not generate a /fo/ request');
    const browserNetwork = bridgeLog.filter(entry => entry.kind !== 'frame-script');
    const responseQueues = new Map();
    for (const browser of browserNetwork) {
      const key = `${browser.url}\0${browser.request_body_size}`;
      const queue = responseQueues.get(key) || [];
      queue.push(browser);
      responseQueues.set(key, queue);
    }
    const matchedResponses = new Map();
    const stageComparison = runner.observed_dynamic_requests.map(request => {
      const key = `${request.url}\0${request.body.size}`;
      const browser = responseQueues.get(key)?.shift() || null;
      matchedResponses.set(request.seq, browser);
      const pathname = new URL(request.url).pathname;
      let responseSemantics = browser ? browser.status > 0 : false;
      if (pathname.includes('/i/')) responseSemantics = browser?.status === 204 && !!browser?.response_headers?.['cf-chl-peek'];
      if (pathname.includes('/pat/')) responseSemantics = browser?.status === 401 && /^PrivateToken\b/.test(browser?.response_headers?.['www-authenticate'] || '');
      if (pathname.includes('/eb/') && pathname.endsWith('/chl_api_m')) responseSemantics = browser?.status === 200 && browser?.response_body_size === 2;
      return {
        seq: request.seq,
        transport: request.transport,
        method: request.method,
        path: pathname,
        node_body_size: request.body.size,
        browser_body_size: browser?.request_body_size ?? null,
        exact_url: browser?.url === request.url,
        exact_body_size: browser?.request_body_size === request.body.size,
        response_status: browser?.status ?? null,
        bridge_error: browser?.error || null,
        response_semantics: responseSemantics,
        passed: !!browser && browser.url === request.url && browser.request_body_size === request.body.size && responseSemantics,
      };
    });
    const unmatchedBrowserResponses = Array.from(responseQueues.values()).flat();
    const stageGate = stageComparison.length > 0 && stageComparison.every(stage => stage.passed);
    if (runner.env_gaps_errors.length || !stageGate) {
      throw new Error(`live stage comparison failed: ${JSON.stringify({ runtime_errors: runner.env_gaps_errors, stageComparison, unmatchedBrowserResponses })}`);
    }
    // A Turnstile /fo/ or /eb/ can be the last generated challenge request
    // without being the clearance response. Require an origin /fo/ whose own
    // native response carries cf_clearance.
    const targetOrigin = new URL(targetUrl).origin;
    const finalPair = runner.observed_dynamic_requests
      .filter(request => {
        try {
          const url = new URL(request.url);
          return url.origin === targetOrigin && url.pathname.includes('/cdn-cgi/challenge-platform/')
            && url.pathname.includes('/fo/');
        } catch { return false; }
      })
      .map(request => ({ request, response: matchedResponses.get(request.seq) }))
      .filter(({ response }) => /(?:^|[,;]\s*)cf_clearance=/i.test(response?.response_headers?.['set-cookie'] || ''))
      .at(-1) || null;
    const finalRequest = finalPair?.request || null;
    const finalBrowserResponse = finalPair?.response || null;
    const finalPath = finalRequest ? new URL(finalRequest.url).pathname : '';
    const finalStage = stageComparison.find(stage => stage.seq === finalRequest?.seq) || null;
    const finalResponseBytes = finalBrowserResponse?.response_body_bytes || Buffer.alloc(0);
    const finalResponseArtifact = path.join(runtimeData, `final-stage-response-${sha256(finalResponseBytes)}.bin`);
    fs.writeFileSync(finalResponseArtifact, finalResponseBytes);
    const finalResponse = {
      seq: finalRequest?.seq ?? null,
      path: finalPath || null,
      request_url: finalRequest?.url ?? null,
      exact_url: finalStage?.exact_url || false,
      exact_request_body_size: finalStage?.exact_body_size || false,
      request_body_size: finalRequest?.body.size ?? null,
      request_body_sha256: finalRequest?.body.sha256 ?? null,
      status: finalBrowserResponse?.status ?? null,
      status_text: finalBrowserResponse?.status_text ?? null,
      response_url: finalBrowserResponse?.response_url ?? null,
      content_type: finalBrowserResponse?.response_content_type ?? null,
      response_headers: finalBrowserResponse?.response_headers || {},
      key_headers: {
        cf_chl_peek: finalBrowserResponse?.response_headers?.['cf-chl-peek'] || null,
        www_authenticate: finalBrowserResponse?.response_headers?.['www-authenticate'] || null,
      },
      response_body_size: finalBrowserResponse?.response_body_size ?? null,
      response_body_sha256: finalBrowserResponse?.response_sha256 ?? null,
      response_body_artifact: finalResponseArtifact,
      response_semantics: finalStage?.response_semantics || false,
      passed: !!finalStage?.passed,
    };
    const clearanceCookies = (finalBrowserResponse?.response_headers?.['set-cookie'] || '')
      .split(/,(?=\s*cf_clearance=)/i).filter(value => /^\s*cf_clearance=/i.test(value));
    finalResponse.cf_clearance_set = clearanceCookies.length > 0;
    finalResponse.passed = finalResponse.passed && finalResponse.cf_clearance_set;
    if (!finalResponse.passed) throw new Error(`final response comparison failed: ${JSON.stringify(finalResponse)}`);

    const homepageBrowserResponse = bidiValue(await send('script.evaluate', {
      target: { context }, awaitPromise: true, resultOwnership: 'none',
      expression: `(async () => {
        const response = await fetch(${JSON.stringify(targetUrl)}, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow',
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          redirected: response.redirected,
          headers: Object.fromEntries(response.headers),
          bodyBase64: btoa(binary),
        });
      })()`,
    }));
    const homepageBytes = Buffer.from(homepageBrowserResponse.bodyBase64 || '', 'base64');
    const homepageText = homepageBytes.toString('utf8');
    const homepageSha256 = sha256(homepageBytes);
    const homepageArtifact = path.join(runtimeData, `homepage-response-${homepageSha256}.html`);
    fs.writeFileSync(homepageArtifact, homepageBytes);
    const title = (homepageText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/\s+/g, ' ').trim();
    const challengeMarkers = [
      '_cf_chl_opt',
      '/cdn-cgi/challenge-platform/',
      'Just a moment',
      'Enable JavaScript and cookies to continue',
    ].filter(marker => homepageText.includes(marker));
    const homepagePassed = homepageBrowserResponse.status === 200
      && /^text\/html\b/i.test(homepageBrowserResponse.headers?.['content-type'] || '')
      && homepageBytes.length > 10000
      && challengeMarkers.length === 0;
    const homepageResponse = {
      request_url: targetUrl,
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      status: homepageBrowserResponse.status,
      status_text: homepageBrowserResponse.statusText,
      response_url: homepageBrowserResponse.url,
      redirected: !!homepageBrowserResponse.redirected,
      response_headers: homepageBrowserResponse.headers || {},
      content_type: homepageBrowserResponse.headers?.['content-type'] || null,
      response_body_size: homepageBytes.length,
      response_body_sha256: homepageSha256,
      response_body_artifact: homepageArtifact,
      title,
      challenge_markers: challengeMarkers,
      body_preview: homepageText.slice(0, 500),
      passed: homepagePassed,
    };
    const cookieState = bidiValue(await send('script.evaluate', {
      target: { context }, awaitPromise: true, resultOwnership: 'none',
      expression: `JSON.stringify(document.cookie.split(';').map(v => v.trim().split('=')[0]).filter(Boolean))`,
    }));
    homepageResponse.cf_clearance_visible_to_script = cookieState.includes('cf_clearance');
    if (!homepagePassed || !finalResponse.cf_clearance_set) throw new Error(`homepage response validation failed: ${JSON.stringify(homepageResponse)}`);
    const result = {
      schema: 'firefox_trace.cloudflare_live_validation.v1',
      validated_at: new Date().toISOString(),
      bootstrap: { ray: bootstrap.bootstrap.cRay, md_size: bootstrap.bootstrap.md?.length || 0, orchestrate_sha256: bootstrap.orchestrate.sha256 },
      candidate: { url: candidate.url, headers: candidate.headers, body_size: candidate.body.size, body_sha256: candidate.body.sha256 },
      browser_responses: bridgeLog,
      generated_requests: runner.trace_alignment_summary,
      stage_comparison: stageComparison,
      stage_gate: 'passed',
      final_response: finalResponse,
      final_response_gate: 'passed',
      homepage_response: homepageResponse,
      homepage_response_gate: 'passed',
      runtime_errors: runner.env_gaps_errors,
      node_acceptance: runner.acceptance,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ result: resultPath, ...result }, null, 2));
  } finally {
    for (const context of auxiliaryContexts) {
      await send('browsingContext.close', { context }).catch(() => {});
    }
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
