// Two-probe hunt for the upstream gate that blocks the orchestrate VM's
// bridge-definition branch (FINDINGS 终稿九):
//   probe A: at b4@5:73652 hits with cursor 856/857, dump the caller frame's
//            full locals and try every function-valued local as decoder.
//   probe B: breakpoint the VM state machine i@5:31741 and dump its locals.
// Usage: HARNESS_PINNED=1 node probe_gate.js
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', HARNESS], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: '22000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = ''; const errBuf = [];
  child.stderr.on('data', d => { const s = d.toString(); errBuf.push(s); const m = s.match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  child.stdout.on('data', d => process.stdout.write('[h] ' + d));
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const events = []; const scripts = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) { if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || ''); events.push(m); } };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const waitEvent = (method, timeoutMs) => new Promise(res => { const t0 = Date.now(); const poll = setInterval(() => { const e = events.find(x => x.method === method && !x.__used); if (e) { e.__used = true; clearInterval(poll); res(e); } else if (Date.now() - t0 > timeoutMs) { clearInterval(poll); res(null); } }, 20); });

  await send('Debugger.enable'); await send('Runtime.enable');
  await send('Runtime.runIfWaitingForDebugger'); await sleep(300);
  let notify = null; const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const ev = await waitEvent('Debugger.paused', 20000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.endsWith('harness.js') && fr.location.lineNumber === DBG_LINE) { notify = ev; break; }
    await send('Debugger.resume');
  }
  if (!notify) { console.error('no notify bp'); child.kill(); return; }
  const orchSid = [...scripts.entries()].filter(([, u]) => (u || '').endsWith('orchestrate.js')).map(([sid]) => sid)[0];
  const bp1 = await send('Debugger.setBreakpoint', { location: { scriptId: orchSid, lineNumber: 5, columnNumber: 73652 } });
  const bp2 = await send('Debugger.setBreakpoint', { location: { scriptId: orchSid, lineNumber: 5, columnNumber: 31741 } });
  console.error('bps:', JSON.stringify([bp1.result && bp1.result.breakpointId, bp2.result && bp2.result.breakpointId]));
  await send('Debugger.resume');

  const evalOn = async (cf, expr) => { try { const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf, expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; } catch (_) { return undefined; } };
  const fullLocals = async (frame) => {
    try {
      const scope = frame.scopeChain.find(s => s.type === 'local') || frame.scopeChain[0];
      const props = await send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true });
      return (props.result.result || []).map(p => ({ n: p.name, desc: p.value ? String(p.value.description != null ? p.value.description : (p.value.value != null ? p.value.value : p.value.type)).slice(0, 70) : '', oid: p.value && p.value.objectId ? p.value.objectId : null }));
    } catch (_) { return []; }
  };

  const probeA = []; const probeB = [];
  const run0 = Date.now();
  while (Date.now() - run0 < 20000) {
    const ev = await waitEvent('Debugger.paused', 4000);
    if (!ev) { console.error('idle'); break; }
    const bps = (ev.params.hitBreakpoints || []);
    const fr = ev.params.callFrames[0];
    if (bps.includes(bp2.result.breakpointId) && probeB.length < 6) {
      probeB.push({ where: `${fr.functionName} @${fr.location.lineNumber}:${fr.location.columnNumber}`, locals: await fullLocals(fr) });
    } else if (bps.includes(bp1.result.breakpointId)) {
      const cur = await evalOn(fr.callFrameId, 'String($i)');
      if (cur === '856' || cur === '857') {
        const up = ev.params.callFrames[1];
        const locals = await fullLocals(up);
        // try every function-valued local as decoder for this cursor
        const tries = [];
        for (const l of locals) {
          if (/^function /.test(l.desc) && !/Object|Array/.test(l.desc)) {
            const v = await evalOn(up.callFrameId, `String(typeof ${l.n}==='function'?${l.n}(${cur}):'?')`);
            if (v !== undefined && v !== '?' && String(v) !== 'undefined') tries.push({ via: l.n, decoded: String(v).slice(0, 60) });
          }
        }
        probeA.push({ cursor: cur, caller: `${up.functionName} @${up.location.lineNumber}:${up.location.columnNumber}`, locals: locals.slice(0, 20), tries });
        if (probeA.length >= 4) { /* enough */ }
      }
    }
    await send('Debugger.resume');
  }
  fs.writeFileSync(path.join(HERE, 'probe-gate.json'), JSON.stringify({ probeA, probeB }, null, 1));
  console.error('probeA:', probeA.length, 'probeB:', probeB.length);
  for (const a of probeA.slice(0, 2)) {
    console.error('A cursor=' + a.cursor, a.caller, JSON.stringify(a.tries));
    for (const l of a.locals.slice(0, 10)) console.error('  ', l.n, '=', l.desc.slice(0, 50));
  }
  for (const b of probeB.slice(0, 2)) {
    console.error('B', b.where);
    for (const l of b.locals.slice(0, 10)) console.error('  ', l.n, '=', l.desc.slice(0, 50));
  }
  await send('Debugger.disable');
  child.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
