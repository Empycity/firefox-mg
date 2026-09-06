#!/usr/bin/env python3
"""Firefox Trace 桌面中控台。

原生 Tk UI：窗口里输入 URL、输出目录、Firefox 路径、勾选采集模块，
后台直接复用 trace-console-server.py 的 TraceConsole 编排逻辑。
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

VENDOR_DIR = pathlib.Path(__file__).resolve().parent / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))
try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:
    DND_FILES = None
    TkinterDnD = None

ROOT = pathlib.Path(os.environ.get("FIREFOX_TRACE_ROOT", pathlib.Path(__file__).resolve().parents[1])).resolve()
SERVER_PATH = ROOT / "tools" / "trace-console-server.py"

spec = importlib.util.spec_from_file_location("firefox_trace_console_server", SERVER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"加载失败：{SERVER_PATH}")
server_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_mod)
TraceConsole = server_mod.TraceConsole
VM_SAFE_DEFAULTS = server_mod.VM_SAFE_DEFAULTS

DEFAULT_FIELDS = "sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest"
DISABLED_FIELDS = "__disabled__"


def find_default_runtime() -> pathlib.Path:
    """Resolve the browser bundle without tying the UI to one app location."""
    configured = os.environ.get("FIREFOX_TRACE_RUNTIME_ROOT", "").strip()
    candidates = []
    if configured:
        candidates.append(pathlib.Path(configured).expanduser())
    candidates.extend(
        [
            ROOT / "firefox-trace-runtime",
            ROOT.parent / "firefox-trace-runtime",
            pathlib.Path("/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime"),
        ]
    )
    for candidate in candidates:
        if (candidate / "Nightly.app/Contents/MacOS/firefox").is_file():
            return candidate.resolve()
    return candidates[0] if candidates else pathlib.Path()


DEFAULT_RUNTIME = find_default_runtime()
DEFAULT_FIREFOX = DEFAULT_RUNTIME / "Nightly.app/Contents/MacOS/firefox"
DEFAULT_TRACE_ROOT = pathlib.Path.home() / "Desktop" / "firefox-trace-outputs"

INTENSITY_PRESETS = {
    "auto": {
        "label": "通用完整值落盘（默认）",
        "object_depth": "1",
        "object_keys": "0",
        "array_items": "0",
        "typed_array_bytes": "0",
        "limit_events": "0",
        "value_store_min_bytes": "1",
        "opcode_limit": str(VM_SAFE_DEFAULTS["opcode_limit"]),
        "opcode_execution_limit": str(VM_SAFE_DEFAULTS["opcode_execution_limit"]),
        "vm_step_limit": str(VM_SAFE_DEFAULTS["vm_step_limit"]),
        "opcode_max_events_per_second": str(VM_SAFE_DEFAULTS["opcode_max_events_per_second"]),
        "opcode_max_bytes_per_second": str(VM_SAFE_DEFAULTS["opcode_max_bytes_per_second"]),
        "ipc_max_events_per_second": str(VM_SAFE_DEFAULTS["ipc_max_events_per_second"]),
        "ipc_max_bytes_per_second": str(VM_SAFE_DEFAULTS["ipc_max_bytes_per_second"]),
        "wasm_dump_max_bytes": str(VM_SAFE_DEFAULTS["wasm_dump_max_bytes"]),
    },
    "hi-fi": {
        "label": "高保真短窗口（更深值预览）",
        "object_depth": "1",
        "object_keys": "0",
        "array_items": "0",
        "typed_array_bytes": "1024",
        "limit_events": "100000",
        "value_store_min_bytes": "1",
        "opcode_limit": "8192",
        "opcode_execution_limit": "131072",
        "vm_step_limit": "4096",
        "opcode_max_events_per_second": "4000",
        "opcode_max_bytes_per_second": "6291456",
        "ipc_max_events_per_second": "9000",
        "ipc_max_bytes_per_second": "6291456",
        "wasm_dump_max_bytes": "2097152",
    },
    "near-full": {
        "label": "近全量短窗口（更大对象/制品）",
        "object_depth": "2",
        "object_keys": "0",
        "array_items": "0",
        "typed_array_bytes": "8192",
        "limit_events": "300000",
        "value_store_min_bytes": "1",
        "opcode_limit": "20000",
        "opcode_execution_limit": "250000",
        "vm_step_limit": "12000",
        "opcode_max_events_per_second": "12000",
        "opcode_max_bytes_per_second": "8388608",
        "ipc_max_events_per_second": "12000",
        "ipc_max_bytes_per_second": "8388608",
        "wasm_dump_max_bytes": "4194304",
    },
}
INTENSITY_LABEL_TO_KEY = {value["label"]: key for key, value in INTENSITY_PRESETS.items()}

TRACE_START_CHOICES = {
    "打开即记录（捕获加载 JS / Script，推荐查链路）": "active",
    "打开后暂停（先登录/准备，再手动开始）": "paused",
    "预热记录（prewarm）": "prewarm",
}

# The desktop first-pass workflow deliberately has only two plans.  The
# backend still accepts its narrower analysis presets through Agent JSON, but
# users should not have to choose internal SpiderMonkey collection profiles.
PLAN_LABELS = {
    "全量 trace（默认：连续 JS/value/网络/环境）": "full-chain",
    "轻量 trace（快速发现页面链路）": "discover-light",
}
PLAN_KEY_TO_LABEL = {value: key for key, value in PLAN_LABELS.items()}

MODULE_LABELS = [
    ("js", "JS 调用"),
    ("xhr", "XHR"),
    ("fetch", "Fetch"),
    ("dom", "DOM / BOM"),
    ("cookie", "Cookie"),
    ("storage", "Storage"),
    ("script", "Script artifact"),
    ("ws", "WebSocket"),
    ("http_raw", "Raw HTTP"),
]

CATEGORY_ORDER = [
    "dom",
    "bom",
    "js",
    "network",
    "state",
    "script",
    "worker",
    "wasm-vm",
    "control-health",
]


def now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def parse_env_lines(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            env[key] = value
    return env


AGENT_CONFIG_SCHEMA = "firefox_trace.agent_config.v1"
AGENT_CONFIG_KIND = "agent-next"

# These are the fields rendered by the desktop form.  Keeping the list next to
# the loader makes the file format explicit and prevents a newly added visible
# control from being silently omitted from an Agent handoff.
AGENT_UI_KEYS = (
    "url",
    "trace_dir",
    "firefox_bin",
    "profile_dir",
    "label",
    "plan",
    "preset",
    "trace_start",
    "trace_start_label",
    "reuse_trace",
    "query_fields",
    "body_fields",
    "header_fields",
    "cookie_fields",
    "field_scopes",
    "intensity",
    "intensity_key",
    "unlimited_trace",
    "show_advanced",
    "vm_stage",
)
AGENT_OPTION_KEYS = (
    "profile",
    "js_mode",
    "script_contains",
    "script_sha256",
    "function_contains",
    "target_match",
    "query_fields",
    "body_fields",
    "header_fields",
    "cookie_fields",
    "object_depth",
    "object_keys",
    "array_items",
    "typed_array_bytes",
    "value_metadata",
    "primitive_metadata",
    "value_store_min_bytes",
    "value_store_max_bytes",
    "deferred_value_capture",
    "deferred_value_pool_bytes",
    "boundary_buffer_events",
    "limit_events",
)
AGENT_VM_KEYS = (
    "vm_window",
    "vm_window_records",
    "opcode",
    "opcode_operands",
    "opcode_stack",
    "opcode_stack_primitives",
    "vm_step",
    "wasm_module",
    "wasm_dump",
    "wasm_insn",
    "unlimited",
    "script_contains",
    "script_sha256",
    "pc_range",
    "script_line",
    "script_column",
    "script_bytecode_length",
    "dispatch_pc",
    "opcode_limit",
    "opcode_execution_limit",
    "vm_step_limit",
    "opcode_max_events_per_second",
    "opcode_max_bytes_per_second",
    "ipc_max_events_per_second",
    "ipc_max_bytes_per_second",
    "opcode_stack_slots",
    "wasm_module_limit",
    "wasm_preview_bytes",
    "wasm_dump_max_bytes",
    "wasm_insn_limit",
)


def config_bool(value: object, default: bool = False) -> bool:
    """Parse JSON/env-style booleans without treating ``"false"`` as true."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "enabled"}:
        return True
    if text in {"0", "false", "no", "off", "disabled", ""}:
        return False
    return default


def _config_section(data: object) -> dict[str, object]:
    return dict(data) if isinstance(data, dict) else {}


def normalize_agent_config(data: object) -> dict[str, object]:
    """Normalize an Agent handoff JSON file to the v1 shape.

    The canonical format stores visible form values under ``ui`` and runtime
    values under ``modules``, ``options``, ``vm`` and ``env``.  For convenient
    hand-written files we also accept the same keys at the top level and accept
    ``env`` either as an object or as ``NAME=VALUE`` text.
    """
    if not isinstance(data, dict):
        raise ValueError("Agent 配置必须是 JSON 对象")

    schema = str(data.get("schema") or AGENT_CONFIG_SCHEMA).strip()
    if schema != AGENT_CONFIG_SCHEMA:
        raise ValueError(f"不支持的 Agent 配置 schema：{schema}")

    raw_ui = _config_section(data.get("ui"))
    # Accept a flat file as well as the documented nested form.  This keeps
    # files easy for an Agent to generate while preserving an unambiguous v1
    # schema for future versions.
    for key in AGENT_UI_KEYS:
        if key in data and key not in raw_ui:
            raw_ui[key] = data[key]
    if "field_scopes" not in raw_ui and "field_scopes" in data:
        raw_ui["field_scopes"] = data["field_scopes"]

    modules = _config_section(data.get("modules"))
    options = _config_section(data.get("options"))
    vm = _config_section(data.get("vm"))
    nested_modules = _config_section(raw_ui.pop("modules", None))
    nested_options = _config_section(raw_ui.pop("options", None))
    nested_vm = _config_section(raw_ui.pop("vm", None))
    for key, value in nested_modules.items():
        modules.setdefault(key, value)
    for key, value in nested_options.items():
        options.setdefault(key, value)
    for key, value in nested_vm.items():
        vm.setdefault(key, value)
    # Also accept a flat handoff where runtime options sit beside the UI
    # fields.  Explicit nested sections take precedence.
    for key in AGENT_OPTION_KEYS:
        if key in data:
            options.setdefault(key, data[key])
    for key in AGENT_VM_KEYS:
        if key in data:
            vm.setdefault(key, data[key])
    raw_env = data.get("env", raw_ui.pop("env", {}))
    if isinstance(raw_env, str):
        env = parse_env_lines(raw_env)
    else:
        env = {
            str(key): str(value)
            for key, value in _config_section(raw_env).items()
            if value is not None
        }
    env_text = data.get("env_text")
    if env_text is not None and not isinstance(env_text, str):
        env_text = str(env_text)

    return {
        "schema": AGENT_CONFIG_SCHEMA,
        "kind": str(data.get("kind") or AGENT_CONFIG_KIND),
        "version": 1,
        "ui": raw_ui,
        "modules": modules,
        "options": options,
        "vm": vm,
        "env": env,
        "env_text": env_text,
        "meta": _config_section(data.get("meta")),
    }


def env_text_from_mapping(env: dict[str, str]) -> str:
    """Render an env mapping without shell quoting.

    Values such as ``=jr,=get`` intentionally keep their leading equals; the
    UI parser splits only on the first equals sign.
    """
    return "\n".join(f"{key}={value}" for key, value in env.items()) + ("\n" if env else "")


class ScrollFrame(ttk.Frame):
    def __init__(self, master, *, background: str = "#eef8ff", body_style: str | None = None):
        super().__init__(master)
        self.canvas = tk.Canvas(self, highlightthickness=0, borderwidth=0, background=background)
        self.scrollbar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.body = ttk.Frame(self.canvas, style=body_style) if body_style else ttk.Frame(self.canvas)
        self.window_id = self.canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.canvas.configure(yscrollcommand=self.scrollbar.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.scrollbar.grid(row=0, column=1, sticky="ns")
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)
        self.body.bind("<Configure>", self._on_body_configure)
        self.canvas.bind("<Configure>", self._on_canvas_configure)
        # macOS Tk 的 MouseWheel delta 常见为 ±1，不能按 Windows 的 120 固定缩放。
        # 绑定到全局后再判断鼠标是否在本 ScrollFrame 内，这样鼠标放在左侧任意控件
        # 上滚轮/触控板都能滚动左侧配置区。
        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel, add="+")
        self.canvas.bind_all("<Button-4>", self._on_linux_scroll_up, add="+")
        self.canvas.bind_all("<Button-5>", self._on_linux_scroll_down, add="+")

    def _on_body_configure(self, _event):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas_configure(self, event):
        self.canvas.itemconfigure(self.window_id, width=event.width)

    def _pointer_inside(self) -> bool:
        x, y = self.winfo_pointerxy()
        left = self.canvas.winfo_rootx()
        top = self.canvas.winfo_rooty()
        return left <= x <= left + self.canvas.winfo_width() and top <= y <= top + self.canvas.winfo_height()

    def _scroll_units_from_delta(self, delta: int) -> int:
        if delta == 0:
            return 0
        if abs(delta) < 120:
            return -1 if delta > 0 else 1
        units = int(-delta / 120)
        return units or (-1 if delta > 0 else 1)

    def _on_mousewheel(self, event):
        if not self._pointer_inside():
            return None
        units = self._scroll_units_from_delta(int(getattr(event, "delta", 0) or 0))
        if units:
            self.canvas.yview_scroll(units, "units")
            return "break"
        return None

    def _on_linux_scroll_up(self, _event):
        if self._pointer_inside():
            self.canvas.yview_scroll(-1, "units")
            return "break"
        return None

    def _on_linux_scroll_down(self, _event):
        if self._pointer_inside():
            self.canvas.yview_scroll(1, "units")
            return "break"
        return None

VM_STAGE_CHOICES = [
    "一轮还原模式（推荐：请求触发回溯）",
    "VM window：目标触发环形缓冲",
    "局部 opcode：自动候选脚本",
    "VM step：已确认 dispatcher",
    "默认关闭 VM（普通 full-chain）",
    "WASM：只看模块元数据",
]


class TraceDesktopApp(TkinterDnD.Tk if TkinterDnD else tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Firefox Trace 桌面中控台")
        try:
            self._icon_image = tk.PhotoImage(file=str(ROOT / "Firefox Trace Console.app" / "Contents" / "Resources" / "TraceConsole.iconset" / "icon_32x32@2x.png"))
            self.iconphoto(True, self._icon_image)
        except tk.TclError:
            self._icon_image = None
        self.geometry("1180x820")
        self.minsize(980, 680)

        self.console = TraceConsole(DEFAULT_TRACE_ROOT)
        self.worker_queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self.busy = False
        self.current_trace_dir = ""
        self.status_timer = ""
        self.last_status: dict | None = None
        self.last_discovery_signature = ""

        self._setup_style()
        self._build_ui()
        self._bind_file_drop_tree(self)
        self._bind_shortcuts()
        self.after(250, self._poll_worker_queue)
        self.after(1000, self.refresh_status_loop)
        self.protocol("WM_DELETE_WINDOW", self.on_window_close)

    def _setup_style(self):
        self.colors = {
            "app": "#eef8ff",
            "panel": "#ffffff",
            "panel2": "#f7fbff",
            "line": "#cfe8ff",
            "text": "#123047",
            "muted": "#5f7f99",
            "primary": "#2f9bff",
            "primary_dark": "#0b6fd3",
            "accent": "#49d3ff",
            "ok": "#10b981",
        }
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        c = self.colors
        style.configure("TFrame", background=c["app"])
        style.configure("Panel.TFrame", background=c["panel"], relief="flat")
        style.configure("Soft.TFrame", background=c["panel2"], relief="flat")
        style.configure("TLabel", background=c["app"], foreground=c["text"], font=("Helvetica", 12))
        style.configure("Muted.TLabel", background=c["panel"], foreground=c["muted"], font=("Helvetica", 11))
        style.configure("Panel.TLabel", background=c["panel"], foreground=c["text"], font=("Helvetica", 12))
        style.configure("Title.TLabel", background=c["app"], foreground=c["primary_dark"], font=("Helvetica", 22, "bold"))
        style.configure("Subtitle.TLabel", background=c["app"], foreground=c["muted"], font=("Helvetica", 12))
        style.configure("Section.TLabel", background=c["panel"], foreground=c["primary_dark"], font=("Helvetica", 15, "bold"))
        style.configure("Metric.TLabel", background=c["panel"], foreground=c["primary_dark"], font=("Menlo", 13, "bold"))
        style.configure("TCheckbutton", background=c["panel"], foreground=c["text"], font=("Helvetica", 12))
        style.configure("TRadiobutton", background=c["panel"], foreground=c["text"], font=("Helvetica", 12))
        style.configure("TButton", font=("Helvetica", 12), padding=(12, 7), background="#e5f3ff", foreground=c["primary_dark"], bordercolor=c["line"], focusthickness=1, focuscolor=c["accent"])
        style.configure("Primary.TButton", font=("Helvetica", 13, "bold"), padding=(16, 9), background=c["primary"], foreground="#ffffff", bordercolor=c["primary"] )
        style.configure("Danger.TButton", font=("Helvetica", 12, "bold"), padding=(12, 7), background="#fee2e2", foreground="#b91c1c")
        style.configure("TEntry", fieldbackground="#f8fcff", foreground=c["text"], bordercolor=c["line"], lightcolor=c["line"], darkcolor=c["line"])
        style.configure("TCombobox", fieldbackground="#f8fcff", foreground=c["text"], bordercolor=c["line"], arrowcolor=c["primary_dark"])
        style.configure("Horizontal.TScrollbar", background="#d9efff", troughcolor="#f1f9ff", bordercolor=c["line"], arrowcolor=c["primary_dark"])
        style.map("TButton", foreground=[("disabled", "#9eb3c7")], background=[("active", "#d8efff")])
        style.map("Primary.TButton", background=[("active", c["primary_dark"]), ("disabled", "#b9dcf8")])

    def _build_ui(self):
        self.configure(bg=self.colors["app"])
        root = ttk.Frame(self, padding=18)
        root.grid(row=0, column=0, sticky="nsew")
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=1)

        header = ttk.Frame(root)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="Firefox Trace 桌面中控台", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            header,
            text="输入 URL → 选择输出目录 → 勾选 trace → 打开 Firefox → 手动操作 → 开始/暂停/停止整理",
            style="Subtitle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))

        paned = tk.PanedWindow(
            root,
            orient=tk.HORIZONTAL,
            sashwidth=10,
            sashrelief=tk.RAISED,
            showhandle=True,
            bg=self.colors["line"],
            bd=0,
            opaqueresize=True,
        )
        paned.grid(row=1, column=0, sticky="nsew")
        self.main_paned = paned

        left = ScrollFrame(paned)
        self.left_scroll = left
        right = ScrollFrame(
            paned,
            background=self.colors["panel"],
            body_style="Panel.TFrame",
        )
        right.body.configure(padding=14)
        self.right_scroll = right
        right_body = right.body
        right_body.columnconfigure(0, weight=1)
        right_body.rowconfigure(7, weight=1)
        paned.add(left, minsize=620, stretch="always")
        paned.add(right, minsize=460, stretch="always")

        self._build_config(left.body)
        self._build_actions(right_body)
        self._build_status(right_body)
        self._build_log(right_body)
        self.after(120, lambda: self.main_paned.sash_place(0, max(680, self.winfo_width() // 2), 0))

    def _bind_click_only_combobox(self, box: ttk.Combobox) -> None:
        """Route wheel input to the form instead of changing a combobox value."""
        box.bind("<MouseWheel>", self._on_combobox_mousewheel)
        box.bind("<Button-4>", lambda event: self._on_combobox_button_scroll(event, -1))
        box.bind("<Button-5>", lambda event: self._on_combobox_button_scroll(event, 1))

    def _on_combobox_mousewheel(self, event):
        for scroll in (self.left_scroll, self.right_scroll):
            if scroll._pointer_inside():
                scroll._on_mousewheel(event)
                break
        return "break"

    def _on_combobox_button_scroll(self, _event, units: int):
        for scroll in (self.left_scroll, self.right_scroll):
            if scroll._pointer_inside():
                scroll.canvas.yview_scroll(units, "units")
                break
        return "break"

    def _panel(self, parent, title: str, row: int):
        frame = ttk.Frame(parent, style="Panel.TFrame", padding=16)
        frame.grid(row=row, column=0, sticky="ew", pady=(0, 14), padx=(0, 8))
        parent.columnconfigure(0, weight=1)
        frame.columnconfigure(0, weight=0)
        for column in (1, 2, 3):
            frame.columnconfigure(column, weight=1, uniform="form")
        ttk.Label(frame, text=title, style="Section.TLabel").grid(row=0, column=0, columnspan=4, sticky="w", pady=(0, 12))
        return frame

    def _entry_row(self, parent, row: int, label: str, var: tk.StringVar, browse: str | None = None):
        ttk.Label(parent, text=label, style="Panel.TLabel").grid(row=row, column=0, sticky="w", pady=4)
        entry = ttk.Entry(parent, textvariable=var)
        entry.grid(row=row, column=1, columnspan=2 if browse else 3, sticky="ew", padx=(10, 0), pady=4)
        if browse:
            ttk.Button(parent, text="选择…", command=lambda: self.browse_path(var, browse)).grid(row=row, column=3, sticky="ew", padx=(8, 0), pady=4)
        return entry

    def _field_row(self, parent, row: int, label: str, var: tk.StringVar, enabled_var: tk.BooleanVar):
        ttk.Checkbutton(parent, text=label, variable=enabled_var).grid(row=row, column=0, sticky="w", pady=4)
        entry = ttk.Entry(parent, textvariable=var)
        entry.grid(row=row, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        return entry

    def _auto_row(self, parent, row: int, label: str, var: tk.StringVar):
        """Display an analyzer-owned value without asking the user to guess it."""
        ttk.Label(parent, text=label, style="Panel.TLabel").grid(row=row, column=0, sticky="w", pady=4)
        entry = ttk.Entry(parent, textvariable=var, state="readonly")
        entry.grid(row=row, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        entry.bind("<FocusIn>", lambda _event: entry.xview_moveto(1.0))
        var.trace_add(
            "write",
            lambda *_args, widget=entry: widget.after_idle(
                lambda: widget.xview_moveto(1.0)
            ),
        )
        return entry

    def _path_row(self, parent, row: int, label: str, var: tk.StringVar, browse: str | None = None):
        ttk.Label(parent, text=label, style="Panel.TLabel").grid(row=row, column=0, columnspan=4, sticky="w", pady=(8, 2))
        holder = ttk.Frame(parent, style="Panel.TFrame")
        holder.grid(row=row + 1, column=0, columnspan=4, sticky="ew", pady=(0, 8))
        holder.columnconfigure(0, weight=1)
        entry = ttk.Entry(holder, textvariable=var)
        entry.grid(row=0, column=0, sticky="ew")
        if browse:
            ttk.Button(holder, text="选择", command=lambda: self.browse_path(var, browse)).grid(row=0, column=1, padx=(10, 0))
        ttk.Button(holder, text="复制", command=lambda: self.copy_text(var.get())).grid(row=0, column=2, padx=(6, 0))
        bar = ttk.Scrollbar(holder, orient="horizontal", command=entry.xview)
        entry.configure(xscrollcommand=bar.set)
        bar.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        entry.bind("<FocusIn>", lambda _event: entry.xview_moveto(1.0))
        var.trace_add("write", lambda *_args, widget=entry: widget.after_idle(lambda: widget.xview_moveto(1.0)))
        return entry

    def _build_config(self, parent):
        # Once an Agent handoff is loaded, keep its script/function/hash
        # filters authoritative for the next segment.  The periodic status
        # refresh also renders target-candidates.json; without this guard an
        # older candidate from the previous segment can silently overwrite a
        # freshly loaded narrow config before "应用配置" is sent.
        self.agent_config_loaded = False
        self.url_var = tk.StringVar(value="about:blank")
        self.trace_dir_var = tk.StringVar(value=str(DEFAULT_TRACE_ROOT / f"firefox-trace-{now_stamp()}"))
        self.profile_dir_var = tk.StringVar(value="")
        self.firefox_bin_var = tk.StringVar(value=str(DEFAULT_FIREFOX if DEFAULT_FIREFOX.exists() else ""))
        self.label_var = tk.StringVar(value="manual")
        self.plan_var = tk.StringVar(value=PLAN_KEY_TO_LABEL["full-chain"])
        self.trace_start_var = tk.StringVar(value="打开即记录（捕获加载 JS / Script，推荐查链路）")
        self.query_fields_var = tk.StringVar(value=DEFAULT_FIELDS)
        self.body_fields_var = tk.StringVar(value=DEFAULT_FIELDS)
        self.header_fields_var = tk.StringVar(value=DEFAULT_FIELDS)
        self.cookie_fields_var = tk.StringVar(value=DEFAULT_FIELDS)
        self.reuse_trace_var = tk.BooleanVar(value=False)
        self.intensity_var = tk.StringVar(value=INTENSITY_PRESETS["auto"]["label"])
        self.show_advanced_var = tk.BooleanVar(value=False)
        self.unlimited_trace_var = tk.BooleanVar(value=True)
        self.vm_unlimited_var = tk.BooleanVar(value=False)
        self.vm_stage_var = tk.StringVar(value="默认关闭 VM（普通 full-chain）")
        self.field_scope_vars = {
            "query": tk.BooleanVar(value=True),
            "body": tk.BooleanVar(value=True),
            "header": tk.BooleanVar(value=True),
            "cookie": tk.BooleanVar(value=True),
        }

        panel = self._panel(parent, "① 会话", 0)
        self._entry_row(panel, 1, "目标 URL", self.url_var)
        self._path_row(panel, 2, "输出目录", self.trace_dir_var, "directory")
        self._path_row(panel, 4, "Firefox 可执行文件", self.firefox_bin_var, "file")
        self._path_row(panel, 6, "Profile 目录（空=临时）", self.profile_dir_var, "directory")
        self._entry_row(panel, 8, "记录标签", self.label_var)
        ttk.Label(panel, text="启动模式", style="Panel.TLabel").grid(row=9, column=0, sticky="w", pady=4)
        start_box = ttk.Combobox(panel, textvariable=self.trace_start_var, values=list(TRACE_START_CHOICES), state="readonly")
        start_box.grid(row=9, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        self._bind_click_only_combobox(start_box)
        ttk.Checkbutton(panel, text="复用已有输出目录", variable=self.reuse_trace_var).grid(row=10, column=1, sticky="w", padx=(10, 0), pady=4)
        ttk.Button(panel, text="新建时间戳目录", command=self.new_trace_dir).grid(row=10, column=2, sticky="w", padx=(8, 0), pady=4)

        panel = self._panel(parent, "② 首轮采集 / 目标字段", 1)
        ttk.Label(panel, text="采集计划", style="Panel.TLabel").grid(row=1, column=0, sticky="w", pady=4)
        plan_box = ttk.Combobox(panel, textvariable=self.plan_var, values=list(PLAN_LABELS), state="readonly")
        plan_box.grid(row=1, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        self._bind_click_only_combobox(plan_box)
        plan_box.bind("<<ComboboxSelected>>", lambda _event: self.apply_capture_plan())
        self._field_row(panel, 2, "URL Query 字段", self.query_fields_var, self.field_scope_vars["query"])
        self._field_row(panel, 3, "POST Body 字段", self.body_fields_var, self.field_scope_vars["body"])
        self._field_row(panel, 4, "Request Header 字段", self.header_fields_var, self.field_scope_vars["header"])
        self._field_row(panel, 5, "Cookie 字段", self.cookie_fields_var, self.field_scope_vars["cookie"])
        ttk.Label(panel, text="采集强度（高级）", style="Panel.TLabel").grid(row=6, column=0, sticky="w", pady=4)
        intensity_box = ttk.Combobox(
            panel,
            textvariable=self.intensity_var,
            values=[item["label"] for item in INTENSITY_PRESETS.values()],
            state="readonly",
        )
        intensity_box.grid(row=6, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        self._bind_click_only_combobox(intensity_box)
        intensity_box.bind("<<ComboboxSelected>>", lambda _event: self.apply_intensity_to_form())
        ttk.Checkbutton(
            panel,
            text="普通 JS trace 不设总数保险丝（高级）",
            variable=self.unlimited_trace_var,
        ).grid(row=7, column=1, columnspan=3, sticky="w", padx=(10, 0), pady=4)
        ttk.Checkbutton(
            panel,
            text="显示高级 / Agent 配置（模块、JS、VM、环境变量）",
            variable=self.show_advanced_var,
            command=self.toggle_advanced_options,
        ).grid(row=8, column=1, columnspan=3, sticky="w", padx=(10, 0), pady=4)
        ttk.Label(
            panel,
            text="全量：连续 JS/value、网络、脚本和环境完整保留，异步批量写盘，VM/WASM 默认关闭。轻量：先快速发现请求和脚本链路。",
            style="Muted.TLabel",
            wraplength=760,
        ).grid(row=9, column=0, columnspan=4, sticky="ew", pady=(8, 0))
        agent_toolbar = ttk.Frame(panel, style="Panel.TFrame")
        agent_toolbar.grid(row=10, column=0, columnspan=4, sticky="ew", pady=(8, 0))
        ttk.Button(
            agent_toolbar,
            text="加载 Agent 完整配置…",
            command=self.load_agent_config_file,
        ).grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Button(
            agent_toolbar,
            text="加载当前目录 agent-next.json",
            command=self.load_default_agent_config,
        ).grid(row=0, column=1, sticky="w", padx=(0, 8))
        ttk.Label(
            agent_toolbar,
            text="一次填充会话、字段、模块、JS、VM 和 env；首轮没有文件时留空即可。",
            style="Muted.TLabel",
        ).grid(row=0, column=2, sticky="w")
        self.agent_drop_target = tk.Label(
            agent_toolbar,
            text="拖入 agent-next.json",
            bg="#f8fcff",
            fg="#0b6fd3",
            padx=10,
            pady=6,
            highlightthickness=1,
            highlightbackground="#9ed3ff",
        )
        self.agent_drop_target.grid(row=0, column=3, sticky="e")

        panel = self._panel(parent, "③ 模块开关（高级）", 2)
        self.modules_advanced_panel = panel
        self.module_vars: dict[str, tk.BooleanVar] = {}
        for i, (key, label) in enumerate(MODULE_LABELS):
            var = tk.BooleanVar(value=(key != "http_raw"))
            self.module_vars[key] = var
            ttk.Checkbutton(panel, text=label, variable=var).grid(row=1 + i // 3, column=i % 3, sticky="w", padx=(0, 18), pady=4)

        panel = self._panel(parent, "④ JS Call / 值采集（高级）", 3)
        self.js_advanced_panel = panel
        self.js_mode_var = tk.StringVar(value="boundary")
        self.target_match_var = tk.StringVar(value="auto")
        self.script_contains_var = tk.StringVar(value="")
        self.script_sha256_var = tk.StringVar(value="")
        self.function_contains_var = tk.StringVar(value="")
        self.object_depth_var = tk.StringVar(value="1")
        self.object_keys_var = tk.StringVar(value="0")
        self.array_items_var = tk.StringVar(value="0")
        self.typed_array_bytes_var = tk.StringVar(value="0")
        self.limit_events_var = tk.StringVar(value="50000")
        self.value_metadata_var = tk.StringVar(value="1")
        self.primitive_metadata_var = tk.StringVar(value="1")
        self.value_store_min_bytes_var = tk.StringVar(value="1")
        self.deferred_value_capture_var = tk.StringVar(value="1")
        self.deferred_value_pool_bytes_var = tk.StringVar(value=str(64 * 1024 * 1024))
        self.boundary_buffer_events_var = tk.StringVar(value="8192")
        row = 1
        js_modes = [
            ("boundary：首轮调用边界", "boundary"),
            ("target：目标脚本/函数", "target"),
            ("deep：局部调用树", "deep"),
            ("off：关闭", "off"),
        ]
        for col, (text, value) in enumerate(js_modes):
            ttk.Radiobutton(
                panel,
                text=text,
                variable=self.js_mode_var,
                value=value,
            ).grid(row=row, column=col, sticky="w", pady=4)
        row += 1
        ttk.Label(
            panel,
            text="脚本、函数和目标匹配范围由请求调用链自动确定；这里不需要填写关键词。",
            style="Muted.TLabel",
            wraplength=760,
        ).grid(row=row, column=0, columnspan=4, sticky="ew", pady=(2, 8))
        row += 1
        grid = ttk.Frame(panel, style="Panel.TFrame")
        grid.grid(row=row, column=0, columnspan=4, sticky="ew")
        for c in range(4):
            grid.columnconfigure(c, weight=1)
        smalls = [
            ("对象深度（0=只记类型）", self.object_depth_var),
            ("对象 keys（0=全量）", self.object_keys_var),
            ("数组 items（0=全量）", self.array_items_var),
            ("TypedArray bytes（0=全量）", self.typed_array_bytes_var),
            ("事件保险丝（0=不限）", self.limit_events_var),
            ("值 metadata", self.value_metadata_var),
            ("primitive metadata", self.primitive_metadata_var),
            ("值落盘最小字节", self.value_store_min_bytes_var),
            ("命中后延迟落盘（1=开）", self.deferred_value_capture_var),
            ("延迟值池 bytes", self.deferred_value_pool_bytes_var),
            ("请求回溯窗口 events", self.boundary_buffer_events_var),
        ]
        for i, (label, var) in enumerate(smalls):
            cell = ttk.Frame(grid, style="Panel.TFrame")
            cell.grid(row=i // 4, column=i % 4, sticky="ew", padx=(0, 8), pady=4)
            ttk.Label(cell, text=label, style="Panel.TLabel").grid(row=0, column=0, sticky="w")
            ttk.Entry(cell, textvariable=var, width=12).grid(row=1, column=0, sticky="ew")

        panel = self._panel(parent, "⑤ VM / WASM 细粒度（高级）", 4)
        self.vm_panel = panel
        ttk.Label(panel, text="VM/JSVMP 阶段预设", style="Panel.TLabel").grid(row=1, column=0, sticky="w", pady=(0, 8))
        vm_stage_box = ttk.Combobox(panel, textvariable=self.vm_stage_var, values=VM_STAGE_CHOICES, state="readonly")
        vm_stage_box.grid(row=1, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=(0, 8))
        self._bind_click_only_combobox(vm_stage_box)
        vm_stage_box.bind("<<ComboboxSelected>>", lambda _event: self.apply_vm_stage_preset())
        self.vm_opcode_var = tk.BooleanVar(value=False)
        self.vm_window_var = tk.BooleanVar(value=False)
        # VM is opt-in.  Raw operands must also start disabled before any
        # preset/config loader runs, so a partially initialized panel cannot
        # show or submit VM evidence accidentally.
        self.vm_operands_var = tk.BooleanVar(value=False)
        self.vm_stack_var = tk.BooleanVar(value=False)
        self.vm_stack_primitive_var = tk.BooleanVar(value=False)
        self.vm_step_var = tk.BooleanVar(value=False)
        self.vm_wasm_module_var = tk.BooleanVar(value=False)
        self.vm_wasm_dump_var = tk.BooleanVar(value=False)
        self.vm_wasm_insn_var = tk.BooleanVar(value=False)
        checks = [
            ("VM window", self.vm_window_var),
            ("JS opcode", self.vm_opcode_var),
            ("raw operands", self.vm_operands_var),
            ("栈 slot 类型", self.vm_stack_var),
            ("栈 primitive 值", self.vm_stack_primitive_var),
            ("VM step", self.vm_step_var),
            ("WASM module 元数据", self.vm_wasm_module_var),
            ("WASM 模块 artifact", self.vm_wasm_dump_var),
            ("WASM raw bytes", self.vm_wasm_insn_var),
        ]
        for i, (label, var) in enumerate(checks):
            ttk.Checkbutton(panel, text=label, variable=var, command=self.sync_vm_dependencies).grid(row=2 + i // 3, column=i % 3, sticky="w", padx=(0, 12), pady=4)
        ttk.Checkbutton(
            panel,
            text="VM/opcode 也不截断（TRACE_UNSAFE_ALLOW=1；只建议目标脚本+短操作）",
            variable=self.vm_unlimited_var,
            command=self.sync_vm_dependencies,
        ).grid(row=5, column=0, columnspan=4, sticky="w", pady=(8, 4))
        self.vm_script_contains_var = tk.StringVar(value="")
        self.vm_pc_range_var = tk.StringVar(value="")
        self.vm_script_line_var = tk.StringVar(value="")
        self.vm_script_column_var = tk.StringVar(value="")
        self.vm_bytecode_length_var = tk.StringVar(value="")
        self.vm_dispatch_pc_var = tk.StringVar(value="")
        self.vm_window_records_var = tk.StringVar(
            value=str(VM_SAFE_DEFAULTS["vm_window_records"])
        )
        self.vm_opcode_limit_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["opcode_limit"]))
        self.vm_opcode_execution_limit_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["opcode_execution_limit"]))
        self.vm_step_limit_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["vm_step_limit"]))
        self.vm_opcode_rate_events_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["opcode_max_events_per_second"]))
        self.vm_opcode_rate_bytes_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["opcode_max_bytes_per_second"]))
        self.vm_ipc_rate_events_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["ipc_max_events_per_second"]))
        self.vm_ipc_rate_bytes_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["ipc_max_bytes_per_second"]))
        self.vm_stack_slots_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["opcode_stack_slots"]))
        self.vm_wasm_module_limit_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["wasm_module_limit"]))
        self.vm_wasm_preview_bytes_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["wasm_preview_bytes"]))
        self.vm_wasm_dump_max_bytes_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["wasm_dump_max_bytes"]))
        self.vm_wasm_insn_limit_var = tk.StringVar(value=str(VM_SAFE_DEFAULTS["wasm_insn_limit"]))
        row = 6
        ttk.Label(
            panel,
            text="一轮还原模式默认不开全站 opcode：靠请求命中触发 JS/value/source 环形缓冲回溯；opcode/VM step 只作为局部补充。",
            style="Muted.TLabel",
            wraplength=760,
        ).grid(row=row, column=0, columnspan=4, sticky="ew", pady=(2, 8))
        row += 1
        grid2 = ttk.Frame(panel, style="Panel.TFrame")
        self.vm_limits_grid = grid2
        grid2.grid(row=row, column=0, columnspan=4, sticky="ew", pady=(6, 0))
        for c in range(4):
            grid2.columnconfigure(c, weight=1)
        vm_smalls = [
            ("VM window records", self.vm_window_records_var),
            ("script line", self.vm_script_line_var),
            ("script column", self.vm_script_column_var),
            ("bytecode length", self.vm_bytecode_length_var),
            ("stack slots", self.vm_stack_slots_var),
            ("opcode 上限", self.vm_opcode_limit_var),
            ("opcode 执行预算", self.vm_opcode_execution_limit_var),
            ("VM step 上限", self.vm_step_limit_var),
            ("opcode events/s", self.vm_opcode_rate_events_var),
            ("opcode bytes/s", self.vm_opcode_rate_bytes_var),
            ("IPC events/s", self.vm_ipc_rate_events_var),
            ("IPC bytes/s", self.vm_ipc_rate_bytes_var),
            ("WASM module 上限", self.vm_wasm_module_limit_var),
            ("WASM preview bytes", self.vm_wasm_preview_bytes_var),
            ("WASM dump max bytes", self.vm_wasm_dump_max_bytes_var),
            ("WASM insn 上限", self.vm_wasm_insn_limit_var),
        ]
        for i, (label, var) in enumerate(vm_smalls):
            cell = ttk.Frame(grid2, style="Panel.TFrame")
            cell.grid(row=i // 4, column=i % 4, sticky="ew", padx=(0, 8), pady=4)
            ttk.Label(cell, text=label, style="Panel.TLabel").grid(row=0, column=0, sticky="w")
            ttk.Entry(cell, textvariable=var, width=12).grid(row=1, column=0, sticky="ew")
        row += 4
        self.vm_hint_var = tk.StringVar(value="脚本身份、PC 范围和 dispatcher PC 由请求调用链与 analyzer 自动推导；你只需重复同一个目标动作。")
        ttk.Label(panel, textvariable=self.vm_hint_var, style="Muted.TLabel", wraplength=760).grid(row=row, column=0, columnspan=4, sticky="ew", pady=(8, 0))

        panel = self._panel(parent, "⑥ 额外环境变量（高级）", 5)
        self.env_advanced_panel = panel
        env_toolbar = ttk.Frame(panel, style="Panel.TFrame")
        env_toolbar.grid(row=1, column=0, columnspan=4, sticky="ew", pady=(0, 8))
        env_toolbar.columnconfigure(3, weight=1)
        ttk.Button(
            env_toolbar,
            text="加载 env 文件…",
            command=self.load_env_file,
        ).grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Button(
            env_toolbar,
            text="加载当前目录 agent-next.env",
            command=self.load_default_env_file,
        ).grid(row=0, column=1, sticky="w", padx=(0, 8))
        ttk.Button(
            env_toolbar,
            text="清空",
            command=self.clear_env_text,
        ).grid(row=0, column=2, sticky="w", padx=(0, 8))
        ttk.Label(
            env_toolbar,
            text="首轮留空；Agent 分析停止后的 TRACE_DIR，再写 agent-next.env 供下一轮加载。",
            style="Muted.TLabel",
        ).grid(row=0, column=3, sticky="e")
        self.custom_env_text = tk.Text(panel, height=5, bg="#f8fcff", fg="#123047", insertbackground="#123047", relief="flat", font=("Menlo", 12), highlightthickness=1, highlightbackground="#cfe8ff")
        self.custom_env_text.grid(row=2, column=0, columnspan=4, sticky="ew")
        self.custom_env_text.insert("1.0", "# 每行 NAME=VALUE\n# full-chain 默认 0=不截断；只在定向轻量采集时填写非零限制\n")
        self.env_drop_target = tk.Label(
            panel,
            text="拖入 agent-next.env 或 .env/.txt 文件",
            bg="#f8fcff",
            fg="#0b6fd3",
            padx=10,
            pady=6,
            highlightthickness=1,
            highlightbackground="#9ed3ff",
        )
        self.env_drop_target.grid(row=3, column=0, columnspan=4, sticky="ew", pady=(8, 0))
        self.apply_intensity_to_form()
        self.apply_capture_plan()
        self.toggle_advanced_options()

    def _build_actions(self, parent):
        ttk.Label(parent, text="启动 / 记录", style="Section.TLabel").grid(row=0, column=0, sticky="w")

        mode_card = ttk.Frame(parent, style="Panel.TFrame", padding=14)
        mode_card.grid(row=1, column=0, sticky="ew", pady=(10, 12))
        mode_card.columnconfigure(0, weight=1)
        ttk.Label(
            mode_card,
            text="启动记录方式",
            style="Panel.TLabel",
        ).grid(row=0, column=0, sticky="w")
        ttk.Radiobutton(
            mode_card,
            text="打开网站就开始 trace（抓页面加载期 JS / Script）",
            variable=self.trace_start_var,
            value="打开即记录（捕获加载 JS / Script，推荐查链路）",
        ).grid(row=1, column=0, sticky="w", pady=(8, 2))
        ttk.Radiobutton(
            mode_card,
            text="先打开但暂停，等我点“开始记录”再 trace",
            variable=self.trace_start_var,
            value="打开后暂停（先登录/准备，再手动开始）",
        ).grid(row=2, column=0, sticky="w", pady=2)
        ttk.Radiobutton(
            mode_card,
            text="预热记录 prewarm",
            variable=self.trace_start_var,
            value="预热记录（prewarm）",
        ).grid(row=3, column=0, sticky="w", pady=2)
        ttk.Label(
            mode_card,
            text="查关键字段生成链路建议选第一项；需要先登录、过验证码、准备页面状态时选第二项。",
            style="Muted.TLabel",
            wraplength=420,
        ).grid(row=4, column=0, sticky="ew", pady=(8, 0))

        ttk.Label(parent, text="操作", style="Section.TLabel").grid(row=2, column=0, sticky="w")
        grid = ttk.Frame(parent, style="Panel.TFrame")
        grid.grid(row=3, column=0, sticky="ew", pady=(10, 12))
        for c in range(2):
            grid.columnconfigure(c, weight=1)
        self.open_btn = ttk.Button(grid, text="打开 Firefox", style="Primary.TButton", command=self.open_browser)
        self.config_btn = ttk.Button(grid, text="应用配置", command=self.apply_config)
        self.start_btn = ttk.Button(grid, text="开始记录", style="Primary.TButton", command=self.start_recording)
        self.pause_btn = ttk.Button(grid, text="暂停记录", command=self.pause_recording)
        self.stop_btn = ttk.Button(grid, text="停止并整理", command=self.stop_recording)
        self.close_btn = ttk.Button(grid, text="关闭 Firefox", command=self.close_browser)
        self.open_dir_btn = ttk.Button(grid, text="打开输出目录", command=self.open_output_dir)
        self.new_segment_btn = ttk.Button(grid, text="新分段", command=self.new_segment)
        buttons = [self.open_btn, self.config_btn, self.start_btn, self.pause_btn, self.stop_btn, self.close_btn, self.open_dir_btn, self.new_segment_btn]
        for i, button in enumerate(buttons):
            button.grid(row=i // 2, column=i % 2, sticky="ew", padx=4, pady=4)

    def _build_status(self, parent):
        ttk.Label(parent, text="状态", style="Section.TLabel").grid(row=4, column=0, sticky="w", pady=(8, 0))
        status = ttk.Frame(parent, style="Panel.TFrame")
        status.grid(row=5, column=0, sticky="ew", pady=(10, 12))
        status.columnconfigure(1, weight=1)
        self.phase_var = tk.StringVar(value="idle")
        self.health_var = tk.StringVar(value="ok")
        self.pid_var = tk.StringVar(value="-")
        self.rate_var = tk.StringVar(value="0 ev/s")
        self.total_var = tk.StringVar(value="0 events / 0 bytes")
        self.trace_dir_display_var = tk.StringVar(value="-")
        rows = [
            ("阶段", self.phase_var),
            ("健康", self.health_var),
            ("PID", self.pid_var),
            ("速率", self.rate_var),
            ("累计", self.total_var),
        ]
        for i, (label, var) in enumerate(rows):
            ttk.Label(status, text=label, style="Panel.TLabel").grid(row=i, column=0, sticky="w", pady=3)
            ttk.Label(status, textvariable=var, style="Metric.TLabel", wraplength=360).grid(row=i, column=1, sticky="w", padx=(8, 0), pady=3)
        path_row = len(rows)
        ttk.Label(status, text="目录", style="Panel.TLabel").grid(row=path_row, column=0, sticky="nw", pady=3)
        path_box = ttk.Frame(status, style="Panel.TFrame")
        path_box.grid(row=path_row, column=1, sticky="ew", padx=(8, 0), pady=3)
        path_box.columnconfigure(0, weight=1)
        self.trace_dir_entry = ttk.Entry(path_box, textvariable=self.trace_dir_display_var, state="readonly")
        self.trace_dir_entry.grid(row=0, column=0, sticky="ew")
        ttk.Button(path_box, text="复制", command=lambda: self.copy_text(self.trace_dir_display_var.get())).grid(row=0, column=1, padx=(6, 0))
        path_scroll = ttk.Scrollbar(path_box, orient="horizontal", command=self.trace_dir_entry.xview)
        self.trace_dir_entry.configure(xscrollcommand=path_scroll.set)
        path_scroll.grid(row=1, column=0, sticky="ew", pady=(3, 0))
        self.category_text = tk.Text(status, height=6, bg="#f8fcff", fg="#0b6fd3", relief="flat", font=("Menlo", 11), highlightthickness=1, highlightbackground="#cfe8ff")
        self.category_text.grid(row=path_row + 1, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        self.category_text.configure(state="disabled")
        ttk.Label(status, text="自动推导", style="Panel.TLabel").grid(
            row=path_row + 2,
            column=0,
            columnspan=2,
            sticky="w",
            pady=(10, 3),
        )
        self.discovery_text = tk.Text(
            status,
            height=7,
            bg="#f8fcff",
            fg="#0b6fd3",
            relief="flat",
            font=("Menlo", 10),
            highlightthickness=1,
            highlightbackground="#cfe8ff",
            wrap="word",
        )
        self.discovery_text.grid(
            row=path_row + 3,
            column=0,
            columnspan=2,
            sticky="ew",
            pady=(0, 0),
        )
        self.discovery_text.configure(state="disabled")

    def _build_log(self, parent):
        ttk.Label(parent, text="日志", style="Section.TLabel").grid(row=6, column=0, sticky="nw")
        self.log_text = tk.Text(parent, bg="#f8fcff", fg="#123047", insertbackground="#123047", relief="flat", font=("Menlo", 11), highlightthickness=1, highlightbackground="#cfe8ff")
        self.log_text.grid(row=7, column=0, sticky="nsew", pady=(10, 0))

    def _bind_shortcuts(self):
        self.bind("<Command-r>", lambda _event: self.start_recording())
        self.bind("<Command-p>", lambda _event: self.pause_recording())
        self.bind("<Command-s>", lambda _event: self.stop_recording())
        self.bind("<Command-o>", lambda _event: self.open_output_dir())

    def browse_path(self, var: tk.StringVar, kind: str):
        if kind == "file":
            path = filedialog.askopenfilename(title="选择 Firefox 可执行文件")
        else:
            path = filedialog.askdirectory(title="选择目录")
        if path:
            var.set(path)

    def current_trace_path(self) -> pathlib.Path:
        raw = self.current_trace_dir or self.trace_dir_var.get().strip()
        return pathlib.Path(raw).expanduser() if raw else DEFAULT_TRACE_ROOT

    def agent_config_payload(self) -> dict[str, object]:
        """Return every visible form value plus the effective runtime payload."""
        env_text = self.custom_env_text.get("1.0", "end").strip()
        return {
            "schema": AGENT_CONFIG_SCHEMA,
            "kind": AGENT_CONFIG_KIND,
            "version": 1,
            "ui": {
                "url": self.url_var.get(),
                "trace_dir": self.trace_dir_var.get(),
                "firefox_bin": self.firefox_bin_var.get(),
                "profile_dir": self.profile_dir_var.get(),
                "label": self.label_var.get(),
                "plan": self.plan_key(),
                "preset": self.plan_key(),
                "trace_start": TRACE_START_CHOICES.get(
                    self.trace_start_var.get(), self.trace_start_var.get()
                ),
                "trace_start_label": self.trace_start_var.get(),
                "reuse_trace": self.reuse_trace_var.get(),
                "query_fields": self.query_fields_var.get(),
                "body_fields": self.body_fields_var.get(),
                "header_fields": self.header_fields_var.get(),
                "cookie_fields": self.cookie_fields_var.get(),
                "field_scopes": {
                    key: var.get() for key, var in self.field_scope_vars.items()
                },
                "intensity": self.intensity_var.get(),
                "intensity_key": self.intensity_key(),
                "unlimited_trace": self.unlimited_trace_var.get(),
                "show_advanced": self.show_advanced_var.get(),
                "vm_stage": self.vm_stage_var.get(),
            },
            "modules": self.modules_payload(),
            "options": self.options_payload(),
            "vm": self.vm_payload(),
            "env": parse_env_lines(env_text),
            "env_text": env_text,
            "meta": {
                "generated_by": "firefox-trace-desktop",
                "trace_dir": self.current_trace_dir
                or self.trace_dir_var.get().strip(),
            },
        }

    def _set_string_var(self, var: tk.StringVar, data: dict[str, object], key: str):
        if key in data:
            value = data[key]
            var.set("" if value is None else str(value))

    def _set_bool_var(self, var: tk.BooleanVar, data: dict[str, object], key: str):
        if key in data:
            var.set(config_bool(data[key]))

    def _set_string_from_sources(
        self,
        var: tk.StringVar,
        key: str,
        *sources: dict[str, object],
    ):
        for source in sources:
            if key in source:
                value = source[key]
                var.set("" if value is None else str(value))
                return

    def _set_bool_from_sources(
        self,
        var: tk.BooleanVar,
        key: str,
        *sources: dict[str, object],
    ):
        for source in sources:
            if key in source:
                var.set(config_bool(source[key]))
                return

    def apply_agent_config(self, data: object, source: pathlib.Path | None = None):
        """Apply a complete Agent JSON handoff to the visible form.

        Explicit ``options``/``vm`` values are applied after the intensity and
        stage defaults, so loading a file never silently replaces the Agent's
        narrow object limits or VM checkboxes with a UI preset.
        """
        config = normalize_agent_config(data)
        ui = _config_section(config["ui"])
        modules = _config_section(config["modules"])
        options = _config_section(config["options"])
        vm = _config_section(config["vm"])
        env = _config_section(config["env"])

        # Session and collection fields.
        self._set_string_var(self.url_var, ui, "url")
        self._set_string_var(self.trace_dir_var, ui, "trace_dir")
        self._set_string_var(self.firefox_bin_var, ui, "firefox_bin")
        self._set_string_var(self.profile_dir_var, ui, "profile_dir")
        self._set_string_var(self.label_var, ui, "label")
        self._set_plan_from_sources(ui)
        self._set_string_from_sources(
            self.trace_start_var,
            "trace_start_label",
            ui,
        )
        if "trace_start_label" not in ui and "trace_start" in ui:
            raw_start = str(ui.get("trace_start") or "")
            self.trace_start_var.set(
                next(
                    (
                        label
                        for label, value in TRACE_START_CHOICES.items()
                        if value == raw_start
                    ),
                    raw_start,
                )
            )
        self._set_bool_var(self.reuse_trace_var, ui, "reuse_trace")
        self._set_string_from_sources(
            self.query_fields_var, "query_fields", ui, options
        )
        self._set_string_from_sources(
            self.body_fields_var, "body_fields", ui, options
        )
        self._set_string_from_sources(
            self.header_fields_var, "header_fields", ui, options
        )
        self._set_string_from_sources(
            self.cookie_fields_var, "cookie_fields", ui, options
        )

        scopes = _config_section(ui.get("field_scopes"))
        for scope, var in self.field_scope_vars.items():
            if scope in scopes:
                var.set(config_bool(scopes[scope]))
            else:
                # A disabled sentinel is a useful flat-file shorthand.
                field_var = {
                    "query": self.query_fields_var,
                    "body": self.body_fields_var,
                    "header": self.header_fields_var,
                    "cookie": self.cookie_fields_var,
                }[scope]
                if field_var.get().strip().lower() == DISABLED_FIELDS:
                    var.set(False)

        intensity_value = ui.get("intensity")
        if intensity_value is None and ui.get("intensity_key") in INTENSITY_PRESETS:
            intensity_value = INTENSITY_PRESETS[str(ui["intensity_key"])]["label"]
        if intensity_value is not None:
            intensity_text = str(intensity_value)
            if intensity_text in INTENSITY_PRESETS:
                intensity_text = INTENSITY_PRESETS[intensity_text]["label"]
            if intensity_text in INTENSITY_LABEL_TO_KEY:
                self.intensity_var.set(intensity_text)
                self.apply_intensity_to_form()
        self._set_bool_var(self.unlimited_trace_var, ui, "unlimited_trace")
        self._set_bool_var(self.show_advanced_var, ui, "show_advanced")

        # Module checkboxes (including the optional WASM key accepted by the
        # server even though the desktop form exposes WASM under the VM panel).
        for key, var in self.module_vars.items():
            if key in modules:
                var.set(config_bool(modules[key]))

        # JS/value controls.  UI values take precedence, then the effective
        # server options.  This also accepts a compact Agent file containing
        # only options/vm without duplicating the same value under ui.
        option_to_var = {
            "js_mode": self.js_mode_var,
            "target_match": self.target_match_var,
            "script_contains": self.script_contains_var,
            "script_sha256": self.script_sha256_var,
            "function_contains": self.function_contains_var,
            "object_depth": self.object_depth_var,
            "object_keys": self.object_keys_var,
            "array_items": self.array_items_var,
            "typed_array_bytes": self.typed_array_bytes_var,
            "limit_events": self.limit_events_var,
            "value_metadata": self.value_metadata_var,
            "primitive_metadata": self.primitive_metadata_var,
            "value_store_min_bytes": self.value_store_min_bytes_var,
            "deferred_value_capture": self.deferred_value_capture_var,
            "deferred_value_pool_bytes": self.deferred_value_pool_bytes_var,
            "boundary_buffer_events": self.boundary_buffer_events_var,
        }
        for key, var in option_to_var.items():
            self._set_string_from_sources(var, key, ui, options)
        if "limit_events" in options and "unlimited_trace" not in ui:
            self.unlimited_trace_var.set(str(options["limit_events"]).strip() == "0")
        elif "unlimited_trace" not in ui and "limit_events" not in options:
            env_limit = env.get(
                "FIREFOX_TRACE_JS_LIMIT_EVENTS",
                env.get("TRACE_JS_LIMIT_EVENTS", ""),
            )
            if str(env_limit).strip():
                self.unlimited_trace_var.set(str(env_limit).strip() == "0")

        # VM stage is a convenience preset only.  If the file has explicit VM
        # checkboxes, apply those after the stage and never call the preset
        # again.
        vm_stage_explicit = "vm_stage" in ui
        if vm_stage_explicit:
            raw_stage = str(ui["vm_stage"])
            stage_aliases = {
                "target": "一轮还原模式（推荐：请求触发回溯）",
                "one-pass": "一轮还原模式（推荐：请求触发回溯）",
                "opcode": "局部 opcode：自动候选脚本",
                "vm_window": "VM window：目标触发环形缓冲",
                "vm_step": "VM step：已确认 dispatcher",
                "dispatcher": "VM step：已确认 dispatcher",
                "off": "默认关闭 VM（普通 full-chain）",
                "wasm": "WASM：只看模块元数据",
            }
            self.vm_stage_var.set(stage_aliases.get(raw_stage, raw_stage))
            if not vm:
                self.apply_vm_stage_preset()
        elif vm:
            self.vm_stage_var.set(
                "VM window：目标触发环形缓冲"
                if config_bool(vm.get("vm_window"))
                else (
                    "VM step：已确认 dispatcher"
                    if config_bool(vm.get("vm_step"))
                    else (
                        "局部 opcode：自动候选脚本"
                        if config_bool(vm.get("opcode"))
                        else (
                            "WASM：只看模块元数据"
                            if config_bool(vm.get("wasm_module"))
                            else "默认关闭 VM（普通 full-chain）"
                        )
                    )
                )
            )

        vm_to_var = {
            "vm_window": self.vm_window_var,
            "vm_window_records": self.vm_window_records_var,
            "opcode": self.vm_opcode_var,
            "opcode_operands": self.vm_operands_var,
            "opcode_stack": self.vm_stack_var,
            "opcode_stack_primitives": self.vm_stack_primitive_var,
            "vm_step": self.vm_step_var,
            "wasm_module": self.vm_wasm_module_var,
            "wasm_dump": self.vm_wasm_dump_var,
            "wasm_insn": self.vm_wasm_insn_var,
            "unlimited": self.vm_unlimited_var,
            "script_contains": self.vm_script_contains_var,
            "script_sha256": self.script_sha256_var,
            "pc_range": self.vm_pc_range_var,
            "script_line": self.vm_script_line_var,
            "script_column": self.vm_script_column_var,
            "script_bytecode_length": self.vm_bytecode_length_var,
            "dispatch_pc": self.vm_dispatch_pc_var,
            "opcode_limit": self.vm_opcode_limit_var,
            "opcode_execution_limit": self.vm_opcode_execution_limit_var,
            "vm_step_limit": self.vm_step_limit_var,
            "opcode_max_events_per_second": self.vm_opcode_rate_events_var,
            "opcode_max_bytes_per_second": self.vm_opcode_rate_bytes_var,
            "ipc_max_events_per_second": self.vm_ipc_rate_events_var,
            "ipc_max_bytes_per_second": self.vm_ipc_rate_bytes_var,
            "opcode_stack_slots": self.vm_stack_slots_var,
            "wasm_module_limit": self.vm_wasm_module_limit_var,
            "wasm_preview_bytes": self.vm_wasm_preview_bytes_var,
            "wasm_dump_max_bytes": self.vm_wasm_dump_max_bytes_var,
            "wasm_insn_limit": self.vm_wasm_insn_limit_var,
        }
        for key, var in vm_to_var.items():
            if isinstance(var, tk.BooleanVar):
                self._set_bool_from_sources(var, key, vm)
            else:
                self._set_string_from_sources(var, key, vm)
        if "wasm" in modules and "wasm_module" not in vm:
            self.vm_wasm_module_var.set(config_bool(modules["wasm"]))
        if "unlimited" not in vm:
            unsafe = env.get("TRACE_UNSAFE_ALLOW", "")
            if str(unsafe).strip():
                self.vm_unlimited_var.set(config_bool(unsafe))

        # ``profile=target/vm`` is an internal runtime option rather than a
        # separate visible combobox.  Keep it effective by materializing it
        # into the same env text that the server already accepts.
        if options.get("profile") and not any(
            key in env for key in ("TRACE_PROFILE", "FIREFOX_TRACE_PROFILE")
        ):
            env["TRACE_PROFILE"] = str(options["profile"])

        env_text = config.get("env_text")
        if isinstance(env_text, str) and env_text.strip():
            rendered_env = env_text
            rendered_keys = parse_env_lines(rendered_env)
            missing_lines = [
                f"{key}={value}"
                for key, value in env.items()
                if key not in rendered_keys
            ]
            if missing_lines:
                rendered_env = rendered_env.rstrip() + "\n" + "\n".join(missing_lines) + "\n"
        else:
            rendered_env = env_text_from_mapping(
                {str(key): str(value) for key, value in env.items()}
            )
        self.custom_env_text.delete("1.0", "end")
        if rendered_env:
            self.custom_env_text.insert("1.0", rendered_env)

        # A complete config always needs advanced fields visible after load.
        # An explicit false still wins, which lets an Agent deliberately keep
        # a compact UI after loading only session values.
        if "show_advanced" not in ui and (
            options or vm or env or config.get("env_text")
        ):
            self.show_advanced_var.set(True)
        self.toggle_advanced_options()
        self.sync_vm_dependencies()
        self.agent_config_loaded = True

        # A pre-run load should select the configured directory.  While a
        # session is alive, current_trace_dir remains authoritative so loading
        # a next-segment file cannot accidentally retarget the running session.
        if not self.last_status or not (self.last_status.get("session") or {}).get(
            "alive"
        ):
            self.current_trace_dir = ""
        if hasattr(self, "trace_dir_display_var"):
            self.trace_dir_display_var.set(self.trace_dir_var.get().strip())
        suffix = f"：{source}" if source else ""
        self.log(f"已加载 Agent 完整配置{suffix}")

    def load_agent_config_text_from_path(self, path: pathlib.Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.apply_agent_config(data, path)

    def _bind_file_drop(self, widget: tk.Widget, kind: str):
        if not DND_FILES:
            widget.configure(text="拖放组件未加载；使用旁边的加载按钮")
            return
        widget.drop_target_register(DND_FILES)
        widget.dnd_bind("<<Drop>>", lambda event: self._load_dropped_file(event, kind))

    def _bind_file_drop_tree(self, widget: tk.Widget):
        """Register every visible Tk target because tkdnd does not bubble drops."""
        self._bind_file_drop(widget, "auto")
        for child in widget.winfo_children():
            self._bind_file_drop_tree(child)

    def _load_dropped_file(self, event, kind: str):
        paths = [pathlib.Path(value) for value in self.tk.splitlist(event.data)]
        if not paths:
            return "break"
        path = paths[0]
        if kind == "auto":
            kind = "agent" if path.suffix.lower() == ".json" else "env"
        try:
            if kind == "agent":
                self.load_agent_config_text_from_path(path)
            else:
                self.load_env_text_from_path(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            label = "Agent 配置" if kind == "agent" else "env 文件"
            messagebox.showerror("Firefox Trace", f"加载 {label} 失败：{exc}")
        return "break"

    def load_agent_config_file(self):
        trace_path = self.current_trace_path()
        initialdir = trace_path if trace_path.exists() else DEFAULT_TRACE_ROOT
        path = filedialog.askopenfilename(
            title="加载 Agent 完整配置",
            initialdir=str(initialdir),
            filetypes=[
                ("Agent config JSON", "*.json"),
                ("All files", "*"),
            ],
        )
        if not path:
            return
        try:
            self.load_agent_config_text_from_path(pathlib.Path(path))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror("Firefox Trace", f"加载 Agent 配置失败：{exc}")

    def load_default_agent_config(self):
        path = self.current_trace_path() / "agent-next.json"
        if not path.exists():
            messagebox.showinfo("Firefox Trace", f"当前输出目录没有 agent-next.json：\n{path}")
            return
        try:
            self.load_agent_config_text_from_path(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror("Firefox Trace", f"加载 Agent 配置失败：{exc}")

    def load_env_text_from_path(self, path: pathlib.Path):
        text = path.read_text(encoding="utf-8")
        self.custom_env_text.delete("1.0", "end")
        self.custom_env_text.insert("1.0", text)
        self.log(f"已加载 env 文件：{path}")

    def load_env_file(self):
        trace_path = self.current_trace_path()
        initialdir = trace_path if trace_path.exists() else DEFAULT_TRACE_ROOT
        path = filedialog.askopenfilename(
            title="加载 env 文件",
            initialdir=str(initialdir),
            filetypes=[
                ("Env files", "*.env *.txt"),
                ("All files", "*"),
            ],
        )
        if not path:
            return
        try:
            self.load_env_text_from_path(pathlib.Path(path))
        except OSError as exc:
            messagebox.showerror("Firefox Trace", f"加载 env 文件失败：{exc}")

    def load_default_env_file(self):
        path = self.current_trace_path() / "agent-next.env"
        if not path.exists():
            messagebox.showinfo("Firefox Trace", f"当前输出目录没有 agent-next.env：\n{path}")
            return
        try:
            self.load_env_text_from_path(path)
        except OSError as exc:
            messagebox.showerror("Firefox Trace", f"加载 env 文件失败：{exc}")

    def clear_env_text(self):
        self.custom_env_text.delete("1.0", "end")

    def copy_text(self, text: str):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.log("已复制路径")

    def new_trace_dir(self):
        self.agent_config_loaded = False
        self.trace_dir_var.set(str(DEFAULT_TRACE_ROOT / f"firefox-trace-{now_stamp()}"))

    def log(self, text: str):
        self.log_text.insert("end", f"[{time.strftime('%H:%M:%S')}] {text}\n")
        self.log_text.see("end")

    def set_busy(self, busy: bool):
        self.busy = busy
        self.update_buttons()

    def update_buttons(self):
        active = False
        recording = False
        if self.last_status:
            session = self.last_status.get("session") or {}
            active = bool(session.get("alive"))
            recording = bool(session.get("recording"))
        self.open_btn.configure(state="disabled" if active or self.busy else "normal")
        self.config_btn.configure(state="disabled" if not active or self.busy else "normal")
        self.start_btn.configure(state="disabled" if not active or recording or self.busy else "normal")
        self.pause_btn.configure(state="disabled" if not active or not recording or self.busy else "normal")
        self.stop_btn.configure(state="disabled" if not active or not recording or self.busy else "normal")
        self.close_btn.configure(state="disabled" if not active or self.busy else "normal")
        self.new_segment_btn.configure(state="disabled" if not active or self.busy else "normal")
        self.open_dir_btn.configure(state="normal")


    def intensity_key(self) -> str:
        return INTENSITY_LABEL_TO_KEY.get(self.intensity_var.get(), "auto")

    def plan_key(self) -> str:
        """Return the backend plan key for the user-facing first-pass choice."""
        return PLAN_LABELS.get(self.plan_var.get(), self.plan_var.get())

    def _set_plan_from_sources(self, *sources: dict[str, object]) -> None:
        for source in sources:
            for key in ("plan", "preset"):
                if key not in source:
                    continue
                raw = str(source[key] or "").strip()
                self.plan_var.set(PLAN_KEY_TO_LABEL.get(raw, raw))
                return

    def apply_capture_plan(self) -> None:
        """Materialize the two supported first-pass plans into safe defaults.

        This intentionally changes only defaults a manual first pass owns.
        Agent JSON is applied field-by-field afterwards and may still request a
        narrower target/VM run through the advanced controls.
        """
        full = self.plan_key() != "discover-light"
        module_defaults = {
            "js": True,
            "xhr": True,
            "fetch": True,
            "dom": True,
            "cookie": True,
            "storage": True,
            "script": True,
            "ws": full,
            "http_raw": False,
        }
        for key, enabled in module_defaults.items():
            self.module_vars[key].set(enabled)
        self.js_mode_var.set("boundary")
        self.vm_stage_var.set("默认关闭 VM（普通 full-chain）")
        self.apply_vm_stage_preset()
        self.intensity_var.set(INTENSITY_PRESETS["auto"]["label"])
        self.apply_intensity_to_form()
        if not full:
            # The light plan is the only built-in bounded JS plan.  Keep its
            # fuse visible in the form and serialize the same value instead
            # of leaving the auto/full-chain value of 0 in place.
            self.limit_events_var.set("50000")
        # Full-chain has no JS total-count cutoff.  Its call/value events are
        # delivered through the async batch spool rather than synchronous I/O.
        self.unlimited_trace_var.set(full)

    def intensity_preset(self) -> dict[str, str]:
        return INTENSITY_PRESETS[self.intensity_key()]

    def apply_intensity_to_form(self):
        preset = self.intensity_preset()
        self.object_depth_var.set(preset["object_depth"])
        self.object_keys_var.set(preset["object_keys"])
        self.array_items_var.set(preset["array_items"])
        self.typed_array_bytes_var.set(preset["typed_array_bytes"])
        limit_events = preset["limit_events"]
        if self.plan_key() == "discover-light" and self.intensity_key() == "auto":
            limit_events = "50000"
        self.limit_events_var.set(limit_events)
        self.value_store_min_bytes_var.set(preset["value_store_min_bytes"])
        self.vm_opcode_limit_var.set(preset["opcode_limit"])
        self.vm_opcode_execution_limit_var.set(preset["opcode_execution_limit"])
        self.vm_step_limit_var.set(preset["vm_step_limit"])
        self.vm_opcode_rate_events_var.set(preset["opcode_max_events_per_second"])
        self.vm_opcode_rate_bytes_var.set(preset["opcode_max_bytes_per_second"])
        self.vm_ipc_rate_events_var.set(preset["ipc_max_events_per_second"])
        self.vm_ipc_rate_bytes_var.set(preset["ipc_max_bytes_per_second"])
        self.vm_wasm_dump_max_bytes_var.set(preset["wasm_dump_max_bytes"])
        self.sync_vm_dependencies()


    def apply_vm_stage_preset(self):
        stage = self.vm_stage_var.get()
        self.vm_unlimited_var.set(False)
        self.vm_window_var.set(False)
        if "一轮还原" in stage:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        elif "VM window" in stage:
            self.vm_window_var.set(True)
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        elif "opcode" in stage:
            self.vm_opcode_var.set(True)
            self.vm_operands_var.set(True)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        elif "dispatcher" in stage:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(True)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        elif "WASM" in stage:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(True)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        else:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            # "默认关闭 VM" must not leave WASM collection enabled from a
            # previously loaded config or stage selection.
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        self.sync_vm_dependencies()

    def toggle_advanced_options(self):
        show = bool(self.show_advanced_var.get())
        for widget in (
            self.modules_advanced_panel,
            self.js_advanced_panel,
            self.vm_panel,
            self.env_advanced_panel,
        ):
            if show:
                widget.grid()
            else:
                widget.grid_remove()
        if show:
            self.vm_limits_grid.grid()
        else:
            self.vm_limits_grid.grid_remove()

    def sync_vm_dependencies(self):
        if self.vm_window_var.get():
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
        if self.vm_stack_primitive_var.get():
            self.vm_stack_var.set(True)
        stage = self.vm_stage_var.get()
        if self.vm_unlimited_var.get():
            self.vm_hint_var.set(
                "当前提醒：已开启 VM/opcode 不截断。只适合锁定脚本后的 1 次短动作；触发目标请求后立刻停止并整理，避免日志洪峰。"
            )
        elif self.vm_step_var.get() and not self.vm_dispatch_pc_var.get().strip():
            self.vm_hint_var.set(
                "当前提醒：选择了 VM step，但 dispatcher PC 尚未写入。先不要手填 PC；由 Agent 根据上一轮 opcode/target-candidates 判断，必要时先跑“局部 opcode”。"
            )
        elif self.vm_window_var.get():
            self.vm_hint_var.set(
                "目标脚本只写固定大小二进制环形记录；query/body 目标字段命中后立即冻结并落盘。普通 Fetch/XHR、script 和 boundary 锚点继续保留。"
            )
        elif "一轮还原" in stage:
            self.vm_hint_var.set(
                "Agent 提醒：这是 VM 第 0/1 步。先不开 JS opcode、VM step、WASM dump；只执行一次目标动作。请求出现后停止整理，把 TRACE_DIR 交给 Agent 看 target-candidates、request-fields、js/value 是否足够。"
            )
        elif "opcode" in stage:
            self.vm_hint_var.set(
                "Agent 提醒：这是 VM 第 2 步。仅当 Agent 已写好 agent-next.env 或已确认候选脚本/PC 范围时使用；执行同一个短目标动作一次，请求出现后马上停止整理。"
            )
        elif "dispatcher" in stage:
            self.vm_hint_var.set(
                "Agent 提醒：这是 VM 第 3 步。仅当 Agent 明确给出 dispatcher PC 时使用；不要自己填写 PC。执行同一个短动作一次，用于确认 VM step / 状态流。"
            )
        elif "WASM" in stage:
            self.vm_hint_var.set(
                "Agent 提醒：只采 WASM module 元数据。只有 Agent 确认目标链涉及 WASM 时再选；需要完整模块时下一轮再勾 WASM 模块 artifact。"
            )
        else:
            self.vm_hint_var.set(
                "Agent 提醒：普通 full-chain / VM 关闭。适合先确认请求、字段、脚本和环境证据；VM/opcode 等 Agent 看完日志后再开。"
            )

    def modules_payload(self) -> dict[str, bool]:
        modules = {key: var.get() for key, var in self.module_vars.items()}
        vm = self.vm_payload()
        if vm.get("wasm_module") or vm.get("wasm_dump") or vm.get("wasm_insn"):
            modules["wasm"] = True
        return modules

    def vm_payload(self) -> dict[str, object]:
        return {
            "vm_window": self.vm_window_var.get(),
            "vm_window_records": self.vm_window_records_var.get().strip(),
            "opcode": self.vm_opcode_var.get(),
            "opcode_operands": self.vm_operands_var.get(),
            "opcode_stack": self.vm_stack_var.get(),
            "opcode_stack_primitives": self.vm_stack_primitive_var.get(),
            "vm_step": self.vm_step_var.get(),
            "wasm_module": self.vm_wasm_module_var.get(),
            "wasm_dump": self.vm_wasm_dump_var.get(),
            "wasm_insn": self.vm_wasm_insn_var.get(),
            "unlimited": self.vm_unlimited_var.get(),
            "script_contains": self.vm_script_contains_var.get().strip(),
            "script_sha256": self.script_sha256_var.get().strip(),
            "pc_range": self.vm_pc_range_var.get().strip(),
            "script_line": self.vm_script_line_var.get().strip(),
            "script_column": self.vm_script_column_var.get().strip(),
            "script_bytecode_length": self.vm_bytecode_length_var.get().strip(),
            "dispatch_pc": self.vm_dispatch_pc_var.get().strip(),
            "opcode_limit": self.vm_opcode_limit_var.get().strip(),
            "opcode_execution_limit": self.vm_opcode_execution_limit_var.get().strip(),
            "vm_step_limit": self.vm_step_limit_var.get().strip(),
            "opcode_max_events_per_second": self.vm_opcode_rate_events_var.get().strip(),
            "opcode_max_bytes_per_second": self.vm_opcode_rate_bytes_var.get().strip(),
            "ipc_max_events_per_second": self.vm_ipc_rate_events_var.get().strip(),
            "ipc_max_bytes_per_second": self.vm_ipc_rate_bytes_var.get().strip(),
            "opcode_stack_slots": self.vm_stack_slots_var.get().strip(),
            "wasm_module_limit": self.vm_wasm_module_limit_var.get().strip(),
            "wasm_preview_bytes": self.vm_wasm_preview_bytes_var.get().strip(),
            "wasm_dump_max_bytes": self.vm_wasm_dump_max_bytes_var.get().strip(),
            "wasm_insn_limit": self.vm_wasm_insn_limit_var.get().strip(),
        }

    def target_field_value(self, scope: str, var: tk.StringVar) -> str:
        enabled = self.field_scope_vars.get(scope)
        return var.get().strip() if enabled is None or enabled.get() else DISABLED_FIELDS

    def options_payload(self) -> dict[str, str]:
        profile = (
            "vm"
            if (
                self.vm_window_var.get()
                or self.vm_opcode_var.get()
                or self.vm_step_var.get()
            )
            else self.plan_key()
        )
        if profile in {"full-chain", "discover-light"}:
            # SpiderMonkey 只认识 discover/field/target/deep/vm；full-chain 是 UI 采集计划。
            profile = "discover"
        return {
            "profile": profile,
            "js_mode": self.js_mode_var.get(),
            "script_contains": self.script_contains_var.get().strip(),
            "script_sha256": self.script_sha256_var.get().strip(),
            "function_contains": self.function_contains_var.get().strip(),
            "target_match": self.target_match_var.get().strip(),
            "query_fields": self.target_field_value("query", self.query_fields_var),
            "body_fields": self.target_field_value("body", self.body_fields_var),
            "header_fields": self.target_field_value("header", self.header_fields_var),
            "cookie_fields": self.target_field_value("cookie", self.cookie_fields_var),
            "object_depth": self.object_depth_var.get().strip(),
            "object_keys": self.object_keys_var.get().strip(),
            "array_items": self.array_items_var.get().strip(),
            "typed_array_bytes": self.typed_array_bytes_var.get().strip(),
            "value_metadata": self.value_metadata_var.get().strip(),
            "primitive_metadata": self.primitive_metadata_var.get().strip(),
            "value_store_min_bytes": self.value_store_min_bytes_var.get().strip(),
            "value_store_max_bytes": "0",
            "deferred_value_capture": self.deferred_value_capture_var.get().strip(),
            "deferred_value_pool_bytes": self.deferred_value_pool_bytes_var.get().strip(),
            "boundary_buffer_events": self.boundary_buffer_events_var.get().strip(),
            "limit_events": "0" if self.unlimited_trace_var.get() else self.limit_events_var.get().strip(),
        }

    def open_payload(self) -> dict[str, object]:
        trace_dir = self.trace_dir_var.get().strip()
        profile_dir = self.profile_dir_var.get().strip()
        firefox_bin = self.firefox_bin_var.get().strip()
        payload: dict[str, object] = {
            "url": self.url_var.get().strip(),
            "trace_dir": trace_dir,
            "profile_dir": profile_dir,
            "firefox_bin": firefox_bin,
            "plan": self.plan_key(),
            "preset": self.plan_key(),
            "label": self.label_var.get().strip() or "manual",
            "trace_start": TRACE_START_CHOICES.get(self.trace_start_var.get(), "active"),
            "reuse_trace": self.reuse_trace_var.get(),
            "query_fields": self.target_field_value("query", self.query_fields_var),
            "body_fields": self.target_field_value("body", self.body_fields_var),
            "header_fields": self.target_field_value("header", self.header_fields_var),
            "cookie_fields": self.target_field_value("cookie", self.cookie_fields_var),
            "modules": self.modules_payload(),
            "options": self.options_payload(),
            "vm": self.vm_payload(),
            "env": parse_env_lines(self.custom_env_text.get("1.0", "end")),
        }
        return payload

    def config_payload(self) -> dict[str, object]:
        env = parse_env_lines(self.custom_env_text.get("1.0", "end"))
        if self.unlimited_trace_var.get():
            env.setdefault("FIREFOX_TRACE_JS_LIMIT_EVENTS", "0")
        if self.vm_unlimited_var.get():
            env.setdefault("TRACE_UNSAFE_ALLOW", "1")
        return {
            "trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(),
            "preset": self.plan_key(),
            "modules": self.modules_payload(),
            "options": self.options_payload(),
            "vm": self.vm_payload(),
            "env": env,
        }

    def run_worker(self, title: str, func, on_success=None):
        if self.busy:
            return
        self.set_busy(True)
        self.log(f"开始：{title}")

        def target():
            try:
                result = func()
                self.worker_queue.put(("success", (title, result, on_success)))
            except Exception as exc:  # noqa: BLE001 - UI 显示具体错误
                self.worker_queue.put(("error", (title, exc)))

        threading.Thread(target=target, daemon=True).start()

    def _poll_worker_queue(self):
        try:
            while True:
                kind, payload = self.worker_queue.get_nowait()
                if kind == "success":
                    title, result, on_success = payload
                    self.log(f"完成：{title}")
                    self.log(json.dumps(result, ensure_ascii=False)[:1800])
                    if isinstance(result, dict) and result.get("trace_dir"):
                        self.current_trace_dir = str(result["trace_dir"])
                        self.trace_dir_display_var.set(self.current_trace_dir)
                    if on_success:
                        on_success(result)
                    self.refresh_status_once()
                    self.set_busy(False)
                else:
                    title, exc = payload
                    self.log(f"失败：{title}: {exc}")
                    messagebox.showerror("Firefox Trace", str(exc))
                    self.set_busy(False)
        except queue.Empty:
            pass
        self.after(250, self._poll_worker_queue)

    def open_browser(self):
        self.current_trace_dir = self.trace_dir_var.get().strip()
        def task():
            result = self.console.open_session(self.open_payload())
            return result
        self.run_worker("打开 Firefox", task, self.sync_effective_js_mode)

    def apply_config(self):
        self.run_worker(
            "应用配置",
            lambda: self.console.config(self.config_payload()),
            self.sync_effective_js_mode,
        )

    def start_recording(self):
        def task():
            trace_dir = self.current_trace_dir or self.trace_dir_var.get().strip()
            config = self.console.config({**self.config_payload(), "trace_dir": trace_dir})
            started = self.console.action(
                "start",
                {
                    "trace_dir": trace_dir,
                    "label": self.label_var.get().strip() or "manual",
                },
            )
            return {"ok": True, "config": config, "start": started, "trace_dir": trace_dir}

        self.run_worker(
            "应用配置并开始记录",
            task,
            lambda result: self.sync_effective_js_mode(result.get("config") or {}),
        )

    def sync_effective_js_mode(self, result: dict):
        capture = result.get("js_capture") if isinstance(result, dict) else None
        if not isinstance(capture, dict):
            return
        if capture.get("status") != "boundary-fallback-empty-target":
            return
        self.js_mode_var.set("boundary")
        self.log("JS Call：target/deep 未加载候选身份，已自动切换为 boundary，避免空记录。")

    def pause_recording(self):
        self.run_worker("暂停记录", lambda: self.console.action("pause", {"trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(), "label": self.label_var.get().strip() or "pause"}))

    def stop_recording(self):
        self.run_worker("停止并整理", lambda: self.console.action("stop", {"trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(), "label": self.label_var.get().strip() or "stop", "finalize": True}))

    def close_browser(self):
        self.run_worker("关闭 Firefox", lambda: self.console.close({"trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(), "label": self.label_var.get().strip() or "close"}))

    def new_segment(self):
        self.run_worker("新分段", lambda: self.console.action("new-segment", {"trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(), "label": self.label_var.get().strip() or "segment"}))

    def open_output_dir(self):
        path = self.current_trace_dir or self.trace_dir_var.get().strip()
        if not path:
            return
        pathlib.Path(path).expanduser().mkdir(parents=True, exist_ok=True)
        try:
            subprocess.Popen(["open", path])
        except OSError as exc:
            self.log(f"打开目录失败：{exc}")

    def refresh_status_once(self):
        trace_dir = self.current_trace_dir or self.trace_dir_var.get().strip()
        if not trace_dir:
            return
        try:
            status = self.console.session_status(pathlib.Path(trace_dir))
        except Exception as exc:  # noqa: BLE001
            self.log(f"状态刷新失败：{exc}")
            return
        self.last_status = status
        self.render_status(status)
        self.update_buttons()

    def refresh_status_loop(self):
        self.refresh_status_once()
        self.after(1000, self.refresh_status_loop)

    def render_status(self, status: dict):
        session = status.get("session") or {}
        metrics = status.get("metrics") or {}
        health = status.get("health") or {}
        self.phase_var.set(str(session.get("phase") or "idle"))
        self.health_var.set(str(health.get("status") or "ok"))
        self.pid_var.set(str(session.get("pid") or "-"))
        self.rate_var.set(f"{metrics.get('events_per_second', 0)} ev/s")
        self.total_var.set(f"{metrics.get('events_total', 0)} events / {metrics.get('bytes_total', 0)} bytes")
        trace_dir = status.get("trace_dir") or self.current_trace_dir or "-"
        self.trace_dir_display_var.set(str(trace_dir))
        if hasattr(self, "trace_dir_entry"):
            self.trace_dir_entry.xview_moveto(1.0)
        self.render_discovery(status.get("target_discovery") or {})
        counts = metrics.get("category_counts") or {}
        lines = [f"{name:15s} {int(counts.get(name, 0))}" for name in CATEGORY_ORDER]
        self.category_text.configure(state="normal")
        self.category_text.delete("1.0", "end")
        self.category_text.insert("1.0", "\n".join(lines))
        self.category_text.configure(state="disabled")

    def render_discovery(self, discovery: dict):
        recommended = discovery.get("recommended") if isinstance(discovery, dict) else None
        recommended = recommended if isinstance(recommended, dict) else None
        vm = recommended.get("vm") if recommended else {}
        vm = vm if isinstance(vm, dict) else {}
        if not getattr(self, "agent_config_loaded", False):
            self.vm_script_contains_var.set(str(vm.get("script_contains") or ""))
            self.vm_pc_range_var.set(str(vm.get("pc_range") or ""))
            self.vm_dispatch_pc_var.set(str(vm.get("dispatch_pc") or ""))
            self.vm_script_line_var.set(str(vm.get("script_line") or ""))
            self.vm_script_column_var.set(str(vm.get("script_column") or ""))
            self.vm_bytecode_length_var.set(str(vm.get("script_bytecode_length") or ""))
            self.script_sha256_var.set(str(vm.get("script_sha256") or ""))
            self.script_contains_var.set(str(vm.get("script_contains") or ""))
            self.function_contains_var.set(str(vm.get("function_contains") or ""))
        signature = json.dumps(
            {
                "status": discovery.get("status") if isinstance(discovery, dict) else "",
                "script": recommended.get("script_url") if recommended else "",
                "pc": vm.get("pc_range"),
                "dispatch": vm.get("dispatch_pc"),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        if signature != self.last_discovery_signature:
            self.last_discovery_signature = signature
            if recommended:
                lines = [
                    "选择方式：自动",
                    f"脚本：{recommended.get('script_url') or '-'}",
                    f"匹配片段：{recommended.get('script_match') or '-'}",
                    f"置信度：{recommended.get('confidence') or '-'}",
                    f"阶段：{recommended.get('stage') or '-'}",
                    f"依据：{'、'.join(recommended.get('reasons') or []) or '-'}",
                    f"PC：{vm.get('pc_range') or '等待 opcode 分析'}",
                    f"dispatcher：{vm.get('dispatch_pc') or '等待高置信度分析'}",
                    "下一步：重复同一个目标动作；参数会自动带入下一轮。",
                ]
            else:
                lines = [
                    f"状态：{discovery.get('status') or '尚未生成'}",
                    discovery.get("next_action")
                    or "先完成一次目标动作，停止整理后自动分析。",
                    "这里不需要填写脚本关键词、PC 范围或 dispatcher PC。",
                ]
            self.discovery_text.configure(state="normal")
            self.discovery_text.delete("1.0", "end")
            self.discovery_text.insert("1.0", "\n".join(lines))
            self.discovery_text.configure(state="disabled")
        self.sync_vm_dependencies()

    def on_window_close(self):
        active = False
        recording = False
        if self.last_status:
            session = self.last_status.get("session") or {}
            active = bool(session.get("alive"))
            recording = bool(session.get("recording"))
        if active:
            msg = "Firefox Trace 还在运行。点击“是”会停止/整理并关闭 Firefox。"
            if recording:
                msg = "正在记录中。点击“是”会停止/整理并关闭 Firefox。"
            if messagebox.askyesno("退出", msg):
                try:
                    self.console.close({"trace_dir": self.current_trace_dir or self.trace_dir_var.get().strip(), "label": "app-exit"})
                except Exception as exc:  # noqa: BLE001
                    self.log(f"退出清理失败：{exc}")
                self.destroy()
        else:
            self.destroy()


def main() -> None:
    DEFAULT_TRACE_ROOT.mkdir(parents=True, exist_ok=True)
    app = TraceDesktopApp()
    app.mainloop()


if __name__ == "__main__":
    main()
