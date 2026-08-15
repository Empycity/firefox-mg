"use strict";

const assert = require("assert");
const crypto = require("crypto");
const {
  encodeJSEncryptText,
  encryptLoginCredentials,
  encryptLoginValue,
  extractLoginPublicKey,
  inspectPublicKey,
} = require("./login_crypto");

const TRACE_PUBLIC_KEY =
  "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKWQQS7eBVKpswIdfgw5uoon05qiWskvrPxMBd0JwulIywcZv3Ve8PO6j00tspgveKqG+w1CWVoXzfyxohxUI4ECAwEAAQ==";

function decodePkcs1Block(privateKey, ciphertext) {
  const block = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
    ciphertext,
  );

  assert.strictEqual(block[0], 0x00);
  assert.strictEqual(block[1], 0x02);
  const separator = block.indexOf(0x00, 2);
  assert(separator >= 10, "PKCS#1 padding must contain at least eight bytes");
  for (const byte of block.subarray(2, separator)) {
    assert.notStrictEqual(byte, 0x00);
  }
  return block.subarray(separator + 1);
}

function run() {
  const keyInfo = inspectPublicKey(TRACE_PUBLIC_KEY);
  assert.strictEqual(keyInfo.modulusBits, 512);
  assert.strictEqual(keyInfo.modulusBytes, 64);
  assert.strictEqual(keyInfo.maxMessageBytes, 53);

  const first = encryptLoginValue("USERNAME", TRACE_PUBLIC_KEY);
  const second = encryptLoginValue("USERNAME", TRACE_PUBLIC_KEY);
  assert.strictEqual(Buffer.from(first, "base64").length, 64);
  assert.strictEqual(first.length, 88);
  assert.notStrictEqual(first, second, "PKCS#1 v1.5 encryption must use fresh padding");

  const extracted = extractLoginPublicKey({
    result: { publicKey: TRACE_PUBLIC_KEY },
  });
  assert.strictEqual(extracted, TRACE_PUBLIC_KEY);

  const credentials = encryptLoginCredentials({
    username: "USERNAME",
    password: "PASSWORD",
    publicKey: extracted,
  });
  assert.strictEqual(credentials.username.length, 88);
  assert.strictEqual(credentials.password.length, 88);
  assert.deepStrictEqual(credentials.extraInfo, {
    encrypted: true,
    encryptUserName: true,
    identifierVersion: "1.0.0",
  });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicExponent: 0x10001,
  });
  const localPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const plaintext = "test-\u7528\u6237";
  const encrypted = Buffer.from(encryptLoginValue(plaintext, localPublicKey), "base64");
  const recovered = decodePkcs1Block(privateKey, encrypted);
  assert.deepStrictEqual(recovered, encodeJSEncryptText(plaintext));

  assert.throws(
    () => encryptLoginValue("x".repeat(54), TRACE_PUBLIC_KEY),
    /maximum is 53/,
  );

  console.log("login crypto tests passed");
}

run();

