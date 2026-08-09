#!/usr/bin/env node

const endpoint = process.env.FIREFOX_BIDI_ENDPOINT || "ws://127.0.0.1:9224/session";

function createClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") request.reject(new Error(`${message.error}: ${message.message}`));
    else request.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
  });
  return {
    async command(method, params = {}) {
      await ready;
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { socket.close(); },
  };
}

const client = createClient(endpoint);
try {
  await client.command("session.new", { capabilities: {} });
  const tree = await client.command("browsingContext.getTree", {});
  const pages = tree.contexts.map(({ context, url, children = [] }) => ({ context, url, children: children.length }));
  console.log(JSON.stringify({ endpoint, pages }, null, 2));
} finally {
  try {
    await client.command("session.end");
  } catch {
    // The browser can close the transport before replying to session.end.
  }
  client.close();
}
