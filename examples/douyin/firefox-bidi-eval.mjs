#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [source] = process.argv.slice(2);
if (!source) throw new Error("Usage: node examples/douyin/firefox-bidi-eval.mjs expression.js");

const endpoint = process.env.FIREFOX_BIDI_ENDPOINT || "ws://127.0.0.1:9224/session";
const pagePrefix = process.env.FIREFOX_PAGE_PREFIX || "https://www.douyin.com/";
const expression = await readFile(source, "utf8");

function clientFor(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === "error") waiter.reject(new Error(`${message.error}: ${message.message}`));
    else waiter.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
  });
  return {
    async command(method, params = {}) {
      await opened;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close: () => socket.close(),
  };
}

const client = clientFor(endpoint);
try {
  await client.command("session.new", { capabilities: {} });
  const { contexts } = await client.command("browsingContext.getTree", {});
  const page = contexts.find(({ url }) => url.startsWith(pagePrefix));
  if (!page) throw new Error(`Page starting with ${pagePrefix} is not open in the remote Firefox profile`);
  const result = await client.command("script.evaluate", {
    expression,
    target: { context: page.context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (result.type === "exception") throw new Error(result.exceptionDetails.text);
  const value = result.result?.value;
  console.log(typeof value === "string" ? value : JSON.stringify(result, null, 2));
} finally {
  try { await client.command("session.end"); } catch {}
  client.close();
}
