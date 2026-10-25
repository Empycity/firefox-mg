// Break precisely at the VM's direct-eval phase script col~337 (the
// new Proxy(apply) site): wait for scriptParsed of a NEW evalmachine script
// AFTER the main boot, set the breakpoint on its scriptId, resume.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '15000', CNMX_FORCE: 'XnuWO5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); let pausedEv = null; const parsed = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Debugger.scriptParsed') parsed.push(m.params);
    else if (m.method === 'Debugger.paused') pausedEv = m.params;
  };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  // Watch for a phase script being parsed that contains 'new Proxy' near col 337
  const t0 = Date.now();
  let target = null;
  while (Date.now() - t0 < 30000 && !target) {
    for (const p of parsed) {
      if (p.__checked) continue;
      p.__checked = 1;
      if ((p.url || '').includes('evalmachine')) {
        const sc = await send('Debugger.getScriptSource', { scriptId: p.scriptId });
        const code = (sc.result && sc.result.scriptSource) || '';
        console.log('EVALMACHINE parsed id=' + p.scriptId + ' len=' + code.length + ' head=' + JSON.stringify(code.slice(0, 60)));
      }
    }
    if (!target) await sleep(50);
  }
  if (!target) { console.log('no phase script with new Proxy found in 30s'); child.kill('SIGKILL'); process.exit(1); }
  // now break at its Proxy construction
  const bp = await send('Debugger.setBreakpoint', { location: { scriptId: target.scriptId, lineNumber: 0, columnNumber: target.col } });
  console.log('bp set:', JSON.stringify(bp.result || bp).slice(0, 200));
  pausedEv = null;
  for (let w = 0; w < 300 && !pausedEv; w++) await sleep(100);
  if (!pausedEv) { console.log('bp never hit'); child.kill('SIGKILL'); process.exit(1); }
  const cf = pausedEv.callFrames[0];
  console.log('HIT at col', cf.location.columnNumber);
  // dump the phase script source fully
  const sc2 = await send('Debugger.getScriptSource', { scriptId: target.scriptId });
  const code = (sc2.result && sc2.result.scriptSource) || '';
  console.log('=== PHASE SCRIPT FULL (' + code.length + 'B) ===');
  console.log(code);
  // dump caller frames and the object pool
  for (const f of pausedEv.callFrames.slice(0, 3)) {
    console.log(`frame ${f.functionName || '(anon)'} col=${f.location.columnNumber}`);
  }
  const ev = async (expression) => {
    const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : '-';
  };
  console.log('POOL:', String(await ev(`(function(){try{const p=HH&&HH.h&&HH.h[4];if(!p)return 'no-pool';const out=[];for(let i=0;i<p.length&&i<30;i++){const v=p[i];out.push(i+':'+((v===undefined)?'UNDEF':(v===null)?'null':(typeof v==='function')?('fn:'+String(v).slice(0,40)):((typeof v==='object')?('o:'+(v.constructor?v.constructor.name:'?')):String(v).slice(0,30))))}return out.join(' | ')}catch(e){return 'E:'+e.message}})()`) ).slice(0, 1200));
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
