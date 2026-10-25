// Start CPU profiling immediately after resume; catch the synchronous spin's hot functions.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '12000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start', {});

  await sleep(9000);
  const prof = await send('Profiler.stop', {});
  const profile = (prof.result || {}).profile || {};
  const byId = new Map((profile.nodes || []).map(n => [n.id, n]));
  const deltas = new Map();
  for (const sid of (profile.samples || [])) deltas.set(sid, (deltas.get(sid) || 0) + 1);
  const parent = new Map();
  for (const n of profile.nodes || []) for (const c of (n.children || [])) parent.set(c, n.id);
  const fmt = (id) => { const cf = ((byId.get(id) || {}).callFrame) || {}; return `${cf.functionName || '(anon)'}@${(cf.url || '').replace(/^.*\//, '')}:${(cf.lineNumber || 0) + 1}:${cf.columnNumber}`; };
  const hot = [...deltas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [id, n] of hot) {
    const chain = [];
    let cur = id, d = 0;
    while (cur && d < 8) { chain.push(fmt(cur)); cur = parent.get(cur); d++; }
    console.log(`HOT ${n}x ` + chain.join(' <- '));
  }
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
