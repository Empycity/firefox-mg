"use strict";

const { createBxUa } = require("./asura_id");

createBxUa()
  .then((value) => process.stdout.write(`${value}\n`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
