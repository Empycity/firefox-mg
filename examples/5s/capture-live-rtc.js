#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const output = path.resolve(process.argv[4] || path.join(__dirname, 'runtime-data/browser-console-live-rtc-20260817.json'));

function decode(result) {
  const value = result?.result || result;
  return value?.type === 'string' ? JSON.parse(value.value) : null;
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
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ userContext } = await send('browser.createUserContext'));
    await send('script.addPreloadScript', {
      userContexts: [userContext],
      functionDeclaration: `() => {
        globalThis.__firefoxTraceRtcProbe = [];
        const Native = globalThis.RTCPeerConnection;
        if (typeof Native !== 'function') return;
        const snapshot = value => {
          try { return JSON.parse(JSON.stringify(value)); }
          catch (error) { return { error: String(error) }; }
        };
        const Wrapped = new Proxy(Native, {
          construct(target, args, newTarget) {
            const started = performance.now();
            const peer = Reflect.construct(target, args, target);
            globalThis.__firefoxTraceRtcProbe.push({ op: 'construct', deltaMs: 0, args: snapshot(args) });
            peer.addEventListener('icecandidate', event => {
              const candidate = event.candidate;
              globalThis.__firefoxTraceRtcProbe.push({
                op: 'icecandidate', deltaMs: performance.now() - started,
                candidate: candidate?.candidate ?? null,
                sdpMid: candidate?.sdpMid ?? null, sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
                address: candidate?.address ?? null, port: candidate?.port ?? null,
                protocol: candidate?.protocol ?? null, type: candidate?.type ?? null,
                component: candidate?.component ?? null, foundation: candidate?.foundation ?? null,
                priority: candidate?.priority ?? null, tcpType: candidate?.tcpType ?? null,
              });
            });
            return peer;
          },
        });
        Object.defineProperty(globalThis, 'RTCPeerConnection', {
          value: Wrapped, writable: true, enumerable: false, configurable: true,
        });
      }`,
    });
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 12000));
    const tree = await send('browsingContext.getTree', { root: context, maxDepth: 8 });
    const rows = [];
    const visit = async (node, depth = 0) => {
      const result = await send('script.evaluate', {
        target: { context: node.context }, awaitPromise: false, resultOwnership: 'none',
        expression: `JSON.stringify({ href: location.href, log: globalThis.__firefoxTraceRtcProbe || [] })`,
      }).catch(error => ({ error: String(error) }));
      rows.push({ context: node.context, depth, url: node.url, observed: result.error ? { error: result.error } : decode(result) });
      for (const child of node.children || []) await visit(child, depth + 1);
    };
    for (const node of tree.contexts || []) await visit(node);
    const result = { schema: 'firefox_trace.browser_console_live_rtc.v1', captured_at: new Date().toISOString(), target_url: targetUrl, contexts: rows };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, contexts: rows.map(row => ({ url: row.url, entries: row.observed?.log?.length || 0 })) }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
