"use strict";

const { createLoginSecurityFields } = require("./asura_id");

createLoginSecurityFields()
  .then((fields) => process.stdout.write(JSON.stringify(fields)))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
