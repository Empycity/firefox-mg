// Break inside tz (task machine) via setBreakpointOnText-ish URL+line/col,
// sample locals 3 times to see if the loop state evolves.
'use strict';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn(process.execPath, ['--inspect=0', 'harness.js', 'orchestrate-live.js'], {
    cwd: __dirname, env: { ...process.env, HARNESS_PINNED: '1', HARNESS_MS: '20000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); let pausedEv = null;
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Debugger.paused') pausedEv = m.params; };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  await sleep(6000); // let it reach the compute phase
  // tz@5:66413 (profiler hot). 0-based: line 4? V8 lineNumber is 0-based -> line5 = 4.
  const bp = await send('Debugger.setBreakpointByUrl', { lineNumber: 4, columnNumber: 36023, urlRegex: 'orchestrate' });
  console.log('bp:', JSON.stringify(bp.result || bp).slice(0, 200));
  for (let s = 0; s < 3; s++) {
    pausedEv = null;
    for (let w = 0; w < 60 && !pausedEv; w++) await sleep(100);
    if (!pausedEv) { console.log('sample', s, 'no pause'); break; }
    // step OUT to run's dispatch line, then record the opcode-column trail
    await send('Debugger.stepOut', {});
    pausedEv = null;
    for (let w = 0; w < 30 && !pausedEv; w++) await sleep(50);
    if (pausedEv && s === 0) {
      const trail = [];
      for (let d = 0; d < 30; d++) {
        const c0 = pausedEv.callFrames[0];
        let st = '';
        try {
          const ev4 = await send('Debugger.evaluateOnCallFrame', { callFrameId: c0.callFrameId, expression: "(function(){try{const s=[];for(let i=0;i<Hv.length&&i<6;i++){const v=Hv[i];s.push((v&&typeof v==='object')?(Array.isArray(v)?('A'+v.length+':'+JSON.stringify(v.slice(0,10)).slice(0,180)):('o:'+Object.keys(v).slice(0,6).join('/'))):String(v).slice(0,20))}return 'STACK='+s.join(' || ')}catch(e){return 'E:'+e.message}})()", returnByValue: true });
          st = String(ev4.result && ev4.result.result && ev4.result.result.value || '?');
        } catch (_) {}
        trail.push(`${c0.location.columnNumber}{${st}}`);
        await send('Debugger.stepOver', {});
        pausedEv = null;
        for (let w = 0; w < 20 && !pausedEv; w++) await sleep(50);
        if (!pausedEv) break;
      }
      console.log('TRAIL: ' + trail.join(' > '));
      break;
    }
    const cf = pausedEv.callFrames[0];
    console.log(`SAMPLE${s} fn=${cf.functionName}@${(cf.url || '').slice(-30)}:${cf.location.lineNumber + 1}:${cf.location.columnNumber}`);
    if (cf.functionName === 'run') {
      // list locals via scope chain
      for (const sc of (cf.scopeChain || []).slice(0, 2)) {
        const props = await send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true, generatePreview: false });
        const names = ((props.result && props.result.result) || []).map(p => `${p.name}=${String((p.value && (p.value.value !== undefined ? p.value.value : p.value.description)) || '?').slice(0, 24)}`);
        if (sc.type === 'local') {
          console.log('  Hh/Hv/HU: ' + names.filter(n2 => /^(Hh|Hn|HO|Hp|Hv|HU|HT|HB)=/.test(n2)).join(', '));
          const ev3 = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: "(function(){const out={};try{out.Hv=JSON.stringify(Hv)}catch(_){};try{out.pc=[HB[HY],HB[Hp]]}catch(_){};try{out.len=Hv[HO]}catch(_){};return JSON.stringify(out)})()", returnByValue: true });
          console.log('  TASKS: ' + String(ev3.result && ev3.result.result && ev3.result.result.value).slice(0, 900));
        } else console.log('  SCOPE[' + sc.type + ']: ' + names.slice(0, 12).join(', '));
      }
    }
    const ev = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: "(function(){function d(o,dep){if(!o||dep>2)return String(o).slice(0,40);const out={};for(const k of Object.keys(o).slice(0,14)){const v=o[k];out[k]=(v&&typeof v==='object')?('['+(v.length!==undefined?('len'+v.length):typeof v)+']'):String(v).slice(0,30)}return JSON.stringify(out)}const args=[];for(const n of ['Hp','HH','Hf','HU']){try{const v=eval(n);args.push(n+'='+d(v,2))}catch(e){args.push(n+'=err')}}return args.join(' | ')})()", returnByValue: true });
    console.log('  locals:', String(ev.result && ev.result.result && ev.result.result.value || JSON.stringify(ev.result || {})).slice(0, 500));
    await sleep(300);
    const ev2 = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: "(function(){return JSON.stringify({dateNow2: Date.now(), perfNow2: (typeof performance!=='undefined'&&performance.now)?performance.now():'?'})})()", returnByValue: true });
    console.log('  +300ms:', String(ev2.result && ev2.result.result && ev2.result.result.value).slice(0, 200));
    await send('Debugger.resume', {});
  }
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
