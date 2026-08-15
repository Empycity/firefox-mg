"use strict";

const { createFireUmid } = require("./asura_id");

createFireUmid()
  .then((value) => process.stdout.write(`${value}\n`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
