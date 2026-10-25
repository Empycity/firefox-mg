// Probe the XOR decoder the VM eval'd (AwUcP3 factory in page-eval.js):
// break inside its returned function, dump the key s, the input k bytes and
// the decoded output for each call.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', path.join(HERE, 'harness.js')], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: '40000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const events = []; const scripts = new Map();
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
  await send('Debugger.enable'); await send('Runtime.enable'); await send('Runtime.runIfWaitingForDebugger');
  await sleep(700);
  // set bp on page-eval.js when it compiles (urlRegex future-apply)
  const bp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'page-eval\\.js', lineNumber: 0, columnNumber: 36 }); // inside the for loop
  console.error('xor bp:', JSON.stringify(bp.result && bp.result.locations || bp.result.breakpointId || bp.error).slice(0, 140));
  await send('Debugger.resume');
  const out = fs.createWriteStream(path.join(HERE, 'xor-trace.log'));
  let hits = 0, resumes = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && hits < 60) {
    const ev = await waitEvent('Debugger.paused', 20000);
    if (!ev) break;
    const p = ev.params;
    if (!(p.hitBreakpoints || []).includes(bp.result.breakpointId)) { resumes++; if (resumes < 20000) await send('Debugger.resume'); continue; }
    const fr = p.callFrames[0];
    const evalOn = async (expr) => {
      try { const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: fr.callFrameId, expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; } catch (_) { return undefined; }
    };
    const s = String(await evalOn('String(s)'));
    const kLen = await evalOn('k&&k.length');
    const kHead = await evalOn('Array.from(k.slice(0,24)).join(",")');
    const oHead = await evalOn('typeof o!=="undefined"?Array.from(o.slice(0,24)).join(","):"-"');
    const kStr = await evalOn('String.fromCharCode.apply(null, Array.from(k.slice(0,40)))');
    out.write(`#${hits} key=${JSON.stringify(s.slice(0, 40))} kLen=${kLen} kHead=[${kHead}] oHead=[${oHead}] kStr=${JSON.stringify(String(kStr).slice(0, 40))}\n`);
    hits++;
    await send('Debugger.resume');
  }
  out.end();
  console.error(`xor hits=${hits} resumes=${resumes}`);
  try { await send('Debugger.setSkipAllPauses', { skip: true }); } catch (_) {}
  await sleep(1500);
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
