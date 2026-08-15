"use strict";

const assert = require("assert");
const { createLoginSecurityFields } = require("./asura_id");

const TEST_TOKEN = `T2gA${"A".repeat(63)}=`;
const TEST_UID_TOKEN = `T2gA${"B".repeat(63)}=`;

async function mockFetch(url) {
  if (String(url).includes("/w/wu.json")) {
    return new Response(
      `try{umx.wu('${TEST_UID_TOKEN}');}catch(e){}` +
      `try{__fycb('${TEST_UID_TOKEN}');}catch(e){}`,
      { status: 200, headers: { "content-type": "text/javascript" } }
    );
  }
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
  assert.strictEqual(fields.bxUmidToken, TEST_UID_TOKEN);
  assert.notStrictEqual(fields.bxUmidToken, fields.fireUmid);
  assert(fields.bxUa.startsWith("231!"));
  assert(fields.bxUa.length > 1000);
  assert(fields.configBxUa.startsWith("231!"));
  assert.notStrictEqual(fields.configBxUa, fields.bxUa);
  console.log(
    `login security field tests passed: ${fields.asuraId.length}/` +
    `${fields.fireUa.length}/${fields.fireUmid.length}/${fields.bxUmidToken.length}/` +
    `${fields.bxUa.length}`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
