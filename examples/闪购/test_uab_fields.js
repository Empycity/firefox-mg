"use strict";

const assert = require("assert");
const { createUabFields } = require("./asura_id");

async function main() {
  const first = await createUabFields();
  const second = await createUabFields();
  for (const fields of [first, second]) {
    assert(fields.asuraId.startsWith("140#"));
    assert(fields.fireUa.startsWith("140#"));
    assert(fields.asuraId.length > 900);
    assert(fields.fireUa.length > 900);
    assert.notStrictEqual(fields.asuraId, fields.fireUa);
  }
  assert.notStrictEqual(first.asuraId, second.asuraId);
  assert.notStrictEqual(first.fireUa, second.fireUa);
  console.log(
    `uab field tests passed: ${first.asuraId.length}/${first.fireUa.length}, ` +
    `${second.asuraId.length}/${second.fireUa.length}`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
