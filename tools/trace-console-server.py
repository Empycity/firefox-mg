#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


ROOT = pathlib.Path(__file__).resolve().parents[1]
TRACE_CONTROL = ROOT / "tools" / "trace-control.sh"

OPTION_FLAGS = {
    "profile": ("--profile", "TRACE_PROFILE"),
    "js_mode": ("--js-mode", "TRACE_JS_MODE"),
    "script_contains": ("--script-contains", "TRACE_SCRIPT_CONTAINS"),
    "function_contains": ("--function-contains", "TRACE_FUNCTION_CONTAINS"),
    "script_sha256": ("--script-sha256", "TRACE_SCRIPT_SHA256"),
    "target_match": ("--target-match", "TRACE_TARGET_MATCH"),
    "query_fields": ("--query-fields", "TRACE_QUERY_FIELDS"),
    "object_depth": ("--object-depth", "TRACE_JS_OBJECT_DEPTH"),
    "object_keys": ("--object-keys", "TRACE_JS_OBJECT_KEYS"),
    "array_items": ("--array-items", "TRACE_JS_ARRAY_ITEMS"),
    "typed_array_bytes": ("--typed-array-bytes", "TRACE_JS_TYPED_ARRAY_BYTES"),
    "value_metadata": ("--value-metadata", "TRACE_JS_VALUE_METADATA"),
    "primitive_metadata": ("--primitive-metadata", "TRACE_JS_PRIMITIVE_METADATA"),
    "value_store_min_bytes": ("--value-store-min-bytes", "TRACE_JS_VALUE_STORE_MIN_BYTES"),
    "limit_events": ("--limit-events", "FIREFOX_TRACE_JS_LIMIT_EVENTS"),
}

MODULES = ["js", "xhr", "fetch", "ws", "dom", "cookie", "storage", "script"]

RESTART_REQUIRED = [
    "TRACE_AUTOMATION_SURFACE",
    "FIREFOX_TRACE_AUTOMATION_SURFACE",
    "TRACE_HEADLESS",
    "TRACE_EXECUTION_MODE",
    "TRACE_OPCODE",
    "TRACE_OPCODE_SCRIPT_CONTAINS",
    "TRACE_OPCODE_SCRIPT_LINE",
    "TRACE_OPCODE_SCRIPT_COLUMN",
    "TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH",
]

HTML = r"""<!doctype html>
<meta charset="utf-8">
<title>Firefox Trace Console</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; }
  header { padding: 14px 18px; border-bottom: 1px solid #9994; display: flex; gap: 12px; align-items: center; }
  main { display: grid; grid-template-columns: minmax(360px, 520px) 1fr; gap: 16px; padding: 16px; }
  fieldset { border: 1px solid #9995; border-radius: 8px; margin: 0 0 12px; padding: 12px; }
  legend { padding: 0 6px; font-weight: 650; }
  label { display: grid; gap: 4px; margin: 8px 0; }
  input, select, textarea, button { font: inherit; }
  input, select, textarea { box-sizing: border-box; width: 100%; padding: 6px 8px; border: 1px solid #9998; border-radius: 6px; background: Canvas; color: CanvasText; }
  textarea { min-height: 92px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  button { padding: 7px 10px; border-radius: 6px; border: 1px solid #7778; cursor: pointer; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  .modules { display: grid; grid-template-columns: repeat(4, minmax(70px, 1fr)); gap: 6px; }
  .modules label { display: flex; gap: 6px; align-items: center; margin: 0; }
  .modules input { width: auto; }
  pre { overflow: auto; max-height: 48vh; padding: 10px; border: 1px solid #9995; border-radius: 8px; background: #8881; }
  .warn { color: #b26b00; }
  .ok { color: #07803b; }
  .small { opacity: .72; font-size: 12px; }
</style>
<header>
  <strong>Firefox Trace Console</strong>
  <span class="small">控制同一个浏览器进程里的 trace segment / mode / filter</span>
</header>
<main>
  <section>
    <fieldset>
      <legend>Run</legend>
      <label>TRACE_DIR <input id="traceDir" placeholder="/private/tmp/firefox-trace-..."></label>
      <label>TRACE_CONTROL_FILE（可空） <input id="controlFile" placeholder="默认 TRACE_DIR/trace-control.json"></label>
      <label>目标 content PID（可空） <input id="targetPid" inputmode="numeric" placeholder="从目标 XHR 事件读取 pid"></label>
      <div class="buttons">
        <button onclick="loadLatest()">最近目录</button>
        <button onclick="status()">Status</button>
        <button onclick="summary()">Summary</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>Segment / Preset</legend>
      <div class="row">
        <label>segment label <input id="segment" placeholder="discover / target-values"></label>
        <label>preset
          <select id="preset">
            <option value="">不改变</option>
            <option>discover-light</option>
            <option>target-return</option>
            <option>target-values</option>
            <option>deep-causal</option>
            <option>manual</option>
          </select>
        </label>
      </div>
      <div class="buttons">
        <button onclick="newSegment()">New Segment</button>
        <button onclick="applyConfig()">Apply Config</button>
        <button onclick="action('prewarm')">Prewarm</button>
        <button onclick="action('start')">Start</button>
        <button onclick="action('stop')">Stop</button>
      </div>
      <p class="small warn">建议：Apply Config 后点 Prewarm 或等一次 status，再触发目标动作，避免首批事件仍用旧 JS mode。</p>
    </fieldset>

    <fieldset>
      <legend>Modules</legend>
      <div class="modules" id="modules"></div>
    </fieldset>

    <fieldset>
      <legend>JS / Request</legend>
      <div class="row">
        <label>profile <input id="profile" placeholder="discover / target / deep"></label>
        <label>js mode
          <select id="js_mode">
            <option value="">不改变</option>
            <option>boundary</option>
            <option>target</option>
            <option>deep</option>
            <option>off</option>
          </select>
        </label>
      </div>
      <label>script contains <input id="script_contains" placeholder="js_security_v3,xxx.js"></label>
      <label>function contains <input id="function_contains" placeholder="signSync,_$gsp,encode"></label>
      <label>script sha256 <input id="script_sha256"></label>
      <div class="row">
        <label>target match
          <select id="target_match">
            <option value="">不改变</option>
            <option>all</option>
            <option>any</option>
            <option>auto</option>
          </select>
        </label>
        <label>query fields <input id="query_fields" placeholder="h5st,anti_content,sign,token,body"></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Value / Limit</legend>
      <div class="row">
        <label>object depth <input id="object_depth" type="number" min="0" max="6"></label>
        <label>object keys <input id="object_keys" type="number" min="0"></label>
      </div>
      <div class="row">
        <label>array items <input id="array_items" type="number" min="0"></label>
        <label>typed array bytes <input id="typed_array_bytes" type="number" min="0"></label>
      </div>
      <div class="row">
        <label>value metadata
          <select id="value_metadata"><option value="">不改变</option><option value="1">1</option><option value="0">0</option></select>
        </label>
        <label>primitive metadata
          <select id="primitive_metadata"><option value="">不改变</option><option value="1">1</option><option value="0">0</option></select>
        </label>
      </div>
      <div class="row">
        <label>value store min bytes <input id="value_store_min_bytes" type="number" min="0"></label>
        <label>JS limit events <input id="limit_events" type="number" min="0"></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Custom env</legend>
      <textarea id="customEnv" placeholder="TRACE_JS_ARGS=preview&#10;TRACE_JS_RET=preview&#10;TRACE_UNSAFE_ALLOW=1"></textarea>
      <p class="small">空值写成 <code>TRACE_SCRIPT_CONTAINS=</code> 会 unset。重启项会被标记，但仍允许写入 control。</p>
    </fieldset>
  </section>
  <section>
    <fieldset>
      <legend>Output</legend>
      <pre id="out">idle</pre>
    </fieldset>
    <fieldset>
      <legend>Current control</legend>
      <pre id="control">not loaded</pre>
    </fieldset>
  </section>
</main>
<script>
const fields = ["profile","js_mode","script_contains","function_contains","script_sha256","target_match","query_fields","object_depth","object_keys","array_items","typed_array_bytes","value_metadata","primitive_metadata","value_store_min_bytes","limit_events"];
const moduleNames = ["js","xhr","fetch","ws","dom","cookie","storage","script"];
document.getElementById("modules").innerHTML = moduleNames.map(m => `<label><input type="checkbox" id="mod_${m}" ${m === "ws" ? "" : "checked"}> ${m}</label>`).join("");

function traceDir() { return document.getElementById("traceDir").value.trim(); }
function controlFile() { return document.getElementById("controlFile").value.trim(); }
function write(id, obj) { document.getElementById(id).textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2); }
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? {"content-type":"application/json"} : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw data;
  return data;
}
function baseBody(extra={}) {
  return {trace_dir: traceDir(), control_file: controlFile() || undefined, ...extra};
}
function customEnv() {
  const env = {};
  const unset = [];
  for (const line of document.getElementById("customEnv").value.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1);
    if (!v) unset.push(k); else env[k] = v;
  }
  return {env, unset};
}
function configBody() {
  const options = {};
  for (const f of fields) {
    const v = document.getElementById(f).value;
    if (v !== "") options[f] = v;
  }
  const modules = {};
  for (const m of moduleNames) modules[m] = document.getElementById("mod_" + m).checked;
  const c = customEnv();
  return baseBody({
    segment: document.getElementById("segment").value.trim() || undefined,
    preset: document.getElementById("preset").value || undefined,
    options, modules, env: c.env, unset: c.unset,
  });
}
async function loadLatest() {
  try {
    const data = await api("/api/latest");
    write("out", data);
    if (data.dirs && data.dirs[0]) document.getElementById("traceDir").value = data.dirs[0];
  } catch (e) { write("out", e); }
}
async function status() {
  try {
    const targetPid = document.getElementById("targetPid").value.trim();
    const data = await api("/api/status?trace_dir=" + encodeURIComponent(traceDir()) + "&control_file=" + encodeURIComponent(controlFile()) + "&target_pid=" + encodeURIComponent(targetPid));
    write("out", data);
    write("control", data.control || {});
  } catch (e) { write("out", e); }
}
async function summary() {
  try { write("out", await api("/api/summary?trace_dir=" + encodeURIComponent(traceDir()))); }
  catch (e) { write("out", e); }
}
async function applyConfig() {
  try {
    const data = await api("/api/config", configBody());
    write("out", data);
    write("control", data.control || {});
  } catch (e) { write("out", e); }
}
async function newSegment() {
  try {
    const data = await api("/api/new-segment", baseBody({label: document.getElementById("segment").value.trim()}));
    write("out", data);
    write("control", data.control || {});
  } catch (e) { write("out", e); }
}
async function action(name) {
  try {
    const label = document.getElementById("segment").value.trim() || name;
    const data = await api("/api/" + name, baseBody({label}));
    write("out", data);
    write("control", data.control || {});
  } catch (e) { write("out", e); }
}
loadLatest();
</script>
"""


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    blob = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(blob)))
    handler.end_headers()
    handler.wfile.write(blob)


def html_response(handler: BaseHTTPRequestHandler):
    blob = HTML.encode("utf-8")
    handler.send_response(200)
    handler.send_header("content-type", "text/html; charset=utf-8")
    handler.send_header("content-length", str(len(blob)))
    handler.end_headers()
    handler.wfile.write(blob)


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def safe_trace_dir(value: str | None, default: pathlib.Path) -> pathlib.Path:
    if value:
        return pathlib.Path(value).expanduser()
    return default


class TraceConsole:
    def __init__(self, default_trace_dir: pathlib.Path):
        self.default_trace_dir = default_trace_dir

    def run_control(self, trace_dir: pathlib.Path, action: str, args: list[str], control_file: str | None = None) -> dict:
        env = os.environ.copy()
        if control_file:
            env["TRACE_CONTROL_FILE"] = control_file
        cmd = [str(TRACE_CONTROL), str(trace_dir), action] + args
        proc = subprocess.run(cmd, cwd=str(ROOT), env=env, text=True, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "").strip() or f"trace-control failed: {proc.returncode}")
        return json.loads(proc.stdout or "{}")

    def status(self, trace_dir: pathlib.Path, control_file: str | None = None, target_pid: str | None = None) -> dict:
        control = self.run_control(trace_dir, "status", [], control_file)
        acknowledgements = self.config_acknowledgements(trace_dir, control, target_pid)
        return {
            "ok": True,
            "trace_dir": str(trace_dir),
            "control": control,
            "config_applied": acknowledgements,
        }

    def config_acknowledgements(self, trace_dir: pathlib.Path, control: dict, target_pid: str | None = None) -> dict:
        """Report ACKs for the exact revision, optionally scoped to one content PID."""
        path = trace_dir / "firefox-control-acks.jsonl"
        expected_version = control.get("version")
        expected_hash = control.get("config_hash")
        latest: dict[str, dict] = {}
        normalized_target_pid = str(target_pid).strip() if target_pid else None
        if not path.is_file():
            return {
                "ready": False,
                "any_ready": False,
                "target_ready": False if normalized_target_pid else None,
                "target_pid": normalized_target_pid,
                "expected_version": expected_version,
                "expected_config_hash": expected_hash,
                "processes": [],
            }
        for line in path.open("r", encoding="utf-8", errors="ignore"):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "trace.config.applied":
                continue
            child_id = str(event.get("child_id") or event.get("pid") or "unknown")
            latest[child_id] = event
        matching = [
            event for event in latest.values()
            if event.get("control_version") == expected_version
            and event.get("config_hash") == expected_hash
        ]
        target_process = next(
            (event for event in latest.values() if str(event.get("pid")) == normalized_target_pid),
            None,
        )
        target_matching = [
            event for event in matching if str(event.get("pid")) == normalized_target_pid
        ] if normalized_target_pid else []
        any_ready = bool(matching)
        target_ready = bool(target_matching) if normalized_target_pid else None
        return {
            "ready": target_ready if normalized_target_pid else any_ready,
            "any_ready": any_ready,
            "target_ready": target_ready,
            "target_pid": normalized_target_pid,
            "expected_version": expected_version,
            "expected_config_hash": expected_hash,
            "processes": sorted(latest.values(), key=lambda item: str(item.get("child_id", ""))),
            "matching_processes": matching,
            "target_process": target_process,
            "target_matching_processes": target_matching,
        }

    def action(self, name: str, payload: dict) -> dict:
        trace_dir = safe_trace_dir(payload.get("trace_dir"), self.default_trace_dir)
        label = payload.get("label") or ""
        control = self.run_control(trace_dir, name, [label] if label else [], payload.get("control_file"))
        return {"ok": True, "trace_dir": str(trace_dir), "control": control}

    def config(self, payload: dict) -> dict:
        trace_dir = safe_trace_dir(payload.get("trace_dir"), self.default_trace_dir)
        args: list[str] = []
        if payload.get("segment"):
            args += ["--segment", str(payload["segment"])]
        if payload.get("preset"):
            args += ["--preset", str(payload["preset"])]
        for key, value in (payload.get("options") or {}).items():
            if key not in OPTION_FLAGS:
                continue
            flag, env_key = OPTION_FLAGS[key]
            if value is None or str(value) == "":
                args += ["--unset", env_key]
            else:
                args += [flag, str(value)]
        for module, enabled in (payload.get("modules") or {}).items():
            if module in MODULES:
                args += ["--module", f"{module}={1 if enabled else 0}"]
        for key, value in (payload.get("env") or {}).items():
            if value is None or str(value) == "":
                args += ["--unset", str(key)]
            else:
                args += ["--set", f"{key}={value}"]
        for key in payload.get("unset") or []:
            args += ["--unset", str(key)]
        control = self.run_control(trace_dir, "config", args, payload.get("control_file"))
        restart_keys = sorted(k for k in (control.get("env") or {}) if k in RESTART_REQUIRED)
        return {"ok": True, "trace_dir": str(trace_dir), "control": control, "restart_required_keys": restart_keys}

    def latest(self) -> dict:
        roots = []
        for p in pathlib.Path("/private/tmp").glob("firefox-trace-*"):
            if p.is_dir() and not p.name.startswith("firefox-trace-profile-"):
                try:
                    roots.append((p.stat().st_mtime, str(p)))
                except OSError:
                    pass
        roots.sort(reverse=True)
        return {"ok": True, "dirs": [p for _, p in roots[:20]]}

    def summary(self, trace_dir: pathlib.Path) -> dict:
        files = {}
        segments: dict[str, dict[str, int]] = {}
        controls = []
        for path in sorted(trace_dir.glob("firefox-*.jsonl")):
            line_count = 0
            for line in path.open("r", encoding="utf-8", errors="ignore"):
                line_count += 1
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if path.name == "firefox-control.jsonl":
                    controls.append(obj)
                seg = obj.get("segment_id") or ""
                typ = obj.get("type") or "?"
                if seg:
                    segments.setdefault(seg, {})
                    segments[seg][typ] = segments[seg].get(typ, 0) + 1
            files[path.name] = line_count
        return {
            "ok": True,
            "trace_dir": str(trace_dir),
            "files": files,
            "segments": segments,
            "last_control": controls[-1] if controls else None,
        }


class Handler(BaseHTTPRequestHandler):
    console: TraceConsole

    def log_message(self, fmt, *args):
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] {self.address_string()} {fmt % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        try:
            if parsed.path in ("/", "/index.html"):
                html_response(self)
            elif parsed.path == "/api/latest":
                json_response(self, 200, self.console.latest())
            elif parsed.path == "/api/status":
                trace_dir = safe_trace_dir((qs.get("trace_dir") or [""])[0], self.console.default_trace_dir)
                control_file = (qs.get("control_file") or [""])[0] or None
                target_pid = (qs.get("target_pid") or [""])[0] or None
                json_response(self, 200, self.console.status(trace_dir, control_file, target_pid))
            elif parsed.path == "/api/summary":
                trace_dir = safe_trace_dir((qs.get("trace_dir") or [""])[0], self.console.default_trace_dir)
                json_response(self, 200, self.console.summary(trace_dir))
            else:
                json_response(self, 404, {"ok": False, "error": "not found"})
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            payload = read_json_body(self)
            if parsed.path == "/api/config":
                json_response(self, 200, self.console.config(payload))
            elif parsed.path == "/api/new-segment":
                json_response(self, 200, self.console.action("new-segment", payload))
            elif parsed.path in ("/api/start", "/api/stop", "/api/prewarm"):
                json_response(self, 200, self.console.action(parsed.path.rsplit("/", 1)[-1], payload))
            else:
                json_response(self, 404, {"ok": False, "error": "not found"})
        except Exception as e:
            json_response(self, 400, {"ok": False, "error": str(e)})


def main():
    parser = argparse.ArgumentParser(description="Firefox Trace local control console")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--trace-dir", default="/private/tmp/firefox-trace-console")
    args = parser.parse_args()

    Handler.console = TraceConsole(pathlib.Path(args.trace_dir).expanduser())
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Trace console: http://{args.host}:{args.port}/")
    print(f"Default TRACE_DIR: {Handler.console.default_trace_dir}")
    server.serve_forever()


if __name__ == "__main__":
    main()
