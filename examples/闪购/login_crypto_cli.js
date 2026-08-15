"use strict";

const {
  encryptLoginCredentials,
  encryptLoginValue,
  inspectPublicKey,
} = require("./login_crypto");

function main() {
  const input = JSON.parse(process.argv[2] || "{}");
  const keyInfo = inspectPublicKey(input.publicKey);

  if (Object.prototype.hasOwnProperty.call(input, "value")) {
    process.stdout.write(
      JSON.stringify({
        encrypted: encryptLoginValue(input.value, input.publicKey),
        modulusBits: keyInfo.modulusBits,
        maxMessageBytes: keyInfo.maxMessageBytes,
      }),
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      ...encryptLoginCredentials(input),
      modulusBits: keyInfo.modulusBits,
      maxMessageBytes: keyInfo.maxMessageBytes,
    }),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}

