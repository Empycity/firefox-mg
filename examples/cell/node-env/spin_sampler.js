// Repeated pause-sample the harness to catch a synchronous spin's stack.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '15000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) throw new Error('no inspector');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); let pausedEv = null;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Debugger.paused') pausedEv = m.params;
  };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  await send('Debugger.setSkipAllPauses', { skip: false });
  await send('Runtime.runIfWaitingForDebugger');
  for (let s = 0; s < 8; s++) {
    await sleep(2200);
    pausedEv = null;
    await send('Debugger.pause', {});
    for (let w = 0; w < 20 && !pausedEv; w++) await sleep(100);
    if (pausedEv && pausedEv.callFrames) {
      const fr = pausedEv.callFrames.slice(0, 6).map(f => `${f.functionName || '(anon)'}@${(f.url || '').replace(/^.*\//, '')}:${f.location.lineNumber + 1}:${f.location.columnNumber}`);
      console.log(`SAMPLE#${s} [${pausedEv.reason}] ` + fr.join(' <- '));
    } else console.log(`SAMPLE#${s} no-pause (running freely)`);
    if (pausedEv) { try { await send('Debugger.resume', {}); } catch (_) {} }
  }
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
