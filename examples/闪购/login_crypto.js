"use strict";

const crypto = require("crypto");

function publicKeyToPem(publicKeyBase64) {
  const compact = String(publicKeyBase64 || "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

  if (!compact) {
    throw new TypeError("publicKey is required");
  }

  const lines = compact.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

// Matches the UTF-8 conversion used by the page's bundled JSEncrypt build.
function encodeJSEncryptText(value) {
  const text = String(value);
  const bytes = [];

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push((code >> 6) | 0xc0, (code & 0x3f) | 0x80);
    } else {
      bytes.push(
        (code >> 12) | 0xe0,
        ((code >> 6) & 0x3f) | 0x80,
        (code & 0x3f) | 0x80,
      );
    }
  }

  return Buffer.from(bytes);
}

function inspectPublicKey(publicKeyBase64) {
  const pem = publicKeyToPem(publicKeyBase64);
  const key = crypto.createPublicKey(pem);
  const modulusBits = key.asymmetricKeyDetails?.modulusLength;

  if (!modulusBits) {
    throw new Error("RSA modulus length is unavailable");
  }

  const modulusBytes = Math.ceil(modulusBits / 8);
  return {
    key,
    modulusBits,
    modulusBytes,
    maxMessageBytes: modulusBytes - 11,
    pem,
  };
}

function encryptLoginValue(value, publicKeyBase64) {
  const message = encodeJSEncryptText(value);
  const keyInfo = inspectPublicKey(publicKeyBase64);

  if (message.length > keyInfo.maxMessageBytes) {
    throw new RangeError(
      `login value is ${message.length} bytes; maximum is ${keyInfo.maxMessageBytes}`,
    );
  }

  return crypto
    .publicEncrypt(
      {
        key: keyInfo.key,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      message,
    )
    .toString("base64");
}

function extractLoginPublicKey(loginConfigResponse) {
  const publicKey = loginConfigResponse?.result?.publicKey;
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new TypeError("loginConfigResponse.result.publicKey is required");
  }
  return publicKey;
}

function encryptLoginCredentials({ username, password, publicKey }) {
  return {
    username: encryptLoginValue(username, publicKey),
    password: encryptLoginValue(password, publicKey),
    extraInfo: {
      encrypted: true,
      encryptUserName: true,
      identifierVersion: "1.0.0",
    },
  };
}

module.exports = {
  encodeJSEncryptText,
  encryptLoginCredentials,
  encryptLoginValue,
  extractLoginPublicKey,
  inspectPublicKey,
  publicKeyToPem,
};

