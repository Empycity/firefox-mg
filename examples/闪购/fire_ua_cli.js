"use strict";

const { createFireUa } = require("./asura_id");

createFireUa()
  .then((value) => process.stdout.write(`${value}\n`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
