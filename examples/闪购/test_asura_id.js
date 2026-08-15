"use strict";

const assert = require("assert");
const { createAsuraId } = require("./asura_id");

async function main() {
  const values = [];
  for (let index = 0; index < 3; index += 1) {
    const value = await createAsuraId();
    assert(value.startsWith("140#"), "AsuraId must use the collina 1.140 format");
    assert(value.length > 900, `AsuraId is unexpectedly short: ${value.length}`);
    values.push(value);
  }
  assert.strictEqual(new Set(values).size, values.length, "AsuraId must be fresh for each run");
  console.log(`asura_id tests passed: ${values.map((value) => value.length).join(", ")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
