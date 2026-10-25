// Trace ONE run of the line-3 state machine (entry 6:17963): stepOver through
// its switch sequence, recording each case position + the cursor locals.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', path.join(HERE, 'harness.js')], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: '30000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const scripts = new Map(); const events = [];
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
  await send('Debugger.enable'); await send('Runtime.enable');
  await send('Runtime.runIfWaitingForDebugger');
  await sleep(600);
  const hsrc = fs.readFileSync(path.join(HERE, 'harness.js'), 'utf8');
  const evalLine = hsrc.slice(0, hsrc.indexOf('vm.runInContext(prelude + scriptSrc')).split('\n').length;
  await send('Debugger.setBreakpointByUrl', { urlRegex: 'harness\\.js', lineNumber: evalLine - 1, columnNumber: 0 });
  await send('Debugger.resume');
  let hitEval = false; const t0 = Date.now();
  while (Date.now() - t0 < 25000 && !hitEval) {
    const ev = await waitEvent('Debugger.paused', 10000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.endsWith('harness.js')) { hitEval = true; break; }
    await send('Debugger.resume');
  }
  if (!hitEval) { console.error('no eval pause'); child.kill(); return; }
  // bp the machine entry (VM line 6 col 17963 -> CDP 5:17963)
  const bp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'orchestrate\\.js', lineNumber: 5, columnNumber: 15805 });
  console.error('machine bp:', JSON.stringify(bp.result && bp.result.locations || []).slice(0, 140));
  await send('Debugger.resume');
  let hit = false; const t1 = Date.now();
  while (Date.now() - t1 < 25000 && !hit) {
    const ev = await waitEvent('Debugger.paused', 10000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.includes('orchestrate') && ev.params.hitBreakpoints && ev.params.hitBreakpoints.length) { hit = true; break; }
    await send('Debugger.resume');
  }
  console.error('at machine entry:', hit);
  if (!hit) { child.kill(); return; }
  const evalOn = async (expr) => {
    try { const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: (await lastPause()).params.callFrames[0].callFrameId, expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; } catch (_) { return undefined; }
  };
  let lastP = null;
  const lastPause = async () => lastP;
  const out = fs.createWriteStream(path.join(HERE, 'machine-trace.log'));
  for (let s = 0; s < 80; s++) {
    const ev = lastP = await waitEvent('Debugger.paused', 8000);
    if (!ev) break;
    const cf = ev.params.callFrames[0];
    const u = (cf.url || scripts.get(cf.location.scriptId) || '').replace(/^.*\//, '');
    const locals = [];
    const sc = cf.scopeChain && cf.scopeChain.find(x => x.type === 'local');
    if (sc && sc.object.objectId) {
      try { const pr = await send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true });
        for (const p of (pr.result.result || []).slice(0, 12)) locals.push(p.name + '=' + String(p.value && (p.value.description != null ? p.value.description : p.value.value)).slice(0, 30));
      } catch (_) {}
    }
    out.write(`${s} ${cf.functionName || '(anon)'} @${u}:${cf.location.lineNumber + 1}:${cf.location.columnNumber} | ${locals.join(' ')}\n`);
    await send('Debugger.stepOver');
  }
  out.end();
  console.error('machine trace done');
  await send('Debugger.setSkipAllPauses', { skip: true });
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
