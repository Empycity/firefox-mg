#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const output = path.resolve(process.argv[4] || path.join(__dirname, 'runtime-data/browser-console-target-probe-20260817.json'));

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

    const expression = `(async () => {
      const safe = async fn => {
        try { return { ok: true, value: await fn() }; }
        catch (error) { return { ok: false, error: { name: error?.name || 'Error', message: String(error?.message || error), string: String(error) } }; }
      };
      const descriptor = (target, name) => {
        let owner = target;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
        const value = owner && Object.getOwnPropertyDescriptor(owner, name);
        return value ? {
          owner: owner.constructor?.name || Object.prototype.toString.call(owner),
          kind: 'value' in value ? 'value' : 'accessor',
          writable: value.writable,
          enumerable: value.enumerable,
          configurable: value.configurable,
          getName: value.get?.name || null,
          setName: value.set?.name || null,
        } : null;
      };
      const describe = value => ({
        type: typeof value,
        tag: Object.prototype.toString.call(value),
        constructor: value?.constructor?.name || null,
        prototypeChain: (() => {
          const chain = [];
          for (let current = value, i = 0; current && i < 8; current = Object.getPrototypeOf(current), i++) {
            chain.push(current.constructor?.name || Object.prototype.toString.call(current));
          }
          return chain;
        })(),
      });

      const audio = await safe(async () => {
        const context = new OfflineAudioContext(1, 1000, 44100);
        const oscillator = context.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.value = 9998.1234559999994;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -52;
        compressor.knee.value = 40;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.0001;
        compressor.release.value = 0.25;
        oscillator.connect(compressor);
        compressor.connect(context.destination);
        oscillator.start(0);
        const rendered = await context.startRendering();
        const samples = rendered.getChannelData(0);
        const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map(value => value.toString(16).padStart(2, '0')).join('');
        let binary = '';
        for (const value of bytes) binary += String.fromCharCode(value);
        return {
          context: describe(context), rendered: describe(rendered),
          parameters: {
            channels: context.numberOfChannels, length: context.length, sampleRate: context.sampleRate,
            oscillatorType: oscillator.type, frequency: oscillator.frequency.value,
            threshold: compressor.threshold.value, knee: compressor.knee.value,
            ratio: compressor.ratio.value, attack: compressor.attack.value, release: compressor.release.value,
          },
          sampleLength: samples.length,
          first32: Array.from(samples.slice(0, 32)),
          middle32: Array.from(samples.slice(480, 512)),
          last32: Array.from(samples.slice(-32)),
          min: Math.min(...samples), max: Math.max(...samples), sha256: digest,
          samplesBase64: btoa(binary),
          descriptors: {
            startRendering: descriptor(context, 'startRendering'),
            getChannelData: descriptor(rendered, 'getChannelData'),
            frequencyValue: descriptor(oscillator.frequency, 'value'),
          },
        };
      });

      const rtc = await safe(async () => {
        const started = performance.now();
        const peer = new RTCPeerConnection({ iceServers: [] });
        const events = [];
        let firstCandidate = null;
        const channel = peer.createDataChannel('probe');
        peer.addEventListener('icecandidate', event => {
          const candidate = event.candidate;
          if (candidate && !firstCandidate) firstCandidate = candidate;
          events.push({
            deltaMs: performance.now() - started,
            event: describe(event), candidate: candidate ? describe(candidate) : null,
            candidateText: candidate?.candidate ?? null,
            address: candidate?.address ?? null, port: candidate?.port ?? null,
            protocol: candidate?.protocol ?? null, type: candidate?.type ?? null,
            component: candidate?.component ?? null, foundation: candidate?.foundation ?? null,
            priority: candidate?.priority ?? null, tcpType: candidate?.tcpType ?? null,
            sdpMid: candidate?.sdpMid ?? null, sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
          });
        });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 5000);
          peer.addEventListener('icegatheringstatechange', () => {
            if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
          });
        });
        const result = {
          peer: describe(peer), channel: describe(channel), offer: { type: offer.type, sdp: offer.sdp },
          localDescription: peer.localDescription && { type: peer.localDescription.type, sdp: peer.localDescription.sdp },
          states: { iceGatheringState: peer.iceGatheringState, connectionState: peer.connectionState, signalingState: peer.signalingState },
          events,
          descriptors: {
            createOffer: descriptor(peer, 'createOffer'), setLocalDescription: descriptor(peer, 'setLocalDescription'),
            candidate: firstCandidate ? descriptor(firstCandidate, 'candidate') : null,
          },
        };
        peer.close();
        return result;
      });

      const taskOrder = await safe(async () => {
        const order = [];
        const frame = document.createElement('iframe');
        frame.src = 'about:blank';
        const frameLoaded = new Promise(resolve => frame.addEventListener('load', () => { order.push('iframe.load'); resolve(); }, { once: true }));
        document.documentElement.appendChild(frame);
        queueMicrotask(() => order.push('parent.microtask'));
        setTimeout(() => order.push('parent.timeout'), 0);
        await frameLoaded;
        const realm = {
          windowSeparated: frame.contentWindow.Window !== Window,
          documentSeparated: frame.contentWindow.Document !== Document,
          promiseSeparated: frame.contentWindow.Promise !== Promise,
          arraySeparated: frame.contentWindow.Array !== Array,
          contentWindowDescriptor: descriptor(frame, 'contentWindow'),
          contentDocumentDescriptor: descriptor(frame, 'contentDocument'),
        };
        const workerSource = \`onmessage = event => { queueMicrotask(() => postMessage('worker.microtask')); postMessage('worker.sync'); setTimeout(() => postMessage('worker.timeout'), 0); };\`;
        const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
        const worker = new Worker(workerUrl);
        await new Promise(resolve => {
          worker.onmessage = event => {
            order.push(event.data);
            if (event.data === 'worker.timeout') resolve();
          };
          worker.postMessage('start');
        });
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        frame.remove();
        return { order, realm, worker: describe(worker) };
      });

      return JSON.stringify({
        page: { href: location.href, origin: location.origin, userAgent: navigator.userAgent, buildId: navigator.buildID || null },
        capturedAt: new Date().toISOString(), audio, rtc, taskOrder,
      });
    })()`;
    const observed = decode(await send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    }));
    const result = {
      schema: 'firefox_trace.browser_console_target_probe.v1',
      source: 'firefox-bidi-target-page',
      target_url: targetUrl,
      expression_sha256: sha256(expression),
      ...observed,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, audio: result.audio, rtcEventCount: result.rtc?.value?.events?.length, taskOrder: result.taskOrder }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
