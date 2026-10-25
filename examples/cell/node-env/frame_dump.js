// Pause-on-exceptions CDP tool: stop at the fav0 payload's "not a function"
// TypeError and dump the real objects/prototype chain from the call frame.
// Usage: HARNESS_PINNED=1 node frame_dump.js [columnNumber]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const HARNESS = path.join(HERE, 'harness.js');
const TARGET_COL = parseInt(process.argv[2] || '0', 10); // 0 = any fav0 payload TypeError

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const IDENT = `(function(o){try{if(o===null||o===undefined)return 'prim:'+String(o);const ch=[];let p=o,i=0;while(p&&i<10){try{ch.push((p.constructor&&p.constructor.name)||Object.prototype.toString.call(p))}catch(e){ch.push('?')}p=Object.getPrototypeOf(p);i++}return '['+(typeof o)+'] '+ch.join(' -> ')}catch(e){return 'identErr:'+e.message}})`;

async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', HARNESS], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: process.env.HARNESS_MS || '30000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  child.stdout.on('data', d => process.stdout.write('[h] ' + d.toString()));
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.error('no inspector'); child.kill(); return; }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const events = []; const scripts = new Map();
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
    }, 10);
  });

  await send('Debugger.enable');
  await send('Runtime.enable');
  await send('Debugger.setPauseOnExceptions', { state: 'all' });
  await send('Runtime.runIfWaitingForDebugger');

  let resumes = 0, captured = 0;
  const hunt0 = Date.now();
  while (Date.now() - hunt0 < 90000) {
    const ev = await waitEvent('Debugger.paused', 30000);
    if (!ev) break;
    const p = ev.params;
    const fr = p.callFrames[0];
    const u = (fr.url || scripts.get(fr.location.scriptId) || '').replace(/^.*\//, '');
    const excText = (p.data && (p.data.description || p.data.text)) || '';
    const isFav0 = u.includes('fav0-payload') || u.includes('turnstile-api-in-realm') || u.includes('orchestrate');
    const hasLm = p.callFrames.some(cf => ['lM','Gz','GZ','AC','tM'].includes(cf.functionName || ''));
    const isTarget = isFav0 && hasLm && (excText.includes('Cannot create proxy') || excText.includes('is not a function') || excText.includes('Cannot read properties') || excText.includes('Cannot convert') || /^TypeError/.test(excText.trim()) || excText.trim() === 'TypeError');
    console.error('PAUSE ' + u + ' | ' + excText.split(String.fromCharCode(10))[0] + ' | ' + (p.reason||''));
    if (!isTarget) {
      resumes++;
      if (resumes < 4000) await send('Debugger.resume');
      else await send('Debugger.setSkipAllPauses', { skip: true });
      continue;
    }
    captured++;
    console.log(`\n=== PAUSE @ ${u}:${fr.location.lineNumber + 1}:${fr.location.columnNumber} ===`);
    // Dump the source of any evalmachine frame in the stack (the VM's direct
    // eval code — invisible to window.eval observers).
    for (const cf2 of p.callFrames.slice(0, 4)) {
      const cfUrl = (cf2.url || scripts.get(cf2.location.scriptId) || '');
      if (cfUrl.includes('evalmachine')) {
        try {
          const sc = await send('Debugger.getScriptSource', { scriptId: cf2.location.scriptId });
          const code = (sc.result && sc.result.scriptSource) || '';
          console.log('--- EVALMACHINE[' + cf2.location.columnNumber + '] ' + code.length + 'B head ---');
          console.log(code.slice(0, 700));
          console.log('--- col' + cf2.location.columnNumber + ' vicinity ---');
          console.log(code.slice(Math.max(0, cf2.location.columnNumber - 200), cf2.location.columnNumber + 300));
        } catch (e3) { console.log('evalmachine src err: ' + e3.message); }
      }
    }
    // AC-frame specialization: dump the asserted value TF and, when it is a
    // string name, what window carries under that name.
    {
      const acf = p.callFrames.find(cf => ['AC','tM','Gz','GZ','lM'].includes(cf.functionName || ''));
      if (acf) {
        const ev = async (expression) => {
          const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: acf.callFrameId, expression, returnByValue: true });
          if (r.result && r.result.exceptionDetails) return '<err>';
          return r.result && r.result.result ? r.result.result.value : '-';
        };
        console.log('--- lM frame regs ---');
        const regsDump = await ev(`(function(){const out={};try{const h=HH&&HH.h;if(h){for(const k of Object.keys(h).slice(0,20)){const v=h[k];out['r'+k]=(v===null)?'null':(typeof v==='object')?('o:'+(v.constructor?v.constructor.name:'?')+String(v).slice(0,30)):(typeof v==='function'?'fn':String(v).slice(0,40))}}}catch(e){out.e=e.message}return JSON.stringify(out)})()`);
        console.log('  regs:', String(regsDump).slice(0, 700));
        const HvDump = await ev(`(function(){try{const out={};out.Hp=typeof Hp==='function'?('fn:'+String(Hp).slice(0,150)):String(Hp).slice(0,60);out.Hf=typeof Hf==='object'&&Hf?JSON.stringify(Hf.slice?Hf.slice(0,8).map(x=>{try{return (x&&typeof x==='object')?('o:'+Object.keys(x).slice(0,10).join('/')+':'+(x.constructor?x.constructor.name:'?')):String(x).slice(0,25)}catch(_){return '?'}}):Hf):String(Hf).slice(0,60);try{out.pool=(function(){try{const h=HH&&HH.h;if(!h)return 'no-h';const out2=[];for(let i2=0;i2<40;i2++){const v=h[i2];out2.push('h'+i2+':'+((v===undefined)?'U':(v===null)?'null':(typeof v==='function')?('fn':String(v).slice(0,26).replace(/\n/g,' ')):(typeof v==='object')?('o'+(v&&v.length!==undefined?'.arr'+v.length:'')+(v.constructor?':'+v.constructor.name:'')):String(v).slice(0,26)))}return out2.join(',')}catch(e){return 'E:'+e.message}})();out.state={i:HH.i,j:HH.j,h79:(function(){try{const v=HH.h[79];return v===null?'null':(typeof v==='object')?('o:'+(v.constructor?v.constructor.name:'')+String(v).slice(0,40)):(typeof v==='function'?'fn':String(v).slice(0,40))}catch(_){return '?'}})(),h140:(function(){try{const v=HH.h[140];return v===null?'null':(typeof v==='object')?('o:'+(v.constructor?v.constructor.name:'')+String(v).slice(0,40)):(typeof v==='function'?'fn':String(v).slice(0,40))}catch(_){return '?'}})(),hKeys:(function(){try{return Object.keys(HH.h).slice(0,30).map(function(k){const v=HH.h[k];return k+':'+((v&&typeof v==='object')?'o':String(v).slice(0,14))}).join(',')}catch(_){return '?'}})()}}catch(_){}try{out.Hv=String(Hv).slice(0,40)}catch(_){}return JSON.stringify(out)}catch(e){return 'E:'+e.message}})()`);
        console.log('  opnd:', String(HvDump).slice(0, 800));
      }
    }
    console.log('exception:', excText.split('\n')[0]);
    for (const cf of p.callFrames.slice(0, 5)) {
      const fu = (cf.url || scripts.get(cf.location && cf.location.scriptId) || '').replace(/^.*\//, '');
      console.log(`  frame fn=${cf.functionName || '(anon)'} @${fu}:${(cf.location ? cf.location.columnNumber : -1)}`);
    }
    const evalOn = async (expression) => {
      const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: fr.callFrameId, expression, returnByValue: true, throwOnSideEffect: false });
      if (r.result && r.result.exceptionDetails) return `<err: ${r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text}>`;
      return r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 200);
    };
    const checks = [];
    // identity + ownkeys for any plausible local object names
    for (const nm of ['a', 'Li', 'LV', 'A7', 'Ax', 'AL', 'LS', 'AP', 'N', 'Q']) {
      checks.push([`${nm} identity`, `typeof ${nm}!=='undefined' ? (${IDENT})(${nm}) : '<undef>'`]);
      checks.push([`${nm} ownkeys`, `try{${nm}&&typeof ${nm}==='object'?Object.getOwnPropertyNames(${nm}).slice(0,60).join(','):String(${nm})}catch(e){'err:'+e.message}`]);
    }
    // decode string-table entries for whichever decoder/keypair is in scope
    for (const [dec, keys] of [['bU', 'pd'], ['bi', 'fY'], ['dy', 'fY'], ['bR', 'gZ']]) {
      checks.push([`${dec} fn?`, `typeof ${dec}!=='undefined' ? String(${dec}) : '<undef>'`]);
      for (const k of ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'l', 'm', 'i', 'j', 'k', 'n', 'b']) {
        checks.push([`${dec}(${keys}.${k})`, `try{typeof ${dec}!=='undefined'&&typeof ${keys}!=='undefined'?String(${dec}(${keys}.${k})):'-'}catch(e){'err'}`]);
      }
    }
    const VAR_NAMES = (process.env.FRAME_VARS || 'a,Li,h3,h4,G,Bl,Be,h0,m,N,Q,A7').split(',');
    const DECODES = (process.env.FRAME_DECODES || 'ak(898),ak(275),ak(1207),ak(1189),ak(32),cx(pI.C),cx(pI.B),cx(pI.P),cx(pI.M),cx(pI.N),bU(pd.I),bi(fY.n)').split(',');
    for (let fi = 0; fi < Math.min(p.callFrames.length, 3); fi++) {
      const cf = p.callFrames[fi];
      const fu = (cf.url || scripts.get(cf.location && cf.location.scriptId) || '').replace(/^.*\//, '');
      console.log(`--- frame[${fi}] fn=${cf.functionName || '(anon)'} @${fu}:${cf.location ? cf.location.columnNumber : -1} ---`);
      const evalOn2 = async (expression) => {
        const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression, returnByValue: true, throwOnSideEffect: false });
        if (r.result && r.result.exceptionDetails) return `<err: ${(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text) + ''}>`;
        return r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 200);
      };
      for (const cf2 of p.callFrames.slice(0, 3)) {
        for (const ex of [`JSON.stringify({name:HH, wt:typeof window[HH], wv:String(window[HH]).slice(0,90)})`, `JSON.stringify({keys: Object.getOwnPropertyNames(HT).slice(0,25), ctor: HT.constructor && HT.constructor.name, self: String(HT.window===HT), loc: String(typeof HT.location)})`, `JSON.stringify({HTeval: typeof HT[HH], HTisW: String(HT===window)})`, `String(HT===window)`, `String(HT.eval)`, `String(typeof HT.eval)`, `String(Object.keys(HT).filter(k2=>/eval/i.test(k2)).join(','))`, `String(HT===globalThis)`, `String(Hp).slice(0,80)`, `String(typeof HY)`, `String(HY)`, `String(typeof HH)`, `String(HH).slice(0,60)`]) {
          try {
            const r2 = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf2.callFrameId, expression: `try{${ex}}catch(e){'<err>'}`, returnByValue: true });
            const v2 = r2.result && r2.result.result ? r2.result.result.value : '-';
            if (v2 !== '-' && v2 !== '<err>' && v2 !== 'undefined') console.log(`  f${p.callFrames.indexOf(cf2)} ${ex.slice(7, 27)} = ${String(v2).slice(0, 90)}`);
          } catch (_) {}
        }
      }
      for (const d of DECODES) {
        const v = await evalOn2(`try{String(${d})}catch(e){'-'}`);
        if (v && v !== '-') console.log(`  decode ${d} = ${String(v).slice(0, 120)}`);
      }
    }
    seenPauses = seenPauses || new Set();
    const pk = fr.functionName + ':' + fr.location.columnNumber;
    if (!seenPauses.has(pk)) {
      seenPauses.add(pk);
      console.log(`[pause-collect ${seenPauses.size}] fn=${fr.functionName || '(anon)'} col=${fr.location.columnNumber}`);
      // dump the exception-throwing frame's scope locals briefly
      try {
        const sc = await send('Debugger.evaluateOnCallFrame', { callFrameId: fr.callFrameId, expression: 'JSON.stringify(Object.entries(this).slice(0,3))', returnByValue: true });
      } catch (_) {}
    }
    if (seenPauses.size >= 8) break;
    if (resumes < 4000) await send('Debugger.resume');
    continue;
  }
  console.log(`\n[resumes=${resumes} captured=${captured}]`);
  try { await send('Debugger.setSkipAllPauses', { skip: true }); } catch (_) {}
  // let the harness finish its timeline
  await sleep(25000);
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
