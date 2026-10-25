// Focused b4-trampoline sampler: no notify-bp gate. Breaks on every
// b4@<b4Line:b4Col> hit in the pinned orchestrate VM, logs cursor + caller
// column, and evaluates the wait expression when the caller is the f-loop.
// Usage: HARNESS_PINNED=1 node b4_sample.js [maxHits]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const HARNESS = path.join(HERE, 'harness.js');
const MAXHITS = parseInt(process.argv[2] || '3000', 10);
// optional line:col override (VM coordinates) e.g. node b4_sample.js 500 4:19584
const B4_OVERRIDE = process.argv[3] || '';
// b4 trampoline location in the VM (prelude shifts orchestrate lines by +1):
// orchestrate line 4 -> VM line 5, col 73652 (established round8-11).
const B4_LINE = B4_OVERRIDE ? parseInt(B4_OVERRIDE.split(':')[0], 10) : 5;
const B4_COL = B4_OVERRIDE ? parseInt(B4_OVERRIDE.split(':')[1], 10) : 73652;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', HARNESS], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: process.env.HARNESS_MS || '30000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write('[h] ' + d.toString()));
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.error('no inspector'); child.kill(); return; }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const events = []; const scripts = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) { if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || ''); events.push(m); }
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
  await send('Runtime.runIfWaitingForDebugger');
  // Node 22: --inspect-brk is not released by runIfWaitingForDebugger alone;
  // an explicit resume is required (Node 26 brake semantics differ).
  await sleep(800);
  if (![...scripts.values()].some(u => (u || '').endsWith('orchestrate.js'))) {
    await send('Debugger.resume');
  }

  // Set the orchestrate breakpoint BEFORE the script runs: break on the
  // harness's orchestrate-eval line first, install the urlRegex bp (it then
  // applies when the script compiles), then release.
  {
    const hsrc = fs.readFileSync(HARNESS, 'utf8');
    const evalLine = hsrc.slice(0, hsrc.indexOf("vm.runInContext(prelude + scriptSrc")).split('\n').length; // 1-based
    const hp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'harness\\.js', lineNumber: evalLine - 1, columnNumber: 0 });
    console.error(`harness eval-line bp: ${JSON.stringify(hp.result && hp.result.locations || hp.error || hp.result).slice(0, 160)}`);
  }
  await send('Debugger.resume');

  // wait for the orchestrate script to parse, then set the b4 breakpoint
  let orchSid = null;
  let sawEvalPause = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const ev = await waitEvent('Debugger.paused', 8000);
    if (!ev) break;
    const fr = ev.params.callFrames[0];
    const u = fr.url || scripts.get(fr.location.scriptId) || '';
    if (u.endsWith('harness.js')) { sawEvalPause = true; console.error('paused at harness eval line'); break; }
    await send('Debugger.resume');
  }
  for (const [sid, u] of scripts) if ((u || '').endsWith('orchestrate.js')) orchSid = sid;
  const bpr = await send('Debugger.setBreakpointByUrl', { urlRegex: 'orchestrate\\.js', lineNumber: B4_LINE - 1, columnNumber: B4_COL });
  if (bpr.error || !bpr.result || !bpr.result.breakpointId) { console.error('b4 bp fail', JSON.stringify(bpr).slice(0, 300)); child.kill(); return; }
  console.error(`b4 bp registered id=${bpr.result.breakpointId} (locations now: ${JSON.stringify(bpr.result.locations)}; applies on compile) preEvalPause=${sawEvalPause}`);
  const BPID = bpr.result.breakpointId;
  await send('Debugger.resume');

  const hits = [];
  const seen = new Set();
  let resumes = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 60000 && hits.length < MAXHITS) {
    const ev = await waitEvent('Debugger.paused', 20000);
    if (!ev) break;
    const p = ev.params;
    if (!(p.hitBreakpoints || []).includes(BPID)) { resumes++; if (resumes < 8000) await send('Debugger.resume'); continue; }
    const fr = p.callFrames[0];
    const caller = p.callFrames[1];
    const ccol = caller && caller.location ? caller.location.columnNumber : -1;
    const key = `${ccol}`;
    const evalOn = async (cf, expr) => {
      try {
        const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: expr, returnByValue: true });
        return r.result && r.result.result ? r.result.result.value : undefined;
      } catch (_) { return undefined; }
    };
    const cur = await evalOn(fr, 'String($i)');
    { for (const pe of ['String(HY)','String(HI[HW])','String(Hn)']) { const pv=await evalOn(fr, 'try{'+pe+'}catch(e){'-'}'); if(pv&&pv!=='-') console.error('VMSTATE', pe+'='+String(pv).slice(0,60)); } }
    { const dn = await evalOn(fr, 'try{String(a6(630))}catch(e){'-'}'); if (dn && dn !== '-') console.error('DECODE a6(630) =', dn); }
    if (!seen.has(key)) {
      seen.add(key);
      const entry = { cursor: String(cur), callerCol: ccol, callerFn: caller ? caller.functionName : '' };
      // decode the string + the wait expression at the caller (f-loop frame)
      entry.str = String(await evalOn(fr, 'String(b3[$i])') || '');
      if (caller) {
        entry.cnmx = String(await evalOn(caller, `try{String(window._cf_chl_opt && window._cf_chl_opt.CNmxZ4)}catch(e){'-'}`));
        entry.zIsWin = await evalOn(caller, 'Z===window');
        entry.xnuType = String(await evalOn(caller, 'typeof window.XnuWO5'));
      }
      // TICK_EXPRS probe: ';;'-separated expressions evaluated at the breakpoint frame
      const exprs = (process.env.TICK_EXPRS || '').split(';;').filter(Boolean);
      if (exprs.length) {
        entry.probe = {};
        for (const ex of exprs) {
          entry.probe[ex.slice(0, 70)] = String(await evalOn(fr, `try{String(${ex})}catch(e){'ERR:'+e.message}`)).slice(0, 160);
        }
      }
      // UPFRAMES probe: evaluate expressions on ancestor frames (tick locals)
      const upExprs = (process.env.UP_EXPRS || '').split(';;').filter(Boolean);
      if (upExprs.length) {
        for (let fi = 1; fi < Math.min(p.callFrames.length, 6); fi++) {
          const cf = p.callFrames[fi];
          const fu = (cf.url || scripts.get(cf.location && cf.location.scriptId) || '').replace(/^.*\//, '');
          for (const ex of upExprs) {
            const v = await evalOn(cf, `try{String(${ex})}catch(e){'ERR'}`);
            if (v !== undefined && v !== 'ERR') console.error(`  up[${fi}] ${fu.slice(0,20)}:${cf.location.columnNumber} ${ex.slice(0,50)} = ${String(v).slice(0, 120)}`);
          }
        }
      }
      hits.push(entry);
      console.error(`b4 hit @${(fr.url||scripts.get(fr.location.scriptId)||"").replace(/^.*\//,"")}:${fr.location.lineNumber+1}:${fr.location.columnNumber} cursor=${entry.cursor} str=${entry.str} callerCol=${ccol} fn=${entry.callerFn} zIsWin=${entry.zIsWin} xnu=${entry.xnuType} cnmx=${entry.cnmx}${entry.probe ? ' probe=' + JSON.stringify(entry.probe) : ''}`);
      // STEPCHAIN: on first hit, stepInto through the chain and record frames
      if (process.env.STEPCHAIN && hits.length === 1) {
        const frames = [];
        for (let s2 = 0; s2 < 4000; s2++) {
          const st = await send('Debugger.stepInto', {});
          const ev2 = await waitEvent('Debugger.paused', 5000);
          if (!ev2) break;
          const cf = ev2.params.callFrames[0];
          const u2 = (cf.url || scripts.get(cf.location.scriptId) || '').replace(/^.*\//, '');
          frames.push(`${cf.functionName || '(anon)'}@${u2}:${cf.location.columnNumber}`);
          // stop when leaving the orchestrate script
          // keep stepping through harness frames
          const args = [];
          try { const pr2 = await send("Debugger.evaluateOnCallFrame", { callFrameId: cf.callFrameId, expression: process.env.STEP_EXPR || "0", returnByValue: true }); args.push("PROBE=" + String(pr2.result && pr2.result.result && (pr2.result.result.description != null ? pr2.result.result.description : pr2.result.result.value)).slice(0, 120)); } catch (_) {}
          const sc = cf.scopeChain && cf.scopeChain.find(s3 => s3.type === 'local');
          if (sc && sc.object.objectId) {
            try {
              const pr = await send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true });
              for (const pp of (pr.result.result || []).slice(0, 10)) {
                args.push(pp.name + '=' + String(pp.value && (pp.value.description != null ? pp.value.description : pp.value.value)).slice(0, 40));
              }
            } catch (_) {}
          }
          console.error(`step${s2}: ${frames[frames.length - 1]} | ${args.join(' ')}`);
          if (ev2.params.callFrames.length < 2) break;
        }
        break;
      }
    }
    await send('Debugger.resume');
  }
  fs.writeFileSync(path.join(HERE, 'b4-sample.json'), JSON.stringify(hits, null, 1));
  console.error(`done hits=${hits.length} uniqCols=${seen.size}`);
  try { await send('Debugger.setSkipAllPauses', { skip: true }); } catch (_) {}
  await sleep(2000);
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
