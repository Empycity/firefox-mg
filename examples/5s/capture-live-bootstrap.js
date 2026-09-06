#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const output = path.resolve(process.argv[3] || path.join(__dirname, 'runtime-data/live-bootstrap.json'));
const targetUrl = process.argv[4] || 'https://simple.ripley.com.pe/';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
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

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ userContext } = await send('browser.createUserContext'));
    const preload = `() => {
      let captured = false;
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
    }`;
    await send('script.addPreloadScript', { functionDeclaration: preload, userContexts: [userContext] });
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' });

    const expression = `(async () => {
      const raw = globalThis.__firefoxTraceCfBootstrap;
      if (!raw) throw new Error('_cf_chl_opt bootstrap was not observed');
      const bootstrap = JSON.parse(raw);
      const orchestrateUrl = new URL(
        '/cdn-cgi/challenge-platform/h/' + bootstrap.cFPWv +
        '/orchestrate/chl_page/v1?ray=' + bootstrap.cRay,
        location.href
      ).href;
      const response = await fetch(orchestrateUrl);
      const script = await response.text();
      return JSON.stringify({
        pageUrl: location.href,
        bootstrap,
        orchestrateUrl,
        script,
        responseStatus: response.status,
      });
    })()`;
    const evaluated = await send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (evaluated.result.type !== 'string') throw new Error(JSON.stringify(evaluated.result));

    const captured = JSON.parse(evaluated.result.value);
    const scriptPath = output.replace(/\.json$/i, '.orchestrate.js');
    const result = {
      schema: 'firefox_trace.cloudflare_bootstrap.v1',
      captured_at: new Date().toISOString(),
      source: 'firefox-bidi-document-start',
      target_url: targetUrl,
      page_url: captured.pageUrl,
      bootstrap: captured.bootstrap,
      orchestrate: {
        url: captured.orchestrateUrl,
        status: captured.responseStatus,
        sha256: sha256(captured.script),
        size: Buffer.byteLength(captured.script),
        artifact_path: scriptPath,
      },
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(scriptPath, captured.script);
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, orchestrate: result.orchestrate }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
