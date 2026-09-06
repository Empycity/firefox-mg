#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const output = path.resolve(process.argv[3] || path.join(__dirname, 'runtime-data/browser-console-live-telemetry.json'));
const targetUrl = process.argv[4] || 'https://simple.ripley.com.pe/';

async function main() {
  const socket = new WebSocket(endpoint);
  let id = 0;
  const pending = new Map();
  const networkEvents = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method && message.method.startsWith('network.')) {
      networkEvents.push({ method: message.method, params: message.params });
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    await send('session.subscribe', { events: ['network.beforeRequestSent', 'network.responseCompleted'] });
    ({ userContext } = await send('browser.createUserContext'));
    const preload = `() => {
      const storageKey = '__firefoxTraceTelemetryLog';
      let log = [];
      try { log = JSON.parse(sessionStorage.getItem(storageKey) || '[]'); } catch (_) {}
      const record = entry => {
        const enriched = { ...entry, realmHref: location.href };
        log.push(enriched);
        try { sessionStorage.setItem(storageKey, JSON.stringify(log)); } catch (_) {}
        if (globalThis !== globalThis.top) {
          try { globalThis.top.postMessage({ __firefoxTraceTelemetryEntry: enriched }, '*'); } catch (_) {}
        }
      };
      if (globalThis === globalThis.top) {
        addEventListener('message', event => {
          const entry = event.data && event.data.__firefoxTraceTelemetryEntry;
          if (!entry || typeof entry !== 'object') return;
          log.push(entry);
          try { sessionStorage.setItem(storageKey, JSON.stringify(log)); } catch (_) {}
        });
      }
      const snapshot = value => {
        try {
          if (!value || typeof value !== 'object') return { type: typeof value, value };
          const keys = Object.keys(value);
          const numeric = keys.filter(key => /^\\d+$/.test(key));
          const shallow = {};
          for (const key of keys) {
            const item = value[key];
            if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) shallow[key] = item;
            else if (Array.isArray(item)) shallow[key] = { type: 'array', length: item.length, preview: item.slice(0, 4) };
            else shallow[key] = { type: Object.prototype.toString.call(item), keys: Object.keys(item).slice(0, 12) };
          }
          return { keys, numeric, keyCount: keys.length, numericCount: numeric.length, shallow };
        } catch (error) { return { error: String(error) }; }
      };
      const nativeTimeout = globalThis.setTimeout;
      globalThis.setTimeout = function wrappedTimeout(callback, delay, ...args) {
        if (delay === 100 && args.length >= 2) {
          record({ op: 'timer-scheduled', delay, args: args.map(snapshot), at: performance.now() });
          const wrapped = function wrappedCallback(...callbackArgs) {
            record({ op: 'timer-enter', args: args.map(snapshot), at: performance.now() });
            const result = callback.apply(this, callbackArgs);
            record({ op: 'timer-return', args: args.map(snapshot), at: performance.now(), result: snapshot(result) });
            return result;
          };
          return nativeTimeout.call(this, wrapped, delay, ...args);
        }
        return nativeTimeout.call(this, callback, delay, ...args);
      };
      const xhrOpen = XMLHttpRequest.prototype.open;
      const xhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this.__firefoxTraceRequest = { method: String(method), url: new URL(String(url), location.href).href };
        return xhrOpen.call(this, method, url, ...args);
      };
      XMLHttpRequest.prototype.send = function(body) {
        const request = this.__firefoxTraceRequest || { method: '', url: '' };
        if (request.url.includes('/cdn-cgi/challenge-platform/') && request.url.includes('/fo/')) {
          record({ op: 'xhr-send', method: request.method, url: request.url,
            body: typeof body === 'string' ? body : null,
            bodyLength: typeof body === 'string' ? body.length : null, at: performance.now() });
          this.addEventListener('loadend', () => record({ op: 'xhr-loadend', method: request.method, url: request.url,
            status: this.status, responseURL: this.responseURL,
            responseText: this.responseType === '' || this.responseType === 'text' ? this.responseText : null,
            responseLength: this.responseType === '' || this.responseType === 'text' ? this.responseText.length : null,
            responseHeaders: this.getAllResponseHeaders(), at: performance.now() }), { once: true });
        }
        return xhrSend.call(this, body);
      };
      globalThis.__firefoxTraceTelemetry = log;
    }`;
    await send('script.addPreloadScript', { functionDeclaration: preload, userContexts: [userContext] });
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 15000));
    const tree = await send('browsingContext.getTree', { root: context });
    const contexts = [];
    const collectContexts = nodes => {
      for (const node of nodes || []) {
        contexts.push({ context: node.context, url: node.url || '' });
        collectContexts(node.children);
      }
    };
    collectContexts(tree.contexts);
    const observedContexts = [];
    for (const item of contexts) {
      const evaluated = await send('script.evaluate', {
        expression: `JSON.stringify({href: location.href, log: (() => {
        try { return JSON.parse(sessionStorage.getItem('__firefoxTraceTelemetryLog') || '[]'); }
        catch (_) { return globalThis.__firefoxTraceTelemetry || []; }
      })()})`,
        target: { context: item.context }, awaitPromise: false, resultOwnership: 'none',
      }).catch(error => ({ error: String(error && error.message || error) }));
      if (evaluated.error) {
        observedContexts.push({ ...item, error: evaluated.error, log: [] });
        continue;
      }
      const value = evaluated.result?.value || '{}';
      observedContexts.push({ context: item.context, ...JSON.parse(value) });
    }
    const top = observedContexts.find(item => item.context === context) || observedContexts[0] || { href: '', log: [] };
    const result = {
      schema: 'firefox_trace.browser_console_live_telemetry.v2',
      captured_at: new Date().toISOString(),
      target_url: targetUrl,
      observed: top,
      contexts: observedContexts,
      network: networkEvents,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      output,
      href: result.observed.href,
      contexts: result.contexts.length,
      entries: result.contexts.reduce((count, item) => count + (item.log?.length || 0), 0),
    }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
