#!/usr/bin/env python3
"""Verify the generic handoff with the real desktop loader, without opening UI."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tkinter as tk

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


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
    desktop = load("collector_v2_desktop", ROOT / "tools/trace-desktop.py")
    config = json.loads((HERE / "agent-next.json").read_text())
    interpreter = tk.Tcl()
    app = desktop.TraceDesktopApp.__new__(desktop.TraceDesktopApp)
    app.tk = interpreter.tk
    source = (ROOT / "tools/trace-desktop.py").read_text()
    for name, kind in re.findall(r"self\.(\w+) = tk\.(StringVar|BooleanVar|IntVar)\(", source):
        setattr(app, name, getattr(tk, kind)(master=interpreter))
    app.module_vars = {name: tk.BooleanVar(master=interpreter) for name in config["modules"]}
    app.field_scope_vars = {name: tk.BooleanVar(master=interpreter) for name in config["ui"]["field_scopes"]}
    app.custom_env_text = TextBuffer()
    app.current_trace_dir = ""
    app.last_status = None
    app.toggle_advanced_options = lambda: None
    app.log = lambda *_: None
    app.apply_agent_config(config, HERE / "agent-next.json")
    payload = app.open_payload()
    server = desktop.server_mod
    payload, _ = server.resolve_payload_js_mode(payload)
    payload, _ = server.resolve_payload_vm(Path(payload["trace_dir"]), payload)
    env = server.startup_env_from_payload(payload)
    expected = {"TRACE_JS_INLINE_PREVIEW_BYTES": "512", "TRACE_JS_VALUE_TRANSPORT_CACHE": "1",
                "TRACE_JS_FULL_SPOOL": "1", "TRACE_JS_MAX_VALUE_BYTES": "0",
                "TRACE_JS_VALUE_STORE_MAX_BYTES": "0", "TRACE_JS_SCRIPT_EVENTS": "1"}
    for key, value in expected.items():
        assert env.get(key) == value, (key, env.get(key), value)
    assert payload["url"] == "about:blank"
    assert payload["cookie_fields"] == "__trace_transport_finished"
    assert Path(payload["firefox_bin"]).is_file()
    for key in ["trace_dir", "profile_dir"]:
        assert Path(payload[key]).is_relative_to(HERE)
        assert not Path(payload[key]).exists(), "Use a fresh output directory"
    report = {"passed": True, "config_sha256": hashlib.sha256((HERE / "agent-next.json").read_bytes()).hexdigest(),
              "loader": "apply_agent_config -> open_payload -> resolve_payload -> startup_env_from_payload",
              "checked": expected, "payload": payload, "effective_env": env}
    (HERE / "config-verification.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("Generic config loader verification passed")


if __name__ == "__main__":
    main()
