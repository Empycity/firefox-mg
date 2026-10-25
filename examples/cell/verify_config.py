#!/usr/bin/env python3
"""Exercise the real desktop loader with Tcl variables, without a GUI/browser."""
import hashlib
import importlib.util
import json
import re
import tkinter as tk
from pathlib import Path

CASE = Path(__file__).resolve().parent
ROOT = CASE.parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TextBuffer:
    def __init__(self):
        self.text = ""

    def delete(self, *_):
        self.text = ""

    def insert(self, _index, value):
        self.text += value

    def get(self, *_):
        return self.text


def main():
    desktop = load("cell_trace_desktop", ROOT / "tools/trace-desktop.py")
    server = desktop.server_mod
    config = json.loads((CASE / "agent-next.json").read_text())
    interpreter = tk.Tcl()
    app = desktop.TraceDesktopApp.__new__(desktop.TraceDesktopApp)
    app.tk = interpreter.tk
    # Keep real StringVar/BooleanVar and real loader/payload methods. Only
    # presentation methods are replaced, so no window or browser is started.
    source = (ROOT / "tools/trace-desktop.py").read_text()
    for name, kind in re.findall(r"self\.(\w+) = tk\.(StringVar|BooleanVar|IntVar)\(", source):
        cls = getattr(tk, kind)
        setattr(app, name, cls(master=interpreter))
    app.module_vars = {name: tk.BooleanVar(master=interpreter) for name in config["modules"]}
    app.field_scope_vars = {name: tk.BooleanVar(master=interpreter) for name in config["ui"]["field_scopes"]}
    app.custom_env_text = TextBuffer()
    app.current_trace_dir = ""
    app.last_status = None
    app.toggle_advanced_options = lambda: None
    app.log = lambda *_: None
    app.apply_agent_config(config, CASE / "agent-next.json")
    payload = app.open_payload()
    payload, js_receipt = server.resolve_payload_js_mode(payload)
    payload, vm_receipt = server.resolve_payload_vm(Path(payload["trace_dir"]), payload)
    env = server.startup_env_from_payload(payload)
    expected = {
        "TRACE_JS_MODE": "boundary", "TRACE_JS_FULL_SPOOL": "1",
        "TRACE_JS_CAPTURE_VALUES": "1", "TRACE_JS_AUTO_CAPTURE_VALUES": "1",
        "TRACE_JS_OBJECT_DEPTH": "0", "FIREFOX_TRACE_JS_LIMIT_EVENTS": "0",
        "TRACE_IPC_MAX_EVENTS_PER_SECOND": "0", "TRACE_IPC_MAX_BYTES_PER_SECOND": "0",
        "TRACE_DOM_MODE": "signal", "TRACE_DOM_PREVIEW": "all",
        "TRACE_DOM_CONTRACT": "1", "TRACE_DOM_OBJECT_VALUES": "1",
        "TRACE_XHR_REQUEST_BODY": "full", "TRACE_XHR_RESPONSE_BODY": "full",
        "TRACE_FETCH_REQUEST_BODY": "full", "TRACE_FETCH_RESPONSE_BODY": "full",
        "TRACE_SCRIPT_RESOURCE_STORE": "1", "TRACE_JS_SCRIPT_DUMP": "1",
        "TRACE_VM_WINDOW": "0", "TRACE_OPCODE": "0", "TRACE_VM_STEP": "0",
        "TRACE_WASM": "0", "TRACE_WASM_DUMP": "0", "TRACE_WASM_INSN": "0",
    }
    for key, value in expected.items():
        assert env.get(key) == value, (key, env.get(key), value)
    assert payload["cookie_fields"] == "cf_clearance"
    assert payload["options"]["cookie_fields"] == "cf_clearance"
    assert all(payload[key] == "__disabled__" for key in ["query_fields", "body_fields", "header_fields"])
    assert not any(payload["vm"][key] for key in ["opcode", "vm_window", "vm_step", "unlimited"])
    assert not payload["options"]["script_contains"]
    assert not payload["options"]["function_contains"]
    assert not payload["reuse_trace"] and payload["trace_start"] == "active"
    for key in ["trace_dir", "profile_dir"]:
        assert Path(payload[key]).is_relative_to(CASE), key
    assert Path(payload["firefox_bin"]).is_file()
    assert not Path(payload["trace_dir"]).exists(), "Use a fresh output directory; do not overwrite an existing capture"
    report = {
        "schema": "cell.config_verification.v1", "passed": True,
        "loader": "TraceDesktopApp.apply_agent_config -> open_payload -> resolve_payload_js_mode/resolve_payload_vm -> startup_env_from_payload",
        "presentation": "Tcl variables, no GUI window, no browser, no remote requests",
        "config_sha256": hashlib.sha256((CASE / "agent-next.json").read_bytes()).hexdigest(),
        "checked_environment": expected, "effective_env": env,
        "effective_payload": payload, "js_receipt": js_receipt, "vm_receipt": vm_receipt,
        "runtime_acceptance": str(CASE / "verification/native-smoke-release/acceptance.json"),
        "not_run": ["remote cell rerun"],
    }
    destination = CASE / "verification/config-verification.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": True, "checked_env_keys": len(expected), "report": str(destination)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
