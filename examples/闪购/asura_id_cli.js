"use strict";

const { createAsuraId } = require("./asura_id");

createAsuraId({ debugMissing: process.env.ASURA_DEBUG_MISSING === "1" })
  .then((value) => process.stdout.write(`${value}\n`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
