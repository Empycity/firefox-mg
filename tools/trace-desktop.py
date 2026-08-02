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
DEFAULT_RUNTIME = pathlib.Path("/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime")
DEFAULT_FIREFOX = DEFAULT_RUNTIME / "Nightly.app/Contents/MacOS/firefox"
DEFAULT_TRACE_ROOT = pathlib.Path.home() / "Desktop" / "firefox-trace-outputs"

INTENSITY_PRESETS = {
    "auto": {
        "label": "通用完整值落盘（默认）",
        "object_depth": "1",
        "object_keys": "0",
        "array_items": "0",
        "typed_array_bytes": "256",
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


class ScrollFrame(ttk.Frame):
    def __init__(self, master):
        super().__init__(master)
        self.canvas = tk.Canvas(self, highlightthickness=0, borderwidth=0, background="#eef8ff")
        self.scrollbar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.body = ttk.Frame(self.canvas)
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
    "默认关闭 VM（普通 full-chain）",
    "JSVMP 第1轮：opcode 热点定位",
    "JSVMP 第2轮：填 PC 范围窄采",
    "JSVMP 第3轮：填 dispatcher 开 VM step",
    "WASM：只看模块元数据",
]


class TraceDesktopApp(tk.Tk):
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

        self._setup_style()
        self._build_ui()
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
        right = ttk.Frame(paned, style="Panel.TFrame", padding=14)
        right.columnconfigure(0, weight=1)
        right.rowconfigure(4, weight=1)
        paned.add(left, minsize=620, stretch="always")
        paned.add(right, minsize=460, stretch="always")

        self._build_config(left.body)
        self._build_actions(right)
        self._build_status(right)
        self._build_log(right)
        self.after(120, lambda: self.main_paned.sash_place(0, max(680, self.winfo_width() // 2), 0))

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
        self.url_var = tk.StringVar(value="about:blank")
        self.trace_dir_var = tk.StringVar(value=str(DEFAULT_TRACE_ROOT / f"firefox-trace-{now_stamp()}"))
        self.profile_dir_var = tk.StringVar(value="")
        self.firefox_bin_var = tk.StringVar(value=str(DEFAULT_FIREFOX if DEFAULT_FIREFOX.exists() else ""))
        self.label_var = tk.StringVar(value="manual")
        self.plan_var = tk.StringVar(value="full-chain")
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
        self.vm_stage_var = tk.StringVar(value=VM_STAGE_CHOICES[0])

        panel = self._panel(parent, "① 会话", 0)
        self._entry_row(panel, 1, "目标 URL", self.url_var)
        self._path_row(panel, 2, "输出目录", self.trace_dir_var, "directory")
        self._path_row(panel, 4, "Firefox 可执行文件", self.firefox_bin_var, "file")
        self._path_row(panel, 6, "Profile 目录（空=临时）", self.profile_dir_var, "directory")
        self._entry_row(panel, 8, "记录标签", self.label_var)
        ttk.Label(panel, text="启动模式", style="Panel.TLabel").grid(row=9, column=0, sticky="w", pady=4)
        start_box = ttk.Combobox(panel, textvariable=self.trace_start_var, values=list(TRACE_START_CHOICES), state="readonly")
        start_box.grid(row=9, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        ttk.Checkbutton(panel, text="复用已有输出目录", variable=self.reuse_trace_var).grid(row=10, column=1, sticky="w", padx=(10, 0), pady=4)
        ttk.Button(panel, text="新建时间戳目录", command=self.new_trace_dir).grid(row=10, column=2, sticky="w", padx=(8, 0), pady=4)

        panel = self._panel(parent, "② 采集计划 / 目标字段", 1)
        ttk.Label(panel, text="采集计划", style="Panel.TLabel").grid(row=1, column=0, sticky="w", pady=4)
        plan_box = ttk.Combobox(panel, textvariable=self.plan_var, values=["full-chain", "discover-light"], state="readonly")
        plan_box.grid(row=1, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        self._entry_row(panel, 2, "URL Query 字段", self.query_fields_var)
        self._entry_row(panel, 3, "POST Body 字段", self.body_fields_var)
        self._entry_row(panel, 4, "Request Header 字段", self.header_fields_var)
        self._entry_row(panel, 5, "Cookie 字段", self.cookie_fields_var)
        ttk.Label(panel, text="采集强度", style="Panel.TLabel").grid(row=6, column=0, sticky="w", pady=4)
        intensity_box = ttk.Combobox(
            panel,
            textvariable=self.intensity_var,
            values=[item["label"] for item in INTENSITY_PRESETS.values()],
            state="readonly",
        )
        intensity_box.grid(row=6, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=4)
        intensity_box.bind("<<ComboboxSelected>>", lambda _event: self.apply_intensity_to_form())
        ttk.Checkbutton(
            panel,
            text="不限普通 JS trace 总事件数（默认开启，完整落盘）",
            variable=self.unlimited_trace_var,
        ).grid(row=7, column=1, columnspan=3, sticky="w", padx=(10, 0), pady=4)
        ttk.Checkbutton(
            panel,
            text="显示高级参数（对象展开 / 性能保险丝 / bytes/s）",
            variable=self.show_advanced_var,
            command=self.toggle_advanced_options,
        ).grid(row=8, column=1, columnspan=3, sticky="w", padx=(10, 0), pady=4)
        ttk.Label(
            panel,
            text="完整证据进 values/ 制品文件；主 JSONL 只放 preview、sha256、size、path，方便索引且不挤爆单行日志。",
            style="Muted.TLabel",
            wraplength=760,
        ).grid(row=9, column=0, columnspan=4, sticky="ew", pady=(8, 0))

        panel = self._panel(parent, "③ 模块开关", 2)
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
        self.function_contains_var = tk.StringVar(value="")
        self.object_depth_var = tk.StringVar(value="1")
        self.object_keys_var = tk.StringVar(value="0")
        self.array_items_var = tk.StringVar(value="0")
        self.typed_array_bytes_var = tk.StringVar(value="256")
        self.limit_events_var = tk.StringVar(value="50000")
        self.value_metadata_var = tk.StringVar(value="1")
        self.primitive_metadata_var = tk.StringVar(value="1")
        self.value_store_min_bytes_var = tk.StringVar(value="1")
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
        self._entry_row(panel, row, "脚本 contains", self.script_contains_var); row += 1
        self._entry_row(panel, row, "函数 contains", self.function_contains_var); row += 1
        self._entry_row(panel, row, "target_match", self.target_match_var); row += 1
        grid = ttk.Frame(panel, style="Panel.TFrame")
        grid.grid(row=row, column=0, columnspan=4, sticky="ew")
        for c in range(4):
            grid.columnconfigure(c, weight=1)
        smalls = [
            ("对象深度", self.object_depth_var),
            ("对象 keys（0=全量）", self.object_keys_var),
            ("数组 items（0=全量）", self.array_items_var),
            ("TypedArray bytes", self.typed_array_bytes_var),
            ("事件保险丝（0=不限）", self.limit_events_var),
            ("值 metadata", self.value_metadata_var),
            ("primitive metadata", self.primitive_metadata_var),
            ("值落盘最小字节", self.value_store_min_bytes_var),
        ]
        for i, (label, var) in enumerate(smalls):
            cell = ttk.Frame(grid, style="Panel.TFrame")
            cell.grid(row=i // 4, column=i % 4, sticky="ew", padx=(0, 8), pady=4)
            ttk.Label(cell, text=label, style="Panel.TLabel").grid(row=0, column=0, sticky="w")
            ttk.Entry(cell, textvariable=var, width=12).grid(row=1, column=0, sticky="ew")

        panel = self._panel(parent, "④ VM / WASM 细粒度", 4)
        self.vm_panel = panel
        ttk.Label(panel, text="VM/JSVMP 阶段预设", style="Panel.TLabel").grid(row=1, column=0, sticky="w", pady=(0, 8))
        vm_stage_box = ttk.Combobox(panel, textvariable=self.vm_stage_var, values=VM_STAGE_CHOICES, state="readonly")
        vm_stage_box.grid(row=1, column=1, columnspan=3, sticky="ew", padx=(10, 0), pady=(0, 8))
        vm_stage_box.bind("<<ComboboxSelected>>", lambda _event: self.apply_vm_stage_preset())
        self.vm_opcode_var = tk.BooleanVar(value=False)
        self.vm_operands_var = tk.BooleanVar(value=True)
        self.vm_stack_var = tk.BooleanVar(value=False)
        self.vm_stack_primitive_var = tk.BooleanVar(value=False)
        self.vm_step_var = tk.BooleanVar(value=False)
        self.vm_wasm_module_var = tk.BooleanVar(value=True)
        self.vm_wasm_dump_var = tk.BooleanVar(value=False)
        self.vm_wasm_insn_var = tk.BooleanVar(value=False)
        checks = [
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
        for label, var in [
            ("目标脚本关键词 contains", self.vm_script_contains_var),
            ("opcode PC 范围（留空=自动）", self.vm_pc_range_var),
            ("VM dispatcher PC（分析后填写）", self.vm_dispatch_pc_var),
        ]:
            self._entry_row(panel, row, label, var); row += 1
        grid2 = ttk.Frame(panel, style="Panel.TFrame")
        self.vm_limits_grid = grid2
        grid2.grid(row=row, column=0, columnspan=4, sticky="ew", pady=(6, 0))
        for c in range(4):
            grid2.columnconfigure(c, weight=1)
        vm_smalls = [
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
        self.vm_hint_var = tk.StringVar(value="contains 是脚本 URL/文件名关键词；PC 范围和 dispatcher PC 初次留空，Agent 用 opcode analyzer 找到后再填。")
        ttk.Label(panel, textvariable=self.vm_hint_var, style="Muted.TLabel", wraplength=760).grid(row=row, column=0, columnspan=4, sticky="ew", pady=(8, 0))

        panel = self._panel(parent, "⑤ 额外环境变量（高级）", 5)
        self.env_advanced_panel = panel
        self.custom_env_text = tk.Text(panel, height=5, bg="#f8fcff", fg="#123047", insertbackground="#123047", relief="flat", font=("Menlo", 12), highlightthickness=1, highlightbackground="#cfe8ff")
        self.custom_env_text.grid(row=1, column=0, columnspan=4, sticky="ew")
        self.custom_env_text.insert("1.0", "# 每行 NAME=VALUE\n# TRACE_FETCH_RESPONSE_BODY_MAX_BYTES=4096\n")
        self.apply_intensity_to_form()
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

    def copy_text(self, text: str):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.log("已复制路径")

    def new_trace_dir(self):
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

    def intensity_preset(self) -> dict[str, str]:
        return INTENSITY_PRESETS[self.intensity_key()]

    def apply_intensity_to_form(self):
        preset = self.intensity_preset()
        self.object_depth_var.set(preset["object_depth"])
        self.object_keys_var.set(preset["object_keys"])
        self.array_items_var.set(preset["array_items"])
        self.typed_array_bytes_var.set(preset["typed_array_bytes"])
        self.limit_events_var.set(preset["limit_events"])
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
        if "第1轮" in stage:
            self.vm_opcode_var.set(True)
            self.vm_operands_var.set(True)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
            self.vm_hint_var.set("JSVMP 第1轮：只填目标脚本关键词 contains；PC 范围和 dispatcher PC 留空，执行一次短目标动作。")
        elif "第2轮" in stage:
            self.vm_opcode_var.set(True)
            self.vm_operands_var.set(True)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
            self.vm_hint_var.set("JSVMP 第2轮：填目标脚本 contains 和 Agent 给的 opcode PC 范围；dispatcher PC 仍可留空。")
        elif "第3轮" in stage:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(True)
            self.vm_wasm_module_var.set(False)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
            self.vm_hint_var.set("JSVMP 第3轮：填目标脚本 contains 和 dispatcher PC；只记录 VM 分发点 step。")
        elif "WASM" in stage:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(False)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(True)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
            self.vm_hint_var.set("WASM 首轮：只看 module 元数据；需要完整模块时再勾 WASM 模块 artifact。")
        else:
            self.vm_opcode_var.set(False)
            self.vm_operands_var.set(True)
            self.vm_stack_var.set(False)
            self.vm_stack_primitive_var.set(False)
            self.vm_step_var.set(False)
            self.vm_wasm_module_var.set(True)
            self.vm_wasm_dump_var.set(False)
            self.vm_wasm_insn_var.set(False)
            self.vm_hint_var.set("普通 full-chain：VM 不开；WASM module 元数据保留轻量线索。")
        self.sync_vm_dependencies()

    def toggle_advanced_options(self):
        show = bool(self.show_advanced_var.get())
        for widget in (self.js_advanced_panel, self.env_advanced_panel):
            if show:
                widget.grid()
            else:
                widget.grid_remove()
        if show:
            self.vm_limits_grid.grid()
        else:
            self.vm_limits_grid.grid_remove()

    def sync_vm_dependencies(self):
        if self.vm_stack_primitive_var.get():
            self.vm_stack_var.set(True)
        if self.vm_unlimited_var.get():
            self.vm_hint_var.set("VM/opcode 不截断已开启：opcode/VM step/rate/IPC 预算写 0，建议只记录一次短目标动作。")
        elif (self.vm_opcode_var.get() or self.vm_step_var.get()) and not self.vm_script_contains_var.get().strip():
            self.vm_hint_var.set("已开启 opcode/VM step：建议填写目标脚本 contains，缩小范围更稳。")
        elif self.vm_step_var.get() and not self.vm_dispatch_pc_var.get().strip():
            self.vm_hint_var.set("已开启 VM step：dispatcher PC 是解释器分发循环的单个 bytecode PC，由 opcode 分析结果填写。")
        else:
            self.vm_hint_var.set("contains 是关键词；PC 范围格式 START:END，初次留空；普通 JS trace 默认不限总事件数，VM/opcode 保留预算。")

    def modules_payload(self) -> dict[str, bool]:
        modules = {key: var.get() for key, var in self.module_vars.items()}
        vm = self.vm_payload()
        if vm.get("wasm_module") or vm.get("wasm_dump") or vm.get("wasm_insn"):
            modules["wasm"] = True
        return modules

    def vm_payload(self) -> dict[str, object]:
        return {
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

    def options_payload(self) -> dict[str, str]:
        profile = "vm" if (self.vm_opcode_var.get() or self.vm_step_var.get()) else self.plan_var.get()
        if profile in {"full-chain", "discover-light"}:
            # SpiderMonkey 只认识 discover/field/target/deep/vm；full-chain 是 UI 采集计划。
            profile = "discover"
        return {
            "profile": profile,
            "js_mode": self.js_mode_var.get(),
            "script_contains": self.script_contains_var.get().strip(),
            "function_contains": self.function_contains_var.get().strip(),
            "target_match": self.target_match_var.get().strip(),
            "query_fields": self.query_fields_var.get().strip(),
            "body_fields": self.body_fields_var.get().strip(),
            "header_fields": self.header_fields_var.get().strip(),
            "cookie_fields": self.cookie_fields_var.get().strip(),
            "object_depth": self.object_depth_var.get().strip(),
            "object_keys": self.object_keys_var.get().strip(),
            "array_items": self.array_items_var.get().strip(),
            "typed_array_bytes": self.typed_array_bytes_var.get().strip(),
            "value_metadata": self.value_metadata_var.get().strip(),
            "primitive_metadata": self.primitive_metadata_var.get().strip(),
            "value_store_min_bytes": self.value_store_min_bytes_var.get().strip(),
            "value_store_max_bytes": "0",
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
            "plan": self.plan_var.get(),
            "preset": self.plan_var.get(),
            "label": self.label_var.get().strip() or "manual",
            "trace_start": TRACE_START_CHOICES.get(self.trace_start_var.get(), "active"),
            "reuse_trace": self.reuse_trace_var.get(),
            "query_fields": self.query_fields_var.get().strip(),
            "body_fields": self.body_fields_var.get().strip(),
            "header_fields": self.header_fields_var.get().strip(),
            "cookie_fields": self.cookie_fields_var.get().strip(),
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
            "preset": self.plan_var.get(),
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
        self.run_worker("打开 Firefox", task)

    def apply_config(self):
        self.run_worker("应用配置", lambda: self.console.config(self.config_payload()))

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

        self.run_worker("应用配置并开始记录", task)

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
        counts = metrics.get("category_counts") or {}
        lines = [f"{name:15s} {int(counts.get(name, 0))}" for name in CATEGORY_ORDER]
        self.category_text.configure(state="normal")
        self.category_text.delete("1.0", "end")
        self.category_text.insert("1.0", "\n".join(lines))
        self.category_text.configure(state="disabled")

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
