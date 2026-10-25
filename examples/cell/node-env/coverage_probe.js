// Precise V8 coverage for orchestrate.js: which byte ranges actually ran.
// Usage: HARNESS_PINNED=1 node coverage_probe.js [waitMs]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const WAIT = parseInt(process.argv[2] || '6000', 10);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  const child = spawn(process.execPath, ['--inspect-brk=0', path.join(HERE, 'harness.js')], {
    cwd: HERE, env: { ...process.env, HARNESS_MS: String(WAIT + 8000) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  let wsUrl = '';
  child.stderr.on('data', d => { const m = d.toString().match(/ws:\/\/\S+/); if (m && !wsUrl) wsUrl = m[0]; });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const scripts = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url || ''); };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable');
  await send('Profiler.enable');
  await send('Runtime.runIfWaitingForDebugger');
  await sleep(600);
  // break at the harness orchestrate-eval line so coverage starts fresh at eval
  const hsrc = fs.readFileSync(path.join(HERE, 'harness.js'), 'utf8');
  const evalLine = hsrc.slice(0, hsrc.indexOf('vm.runInContext(prelude + scriptSrc')).split('\n').length;
  await send('Debugger.setBreakpointByUrl', { urlRegex: 'harness\\.js', lineNumber: evalLine - 1, columnNumber: 0 });
  await send('Debugger.resume');
  // wait for the eval pause
  let paused = false;
  const t0 = Date.now();
  ws.onmessage = (() => { const orig = ws.onmessage; return ev => { const m = JSON.parse(ev.data); if (m.method === 'Debugger.paused') paused = true; orig(ev); }; })();
  while (Date.now() - t0 < 20000 && !paused) await sleep(30);
  console.error('at eval pause:', paused);
  await send('Debugger.resume');
  const ps = await send('Profiler.start');
  console.error('Profiler.start:', JSON.stringify(ps).slice(0, 120));
  await sleep(WAIT);
  const cov = await send('Profiler.takePreciseCoverage');
  await send('Profiler.stop');
  const prof = (cov && cov.result && cov.result.result) || [];
  console.error('raw cov keys:', JSON.stringify(cov).slice(0, 150));
  const orch = prof.filter(s => (s.url || '').includes('orchestrate'));
  if (!orch.length) { console.error('no orchestrate coverage; profile scripts: ' + prof.length); child.kill(); return; }
  const src = fs.readFileSync(path.join(HERE, 'pinned-orchestrate.js'), 'utf8');
  const lines = src.split('\n');
  const lineStarts = []; let acc = 0;
  for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; }
  const abs = (line0, col) => lineStarts[line0] + col;   // line0 = CDP 0-based
  // VM line = source line + 4 (prelude has 3 newlines, last line merges with source line 1)
  const out = [];
  for (const s of orch) {
    for (const f of (s.functions || [])) {
      for (const r of (f.ranges || [])) {
        if (!r.count) continue;
        const sl = r.startLocation, el = r.endLocation;
        if (!sl || !el) continue;
        const a = abs(sl.lineNumber - 4, sl.columnNumber);
        const b = abs(el.lineNumber - 4, el.columnNumber);
        out.push([a, b, r.count]);
      }
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  // merge and report coverage against key columns (line2 = VM5: source line 1 (0-based))
  const L1 = lineStarts[1], L2 = lineStarts[2]; // 0-based source line 1 = source line 2 (1-based)
  console.error(`coverage blocks: ${out.length}`);
  // find max covered col on source line 2 (the IIFE line) and line 3
  let maxL2 = -1, maxL3 = -1, coverL3 = 0;
  for (const [a, b] of out) {
    if (a < L2 && b > L1) maxL2 = Math.max(maxL2, Math.min(b, L2) - L1);
    if (b > L2) { maxL3 = Math.max(maxL3, Math.min(b, acc) - L2); coverL3 += (b > L2 ? Math.min(b, acc) - L2 : 0); }
  }
  console.error(`source line2 covered up to col: ${maxL2} (of ${lines[1].length})`);
  console.error(`source line3 covered up to col: ${maxL3} (of ${lines[2].length})`);
  // gaps on line 2 beyond 5000
  const l2ranges = out.filter(([a, b]) => b > L1 && a < L2).map(([a, b]) => [Math.max(a - L1, 0), Math.min(b, L2) - L1]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of l2ranges) { if (merged.length && r[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]); else merged.push([...r]); }
  console.error('line2 covered ranges (col-col):', merged.map(r => r[0] + '-' + r[1]).join(', '));
  fs.writeFileSync(path.join(HERE, 'coverage.json'), JSON.stringify(out));
  child.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
