#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9225/session';
const output = path.resolve(process.argv[3] || path.join(__dirname, 'runtime-data/browser-pat-contracts.json'));
const targetUrl = process.argv[4] || 'https://simple.ripley.com.pe/?__agent_probe_sentinel__=1';

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
    message.error ? request.reject(new Error(JSON.stringify(message))) : request.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ userContext } = await send('browser.createUserContext'));
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 12000));
    const tree = await send('browsingContext.getTree', { root: context, maxDepth: 8 });
    const contexts = [];
    const visit = async (node, depth = 0) => {
      const expression = `JSON.stringify((() => {
        const safe = fn => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error: String(error) }; } };
        const descriptor = (target, name) => {
          let owner = target;
          while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
          const item = owner && Object.getOwnPropertyDescriptor(owner, name);
          return item ? { owner: owner.constructor?.name || null, kind: 'value' in item ? 'value' : 'accessor', enumerable: item.enumerable, configurable: item.configurable } : null;
        };
        const policy = document.permissionsPolicy || document.featurePolicy || null;
        const names = ['private-state-token-issuance','private-state-token-redemption','private-aggregation','publickey-credentials-get'];
        return {
          href: location.href,
          globals: Object.fromEntries(['PrivateToken','PrivateStateToken','PermissionsPolicy','FeaturePolicy','PublicKeyCredential'].map(name => [name, { type: typeof globalThis[name], descriptor: descriptor(globalThis, name) }])),
          windowValues: { crossOriginIsolated, originAgentCluster, isSecureContext },
          navigator: Object.fromEntries(['userAgentData','cookieEnabled','webdriver','platform','userAgent'].map(name => [name, { type: typeof navigator[name], value: ['string','number','boolean'].includes(typeof navigator[name]) ? navigator[name] : null, descriptor: descriptor(navigator, name) }])),
          documentPolicy: {
            selected: policy === document.permissionsPolicy ? 'permissionsPolicy' : policy === document.featurePolicy ? 'featurePolicy' : null,
            tag: policy ? Object.prototype.toString.call(policy) : null,
            descriptors: Object.fromEntries(['allowedFeatures','features','allowsFeature','getAllowlistForFeature'].map(name => [name, descriptor(policy, name)])),
            allowedFeatures: safe(() => policy?.allowedFeatures?.() || null),
            features: safe(() => policy?.features?.() || null),
            allows: Object.fromEntries(names.map(name => [name, safe(() => policy?.allowsFeature?.(name) ?? null)])),
            allowlists: Object.fromEntries(names.map(name => [name, safe(() => policy?.getAllowlistForFeature?.(name) || null)])),
          },
        };
      })())`;
      const result = await send('script.evaluate', { target: { context: node.context }, expression, awaitPromise: false, resultOwnership: 'none' }).catch(error => ({ error: String(error) }));
      contexts.push({ context: node.context, depth, url: node.url, result: result.error ? { error: result.error } : JSON.parse(result.result?.value || '{}') });
      for (const child of node.children || []) await visit(child, depth + 1);
    };
    for (const node of tree.contexts || []) await visit(node);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify({ captured_at: new Date().toISOString(), contexts }, null, 2)}\n`);
    console.log(JSON.stringify({ output, contexts: contexts.map(item => ({ url: item.url, result: item.result })) }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
