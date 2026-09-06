#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const output = path.resolve(process.argv[4] || path.join(__dirname, 'runtime-data/browser-console-error-stack-20260818.json'));
const profile = process.argv[5] || '';

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
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    const initialTree = await send('browsingContext.getTree', { maxDepth: 8 });
    const initialContexts = [];
    const visitInitial = item => {
      initialContexts.push(item);
      for (const child of item.children || []) visitInitial(child);
    };
    for (const item of initialTree.contexts || []) visitInitial(item);
    const page = initialContexts.find(item => String(item.url || '').startsWith(targetUrl));
    if (!page) throw new Error(`target page is not open in the current Firefox session: ${targetUrl}`);
    const context = page.context;
    const tree = await send('browsingContext.getTree', { root: context, maxDepth: 8 });
    const contexts = [];
    const visit = item => {
      contexts.push(item);
      for (const child of item.children || []) visit(child);
    };
    for (const item of tree.contexts || []) visit(item);
    const challenge = contexts.find(item => String(item.url || '').startsWith('https://challenges.cloudflare.com/'));

    const expression = `(() => {
      const descriptor = (target, name) => {
        let owner = target;
        let depth = 0;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) {
          owner = Object.getPrototypeOf(owner);
          depth++;
        }
        const value = owner && Object.getOwnPropertyDescriptor(owner, name);
        return value ? {
          depth,
          owner: owner?.constructor?.name || null,
          kind: 'value' in value ? 'value' : 'accessor',
          writable: value.writable,
          enumerable: value.enumerable,
          configurable: value.configurable,
          getName: value.get?.name || null,
        } : null;
      };
      const first = () => new Error('probe');
      const second = () => first();
      const error = second();
      return JSON.stringify({
        page: {
          href: location.href,
          title: document.title,
          htmlLength: document.documentElement?.outerHTML?.length || 0,
          challengeMarkers: ['_cf_chl_opt', '/cdn-cgi/challenge-platform/', 'Just a moment', 'Enable JavaScript and cookies to continue']
            .filter(marker => document.documentElement?.outerHTML?.includes(marker)),
          userAgent: navigator.userAgent,
          buildID: navigator.buildID || null,
        },
        error: {
          string: String(error),
          stack: error.stack,
          tag: Object.prototype.toString.call(error),
          constructor: error.constructor?.name || null,
          prototypeChain: (() => {
            const out = [];
            for (let current = error, depth = 0; current && depth < 6; current = Object.getPrototypeOf(current), depth++) {
              out.push(current.constructor?.name || null);
            }
            return out;
          })(),
          stackDescriptor: descriptor(error, 'stack'),
        },
        constructor: {
          prepareStackTraceDescriptor: Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace') || null,
          source: Function.prototype.toString.call(Error),
          firstSource: Function.prototype.toString.call(first),
        },
      });
    })()`;
    const evaluate = async target => decode(await send('script.evaluate', {
      expression,
      target: { context: target },
      awaitPromise: false,
      resultOwnership: 'none',
    }));

    const observed = {
      main: await evaluate(context),
      challenge: challenge ? await evaluate(challenge.context) : null,
    };
    const cookieResult = await send('storage.getCookies', {}).catch(error => ({ error: String(error.message || error) }));
    const cookies = (cookieResult.cookies || []).filter(cookie => {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      return domain === 'simple.ripley.com.pe' || domain === 'ripley.com.pe';
    });
    const result = {
      schema: 'firefox_trace.browser_console_error_stack.v1',
      source: 'firefox-console-observed',
      target_url: targetUrl,
      captured_at: new Date().toISOString(),
      profile,
      expression_sha256: crypto.createHash('sha256').update(expression).digest('hex'),
      browsing_contexts: contexts.map(item => ({ context: item.context, url: item.url })),
      observed,
      cookies,
      cookie_error: cookieResult.error || null,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      output,
      main: result.observed.main.error.stack,
      challenge: result.observed.challenge?.error?.stack || null,
      page: result.observed.main.page,
      cookies: result.cookies.map(cookie => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expiry: cookie.expiry,
      })),
    }, null, 2));
  } finally {
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
