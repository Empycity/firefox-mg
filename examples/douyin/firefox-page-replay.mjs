#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractPath = resolve(process.argv[2] || fileURLToPath(new URL("./runtime-contract.json", import.meta.url)));
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const endpoint = process.env.FIREFOX_BIDI_ENDPOINT || "ws://127.0.0.1:9224/session";
const signatureFlag = process.argv.indexOf("--a-bogus");
const suppliedSignature = signatureFlag >= 0 ? process.argv[signatureFlag + 1] : "";
if (signatureFlag >= 0 && !suppliedSignature) throw new Error("--a-bogus requires a value");

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
    close: () => socket.close(),
  };
}

const unsignedUrl = contract.request.unsigned_url;
const config = contract.init;
const headers = contract.request.headers;
const expression = `
(async () => {
  const url = new URL(${JSON.stringify(unsignedUrl)});
  const headers = ${JSON.stringify(headers)};
  const initConfig = ${JSON.stringify(config)};
  const suppliedSignature = ${JSON.stringify(suppliedSignature)};
  if (suppliedSignature) url.searchParams.set("a_bogus", suppliedSignature);
  else await window.bdms.init(initConfig);
  const outcome = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url.href, true);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.timeout = 30000;
    xhr.onload = () => resolve({ status: xhr.status, responseURL: xhr.responseURL, body: xhr.responseText });
    xhr.onerror = () => resolve({ status: xhr.status, responseURL: xhr.responseURL, error: "network_error" });
    xhr.ontimeout = () => resolve({ status: xhr.status, responseURL: xhr.responseURL, error: "timeout" });
    xhr.send(null);
  });
  let parsed = null;
  try { parsed = JSON.parse(outcome.body || ""); } catch {}
  const final = new URL(outcome.responseURL || url.href);
  const signature = final.searchParams.get("a_bogus") || "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
  const signatureHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const suppliedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedSignature));
  const suppliedHash = [...new Uint8Array(suppliedDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({
    http_status: outcome.status,
    network_error: outcome.error || null,
    a_bogus_length: signature.length,
    a_bogus_sha256: signatureHash,
    supplied_a_bogus_sha256: suppliedSignature ? suppliedHash : null,
    supplied_a_bogus_preserved: suppliedSignature ? signature === suppliedSignature : null,
    a_bogus_is_fresh: Boolean(signature),
    json_status_code: parsed?.status_code ?? null,
    comments: Array.isArray(parsed?.comments) ? parsed.comments.length : 0,
    response_bytes: (outcome.body || "").length,
  });
})()`;

const client = createClient(endpoint);
try {
  await client.command("session.new", { capabilities: {} });
  const { contexts } = await client.command("browsingContext.getTree", {});
  const page = contexts.find(({ url }) => url.startsWith("https://www.douyin.com/"));
  if (!page) throw new Error("Douyin page is not open in the remote Firefox profile");
  const result = await client.command("script.evaluate", {
    expression,
    target: { context: page.context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (result.type === "exception") throw new Error(result.exceptionDetails.text);
  const output = JSON.parse(result.result.value);
  output.contract = contractPath;
  output.accepted = output.http_status === 200 && output.json_status_code === 0 && output.comments > 0 &&
    (output.supplied_a_bogus_preserved ?? true);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.accepted ? 0 : 2;
} finally {
  try { await client.command("session.end"); } catch {}
  client.close();
}
