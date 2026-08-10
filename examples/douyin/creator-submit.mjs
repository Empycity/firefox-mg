#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(process.argv[2] || resolve(here, "creator-live-contract.json"));
const contract = JSON.parse(await readFile(contractPath, "utf8"));

const generated = spawnSync(process.execPath, [resolve(here, "bdms-runner.js"), "--config", contractPath], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (generated.status !== 0) {
  process.stderr.write(generated.stderr || generated.stdout);
  process.exit(generated.status || 1);
}
const vmResult = JSON.parse(generated.stdout);
const send = [...(vmResult.xhr || [])].reverse().find((entry) =>
  entry.phase === "send" && entry.url?.includes("/web/api/media/aweme/create_v2/")
);
const signature = send?.url ? new URL(send.url).searchParams.get("a_bogus") : "";
if (!signature) throw new Error("Local VM did not generate a_bogus");

const replay = spawnSync(process.execPath, [
  resolve(here, "firefox-page-replay.mjs"),
  contractPath,
  "--a-bogus",
  signature,
], {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 4 * 1024 * 1024,
});
let response;
try { response = JSON.parse(replay.stdout); } catch {
  process.stderr.write(replay.stderr || replay.stdout);
  process.exit(replay.status || 1);
}

const result = {
  contract: contractPath,
  request: {
    method: contract.request.method,
    endpoint: new URL(contract.request.unsigned_url).pathname,
    body_bytes: Buffer.byteLength(JSON.stringify(contract.request.body)),
    uri: contract.live_capture?.uri,
    creation_id: contract.live_capture?.creation_id,
  },
  local_generation: {
    a_bogus_length: signature.length,
    random_calls: vmResult.replay?.dynamic_usage?.math_random?.calls,
    time_calls: vmResult.replay?.dynamic_usage?.date_now_or_no_arg_date?.calls,
  },
  response,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = replay.status || (response.accepted ? 0 : 2);
