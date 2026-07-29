# Firefox Trace 魔改进展记录

更新时间：2026-07-27

## 目标定位

本项目目标是做一个用于参数逆向分析的 Firefox Trace 浏览器。h5st/JD 只作为测试样本，用来暴露通用 trace 能力的不足；浏览器核心不应写死 JD、h5st、request_algo 等站点特化逻辑。

## 项目硬约束

- 最终交付物是魔改 Firefox 浏览器、日志 schema、启动参数和详细使用说明；不能要求用户依赖某个 Python 分析脚本才能使用。
- `tools/trace_analyzer.py` 只能作为开发期 smoke / 辅助检查工具；不能作为交付路径、默认工作流或能力边界。
- JD/h5st 只允许作为测试样本和验证材料；浏览器核心、日志 schema、默认配置、文档默认流程都不能写死 JD/h5st/request_algo 等站点特化逻辑。
- 目标字段必须来自用户需求、运行配置或 AI 按使用说明从日志里选择；默认能力应面向所有网站的参数逆向，而不是某个站点。
- 每做完一块内核能力，必须编译，并用本地或真实页面 smoke 验证后再继续推进。
- 如需安装新依赖，暂停并让用户安装；不要自行扩大安装范围。
- 默认配置只能是安全起步建议，不能成为能力边界。凡是影响覆盖范围、日志量或
  页面时序的策略都必须有可配置出口：DOM 成员/interface 可扩展，JS
  this/args/return/object/value_store/buffer/limit 可调，早期过滤也必须可关闭。

标准工作流，也是后续实现和验收的硬约束：

1. 首轮用脚本级/轻量 trace，保调用边界和长字符串：
   - 不要求预先知道函数名。
   - 通用记录请求、DOM/XHR/fetch、Cookie/Storage、JS boundary、origin_call_id。
   - 对高频混淆脚本优先用 `TRACE_JS_CAPTURE_VALUES=0`，先画调用图，避免深序列化拖慢页面或触发反爬时序。
   - 长字符串通过 `TRACE_JS_DEEP_LONG_STR` + `TRACE_JS_VALUE_STORE` 保真，避免 h5st/tk/sign/riskData 这类值只剩截断 preview。
2. AI/用户从通用日志里的目标字段反推候选脚本/函数：
   - 从目标参数、query 字段、高熵字段、`value_store` 完整值出发。
   - 优先回溯 `origin_call_id` 和 JS `parent_call_id`。
   - 没有精确链时，用时间窗口和同上下文 JS 调用做 fallback。
   - 得到候选 `TRACE_SCRIPT_CONTAINS` / `TRACE_FUNCTION_CONTAINS` / `TRACE_SCRIPT_SHA256` 后再跑二轮。
3. 二轮再对候选函数开 args/return/object/value_store 深抓：
   - 使用 `TRACE_PROFILE=target` 或 `TRACE_PROFILE=deep`。
   - 使用 `TRACE_TARGET_MATCH=all` 同时约束脚本和函数，避免只配脚本导致日志爆量。
   - 打开 `TRACE_JS_CAPTURE_VALUES=1`、`TRACE_JS_OBJECT_DEPTH`、`TRACE_JS_VALUE_STORE`，抓对象内部字段和完整长值。
4. 热点 limit/sample 只当保险丝，不能当主策略：
   - `TRACE_JS_LIMIT_EVENTS` 命中时必须写 `trace.degraded`，不能静默截断。
   - `TRACE_JS_HOT_FUNCTION_LIMIT` / `TRACE_JS_HOT_FUNCTION_SAMPLE` 默认关闭，只用于应急降载。
   - AI/用户或开发期辅助脚本看到 `trace.degraded` 时，本轮 trace 只能作为候选参考，不能作为“没有抓到”的结论。
5. 更深场景再上 opcode / jsvmp：
   - 只有遇到自建 VM、字节码解释器、混淆状态机，才进入 opcode / vm_step。
   - opcode/jsvmp 必须先按脚本、PC 窗口、函数范围收窄，否则日志量和时序风险都不可控。
   - 真实反爬页面默认保留 JIT；需要栈值或离线对拍时再做解释器/tier-pin 策略。

这套工作流是当前项目对齐 ruyiTrace 的核心解法：先轻量发现，再离线归因，再窄化深抓；不是默认全站深抓，也不是默认采样。

实现判断标准：

- 首轮 trace 不应要求用户已经知道 `sha256`、函数名、混淆属性名或站点专用关键词；这些只能作为可选过滤条件。
- 首轮日志必须能保留“目标字段出现在哪里、附近有哪些请求/脚本/调用边界、长字符串在哪里落盘”这类线索。
- 日志和使用说明必须足够完整，让 AI/用户能把通用 trace 转成候选脚本/函数/hash/时间窗口，而不是预先手工猜过滤条件。
- 二轮深抓必须可配置，包括 trace profile、脚本/函数/hash 过滤、args/return、object depth、array items、TypedArray preview、value_store 和日志上限。
- 上限和采样只负责防崩溃、防日志爆量；一旦触发 `trace.degraded`，该日志不能用来证明链路不存在。

## 总体规划：对齐 ruyiTrace 能力的三阶段路线

`/Users/empycity/Desktop/JS-tools/ruyiTrace/README-cheatsheet.md` 描述的是一套更完整的 Firefox trace 系统。当前项目已具备“通用发现 + 链路回溯 + target 收窄”的骨架，但还没有完整覆盖 ruyiTrace 的深度能力。

规划按优先级分三阶段推进。

### 第一阶段：参数逆向基础闭环

目标：解决 h5st 这类参数逆向当前最直接的卡点——已经定位到函数，但对象参数内部看不到。

必须补齐：

- JS value 序列化体系：
  - `[已实现] TRACE_JS_OBJECT_DEPTH`：普通对象浅层展开深度，默认 0，建议 target 下用 1/2。
  - `[已实现] TRACE_JS_OBJECT_KEYS`：对象最多展开属性数，防止大对象爆量。
  - `[已实现] TRACE_JS_ARRAY_ITEMS`：数组最多展开元素数。
  - `[已实现] TRACE_JS_TYPED_ARRAY_BYTES`：TypedArray/ArrayBuffer/DataView preview 字节数。
  - `[已实现] TRACE_JS_DEEP_LONG_STR`：长字符串完整落盘触发阈值，适合 h5st/tk/riskData/sign。
  - `[已实现] TRACE_JS_VALUE_STORE`：开启 `values/` 完整值落盘。
- `values/` 完整值落盘：
  - `[已实现]` preview 留在 jsonl；
  - `[已实现]` 大字符串写 `values/<value_id>.txt`；
  - `[已实现]` 日志记录 `value_id`、`value_store_path`、size、sha256、truncated、stored。
  - `[已实现]` content 进程通过 IPC 交给 parent 进程落盘，避免 content sandbox 写文件失败。
- Fetch API trace：
  - `[已实现] fetch.call`：记录标准化后的 url/method/body_length/query_fields/caller/origin_call_id。
  - `[已实现] fetch.request`：记录最终 Request 的 method/url/body_length/mode/credentials/cache/redirect/referrer；显式开启 `TRACE_FETCH_REQUEST_BODY=preview|full` 后克隆 request body stream 做 bounded preview/value_store，不消费真实请求体。
  - `[已实现] fetch.response`：记录 response type/status/statusText/url/redirect/body_size/body_available/response headers；显式开启时会尝试 bounded clone preview/value_store。
  - `[已实现] fetch.body_chunk`：显式开启 response body trace 时，在 `FetchDriver::OnDataAvailable` 原 copy 路径旁路采样响应体 chunk。
  - `[已实现] fetch.done`：记录 fetch 结束原因。
  - Request/Response body preview 默认关闭；`TRACE_FETCH_REQUEST_BODY=preview|full` / `TRACE_FETCH_RESPONSE_BODY=preview|full` 显式开启后才采样，clone/available/read 失败会写 skipped，不静默成功。
- Cookie/Storage 生命周期 trace：
  - `[已实现] document.cookie get/set`；
  - `[已实现] CookieStore API get/getAll/set/delete`；
  - `[已实现] HTTP Set-Cookie accepted/rejected/ignored 来源事件`；
  - `[已实现] 底层 Cookie lifecycle 事件：delete/overwrite/expired/purge/eviction/removeAll`；
  - `[已实现] localStorage/sessionStorage get/set/remove/clear`；
  - `[已实现] partitionedLocalStorage get/set/remove/clear`；
  - IndexedDB 暂列后续。
- 动态脚本 source/hash：
  - `[已实现]` script URL；
  - `[已实现]` `script_id`；
  - `[已实现]` source sha256 输出；
  - `[已实现]` `TRACE_SCRIPT_SHA256` / `FIREFOX_TRACE_JS_SCRIPT_SHA256` 过滤；
  - `[已实现]` eval/new Function 在 source text 可取时输出 hash；
  - `[已实现]` 动态 inline/eval/new Function source 保存到 `scripts/<sha256>.js`；
  - `[已实现]` 日志可用 script hash 作为二轮 trace 候选过滤条件。
  - `[已实现] script.resource`：外部脚本资源加载事件，记录 URL/page/content-type/charset/source map/headers/raw size/raw sha256。
  - `[已实现] TRACE_SCRIPT_RESOURCE_FILTER=web|chrome|all`：默认只记录网页脚本，避免扩展/chrome 脚本噪声。
  - `[已实现] TRACE_SCRIPT_RESOURCE_CAPTURE/STORE`：显式开启后将未截断的外部脚本原始响应写入 `scripts/<raw_sha256>.js`。
- 开发期辅助脚本：
  - `tools/trace_analyzer.py` 只用于 smoke 和辅助检查；
  - 最终交付不依赖该脚本，正式使用流程以浏览器日志和使用说明为准。

第一阶段完成标准：

- 对 `H< / onRequest` 这种对象参数函数，target 日志不再只显示 `Object`，至少能看到浅层字段。
- 长 h5st/tk/riskData 不因 preview 截断丢失，可通过 `value_id` 找完整值。
- 不知道函数名时，discover 能找候选；知道候选后，target 能看到参数内部。

### 第二阶段：深度 JS 执行 trace

目标：覆盖混淆函数、自建状态机、轻量 jsvmp 前置分析；对齐 ruyiTrace 的 jscall/opcode 主力能力。

规划能力：

- jscall 完整开关体系：
  - flush interval；
  - summary interval；
  - target only；
  - native/self-hosted 可选；
  - shallow/deep 序列化策略；
  - script URL / function / script sha256 过滤。
- opcode 级 trace：
  - `TRACE_JS_OPCODE_URL`
  - `TRACE_JS_OPCODE_PC_START`
  - `TRACE_JS_OPCODE_PC_END`
  - `TRACE_JS_OPCODE_STACK`
  - `TRACE_JS_OPCODE_STACK_SLOTS`
  - `TRACE_JS_OPCODE_OPERANDS`
  - `TRACE_JS_OPCODE_LIMIT`
- JIT/解释器策略可配置：
  - 默认真实站点尽量保留 JIT，降低时序风险；
  - target/deep/opcode 需要栈值时再切解释器或局部 tier-pin；
  - 文档明确“反爬站勿无脑禁 JIT、勿深序列化”。

第二阶段完成标准：

- 能对单脚本、单函数或 PC 窗口抓 opcode。
- 能看到调用栈附近的关键栈值/操作数。
- 热点混淆函数不会因为全量深序列化拖垮页面。

### 第三阶段：VM/WASM/网络底层 trace

目标：覆盖 ruyiTrace 里的高级能力，用于 jsvmp、WASM、HTTP/WS 明文和底层协议分析。

规划能力：

- jsvmp/vm_step：
  - dispatcher 手动声明；
  - autodetect；
  - vm_pc / op_byte / vm_pc_next；
  - branch trace；
  - bytecode dump；
  - const table dump；
  - 多 dispatcher 支持。
- WASM trace：
  - module dump；
  - wasm 反汇编；
  - 指定函数 index；
  - dump 总量/单模块限制。
- HTTP packet / WebSocket frame trace：
  - HTTP 请求/响应报文落盘；
  - WebSocket 解压/解 mask 后 payload；
  - 单帧大小限制；
  - 和 JS/XHR/fetch 通过时间、URL、request_id 关联。

第三阶段完成标准：

- 自建 VM 能从 JS opcode 过渡到 vm_step 级别分析。
- WASM 和 WS 场景有独立 trace 通道。
- 网络层能作为 JS 层缺失时的兜底证据。

### ruyiTrace 能力对照表

| 能力 | ruyiTrace | 当前 firefoxTrace | 规划阶段 |
|---|---:|---:|---|
| 总开关/日志目录 | 有 | 有 | 已实现 |
| DOM/BOM trace | 有 | 有 | 已实现 |
| XHR trace | 有 | 有 | 已实现 |
| Fetch trace | 未在 cheatsheet 重点列出 | 有轻量入口 | 第一阶段 |
| JS call enter/return | 有 | 有 | 已实现 |
| target only 降噪 | 有 | 有 | 已实现 |
| 函数/脚本过滤 | 有 | 有 | 已实现 |
| script sha256 输出/过滤 | 有 | 有 | 已实现 |
| script source dump | 有 | 有 | 已实现 |
| 对象浅层展开 | 有 | 有 | 已实现 |
| 长字符串完整抓 | 有 | 有 | 已实现 |
| values 完整值落盘 | 有类似能力 | 有 | 已实现 |
| Cookie/Storage trace | 有 | document.cookie + Storage 已实现 | 第一阶段 |
| flush/summary interval | 有 | 无 | 第二阶段 |
| opcode trace | 有 | 无 | 第二阶段 |
| opcode stack/operands | 有 | 无 | 第二阶段 |
| jsvmp/vm_step | 有 | 无 | 第三阶段 |
| WASM trace | 有 | 无 | 第三阶段 |
| HTTP packet trace | 有 | 无 | 第三阶段 |
| WebSocket frame trace | 有 | 无 | 第三阶段 |

## 当前已实现能力

### Runtime Trace Control

本轮新增：

- `tools/run-trace-firefox.sh --trace-start active|paused|prewarm`。
- `tools/trace-control.sh TRACE_DIR config|new-segment|start|stop|prewarm|status`。
- `manifest.json` 写入 `trace_start`、`trace_control_file`、`TRACE_CONTROL_FILE`。
- `firefox-control.jsonl` 记录 `trace.control` start/stop 事件。
- `trace-control.json` 升级为 `firefox_trace.control.v2`，包含
  `segment_id`、`segment_label`、`config_hash`、`modules` 和可热切 `env`。
- Gecko runtime gate 下沉到 JS/DOM/XHR/Fetch/Storage/Cookie enabled 入口，paused/prewarm
  阶段不再做主要 trace 构造和 value/body/script artifact 写入。
- Parent 进程通过 `FirefoxTraceRuntimeConfig` IPC 把 control config 推给 content；
  JS trace 能在同一浏览器进程内从 boundary/discover 切到 target/value。
- ContentChild/ContentParent IPC 写入前保留二次 gate。
- 控制状态 200ms 缓存刷新；刷新时直接重读小控制文件，不再依赖 mtime+size 判断。
- 控制 JSON 解析只看 `previous_state` 前的顶层字段，避免 start 后误命中历史 paused 状态。
- Parent 写 JSONL 前统一注入 `segment_id`、`control_version`、`config_hash`。

最新本地 smoke：

- 目录：`/private/tmp/firefox-trace-1785146389-29562`
- paused 启动后无业务日志；
- start 后捕获 delayed XHR：
  - `xhr.open/send/response`
  - `anti_content=runtime-control-token-1785146413444`
  - `origin_call_id=call_2530`
  - `js.boundary.flush_summary complete_window=true`
- stop 后再次触发请求，server 有请求，但 XHR/JS 日志行数不增加。

runtime segment/config 热切 smoke：

- 目录：`/private/tmp/firefox-trace-runtime-segments-smoke6`
- 同一个 headless Firefox 进程内：
  - `seg_002` 使用 `discover-light`；
  - 不重开浏览器切到 `seg_003`，使用 `target-values`，
    `TRACE_SCRIPT_CONTAINS=runtime-segments`，
    `TRACE_FUNCTION_CONTAINS=sendTick,makeSegmentValue`。
- 结果：
  - `firefox-js-55477.jsonl` 60 行；
  - `seg_002` 为 boundary 事件；
  - `seg_003` 出现 `js_mode=target`、`target_match=true` 和 9 条
    `js.value.store`；
  - `makeSegmentValue return` 的完整复合字段 preview 被记录。
- 边界：
  - 刚切 segment 后首批事件可能仍按旧配置产生；控制台/UI 需要提供
    `apply/prewarm` 或等待 `control_version` 生效确认。

后续状态（2026-07-28）：

- `config_applied` ACK 已实现并通过 paused headless smoke；UI/agent 以匹配
  `control_version/config_hash` 的 ACK 作为触发关键动作的门槛。
- JS 模块启动级关闭已 build/smoke 通过。
- PDD paused-flow 真实页复验仍待完成。

### Trace Console v1

新增：

- `tools/trace-console-server.py`
  - 本地 Web UI：`http://127.0.0.1:8788/`
  - Agent HTTP API：
    - `GET /api/latest`
    - `GET /api/status?trace_dir=...`
    - `GET /api/summary?trace_dir=...`
    - `POST /api/config`
    - `POST /api/new-segment`
    - `POST /api/start`
    - `POST /api/stop`
    - `POST /api/prewarm`
- UI 可配置：
  - `TRACE_DIR` / `TRACE_CONTROL_FILE`
  - segment label / preset
  - module 开关：js/xhr/fetch/dom/cookie/storage/script
  - profile / js mode
  - script/function/script_sha256 filter
  - target match / query fields
  - object depth/keys、array items、typed array bytes
  - value metadata / primitive metadata
  - value store min bytes / JS limit events
  - custom `TRACE_*` / `FIREFOX_TRACE_*`
- API 统一调用 `tools/trace-control.sh`，避免 UI 和 agent 走不同控制路径。
- 支持清空旧配置：
  - `tools/trace-control.sh config --unset TRACE_NAME`
  - UI custom env 中 `TRACE_NAME=` 会转成 unset。

验证：

- Python 语法检查通过：`python3 -m py_compile tools/trace-console-server.py`。
- `trace-control.sh --unset` smoke 通过，能同时清理 `TRACE_SCRIPT_CONTAINS`
  和 `FIREFOX_TRACE_SCRIPT_CONTAINS`。
- HTTP API smoke 通过：
  - 控制台服务：`127.0.0.1:8788`
  - 目录：`/private/tmp/firefox-trace-console-api-smoke`
  - 完成 `/api/config -> /api/start -> /api/stop -> /api/new-segment ->
    /api/config -> /api/status -> /api/summary`。

当前边界：

- 控制台 v1 是控制面，不是 viewer；请求时间线、value/script artifact 查看和报告导出后续补。
- `config_applied` ACK 已实现；切换到 target/deep 后应等待 `/api/status` 返回当前
  `control_version/config_hash` 的 `config_applied.ready=true`，而不是依赖固定等待时间。

真实页 JD paused-flow 验证：

- 目录：`/private/tmp/firefox-trace-1785149433-86188`
- 流程：`--trace-start paused` 打开 JD，用户完成登录和搜索跳转后，执行
  `tools/trace-control.sh ... start jd-search`，目标接口触发后执行
  `tools/trace-control.sh ... stop after-page2`。
- 结果：登录和搜索跳转稳定，不再出现 “Gah. Your tab just crashed.”。
- 本轮总日志约 12MB，`firefox-xhr-86188.jsonl` 40 行，
  `firefox-js-86188.jsonl` 27197 行。
- 捕获主搜索 h5st：
  - `request_id=xhr_166`
  - `functionId=pc_search_searchWare`
  - API body 记录 `page=3`，以实际请求 body 为准；
  - `origin_call_id=call_1446748`
  - `h5st` 长度 1195；
  - sha256：`e2e5624564c2f17106c3b702d2abcfd2a27899dfd0d9c595947f13dc1b761d47`
  - 完整值：`values/qfv_xhr_86206_213.txt`、`values/qfv_xhr_86206_215.txt`
- `xhr.open.h5st` 对应 `js.boundary.flush_summary`：
  - `flushed=168`
  - `dropped_before_flush=0`
  - `skipped_by_window=0`
  - `complete_window=true`
- discover-light 候选链路：
  - `pc-tk.js?v=2024-06-20-17`：`getJsToken`、`__getTkResult`、
    `__callbackWrapper`、`_0x1d73`
  - `pc-core-disposal.js`：`onRequest`、`DisposalSDK.prototype.attachCustomHeader`、
    `D<`、`send`
  - `main_search/pro/0.0.11/js/index.6fe45f56.js`：搜索业务请求包装函数。

本轮 crash 根因和修复：

- crash 发生在 paused 阶段 JD 登录/搜索跳转期间，栈位于
  `ScriptLoadHandler::OnStreamComplete`，不是 trace active 后日志爆量导致。
- 直接原因是 `ScriptLoadHandler.cpp` 中 `mRequest->ScriptTextLength()` 在
  `script.resource` 实际需要记录前就执行；部分 JD 脚本请求没有可读 text source，
  触发 `MOZ_RELEASE_ASSERT(isSome())`。
- 修复：
  - `script.resource` enabled 判断增加 runtime active gate；
  - `NotifyStart/NotifyStop` 增加 `HasScriptLoadContext()` 保护；
  - `ScriptTextLength()` 移入 `FirefoxTraceScriptResourceShouldRecord(...)` 内部，
    并先判断 `mRequest->IsTextSource()`；
  - trace profile 禁用 script bytecode/navigation cache，降低该路径不确定性。
- 修复后已重新 build，并用上面的 JD paused-flow 通过验证。

### JD target-values 二轮深抓验证

前置目录：`/private/tmp/firefox-trace-jd-h5st-target-values-fix-1785150459-35916`

metadata 验证目录：`/private/tmp/firefox-trace-jd-h5st-target-values-meta-1785151960-86646`

本轮目标是用上一轮 discover 得到的候选脚本/函数，跑 `target-values` 看 h5st 的
args/return/object/value_store。

新增 crash 修复：

- 初次打开 `target-values + paused` 时，JD 首页 worker 脚本触发 content crash。
- crash reason：

  ```text
  MOZ_RELEASE_ASSERT(mWorkerThread && mWorkerThread->IsOnCurrentThread()) (not on worker thread!)
  ```

- 符号化后确认是 worker 线程执行 JS 时，`AutoFirefoxTraceJSCall` 写事件，进而调用
  `PContentChild::SendFirefoxTraceDOMEvent`。PContent IPC 只能在 content main thread
  调用。
- 已修：
  - `FirefoxTraceSendEventToParent`
  - `FirefoxTraceSendValueToParent`
  - `FirefoxTraceSendScriptSourceToParent`
  在非主线程直接 handled/drop。
  - JS raw event/value/script source 写入增加 runtime active gate。
- 修复后重新 build 通过，并重新打开 JD `target-values + paused`，启动稳定。

二轮 trace 结果：

- start label：`jd-h5st-target-values-deep2`
- stop label：`after-target-trigger`
- 运行稳定，无 content crash。
- 总目录约 14MB。
- 捕获 h5st 请求：
  - `pc_search_searchWare`：`bb172d8a0f417db38a89fed63b17406ee7e3b961cb57bf20e2f270aa4879c374`
  - `pc_search_adv_Search`：`52799107ef546a1eed3314bc02ec7903859d3738f6c65780459334fae5c1d52b`
  - `pctradesoa_mixer`：`b87562c2e925f9704cf3f39931936c4b530e675ef1b4315b8d0d7621ab985277`
  - `pc_club_productCommentSummaries`：`b37d8024d39df4f2a54ddc387d13bc6bc583117f834e831749cf9c72002c8e71`
- `values/jsv_*.txt` 中每组 h5st 都有 16 个 artifact 与 XHR query field
  artifact sha256 完全一致，说明 JS value serialization 已抓到最终 h5st 完整字符串。

前置轮暴露的新缺口：

- `firefox-js-*.jsonl` 只有 2 行 chrome/newtab 事件；大量 `jsv_*` value artifact
  缺少对应 `call_id/function/script/path` 元数据。
- 现状能证明“JS 层出现过最终 h5st 完整值”，但不能仅凭这轮日志直接指认具体函数
  args/return。
- 已补 JS value_store metadata 事件，并重新跑 JD target-values 验证。

metadata 验证结果：

- start label：`jd-h5st-meta-target`
- stop label：`after-h5st-meta-trigger`
- 运行稳定，无 content crash。
- 总目录约 16MB。
- `firefox-js-86646.jsonl` 1036 行，其中 `js.value.store` 1032 行。
- `firefox-xhr-86646.jsonl` 76 行。
- 无 `trace.degraded`、无 event limit、无 hot-function 抑制。
- 主搜索请求：
  - `request_id=xhr_148`
  - `functionId=pc_search_searchWare`
  - `origin_call_id=call_297474`
  - caller：`pc-core-disposal.js`
  - XHR h5st sha256：`7f2917e203c397f6c4ad0f6a52ea7422df0abf28689c75704bdea65856ecb1e4`
- 该 sha256 在 JS value metadata 中命中 16 条，关键行：
  - `_$PI.prototype._$gsp` return，同 sha256；
  - `_$PI.prototype._$ms` return `h5st`；
  - `_$PI.prototype._$sdnmd` return `h5st`；
  - `_$PI.prototype.signSync` return `h5st`；
  - `zxGsw`、`_$iW`、`stringify`、`bhikZ`、`_$fv`、`resolve`、`_$hc`、
    `EiLPS`、`_$R0` 等 helper 继续接收或返回同 sha256 的 h5st。
- 同轮另外 3 组 h5st 也均有 16 条 JS metadata 命中：
  - `pc_search_adv_Search`
  - `pctradesoa_mixer`
  - `pc_club_productCommentSummaries`

结论：

- `target-values` 现在不只证明 JS 层出现最终 h5st；日志已经能给出
  `value_id -> call_id/function/script/arg|return/path` 的反向链路。
- JD 这轮能直接看出 h5st 由 `js_security_v3_0.1.6.js?v=2024-06-20-17`
  内的 `_$PI.prototype.signSync` / `_$sdnmd` / `_$ms` 返回并继续传递到请求组包层。
- 还原算法内部每一步仍需后续窄化到候选函数后做 `deep-causal`、动态调试或 opcode/window。

字段级补强：

- 当前 JD 日志里 h5st 10 个 `;` 分段中：
  - 第 7 段长 payload 已有独立 exact metadata：
    `encode -> _$PI.prototype._$clt -> _$PI.prototype._$ms(arg1) -> _$PI.prototype._$gsp(arg3)`；
  - 第 4 段 `signStr` 是 308 字节签名输入串的 sha256：
    `_eData` return / `parse` arg 的 `sha256` 等于 h5st 第 4 段；
  - 第 3 段 token 出现在算法依赖解析结果：
    `stringify` / `UTyhQ` / `zIXmn` / `_$fI` 的值里包含 `tk` 和 `algo`；
  - 第 0/1/2/5/6/8/9 段这轮主要在最终 h5st 或结构化 result 里出现，
    还没有稳定的独立字段 metadata。
- 为补这个短字段缺口，已新增：
  - `TRACE_JS_VALUE_METADATA=1`
  - `TRACE_JS_VALUE_METADATA_MIN_BYTES=1`
  - `TRACE_JS_VALUE_STORE_MIN_BYTES`
- 行为：
  - target/deep preset 默认开启短字符串 metadata；
  - 大值是否写文件仍由 value_store/store min/max 控制；
  - 短值默认写 `stored:false + preview + sha256 + call_id/function/value_path`。
- 本地 smoke 目录：
  `/private/tmp/firefox-trace-value-metadata-object-smoke`。
  结果：`tests/value-metadata.html` 中 `makeTraceParts` return 对象字段
  `ts/fp/app/token/digest/version/payload` 均写出独立 metadata。

最新 JD 复验：

- 目录：`/private/tmp/firefox-trace-1785153736-41130`
- 配置：`target-values + paused`，`TRACE_SCRIPT_CONTAINS=js_security_v3_0.1.6.js`，
  `TRACE_JS_VALUE_METADATA=1`，`TRACE_JS_VALUE_METADATA_MIN_BYTES=1`，
  `TRACE_JS_VALUE_STORE_MIN_BYTES=256`。
- 结果：
  - 总目录约 6.8MB；
  - `firefox-js-41130.jsonl` 7893 行；
  - `js.value.store` 3179 条，其中 `stored=false` 2956 条；
  - XHR h5st 4 组；
  - 无 `trace.degraded`。
- 主搜索请求：
  - `request_id=xhr_183`
  - `functionId=pc_search_searchWare`
  - `origin_call_id=call_220943`
  - h5st sha256：`090a7f323ec9faffc7fcc0db9f57cb3a4fb230718ebaf85aae7940b7890020fe`
- 这轮短字段 metadata 明显补齐：
  - h5st 第 0 段时间格式串：`_$f6` return，并作为 `_$gsp` arg2；
  - 第 1 段 fp：`_$fg` / `_$fp` / `get` return，路径包含 `v`，后续作为 `fp` 进入环境对象；
  - 第 2 段 appId/版本 key：`get` / `_$fg` arg；
  - 第 3 段 tk：`get` return path `tk`，进入 `_$pam` / `ZNEiI`；
  - 第 4 段 signStr：`_$PI.prototype._$gs` return，并作为 `_$gsp` arg0；
    同时 `_eData` 308 字节签名输入串的 sha256 等于该段；
  - 第 5 段版本 `5.3`：`get` / `_$fg` arg；
  - 第 7 段长 payload：`encode -> _$PI.prototype._$clt -> _$PI.prototype._$ms(arg1) -> _$PI.prototype._$gsp(arg3)`；
  - 第 8 段 default sign：`format -> stringify -> toString -> _$PI.prototype._$gsd`
    return，并作为 `_$gsp` arg4；其前置 `_eData` 173 字节输入串 sha256 等于该段；
  - 第 9 段短 encode：`encode` return，并作为 `_$gsp` arg5。
- 仍需说明的边界：
  - 第 6 段 13 位时间戳主要以 number 出现在 `_ $ms` / `_ $gsd` 的参数对象中，
    例如 key `t` 的 value 是 number preview；短字符串 metadata 不会覆盖 number。

primitive metadata 补强：

- 已新增：
  - `TRACE_JS_PRIMITIVE_METADATA=1`
  - `TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES=1`
- 行为：
  - number/boolean 也写 `js.value.store` metadata；
  - `stored=false`，不写 `values/`；
  - 记录 `value_type=number|boolean`、`preview`、`sha256`、`call_id`、
    `function_name`、`value_role`、`arg_index`、`value_path`。
- target/deep preset 默认开启；discover 不默认开启。
- 本地 smoke 目录：
  `/private/tmp/firefox-trace-primitive-metadata-smoke`。
  结果：`tests/value-metadata.html` 中 `makeTraceParts` return 对象字段
  `ts_num` 输出 `value_type=number`，`ok` 输出 `value_type=boolean`。

JD 真实页 primitive metadata 复验：

- 目录：`/private/tmp/firefox-trace-1785161281-80006`
- 配置：`target-values + paused`，宽脚本过滤
  `TRACE_SCRIPT_CONTAINS=js_security_v3,js-security-v3-rac`，
  `TRACE_TARGET_MATCH=any`，并开启：
  - `TRACE_JS_VALUE_METADATA=1`
  - `TRACE_JS_VALUE_METADATA_MIN_BYTES=1`
  - `TRACE_JS_PRIMITIVE_METADATA=1`
  - `TRACE_JS_PRIMITIVE_METADATA_MIN_BYTES=1`
  - `TRACE_JS_VALUE_STORE_MIN_BYTES=256`
- 日志量：
  - `firefox-js-80006.jsonl` 8764 行；
  - `firefox-xhr-80006.jsonl` 9 行；
  - `firefox-dom-80006.jsonl` 4887 行；
  - `firefox-cookie-80006.jsonl` 959 行；
  - 无 `trace.degraded` / `dropped` / `truncated` 类降级事件。
- `js.value.store` 共 8764 条：
  - string 3475 条；
  - number 4592 条；
  - boolean 697 条；
  - `stored=false` 8648 条；
  - `stored=true` 116 条。
- 捕获 JD 首页 `pc_home_feed` 两组 XHR `h5st` 请求：
  - `xhr_61`：page=3，h5st 长度 1155；
  - `xhr_62`：page=4，h5st 长度 1155；
  - 请求侧 `query_fields_meta.h5st.value_store_path` 正常写入 `values/qfv_xhr_*.txt`。
- 以 `xhr_61` 的 h5st 为样本，10 个分段均有 JS 侧证据：
  - 第 0 段时间格式串：`_$f6` return，进入 `_$PI.prototype._$gsp` arg2；
  - 第 1 段 fp：`_$fg` / `_$fp` / `get`，路径包含 `v`，后续作为 `fp`；
  - 第 2 段 app/key：`get` / `_$fg` 参数；
  - 第 3 段 tk：`get` return path `tk`，进入 `_$pam` / `ZNEiI`；
  - 第 4 段 signStr：`format -> stringify -> toString -> _$PI.prototype._$gs`
    return，并进入 `_$gsp` arg0；
  - 第 5 段版本 `5.3`：`get` / `_$fg` 参数；
  - 第 6 段 13 位时间戳：已由 primitive metadata 精确命中
    `_$f6` arg0 和 `_$PI.prototype._$gsp` arg1，`value_type=number`；
  - 第 7 段长 payload：`encode -> _$PI.prototype._$clt ->
    _$PI.prototype._$ms(arg1) -> _$PI.prototype._$gsp(arg3)`，完整落盘；
  - 第 8 段 default sign：`format -> stringify -> toString ->
    _$PI.prototype._$gsd` return，并进入 `_$gsp` arg4；
  - 第 9 段短 encode：`encode` return，并进入 `_$gsp` arg5。
- 结论：此前第 6 段只在 object/call preview 中出现的问题已修复；现在
  string + primitive metadata 能对复合签名字段做分段级 exact/contains/digest
  证据归因。JD 仍只是验证样本，不进入核心默认逻辑。

### DOM/WebIDL trace

修改文件：

- `gecko-dev/dom/bindings/Codegen.py`
- `gecko-dev/dom/bindings/BindingUtils.cpp`
- `gecko-dev/dom/bindings/BindingUtils.h`
- `gecko-dev/dom/ipc/PContent.ipdl`
- `gecko-dev/dom/ipc/ContentParent.cpp`
- `gecko-dev/dom/ipc/ContentParent.h`

事件：

- `dom.get`
- `dom.set`
- `dom.call`
- `dom.construct`

字段：

- `schema`
- `type`
- `ts_us`
- `pid`
- `tid`
- `interface`
- `member`
- `argc`
- `args`
- `origin_call_id`
- `value_kind`
- `value_preview`
- `page_url`
- `caller_url`
- `caller_line`
- `caller_column`

参数：

- `FIREFOX_TRACE_ENABLE` / `TRACE_ENABLE`
- `FIREFOX_TRACE_DOM`
- `FIREFOX_TRACE_DOM_FILTER=all|chrome|web|content`
- `FIREFOX_TRACE_ARG_LIMIT`，默认 8，最大 64
- `FIREFOX_TRACE_PREVIEW_LIMIT`，默认 4096，最大 65536

说明：

- content 进程通过 `FirefoxTraceDOMEvent` IPC 转发到 parent 写日志，避免 sandbox 写文件失败。

### XHR trace

修改文件：

- `gecko-dev/dom/xhr/XMLHttpRequestMainThread.cpp`
- `gecko-dev/dom/xhr/XMLHttpRequestMainThread.h`
- `gecko-dev/dom/ipc/ContentParent.cpp`

事件：

- `xhr.open`
- `xhr.header`
- `xhr.send`
- `xhr.body`
- `xhr.start`
- `xhr.done`
- `xhr.response`

字段：

- `request_id`
- `xhr_ptr`
- `method`
- `url`
- `async`
- `with_credentials`
- `ready_state`
- `page_url`
- `origin_call_id`
- `caller_url`
- `caller_line`
- `caller_column`
- `query_fields`
- header/body/response preview

参数：

- `FIREFOX_TRACE_XHR`
- `FIREFOX_TRACE_XHR_FILTER`
- `FIREFOX_TRACE_XHR_EVENTS` / `TRACE_XHR_EVENTS=all|none|open,header,send,body,start,done,response`
- `FIREFOX_TRACE_XHR_PREVIEW` / `TRACE_XHR_PREVIEW=all|none|header,body,response,detail`
- `FIREFOX_TRACE_PREVIEW_LIMIT`
- `FIREFOX_TRACE_QUERY_FIELDS` / `TRACE_QUERY_FIELDS`
- `FIREFOX_TRACE_REQUEST_URL` / `TRACE_REQUEST_URL=full|preview|none`

说明：

- XHR 默认记录完整 URL，不写死任何站点字段。真实站长 URL/query 导致日志过大时，可设置 `TRACE_REQUEST_URL=preview` 只写截断 URL、`url_size`、`url_truncated`，或设置 `TRACE_REQUEST_URL=none` 只写 `url_disabled/url_size`。
- XHR 默认记录全部生命周期事件；真实站 XHR hook/send 路径过热时，可设置
  `TRACE_XHR_EVENTS=open,send,response` 或 `send,response` 降低 header/start/done 重复事件。
- XHR 默认记录 header/detail/body/response preview；真实站响应体或 header 值过大时，可设置
  `TRACE_XHR_PREVIEW=none` 或 `TRACE_XHR_PREVIEW=response` 这类白名单。关闭 `response` 时不会复制
  `responseText`。
- 如需额外拆 query 字段，使用 `TRACE_QUERY_FIELDS=functionId,appid,h5st,sign,token` 这类配置；日志会写入通用对象 `query_fields`。
- `TRACE_REQUEST_URL` 不影响 query 解析；即使 URL 输出为 preview/none，`query_fields` 仍从完整 URL 中提取。
- `query_fields` 只是 preview，受 `FIREFOX_TRACE_PREVIEW_LIMIT` 控制；完整值仍以后续 `values/` 落盘为目标。

### Fetch trace

修改文件：

- `gecko-dev/dom/fetch/Fetch.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`

事件：

- `fetch.call`
- `fetch.request`
- `fetch.response`
- `fetch.body_chunk`
- `fetch.done`

字段：

- `request_id`
- `method`
- `url`
- `query_fields`
- `body_length`
- `origin_call_id`
- `caller_url/line/column`
- `mode/credentials/cache/redirect/referrer`
- `response_type/status/status_text/redirected/body_size/body_available`
- `body_preview_enabled/body_preview_mode/body_preview_skipped`
- `body_preview/body_preview_size/body_preview_truncated/body_sha256/body_bytes_hex`
- `body_value_id/body_value_store_path/body_value_stored`
- `chunk_index/offset/source_count/captured_size/captured_total/capture_truncated`
- `end_reason`
- `url`
- `body_length`
- `keepalive`
- `page_url`
- `origin_call_id`
- `caller_url`
- `caller_line`
- `caller_column`
- `query_fields`

参数：

- `FIREFOX_TRACE_FETCH` / `TRACE_FETCH`
- `FIREFOX_TRACE_FETCH_FILTER` / `TRACE_FETCH_FILTER`
- `FIREFOX_TRACE_QUERY_FIELDS` / `TRACE_QUERY_FIELDS`
- `FIREFOX_TRACE_PREVIEW_LIMIT`
- `FIREFOX_TRACE_REQUEST_URL` / `TRACE_REQUEST_URL=full|preview|none`
- `TRACE_FETCH_RESPONSE_BODY=none|preview|full`
- `TRACE_FETCH_RESPONSE_BODY_MAX_BYTES`
- `TRACE_FETCH_RESPONSE_BODY_HEX_BYTES`
- `TRACE_FETCH_RESPONSE_BODY_CHUNK_EVENTS`
- `TRACE_FETCH_RESPONSE_BODY_STORE`

说明：

- 当前 Fetch trace 是轻量入口，记录 `Request::Constructor` 后的标准化请求元数据。
- `TRACE_REQUEST_URL=preview|none` 与 XHR 共用，用于降低真实站长 URL/query 写盘量；不影响 `query_fields` 从完整 URL 中提取。
- 默认不 clone/read body，避免影响页面行为；body 常规只记录 `body_length/body_size/body_available`。
- 显式设置 `TRACE_FETCH_RESPONSE_BODY=preview|full` 后，`fetch.response` 先使用 `InternalResponse::CloneBodyForTrace()` 克隆 body stream，再限量读取 clone；不会调用 JS `Response.clone()`，也不会把 response 标记成 JS cloned。
- 真实网络响应体通常在 `fetch.response` 阶段 `Available()==0`，这时日志写 `body_preview_skipped=not_available`。这不是响应体为空，而是响应体还没流到可读阶段。
- `fetch.body_chunk` 是响应体可见性的主路径：在 `FetchDriver::OnDataAvailable` 将网络数据复制到原 pipe 的同一轮旁路采样，不额外读取 stream；默认最多 4 个 chunk 事件，且总采样量受 `TRACE_FETCH_RESPONSE_BODY_MAX_BYTES` 限制。
- content 进程通过现有 `FirefoxTraceDOMEvent` IPC 转发到 parent，但 parent 会识别 `firefox_trace.fetch.v1` 并写入 `firefox-fetch-<pid>.jsonl`。

### Storage trace

修改文件：

- `gecko-dev/dom/storage/Storage.h`
- `gecko-dev/dom/storage/Storage.cpp`
- `gecko-dev/dom/storage/SessionStorage.cpp`
- `gecko-dev/dom/storage/LocalStorage.cpp`
- `gecko-dev/dom/storage/PartitionedLocalStorage.cpp`
- `gecko-dev/dom/localstorage/LSObject.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`

事件：

- `storage.get`
- `storage.set`
- `storage.remove`
- `storage.clear`

字段：

- `storage_type`
- `key`
- `found`
- `value_preview`
- `page_url`
- `origin_call_id`
- `caller_url`
- `caller_line`
- `caller_column`

参数：

- `FIREFOX_TRACE_STORAGE` / `TRACE_STORAGE`
- `FIREFOX_TRACE_STORAGE_FILTER` / `TRACE_STORAGE_FILTER`
- `FIREFOX_TRACE_PREVIEW_LIMIT`

说明：

- 覆盖新版 `localStorage` 主入口 `LSObject`，以及旧 `LocalStorage`、`SessionStorage`、`PartitionedLocalStorage`。
- 默认跟随 `FIREFOX_TRACE_ENABLE=1` 开启；显式设置 `FIREFOX_TRACE_STORAGE=0` 可关闭。
- content 进程通过现有 `FirefoxTraceDOMEvent` IPC 转发到 parent，但 parent 会识别 `firefox_trace.storage.v1` 并写入 `firefox-storage-<pid>.jsonl`。
- `value_preview` 受 `FIREFOX_TRACE_PREVIEW_LIMIT` 控制；Storage 长值完整落盘还未实现，后续可复用 JS value_store 机制扩展。

### Cookie trace

修改文件：

- `gecko-dev/dom/base/Document.cpp`
- `gecko-dev/dom/cookiestore/CookieStore.cpp`
- `gecko-dev/netwerk/cookie/CookieService.cpp`
- `gecko-dev/netwerk/cookie/CookieStorage.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`

事件：

- `cookie.get`
- `cookie.getAll`
- `cookie.set`
- `cookie.delete`
- `cookie.http_set`
- `cookie.lifecycle`

字段：

- `source`
- `key`
- `found`
- `value_preview`
- `page_url`
- `origin_call_id`
- `caller_url`
- `caller_line`
- `caller_column`
- `outcome`
- `from_http`
- `header_preview`
- `host_url`
- `channel_url`
- `final_url`
- `secure/http_only/session/same_site/partitioned/expiry`
- `rejected_reason`
- `reason`
- `base_domain`
- `origin_attributes_suffix`
- `private_browsing_id`
- `partition_key`
- `raw_host`
- `last_accessed`
- `creation_time`
- `count`

参数：

- `FIREFOX_TRACE_COOKIE` / `TRACE_COOKIE`
- `FIREFOX_TRACE_COOKIE_FILTER` / `TRACE_COOKIE_FILTER`
- `FIREFOX_TRACE_PREVIEW_LIMIT`

说明：

- 当前覆盖 `document.cookie` getter/setter。
- 当前覆盖 `cookieStore.get/getAll/set/delete` 的 JS API 调用输入和上下文。
- `cookie.get` 空 cookie 也会记录 `found:false`，避免把“读过但为空”误判成“没读”。
- `cookie.set` 在通过安全检查并调用 `AddCookieFromDocument` 后记录，`key` 为 cookie name，`value_preview` 为 JS 写入的 cookie 字符串。
- `cookieStore.*` 记录 API 调用输入，包括 `key`、`value_preview`、`url`、`domain`、`path`、`partitioned`、`page_url`、`origin_call_id` 和 caller 位置；Promise resolve 结果暂未记录。
- `cookie.http_set` 记录 HTTP 响应 `Set-Cookie` 进入 CookieService 后的 accepted/rejected/ignored 状态、原始 header preview、解析出的 key/value/domain/path 和 channel/final/host URL。
- `cookie.lifecycle` 记录 CookieStorage 底层状态变化原因，当前原因枚举包括：`explicit_remove`、`origin_attributes_remove`、`exact_host_remove`、`remove_all`、`overwrite_old`、`expired_set_delete`、`already_expired_ignored`、`stale_overwrite_purge`、`per_host_eviction`、`partition_byte_eviction`、`expired_purge`、`age_purge`。
- `cookie.lifecycle` 是 storage-level truth：用于确认 Cookie 被删除、覆盖、过期清理或配额驱逐；它不保证带 JS `origin_call_id`。需要 JS 调用上下文时，结合 `document.cookie` / CookieStore API 事件和 JS boundary/target trace。
- `remove_all` 只输出 summary 事件和 `count`，不逐个落 cookie，避免清空大量 Cookie 时日志爆炸。
- content 进程通过现有 `FirefoxTraceDOMEvent` IPC 转发到 parent，但 parent 会识别 `firefox_trace.cookie.v1` 并写入 `firefox-cookie-<pid>.jsonl`。

### JS boundary / target trace

修改文件：

- `gecko-dev/js/src/vm/Interpreter.cpp`
- `gecko-dev/dom/ipc/ContentChild.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`

事件：

- `js.call.enter`
- `js.call.return`
- `js.script.enter`
- `js.script.return`
- `trace.degraded`

能力：

- 普通 JS 函数 fast path 已补 trace guard。
- content JS 日志通过弱符号桥 `FirefoxTraceSendEventToParent` 转发到 parent。
- 默认保留 JIT，降低真实页面时序干扰和卡死风险；只有显式设置
  `TRACE_EXECUTION_MODE=target-interpreter` 才把目标运行压到解释器路径。
- `target` 模式只记录命中过滤的函数 args/return。
- `deep` 模式记录目标函数及其子调用 args/return。
- `boundary` 模式记录轻量调用边界，不记录 args/return。

参数：

- `FIREFOX_TRACE_LOG_DIR` / `TRACE_LOG_DIR`
- `FIREFOX_TRACE_PROFILE` / `TRACE_PROFILE`
  - `discover`：通用首跑，默认开启低噪声 JS boundary。
  - `field`：字段分析模式，类似 discover。
  - `target`：二次目标函数抓值。
  - `deep`：目标函数及子调用抓值。
- `FIREFOX_TRACE_JS` / `TRACE_JS`
- `FIREFOX_TRACE_JS_MODE` / `TRACE_JS_MODE=off|boundary|target|deep`
- `FIREFOX_TRACE_JS_BOUNDARY_FILTER` / `TRACE_JS_BOUNDARY_FILTER=all|web|content|chrome`
- `FIREFOX_TRACE_JS_BOUNDARY_BUFFER` / `TRACE_JS_BOUNDARY_BUFFER`
  - `discover/field + boundary` 默认开启；
  - JS 调用边界先进入线程本地 ring buffer；
  - XHR/fetch/storage/cookie/DOM sink 发生时 flush 最近边界，减少全站同步刷盘。
- `FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS` / `TRACE_JS_BOUNDARY_BUFFER_EVENTS`
- `FIREFOX_TRACE_JS_BOUNDARY_FLUSH_ON` / `TRACE_JS_BOUNDARY_FLUSH_ON`
- `FIREFOX_TRACE_JS_NATIVE` / `TRACE_JS_NATIVE`
- `FIREFOX_TRACE_JS_SCRIPT_EVENTS` / `TRACE_JS_SCRIPT_EVENTS`
- `FIREFOX_TRACE_EXECUTION_MODE` / `TRACE_EXECUTION_MODE=jit|target-interpreter`
- `FIREFOX_TRACE_JS_EARLY_SCRIPT_FILTER` / `TRACE_JS_EARLY_SCRIPT_FILTER`
- `FIREFOX_TRACE_JS_SCRIPT_CONTAINS` / `TRACE_SCRIPT_CONTAINS`
- `FIREFOX_TRACE_JS_FUNCTION_CONTAINS` / `TRACE_FUNCTION_CONTAINS`
- `FIREFOX_TRACE_JS_SCRIPT_HASH` / `TRACE_JS_SCRIPT_HASH`
- `FIREFOX_TRACE_JS_SCRIPT_HASH_MAX_BYTES` / `TRACE_JS_SCRIPT_HASH_MAX_BYTES`
- `FIREFOX_TRACE_JS_SCRIPT_SHA256` / `TRACE_SCRIPT_SHA256`
- `FIREFOX_TRACE_JS_SCRIPT_DUMP` / `TRACE_JS_SCRIPT_DUMP`
- `FIREFOX_TRACE_JS_SCRIPT_DUMP_MAX_BYTES` / `TRACE_JS_SCRIPT_DUMP_MAX_BYTES`
- `FIREFOX_TRACE_TARGET_MATCH` / `TRACE_TARGET_MATCH=auto|any|all`
- `FIREFOX_TRACE_JS_MAX_VALUE_BYTES` / `TRACE_JS_MAX_VALUE_BYTES`
- `FIREFOX_TRACE_JS_OBJECT_DEPTH` / `TRACE_JS_OBJECT_DEPTH`
- `FIREFOX_TRACE_JS_OBJECT_KEYS` / `TRACE_JS_OBJECT_KEYS`
- `FIREFOX_TRACE_JS_ARRAY_ITEMS` / `TRACE_JS_ARRAY_ITEMS`
- `FIREFOX_TRACE_JS_TYPED_ARRAY_BYTES` / `TRACE_JS_TYPED_ARRAY_BYTES`
- `FIREFOX_TRACE_JS_VALUE_STORE` / `TRACE_JS_VALUE_STORE`
- `FIREFOX_TRACE_JS_DEEP_LONG_STR` / `TRACE_JS_DEEP_LONG_STR`
- `FIREFOX_TRACE_JS_VALUE_STORE_MAX_BYTES` / `TRACE_JS_VALUE_STORE_MAX_BYTES`
- `FIREFOX_TRACE_JS_LIMIT_EVENTS` / `TRACE_JS_LIMIT_EVENTS`
- `FIREFOX_TRACE_JS_CAPTURE_VALUES` / `TRACE_JS_CAPTURE_VALUES`
- `FIREFOX_TRACE_JS_THIS` / `TRACE_JS_THIS=none|preview`
- `FIREFOX_TRACE_JS_ARGS` / `TRACE_JS_ARGS=preview|none`
- `FIREFOX_TRACE_JS_RET` / `TRACE_JS_RET=preview|none`
- `FIREFOX_TRACE_JS_MAX_ARGS` / `TRACE_JS_MAX_ARGS`
- `FIREFOX_TRACE_JS_HOT_FUNCTION_LIMIT` / `TRACE_JS_HOT_FUNCTION_LIMIT`
- `FIREFOX_TRACE_JS_HOT_FUNCTION_SAMPLE` / `TRACE_JS_HOT_FUNCTION_SAMPLE`
- `FIREFOX_TRACE_DOM_MODE` / `TRACE_DOM_MODE=signal|all|off`
- `FIREFOX_TRACE_DOM_MEMBERS` / `TRACE_DOM_MEMBERS`
- `FIREFOX_TRACE_DOM_INTERFACES` / `TRACE_DOM_INTERFACES`
- `FIREFOX_TRACE_DOM_LIMIT_EVENTS` / `TRACE_DOM_LIMIT_EVENTS`

过滤语法：

- `SHA256`：substring 匹配。
- `=SHA256`：精确匹配。
- `TRACE_TARGET_MATCH=auto`：默认；脚本、函数、hash 三个维度里，所有已配置维度都必须命中。只配置一种时按单条件命中。
- `TRACE_TARGET_MATCH=all`：所有已配置过滤维度都必须命中。
- `TRACE_TARGET_MATCH=any`：任一过滤维度命中即可，保留旧 OR 行为；日志会明显更多。
- 配置 `TRACE_SCRIPT_SHA256` 时会自动计算并输出 `script_sha256`，不需要额外打开 `TRACE_JS_SCRIPT_HASH=1`。
- `TRACE_JS_SCRIPT_DUMP=1` 时，实际被 JS trace 记录的目标/边界脚本会按 sha256 保存到 `scripts/<sha256>.js`；不会因为 hash 计算而默认 dump 全站脚本。
- `TRACE_JS_SCRIPT_DUMP_MAX_BYTES` 默认 4 MiB，超过时事件写 `script_source_status=too_large`。

上限策略：

- JS 默认事件上限：`50000`。
- `TRACE_JS_LIMIT_EVENTS=0` 表示不限制。
- `discover/field` 下 `TRACE_JS_BOUNDARY_BUFFER` 默认开启，首轮不会把每个 JS call
  立即同步写盘；sink 事件触发 flush。若 ring buffer 覆盖未 flush 事件，会写
  `trace.degraded reason=boundary_buffer_overwrite`。
- `TRACE_JS_HOT_FUNCTION_LIMIT` / `TRACE_JS_HOT_FUNCTION_SAMPLE` 默认关闭，只是应急保险丝；命中后会写 `trace.degraded reason=hot_function_limit`。不要把采样当主分析策略。
- `TRACE_JS_CAPTURE_VALUES` 默认关闭；对高频混淆脚本，优先用 `TRACE_JS_CAPTURE_VALUES=0`
  做轻量 target/discover 调用图；确定候选函数后再打开 `TRACE_JS_CAPTURE_VALUES=1`
  抓 args/return/object/value_store。
- `TRACE_JS_OBJECT_VALUE_KEYS` 可限制对象展开时读取哪些属性值。不匹配的属性只记录 key
  和 `value_skipped=key_filter`，不调用 `JS_GetPropertyById` 读取值，降低 getter/Proxy/惰性
  计算造成的时序扰动。默认 `all` 保持旧行为；真实站二轮可先只列目标字段，再按需扩大。
- `discover` 默认不记录 `js.script.enter/return`，需要时显式设置 `TRACE_JS_SCRIPT_EVENTS=1`。
- DOM 默认 `TRACE_DOM_MODE=signal`，只记录风控常用 DOM 面和 `TRACE_DOM_MEMBERS`
  显式配置成员；`TRACE_DOM_INTERFACES` 可额外打开整个 interface；全量 DOM 需要
  设置 `TRACE_DOM_MODE=all`。
- `target/deep` 下配置 `TRACE_SCRIPT_CONTAINS` 时默认启用
  `TRACE_JS_EARLY_SCRIPT_FILTER=1`，非目标脚本在函数名/hash/value 采集前提前跳过。
  命中的 JS 事件会写 `early_script_filter=true` 和
  `non_target_stack_skipped=true`；这代表本轮 parent/origin 栈不是全站完整栈。
  需要完整跨脚本栈时设置 `TRACE_JS_EARLY_SCRIPT_FILTER=0`。
- `target/deep` 下默认启用 `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS=1`，同一目标脚本内
  函数过滤不命中的高频函数不会维护 call_id/current-stack。命中的 JS 事件会写
  `non_target_function_stack_skipped=true`；这代表本轮目标脚本内部函数树也不是完整栈。
  需要完整目标脚本函数树时设置 `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS=0`，同时降低
  args/return/object/value_store 强度。
- 命中上限不会静默截断，会向当前运行的 trace 日志目录写入一条事件：

```json
{"type":"trace.degraded","module":"js","reason":"event_limit","limit":50000}
```

日志目录由 `FIREFOX_TRACE_LOG_DIR` / `TRACE_LOG_DIR` 决定；未配置时才使用 `/tmp/firefox-trace`。`trace.degraded` 不绑定任何测试站点或固定文件。

AI/用户或开发期辅助脚本看到 `trace.degraded` 必须标记本次 JS trace 不完整，不能拿来下最终结论。

### 开发期辅助脚本

新增文件：

- `tools/trace_analyzer.py`

状态：

- 开发期辅助脚本，不作为最终交付工具要求。

定位：

- 该脚本只用于开发期 smoke、回归检查和辅助观察日志，不是最终交付依赖。
- 正式交付以魔改浏览器、日志 schema、启动参数和使用说明为准。

用途：

- 输入 trace log 目录或单个 jsonl。
- 自动识别配置字段、默认关注字段、URL/body/DOM preview 里的高熵字段。
- 递归读取 JS target/deep 事件里的对象 preview；如存在 `value_store_path`，会读取 `values/` 完整值参与字段提取。
- 递归读取 `bytes_hex` / `sha256`，TypedArray、ArrayBuffer、DataView preview 可参与候选字段分析。
- 从 `origin_call_id` 回溯 `js.call.enter` 的 `parent_call_id` 链。
- 如果 `origin_call_id` 没有精确 JS chain，则按时间窗口列出附近 JS 调用，默认窗口 `--nearby-window-us 5000`。
- 输出候选 `TRACE_SCRIPT_CONTAINS` / `TRACE_FUNCTION_CONTAINS` / `TRACE_SCRIPT_SHA256`。
- 如果 JS 事件带 `script_source_path`，报告会输出 `script_sources`，用于按 hash 回查 `scripts/` 下的源码制品。
- 可用 `--write-next-env [path]` 写出二次 trace 配置文件，默认建议 target + values + object preview。
- 默认使用 `--preset generic`，关注 `sign/signature/token/riskData/fp/nonce/timestamp/captchaId`；也会对 high-entropy query 值做候选提示。
- 站点样本字段不进入默认能力；需要分析某个目标字段时由 AI/用户显式传 `--field`，例如 `--field h5st` / `--field _stk`。

示例：

```bash
python3.11 tools/trace_analyzer.py "$TRACE_LOG_DIR" --max-findings 8
python3.11 tools/trace_analyzer.py "$TRACE_LOG_DIR" --preset none --field h5st --field sign --write-next-env /tmp/trace-next.env
```

注意：

- h5st 不在 analyzer 默认 generic preset 里；JD 测试使用显式字段，不代表浏览器核心或 analyzer 是 JD/h5st 专用。
- 后续应把默认字段列表和高熵阈值做成配置。

## 已验证结果

### 本地 JS target smoke

测试文件：

- `js-target-test.html`

验证结论：

- `target` 模式能捕获普通 JS 函数：
  - `buildSign` 入参/返回值
  - `SHA256` 入参/返回值
- 不关闭 content sandbox 也能落 JS 日志。
- target 模式日志量已从百万级降到命中函数的 4 行。
- `TRACE_JS_LIMIT_EVENTS=2` 能写出 `trace.degraded`。

### JS script id/hash + sha256 过滤 smoke

本地测试日志：

- script hash 输出 tight smoke：`/private/tmp/firefox-trace-script-hash-smoke-tight`
- `TRACE_SCRIPT_SHA256` 正例：`/private/tmp/firefox-trace-script-sha-positive`
- `TRACE_SCRIPT_SHA256` 反例：`/private/tmp/firefox-trace-script-sha-negative`

验证结论：

- tight smoke 只有 4 行 JS 日志：
  - `evalTraceTarget` enter/return；
  - `buildSign` enter/return。
- `buildSign` 与 `evalTraceTarget` 都输出：
  - `script_id`
  - `script_sha256`
  - `script_source_length`
- 正例使用：
  - `TRACE_SCRIPT_SHA256==ffaaef8be5427db1bf4e1f92484a1ac734db5914847c506afbc106668ff656fb`
  - `TRACE_FUNCTION_CONTAINS==buildSign`
  - `TRACE_TARGET_MATCH=all`
- 正例结果：只输出 2 行 `buildSign` enter/return，没有 `trace.degraded`。
- 反例使用 eval 脚本 hash + `buildSign` 函数名，结果没有 JS 日志文件，证明 hash 过滤参与 `all/auto` 收窄，不会因为函数名命中而误抓。
- analyzer 已能从含 `script_sha256` 的 JS 日志输出：
  - `TRACE_SCRIPT_CONTAINS`
  - `TRACE_FUNCTION_CONTAINS`
  - `TRACE_SCRIPT_SHA256`
- 已验证生成 env：`/private/tmp/trace-next-script-sha.env`。

### JS script source dump smoke

本地测试日志：

- inline + eval：`/private/tmp/firefox-trace-script-dump-smoke`
- new Function：`/private/tmp/firefox-trace-script-dump-newfn`

运行参数要点：

- `TRACE_JS_SCRIPT_DUMP=1`
- `TRACE_JS_SCRIPT_DUMP_MAX_BYTES=1048576`
- `TRACE_JS_SCRIPT_HASH_MAX_BYTES=1048576`
- inline/eval：`TRACE_FUNCTION_CONTAINS==buildSign,=evalTraceTarget`
- new Function：`TRACE_SCRIPT_CONTAINS=js-target-test.html line 26 > Function` + `TRACE_FUNCTION_CONTAINS==anonymous`
- 均使用 `TRACE_TARGET_MATCH=all`，避免只按 `anonymous` 函数名误抓。

验证结论：

- inline + eval 只生成 2 个 source 文件：
  - `scripts/78233f09ccf373bf9919edc34ad6b0c80feafc5cd176ad3fa67278185a98b36a.js`
  - `scripts/ffaaef8be5427db1bf4e1f92484a1ac734db5914847c506afbc106668ff656fb.js`
- new Function 生成 1 个 source 文件：
  - `scripts/46afa18b0bcc0dc4826023ff1e59f06359bbcd6a64989b84ef89db3892a13cf4.js`
- `shasum -a 256 scripts/*.js` 与事件里的 `script_sha256` 一致。
- JS 事件包含：
  - `script_source_path`
  - `script_source_status=stored`
  - `script_source_length`
- analyzer JSON 报告已输出 `script_sources`。
- 初版曾出现 `TRACE_JS_SCRIPT_DUMP=1` dump 大量 chrome/internal 脚本的问题；已修正为只 dump 实际会记录的目标/边界脚本，hash 计算本身不会触发全站 source dump。

### 本地 discover + query_fields smoke

测试日志：

- `/private/tmp/firefox-trace-smoke-content-1784909771`

运行参数要点：

- `FIREFOX_TRACE_PROFILE=discover`
- `FIREFOX_TRACE_DOM_FILTER=content`
- `FIREFOX_TRACE_XHR_FILTER=content`
- `TRACE_QUERY_FIELDS=functionId,sign,token`
- `FIREFOX_TRACE_LOG_DIR` / `TRACE_LOG_DIR` 指向本次临时目录。

验证结论：

- 构建产物可以在 sandbox 外 headless 跑通。
- 日志写入当前配置的 trace 目录，不写入固定 JD 文件。
- `content` 过滤下日志量正常：
  - `dom.call`: 274
  - `dom.get`: 20
  - `js.call.enter`: 2
  - `js.call.return`: 2
  - `xhr.open/send/start/done/response`: 各 1
- 没有 `trace.degraded`。
- XHR 能输出通用 `query_fields`：

```json
{"functionId":"demoFn","sign":"abc123demo","token":"tok_demo_12345678901234567890"}
```

- analyzer 对 `sign/token` 能输出附近 JS 调用 fallback：
  - `SHA256`
  - `buildSign`
- 另用 `FILTER=all` 压力测试触发过 `trace.degraded`，事件写在当次配置目录的 `firefox-js-<pid>.jsonl`，验证了上限提示不绑定固定站点/路径。

### JD/h5st 作为测试样本

历史测试日志：

- `/private/tmp/firefox-trace-jd-h5st-focused-1784907214`
- `/private/tmp/firefox-trace-jd-discover-1784909070`

说明：

- 这些只是当时手工设置的 `FIREFOX_TRACE_LOG_DIR` 目录，不是代码里的固定路径。
- 后续测试统一建议用每次运行生成的新目录，例如 `/private/tmp/firefox-trace-discover-$run_id`。

验证结论：

- 能抓到 request/h5st/XHR/DOM/JS 事件。
- 能抓到 `SHA256` 调用，但这不是最终 h5st hash 的直接生成点。
- analyzer 能对部分 XHR h5st 请求回溯到：
  - `H<`
  - `onRequest`
  - `pc-core-disposal.js`
- `TRACE_PROFILE=discover` 不传函数过滤时，analyzer 能从 h5st 请求自动输出候选：
  - `TRACE_SCRIPT_CONTAINS=index.chunk.js,pc-core-disposal.js,aria.js`
  - `TRACE_FUNCTION_CONTAINS==H<,=onRequest,=appendScriptTagToHead,=fetchData,...`
- 部分 DOM `HTMLScriptElement.src` 事件因为 preview 截断，不能完整拆 h5st，需要依赖 XHR/fetch 层完整字段或后续增加“字段落盘/完整值存储”。
- 其中一次 discover 日志命中了 `trace.degraded`，原因是 JS boundary 接近当次设置的 100000 条上限。后续已将 `js.script.enter/return` 改为默认关闭，降低 discover 噪声。

### JD 通用 discover 到 target 过滤验证

通用 discover 日志：

- `/private/tmp/firefox-trace-jd-discover-1784933478`

discover 参数要点：

- `TRACE_PROFILE=discover`
- `FIREFOX_TRACE_DOM_FILTER=content`
- `FIREFOX_TRACE_XHR_FILTER=content`
- `FIREFOX_TRACE_JS_BOUNDARY_FILTER=web`
- `TRACE_QUERY_FIELDS=functionId,appid,h5st,sign,token,riskData,fp`
- `FIREFOX_TRACE_JS_LIMIT_EVENTS=200000`

discover 结果：

- 总行数：195885
- JS：142328 行
- DOM：53234 行
- XHR：323 行
- `trace.degraded`：无
- analyzer 从 h5st 请求自动输出候选：
  - `TRACE_SCRIPT_CONTAINS=pc-core-disposal.js,index.chunk.js,aria.js`
  - `TRACE_FUNCTION_CONTAINS==H<,=onRequest,=appendScriptTagToHead,=fetchData,...`
- 典型链路：
  - XHR h5st：`H< -> onRequest -> pc-core-disposal.js`
  - JSONP/DOM h5st：`appendScriptTagToHead -> fetchData -> jsonp$1 -> dispatchRequest -> index.chunk.js`

第一版 target 过滤日志：

- `/private/tmp/firefox-trace-jd-target-1784933531`

结果：

- 总行数：70140
- JS：65399 行
- `trace.degraded`：无
- 问题：旧 target 匹配语义是脚本或函数任一命中即可，配置了脚本过滤后会抓该脚本内大量函数，过滤不够准。

修正：

- 新增 `TRACE_TARGET_MATCH=auto|any|all`。
- 默认 `auto`：脚本和函数都配置时两者必须同时命中；只配置一种时按单条件命中。
- 本次收窄验证显式使用 `TRACE_TARGET_MATCH=all`。

收窄后 target 日志：

- `/private/tmp/firefox-trace-jd-target-tight-1784933636`

结果：

- 总行数：3984
- JS：64 行
- XHR：25 行
- DOM：3895 行
- `trace.degraded`：无
- 命中函数：
  - `H<`: 2
  - `onRequest`: 2
  - `appendScriptTagToHead`: 3
  - `fetchData`: 3
  - `jsonp$1`: 3
  - `dispatchRequest`: 4
  - `handleStateCallback`: 3
  - `hook/t.XMLHttpRequest/e.getProxy`: 10
- analyzer 仍能从 h5st 请求回溯：
  - `H< -> onRequest`
  - `appendScriptTagToHead -> fetchData`

当前观察：

- 过滤流程成立：先通用 discover，再 analyzer，再 target 收窄。
- JS args/return 对普通字符串有效；但 h5st 相关核心参数很多包在 object 内，目前只显示 `Object` preview，不够分析内部字段。
- 后续需要实现对象浅层属性 preview 或 `values/` 完整值落盘，否则 target 虽然能定位函数，但对象参数内部看不全。

### JS object preview + value store 验证

本地 object preview smoke：

- 日志目录：`/private/tmp/firefox-trace-object-smoke-1784934957`
- 参数要点：
  - `TRACE_PROFILE=target`
  - `TRACE_FUNCTION_CONTAINS==objectTarget`
  - `TRACE_JS_OBJECT_DEPTH=2`
  - `TRACE_JS_OBJECT_KEYS=16`
  - `TRACE_JS_ARRAY_ITEMS=8`
- 结论：
  - `objectTarget` 参数不再只显示 `Object`。
  - 能展开 `token`、`nested.sign`、`body.appid`、`body.functionId`。

本地 value store smoke：

- 日志目录：`/private/tmp/firefox-trace-value-store-smoke-fixed3`
- 参数要点：
  - `TRACE_FUNCTION_CONTAINS==longStringTarget`
  - `TRACE_JS_VALUE_STORE=1`
  - `TRACE_JS_DEEP_LONG_STR=256`
  - `TRACE_JS_MAX_VALUE_BYTES=128`
- 结论：
  - 1840 字节长字符串 preview 被截断，但完整值写入 `values/jsv_31693_1.txt`。
  - 日志记录 `value_id`、`value_store_path`、`sha256`、`stored:true`。
  - 文件 sha256 与日志一致。
  - content 进程无法直接写 `/private/tmp` 的问题已通过 `FirefoxTraceJSValue` IPC 修正，由 parent 进程落盘。

JD target value store 验证：

- 日志目录：`/private/tmp/firefox-trace-jd-value-store-phase1`
- 参数要点：
  - `TRACE_PROFILE=target`
  - `TRACE_SCRIPT_CONTAINS=pc-core-disposal.js`
  - `TRACE_FUNCTION_CONTAINS==H<,=onRequest`
  - `TRACE_TARGET_MATCH=all`
  - `TRACE_JS_OBJECT_DEPTH=2`
  - `TRACE_JS_VALUE_STORE=1`
  - `TRACE_JS_DEEP_LONG_STR=512`
- 结果：
  - 总行数：7571
  - DOM：7327 行
  - JS：84 行
  - XHR：160 行
  - `trace.degraded`：无
  - `values/`：48 个长字符串文件。
- 观察：
  - `onRequest -> H<` 对象参数里能看到 `headers`、`params`、`method`、`url`、`body`、`withCredentials` 等字段。
  - 带 h5st 的长 URL 不再只靠 preview；完整 URL 写入 `values/`，可解析出 `appid`、`functionId`、`body`、`h5st`、`x-api-eid-token`。
  - analyzer 已能读取 JS `value_store_path`，从 `data.args[0].params[1].value_store` 直接发现 h5st。
  - 本次页面控制台还暴露了一个生成方向：`js_security_v3_0.1.4.js` 中 `sign -> signSync -> _$sdnmd -> _$clt -> encode -> fromWordArray`，后续应通过通用 discover/deep trace 验证，而不是在核心写死该站点逻辑。

JD js_security 轻量到深值验证：

- 轻量 target 日志：`/private/tmp/firefox-trace-jd-jssec-lite-1784937624`
  - 参数要点：`TRACE_SCRIPT_CONTAINS=js_security_v3_0.1.4.js`、`TRACE_JS_CAPTURE_VALUES=0`。
  - 作用：不序列化 args/return，只画高频脚本调用图。
  - 观察到生成侧候选函数：
    - `_$PI.prototype.sign`
    - `_$PI.prototype.signSync`
    - `_$PI.prototype._$sdnmd`
    - `_$PI.prototype._$clt`
    - `parse`
    - `encode`
    - `fromWordArray`
- 二次深值日志：`/private/tmp/firefox-trace-jd-jssec-deep-values-1784937709`
  - 参数要点：只抓上述候选函数，`TRACE_JS_CAPTURE_VALUES=1`、`TRACE_JS_VALUE_STORE=1`、`TRACE_JS_OBJECT_DEPTH=1`。
  - 总行数：6611；JS enter/return 各 339；`trace.degraded`：无。
  - 能直接看到 h5st 生成返回：
    - `_$PI.prototype._$sdnmd` 返回对象含 `_stk` 和 `h5st`。
    - `_$PI.prototype.signSync` 返回对象含 `_stk` 和 `h5st`。
  - analyzer 回溯链路：

```text
_$PI.prototype._$sdnmd
  -> _$PI.prototype.signSync
  -> _$PI.prototype.sign
```

本轮结论：

- h5st 作为测试样本已经证明：当前浏览器能抓到生成侧函数链和完整 h5st 返回值。
- 最优策略不是默认采样，也不是全站深值；而是：
  1. 脚本级/轻量 trace：`TRACE_JS_CAPTURE_VALUES=0`，保调用边界。
  2. analyzer 输出候选和 `trace-next.env`。
  3. 候选函数深值 trace：打开 object preview/value_store。

### Fetch trace smoke

本地测试日志：

- `/private/tmp/firefox-trace-fetch-smoke`

验证结论：

- 构建产物能写出 `firefox-fetch-<pid>.jsonl`。
- 旧 smoke 验证 `fetch.call` 包含：
  - `request_id`
  - `method`
  - `url`
  - `query_fields`
  - `body_length`
  - `keepalive`
  - `page_url`
  - `origin_call_id`
  - `caller_url/line/column`
- analyzer 能从 `fetch.call` 中识别 `sign/token` 并输出下一轮 target 配置。
- 新增生命周期 smoke：
  - `/private/tmp/firefox-trace-fetch-events-smoke-1784956693`
  - 编译：`mach build` 通过，最后一次 wall time 约 18s。
  - 本地 `js-target-test.html` 触发 `fetch(...)` 后，同一个 `request_id=fetch_1`
    输出 4 条事件：`fetch.call`、`fetch.request`、`fetch.response`、`fetch.done`。
  - 验证 `query_fields` 包含 `functionId/sign/token`，`fetch.response` 包含
    `status=200`、`body_size=2892`、`body_available=true`，且
    `body_preview_enabled=false`，未读取或 clone body。
- response body preview smoke：
  - 默认关闭：`/private/tmp/firefox-trace-fetch-body-off-smoke-1785052400`
    - 输出 `fetch.call/request/response/done` 各 2 条；
    - 没有 `fetch.body_chunk`；
    - `fetch.response body_preview_enabled=false`。
  - 显式开启：`/private/tmp/firefox-trace-fetch-body-chunk-smoke-1785052300`
    - 参数：`TRACE_FETCH_RESPONSE_BODY=preview`、`TRACE_FETCH_RESPONSE_BODY_MAX_BYTES=4096`、`TRACE_FETCH_RESPONSE_BODY_HEX_BYTES=128`、`TRACE_QUERY_FIELDS=token`。
    - 输出 `fetch.call/request/response/body_chunk/done`，其中 `fetch.body_chunk` 2 条。
    - `data:` fetch 的 body_chunk 捕获 `trace-fetch-body-data-url`。
    - 本地 HTTP JSON fetch 的 body_chunk 捕获 `traceFetchBodyToken`，同时 `query_fields.token=traceFetchBodyToken`。
    - `fetch.response` 在两条响应上均写 `body_preview_skipped=not_available`，说明 response 阶段 body stream 尚不可读；实际响应体由 `fetch.body_chunk` 提供。

### Storage trace smoke

本地测试日志：

- `/private/tmp/firefox-trace-storage-http-smoke2`

验证结论：

- 构建产物能写出 `firefox-storage-<pid>.jsonl`。
- 本地 HTTP 页面验证到：
  - localStorage：`storage.set` / `storage.get`
  - sessionStorage：`storage.set` / `storage.get` / `storage.remove`
- `storage.*` 包含：
  - `storage_type`
  - `key`
  - `found`
  - `value_preview`
  - `page_url`
  - `origin_call_id`
  - `caller_url/line/column`
- analyzer 能从 Storage key 识别候选字段，例如 `traceSign` / `traceToken`。

### Cookie trace smoke

本地测试日志：

- `/private/tmp/firefox-trace-cookie-http-smoke`
- `/private/tmp/firefox-trace-cookiestore-smoke`
- `/private/tmp/firefox-trace-http-cookie-smoke-1784953869`
- `/private/tmp/firefox-trace-cookie-lifecycle-smoke-1785050000`

验证结论：

- 构建产物能写出 `firefox-cookie-<pid>.jsonl`。
- 本地 HTTP 页面验证到：
  - `document.cookie = ...` 产生 `cookie.set`
  - `document.cookie` 读取产生 `cookie.get`
  - `cookieStore.set(...)` 产生 `source=cookieStore` 的 `cookie.set`
  - `cookieStore.get(...)` 产生 `source=cookieStore` 的 `cookie.get`
  - `cookieStore.getAll(...)` 产生 `source=cookieStore` 的 `cookie.getAll`
  - `cookieStore.delete(...)` 产生 `source=cookieStore` 的 `cookie.delete`
  - HTTP 响应 `Set-Cookie` 产生 `source=http.set-cookie` 的 `cookie.http_set`
  - `document.cookie` 覆盖同名 cookie 产生 `cookie.lifecycle reason=overwrite_old`
  - `document.cookie` 写入 `max-age=0` 删除已有 cookie 产生 `cookie.lifecycle reason=expired_set_delete`
  - `document.cookie` 写入已过期且无旧值的 cookie 产生 `cookie.lifecycle reason=already_expired_ignored`
- `cookie.*` 包含：
  - `source=document.cookie`
  - `source=cookieStore`
  - `source=http.set-cookie`
  - `key`
  - `found`
  - `value_preview`
  - `header_preview/outcome/from_http`（HTTP Set-Cookie）
  - `host_url/channel_url/final_url`（HTTP Set-Cookie）
  - `path/domain/url/partitioned`（CookieStore API 按实际参数输出）
  - `page_url`
  - `origin_call_id`
  - `caller_url/line/column`
- `cookie.lifecycle` smoke 结果：
  - 总计 13 行：`fetch.call/request/response/done` 各 1，`cookie.set` 5，`cookie.get` 1，`cookie.lifecycle` 3。
  - lifecycle reasons：`overwrite_old=1`、`expired_set_delete=1`、`already_expired_ignored=1`。
  - `trace.degraded=0`。
- AI/用户可从 cookie key/value、`origin_call_id` 和 caller 位置回溯到对应 JS 调用；开发期辅助脚本也可用于 smoke 检查。

### TypedArray / ArrayBuffer trace smoke

本地测试日志：

- `/private/tmp/firefox-trace-typed-array-smoke`

验证参数：

- `TRACE_PROFILE=target`
- `TRACE_JS_MODE=target`
- `TRACE_FUNCTION_CONTAINS==typedArrayTarget`
- `TRACE_TARGET_MATCH=all`
- `TRACE_JS_CAPTURE_VALUES=1`
- `TRACE_JS_TYPED_ARRAY_BYTES=8`

验证结论：

- `typedArrayTarget` enter/return 各 1 条。
- `Uint8Array` 输出 `type=typed_array`、`scalar_type=Uint8`、`byte_length=10`、`array_length=10`、`bytes_hex=01020304fafbfcfd`、`bytes_truncated=true`。
- `ArrayBuffer` 输出 `type=array_buffer`、`byte_length=10`、`bytes_hex=01020304fafbfcfd`、`bytes_truncated=true`。
- `DataView` 输出 `type=data_view`、`byte_length=4`、`byte_offset=2`、`bytes_hex=0304fafb`。

## 当前已知缺口

## 2026-07-25 最新验证：真实站卡死问题处理

本轮针对“页面被 trace 卡死”做了三类降载改动，并完成编译验证：

- JS `target/deep` 默认不再全站禁用 JIT；`TRACE_EXECUTION_MODE=target-interpreter`
  变成显式精确调试开关。
- `TRACE_JS_CAPTURE_VALUES` 默认关闭，二轮深抓必须显式开启；新增
  `TRACE_JS_ARGS`、`TRACE_JS_RET`、`TRACE_JS_MAX_ARGS`，避免一次性抓过多参数/返回值。
- DOM 默认改为 `TRACE_DOM_MODE=signal`，只保留风控常读面；全量 DOM 需要显式
  `TRACE_DOM_MODE=all`。
- `discover/field + boundary` 新增 JS boundary ring buffer；XHR/fetch/storage/cookie/DOM
  sink 触发 flush 最近调用边界，减少全站同步写盘。

验证记录：

- 编译：`mach build` 通过，最后一次 wall time 约 34s。
- 本地 smoke：
  - `/private/tmp/firefox-trace-safety-values2-1784954911`
  - 验证 `TRACE_JS_CAPTURE_VALUES=1`、`TRACE_JS_MAX_ARGS=2`、`TRACE_JS_RET=none`
    能输出 `args_truncated=true` 和 `return_disabled=true`。
- 本地 boundary buffer smoke：
  - `/private/tmp/firefox-trace-boundary-buffer-smoke-1784955218`
  - 总日志 40 行，JS 19 行；sink flush 后保留 `buildSign -> SHA256` 等调用边界。
- JD discover 最新验证：
  - `/private/tmp/firefox-trace-jd-buffer-discover-1784955253`
  - 4 秒内完成，没有页面脚本 timeout。
  - 抓到 h5st 请求字段、`request_algo`、`api.m.jd.com/api`、`jsTk.do` 等 sink。
  - JS boundary 中抓到候选链：`_$PI.prototype.signSync -> _$PI.prototype._$sdnmd`。
  - 出现 `trace.degraded reason=boundary_buffer_overwrite dropped=4326`；该轮只用于定位候选，
    不能用于证明完整调用链不存在。
- JD target 最新验证：
  - `/private/tmp/firefox-trace-jd-h5st-target-latest-1784955291`
  - JS 20 行，values 10 个；抓到 `_$PI.prototype._$sdnmd` 和
    `_$PI.prototype.signSync` 的入参、this 内部字段、return 对象。
  - return 对象包含 `_stk`、`_ste`、`h5st`；完整 h5st 写入 `values/jsv_82941_9.txt`
    和 `values/jsv_82941_10.txt`。
  - 控制台仍出现一次页面脚本 timeout；后续二轮推荐应先用 return-only/depth=1，
    再按需打开 args/object/value_store。
- target 早期脚本过滤验证：
  - 编译：`mach build` 通过，最后一次 wall time 约 24s。
  - 本地 smoke：`/private/tmp/firefox-trace-early-filter-smoke-1784956180`
    - JS 2 行；`buildSign` enter/return 均带 `early_script_filter=true`、
      `non_target_stack_skipped=true`。
    - `TRACE_JS_THIS=none TRACE_JS_ARGS=none TRACE_JS_RET=preview` 正常，仅记录 return；
      完整 return string 写入 `values/jsv_18115_1.txt`。
  - JD target return-only：`/private/tmp/firefox-trace-jd-h5st-early-filter-1784956204`
    - 浏览器 2 秒内完成 headless screenshot，没有被 trace 卡死。
    - 日志总 802 行，其中 JS 20 行；没有 `trace.degraded`。
    - 捕获 `_$PI.prototype.signSync -> _$PI.prototype._$sdnmd` 多组 return 对象；
      return 包含 `functionId`、`body`、`_stk`、`_ste`、`h5st`。
    - 完整 h5st 长字符串写入 10 个 `values/jsv_18639_*.txt` 文件。
    - 控制台仍出现 JD 首页 `index.chunk.js` 自身 script timeout；它不是目标
      `js_security_v3_0.1.4.js` 的 trace 卡死，但说明真实页还需要继续做降噪和
      浏览器启动偏好优化。
- target 非目标函数剪枝验证：
  - 编译：`mach build` 通过，最后一次 wall time 约 17s。
  - 本地 smoke：`/private/tmp/firefox-trace-prune-smoke-1784957139`
    - JS 只输出目标函数 2 行；事件带 `early_script_filter=true`、
      `non_target_stack_skipped=true`、`non_target_function_stack_skipped=true`。
    - return 长值正常写入 `values/`。
  - JD target return-only：`/private/tmp/firefox-trace-jd-prune-target-1784957171`
    - headless 截图约 2.5s 完成，未触发 `trace.degraded`。
    - 日志总 815 行：cookie 148、DOM 480、JS 24、storage 99、XHR 64。
    - 捕获 `_$PI.prototype.signSync -> _$PI.prototype._$sdnmd` 多组 return；
      return 对象包含 `functionId`、`appid`、`body`、`_stk`、`_ste`、`h5st`。
    - 完整 h5st 长字符串写入 12 个 `values/jsv_63243_*.txt`。
    - 目标脚本 `js_security_v3_0.1.4.js` 未再出现 trace 导致的 timeout；仍可见 JD
      首页 `index.chunk.js` 自身 timeout，说明浏览器全局降噪还要继续推进。

当前结论：真实站“卡死”不能靠全量深抓解决，已落地的有效路径是 ruyiTrace 风格的两轮/多轮策略：首轮轻量 boundary/ring-buffer 保候选和长字符串，二轮 target return-only/prune 深抓。`TRACE_JS_EARLY_SCRIPT_FILTER` 和 `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS` 是保页面活性的主开关，不是能力边界；需要完整调用树时可以关闭，但必须配合更轻的 value/object 配置重跑。

## 2026-07-25 请求 URL 输出降载验证

本轮新增 `FIREFOX_TRACE_REQUEST_URL` / `TRACE_REQUEST_URL=full|preview|none`，覆盖 XHR 和 Fetch：

- 默认 `full`：保持兼容，继续写完整 `url` / `response_url`。
- `preview`：写截断 URL，同时写 `url_size` / `url_truncated`；XHR response 使用
  `response_url_size` / `response_url_truncated`。
- `none`：不写 URL 正文，只写 `url_disabled/url_size`；XHR response 使用
  `response_url_disabled/response_url_size`。
- 该开关只控制日志输出，不影响内部用完整 URL 提取 `query_fields`。

验证记录：

- 编译：`mach build` 通过，wall time 约 22s。
- `TRACE_REQUEST_URL=preview` 本地 smoke：
  - 日志目录：`/private/tmp/firefox-trace-request-url-preview-1784957772`
  - 结果：XHR 6 行、Fetch 4 行；`xhr.open`、`xhr.response`、`fetch.call`、
    `fetch.request`、`fetch.response` 均写出截断 URL 和 size/truncated 元数据。
  - `query_fields` 仍从完整 URL 提取到 `functionId/sign/token`。
- `TRACE_REQUEST_URL=none` 本地 smoke：
  - 日志目录：`/private/tmp/firefox-trace-request-url-none-1784957797`
  - 结果：XHR 6 行、Fetch 4 行；事件不再写 URL 正文，只写 disabled/size。
  - `query_fields` 仍正常提取。
- JD 真实页 target smoke：
  - 日志目录：`/private/tmp/firefox-trace-jd-request-url-preview-1784957869`
  - 结果：总日志 832 行；XHR 70、JS 28、DOM 479、Storage 103、Cookie 152。
  - `url_size` 事件 54 条，其中 `url_truncated=true` 20 条；长 h5st URL 被截断并保留 size。
  - JS target 仍捕获 12 条带 h5st 的 return，完整值写入 12 个 `values/jsv_89995_*.txt`。
  - 未发现 `trace.degraded`。
  - 控制台重新出现目标脚本 `js_security_v3_0.1.4.js` timeout；页面仍完成截图、日志仍抓到目标 return。
    这说明 URL 降载能降低日志体积，但不能单独证明目标脚本 timeout 已彻底解决；后续需要继续做
    JS value 捕获/DOM/XHR 重复事件降载。

该改动是通用降载开关，不绑定任何测试站。后续如果真实站 URL/query 极长，首轮可以用 `TRACE_REQUEST_URL=preview` 保留定位信息，或者用 `none` 只保字段拆解和大小元数据。

## 2026-07-25 JS 对象属性值过滤验证

本轮新增 `FIREFOX_TRACE_JS_OBJECT_VALUE_KEYS` / `TRACE_JS_OBJECT_VALUE_KEYS`，用于降低
target/deep 对象展开的副作用：

- 默认 `all`：保持旧行为，展开对象时读取已枚举属性的值。
- CSV：只读取匹配 key 的属性值；不匹配属性仍记录 key，但写
  `value_skipped=key_filter`，不调用 `JS_GetPropertyById`。
- `none` / `0`：对象展开只保留 key 轮廓，不读取任何属性值。
- CSV 过滤继承现有语法：`token` 为 substring，`=token` 为精确匹配。

设计原因：真实反爬页的 return/args 常是普通对象、Proxy 或带 getter 的对象。对象 key 枚举已经有成本，逐个读取 value 还可能触发 getter、Proxy trap 或惰性计算。该开关让二轮 target 可以先只读取目标字段，避免为了看一个字段读取整对象。

验证记录：

- 编译：`mach build` 通过，wall time 约 20s。
- 本地 smoke：
  - 日志目录：`/private/tmp/firefox-trace-object-value-keys-1784958138`
  - 配置：`TRACE_JS_OBJECT_VALUE_KEYS=token,nested`
  - 结果：`objectTarget` 参数里 `token/nested` 有 value；`body` 只写
    `value_skipped=key_filter`。递归对象里未配置的 `sign/arr` 也跳过。
- JD 真实页 target smoke：
  - 日志目录：`/private/tmp/firefox-trace-jd-object-value-keys-1784958180`
  - 配置：`TRACE_JS_OBJECT_VALUE_KEYS=functionId,appid,body,_stk,_ste,h5st`
  - 结果：总日志 827 行；JS 20、XHR 62、DOM 496、Storage 97、Cookie 152。
  - `value_skipped=key_filter` 出现在 10 条事件里；未配置的 `client/clientVersion/t/r`
    被跳过。
  - h5st return 仍捕获 10 条，完整值写入 10 个 `values/jsv_5459_*.txt`。
  - 未发现 `trace.degraded`。
  - 本轮目标 `js_security_v3_0.1.4.js` timeout 未复现；控制台出现
    `pc-core-disposal.js` 的 XHR hook/send timeout。说明对象值过滤能降低 JS value
    捕获副作用，但真实页整体仍需要继续做 DOM/XHR 重复事件和浏览器背景噪声降载。

## 2026-07-25 XHR 事件级降载验证

本轮新增 `FIREFOX_TRACE_XHR_EVENTS` / `TRACE_XHR_EVENTS`，覆盖 XHR 生命周期事件：

- 默认 `all`：保持旧行为，记录 `open/header/send/body/start/done/response`。
- CSV：可写完整事件名或短名，例如 `open,send,response`。
- `none` / `0`：关闭 XHR 事件输出，但不影响总开关语义。

设计原因：真实站会在 XHR hook/send/header 路径上产生大量重复事件，尤其是 header/start/done
对参数逆向首轮不一定必要。该开关让用户可以在真实页保留 `send/response` 或
`open/send/response`，降低日志写盘和 hook 时序扰动；需要完整生命周期时再恢复 `all`。

验证记录：

- 编译：`mach build` 通过，wall time 约 16s。
- 本地 smoke：
  - 日志目录：`/private/tmp/firefox-trace-xhr-events-filter-1784958345`
  - 配置：`TRACE_XHR_EVENTS=open,send,response`
  - 结果：只输出 3 行：`xhr.open`、`xhr.send`、`xhr.response`。
  - `xhr.header`、`xhr.body`、`xhr.start`、`xhr.done` 均被过滤。
  - `query_fields` 仍正常输出。

## 2026-07-25 XHR 预览值降载验证

本轮新增 `FIREFOX_TRACE_XHR_PREVIEW` / `TRACE_XHR_PREVIEW`，控制 XHR 值预览：

- 默认 `all`：保持旧行为。
- CSV：可按 `header,body,response,detail` 白名单开启。
- `none` / `0`：关闭所有 XHR detail/body/response 值预览。
- 关闭 `response` 时，不再复制 `responseText` 到 UTF-8 preview，只保留
  `status/response_url/response_type/response_preview_enabled=false`。

设计原因：真实页 XHR hook/send timeout 不只来自事件数量，也可能来自 header/body/response
值复制。该开关允许保留请求关联、URL、query_fields、状态码和 caller，同时关闭大值预览。

验证记录：

- 编译：`mach build` 通过，wall time 约 20s。
- 本地 `TRACE_XHR_PREVIEW=none` smoke：
  - 日志目录：`/private/tmp/firefox-trace-xhr-preview-none-1784958571`
  - 结果：仍输出完整 XHR 生命周期 6 行。
  - `xhr.body` 写 `body_preview_enabled=false`。
  - `xhr.done` 写 `detail_value_disabled=true`。
  - `xhr.response` 写 `response_preview_enabled=false`。
  - `query_fields` 正常输出。
- 本地轻量组合 smoke：
  - 日志目录：`/private/tmp/firefox-trace-xhr-light-combo-1784958600`
  - 配置：`TRACE_XHR_EVENTS=open,send,response`、`TRACE_XHR_PREVIEW=none`
  - 结果：只输出 `xhr.open/xhr.send/xhr.response` 3 行；无 `detail_value`、
    `body_preview`、`response_preview`，但 `query_fields` 正常。

### DOM 事件/预览/热点保险丝

本轮补齐 DOM 侧防卡死配置，避免真实页在 `TRACE_DOM_MODE=signal` 下仍因大量
DOM getter/call、caller 描述和值 preview 干扰页面时序。

新增开关：

- `FIREFOX_TRACE_DOM_EVENTS` / `TRACE_DOM_EVENTS=all|none|get,set,call,construct`
  - 支持短名和完整事件名，如 `get` / `dom.get`。
  - 默认 `all`，保持旧行为。
- `FIREFOX_TRACE_DOM_PREVIEW` / `TRACE_DOM_PREVIEW=all|none|args,value,page,caller`
  - 默认 `all`，保持旧行为。
  - `none` 时仍记录 `interface/member/argc/origin_call_id/member_count` 等结构字段，
    但跳过参数展开、返回值描述、caller 描述和 page URL 输出。
  - page URL 仍会在需要时用于 `TRACE_DOM_FILTER` 内部判断；只是日志不输出完整 URL。
- `FIREFOX_TRACE_DOM_HOT_MEMBER_LIMIT` / `TRACE_DOM_HOT_MEMBER_LIMIT`
  - 默认 `0` 关闭。
  - 对单个 `operation/interface/member` 计数，超过阈值写
    `trace.degraded module=dom reason=hot_member_limit`。
- `FIREFOX_TRACE_DOM_HOT_MEMBER_SAMPLE` / `TRACE_DOM_HOT_MEMBER_SAMPLE`
  - 默认 `0`，超限后直接丢弃该热点成员后续事件。
  - 设置为 N 时，超限后每 N 次保留 1 条，并写 `member_count`。

设计结论：

- 这不是主分析策略，只是保险丝。首轮仍按 ruyiTrace 风格使用轻量 boundary /
  sink trace 保执行轮廓；二轮再按候选脚本/函数/DOM 面深抓。
- 命中 DOM 热点保险丝后必须把本轮标记为不完整，不能拿它证明目标链路不存在。
- 开关不绑定 JD/h5st；测试站只用于验证真实页面压力。

验证记录：

- 编译：`mach build` 通过，wall time 约 21s。
- 本地 `TRACE_DOM_PREVIEW=none` getter smoke：
  - 日志目录：`/private/tmp/firefox-trace-dom-hot-1784958991`
  - 结果：写出 `dom.get Navigator.userAgent`。
  - 日志包含 `args_preview_enabled=false`、`value_preview_enabled=false`、
    `page_url_disabled=true`、`caller_preview_enabled=false`。
- 本地 DOM call 热点 smoke：
  - 日志目录：`/private/tmp/firefox-trace-dom-hot-call-1784959052`
  - 配置：`TRACE_DOM_EVENTS=call`、`TRACE_DOM_PREVIEW=none`、
    `TRACE_DOM_HOT_MEMBER_LIMIT=3`、`TRACE_DOM_HOT_MEMBER_SAMPLE=2`。
  - 页面执行 20 次 `document.createElement("div")`，日志 13 行。
  - 第 4 次写出：
    `trace.degraded module=dom reason=hot_member_limit interface=Document member=createElement limit=3 sample=2`。
  - 后续按 `member_count` 偶数采样保留，证明热点保险丝生效且不静默截断。

### query_fields 长值保真

真实页验证暴露一个通用缺口：JS return 的长字符串已经能写入 `values/`，
但请求 URL 中由 `TRACE_QUERY_FIELDS` 拆出的目标字段默认仍跟随全局 preview 截断。
这样只能定位“请求里有目标字段”，不能稳定把请求字段与 JS 生成值做完整等值对齐。

本轮对 XHR 和 Fetch 都补齐同一套通用配置，不绑定任何站点或字段名：

- `FIREFOX_TRACE_QUERY_FIELD_VALUES` / `TRACE_QUERY_FIELD_VALUES=preview|full|none`
  - 默认 `preview`，保持旧行为，继续受 `TRACE_PREVIEW_LIMIT` 控制。
  - `full` 直接在 `query_fields` 写完整字段值，只建议二轮窄范围使用。
  - `none` 在 `query_fields` 中写 `null`，只保留 `query_fields_meta`。
- `FIREFOX_TRACE_QUERY_FIELD_VALUE_STORE` / `TRACE_QUERY_FIELD_VALUE_STORE=1|0`
  - 默认 `0`。
  - 开启后对命中的 query 字段写 `query_fields_meta`：
    `size/truncated/value_id/value_store_path/sha256/stored`。
  - 文件落在当前 trace 目录，XHR 使用 `values/qfv_xhr_<pid>_<seq>.txt`，
    Fetch 使用 `values/qfv_fetch_<pid>_<seq>.txt`，避免同一进程内文件名冲突。
- `FIREFOX_TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES` /
  `TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES`
  - 默认 `0`。
- `FIREFOX_TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES` /
  `TRACE_QUERY_FIELD_VALUE_STORE_MAX_BYTES`
  - 默认 `2097152`，超过写 `value_store_skipped=too_large`。

实现说明：

- XHR 和 Fetch 的 `query_fields` 保持原对象结构，避免破坏已有消费方。
- 元数据单独写 `query_fields_meta`，只有发生截断、禁用值输出或开启 value_store
  时才出现。
- content process 通过已有 value-store IPC 转 parent 落盘；`qfv_` 前缀按
  `TRACE_QUERY_FIELD_VALUE_STORE` 判断，不再受 JS value_store 开关误伤。
- XHR/Fetch preview limit 现在同时支持 `FIREFOX_TRACE_PREVIEW_LIMIT` 和
  `TRACE_PREVIEW_LIMIT`。
- 默认仍是轻量 preview；完整保真需要显式开关，符合“首轮发现、二轮精确对齐”的策略。

验证记录：

- 编译：`mach build` 通过，wall time 约 20s。
- 本地 XHR + Fetch query field value_store smoke：
  - 日志目录：`/private/tmp/firefox-trace-query-field-store2-1784959879`
  - 配置：`TRACE_REQUEST_URL=none`、`TRACE_QUERY_FIELDS=token`、
    `FIREFOX_TRACE_PREVIEW_LIMIT=24`、`TRACE_QUERY_FIELD_VALUES=preview`、
    `TRACE_QUERY_FIELD_VALUE_STORE=1`。
  - 结果：`firefox-xhr-75020.jsonl` 2 行、`firefox-fetch-75020.jsonl` 1 行。
  - `query_fields.token` 被截断为 `abcdefghijklmnopqrstuvwx...`。
  - `query_fields_meta.token` 写出 `size=288`、`truncated=true`、`sha256`、
    `stored=true`。
  - 完整值文件：
    - `values/qfv_xhr_75036_1.txt`，288 字节。
    - `values/qfv_xhr_75036_2.txt`，288 字节。
    - `values/qfv_fetch_75036_1.txt`，288 字节。
  - 没有 `trace.degraded`。

JD 真实页 query field value_store 对齐验证：

- 日志目录：`/private/tmp/firefox-trace-jd-qfv-1784960050`
- 配置要点：
  - `TRACE_PROFILE=target`
  - `TRACE_JS_MODE=target`
  - `TRACE_SCRIPT_CONTAINS=js_security_v3_0.1.4.js`
  - `TRACE_FUNCTION_CONTAINS='=_$PI.prototype.signSync,=_$PI.prototype._$sdnmd'`
  - `TRACE_JS_THIS=none`
  - `TRACE_JS_ARGS=none`
  - `TRACE_JS_RET=preview`
  - `TRACE_JS_OBJECT_VALUE_KEYS=functionId,appid,body,_stk,_ste,h5st`
  - `TRACE_QUERY_FIELDS=functionId,appid,h5st,sign,token,riskData,fp,_stk`
  - `TRACE_QUERY_FIELD_VALUE_STORE=1`
- 日志规模：
  - cookie：152 行
  - DOM：462 行
  - JS：28 行
  - storage：102 行
  - XHR：24 行
  - 总计：768 行
- `trace.degraded`：无。
- 生成轮廓：
  - JS target 记录到 `_$PI.prototype.signSync` 和 `_$PI.prototype._$sdnmd`。
  - `_$sdnmd` 为 `signSync` 的子调用，例如 `call_11577 -> call_11576`。
  - return 对象中包含 `functionId/appid/body/_stk/_ste/h5st`。
  - `h5st` 长值写入 JS `values/jsv_*.txt`。
- 请求字段对齐：
  - `jsfbox_newUser_hongbao`：`qfv_xhr_79853_1/2` 与
    `jsv_79853_9/10` 的 sha256 直接相同：
    `f444f089cc49e518364fccd5cf17e8cac733ca9e30a736b4445702b230956f15`。
  - `jsfbox_site_notice`：`qfv_xhr_79853_3/4` 与
    `jsv_79853_11/12` 的 sha256 直接相同：
    `ea9f7633d1a0be4470e2f111223a89cb704c115e20d1476996cc675b6ffc13f9`。
  - `jsfbox_pre_gb`：请求中的 `h5st` 是 URL 编码值，raw sha256 与 JS 不同；
    URL decode 后与 `jsv_79853_1/2` 对齐。
- 结论：
  - query field value_store 能把请求字段完整值和 JS return 完整值闭环。
  - 对 URL 编码字段，分析侧需要同时比较 raw 和 URL-decoded 值；浏览器核心不写死任何字段名或站点逻辑。

JD 真实页有头 Firefox 最终验证：

- 日志目录：`/private/tmp/firefox-trace-jd-headed-qfv-1785038025`
- 启动方式：`tools/run-trace-firefox.sh --trace-preset target-return https://www.jd.com/`
- `manifest.json` 记录：
  - `preset=target-return`
  - `campaign_id=jd-h5st-headed-final`
  - `run_label=jd-headed-target-return`
  - `headless=false`
  - `target_url=https://www.jd.com/`
  - 显式验证参数包括 `TRACE_SCRIPT_CONTAINS=js_security_v3_0.1.4.js`、
    `TRACE_FUNCTION_CONTAINS='=_$PI.prototype.signSync,=_$PI.prototype._$sdnmd'`、
    `TRACE_JS_OBJECT_VALUE_KEYS=functionId,appid,body,_stk,_ste,h5st`、
    `TRACE_QUERY_FIELDS=functionId,appid,h5st,sign,token,riskData,fp,_stk`。
- 日志规模：
  - cookie：1791 行
  - DOM：27864 行
  - fetch：25 行
  - JS：44 行
  - storage：505 行
  - XHR：168 行
  - 总计：30397 行
- `trace.degraded`：无。
- 生成轮廓：
  - JS 日志记录 22 个 `js.call.enter` 和 22 个 `js.call.return`。
  - 每组核心链路为 `_$PI.prototype.signSync` 调用
    `_$PI.prototype._$sdnmd`，例如：
    - `call_5091` enter `signSync`
    - `call_5092` enter `_$sdnmd`，`parent_call_id=call_5091`
    - `call_5092` return，return object keys 包含
      `functionId/appid/body/_stk/_ste/h5st`
    - `call_5091` return，return object keys 同样包含
      `functionId/appid/body/_stk/_ste/h5st`
  - `h5st` 长值完整写入 `values/jsv_57309_*.txt`，日志中保留
    `value_store_path`、`size`、`sha256`。
- 请求字段对齐：
  - XHR 中 `h5st` 完整值写入 `values/qfv_xhr_57309_*.txt`。
  - JS return 中 h5st 共 22 个完整值。
  - XHR h5st 与 JS return h5st 共得到 32 条匹配记录。
  - `jsfbox_newUser_hongbao`：`qfv_xhr_57309_1/2` 与
    `jsv_57309_9/10` 的 sha256 直接相同：
    `c80b754669721275cdc2e6d52be563e7be036a53114c03dcc5fec914593f5a79`。
  - `jsfbox_pre_gb`：请求里的 h5st 为 URL 编码值，URL decode 后与
    `jsv_57309_1/2` 对齐，sha256：
    `2a9b1f592686b951e29ff0a504e087fb79daaba56de8751f2948a27a94eb2adc`。
  - `jsfbox_site_notice`：`qfv_xhr_57309_5/6` 与
    `jsv_57309_11/12` 的 sha256 直接相同：
    `66e6138e9b4ae476ea1cf96904bf1ae139688c7c8d8a07eac900b7edc1fb905f`。
- 结论：
  - 最新有头 Firefox 构建能在真实 JD 页面抓到 h5st 的生成轮廓。
  - 能从请求侧 `query_fields_meta.h5st.value_store_path` 回连到 JS return
    侧 `h5st.value_store_path`。
  - JD/h5st 仍只作为验证样本，未进入核心默认逻辑。

### Trace Campaign / launcher presets

本轮将“不要一次全开”的策略固化到运行入口和文档：

- `tools/run-trace-firefox.sh` 新增 `TRACE_PRESET` / `--trace-preset`。
- preset 只填默认值；用户显式设置的环境变量优先。
- 新增 `TRACE_CAMPAIGN_ID` 和 `TRACE_RUN_LABEL`，用于把多轮运行归到同一目标分析。
- 每轮启动前写 `TRACE_DIR/manifest.json`：
  - `campaign_id`
  - `preset`
  - `run_label`
  - `target_url`
  - `trace_dir`
  - `profile_dir`
  - `firefox_bin`
  - `headless`
  - 关键 trace 环境变量。

当前 launcher preset：

- `discover-light`：首轮通用发现，JS boundary ring buffer、请求字段保真、DOM signal、XHR light。
- `target-return`：二轮确认生成函数，return-only、this/args 关闭、object depth=1、value_store。
- `target-values`：输入依赖分析，target args/return preview、object depth=2、value_store。
- `deep-causal`：目标局部调用树，deep + 关闭目标脚本内 prune，但仍保持浅值策略。
- `opcode-window`：VM/opcode 前置，只设置基础项；必须另行锁脚本、PC 窗口和 limit。

设计结论：

- Campaign 是工作流层，不是分析脚本依赖；最终交付仍是浏览器、日志 schema、启动参数和说明。
- 多轮证据通过 `value_store sha256`、`origin_call_id`、`call_id/parent_call_id`、
  `request_id`、脚本 URL/hash 综合，不要求一次 trace 不遗漏。
- 如果某轮出现 `trace.degraded`，manifest 和日志能保留本轮配置，下一轮按缺口收窄重跑。

本地 launcher smoke：

- 日志目录：`/private/tmp/firefox-trace-preset-smoke-1785037816`
- 命令类型：`tools/run-trace-firefox.sh --trace-preset discover-light --trace-run-label smoke-local data:text/html,...`
- `manifest.json` 已写入：
  - `preset=discover-light`
  - `campaign_id=smoke-campaign`
  - `run_label=smoke-local`
  - `headless=true`
  - `target_url=data:text/html,...`
- XHR/Fetch 均抓到 `query_fields.token` 和 `query_fields_meta.token.size=48`。
- 本轮 token 长度低于 `TRACE_QUERY_FIELD_VALUE_STORE_MIN_BYTES=64`，因此没有生成 `values/qfv_*` 文件，符合 preset 默认配置。
- 没有 `trace.degraded`。
- Firefox headless 退出阶段出现 Remote Settings / XPIProvider shutdown 噪声；trace 文件和 manifest 已完整落盘，不影响 launcher preset 验证。

### Deep causal 降噪：面向日志 + agent 动态调试

问题复现：

- 日志目录：`/private/tmp/firefox-trace-jd-deep-causal-process-1785048187`
- 配置：`deep-causal`，关闭目标脚本内 prune，保留 native/self-hosted。
- 结果：
  - JS：80001 行，命中 `trace.degraded reason=event_limit limit=80000`。
  - DOM：50288 行，命中 `trace.degraded reason=event_limit limit=50000`。
  - 爆量来源主要是目标后代中的 native/builtin 调用：
    `call`、`charCodeAt`、`isPrototypeOf`、`push`、`slice`、`apply`、`reverse` 等。
  - 虽然能看到 `_cps/_atm/_gdk/_gs/_gsd/_ms/_fv/bhikZ` 和多个 64-hex 中间 return，
    但该轮不完整，只能作为优化依据。

本轮改动：

- `js/src/vm/Interpreter.cpp`
  - 新增 `TRACE_JS_DEEP_NATIVE=1|0`。
  - 新增 `TRACE_JS_DEEP_SELFHOSTED=1|0`。
  - 新增 `TRACE_JS_DEEP_SUPPRESS_FUNCTIONS=CSV`。
  - deep 目标后代命中 suppression 时不写该调用 enter/return，不把该调用设为当前
    `parent_call_id`，后续非 suppression 子调用仍挂到最近可见父节点。
  - suppression 生效时写一次：
    `trace.suppressed reason=deep_descendant_suppressed`，避免静默省略。
- `tools/run-trace-firefox.sh`
  - `deep-causal` preset 默认：
    - `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS=0`
    - `TRACE_JS_DEEP_NATIVE=0`
    - `TRACE_JS_DEEP_SELFHOSTED=0`
    - `FIREFOX_TRACE_DOM=1`
    - `TRACE_DOM_MODE=signal`
    - `TRACE_DOM_EVENTS=get,call`
    - `TRACE_DOM_PREVIEW=none`
  - manifest 增加 deep suppression 相关配置项。

验证结果：

- 日志目录：`/private/tmp/firefox-trace-jd-deep-causal-suppressed3-1785048915`
- manifest 关键项：
  - `TRACE_PRESET=deep-causal`
  - `TRACE_JS_MODE=deep`
  - `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS=0`
  - `TRACE_JS_DEEP_NATIVE=0`
  - `TRACE_JS_DEEP_SELFHOSTED=0`
  - `FIREFOX_TRACE_DOM=1`
  - `TRACE_DOM_MODE=signal`
- 日志规模：
  - cookie：1826 行
  - DOM：28213 行
  - fetch：29 行
  - JS：19009 行
  - storage：528 行
  - XHR：481 行
- `trace.degraded`：无。
- `trace.suppressed`：有 1 条，说明 native deep descendant suppression 生效；
  这是配置性降噪，不是上限截断。
- JS 过程保留情况：
  - 目标链仍完整：`signSync -> _$sdnmd`。
  - interpreted 中间函数仍可见：
    `_cps`、`ParamsSign<`、`_$atm`、`_$gs`、`_$gsd`、`_$ms`、`_$fv`、`bhikZ`、
    `OzyUo`、`a0e467aT`、`_$PR`、`toWordArray`、`fromWordArray`、`finalize` 等。
  - 64-hex 中间 return：148 个。
  - h5st return/value_store：55 个。
  - 示例 h5st 传播：
    `_$PI.prototype._$ms -> _$fv -> bhikZ -> _$sdnmd -> signSync` 的 h5st
    `sha256=d2ac690a5c8e035e0b7102ec108c9c2739e19c6662b331cc68cdaa450a1400ec`
    对应 `values/jsv_97592_74.txt`、`values/jsv_97592_77.txt`、
    `values/jsv_97592_78.txt`、`values/jsv_97592_79.txt`、
    `values/jsv_97592_80.txt`。

结论：

- deep-causal 现在可以作为“日志 + agent 动态调试”的锚点层：
  先保留自定义 JS 调用链、关键入参、return、中间 hash 和完整 h5st；
  agent 再按 call_id/function_name/script_url/line/column/value sha256 选择下一轮断点或
  native 细节重跑。
- 这不是要求 AI 离线阅读完整大日志还原算法；日志负责给出可靠锚点和候选路径。
- 如果需要追 `charCodeAt`、`push/pop`、`Array/String` 低层细节，显式重跑：
  `TRACE_JS_DEEP_NATIVE=1 TRACE_JS_DEEP_SELFHOSTED=1`，并应再收窄函数、时间窗口或
  `TRACE_JS_DEEP_SUPPRESS_FUNCTIONS`，避免回到 8 万行爆量。

### 第一阶段缺口：参数逆向闭环

1. Fetch main-thread 非 keepalive 路径已有 `fetch.call/request/response/body_chunk/done`；
   request body bounded preview/store 已可通过 `TRACE_FETCH_REQUEST_BODY=preview|full`
   和 `TRACE_FETCH_REQUEST_BODY_STORE=1` 显式开启；response headers 已记录；
   response body bounded preview 已可通过 `TRACE_FETCH_RESPONSE_BODY=preview|full` 显式开启。
   Worker fetch、keepalive/PFetch、完整 response body artifact 仍列为后续边界。
2. document.cookie、CookieStore API、HTTP Set-Cookie、CookieStorage 底层生命周期和 Storage 生命周期 trace 已实现；CookieStorage lifecycle 当前覆盖 delete/overwrite/expired/purge/eviction/removeAll，但 JS 调用上下文仍需结合 API 层事件和 JS trace。
3. 动态脚本 source/hash 基础能力、source map/header/charset 元数据、外部脚本 raw artifact 和显式 source map 下载工具已实现；source map 文件通过 `tools/fetch_source_maps.py` 在运行后按 `source_map_resolved_url` 抓取，不由浏览器后台自动下载。
4. XHR/Fetch 已有 URL `query_fields`；Fetch 已有 request body preview/store、response headers、response clone preview 和流式 `body_chunk` preview；XHR 已有 request body bounded preview/store/sha256，并能从 JSON body 或 form-urlencoded body 中按 `TRACE_QUERY_FIELDS` 抽取 `body_fields`。完整 response body artifact 仍列后续。
5. 参数配置还只是环境变量，尚未接入 UI/配置面板。
6. `discover/field` 已实现 JS boundary ring buffer、sink 触发 flush、flush summary、
   按 sink/字段 reason 的窗口大小配置和覆盖后的重跑建议；后续只保留更细的
   summary interval / UI 展示优化。

### 第二阶段缺口：深度 JS 执行

1. 没有 opcode trace。
2. 没有 stack slots / operands 记录。
3. 没有 PC window。
4. 没有 flush interval / summary interval。
5. JIT/解释器策略已改为默认保留 JIT；仍缺按脚本/函数粒度的 tier-pin。

### 第三阶段缺口：VM/WASM/网络底层

1. 没有 jsvmp/vm_step。
2. 没有 dispatcher autodetect。
3. 没有 WASM dump/insn trace。
4. 没有 HTTP packet trace。
5. 没有 WebSocket frame trace。

## 推荐下一步

当前唯一待做清单入口是 [TODO.md](TODO.md)。本文件继续作为历史进度和验证记录，
不要再扩写长期 TODO。

当前最高优先级：

1. P0 运行时 Trace 开关：支持浏览器先打开但 trace 暂停，用户完成登录/验证码/滑块后，
   再 start 采集目标请求，触发后 stop。
2. P0 运行时配置边界：明确哪些开关启动前固定，哪些可通过 control file 动态修改。
3. P1 验证和收口：对 automation surface、boundary window、source map、XHR/Fetch 字段、
   JD/PDD smoke 重新跑一轮，更新 patch 和 handoff。

## 2026-07-26 P0 automation surface baseline

本轮实现：

- `gecko-dev/dom/base/Navigator.cpp`
  - 新增 `TRACE_AUTOMATION_SURFACE` / `FIREFOX_TRACE_AUTOMATION_SURFACE`。
  - 默认 `baseline` 行为：网页读取 `navigator.webdriver` 返回 `false`。
  - `stock` 行为：保持 Firefox 原始逻辑，Marionette 或 RemoteAgent running 时返回 `true`。
- `gecko-dev/browser/base/content/browser.js`
  - 默认 `baseline` 行为：有头窗口不显示远程控制提示 UI，不设置主窗口
    `remotecontrol` 属性。
  - `stock` 行为：保持 Firefox 原始远控 UI 提示逻辑。
- `gecko-dev/toolkit/modules/Troubleshoot.sys.mjs`
  - 默认 `baseline` 行为：`about:support` RemoteAgent provider 返回 not running，
    不展示监听 URL。
  - `stock` 行为：保持 Firefox 原始排障页 RemoteAgent 信息。
- `gecko-dev/toolkit/components/search/AppProvidedSearchEngine.sys.mjs`
  - 默认 `baseline` 行为：搜索引擎图标 Remote Settings attachment 缺失时安静返回，
    不打印 `cache or dump` console error/warn，也不排 idle 后台下载。
  - `stock` 行为：保持 Firefox 原始图标日志和后台更新逻辑。
- `gecko-dev/services/settings/remote-settings.sys.mjs`
  - 默认 `baseline` 行为：Remote Settings startup bundle、timer poll 和 broadcast poll
    no-op，保留 packaged dump 读取。
  - `stock` 行为：保持 Firefox 原始 Remote Settings 后台同步逻辑。
- `tools/run-trace-firefox.sh`
  - 默认 `TRACE_AUTOMATION_SURFACE=baseline`。
  - 新增 `--trace-automation-surface stock|baseline`。
  - 导出 `TRACE_AUTOMATION_SURFACE` 和 `FIREFOX_TRACE_AUTOMATION_SURFACE`，后者供 Gecko
    侧优先读取。
  - `manifest.json` 增加顶层 `automation_surface` 和 env 记录。
  - 默认 trace/profile 临时目录增加 pid 后缀，避免并行 smoke 同秒撞 profile。
  - `manifest.json.target_url` 跳过 `--marionette`、`--remote-debugging-port` 等 Firefox
    控制参数，记录实际页面参数。
- `profiles/trace-user.js`
  - Remote Settings 默认关闭自身日志，并保留长轮询间隔，避免浏览器 chrome 后台噪声
    污染 trace run。
  - 不在 profile 里修改页面可读的 UA、语言、时区、screen、WebGL 或 canvas。
- `tests/automation-surface.html`
  - 本地对拍页，采集 webdriver descriptor、UA/app、OS、languages、plugins、
    permissions、screen/window、visibility、WebGL/GPU 和 timezone 等页面可见面。

验证：

- Gecko build 已通过；新增有头远控 UI gate 和 `about:support` RemoteAgent gate 后已重新 build 通过。
- baseline smoke：
  - 目录 `/private/tmp/firefox-trace-surface-baseline`。
  - 截图 `/private/tmp/firefox-trace-surface-baseline.png`。
  - 页面 JSON 显示 `webdriver: false`。
- stock smoke：
  - 目录 `/private/tmp/firefox-trace-surface-stock`。
  - 截图 `/private/tmp/firefox-trace-surface-stock.png`。
  - 页面 JSON 显示 `webdriver: true`。
- 两轮均使用 `--marionette`，且 trace 目录内存在 `firefox-dom-*.jsonl`；日志记录到
  permissions、canvas 和 WebGL 相关 DOM 事件，说明页面 API gate 没有破坏控制通道
  或 DOM trace。
- launcher manifest 单测使用 `FIREFOX_BIN=/usr/bin/true` 验证：
  `tools/run-trace-firefox.sh --marionette tests/automation-surface.html` 写出的
  `target_url` 是 `tests/automation-surface.html`。

判断：

- 该改动只改页面 API 返回值，不停止 MCP 依赖的 Marionette / RemoteAgent 控制通道。
- 有头窗口/focus、WebGL/GPU、permissions、plugins/languages 等 surface 先用本地页和
  真实页面 smoke 对拍，再决定是否需要 Gecko 层继续压平。

补充真站 smoke：

- BrowserScan bot detection：
  - URL `https://www.browserscan.net/zh/bot-detection`。
  - 页面检测结果：总结果正常；WebDriver、WebDriver Advance、Selenium、Headless
    Chrome、CDP、Dev Tool 均正常。
  - 页面 Navigator 列表显示 `webdriver=false`。
- BrowserScan browser checker：
  - URL `https://www.browserscan.net/zh/browser-checker`。
  - 页面显示 Firefox 142；浏览器版本和 User-Agent 匹配。
- PDD mobile：
  - URL `https://mobile.pinduoduo.com/`。
  - title 为 `拼多多`，页面正常渲染商品流和底部导航。
  - 页面侧 `navigator.webdriver=false`。
- Remote Settings 后台噪声复测：
  - 新增 `remote-settings.sys.mjs` baseline gate 后重新 build 通过。
  - 再次打开 BrowserScan bot detection，检测结果正常，页面侧 `navigator.webdriver=false`。
  - 启动/关闭阶段未再出现 Remote Settings polling content-type 报错或
    search icon attachment `cache or dump` 报错。

## 2026-07-27 P1 quick user runbook

README 顶部新增“快速使用入口”，覆盖：

- 默认有头 baseline 行为；
- 一轮 `discover-light` 启动命令；
- preset 选择表；
- discover → target-return → target-values 多轮流程；
- `manifest.json`、XHR/Fetch/JS/DOM/Storage/Cookie/Script/values 日志速查；
- value_store / sha256 对齐规则；
- `trace.degraded` 的处理方式；
- 常见降载组合。

## 2026-07-27 P1 ring buffer flush summary

新增 JS boundary ring buffer 体验改进：

- `js.boundary.flush_summary`
  - 每次 sink 触发 `FirefoxTraceFlushJSBoundaryBuffer()` 后写入。
  - 字段：`flush_index`、`reason`、`first_seq`、`last_seq`、`flushed`、
    `dropped_before_flush`、`capacity`、`complete_window`、`suggestion`。
  - `complete_window=false` 表示本轮已有覆盖，只能作为候选定位。
- `trace.degraded reason=boundary_buffer_overwrite`
  - 新增 `suggestion` 字段，提示增大 `TRACE_JS_BOUNDARY_BUFFER_EVENTS`、收窄
    `TRACE_JS_BOUNDARY_FLUSH_ON`，或用 `TRACE_SCRIPT_CONTAINS` /
    `TRACE_FUNCTION_CONTAINS` 重跑 `target-return`。

验证：

- Gecko build 通过。
- 有头本地 smoke：
  - 目录 `/private/tmp/firefox-trace-ring-summary-1785122172`。
  - 命令：`tools/run-trace-firefox.sh --trace-preset discover-light --marionette tests/automation-surface.html`。
  - `firefox-js-97157.jsonl` 写出多条 `js.boundary.flush_summary`。
  - 示例字段：`reason=dom.get`、`flushed=1/2/3`、`dropped_before_flush=0`、
    `capacity=8192`、`complete_window=true`。

## 2026-07-27 P1 ring buffer sink window

新增按 sink reason 配置 JS boundary flush 窗口：

- 全局默认仍是 `TRACE_JS_BOUNDARY_BUFFER_EVENTS`。
- 新增 `TRACE_JS_BOUNDARY_BUFFER_EVENTS_<REASON>` /
  `FIREFOX_TRACE_JS_BOUNDARY_BUFFER_EVENTS_<REASON>`，其中 `<REASON>` 为 sink reason
  大写并把分隔符转成 `_`，例如：
  - `dom.get` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_GET`
  - `dom.call` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL`
  - `xhr.body` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY`
  - `fetch.call` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL`
- XHR/Fetch URL query 和 XHR body 如果命中 `TRACE_QUERY_FIELDS`，flush reason 会追加
  字段名，例如：
  - `xhr.body.anti_content` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY_ANTI_CONTENT`
  - `fetch.call.token` -> `TRACE_JS_BOUNDARY_BUFFER_EVENTS_FETCH_CALL_TOKEN`
- 如果精确 reason 未配置，会继续尝试模块级配置，例如 `xhr.body` 可回退到
  `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR`。
- `discover-light` preset 默认：
  - DOM get/call：`2048`
  - XHR send：`12288`
  - XHR body：`16384`
  - Fetch call：`12288`
  - 全局：`8192`
- 物理 ring 仍保留最大 32768 条，flush 时按当前 sink 的窗口裁剪；这样 DOM 小窗口
  不会提前破坏 XHR body 需要的更长历史。
- `js.boundary.flush_summary` 新增：
  - `skipped_by_window`
  - `window_capacity`
  - `storage_capacity`
  - `window_capacity_source`
- `trace.degraded reason=boundary_buffer_overwrite` 新增同类窗口字段和针对 per-sink
  窗口的重跑建议。

设计收益：

- 首轮 discover 可以给关键请求 sink 保留更长 JS 前置调用窗口，同时压短高频 DOM
  环境读取窗口。
- 日志量不需要随最大请求窗口线性膨胀，`complete_window=false` 时也能区分是物理覆盖
  还是本次 sink 窗口裁剪。
- 当前实现支持 sink reason 和 `TRACE_QUERY_FIELDS` 命中字段级窗口；不是字段命中的
  sink 仍使用 sink 或模块级窗口。

验证：

- Gecko build 通过。
- 本地 headless smoke：
  - 页面：`file:///Users/empycity/Desktop/JS-tools/firefoxTrace/tests/boundary-window.html`
  - 目录：`/private/tmp/firefox-trace-boundary-window-abs-1785123980`
  - 配置：`TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL=3` + `discover-light`
  - `firefox-js-67983.jsonl` 写出：
    - `reason=dom.call`
    - `flushed=3`
    - `skipped_by_window=42`
    - `window_capacity=3`
    - `storage_capacity=32768`
    - `window_capacity_source=TRACE_JS_BOUNDARY_BUFFER_EVENTS_DOM_CALL`
    - `complete_window=false`

## 2026-07-27 P1 source map relation fields

`script.resource` 增加 source map 关系字段：

- `source_map_resolved_url`
  - 从 `mRequest->mSourceMapURL` 或 `sourcemap/x-sourcemap` 响应头得到
    `source_map_url` 后，基于脚本最终 URL 解析成绝对 URL。
  - 如果 request/header 未提供 source map，但完整 raw capture 里存在
    `sourceMappingURL=` 注释，则从 raw capture 中解析。
- `source_map_fetch_suggestion`
  - 说明由外部工具按 `source_map_resolved_url` 显式抓取 source map，并用
    `raw_sha256/artifact_path` 作为脚本和 map 的 join key。

设计取舍：

- 不在浏览器后台自动下载 source map，避免 trace 浏览器自己引入额外网络行为。
- 已有 `TRACE_SCRIPT_RESOURCE_CAPTURE/STORE` 继续负责脚本原始响应 artifact。
- `raw_truncated=true` 时新增 `raw_capture_limit` 和 `raw_capture_suggestion`，明确提示
  增大 `TRACE_SCRIPT_RESOURCE_MAX_BYTES`、收窄 `TRACE_SCRIPT_RESOURCE_FILTER` 或关闭
  无关脚本 raw store 后重跑；截断 raw 不能产生可靠 `raw_sha256` 或完整脚本 artifact。
- 新增外部工具 `tools/fetch_source_maps.py`：
  - 读取 `firefox-script-*.jsonl` 的 `source_map_resolved_url`；
  - 显式下载 source map 到 `source_maps/<script-raw-sha256>.map`；
  - 写 `source_maps/index.jsonl`，记录脚本 URL、`raw_sha256`、`artifact_path`、
    source map URL、source map sha256 和落盘路径。
  - 这是运行后工具，不在浏览器中自动发起额外网络请求。

验证：

- Gecko build 通过。
- 本地 HTTP source map smoke：
  - server：`python3 -m http.server 8765 --bind 127.0.0.1 --directory tests`。
  - 页面：`http://127.0.0.1:8765/source-map-page.html`。
  - 配置：`TRACE_SCRIPT_RESOURCE_CAPTURE=1 TRACE_SCRIPT_RESOURCE_STORE=1`
    + `discover-light`。
  - 目录：`/private/tmp/firefox-trace-sourcemap-http-1785122924`。
  - `firefox-script-27128.jsonl` 写出：
    - `source_map_url=source-map-target.js.map`
    - `source_map_resolved_url=http://127.0.0.1:8765/source-map-target.js.map`
    - `raw_sha256=3ffa9f58e901a5cf89b76ad7907b2f17d1b99b32a859f05a4d50ac3e20390464`
    - `artifact_path=scripts/3ffa9f58e901a5cf89b76ad7907b2f17d1b99b32a859f05a4d50ac3e20390464.js`
  - artifact 文件 sha256 与事件 `raw_sha256` 一致。

## 2026-07-26 第一阶段真实站验证：JD h5st + PDD anti_content

本轮新增并验证 XHR request body 能力：

- 新增配置：
  - `TRACE_XHR_REQUEST_BODY=none|preview|full`
  - `TRACE_XHR_REQUEST_BODY_MAX_BYTES`
  - `TRACE_XHR_REQUEST_BODY_HEX_BYTES`
  - `TRACE_XHR_REQUEST_BODY_STORE`
- `xhr.body` 新增字段：
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
- body 字段抽取复用 `TRACE_QUERY_FIELDS`，支持：
  - JSON 字符串 body，例如 `{"anti_content":"..."}`
  - form-urlencoded body，例如 `req_params=...&anti_content=...`
- XHR request body 只记录 JS `send()` 已经持有的字符串/URLSearchParams 等可见值，不额外读取网络 stream，不消费真实请求体。

本地 smoke：

- 目录：`/private/tmp/firefox-trace-xhr-request-body-smoke-1785065876`
- 页面：`tests/xhr-request-body.html`
- 结果：
  - `xhr.body` 捕获 JSON body：
    `{"anti_content":"trace-xhr-request-body-token","nested":{"n":11}}`
  - body sha256：
    `032277ddb395b4d2805d519fc6fe16ad52730540dd088108c692682f3dec9f05`
  - body artifact：
    `values/xhr_req_body_66874_1.txt`
  - 字段 artifact：
    `values/qfv_xhr_66874_1.txt`
  - `xhr.response status=200`，说明 trace 没有破坏请求体。

JD `h5st` 验证：

- 目录：`/private/tmp/firefox-trace-jd-firstphase-target-1785065263`
- 配置：`target-return`，`TRACE_FUNCTION_CONTAINS='signSync,_$sdnmd'`，`TRACE_QUERY_FIELDS=functionId,appid,h5st,sign,token,riskData,fp,_stk`
- 结果：
  - 无 `trace.degraded`。
  - XHR 请求侧捕获 34 个 `h5st` value store，15 个唯一 sha256。
  - 相关脚本包括：
    - `https://storage.360buyimg.com/webcontainer/js_security_v3_0.1.4.js?v=20240117`
    - `https://storage.360buyimg.com/webcontainer/main/js_security_v3_main_0.1.8.js?v=20260726`
    - `https://storage.360buyimg.com/webcontainer/main/js-security-v3-rac.js?v=20260726`
  - JS 生成/返回侧捕获：
    - `_$PI.prototype.signSync`
    - `_$PI.prototype._$sdnmd`
    - `_$Yx.prototype.signSync`
    - `_$Yx.prototype._$sdnmd`
  - 至少一组 JS return value_store 与 XHR `h5st` 请求字段 sha256 完全一致：
    - `values/jsv_50839_9.txt`
    - `values/jsv_50839_10.txt`
    - `values/qfv_xhr_50839_2.txt`

PDD `anti_content` 验证：

- 第一轮 discover 目录：`/private/tmp/firefox-trace-pdd-firstphase-search-1785065942`
- 第二轮 target 目录：`/private/tmp/firefox-trace-pdd-firstphase-target-search-1785066090`
- 测试页：
  `https://mobile.yangkeduo.com/search_result.html?search_key=%E6%89%8B%E6%9C%BA`
- discover 结果：
  - 无 `trace.degraded`。
  - `xhr_9` 请求：
    - URL：`https://mobile.yangkeduo.com/proxy/api/search?pdduid=0`
    - response status：`403`，但参数生成和发送已经发生。
    - `xhr.body` 捕获 JSON request body，包含 `anti_content`。
    - body artifact：`values/xhr_req_body_67790_5.txt`
    - 字段 artifact：`values/qfv_xhr_67790_2.txt`
- target 结果：
  - 对 `search_result` 脚本做 target-values。
  - JS 调用入参中捕获 `req_params`，其中包含完整 `anti_content`：
    - `881/t.Ay`
    - `12401/_</<`
    - `12401/x</<`
    - `e`
  - `values/jsv_70420_1.txt` 到 `values/jsv_70420_10.txt` 中多条 JS value 与请求 body 片段内容一致。
  - 关键 sha256 对齐：
    - JS value sha256：
      `064d819c51dc7bf4c296074d0be4e1f1ce803a1d2ca1042daefc57c73fb37a4e`
    - XHR body sha256：
      `064d819c51dc7bf4c296074d0be4e1f1ce803a1d2ca1042daefc57c73fb37a4e`
    - 对应：
      `values/jsv_70420_1.txt` 等 JS artifacts 与
      `values/xhr_req_body_70420_5.txt`

阶段结论：

- 第一阶段核心证据链已闭合：
  1. 首轮轻量 discover 能保请求、脚本身份、调用边界和目标字段；
  2. analyzer/agent 可从 sink 反推候选脚本/函数；
  3. 二轮 target-values 能深抓 args/return/object/value_store；
  4. 请求侧字段/body artifact 能与 JS value_store 做 sha256 对齐；
  5. JD 与 PDD 都能形成“生成/传递侧 + 请求侧”的双证据。
- 第一阶段剩余边界仍明确列为后续：
  - Worker fetch
  - keepalive/PFetch
  - 完整 response body artifact
  - UI/配置面板
  - 更细的 ring buffer summary interval / UI 展示
  - opcode / vm_step / WASM / HTTP/WS

## 构建命令

### 第一阶段补齐 smoke：script.resource + Fetch request/headers

本轮补齐并验证：

- 外部脚本资源事件 `script.resource`：
  - 新增配置：`TRACE_SCRIPT_RESOURCE`、`TRACE_SCRIPT_RESOURCE_FILTER`、
    `TRACE_SCRIPT_RESOURCE_CAPTURE`、`TRACE_SCRIPT_RESOURCE_STORE`、
    `TRACE_SCRIPT_RESOURCE_MAX_BYTES`、`TRACE_SCRIPT_RESOURCE_HEADERS`、
    `TRACE_SCRIPT_RESOURCE_HEADER_NAMES`。
  - 默认 `TRACE_SCRIPT_RESOURCE_FILTER=web`，只记录网页脚本；需要排查扩展/chrome
    噪声时显式设置 `all` 或 `chrome`。
  - 本地 smoke：`/private/tmp/firefox-trace-script-resource-smoke-1785064453`
    - `firefox-script-*.jsonl` 只有 1 条页面脚本；
    - 记录 `content_type=text/javascript`、`source_map_url`、headers、
      `raw_sha256`、`artifact_path`；
    - 原始脚本写入 `scripts/565fb028ed20382147ef9eea805b020294b2ebf215bb9c3080314fca38a02f2e.js`。
- Fetch request body preview/store：
  - 新增配置：`TRACE_FETCH_REQUEST_BODY`、
    `TRACE_FETCH_REQUEST_BODY_MAX_BYTES`、
    `TRACE_FETCH_REQUEST_BODY_HEX_BYTES`、
    `TRACE_FETCH_REQUEST_BODY_STORE`。
  - 实现方式：`fetch.request` 阶段 clone `InternalRequest` body stream 后读取预览，不消费真实上传 body；clone/available/read 失败写 `body_preview_skipped`。
  - 本地 POST smoke：`/private/tmp/firefox-trace-fetch-request-body-smoke-1785064991`
    - `fetch.request` 捕获 JSON body：
      `{"token":"trace-fetch-request-body-token","nested":{"n":7}}`；
    - 完整预览写入 `values/fetch_req_body_45925_1.txt`；
    - 本地 echo 返回 200，说明 body 没被 trace 消费。
- Fetch response headers：
  - 新增配置：`TRACE_FETCH_RESPONSE_HEADERS`、
    `TRACE_FETCH_RESPONSE_HEADER_NAMES`、
    `TRACE_FETCH_RESPONSE_HEADERS_MAX_COUNT`、
    `TRACE_FETCH_RESPONSE_HEADER_VALUE_MAX_BYTES`。
  - 本地 smoke 中 `fetch.response` 记录 `Content-Type/Date/Server`，
    `headers_truncated=false`。

本轮构建：

- `python3.11 ./mach build` 通过。

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

正确运行路径：

```bash
obj-aarch64-apple-darwin25.6.0/dist/Nightly.app/Contents/MacOS/firefox
```

`tools/run-trace-firefox.sh` 未设置 `FIREFOX_BIN` 时，会自动从
`gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/firefox` 选择最新可执行文件。

不要运行：

```bash
obj-aarch64-apple-darwin25.6.0/dist/bin/firefox
```

该路径会报 `Couldn't load XPCOM`。

## 2026-07-28：JS 模块运行时开关下沉

本次按用户要求只改一个内核点后停止：

- 文件：`gecko-dev/js/src/vm/Interpreter.cpp`
- 改动：`FirefoxTraceBaseEnabled()` 现在同时检查
  `FIREFOX_TRACE_JS` / `TRACE_JS`。
- 目的：控制台 UI 或 CLI 写入 `--module js=0` 后，JS trace 入口直接关闭，
  不再继续产生 JS call/value/boundary buffer 等 JS 侧日志和重活。
- 已验证：
  - `git -C gecko-dev diff --check -- js/src/vm/Interpreter.cpp` 通过；
  - `python3.11 ./mach build` 通过；
  - active smoke 目录：
    `/private/tmp/firefox-trace-js-module-off-active-smoke-1785212600`。
- smoke 结果：
  - 启动参数包含 `FIREFOX_TRACE_JS=0 --trace-start active`；
  - `firefox-xhr-97195.jsonl` 3 行，抓到
    `anti_content=runtime-control-token-1785210988666`；
  - `firefox-dom-97195.jsonl` 1 行；
  - 未生成 `firefox-js-*.jsonl`。
- 已完成：paused 后通过 `trace-control.sh config --module js=0` 热切换已闭环。2026-07-28
  headless smoke 中，config revision 2 和 start revision 3 均收到匹配 ACK；首个目标 XHR 的
  三个事件均带 `control_version=3` 与当前 `config_hash`，并且没有生成 JS trace。
