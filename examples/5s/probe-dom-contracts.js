#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoint = process.argv[2] || 'ws://127.0.0.1:9222/session';
const targetUrl = process.argv[3] || 'https://simple.ripley.com.pe/';
const output = path.resolve(process.argv[4] || path.join(__dirname, 'runtime-data/browser-console-dom-contracts-20260817.json'));

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

  let userContext;
  try {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ userContext } = await send('browser.createUserContext'));
    const { context } = await send('browsingContext.create', { type: 'tab', userContext });
    await send('browsingContext.navigate', { context, url: targetUrl, wait: 'complete' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 2000));
    const expression = `(() => {
      const source = value => { try { return Function.prototype.toString.call(value); } catch (error) { return String(error); } };
      const prototypeRows = value => {
        const rows = [];
        for (let current = value, depth = 0; current && depth < 10; current = Object.getPrototypeOf(current), depth++) {
          rows.push({
            depth,
            constructor: current?.constructor?.name || null,
            tag: Object.prototype.toString.call(current),
            ownKeys: Reflect.ownKeys(current).map(String),
          });
        }
        return rows;
      };
      const findDescriptor = (value, name) => {
        let owner = value;
        let depth = 0;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) { owner = Object.getPrototypeOf(owner); depth++; }
        const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
        if (!descriptor) return null;
        return {
          depth,
          ownerConstructor: owner?.constructor?.name || null,
          ownerTag: Object.prototype.toString.call(owner),
          kind: 'value' in descriptor ? 'value' : 'accessor',
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          valueName: typeof descriptor.value === 'function' ? descriptor.value.name : null,
          valueLength: typeof descriptor.value === 'function' ? descriptor.value.length : null,
          valueSource: typeof descriptor.value === 'function' ? source(descriptor.value) : null,
          getName: descriptor.get?.name || null,
          getSource: descriptor.get ? source(descriptor.get) : null,
          setName: descriptor.set?.name || null,
          setSource: descriptor.set ? source(descriptor.set) : null,
        };
      };
      const describe = (value, members) => ({
        type: typeof value,
        tag: Object.prototype.toString.call(value),
        constructor: value?.constructor?.name || null,
        ownKeys: Reflect.ownKeys(value).map(String),
        instanceof: Object.fromEntries(['EventTarget','Node','Document','HTMLDocument','DocumentFragment','Element','HTMLElement','HTMLDivElement','HTMLIFrameElement','HTMLScriptElement','Window'].map(name => [name, typeof globalThis[name] === 'function' ? value instanceof globalThis[name] : null])),
        prototypes: prototypeRows(value),
        descriptors: Object.fromEntries(members.map(name => [name, findDescriptor(value, name)])),
      });
      const commonNode = ['nodeType','nodeName','parentNode','parentElement','childNodes','firstChild','firstElementChild','ownerDocument','textContent','isConnected','appendChild','insertBefore','removeChild','replaceChild','cloneNode','contains','compareDocumentPosition'];
      const elementMembers = [...commonNode,'tagName','localName','namespaceURI','children','attributes','id','className','classList','style','dataset','innerHTML','innerText','previousElementSibling','setAttribute','getAttribute','hasAttribute','removeAttribute','matches','closest','getBoundingClientRect','querySelector','querySelectorAll','getElementsByTagName','attachShadow','shadowRoot','remove'];
      const documentMembers = [...commonNode,'URL','documentURI','location','domain','referrer','characterSet','compatMode','readyState','visibilityState','hidden','title','cookie','currentScript','documentElement','head','body','scripts','forms','images','links','styleSheets','fonts','defaultView','createElement','createElementNS','createTextNode','createDocumentFragment','createNodeIterator','getElementById','getElementsByTagName','querySelector','querySelectorAll'];
      const div = document.createElement('div');
      const iframe = document.createElement('iframe');
      const script = document.createElement('script');
      const text = document.createTextNode('probe');
      const fragment = document.createDocumentFragment();
      return JSON.stringify({
        page: { href: location.href, userAgent: navigator.userAgent, buildID: navigator.buildID },
        constructors: Object.fromEntries(['EventTarget','Node','Document','HTMLDocument','DocumentFragment','Element','HTMLElement','HTMLDivElement','HTMLIFrameElement','HTMLScriptElement','Window'].map(name => [name, typeof globalThis[name] === 'function' ? { name: globalThis[name].name, length: globalThis[name].length, source: source(globalThis[name]), prototypeParent: Object.getPrototypeOf(globalThis[name].prototype)?.constructor?.name || null } : null])),
        window: describe(window, ['window','self','globalThis','top','parent','frames','document','location','navigator','innerWidth','innerHeight','screenX','screenY','devicePixelRatio','addEventListener','removeEventListener','dispatchEvent','postMessage']),
        document: describe(document, documentMembers),
        div: describe(div, elementMembers),
        iframe: describe(iframe, [...elementMembers,'contentWindow','contentDocument','sandbox','width','height','src']),
        script: describe(script, [...elementMembers,'src','async','defer','text','readyState','onload','onerror']),
        text: describe(text, commonNode),
        fragment: describe(fragment, [...commonNode,'children','querySelector','querySelectorAll','getElementById','append','prepend','replaceChildren']),
      });
    })()`;
    const observed = decode(await send('script.evaluate', { expression, target: { context }, awaitPromise: false, resultOwnership: 'none' }));
    const result = {
      schema: 'firefox_trace.browser_console_dom_contracts.v1',
      source: 'firefox-bidi-target-page',
      target_url: targetUrl,
      expression_sha256: crypto.createHash('sha256').update(expression).digest('hex'),
      captured_at: new Date().toISOString(),
      ...observed,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, page: result.page, chains: Object.fromEntries(['window','document','div','iframe','script','text','fragment'].map(name => [name, result[name].prototypes.map(row => row.constructor)])) }, null, 2));
  } finally {
    if (userContext) await send('browser.removeUserContext', { userContext }).catch(() => {});
    await send('session.end').catch(() => {});
    socket.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
