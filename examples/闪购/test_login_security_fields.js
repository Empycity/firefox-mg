"use strict";

const assert = require("assert");
const { createLoginSecurityFields } = require("./asura_id");

const TEST_TOKEN = `T2gA${"A".repeat(63)}=`;

async function mockFetch() {
  return new Response(JSON.stringify({ tn: TEST_TOKEN, id: TEST_TOKEN }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function main() {
  const fields = await createLoginSecurityFields({ fetch: mockFetch });
  assert(fields.asuraId.startsWith("140#"));
  assert(fields.fireUa.startsWith("140#"));
  assert.notStrictEqual(fields.asuraId, fields.fireUa);
  assert.strictEqual(fields.fireUmid, TEST_TOKEN);
  console.log(
    `login security field tests passed: ${fields.asuraId.length}/` +
    `${fields.fireUa.length}/${fields.fireUmid.length}`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
