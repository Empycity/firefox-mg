// Pre-set a breakpoint on the fav0 payload entry (scriptParsed-time), start
// the CPU profiler, resume, then stop and print hot functions.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '12000' },
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
  await send('Profiler.enable');
  // Break at the harness line that evals the fav0 payload inline code.
  // Harness.js line: vm.runInContext(inline, entry.ctx, { filename: 'fav0-payload.js' })
  const r1 = await send('Debugger.setBreakpointByUrl', { lineNumber: 164, urlRegex: 'harness\\.js' }); // 0-based; adjusted below if needed
  console.log('bp harness eval line:', JSON.stringify(r1.result || r1).slice(0, 200));
  await send('Runtime.runIfWaitingForDebugger');
  await sleep(300);
  for (let w = 0; w < 300 && !pausedEv; w++) await sleep(100);
  if (!pausedEv) { console.log('never paused at harness line; kill'); child.kill('SIGKILL'); process.exit(1); }
  console.log('paused at harness fav0-eval line ✓');
  {
    const cf0 = pausedEv.callFrames[0];
    const ev = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf0.callFrameId, expression: "JSON.stringify({inlineLen: typeof inline !== 'undefined' ? inline.length : 'no-var', head: typeof inline !== 'undefined' ? String(inline).slice(0, 80) : '', entryIdx: typeof entry !== 'undefined' && entry.element ? iframeRealms.length : '?'})", returnByValue: true });
    console.log('INLINE STATE:', JSON.stringify(ev.result && ev.result.result && ev.result.result.value).slice(0, 300));
  }
  // Now set an entry breakpoint on the payload script itself (compiled when eval runs).
  // Step INTO the eval call to land in the payload (or see where it goes).
  for (let s = 0; s < 6; s++) {
    await send('Debugger.stepInto', {});
    pausedEv = null;
    for (let w = 0; w < 15 && !pausedEv; w++) await sleep(100);
    if (!pausedEv) { console.log('stepInto no-pause at step', s); break; }
    const fr = pausedEv.callFrames.slice(0, 3).map(f => `${f.functionName || '(anon)'}@${(f.url || '').replace(/^.*\//, '')}:${f.location.lineNumber + 1}:${f.location.columnNumber}`);
    console.log(`STEP#${s} [${pausedEv.reason}] ` + fr.join(' <- '));
    if ((pausedEv.callFrames[0].url || '').includes('fav0')) break;
  }
  await send('Profiler.setSamplingInterval', { interval: 500 });
  await send('Profiler.start', {});
  await send('Debugger.setSkipAllPauses', { skip: true });
  await send('Debugger.resume', {});
  await sleep(8000); // let it spin under the profiler
  const prof = await send('Profiler.stop', {});
  const profNodes = (((prof.result || {}).profile || {}).nodes) || [];
  const deltas = new Map();
  const samples = (((prof.result || {}).profile || {}).samples) || [];
  const byId = new Map(profNodes.map(n => [n.id, n]));
  for (const sid of samples) deltas.set(sid, (deltas.get(sid) || 0) + 1);
  const hot = [...deltas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [id, n] of hot) {
    const node = byId.get(id) || {};
    const cf = (node.callFrame || {});
    console.log(`HOT ${n}x ${cf.functionName || '(anon)'} @ ${(cf.url || '').replace(/^.*\//, '')}:${cf.lineNumber + 1}:${cf.columnNumber}`);
  }
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
