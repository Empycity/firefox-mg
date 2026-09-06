#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const output = path.resolve(process.argv[4] || path.join(__dirname, 'runtime-data/browser-console-contracts-20260817.json'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decode(result) {
  const value = result?.result || result;
  if (value?.type !== 'string') throw new Error(`unexpected BiDi result: ${JSON.stringify(value)}`);
  return JSON.parse(value.value);
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
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const tree = await send('browsingContext.getTree', { root: context, maxDepth: 8 });
    const flattened = [];
    const visit = node => {
      flattened.push(node);
      for (const child of node.children || []) visit(child);
    };
    for (const root of tree.contexts || []) visit(root);
    const challengeContext = flattened.find(item => String(item.url || '').startsWith('https://challenges.cloudflare.com/'));
    const evaluationContext = challengeContext?.context || context;
    const expression = `(async () => {
      const safe = async fn => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: { name: error?.name, message: error?.message, string: String(error) } }; } };
      const scalar = value => {
        if (value === undefined) return { type: 'undefined' };
        if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return { type: typeof value, value };
        return describe(value);
      };
      const descriptor = (target, name) => {
        let owner = target;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
        const desc = owner && Object.getOwnPropertyDescriptor(owner, name);
        return desc ? { owner: owner.constructor?.name || Object.prototype.toString.call(owner), kind: 'value' in desc ? 'value' : 'accessor', writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable, getName: desc.get?.name || null, setName: desc.set?.name || null } : null;
      };
      const describe = value => ({
        type: typeof value,
        tag: Object.prototype.toString.call(value),
        constructor: value?.constructor?.name || null,
        prototypeChain: (() => { const out = []; for (let current = value, i = 0; current && i < 8; current = Object.getPrototypeOf(current), i++) out.push(current.constructor?.name || Object.prototype.toString.call(current)); return out; })(),
        ownKeys: value == null ? [] : Reflect.ownKeys(value).map(String).slice(0, 80),
        prototypeKeys: value == null ? [] : Reflect.ownKeys(Object.getPrototypeOf(value) || {}).map(String).slice(0, 120),
      });
      const members = async (value, names) => Object.fromEntries(await Promise.all(names.map(async name => [name, { value: await safe(() => scalar(value[name])), descriptor: descriptor(value, name) }])));

      const globals = {};
      for (const name of ['caches','cookieStore','customElements','scheduler','visualViewport','toolbar','statusbar','scrollbars','personalbar','menubar','locationbar','external','indexedDB']) {
        globals[name] = { value: scalar(window[name]), descriptor: descriptor(window, name) };
      }
      const bars = {};
      for (const name of ['toolbar','statusbar','scrollbars','personalbar','menubar','locationbar']) bars[name] = await members(window[name], ['visible']);
      const viewport = await members(visualViewport, ['offsetLeft','offsetTop','pageLeft','pageTop','width','height','scale','onresize','onscroll','onscrollend']);
      const notification = { permission: scalar(Notification.permission), descriptor: descriptor(Notification, 'permission') };

      const cache = await safe(async () => {
        const name = 'cf-contract-' + crypto.randomUUID();
        const opened = await caches.open(name);
        const keysBefore = await caches.keys();
        const req = new Request(location.origin + '/__contract_probe__');
        const response = new Response('probe', { headers: { 'content-type': 'text/plain' } });
        await opened.put(req, response);
        const match = await opened.match(req);
        const cacheKeys = await opened.keys();
        const deleted = await caches.delete(name);
        return { storage: describe(caches), opened: describe(opened), keysBefore, cacheKeys: cacheKeys.map(item => ({ url: item.url, method: item.method })), match: match && { object: describe(match), status: match.status, type: match.type, text: await match.text() }, deleted };
      });

      const customElementsProbe = await safe(async () => {
        const name = 'x-contract-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
        class ContractElement extends HTMLElement {}
        customElements.define(name, ContractElement);
        const when = await customElements.whenDefined(name);
        const element = document.createElement(name);
        return { registry: describe(customElements), getMatches: customElements.get(name) === ContractElement, whenMatches: when === ContractElement, element: describe(element), name };
      });

      const performanceProbe = await safe(async () => {
        const all = performance.getEntries();
        const resources = performance.getEntriesByType('resource');
        const navigation = performance.getEntriesByType('navigation');
        const picked = resources.slice(-3).map(entry => ({ object: describe(entry), json: entry.toJSON(), members: Object.fromEntries(['name','entryType','startTime','duration','initiatorType','nextHopProtocol','workerStart','redirectStart','redirectEnd','fetchStart','domainLookupStart','domainLookupEnd','connectStart','secureConnectionStart','connectEnd','requestStart','responseStart','responseEnd','transferSize','encodedBodySize','decodedBodySize','responseStatus','contentType','serverTiming'].map(name => [name, scalar(entry[name])])) }));
        return { performance: describe(performance), allCount: all.length, resourceCount: resources.length, navigation: navigation.map(entry => entry.toJSON()), resources: picked, descriptors: { getEntries: descriptor(performance, 'getEntries'), getEntriesByType: descriptor(performance, 'getEntriesByType') } };
      });

      const gpuProbe = await safe(async () => {
        const gpu = navigator.gpu;
        const adapter = gpu && await gpu.requestAdapter();
        return {
          gpu: scalar(gpu),
          adapter: scalar(adapter),
          info: adapter ? { object: scalar(adapter.info), values: Object.fromEntries(['vendor','architecture','device','description','subgroupMinSize','subgroupMaxSize','isFallbackAdapter'].map(name => [name, scalar(adapter.info[name])])) } : null,
          features: adapter ? { object: scalar(adapter.features), values: Array.from(adapter.features) } : null,
          limits: adapter ? { object: scalar(adapter.limits), values: Object.fromEntries(['maxTextureDimension1D','maxTextureDimension2D','maxTextureDimension3D','maxTextureArrayLayers','maxBindGroups','maxBindGroupsPlusVertexBuffers','maxBindingsPerBindGroup','maxBufferSize','maxComputeInvocationsPerWorkgroup'].map(name => [name, scalar(adapter.limits[name])])) } : null,
          descriptors: {
            navigatorGpu: descriptor(navigator, 'gpu'),
            requestAdapter: gpu && descriptor(gpu, 'requestAdapter'),
            adapterInfo: adapter && descriptor(adapter, 'info'),
            adapterFeatures: adapter && descriptor(adapter, 'features'),
            adapterLimits: adapter && descriptor(adapter, 'limits'),
          },
        };
      });

      const speechProbe = await safe(async () => ({
        object: scalar(speechSynthesis),
        voices: speechSynthesis.getVoices().map(voice => ({ object: scalar(voice), name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default, voiceURI: voice.voiceURI })),
        descriptors: { getVoices: descriptor(speechSynthesis, 'getVoices'), speaking: descriptor(speechSynthesis, 'speaking'), pending: descriptor(speechSynthesis, 'pending'), paused: descriptor(speechSynthesis, 'paused') },
      }));

      const shadow = await safe(async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>.x{color:red}</style><div class="x"><span id="needle">ok</span></div>';
        const needle = root.querySelector('#needle');
        const result = { host: describe(host), root: describe(root), mode: root.mode, hostMatches: root.host === host, query: describe(needle), text: needle.textContent, descriptors: { attachShadow: descriptor(host, 'attachShadow'), shadowRoot: descriptor(host, 'shadowRoot'), querySelector: descriptor(root, 'querySelector'), mode: descriptor(root, 'mode') } };
        host.remove();
        return result;
      });

      const rtc = await safe(async () => {
        const peer = new RTCPeerConnection({ iceServers: [] });
        const channel = peer.createDataChannel('contract', { ordered: false, maxRetransmits: 2, protocol: 'probe' });
        const result = { peer: describe(peer), channel: describe(channel), values: Object.fromEntries(['label','ordered','maxPacketLifeTime','maxRetransmits','protocol','negotiated','id','readyState','bufferedAmount','bufferedAmountLowThreshold','binaryType'].map(name => [name, scalar(channel[name])])), descriptors: Object.fromEntries(['send','close','label','ordered','readyState','binaryType'].map(name => [name, descriptor(channel, name)])) };
        channel.close(); peer.close(); return result;
      });

      const message = await safe(async () => {
        const event = new MessageEvent('message', { data: { probe: 1 }, origin: location.origin, source: window, lastEventId: '42', ports: [] });
        return { object: describe(event), values: Object.fromEntries(['type','data','origin','lastEventId','source','ports','isTrusted','bubbles','cancelable','composed'].map(name => [name, scalar(event[name])])), descriptors: Object.fromEntries(['data','origin','source','lastEventId','ports'].map(name => [name, descriptor(event, name)])) };
      });

      const broadcast = await safe(async () => {
        const name = 'contract-' + crypto.randomUUID();
        const first = new BroadcastChannel(name); const second = new BroadcastChannel(name);
        const received = new Promise(resolve => { second.onmessage = event => resolve({ event: describe(event), data: event.data, origin: event.origin, source: scalar(event.source), isTrusted: event.isTrusted }); });
        first.postMessage({ probe: 1 });
        const delivery = await Promise.race([received, new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000))]);
        const result = { first: describe(first), values: await members(first, ['name','onmessage','onmessageerror']), delivery, descriptors: { postMessage: descriptor(first, 'postMessage'), close: descriptor(first, 'close'), name: descriptor(first, 'name') } };
        first.close(); second.close(); return result;
      });

      const worker = await safe(async () => {
        const source = \`postMessage(JSON.stringify({self:({type:typeof self,tag:Object.prototype.toString.call(self),constructor:self.constructor?.name,proto:(()=>{const o=[];for(let c=self,i=0;c&&i<6;c=Object.getPrototypeOf(c),i++)o.push(c.constructor?.name||Object.prototype.toString.call(c));return o})()}),navigator:({type:typeof navigator,tag:Object.prototype.toString.call(navigator),constructor:navigator.constructor?.name,proto:(()=>{const o=[];for(let c=navigator,i=0;c&&i<6;c=Object.getPrototypeOf(c),i++)o.push(c.constructor?.name||Object.prototype.toString.call(c));return o})(),values:Object.fromEntries(['userAgent','platform','language','languages','hardwareConcurrency','deviceMemory','maxTouchPoints','webdriver','onLine','cookieEnabled','pdfViewerEnabled','product','productSub','vendor','vendorSub','buildID','appCodeName','appName','appVersion','oscpu'].map(k=>[k,navigator[k]])),keys:Reflect.ownKeys(navigator).map(String)}),globals:Object.fromEntries(['location','performance','crypto','caches','indexedDB','scheduler'].map(k=>[k,{type:typeof self[k],tag:Object.prototype.toString.call(self[k]),constructor:self[k]?.constructor?.name||null}]))}))\`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const instance = new Worker(url);
        const data = await new Promise((resolve, reject) => { instance.onmessage = event => resolve(JSON.parse(event.data)); instance.onerror = reject; });
        instance.terminate(); URL.revokeObjectURL(url); return { worker: describe(instance), data };
      });

      return JSON.stringify({ page: { href: location.href, origin: location.origin, userAgent: navigator.userAgent, buildID: navigator.buildID }, capturedAt: new Date().toISOString(), globals, bars, viewport, notification, cache, customElements: customElementsProbe, performance: performanceProbe, gpu: gpuProbe, speech: speechProbe, shadow, rtc, message, broadcast, worker });
    })()`;
    const observed = decode(await send('script.evaluate', { expression, target: { context: evaluationContext }, awaitPromise: true, resultOwnership: 'none' }));
    const result = { schema: 'firefox_trace.browser_console_contracts.v1', source: 'firefox-bidi-target-page', target_url: targetUrl, browsing_context: { context: evaluationContext, url: challengeContext?.url || targetUrl, challenge_frame: !!challengeContext }, expression_sha256: sha256(expression), ...observed };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, globals: result.globals, notification: result.notification, cache: result.cache?.ok, performance: result.performance?.ok, shadow: result.shadow?.ok, rtc: result.rtc?.ok, broadcast: result.broadcast?.ok, worker: result.worker?.ok }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
