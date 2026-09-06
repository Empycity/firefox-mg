'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const configPath = process.argv[2];
if (!configPath) {
  console.error('usage: node run_feilin005.js DEVICE_CONFIG.json');
  process.exit(2);
}

function decryptInitResponse(init) {
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    Buffer.from('87f879f135f27da7'),
    Buffer.from('0123456789ABCDEF')
  );
  const plain = Buffer.concat([
    decipher.update(Buffer.from(init.DeviceConfig, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const chunks = plain.split('#');
  return {
    key: Buffer.from(chunks[0], 'base64').toString('utf8'),
    switch: Number(Buffer.from(chunks[1] || 'MQ==', 'base64').toString('utf8') || 1),
    sessionId: String(chunks[2] || '').replace(/^WEB#/, ''),
    version: chunks[3] || '',
    pluginElements: chunks[4] || '',
    pluginResource: chunks[5] || '',
    globalVariable: chunks[6] || '',
    timestamp: chunks[7] || '',
    ip: chunks[8] || '',
    certifyId: init.CertifyId || '',
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function resolveFeilinScript(config) {
  const localScript = path.join(__dirname, 'feilin.js');
  const expected = String(config.version || '').match(/\.([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  if (!expected || (fs.existsSync(localScript) && sha256(localScript) === expected)) {
    return localScript;
  }

  const cacheDir = path.join(__dirname, 'cache');
  const cacheFile = path.join(cacheDir, `${expected}.js`);
  if (fs.existsSync(cacheFile) && sha256(cacheFile) === expected) {
    return cacheFile;
  }

  const url = `https://g.alicdn.com/captcha-frontend/FeiLin/${config.version}.js`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FeiLin download failed: HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new Error(`FeiLin sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, body);
  return cacheFile;
}

async function main() {
const inputText = configPath === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(path.resolve(configPath), 'utf8');
const input = JSON.parse(inputText);
const config = input.DeviceConfig ? decryptInitResponse(input) : input;
const scriptPath = await resolveFeilinScript(config);
const env = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH ||
    '/Users/empycity/Desktop/pythonProject/node_modules',
  FEILIN_SCRIPT_PATH: scriptPath,
};
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, 'env.js'), JSON.stringify(config)],
  { encoding: 'utf8', env }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status === null ? 1 : result.status);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
