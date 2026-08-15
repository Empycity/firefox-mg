"use strict";

const assert = require("assert");
const { createAsuraEnvironment } = require("./asura_env");
const { createLoginSecurityFields } = require("./asura_id");

const FIRE_UMID = `T2gA${"E".repeat(63)}=`;
const BX_UMID_TOKEN = `T2gA${"F".repeat(63)}=`;

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

function assertFingerprintFixtures() {
  const environment = createAsuraEnvironment();
  const canvas = environment.document.createElement("canvas");
  const webgl = canvas.getContext("webgl");

  assert(canvas.toDataURL().startsWith("data:image/png;base64,"));
  assert(canvas.toDataURL().length > 10000);
  assert.strictEqual(webgl.getSupportedExtensions().length, 27);
  assert.deepStrictEqual(Array.from(webgl.getParameter(33902)), [1, 1]);
  assert.deepStrictEqual(Array.from(webgl.getParameter(33901)), [1, 64]);
  assert.deepStrictEqual(Array.from(webgl.getParameter(3386)), [16384, 16384]);
}

async function main() {
  assertFingerprintFixtures();
  const first = await createLoginSecurityFields({ fetch: mockFetch });
  const second = await createLoginSecurityFields({ fetch: mockFetch });
  for (const fields of [first, second]) {
    assert(fields.bxUa.startsWith("231!"));
    assert(fields.bxUa.length > 1000);
  }
  assert.notStrictEqual(first.bxUa, second.bxUa);
  console.log(`bx-ua tests passed: ${first.bxUa.length}/${second.bxUa.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
