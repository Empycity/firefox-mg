// Break inside the VM's direct-eval phase script (evalmachine:1:337 region)
// and dump its source.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '12000', CNMX_FORCE: 'XnuWO5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); let pausedEv = null; const scripts = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || ''); else if (m.method === 'Debugger.paused') pausedEv = m.params; };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  // break at the phase script's Proxy call column region
  const bp = await send('Debugger.setBreakpointByUrl', { lineNumber: 0, columnNumber: 337, urlRegex: 'evalmachine' });
  console.log('bp:', JSON.stringify(bp.result || bp).slice(0, 160));
  await sleep(8000); // let the VM reach it (pump cycles)
  if (pausedEv && pausedEv.callFrames) {
    const cf = pausedEv.callFrames[0];
    console.log('PAUSED at', (cf.url || scripts.get(cf.location.scriptId)) + ':' + cf.location.columnNumber);
    const sc = await send('Debugger.getScriptSource', { scriptId: cf.location.scriptId });
    const code = (sc.result && sc.result.scriptSource) || '';
    console.log('=== PHASE SCRIPT ' + code.length + 'B ===');
    console.log(code.slice(0, 2600));
  } else console.log('no pause — phase script col~300 not hit');
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
