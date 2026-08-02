# Firefox Trace Agent Handoff

更新时间：2026-08-02

## 当前结论

补充：`docs/AGENT_TRACE_GUIDE.md` 是后续 agent 读懂通用 trace 日志、做补环境/纯算的入口文档；站点样本放在 `examples/` 或 `analysis/`，不属于 `tools/` 主交付链路。

第一阶段核心能力已完成并通过真实站验证。JD `h5st` 和 PDD `anti_content` 都只是验证样本，
不是产品内置规则。当前已新增 `full-chain` 一次采集计划和中文中控台，可支持用户打开可见
Firefox、手动完成前置动作、开始/暂停/停止记录，并把同一操作的多类日志整理到分类目录。

JD `h5st` 和 PDD `anti_content` 都能形成：

1. 首轮轻量 discover 定位目标字段、请求、脚本和调用边界；
2. 从请求 sink / value_store 反推候选脚本或函数；
3. 二轮 target-values 深抓 args/return/object；
4. JS value_store 与请求侧 query/body artifact 用 sha256 对齐。

下一位 agent 可以把第一阶段视为“可交付试用版”。后续重点按 `docs/TODO.md` 推进。
最新一次补了两个收口点：

- `tools/run-trace-firefox.sh` 默认不再固定旧 obj 目录；未设置 `FIREFOX_BIN` 时，会从
  `gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/firefox` 自动选择最新可执行产物。
- `FIREFOX_TRACE_JS=0` / `TRACE_JS=0` 已下沉到
  `js/src/vm/Interpreter.cpp::FirefoxTraceBaseEnabled()`，已重新 build，并用本地 active smoke
  验证：XHR/DOM 仍写日志，`firefox-js-*.jsonl` 不生成。
- `TRACE_JS_AUTO_CAPTURE_VALUES=1` 已接入 boundary 模式：网页脚本调用按
  `TRACE_JS_MAX_ARGS`、`TRACE_JS_OBJECT_DEPTH`、`TRACE_JS_MAX_VALUE_BYTES` 做浅层
  args/return 采集，事件标记 `capture_tier=boundary_auto`；值 metadata 仍受
  `TRACE_JS_VALUE_STORE_MIN_BYTES` 和 IPC/事件预算保护。
- Query 与 Body 已分开支持：`TRACE_QUERY_FIELDS` / `TRACE_BODY_FIELDS`，XHR 与 Fetch
  request body 都写 `body_fields` / `body_fields_meta`，Fetch body 的真实上传流仍通过
  clone 读取。
- `tools/trace_finalize.py` 会把原始 JSONL 生成 `categorized/`、`index/summary.json`、
  `index/causal-index.json`；`tools/trace_check.py full-chain TRACE_DIR` 可做离线校验。
- 中文中控台入口：

  ```bash
  tools/trace-console.sh --host 127.0.0.1 --port 8788
  ```

  API 现在包含 `/api/open`、`/api/start`、`/api/pause`、`/api/stop`、
  `/api/finalize`、`/api/close` 和 `/api/session/status`；`/api/status` 等旧入口继续兼容。
- VM/WASM 选项已进入中控台：opcode、raw operand、栈 slot/primitive、dispatcher
  `vm_step`、WASM dump/raw bytes 均可同一轮配置；opcode/VM 会自动补齐安全上限和 rate
  guard，缺脚本过滤或 dispatcher PC 的配置会直接报错。
- 开启 VM 细粒度时，中控台会自动把 JS call 收窄到目标脚本、关闭 JS 自动浅值并设置
  `FIREFOX_TRACE_JS_LIMIT_EVENTS=12000`，避免普通 JS call 日志把 VM 压力页放大。

本轮已完成 paused 热切换的配置推送与 ACK 协议：Parent 轮询 control revision 并在 content
初始化后立即尝试推送，content 安装后写 `firefox-control-acks.jsonl` 的
`trace.config.applied`，控制台 `/api/status` 可读取 `config_applied`。2026-07-28 headless
paused smoke 已通过：`config --module js=0` 与 `start` 均收到匹配 ACK，首个目标 XHR 带新的
`control_version/config_hash`，且没有 JS trace。关键动作前仍要等待当前 revision ACK；
`trace.config.push` 仅用于诊断，不能替代 applied ACK。

## 用户硬约束

- 最终交付物是魔改 Firefox 浏览器、日志 schema、启动参数和详细使用说明。
- 不要把 JD/PDD/h5st/anti_content 写死进浏览器核心、默认 schema 或默认流程；它们只是验证样本。
- 不要依赖站点专用 Python 分析脚本作为交付路径。开发期 smoke 可以有，但最终应让 AI/用户按使用说明操作。
- 每做完一块内核能力，必须编译，并用本地或真实页面 smoke 验证。
- 如需安装新依赖，暂停，让用户自己安装。
- 所有影响覆盖范围、日志量和页面时序的策略都要可配置；limit/sample 只能当保险丝，不能当主策略。
- 如果出现 `trace.degraded`，该轮日志只能作为候选参考，不能证明链路不存在。
- 用户明确要求过：不要做一半忘记目标；文档要持续同步。
- 自动化可见面属于通用浏览器底层能力，不绑定任何站点；相关改动必须可配置、可回滚，并写入 `manifest.json`。
- 默认 trace launcher 使用 `TRACE_AUTOMATION_SURFACE=baseline` 压平页面可见自动化面；需要 stock Firefox 语义对拍时显式设置 `TRACE_AUTOMATION_SURFACE=stock`。
- 不要把某个站点的检测规则、字段名或返回值写死进浏览器核心；只做通用 API surface、启动参数、profile 和运行时行为的一致化。

## 工作目录和运行路径

项目根目录：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace
```

Gecko 源码：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
```

正确 Firefox 运行路径：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev/obj-aarch64-apple-darwin25.6.0/dist/Nightly.app/Contents/MacOS/firefox
```

`tools/run-trace-firefox.sh` 默认会自动选择最新 `obj-*/dist/Nightly.app/.../firefox`；
需要指定产物时显式传 `FIREFOX_BIN=/abs/path/to/firefox`。

不要运行：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev/obj-aarch64-apple-darwin25.6.0/dist/bin/firefox
```

该路径之前报过：

```text
Couldn't load XPCOM.
```

## 构建命令

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

最近一次构建结果：通过（2026-08-02，obj-aarch64-apple-darwin25.6.0）。

## 当前主要能力

### JS trace

- JS call enter/return。
- `TRACE_JS_MODE=boundary|target|deep`。
- `TRACE_SCRIPT_CONTAINS` / `TRACE_FUNCTION_CONTAINS` / `TRACE_SCRIPT_SHA256`。
- `TRACE_TARGET_MATCH=all|any|auto`。
- object/array/typed array preview。
- 长字符串 value_store。
- `values/<value_id>.txt` 保存完整值。
- `origin_call_id` / `parent_call_id` 辅助链路回溯。
- `full-chain` 下的 boundary 自动浅值：`capture_tier=boundary_auto`、
  `capture_status=boundary_auto_values_preview`、受限 `data.args` / `data.return`。
- boundary ring buffer：首轮 discover 保调用边界，sink 触发 flush。
- boundary ring buffer 支持按 sink reason 设置 flush 窗口，例如
  `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY` / `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL`；
  XHR/Fetch URL query 和 XHR body 命中 `TRACE_QUERY_FIELDS` 时，会进一步使用字段级
  reason，例如 `xhr.body.anti_content` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY_ANTI_CONTENT`；
  `js.boundary.flush_summary` 会记录 `skipped_by_window`、`window_capacity`、
  `storage_capacity` 和 `window_capacity_source`。

### DOM / Cookie / Storage

- DOM get/call signal 模式。
- document.cookie / CookieStore API trace。
- HTTP Set-Cookie。
- CookieStorage lifecycle。
- localStorage/sessionStorage lifecycle。

### XHR / Fetch

- XHR open/send/body/response。
- XHR URL `query_fields` 和 value_store。
- XHR request body bounded preview/store/sha256。
- XHR responseText 完整 artifact：`TRACE_XHR_RESPONSE_BODY=full` +
  `TRACE_XHR_RESPONSE_BODY_STORE=1`，`TRACE_XHR_RESPONSE_BODY_STORE_MAX_BYTES=0`
  表示 trace 层不按大小丢弃；`xhr.response` 带 path/size/SHA-256。
- XHR body 字段抽取：
  - JSON body；
  - form-urlencoded body；
  - 字段名使用 `TRACE_BODY_FIELDS`，为空时回退 `TRACE_QUERY_FIELDS`。
- Fetch call/request/response/done。
- Fetch request body clone preview/store。
- Fetch request body JSON/form 字段抽取和 `body_fields_meta`。
- Fetch response headers。
- Fetch response body clone preview、`body_chunk` preview 和
  `fetch.body_artifact` 完整响应制品已有基础能力；完整制品由正常网络读路径旁路保存。

### script.resource

- 外部脚本资源事件 `script.resource`。
- 记录脚本 URL、final URL、content-type、charset、source map header、headers、decoded length。
- 可选 raw capture/store。
- 默认 `TRACE_SCRIPT_RESOURCE_FILTER=web`，避免扩展/chrome 噪声。

## 本轮新增能力

新增 runtime trace control：

```bash
tools/run-trace-firefox.sh --trace-preset discover-light --trace-start paused 'https://target.example/'
tools/trace-control.sh "$TRACE_DIR" config --segment discover --preset discover-light --query-fields h5st,anti_content
tools/trace-control.sh "$TRACE_DIR" start discover
tools/trace-control.sh "$TRACE_DIR" stop after-target
tools/trace-control.sh "$TRACE_DIR" new-segment target-values
tools/trace-control.sh "$TRACE_DIR" config --preset target-values --script-contains '<script-substr>' --function-contains '<fn-substr>'
tools/trace-control.sh "$TRACE_DIR" start target-values
tools/trace-control.sh "$TRACE_DIR" status
```

当前行为：

- launcher 支持 `--trace-start active|paused|prewarm`。
- 每轮写入 `TRACE_DIR/trace-control.json`，并把 control file path、初始状态写入
  `manifest.json`。control schema 当前为 `firefox_trace.control.v2`。
- `tools/trace-control.sh` 支持 `config/new-segment/start/stop/prewarm/status`，只改控制文件并追加
  `firefox-control.jsonl`，不杀浏览器、不改 profile。
- control v2 包含 `segment_id`、`segment_label`、`config_hash`、`modules` 和可热切 `env`。
- Gecko 侧 runtime gate 已下沉到 JS/DOM/XHR/Fetch/Storage/Cookie 的 enabled 入口；
  paused/prewarm 下不会继续做主要 preview/value_store/body_store/boundary buffer 重活。
- 最新补丁：JS 入口已额外尊重 `FIREFOX_TRACE_JS=0` / `TRACE_JS=0`，用于控制台
  module checkbox 的运行时关闭；该点已 build，并用启动级 active smoke 验证。
- Parent 进程会通过 `FirefoxTraceRuntimeConfig` IPC 把 control config 推给 content 进程；
  JS trace 能在同一浏览器进程内从 boundary/discover 切到 target/value。
- Parent/content 的 `FirefoxTraceRuntimeConfigApplied` ACK 协议与 console status 已接入，
  2026-07-28 paused headless smoke 已收到初始、`config --module js=0` 和 `start` 的
  匹配 ACK。`config_applied.ready=true` 是切换目标配置后触发关键动作的生效门槛。
- Parent 写 JSONL 前统一注入 `segment_id`、`control_version`、`config_hash`。
- ContentChild/ContentParent 写入前仍有二次 gate，避免漏写。
- 控制状态按 200ms 缓存刷新；每次刷新直接重读小控制文件，避免同秒/同大小 start/stop
  被 mtime 判断漏掉。
- 控制 JSON 解析只看 `previous_state` 之前的顶层字段，避免 start 后误命中
  `previous_state.enabled=false`。
- safety：`trace-control.sh start` 会拒绝无脚本/函数/hash 过滤的 `js_mode=deep`；
  `TRACE_JS_OBJECT_DEPTH>2` 也需要显式 `TRACE_UNSAFE_ALLOW=1`。
- 最新 smoke：`/private/tmp/firefox-trace-runtime-segments-smoke6`，同一个 Firefox
  进程先跑 `discover-light` segment，再切到 `target-values` segment；`seg_003`
  成功出现 `js_mode=target`、`target_match=true` 和 `js.value.store`。
- 桌面控制台 v1 已实现：`tools/trace-desktop.py` 与 `Firefox Trace Console.app`；Web/API 控制台保留为 `tools/trace-console-server.py` / `tools/trace-console.sh`。
  - Python 环境：默认固定 `/opt/miniconda3/envs/firefox-trace/bin/python`；
    只有显式设置 `FIREFOX_TRACE_PYTHON=/path/to/python` 才会替换。
  - 桌面启动：双击 `Firefox Trace Console.app` 或执行 `tools/trace-desktop.sh`；
  - Web 启动：`tools/trace-console.sh --host 127.0.0.1 --port 8788 --trace-dir "$TRACE_DIR"`；
  - UI 默认使用 `full-chain`；
  - Agent API：`/api/open`、`/api/status`、`/api/session/status`、`/api/summary`、
    `/api/config`、`/api/new-segment`、`/api/start`、`/api/pause`、`/api/stop`、
    `/api/finalize`、`/api/close`、`/api/prewarm`；
  - 中控台状态每秒读取新增 JSONL，显示事件速率、分类计数、字段命中、Producer 候选、
    ACK 和 degraded 状态；
- 本地 full-chain smoke 已通过：`/private/tmp/firefox-trace-full-chain-smoke-20260802-final`。
- 最新构建 Fetch request body smoke 已通过：
  `/private/tmp/firefox-trace-fetch-request-body-full-chain-1Zu2Nx`；
  `fetch.request` 实际包含 `body_fields.token`、`body_fields_meta` 和
  `values/fetch_req_body_*.txt`，整理后的 full-chain 校验通过。
- 中控台 `/api/latest` 已回归：只枚举带 `manifest.json` 的 trace 目录，并排除
  `*-profile` 目录。
- JS value_store 的长值 artifact 按 SHA-256 命名并去重；不同 `value_id` 可引用相同
  `values/<sha256>.txt`。这减少二轮 args/return 重复值的 IPC 和磁盘写入。
- launcher preset 新增 `TRACE_IPC_MAX_EVENTS_PER_SECOND` / `TRACE_IPC_MAX_BYTES_PER_SECOND`
  保活预算。超限写一次 `trace.degraded module=ipc reason=event_budget`，该段不作完整证据。
- 已验证：JS 模块启动级关闭 smoke；patch 已重新生成。

新增 automation surface baseline：

```bash
TRACE_AUTOMATION_SURFACE=stock|baseline
```

当前行为：

- launcher 默认 `baseline`，并写入 `manifest.json` 的 `automation_surface` 和 `env.TRACE_AUTOMATION_SURFACE`。
- `Navigator::Webdriver()` 在 `baseline` 下固定向网页返回 `false`。
- `stock` 模式保留 Firefox 原始逻辑：Marionette 或 RemoteAgent running 时返回 `true`。
- 有头窗口 `gRemoteControl` 在 `baseline` 下不显示远程控制提示 UI；`stock` 保留原始提示。
- `about:support` / Troubleshoot 的 RemoteAgent provider 在 `baseline` 下返回 not running，避免排障页直接暴露远控监听信息。
- 该改动不关闭 Marionette、RemoteAgent 或 WebDriver/BiDi 控制通道，因此不应影响 MCP 操作浏览器。
- 新增本地对拍页 `tests/automation-surface.html`，用于采集 webdriver、UA/app、OS、languages、plugins、permissions、screen/window、visibility、WebGL/GPU 等页面可见值。
- launcher 默认 trace/profile 临时目录增加 pid 后缀，避免并行 smoke 同秒撞 profile。
- `manifest.json` 的 `target_url` 会跳过 `--marionette`、`--remote-debugging-port` 等 Firefox 控制参数，记录实际页面参数。
- `profiles/trace-user.js` 默认降低 Remote Settings 日志并拉长轮询间隔，用于减少浏览器 chrome 后台噪声；这不是页面指纹 spoof。
- `AppProvidedSearchEngine` 在 `baseline` 下对搜索图标 Remote Settings attachment 缺失安静返回，并跳过 idle 后台下载；`stock` 保留 Firefox 原始行为。
- `remote-settings.sys.mjs` 在 `baseline` 下禁用后台 startup bundle、timer poll 和 broadcast poll；packaged dump 读取路径保留。

新增 P1 boundary sink window：

- `discover-light` 默认给关键请求 sink 更长窗口、DOM sink 更短窗口：
  - `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_GET=2048`
  - `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL=2048`
  - `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_SEND=12288`
  - `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY=16384`
  - `TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL=12288`
- 物理 ring 保留 32768 条，flush 时按当前 sink 窗口裁剪。
- 本地 smoke：
  - 目录 `/private/tmp/firefox-trace-boundary-window-abs-1785123980`
  - 配置 `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL=3`
  - `js.boundary.flush_summary` 显示 `reason=dom.call`、`flushed=3`、
    `skipped_by_window=42`、`window_capacity_source=TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL`。

新增 XHR request body 通用 trace：

```bash
TRACE_XHR_REQUEST_BODY=none|preview|full
TRACE_XHR_REQUEST_BODY_MAX_BYTES=65536
TRACE_XHR_REQUEST_BODY_HEX_BYTES=64
TRACE_XHR_REQUEST_BODY_STORE=0|1
```

`xhr.body` 新字段：

- `request_body_mode`
- `request_body_size`
- `request_body_captured_size`
- `request_body_truncated`
- `request_body_sha256`
- `request_body_preview`
- `request_body_bytes_hex`
- `request_body_value_id`
- `request_body_store_path`
- `request_body_stored`
- `body_fields`
- `body_fields_meta`

实现文件：

- `gecko-dev/dom/xhr/XMLHttpRequestMainThread.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`
- `tools/run-trace-firefox.sh`

文档：

- `README.md`
- `docs/TRACE_PROGRESS.md`

本地 smoke 页面：

- `tests/xhr-request-body.html`

## 验证证据

### runtime trace control smoke

最新构建：通过，1065 warnings。

本地 server：

```bash
python3 -m http.server 8771 --bind 127.0.0.1 --directory tests
```

运行命令：

```bash
TRACE_RUN_LABEL=runtime-control-smoke \
TRACE_CAMPAIGN_ID=runtime-control-smoke \
TRACE_QUERY_FIELDS=anti_content \
TRACE_XHR_EVENTS=open,send,response \
TRACE_REQUEST_URL=preview \
TRACE_DOM_MODE=signal \
TRACE_DOM_PREVIEW=none \
tools/run-trace-firefox.sh --trace-preset discover-light --trace-start paused \
  'http://127.0.0.1:8771/runtime-control.html?auto=1&delay=20000'
```

目录：

```bash
/private/tmp/firefox-trace-1785146389-29562
```

结果：

- paused 启动后没有业务日志。
- `tools/trace-control.sh ... start target` 后，自动 XHR 触发并生成：
  - `firefox-xhr-29562.jsonl` 3 行：`xhr.open`、`xhr.send`、`xhr.response`；
  - `firefox-js-29562.jsonl` 2 行，包含 `js.boundary.flush_summary`；
  - 字段：`anti_content=runtime-control-token-1785146413444`；
  - `origin_call_id=call_2530`；
  - `complete_window=true`，`dropped_before_flush=0`，`skipped_by_window=0`。
- `tools/trace-control.sh ... stop after-target` 后再次打开自动触发页面：
  - server 收到 `runtime-control-token-1785146465792` 请求；
  - `firefox-xhr-29562.jsonl` 仍为 3 行；
  - `firefox-js-29562.jsonl` 仍为 2 行。

结论：paused/start/stop 对最新构建有效，且 stop 后不再追加业务 trace。

### automation surface smoke

目录：

```bash
/private/tmp/firefox-trace-surface-baseline
/private/tmp/firefox-trace-surface-stock
```

截图：

```bash
/private/tmp/firefox-trace-surface-baseline.png
/private/tmp/firefox-trace-surface-stock.png
```

结果：

- baseline manifest：`automation_surface=baseline`，`env.TRACE_AUTOMATION_SURFACE=baseline`。
- stock manifest：`automation_surface=stock`，`env.TRACE_AUTOMATION_SURFACE=stock`。
- baseline 截图：页面 JSON 显示 `webdriver: false`。
- stock 截图：页面 JSON 显示 `webdriver: true`。
- 两轮都有 `firefox-dom-*.jsonl`，能看到 `Navigator.permissions`、`Permissions.query`、`Document.createElement`、`HTMLCanvasElement.getContext`、`WebGLRenderingContext.getParameter` 等 DOM trace 事件，说明 trace 通道仍工作。
- 两轮都通过 `--marionette` 启动；baseline 只改变页面 API 返回值，没有关闭控制通道。
- 新增有头远控 UI gate 和 `about:support` RemoteAgent gate 后已重新运行 Gecko build，结果通过。
- profile 已补 `services.settings.loglevel=off`，并继续保留长轮询间隔，用于压低后台噪声。
- search icon attachment 噪声已加 Gecko baseline gate，并已重新 build/smoke。
- Remote Settings 后台 poll/startup bundle 已加 Gecko baseline gate，并已重新 build/smoke。

launcher manifest 单测：

```bash
FIREFOX_BIN=/usr/bin/true \
TRACE_DIR=/private/tmp/firefox-trace-manifest-target-test \
PROFILE_DIR=/private/tmp/firefox-trace-profile-manifest-target-test \
tools/run-trace-firefox.sh --marionette tests/automation-surface.html
```

结果：`manifest.json.target_url` 为 `tests/automation-surface.html`，不再误写成 `--marionette`。

### XHR request body smoke

目录：

```bash
/private/tmp/firefox-trace-xhr-request-body-smoke-1785065876
```

结果：

- `xhr.body` 捕获：

```json
{"anti_content":"trace-xhr-request-body-token","nested":{"n":11}}
```

- body sha256：

```text
032277ddb395b4d2805d519fc6fe16ad52730540dd088108c692682f3dec9f05
```

- body artifact：

```bash
values/xhr_req_body_66874_1.txt
```

- 字段 artifact：

```bash
values/qfv_xhr_66874_1.txt
```

- response status 200，说明 trace 没有消费/破坏请求体。

### JD h5st

#### paused-flow search smoke（最新）

目录：

```bash
/private/tmp/firefox-trace-1785149433-86188
```

流程：

- 使用 `--trace-start paused` 打开 JD。
- 用户手动登录、搜索和跳转，paused 阶段不写业务 trace。
- 用户确认页面稳定后执行：

  ```bash
  tools/trace-control.sh /private/tmp/firefox-trace-1785149433-86188 start jd-search
  ```

- 用户触发翻页/搜索接口后执行：

  ```bash
  tools/trace-control.sh /private/tmp/firefox-trace-1785149433-86188 stop after-page2
  ```

结果：

- 登录和搜索跳转不再 crash。
- 总日志约 12MB：
  - `firefox-js-86188.jsonl`：27197 行；
  - `firefox-xhr-86188.jsonl`：40 行；
  - `firefox-cookie-86188.jsonl`：157 行；
  - `firefox-storage-86188.jsonl`：50 行；
  - `firefox-script-86188.jsonl`：1 行。
- 主搜索请求：
  - `request_id=xhr_166`
  - `functionId=pc_search_searchWare`
  - 请求 body 里记录到 `page=3`。用户口头触发的是“page=2/第二页”，日志以实际 API body 为准。
  - `origin_call_id=call_1446748`
  - caller：`https://storage.360buyimg.com/pubfree-basic/pc-risk/2.1.0/pc-core-disposal.js:1`
  - `h5st` 长度 1195；
  - `h5st` sha256：`e2e5624564c2f17106c3b702d2abcfd2a27899dfd0d9c595947f13dc1b761d47`
  - 完整值：`values/qfv_xhr_86206_213.txt`、`values/qfv_xhr_86206_215.txt`
- 同轮还捕获：
  - `pc_search_adv_Search`
  - `pctradesoa_mixer`
  - `pc_club_productCommentSummaries`
- `xhr.open.h5st` 的 boundary summary：
  - `flushed=168`
  - `dropped_before_flush=0`
  - `skipped_by_window=0`
  - `complete_window=true`

这轮是 `discover-light` 边界模式，所以结论是候选链路，不是完整算法中间值：

- 请求 sink 位于 `pc-core-disposal.js`：
  - `onRequest`
  - `DisposalSDK.prototype.attachCustomHeader`
  - `D<`
  - `send`
- 生成候选位于 `pc-tk.js?v=2024-06-20-17`：
  - `getJsToken`
  - `__getTkResult`
  - `__callbackWrapper`
  - 高频 helper `_0x1d73`
- 业务调用候选位于 `main_search/pro/0.0.11/js/index.6fe45f56.js`：
  - `Rw/u<`
  - `$m`
  - `aj</<`

如果要继续看 h5st 的中间入参、return、对象字段，需要以这些脚本/函数作为候选再跑
`target-values`，开启 `TRACE_JS_ARGS` / `TRACE_JS_RET` /
`TRACE_JS_OBJECT_DEPTH` / `TRACE_JS_VALUE_STORE`。

#### target-values 二轮深抓

前置验证目录：

```bash
/private/tmp/firefox-trace-jd-h5st-target-values-fix-1785150459-35916
```

metadata 验证目录：

```bash
/private/tmp/firefox-trace-jd-h5st-target-values-meta-1785151960-86646
```

流程：

- 首次用 `target-values + paused` 打开 JD 时曾启动即 crash。
- crash reason：

  ```text
  MOZ_RELEASE_ASSERT(mWorkerThread && mWorkerThread->IsOnCurrentThread()) (not on worker thread!)
  ```

- 符号化栈显示：worker 脚本执行期间，`AutoFirefoxTraceJSCall` 写 JS 事件，调用
  `PContentChild::SendFirefoxTraceDOMEvent`，但 PContent IPC 只能在 content main thread
  使用。
- 修复：
  - `FirefoxTraceSendEventToParent`
  - `FirefoxTraceSendValueToParent`
  - `FirefoxTraceSendScriptSourceToParent`
  在非主线程不进入 IPC，首次跳过时直接写一次
  `trace.suppressed reason=worker_thread_ipc_unsupported`，避免 Worker trace 缺失无迹可查。
  - `FirefoxTraceWriteJSEventLineRaw`
  - `FirefoxTraceWriteJSValueStoreFile`
  - `FirefoxTraceWriteJSScriptSourceFile`
  增加 `FirefoxTraceBaseEnabled()` active gate。
- 修复后重新 build 通过，并重新打开 `target-values + paused`，启动稳定。

前置二轮结果：

- start：`jd-h5st-target-values-deep2`
- stop：`after-target-trigger`
- 浏览器稳定，无 content crash。
- 日志体量约 14MB：
  - XHR：52 行；
  - Cookie：121 行；
  - Storage：65 行；
  - JS jsonl：2 行；
  - `values/jsv_*.txt`：1121 个。
- XHR 捕获 4 组 h5st：
  - `pc_search_searchWare`：sha256 `bb172d8a0f417db38a89fed63b17406ee7e3b961cb57bf20e2f270aa4879c374`
  - `pc_search_adv_Search`：sha256 `52799107ef546a1eed3314bc02ec7903859d3738f6c65780459334fae5c1d52b`
  - `pctradesoa_mixer`：sha256 `b87562c2e925f9704cf3f39931936c4b530e675ef1b4315b8d0d7621ab985277`
  - `pc_club_productCommentSummaries`：sha256 `b37d8024d39df4f2a54ddc387d13bc6bc583117f834e831749cf9c72002c8e71`
- JS value artifact 与 XHR h5st 完全对齐：
  - 每组 h5st 都有 16 个 `values/jsv_*.txt` 与请求侧 `values/qfv_xhr_*.txt`
    sha256 完全相同。
  - 例：主搜索 `pc_search_searchWare` 对齐
    `values/qfv_xhr_35932_269.txt` / `values/qfv_xhr_35932_271.txt`
    和 `values/jsv_35932_5255.txt`、`values/jsv_35932_5269.txt` 等 16 个 JS value。

该轮暴露的缺口：

- `target-values` 这轮能证明 JS 层出现了最终 h5st 完整值，但 JS 事件 jsonl 没有保留
  这些 `jsv_*` 的函数上下文；因此这轮还不能直接从日志说“某个具体函数 return 了该值”。
- 已修 JS value_store metadata，并用 metadata 验证目录重新跑 JD。

metadata 验证结果：

- start label：`jd-h5st-meta-target`
- stop label：`after-h5st-meta-trigger`
- 浏览器稳定，无 content crash。
- 目录约 16MB：
  - `firefox-js-86646.jsonl`：1036 行；
  - `js.value.store`：1032 行；
  - XHR：76 行。
- 无 `trace.degraded`、无 event limit、无 hot-function 抑制；只出现 XHR body
  `non_string_or_empty` skipped，不影响 URL query 中的 h5st。
- XHR 捕获 4 组 h5st：
  - `pc_search_searchWare`：sha256 `7f2917e203c397f6c4ad0f6a52ea7422df0abf28689c75704bdea65856ecb1e4`
  - `pc_search_adv_Search`：sha256 `47c26a31bc4a449f3e3f5b7a11d119b9a4b3e2f6299a31961a3441e90713830c`
  - `pctradesoa_mixer`：sha256 `75071dd642f72cf840a7d5a4a85cfa7cb29340cee915b5084db884b881e87076`
  - `pc_club_productCommentSummaries`：sha256 `fa86e7446fd46304b017d658e2473e17c3f6758f5641633a11787e7c03c99de6`
- 每组 h5st 在 `js.value.store` metadata 中命中 16 条，能反查
  `value_id`、`value_store_path`、`call_id`、`parent_call_id`、`function_name`、
  `script_url`、`value_role`、`arg_index`、`value_path`。
- 主搜索 `pc_search_searchWare` 的关键链路已经能从日志直接看出：
  - `_$PI.prototype.signSync` return `h5st`
  - `_$PI.prototype._$sdnmd` return `h5st`
  - `_$PI.prototype._$ms` return `h5st`
  - `_$PI.prototype._$gsp` return 同 sha256 字符串
  - `bhikZ` / `_$fv` / `resolve` / `_$hc` / `EiLPS` / `_$R0` 等 helper
    继续把同一份 h5st 作为参数或返回值传递。

当前剩余边界：

- 最新能力能看到最终 h5st 从签名函数返回、helper 传递到 XHR sink 的链路；
  如果要还原更细的算法内部中间值，需要下一阶段按候选脚本/函数继续做
  `deep-causal`、动态调试或 opcode/window。
- 本轮继续补了短字符串字段 metadata：
  - `TRACE_JS_VALUE_METADATA=1`
  - `TRACE_JS_VALUE_METADATA_MIN_BYTES=1`
  - `TRACE_JS_VALUE_STORE_MIN_BYTES`
  target/deep preset 默认开启 metadata；短字符串默认只写 metadata，不强制落盘。
- 本地验证目录：`/private/tmp/firefox-trace-value-metadata-object-smoke`。
  测试页 `tests/value-metadata.html` 的 `makeTraceParts` return 对象中
  `ts/fp/app/token/digest/version/payload` 都写出 `js.value.store` metadata：
  `stored=false`、`preview`、`sha256`、`value_path`、`call_id`。
- 最新 JD 复验目录：`/private/tmp/firefox-trace-1785153736-41130`。
  结果无 `trace.degraded`；主搜索 `pc_search_searchWare` 的 h5st sha256
  `090a7f323ec9faffc7fcc0db9f57cb3a4fb230718ebaf85aae7940b7890020fe`
  在 JS metadata 中命中 16 条。10 个 h5st 分段里，0/1/2/3/4/5/7/8/9
  都已有独立 exact 或 digest/source-string 证据；第 6 段是 number 时间戳，
  当前在 call/object preview 中出现，不属于 string metadata。
- 已补 primitive metadata：
  - `TRACE_JS_PRIMITIVE_METADATA=1`
  - `TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES=1`
  target/deep preset 默认开启。
  本地验证目录：`/private/tmp/firefox-trace-primitive-metadata-smoke`，
  `ts_num` 写出 `value_type=number`，`ok` 写出 `value_type=boolean`。
- 最新 JD primitive metadata 真实页复验：
  - 目录：`/private/tmp/firefox-trace-1785161281-80006`
  - 配置：`target-values + paused`，宽脚本过滤
    `TRACE_SCRIPT_CONTAINS=js_security_v3,js-security-v3-rac`，
    `TRACE_TARGET_MATCH=any`，开启 string/primitive metadata。
  - `firefox-js-80006.jsonl` 8764 行；`js.value.store` 8764 条：
    string 3475、number 4592、boolean 697、`stored=true` 116。
  - 捕获 `pc_home_feed` 两组 XHR h5st：`xhr_61` page=3、`xhr_62` page=4，
    h5st 长度均为 1155。
  - 以 `xhr_61` 为样本，h5st 10 个分段都有 JS 侧证据；此前缺口的第 6 段
    13 位时间戳已由 primitive metadata 精确命中：
    `_$f6` arg0 和 `_$PI.prototype._$gsp` arg1，`value_type=number`。
  - 其它关键段也能定位到候选生成/传递点：`_$fg/_$fp/get`、`_$pam/ZNEiI`、
    `_$PI.prototype._$gs`、`_$PI.prototype._$clt/_$ms`、`_$PI.prototype._$gsd`、
    `encode`、`_$PI.prototype._$gsp`。
  - 无 `trace.degraded` / dropped / truncated 类降级事件。
- 大 JS event Parent send 失败会返回 false，由 `FirefoxTraceWriteJSEventLineRaw` 回退到本地
  JSONL；IPC budget 丢弃首条会写 `trace.degraded module=ipc reason=event_budget`。
- Worker JS trace 当前不经 IPC，首次跳过会写
  `trace.suppressed reason=worker_thread_ipc_unsupported scope=worker`。如需采集 Worker
  事件本身，后续再引入 dedicated cross-thread queue。

#### first-phase target 对齐验证（早期）

目录：

```bash
/private/tmp/firefox-trace-jd-firstphase-target-1785065263
```

关键结果：

- 无 `trace.degraded`。
- `h5st` 请求侧命中 34 个 value_store，15 个唯一 sha256。
- 生成/返回侧命中：
  - `_$PI.prototype.signSync`
  - `_$PI.prototype._$sdnmd`
  - `_$Yx.prototype.signSync`
  - `_$Yx.prototype._$sdnmd`
- 至少一组 JS return 与 XHR `h5st` 请求字段 sha256 完全一致：
  - `values/jsv_50839_9.txt`
  - `values/jsv_50839_10.txt`
  - `values/qfv_xhr_50839_2.txt`

结论：JD 能看到生成/返回侧和请求侧，并能做 value 对齐。

### PDD anti_content

discover 目录：

```bash
/private/tmp/firefox-trace-pdd-firstphase-search-1785065942
```

target 目录：

```bash
/private/tmp/firefox-trace-pdd-firstphase-target-search-1785066090
```

测试页：

```text
https://mobile.yangkeduo.com/search_result.html?search_key=%E6%89%8B%E6%9C%BA
```

discover 结果：

- 无 `trace.degraded`。
- `xhr_9`：
  - `POST https://mobile.yangkeduo.com/proxy/api/search?pdduid=0`
  - response status 403，但参数已经生成并发送。
  - `xhr.body` 捕获完整 JSON request body，包含 `anti_content`。
  - body artifact：`values/xhr_req_body_67790_5.txt`
  - 字段 artifact：`values/qfv_xhr_67790_2.txt`

target 结果：

- 对 `search_result` 脚本做 target-values。
- JS 入参 `req_params` 包含完整 `anti_content`。
- 命中函数：
  - `881/t.Ay`
  - `12401/_</<`
  - `12401/x</<`
  - `e`
- 多条 JS value artifact 和 XHR body artifact 内容一致。
- 关键 sha256：

```text
064d819c51dc7bf4c296074d0be4e1f1ce803a1d2ca1042daefc57c73fb37a4e
```

对应：

```bash
values/jsv_70420_1.txt
values/jsv_70420_2.txt
...
values/jsv_70420_10.txt
values/xhr_req_body_70420_5.txt
```

结论：PDD 这轮看到的是组包/发送链路，不是算法内部每一步。已能从请求侧反推到 JS 业务脚本传递点，并用 sha256 证明 JS 入参与最终 XHR body 是同一份参数。

## 推荐工作流

### 首轮 discover

目标：不要预先猜函数名，先保留请求、脚本身份、调用边界和长字符串。

示例：

```bash
TRACE_HEADLESS=1 \
TRACE_DIR=/private/tmp/firefox-trace-discover-$(date +%s) \
TRACE_RUN_LABEL=discover \
TRACE_QUERY_FIELDS=anti_content,h5st,sign,token \
TRACE_QUERY_FIELD_VALUE_STORE=1 \
TRACE_SCRIPT_RESOURCE=1 \
TRACE_SCRIPT_RESOURCE_FILTER=web \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_PREVIEW=body \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
./tools/run-trace-firefox.sh --trace-preset discover-light '<url>'
```

### 二轮 target

目标：根据首轮 sink / script.resource / origin_call_id 反推脚本或函数，再深抓 args/return/object/value_store。

示例：

```bash
TRACE_HEADLESS=1 \
TRACE_DIR=/private/tmp/firefox-trace-target-$(date +%s) \
TRACE_RUN_LABEL=target \
TRACE_QUERY_FIELDS=anti_content,h5st,sign,token \
TRACE_QUERY_FIELD_VALUE_STORE=1 \
TRACE_SCRIPT_RESOURCE=1 \
TRACE_SCRIPT_RESOURCE_FILTER=web \
TRACE_SCRIPT_CONTAINS='<candidate-script-substring>' \
TRACE_FUNCTION_CONTAINS='<candidate-function-substring>' \
TRACE_JS_OBJECT_VALUE_KEYS=anti_content,req_params,h5st,sign,body,data \
TRACE_JS_ARGS=preview \
TRACE_JS_RET=preview \
TRACE_JS_OBJECT_DEPTH=2 \
TRACE_JS_OBJECT_KEYS=64 \
TRACE_JS_VALUE_STORE=1 \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_PREVIEW=body \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
./tools/run-trace-firefox.sh --trace-preset target-values '<url>'
```

## P3 Opcode / VMP 接手状态（2026-07-28）

`docs/TODO.md` 是任务状态的唯一入口。本节记录已落地的 P3 当前状态、验收方法和接手
边界，避免把小 fixture 的事件数量误解为内核容量。

### 已实现

- SpiderMonkey `Interpret()` 的 `ADVANCE_AND_DISPATCH` 在 opcode 模式下写
  `js.opcode`。事件含 `script_url`、`pc`、`op/op_name`、bytecode length、
  `origin_call_id`、segment/control 元数据。
- raw operand：`operand_format`、`operand_bytes_hex`；最大 16 operand bytes，超过标记
  `operand_bytes_truncated=true`。
- 栈侧元数据：`stack_depth`、`stack_uses`、`stack_defs`；
  `TRACE_OPCODE_STACK_SLOTS=0..8` 时记录 `stack_top` 类型。仅
  `TRACE_OPCODE_STACK_PRIMITIVES=1` 时记录 number/boolean/null/undefined 值，字符串和
  对象只写类型。
- 上限为独立的 `TRACE_OPCODE_LIMIT`，每个 segment 默认 10,000 条；到达后写
  `trace.degraded module=opcode reason=opcode_limit`。Parent 已把 `module=opcode` 正确
  路由到 `firefox-js-*.jsonl`。
- launcher 的 `opcode-window` preset 默认：`TRACE_OPCODE_LIMIT=4096`、
  `TRACE_OPCODE_OPERANDS=1`、`TRACE_OPCODE_STACK_SLOTS=2`、
  `TRACE_OPCODE_STACK_PRIMITIVES=0`。缺少 `TRACE_OPCODE_SCRIPT_CONTAINS` 或
  `TRACE_SCRIPT_CONTAINS` 时 launcher 退出，避免无目标脚本的 opcode run。
- opcode/VM 默认还包含 `TRACE_OPCODE_EXECUTION_LIMIT=65536`、`TRACE_VM_STEP_LIMIT=2048`、opcode
  `2000 events/s + 4 MiB/s` 和 IPC `6000 events/s + 4 MiB/s` 的 rate guard；
  `trace-control.sh` 直接配置时同样自动补齐。

实现文件：

- `gecko-dev/js/src/vm/Interpreter.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`
- `tools/run-trace-firefox.sh`
- `tests/opcode-window.html`
- `tests/vmp-fixtures.html`
- `tools/trace_opcode_analyzer.py`

### 配置与容量

以下均为启动级配置；`TRACE_EXECUTION_MODE`、`TRACE_OPCODE`、script filter、PC range、
limit、operand/stack 开关在控制台中都属于 restart-required，不能在已启动的 opcode
进程上热切换。

```bash
TRACE_EXECUTION_MODE=opcode
TRACE_OPCODE=1
TRACE_OPCODE_SCRIPT_CONTAINS='<target-script-substring>'
TRACE_OPCODE_SCRIPT_LINE=LINE             # 可空，由 analyzer tier_pin_env 给出
TRACE_OPCODE_SCRIPT_COLUMN=COLUMN         # 可空
TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH=LEN   # 可空
TRACE_OPCODE_PC_RANGE='START:END'       # 可空
TRACE_OPCODE_LIMIT=4096                 # 安全默认；范围由 trace-control 校验
TRACE_OPCODE_EXECUTION_LIMIT=65536      # 解释执行预算；到达后允许回 JIT
TRACE_OPCODE_OPERANDS=1
TRACE_OPCODE_STACK_SLOTS=2              # 安全 preset；内核支持 0..8
TRACE_OPCODE_STACK_PRIMITIVES=0
TRACE_VM_STEP=1
TRACE_VM_DISPATCH_PC=START             # 必填；使用 analyzer 的 dispatcher window 起点
TRACE_VM_STEP_LIMIT=2048
```

fixture 的 255/469/551 条事件是各自小程序的实际执行次数，不是采集器的固定上限。真实
VMP 的 dispatch loop 会随循环、输入和触发窗口产生远高于此的数量，最终由 PC window、
script filter 与 `TRACE_OPCODE_LIMIT` 共同收敛。高频 fixture 已验证 limit=128 时页面仍能
完成脚本并写降级哨兵。

opcode 现已按 script URL 和可选 line/column/bytecode length 做 script-level tier pin；
JIT entry、LoopHead OSR、解释器 inline callee 和事件写入使用同一条件。真实页仍应使用
paused 启动、短触发窗口和保守 limit。PC window、tier-pin 和 heuristic dispatcher
autodetect 和 `jsvmp/vm_step` 已完成。vm_step 只在显式配置的 native dispatcher PC
写入一次 `js.vm_step`，记录 `step_index`、JSScript identity、`vm_dispatch_pc` 和当前
stack depth，并有独立 per-segment limit；它不是 VMP virtual instruction / virtual PC
自动解码。当前 opcode 仍描述 SpiderMonkey bytecode。

运行时配置：script identity/tier-pin 需要重启；`TRACE_OPCODE_PC_RANGE`、
`TRACE_OPCODE_LIMIT`、`TRACE_VM_STEP`、`TRACE_VM_DISPATCH_PC`、`TRACE_VM_STEP_LIMIT`
均可通过 `trace-control config` 热更新。两个 limit 设为 `0` 表示不限；vm_step 只受 JSScript
identity 和自身 dispatcher PC 限制，不受 opcode 显示 window 限制。

opcode 配置支持 paused 启动：解释器保留启动级的 opcode 配置状态，并每 1,024 条 bytecode
刷新 runtime active 状态。因此应采用“paused 加载页面 -> `trace-control start` -> 触发一次
目标动作 -> `trace-control stop`”流程，避免初始加载占用 opcode/vm_step 限额。

### P3 验收

构建命令：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

已通过的 smoke：

- `/private/tmp/firefox-trace-opcode-window-smoke-20260728`：194 条 opcode。
- `/private/tmp/firefox-trace-opcode-pc-window-smoke-20260728`：`PC=10:11` 时仅写这两个 PC。
- `/private/tmp/firefox-trace-opcode-limit-routing-smoke-20260728`：limit=5 后 JS 流内写
  `opcode_limit`。
- `/private/tmp/firefox-trace-vmp-simple-20260728`：255 条。
- `/private/tmp/firefox-trace-vmp-register-20260728`：469 条。
- `/private/tmp/firefox-trace-vmp-complex-primitive-20260728`：551 条，296 条有 primitive
  slot 值；对应 `complex-types` 在关闭 primitive 后为 0 条值。
- `/private/tmp/firefox-trace-vmp-stress-types-20260728`：4,000 轮虚拟 dispatcher，limit=128
  后写 `opcode_limit`，截图输出 `stress:126`。
- `/private/tmp/firefox-trace-vmp-pc-discover-20260728`：551 条，拆成 8 个 JSScript 组，
  analyzer 推荐 dispatcher PC window `278:325`。
- `/private/tmp/firefox-trace-vmp-pc-target-20260728`：二轮仅 126 条、单一 JSScript 组、
  PC `278..322`，页面仍输出 `complex:126`。
- `/private/tmp/firefox-trace-vmp-tier-pin-valid-20260728`：pin `(40,19,401)` 后仅目标
  JSScript 的 126 条 opcode。
- `/private/tmp/firefox-trace-vmp-tier-pin-invalid-20260728`：错误 line pin 后 0 条 opcode，
  页面仍输出 `complex:126`。
- dispatcher autodetect：simple/register/complex 主 dispatcher 均排名第一并为 medium；
  `/private/tmp/firefox-trace-dispatch-negative-20260728` 普通循环负样本保持 low。
- `/private/tmp/firefox-trace-vmp-vm-step-headed-20260728`：有头 complex fixture 的
  PC 278 输出 7 条 vm_step、126 条 opcode，页面完成 `complex:126`。
- `/private/tmp/firefox-trace-vmp-vm-step-limit-routed-20260728`：limit=3 保留 3 条
  vm_step，随后 JS 流内写 `trace.degraded module=vm_step reason=vm_step_limit`。
- `/private/tmp/firefox-trace-vm-safe-stress-LoaXHO`：安全 rate guard 下 opcode=4096、
  vm_step=65，写出 `opcode_rate_limit` 与 `opcode_limit` 降级事件，页面截图输出
  `stress:126`。
- `/private/tmp/firefox-trace-ui-vm-step-only-1785652331`：只勾 vm_step，不输出 opcode，
  3.2 秒完成、约 3.3 MiB。
- `/private/tmp/firefox-trace-ui-opcode-stack-budget-1785652334`：opcode/stack/primitive/vm_step
  同开，2.4 秒完成、约 3.2 MiB，写出 rate/execution 降级但页面完成。
- `/private/tmp/firefox-trace-wasm-final-20260802-141334`：JS 关闭时生成 1 个
  `wasm.module`、6 个 `wasm.insn` 和 `.wasm` artifact，`trace_check.py wasm` 通过。

PC window 分析命令：

```bash
python3 tools/trace_opcode_analyzer.py TRACE_DIR \
  --script-contains TARGET_SCRIPT \
  --width 48 \
  --top-windows 3
```

每次改 Gecko 后重新导出 patch：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
git -C gecko-dev diff --binary > patches/gecko-firefox-trace.patch
```

P1 fixture 产物可用以下检查器做结构化验收：

```bash
python3 tools/trace_check.py runtime TRACE_DIR
python3 tools/trace_check.py boundary TRACE_DIR
python3 tools/trace_check.py source-map TRACE_DIR
python3 tools/trace_check.py worker TRACE_DIR
```

## 下一步优先级

当前唯一待做清单入口是 [TODO.md](TODO.md)。接手 agent 先读该文件，再决定是否继续实现。

最高优先级：

- P1：补跑 source map、boundary window、automation surface 和 XHR/Fetch 字段回归，
  并记录 `trace.degraded`。
- P1：运行 `tests/worker-trace.html`，并用 `tools/trace_check.py worker TRACE_DIR` 验证
  Worker suppression 语义。
- P1：完成回归后重新生成 binary Gecko patch、更新验证证据并提交。

## 当前已知边界

- PDD 目前看到的是 `anti_content` 的业务组包/发送链路，不是算法内部每一步。
- PDD 搜索请求返回 403，但验证目标是 trace 能否看到参数生成和发送，不是服务端放行结果。
- Worker fetch、keepalive/PFetch 和完整 response body artifact 已通过本地 fixture：
  `/private/tmp/firefox-trace-worker-pfetch-two-modes-20260729` 中 `fetch_1`（keepalive）和
  `fetch_2`（普通）均有 call/request/response/done/body_artifact，`fetch-body` 与
  `worker-fetch` 校验均通过。
- UI/配置面板 v1 已做；静态 `viewer/index.html` 已提供本地时间线、筛选、制品预览和导出，
  仍缺跨 run 对比与自动 request -> JS -> DOM/Cookie/Storage 拼接。
- 真实站长时间运行仍可能日志很大；必须坚持 discover → target 多轮策略。

## 接手检查命令

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
git -C gecko-dev status --short
```

确认构建：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

最近验证目录降级检查：

```bash
python3 - <<'PY'
import json, glob
for root in [
  '/private/tmp/firefox-trace-jd-firstphase-target-1785065263',
  '/private/tmp/firefox-trace-pdd-firstphase-search-1785065942',
  '/private/tmp/firefox-trace-pdd-firstphase-target-search-1785066090',
]:
    deg = 0
    for p in glob.glob(root + '/*.jsonl'):
        for line in open(p, errors='replace'):
            if 'trace.degraded' in line:
                deg += 1
    print(root, 'trace.degraded=', deg)
PY
```

当前结果均为 0。
# 2026-07-29: WebSocket logical frame (in progress)

- `dom/websocket/WebSocket.cpp` now emits `firefox_trace.websocket.v1` logical
  send/recv frames only when `FIREFOX_TRACE_WS` / `TRACE_WS` is explicitly enabled.
- Events use the existing content-main-thread IPC gateway and parent output path
  `firefox-websocket-<pid>.jsonl`; Worker WebSocket frames are dispatched to the
  content main thread before IPC.
- `TRACE_WS_PREVIEW_BYTES` defaults to 512 and caps at 4096. Text emits escaped
  previews, binary emits a hex prefix, and stream/Blob sends have no preview.
- `tools/trace_check.py websocket TRACE_DIR` validates a live fixture directory.
- Build and a persistent Firefox fixture run remain required before treating this
  increment as fully verified.
