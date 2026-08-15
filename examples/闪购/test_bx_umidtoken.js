"use strict";

const assert = require("assert");
const { createLoginSecurityFields } = require("./asura_id");

const FIRE_UMID = `T2gA${"C".repeat(63)}=`;
const BX_UMID_TOKEN = `T2gA${"D".repeat(63)}=`;

async function mockFetch(url) {
  if (String(url).includes("/w/wu.json")) {
    return new Response(
      `try{umx.wu('${BX_UMID_TOKEN}');}catch(e){}` +
      `try{__fycb('${BX_UMID_TOKEN}');}catch(e){}`,
      { status: 200, headers: { "content-type": "text/javascript" } }
    );
  }
  return new Response(JSON.stringify({ tn: FIRE_UMID, id: BX_UMID_TOKEN }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

createLoginSecurityFields({ fetch: mockFetch })
  .then(({ fireUmid, bxUmidToken }) => {
    assert.strictEqual(fireUmid, FIRE_UMID);
    assert.strictEqual(bxUmidToken, BX_UMID_TOKEN);
    assert.notStrictEqual(fireUmid, bxUmidToken);
    console.log("bx-umidtoken tests passed: FireEye read the WebUMID lswucn token");
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
