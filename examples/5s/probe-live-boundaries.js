#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9225/session';
const output = path.resolve(process.argv[3] || path.join(__dirname, 'runtime-data/browser-console-live-boundaries.json'));
const targetUrl = process.argv[4] || 'https://simple.ripley.com.pe/';

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
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ userContext } = await send('browser.createUserContext'));
    await send('script.addPreloadScript', {
      userContexts: [userContext],
      functionDeclaration: `() => {
        const key = '__firefoxTraceBoundaryLog';
        let log = [];
        const now = () => Math.round(performance.now() * 100) / 100;
        const save = () => { try { sessionStorage.setItem(key, JSON.stringify(log.slice(-600))); } catch (_) {} };
        try { log = JSON.parse(sessionStorage.getItem(key) || '[]'); } catch (_) {}
        const summarize = value => {
          try {
            if (value == null || ['string','number','boolean'].includes(typeof value)) {
              const text = typeof value === 'string' ? value : String(value);
              return { type: typeof value, length: text.length, prefix: text.slice(0, 100) };
            }
            const keys = Object.keys(value);
            return { type: Object.prototype.toString.call(value), keyCount: keys.length,
              valueTypes: keys.slice(0, 32).map(name => typeof value[name]),
              arrayLengths: keys.slice(0, 32).map(name => Array.isArray(value[name]) ? value[name].length : null),
              stringValues: keys.slice(0, 32).map(name => typeof value[name] === 'string' ? value[name].slice(0, 160) : null),
              numberValues: keys.slice(0, 32).map(name => typeof value[name] === 'number' ? value[name] : null),
              booleanValues: keys.slice(0, 32).map(name => typeof value[name] === 'boolean' ? value[name] : null),
              objectShapes: keys.slice(0, 32).map(name => {
                const item = value[name];
                if (!item || typeof item !== 'object') return null;
                try { return { tag: Object.prototype.toString.call(item), keyCount: Object.keys(item).length, length: Array.isArray(item) ? item.length : null }; }
                catch (_) { return { tag: 'unreadable' }; }
              }) };
          } catch (error) { return { error: String(error) }; }
        };
        const record = entry => { log.push({ at: now(), href: location.href, ...entry }); save(); };
        globalThis.__firefoxTraceBoundaryLog = log;

        const NativeXHR = globalThis.XMLHttpRequest;
        if (typeof NativeXHR === 'function') {
          const open = NativeXHR.prototype.open;
          const send = NativeXHR.prototype.send;
          const header = NativeXHR.prototype.setRequestHeader;
          const getHeader = NativeXHR.prototype.getResponseHeader;
          const getAll = NativeXHR.prototype.getAllResponseHeaders;
          NativeXHR.prototype.open = function(method, url, ...rest) {
            this.__ft = { method: String(method), url: new URL(String(url), location.href).href, headers: [] };
            record({ op: 'xhr.open', method: this.__ft.method, url: this.__ft.url });
            for (const type of ['readystatechange','loadstart','progress','load','loadend','error','abort','timeout']) {
              this.addEventListener(type, event => record({ op: 'xhr.event', type, url: this.__ft?.url,
                readyState: this.readyState, status: this.status, loaded: event.loaded ?? null, total: event.total ?? null,
                responseLength: typeof this.responseText === 'string' ? this.responseText.length : null }));
            }
            return Reflect.apply(open, this, [method, url, ...rest]);
          };
          NativeXHR.prototype.setRequestHeader = function(name, value) {
            this.__ft?.headers.push([String(name).toLowerCase(), String(value).length]);
            return Reflect.apply(header, this, [name, value]);
          };
          NativeXHR.prototype.send = function(body) {
            record({ op: 'xhr.send', url: this.__ft?.url, bodyLength: typeof body === 'string' ? body.length : body?.byteLength ?? 0,
              headers: this.__ft?.headers || [] });
            return Reflect.apply(send, this, [body]);
          };
          NativeXHR.prototype.getResponseHeader = function(name) {
            const result = Reflect.apply(getHeader, this, [name]);
            record({ op: 'xhr.getResponseHeader', url: this.__ft?.url, name: String(name).toLowerCase(), valueLength: result?.length ?? null });
            return result;
          };
          NativeXHR.prototype.getAllResponseHeaders = function() {
            const result = Reflect.apply(getAll, this, []);
            record({ op: 'xhr.getAllResponseHeaders', url: this.__ft?.url, length: result.length });
            return result;
          };
        }

        addEventListener('message', event => record({ op: 'window.message', origin: event.origin, data: summarize(event.data) }), true);
        const nativePost = globalThis.postMessage;
        if (typeof nativePost === 'function') globalThis.postMessage = function(message, targetOrigin, transfer) {
          record({ op: 'window.postMessage', targetOrigin: String(targetOrigin || ''), data: summarize(message) });
          return Reflect.apply(nativePost, this, arguments);
        };
        const WorkerCtor = globalThis.Worker;
        if (typeof WorkerCtor === 'function') {
          const NativeWorker = WorkerCtor;
          globalThis.Worker = new Proxy(NativeWorker, {
            construct(target, args, newTarget) {
              const worker = Reflect.construct(target, args, newTarget);
              record({ op: 'worker.construct', url: String(args[0]) });
              worker.addEventListener('message', event => record({ op: 'worker.message', data: summarize(event.data) }));
              const post = worker.postMessage;
              worker.postMessage = function(message) {
                record({ op: 'worker.postMessage', data: summarize(message) });
                return Reflect.apply(post, this, arguments);
              };
              return worker;
            }
          });
        }
      }`,
    });
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 25000));
    const tree = await send('browsingContext.getTree', { root: context, maxDepth: 8 });
    const contexts = [];
    const visit = async (node, depth = 0) => {
      const evaluated = await send('script.evaluate', {
        target: { context: node.context }, awaitPromise: false, resultOwnership: 'none',
        expression: `JSON.stringify({href: location.href, log: (() => { try { return JSON.parse(sessionStorage.getItem('__firefoxTraceBoundaryLog') || '[]'); } catch (_) { return globalThis.__firefoxTraceBoundaryLog || []; } })()})`,
      }).catch(error => ({ error: String(error) }));
      contexts.push({ context: node.context, depth, url: node.url,
        observed: evaluated.error ? { error: evaluated.error } : JSON.parse(evaluated.result?.value || '{}') });
      for (const child of node.children || []) await visit(child, depth + 1);
    };
    for (const node of tree.contexts || []) await visit(node);
    const result = { schema: 'firefox_trace.cloudflare_boundary_probe.v1', captured_at: new Date().toISOString(), target_url: targetUrl, contexts };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, contexts: contexts.map(item => ({ url: item.url, entries: item.observed?.log?.length || 0 })) }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
