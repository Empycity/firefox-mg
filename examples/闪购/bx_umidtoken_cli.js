"use strict";

const { createBxUmidToken } = require("./asura_id");

createBxUmidToken()
  .then((value) => process.stdout.write(`${value}\n`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
