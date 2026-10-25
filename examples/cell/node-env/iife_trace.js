// Trace the orchestrate IIFE's eval-time execution path: break at the IIFE
// head, then stepInto and record every frame location until the trace dies.
// Usage: HARNESS_PINNED=1 node iife_trace.js [maxSteps]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const MAXSTEPS = parseInt(process.argv[2] || '6000', 10);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', path.join(HERE, 'harness.js')], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const scripts = new Map();
  const events = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) { if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || ''); events.push(m); } };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const waitEvent = (method, timeoutMs) => new Promise(res => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const e = events.find(x => x.method === method && !x.__used);
      if (e) { e.__used = true; clearInterval(poll); res(e); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(poll); res(null); }
    }, 10);
  });
  await send('Debugger.enable');
  await send('Runtime.enable');
  await send('Runtime.runIfWaitingForDebugger');
  await sleep(600);
  // pause at the harness orchestrate-eval line
  const hsrc = fs.readFileSync(path.join(HERE, 'harness.js'), 'utf8');
  const evalLine = hsrc.slice(0, hsrc.indexOf('vm.runInContext(prelude + scriptSrc')).split('\n').length;
  await send('Debugger.setBreakpointByUrl', { urlRegex: 'harness\\.js', lineNumber: evalLine - 1, columnNumber: 0 });
  await send('Debugger.resume');
  let hitEval = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && !hitEval) {
    const ev = await waitEvent('Debugger.paused', 10000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.endsWith('harness.js') && fr.location.lineNumber === evalLine - 1) { hitEval = true; break; }
    await send('Debugger.resume');
  }
  console.error('at eval pause:', hitEval);
  if (!hitEval) { child.kill(); return; }
  // set the IIFE-head bp (VM line 5 col 1982 = 1-based -> CDP 4:1982), then release
  const bp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'orchestrate\\.js', lineNumber: 4, columnNumber: 9375 });
  console.error('iife bp:', JSON.stringify(bp.result && bp.result.locations || bp.result || bp.error).slice(0, 120));
  await send('Debugger.resume');
  let hitIife = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 25000 && !hitIife) {
    const ev = await waitEvent('Debugger.paused', 10000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.includes('orchestrate') && fr.location.lineNumber === 4) { hitIife = true; break; }
    await send('Debugger.resume');
  }
  console.error('at IIFE head:', hitIife);
  if (!hitIife) { child.kill(); return; }
  // step through and record; when the top frame leaves the orchestrate
  // (harness internals: proxy traps, realm creation), stepOut back into it.
  let currentMode = 'Debugger.stepOver';
  const out = fs.createWriteStream(path.join(HERE, 'iife-trace.log'));
  let steps = 0;
  while (steps < MAXSTEPS) {
    const cf0 = (await (async () => { const e2 = await waitEvent('Debugger.paused', 1); return e2; })()) || null;
    // determine current top frame from the last pause
    const last = steps === 0 ? { url: 'orchestrate.js' } : null;
    currentMode = 'Debugger.stepInto';
    await send(currentMode);
    const ev = await waitEvent('Debugger.paused', 8000);
    if (!ev) { console.error('trace died at step', steps); break; }
    let cf = ev.params.callFrames[0];
    let u = (cf.url || scripts.get(cf.location.scriptId) || '').replace(/^.*\//, '');
    if (!u.includes('orchestrate') && ev.params.callFrames.length > 1) {
      // stepOut up to 12 times to return to an orchestrate frame
      for (let k = 0; k < 12 && !u.includes('orchestrate'); k++) {
        await send('Debugger.stepOut');
        const ev2 = await waitEvent('Debugger.paused', 8000);
        if (!ev2) break;
        cf = ev2.params.callFrames[0];
        u = (cf.url || scripts.get(cf.location.scriptId) || '').replace(/^.*\//, '');
      }
    }
    const line = `${steps} ${cf.functionName || '(anon)'} @${u}:${cf.location.lineNumber + 1}:${cf.location.columnNumber}`;
    out.write(line + '\n');
    if (steps % 200 === 0) console.error(`step ${steps}: ${line}`);
    steps++;
  }
  out.end();
  console.error('trace done, steps:', steps);
  await send('Debugger.setSkipAllPauses', { skip: true });
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
