# Firefox Trace Agent Handoff

更新时间：2026-08-03

> **2026-08-06 策略校正**：下文早期“一轮回溯稳态/默认降载”记录仅是历史实验，
> 不代表当前默认值。当前 full-chain 恢复原始首轮覆盖：DOM/BOM、普通 JS、IPC、
> XHR full 和 boundary 原有默认策略不被工具偷偷加总量上限；只有 Agent 配置显式写入
> 环境变量才限制。VM/WASM 仍按 UI 要求默认关闭。每轮整理新增
> `index/trace-health.json`，把显式上限造成的日志缺口与页面运行结果分开报告。

## 0. 当前最新状态 / 接手重点

用户刚按新版思路选择“打开即记录 + 一轮还原模式”后，重页面出现浏览器卡顿/近似卡死。原因判断不是 Firefox 启动流程问题，而是默认 full-chain 叠加了过重采集：

- 打开即记录会覆盖页面加载期，日志洪峰集中在首屏；
- 旧 full-chain 默认 `TRACE_JS_CAPTURE_VALUES=1` / `TRACE_JS_AUTO_CAPTURE_VALUES=1`，全站 JS boundary 同时采 args/return 浅值；
- XHR response 默认 `full`，WASM dump 默认开启，IPC 预算偏大；
- 用户还要求记录验证码/风控鼠标轨迹相关 DOM/BOM 面，进一步增加 DOM signal 范围。

当前策略是“通用完整值落盘”：仍然一轮 trace，args/return 值走内存去重并异步批量落盘，浏览器不再在每个 JS 调用同步写制品；异步 spool 不改变事件覆盖。旧的“一轮回溯稳态/默认降载”段落仅作历史记录，遇到冲突以当前代码、`README.md` 和 `references/ui-options.md` 为准。

### 已落地的默认降载

涉及文件：

```text
tools/trace-control.sh
tools/run-trace-firefox.sh
tools/trace-console-server.py
tools/trace-desktop.py
README.md
gecko-dev/dom/bindings/BindingUtils.cpp
```

核心变化：

```text
TRACE_JS_CAPTURE_VALUES=1
TRACE_JS_AUTO_CAPTURE_VALUES=1
TRACE_JS_VALUE_STORE=1
TRACE_JS_DEFERRED_VALUE_CAPTURE=1
TRACE_JS_DEFERRED_VALUE_POOL_BYTES=67108864
TRACE_JS_BOUNDARY_BUFFER=1
TRACE_JS_BOUNDARY_BUFFER_EVENTS=8192
TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_SEND=8192
TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY=12288
TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL=8192
TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_REQUEST=8192
TRACE_XHR_RESPONSE_BODY=full
TRACE_XHR_RESPONSE_BODY_STORE=1
TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES=0
TRACE_FETCH_RESPONSE_BODY=preview
TRACE_FETCH_RESPONSE_BODY_STORE=1
TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES=0
TRACE_WASM_DUMP=0
TRACE_IPC_MAX_EVENTS_PER_SECOND=12000
TRACE_IPC_MAX_BYTES_PER_SECOND=8388608
FIREFOX_TRACE_JS_LIMIT_EVENTS=0
```

桌面 UI 默认强度改为：

```text
通用完整值落盘（默认）
```

并且“普通 JS trace 不设总数保险丝”在 full-chain 默认打开；discover-light 才使用显式 50000 事件预算。

### 一轮策略的新定义

一轮 trace 不是“所有维度全量深抓”。当前推荐含义是：

1. Network/XHR/Fetch、query/body/header/cookie 目标字段照常记录；
2. Script artifact、source、downloaded assets、hash 照常保留；
3. Cookie/Storage/DOM/BOM signal 照常记录；
4. JS 使用 boundary ring buffer，只在用户配置的 Query/Body 目标字段命中请求时 flush；
   DOM/Cookie/Storage 保留独立信号，但不再高频清空 JS ring；
5. JS args/return 在目标请求的本地窗口内保留值引用和完整去重制品；全站 opcode、VM step、WASM dump 默认后置为“短窗口补证据”。

这样减少打开即记录时首屏洪峰，同时保留 Agent 找链路的关键索引。

## 1. 用户当前关心的问题和答复口径

### 1.1 是否还只需一轮 trace？

默认仍按一轮来采；但一轮是“稳态回溯一轮”，不是“全站深值一轮”。

推荐用户操作：

```text
启动模式：打开即记录
采集计划：full-chain / 通用完整值落盘
VM/JSVMP：一轮还原模式
普通 JS trace 不设总数保险丝：保持打开
Raw HTTP：保持关闭
WASM dump/raw bytes：保持关闭
JS Call：boundary：首轮调用边界
只勾目标字段实际可能出现的位置，未知时四个位置都开
```

`target/deep` 只在 Agent 已写入并加载脚本、函数或 SHA-256 候选后使用。空候选会由桌面中控台显式转为 boundary，并同步 UI 单选状态和日志，禁止再生成 `JS=0` 的伪目标采集。

如果这一轮 summary 里出现 `trace.degraded`、`boundary_buffer_overwrite` 或目标字段缺失，再让 Agent 基于 `target-candidates.json` 给出短窗口补采，而不是让用户手填脚本关键词、PC range、dispatcher PC。

### 1.2 鼠标轨迹 / 验证码会不会被默认关闭影响？

本轮降载关闭的是全站 JS 深值、全量 response、WASM dump、全站 opcode 这类高成本项；不是关闭鼠标轨迹相关 DOM/BOM signal。

已在 `gecko-dev/dom/bindings/BindingUtils.cpp` 的 DOM signal 白名单里加入交互轨迹相关面：

```text
EventTarget.addEventListener/removeEventListener/dispatchEvent
MouseEvent/PointerEvent/TouchEvent/Touch/WheelEvent/KeyboardEvent/InputEvent/DragEvent
clientX/clientY/pageX/pageY/screenX/screenY/offsetX/offsetY/movementX/movementY
button/buttons/modifier/pointerId/pressure/tilt/twist/pointerType/isPrimary
wheel delta、touch radius/force/changedTouches/touches、keyboard key/code/inputType
Element.getBoundingClientRect/getClientRects/clientWidth/clientHeight/offset*/scroll*/value/dataset
Document.elementFromPoint/elementsFromPoint/querySelector/activeElement
```

这部分已重新 build，并通过默认 `signal` 模式 smoke 验证。

### 1.3 为何打开即记录会卡

打开即记录抓加载期证据更完整，但重页面加载期事件峰值很高。旧默认相当于页面加载、请求响应、JS args/return、WASM dump 一起开，日志 IPC 和磁盘写入瞬间放大。现已把默认切成稳态。

## 2. 下一步人工验收

当前 Nightly 已包含 `BindingUtils.cpp` 的交互轨迹 signal。需要再次构建时运行：

   ```bash
   cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
   source ~/.cargo/env
   MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
   MACH_TELEMETRY_DISABLED=1 \
   PATH=/opt/homebrew/opt/lld/bin:$PATH \
   python3.11 ./mach build
   ```

1. 重启桌面 UI：

   ```bash
   cd /Users/empycity/Desktop/JS-tools/firefoxTrace
   open "Firefox Trace Console.app"
   ```

2. 用一个重页面做 smoke：

   - 打开即记录；
   - full-chain；
   - VM 一轮还原模式；
   - Raw HTTP 关闭；
   - 普通 JS trace 不设总数保险丝保持关闭；
   - 触发一次目标请求后停止整理。

3. 检查：

   ```bash
   python3 tools/trace_finalize.py TRACE_DIR --json
   jq '.event_counts,.degraded_count' TRACE_DIR/index/summary.json
   ```

4. 重点确认：

   - 浏览器可操作；
   - 目标 request-field 存在；
   - network/request/response artifact 有 path/hash；
   - script artifact 和 downloaded asset 存在；
   - JS boundary flush 有目标请求附近窗口；
   - DOM/BOM 里有事件监听、鼠标/触摸/坐标读取信号。

## 3. 通用产品原则

- 项目是通用 Firefox Trace 工具，不写死任何站点、字段、SDK。
- UI 不展示站点专名，只展示 query/body/header/cookie 目标字段和通用 VM/WASM 选项。
- 用户不填脚本关键词、PC range、dispatcher PC；这些由 `trace_finalize.py` / analyzer / Agent 自动推导。
- 默认配置以“用户能完成一次真实操作”为优先；全量深抓放在短窗口补证据阶段。
- `trace.degraded`、rate guard、event budget 命中时，本轮只当候选证据。

## 4. 已完成能力概览

- 桌面软件 UI：输入 URL、输出目录、Firefox 路径、profile、启动模式、目标字段、模块、VM/WASM。
- 支持 query/body/header/cookie 四个字段位置，可单独启用/关闭。
- 支持 active / paused / prewarm。
- 支持 full-chain / discover-light。
- 支持 Network、JS、DOM/BOM、Cookie、Storage、Script artifact、WebSocket、Raw HTTP、WASM/VM 分类输出。
- `trace_finalize.py` 生成：

  ```text
  categorized/
  index/summary.json
  index/causal-index.json
  index/target-candidates.json
  downloaded-assets/
  web-assets/
  values/
  scripts/
  ```

- VM 方向已从“用户填过滤条件多轮 trace”重构为“一轮请求触发回溯优先，opcode/VM step 仅自动候选后局部辅助”。
- target candidates 会输出候选脚本、函数上下文、source hash、line/column、function_contains；opcode 热窗口和目标函数上下文不匹配时会标记忽略。

## 5. 当前风险 / 待验证

- `[已通过]` `BindingUtils.cpp` 交互轨迹 signal 已重新 build，并用
  `tests/trace-smoke.html` 验证事件监听、dispatch、鼠标坐标、pointerId、pressure、
  `getBoundingClientRect` 和 `elementFromPoint`。同时修复了重叠接口白名单提前返回导致
  `Element.getBoundingClientRect` 在默认 `signal` 模式漏采的问题。
- 降载后的 full-chain 默认 JS 深值减少，某些字段若只存在于 JS return/args 且未进入 request-field artifact，可能需要 Agent 自动建议短窗口 `target-values`。
- `[已通过]` response body 默认从 `full` 降为 `preview + store` 后，XHR/Fetch 对 8 KiB
  响应仍生成完整 artifact，path/hash/size 校验通过。
- `FIREFOX_TRACE_JS_LIMIT_EVENTS=0` 是 full-chain 默认值；discover-light/VM 等显式窄模式可以使用非零预算，命中后由 `trace-health.json` 报告。
- `[已通过]` 当前 full-chain smoke 的 boundary flush schema 与完整性校验通过，且无
  `trace.degraded`；真实重页面仍需持续关注 `boundary_buffer_overwrite`。
- `[已通过]` 外部脚本同时生成内核 `script.resource` artifact 和 finalizer downloaded
  asset；两份文件大小均为 1,683 bytes，SHA-256 一致，且无 web asset 下载错误。

最近验证目录：`/private/tmp/firefox-trace-current-smoke-complete`。可重复 fixture：

```bash
python3 tests/trace_smoke_server.py --port 8765
python3 tools/trace_check.py interaction TRACE_DIR
python3 tools/trace_check.py fetch-body TRACE_DIR
python3 tools/trace_check.py xhr-response-body TRACE_DIR
python3 tools/trace_check.py boundary TRACE_DIR
```

真实页面回归应以当前运行的 `TRACE_DIR` 和 `manifest.json` 为准。通用 smoke 只验证
请求字段、响应 artifact、boundary flush 和 DOM signal 的 schema；站点、接口、数量、路径
等案例事实统一放在 `examples/<case>/`，不写入本接手文档。
