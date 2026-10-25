// Final stepper: sample every b4 dispatch-table read after the perf-notify
// breakpoint, detect the terminal wait cycle, and decode each cursor in it
// (cN(idx) + caller locals) in the same run. Usage:
//   HARNESS_PINNED=1 node step_debug.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const HARNESS = path.join(HERE, 'harness.js');
const DBG_LINE = (() => {
  const src = fs.readFileSync(HARNESS, 'utf8');
  return src.slice(0, src.indexOf('step_debug.js breaks here')).split('\n').length - 1;
})();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', HARNESS], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: process.env.HARNESS_MS || '25000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  const errBuf = [];
  child.stderr.on('data', d => { const s = d.toString(); errBuf.push(s); const m = s.match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  child.stdout.on('data', d => process.stdout.write('[h] ' + d));
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.error('no inspector'); child.kill(); return; }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const events = [];
  const scripts = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) {
      if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || '');
      events.push(m);
    }
  };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const waitEvent = (method, timeoutMs) => new Promise(res => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const e = events.find(x => x.method === method && !x.__used);
      if (e) { e.__used = true; clearInterval(poll); res(e); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(poll); res(null); }
    }, 20);
  });

  await send('Debugger.enable');
  await send('Runtime.enable');
  await send('Runtime.runIfWaitingForDebugger');
  await sleep(300);

  // hunt for OUR notify breakpoint (resume CF anti-debug traps on the way)
  let notifyPause = null;
  const hunt0 = Date.now();
  while (Date.now() - hunt0 < 45000) {
    const ev = await waitEvent('Debugger.paused', 20000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.endsWith('harness.js') && fr.location.lineNumber === DBG_LINE) { notifyPause = ev; console.error('HIT notify bp'); break; }
    await send('Debugger.resume');
  }
  if (!notifyPause) { console.error('no notify bp; tail:\n' + errBuf.join('').slice(-2500)); child.kill(); return; }

  const orchSid = [...scripts.entries()].filter(([, u]) => (u || '').endsWith('orchestrate.js')).map(([sid]) => sid)[0];
  const bpr = await send('Debugger.setBreakpoint', { location: { scriptId: orchSid, lineNumber: 5, columnNumber: 73652 } });
  if (bpr.error) { console.error('bp fail', JSON.stringify(bpr.error)); child.kill(); return; }
  const BPID = bpr.result.breakpointId;
  await send('Debugger.resume');

  const evalOn = async (callFrameId, expression) => {
    try {
      const r = await send('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    } catch (_) { return undefined; }
  };
  const localsOf = async (frame) => {
    try {
      const scope = frame.scopeChain.find(s => s.type === 'local') || frame.scopeChain[0];
      const props = await send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true });
      return (props.result.result || []).slice(0, 15).map(p => ({
        n: p.name,
        v: p.value ? String(p.value.description != null ? p.value.description : (p.value.value != null ? p.value.value : p.value.type)).slice(0, 55) : '',
      }));
    } catch (_) { return []; }
  };

  const hits = [];
  const snapshots = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && hits.length < 4000) {
    const ev = await waitEvent('Debugger.paused', 4000);
    if (!ev) { console.error('VM idle'); break; }
    if (!(ev.params.hitBreakpoints || []).includes(BPID)) { await send('Debugger.resume'); continue; }
    const fr = ev.params.callFrames[0];
    const cur = await evalOn(fr.callFrameId, 'String($i)');
    hits.push(String(cur));
    if (hits.length % 40 === 1 || hits[hits.length-1] !== hits[hits.length-2]) {
      const up = ev.params.callFrames[1];
      let dec = '';
      try {
        const r2 = await send('Debugger.evaluateOnCallFrame', { callFrameId: up.callFrameId, returnByValue: true,
          expression: "JSON.stringify({expr: String(Z&&Z[cN(12)]&&Z[cN(12)][SV]&&Z[cN(12)][SV][cN(50)]&&Z[cN(12)][SV][cN(50)](Sz)), zIsWin: Z===window, zAKE: typeof Z[cN(1122)], zcoT: typeof Z[cN(1123)], zXnu: typeof Z[cN(1078)], cnmxz4: String(Z&&Z[cN(12)]&&Z[cN(12)][SV]).slice(0,60) })" });
        dec = String(r2.result.result.value).slice(0, 300);
      } catch (e) { dec = 'err:' + e.message; }
      const up2 = ev.params.callFrames[2];
      snapshots.push({ cursor: String(cur), decoded: String(dec).slice(0, 500),
        caller: `${up.functionName} @${up.location.lineNumber}:${up.location.columnNumber}`, locals: await localsOf(up),
        outer: up2 ? { where: `${up2.functionName} @${up2.location.lineNumber}:${up2.location.columnNumber}`, locals: await localsOf(up2) } : null });
    }
    await send('Debugger.resume');
  }
  fs.writeFileSync(path.join(HERE, 'b4-hits.json'), JSON.stringify(hits));
  fs.writeFileSync(path.join(HERE, 'snapshots.json'), JSON.stringify(snapshots, null, 1));

  // terminal cycle detection
  const tailN = Math.min(400, hits.length);
  const tail = hits.slice(-tailN).join(',');
  let unit = null;
  for (let len = 1; len <= 150; len++) {
    if (tailN < len * 3) break;
    const u = hits.slice(-len).join(',');
    if (tail.endsWith(u.repeat(Math.floor(tailN / len)))) { unit = hits.slice(-len); break; }
  }
  console.error('hits:', hits.length, 'terminal unit:', unit ? unit.join(' -> ') : 'none');
  if (unit) {
    const uniq = [...new Set(unit)];
    console.error('cycle cursors:', uniq.join(','));
    const matching = snapshots.filter(s => uniq.includes(s.cursor));
    for (const s of matching) {
      console.error(`SNAP cursor=${s.cursor} dec=${JSON.stringify(s.decoded)} caller=${s.caller}`);
      for (const l of s.locals.slice(0, 8)) console.error(`   ${l.n} = ${l.v}`);
    }
  }
  await send('Debugger.disable');
  child.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
