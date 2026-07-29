# Firefox Trace 待做清单

更新时间：2026-07-28

本文是当前唯一的待做清单入口。`README.md`、`docs/TRACE_PROGRESS.md` 和
`docs/AGENT_HANDOFF.md` 只保留背景、能力说明和验证记录；后续新增/关闭任务优先改这里。

## 当前基线

P1 可交付试用能力已经具备：

- 有头 Firefox Trace 可以编译通过并启动 `Nightly.app`。
- runtime trace control v2 已实现：`--trace-start active|paused|prewarm` 和
  `tools/trace-control.sh config|new-segment|start|stop|prewarm|status`。
- `discover-light` / `target-return` / `target-values` / `deep-causal` / `opcode-window`
  preset 已有 launcher 配置。
- XHR/Fetch URL query 字段、XHR request body 字段、Fetch request body、Fetch response
  headers 和 bounded response body preview/chunk 已实现。
- DOM signal、Cookie、Storage、script.resource、动态脚本 hash/artifact、source map
  relation fields 已实现。
- JS boundary ring buffer、sink/字段级窗口、flush summary、`trace.degraded` 明确提示已实现。
- target/deep JS args/return/object preview/value_store 已实现。
- `TRACE_AUTOMATION_SURFACE=baseline|stock` 已实现并写入 manifest。
- `tools/run-trace-firefox.sh` 默认优先使用 `FIREFOX_BIN`；未指定时会从
  `gecko-dev/obj-*/dist/Nightly.app/Contents/MacOS/firefox` 自动选择最新可执行产物。
- `tools/trace_analyzer.py` 可做首轮候选分析和下一轮 env 建议。
- `[已通过]` Parent push / content ACK 协议：控制台可读取 `trace.config.applied`，并以
  当前 `version/config_hash` 匹配作为热切换生效门槛；多进程目标页可按 XHR/Fetch 的 `pid`
  查询 `/api/status?target_pid=<pid>`，不再把其他 content process 的 ACK 当作目标页就绪。
  2026-07-28 headless paused smoke 已验证
  `config --module js=0`、`start` 的 ACK 和首个 XHR；XHR 带新控制版本/hash，且未生成 JS trace。
- `[已修复]` JS 预设与模块开关现在显式写入 `FIREFOX_TRACE_JS`：此前仅设置
  `TRACE_JS_MODE`/profile 会让内核 JS gate 保持关闭，造成 `target-return` 只有 XHR 而没有
  `firefox-js-*.jsonl`；`--module js=0|1` 也会同步更新对应环境变量。
- `[已修复]` target/deep 可显式启用 `TRACE_JS_TARGET_BOUNDARY_BUFFER=1`：目标脚本的
  call/return/value_store 先进入环形窗口，目标 XHR/Fetch sink 才 flush，避免人工等待期间
  高热点把 JS event limit 提前耗尽。
- JS 长值 artifact 按 SHA-256 去重；预设启用 IPC 事件/字节预算，超限写
  `trace.degraded module=ipc reason=event_budget`。
- JD `h5st` 和 PDD `anti_content` 已作为真实页面验收样本使用；它们不是产品内置规则。

## P0：运行时 Trace 开关

问题：

真实站通常要先登录、过验证码、滑块、跳转或人工选择状态。当前浏览器一启动就 trace，
前置流程会产生大量 DOM/JS 日志，污染 boundary buffer，严重时导致页面卡死。PDD 登录卡死
就是这个问题的直接样本。

目标：

- 浏览器可先正常打开，trace 默认暂停。
- 用户/agent 完成前置动作后，再在目标触发前开启 trace。
- 目标请求发出后可以停止 trace。
- 日志明确记录 start/stop 边界，分析时不会混淆前置动作和目标动作。

建议接口：

```bash
tools/run-trace-firefox.sh \
  --trace-preset discover-light \
  --trace-start paused \
  'https://mobile.pinduoduo.com/'

tools/trace-control.sh "$TRACE_DIR" start
tools/trace-control.sh "$TRACE_DIR" stop
tools/trace-control.sh "$TRACE_DIR" status
```

多 segment 热切：

```bash
tools/trace-control.sh "$TRACE_DIR" config --segment discover --preset discover-light --query-fields h5st,anti_content
tools/trace-control.sh "$TRACE_DIR" start discover
tools/trace-control.sh "$TRACE_DIR" stop after-discover

tools/trace-control.sh "$TRACE_DIR" new-segment target-values
tools/trace-control.sh "$TRACE_DIR" config --preset target-values --script-contains '<script>' --function-contains '<fn>'
tools/trace-control.sh "$TRACE_DIR" start target-values
```

已实现：

- launcher 新增 `--trace-start active|paused|prewarm`。
  - `active`：保持当前行为，启动即采集。
  - `paused`：启动后所有 trace 模块默认不写事件、不做重活。
  - `prewarm`：只记录极轻量 manifest/control/script 身份，默认不开 JS/DOM/value preview。
- `TRACE_DIR/trace-control.json` 作为运行时控制文件，例如：

  ```json
  {
    "schema": "firefox_trace.control.v2",
    "enabled": true,
    "mode": "active",
    "segment_id": "seg_002",
    "segment_label": "discover",
    "config_hash": "…",
    "modules": {
      "xhr": true,
      "fetch": true,
      "js": true,
      "dom": true,
      "cookie": true,
      "storage": true,
      "script": true
    },
    "env": {
      "TRACE_PROFILE": "discover",
      "TRACE_JS_MODE": "boundary",
      "TRACE_QUERY_FIELDS": "h5st,anti_content"
    }
  }
  ```

- Gecko 侧提供统一运行时判断。当前实现为 `FirefoxTraceRuntimeActive()`，并已下沉到
  JS/DOM/XHR/Fetch/Storage/Cookie 的 enabled 入口；ContentChild/ContentParent 仍保留
  IPC 写入前的二次 gate。
- 控制状态按 200ms 缓存刷新；刷新时直接重读小控制文件，避免同秒/同大小修改被 mtime
  判断漏掉。
- start 时写 `trace.control` 事件：
  - `action=start`
  - `enabled_modules`
  - `control_version`
  - `previous_state`
- stop 时写 `trace.control action=stop`。
- manifest 写入初始 trace state、control file path 和控制模式。
- `tools/trace-control.sh` 只改控制文件，不杀浏览器、不改用户 profile。
- Parent 进程通过 `FirefoxTraceRuntimeConfig` IPC 把 control config 推给 content；
  JS trace 已能在同一浏览器进程内从 `boundary` 切到 `target`。
- JSONL 事件写入前注入 `segment_id`、`control_version`、`config_hash`。
- safety：
  - `js_mode=deep` 无 script/function/hash 过滤时拒绝 start；
  - `TRACE_JS_OBJECT_DEPTH>2` 需要 `TRACE_UNSAFE_ALLOW=1`。
- 最新 smoke：`/private/tmp/firefox-trace-runtime-segments-smoke6`，
  `seg_003` 成功出现 `js_mode=target`、`target_match=true` 和 `js.value.store`。

已实现：

- `config_applied` 确认机制已实现：切换配置后 UI/agent 等待 content 收到目标
  `control_version/config_hash`，再提示用户触发目标动作。Parent 的定时推送和 content 初始化
  推送不依赖下一条业务事件。

待补：
- start/config/new-segment 已有独立 `segment_id`；JS segment 切换会重置 event count、
  limit sentinel 和 boundary buffer。后续 viewer/analyzer 仍需按 `segment_id` 做更好的展示。
- 模块级运行时开关：
  - XHR/Fetch/DOM/Cookie/Storage/script 已有入口 gate 或 parent 二次 gate；
  - `FIREFOX_TRACE_JS=0` / `TRACE_JS=0` 已补到 JS trace 入口
    `FirefoxTraceBaseEnabled()`；
  - 该 JS gate 已 build 通过，并用 active smoke 验证：JS 日志不生成，XHR/DOM 仍工作。

验收：

- `[已通过]` 本地 delayed-trigger 测试页：启动 paused 时无 JS/DOM/XHR 事件；
  start 后触发请求能抓到字段和 origin；stop 后继续触发请求不再追加业务 trace。
  - 目录：`/private/tmp/firefox-trace-1785146389-29562`
  - start 后捕获：`xhr.open/send/response`，字段 `anti_content=runtime-control-token-1785146413444`
  - stop 后再次请求：server 收到 `runtime-control-token-1785146465792`，但
    `firefox-xhr-29562.jsonl` 仍为 3 行、`firefox-js-29562.jsonl` 仍为 2 行。
- `[已通过]` JD paused-flow 真实页：paused 阶段完成登录、搜索和跳转不再 crash；
  start 后触发搜索/翻页接口能抓到 h5st 请求字段和完整 boundary summary；
  stop 后结束本段采集。
  - 目录：`/private/tmp/firefox-trace-1785149433-86188`
  - 主请求：`xhr_166` / `pc_search_searchWare`
  - `origin_call_id=call_1446748`
  - `h5st` sha256：`e2e5624564c2f17106c3b702d2abcfd2a27899dfd0d9c595947f13dc1b761d47`
  - `js.boundary.flush_summary complete_window=true`
- `[已通过]` JS 模块启动级关闭 smoke：
  - 目录：`/private/tmp/firefox-trace-js-module-off-active-smoke-1785212600`
  - 启动：`FIREFOX_TRACE_JS=0 --trace-start active`
  - 结果：`firefox-xhr-97195.jsonl` 3 行，抓到
    `anti_content=runtime-control-token-1785210988666`；`firefox-dom-97195.jsonl` 1 行；
    没有生成 `firefox-js-*.jsonl`。
  - 结论：JS base gate 有效；其它开启模块仍可写日志。
- PDD 登录/前置流程：paused 阶段页面不卡；start 后触发 `anti_content` 能抓到 query/body 字段和完整 boundary summary。
- `trace.degraded` 不应因为 paused 阶段历史日志出现。

## P0：运行时配置边界梳理

目标：

- 明确哪些配置只能启动前决定，哪些配置可以运行时修改。
- 避免用户以为所有 env 都能动态生效。

需要补文档/实现：

- 启动前固定：
  - Firefox binary/profile；
  - preset 默认值；
  - deep/object/value_store 上限；
  - JIT/解释器策略；
  - automation surface。
- 可运行时控制：
  - 总开关 enabled；
  - 模块开关；
  - start/stop 标记；
  - 可选的 run segment label。
- 如果后续要支持运行时调整字段，例如 `TRACE_QUERY_FIELDS`，需要单独设计 reload 规则，
  不能靠外部改 env。

## P1：验证和收口

当前已有代码变更较多，继续堆能力前先做验收闭环。

必须验证：

- Gecko build 通过。
- `[已通过]` runtime config ACK：paused headless smoke 中，初始、`config --module js=0`、
  `start` 的 `firefox-control-acks.jsonl` 都出现匹配 `control_version/config_hash` 的 ACK；首个
  目标 XHR 使用 start 后的 revision，JS 模块保持关闭。
- launcher manifest 仍正确记录真实目标 URL，不把 `--marionette` 等控制参数当 URL。
- automation surface：
  - baseline / stock 本地对拍；
  - `navigator.webdriver`、远控 UI、`about:support` 行为符合模式；
  - trace 通道不受影响。
- boundary window：
  - sink 级窗口；
  - 字段级窗口；
  - `complete_window`、`skipped_by_window`、`dropped_before_flush` 正确。
  - `tools/trace_check.py boundary TRACE_DIR` 能验证 flush summary schema。
- source map：
  - `source_map_url` / `source_map_resolved_url` 正确；
  - raw script `raw_size` 和真实文件大小一致；
  - `raw_sha256` 和真实文件 sha256 一致；
  - `tools/fetch_source_maps.py` 能落盘 map。
  - `tools/trace_check.py source-map TRACE_DIR` 能验证 relation 和 raw artifact。
- XHR/Fetch 字段回归：
  - URL query 字段；
  - XHR JSON/form body 字段；
  - Fetch request body 字段。
- Worker suppression：
  - `tests/worker-trace.html` 触发 Worker JS；
  - `tools/trace_check.py worker TRACE_DIR` 必须命中一次显式 suppression。
- 真实页面 smoke：
  - `[已通过]` JD `h5st` 只作为测试样本；
  - PDD `anti_content` 只作为测试样本；
  - 记录是否有 `trace.degraded`，不能只看是否有字段。

最新 JD 二轮 target-values 结论：

- `[已通过]` worker 线程直接 IPC crash 已修，重新 build 后 JD
  `target-values + paused` 启动稳定。
- `[已通过]` JS value_store 已抓到最终 h5st 完整值，并能和 XHR query field
  artifact sha256 对齐。
- `[已通过]` JS value_store metadata 已补齐并通过最新 JD 真实页验证，可以从
  `value_id -> call_id/function/script/arg|return/path` 反查到签名函数返回链。
  最新目录：`/private/tmp/firefox-trace-jd-h5st-target-values-meta-1785151960-86646`。
  主搜索请求 `pc_search_searchWare` 的 XHR h5st sha256
  `7f2917e203c397f6c4ad0f6a52ea7422df0abf28689c75704bdea65856ecb1e4`
  在 JS metadata 中命中 16 条，关键链路包括
  `_$PI.prototype.signSync -> _$PI.prototype._$sdnmd -> _$PI.prototype._$ms -> _$fv/bhikZ/...`，
  且 `signSync` / `_$sdnmd` / `_$ms` return path 均标记为 `h5st`。
- `[已通过]` 最新 metadata 验证轮无 `trace.degraded`、无 limit/hot-function 抑制；
  日志约 16MB，`firefox-js-86646.jsonl` 1036 行，其中 `js.value.store` 1032 行。
- `[已通过]` 已新增可配置短字符串 metadata：
  - `TRACE_JS_VALUE_METADATA=1`
  - `TRACE_JS_VALUE_METADATA_MIN_BYTES=1`
  - `TRACE_JS_VALUE_STORE_MIN_BYTES` 可独立控制完整落盘阈值；未配置时兼容旧的
    `TRACE_JS_DEEP_LONG_STR`。
  - target/deep preset 默认开启 metadata，但短值默认只写
    `stored:false + preview + sha256`，不强制写入 `values/`。
  - 本地 smoke：`/private/tmp/firefox-trace-value-metadata-object-smoke`，
    `makeTraceParts` return 对象里的 `ts/fp/app/token/digest/version/payload`
    都能按 `value_path` 写出短字段 metadata。
- `[已通过]` JD string metadata 复验目录 `/private/tmp/firefox-trace-1785153736-41130`：
  `pc_search_searchWare` h5st 的 10 个分段里，0/1/2/3/4/5/7/8/9
  已有独立 exact 或 digest/source-string 证据；第 6 段是 number 时间戳，
  当前在 call/object preview 中出现，不属于 string metadata。
- `[已通过]` JD primitive metadata 复验目录
  `/private/tmp/firefox-trace-1785161281-80006`：
  `pc_home_feed` h5st 的 10 个分段均有 JS 侧证据；第 6 段 13 位时间戳已由
  `TRACE_JS_PRIMITIVE_METADATA=1` 精确命中 `_$f6` arg0 和
  `_$PI.prototype._$gsp` arg1，`value_type=number`。该轮无
  `trace.degraded` / dropped / truncated 类降级事件。

已实现：

- JS event 发送到 Parent 失败时会回退到本地 JSONL；IPC event budget 丢弃首条会写
  `trace.degraded module=ipc reason=event_budget`，不再静默成功。
- Worker JS trace 不触碰 `PContentChild` IPC；首次 Worker event/value/script artifact 被跳过时
  写 `trace.suppressed reason=worker_thread_ipc_unsupported scope=worker`。专用跨线程 queue
  仍是后续覆盖 Worker 事件本身的扩展项。

必须补：

- bigint metadata 暂未实现；如果后续确实需要真实值字符串，再单独评估低副作用
  转换方式，不能为了 bigint 破坏真实站时序。

交付动作：

- 重新生成 `patches/gecko-firefox-trace.patch`。
- 更新 `patches/gecko-base-commit.txt`。
- 更新 `docs/AGENT_HANDOFF.md` 的“最近验证证据”。
- 轻量 repo commit/push。

## P1：配置可用性和文档减负

问题：

当前能力说明散落在 README、TRACE_PROGRESS、PRODUCT_MANUAL、AGENT_HANDOFF 中，容易重复和过期。

目标：

- `docs/PRODUCT_MANUAL.md` 面向使用者。
- `docs/TODO.md` 只放待办和验收状态。
- `docs/TRACE_PROGRESS.md` 只追加历史进度和验证证据。
- `docs/AGENT_HANDOFF.md` 只放接手必读、路径、命令、当前状态。
- `README.md` 只保留项目定位、快速入口和核心架构。

需要做：

- `[待做]` 把 README 中过长的 Phase 规划压缩，详细路线迁移/引用 `docs/TODO.md`。
- `[已处理]` AGENT_HANDOFF 的“下一步优先级”改为引用 `docs/TODO.md`。
- `[已处理]` PRODUCT_MANUAL 的“当前版本边界”改为引用 `docs/TODO.md`，只保留用户侧说明。

## P2：网络和异步边界

待做：

- `[已实现，待 fixture 回归]` Worker fetch：Worker 线程生成的 Fetch trace event 经 content
  主线程 queue 再送 IPC；不直接触碰 `PContentChild`。`tests/worker-trace.html` 会发起本地
  Fetch，需在持久 Firefox 终端确认 `fetch.call/open/response`。
- keepalive/PFetch。
- 完整 response body artifact。
- WebSocket frame。
- HTTP packet/raw bytes trace。
- 跨进程/跨 frame 请求链进一步统一。

验收：

- 每项都要有本地测试页或真实页面 smoke。
- 每项都要有降载开关和 `trace.degraded` 语义。

## P2：Trace Adapter / Run Store

当前原始 JSONL 可以用，但大日志分析成本高。

待做：

- `[已实现]` JSONL -> SQLite adapter：`tools/trace_store.py import TRACE_DIR` 写入
  `trace-store.sqlite`，索引 event、segment、request/call/origin/value 和制品。
- `[已实现]` 基础 trace query CLI：`field`、`value-sha`、`call`、`request`。
- Run/campaign/segment 跨 run 索引。
- request、origin_call_id、script、value_store、DOM/Cookie/Storage 统一查询。
- 大值、脚本、source map artifact 索引。
- analyzer 改为优先查 Run Store，保留原始 JSONL fallback。
- 通用分段参数归因：
  - 自动从目标字段中按 `;`、`&`、`,`、`|`、`.`、JSON path 拆分；
  - 对每个分段输出 exact / digest(source-string) / contains 三类证据；
  - 标记证据强度，避免把 contains-only 误判成独立生成点；
  - 不写 JD/PDD 专用字段规则。
- primitive metadata：
  - `[已实现]` 可配置地为 number/boolean 写轻量 metadata；
  - `[已实现]` 用于时间戳、开关位这类不会进入 string value_store 的字段；
  - `[已实现]` target/deep preset 默认开启，首轮 discover 不默认开启；
  - `[待做]` bigint 如需真实值字符串，再单独评估低副作用转换方式。
- request -> JS call 自动拼链：
  - 从请求字段 sha256 回连 JS value metadata；
  - 从 `call_id/parent_call_id` 输出候选链；
  - 标注跨脚本链是否因 `early_script_filter` 被剪断。
- trace query CLI：
  - `trace-query field <name>`；
  - `trace-query value-sha <sha>`；
  - `trace-query call <call_id>`；
  - `trace-query split-field <request_id> <field>`。

验收：

- 不遍历原始大日志，也能按字段名取回请求、附近 JS、脚本、value_store 和环境读取窗口。
- 对任意复合字段，不依赖站点专用 analyzer，也能输出分段级候选链和证据强度。

primitive metadata 验收：

- `[已通过]` 本地 smoke 目录 `/private/tmp/firefox-trace-primitive-metadata-smoke`。
- `tests/value-metadata.html` 的 `makeTraceParts` return 对象：
  - `ts_num` 写出 `value_type=number`；
  - `ok` 写出 `value_type=boolean`；
  - 均包含 `stored=false`、`preview`、`sha256`、`call_id`、`value_path`。
- `[已通过]` JD 真实页目录 `/private/tmp/firefox-trace-1785161281-80006`：
  - `js.value.store` 共 8764 条，number 4592、boolean 697；
  - `h5st` 第 6 段时间戳通过 number metadata exact 命中；
  - 无降级事件。

## P3：深度 JS / VM / WASM

只有在请求组包链、target-values 和动态调试仍不足时进入。

待做：

- `[已实现]` opcode window：解释器分发点写 `js.opcode`，含 SpiderMonkey `pc`、
  `op/op_name`、bytecode length、script URL、origin call 和 segment/control 元数据；仅
  `TRACE_EXECUTION_MODE=opcode`、`TRACE_OPCODE=1` 且命中脚本过滤时启用，可加
  `TRACE_OPCODE_PC_RANGE=start:end`，默认每 segment 最多 10,000 条并写
  `trace.degraded reason=opcode_limit`。当前包含原生 JS bytecode、raw operand 和可选
  stack slots；尚不包含虚拟 PC 或 VM step。
- `[已实现]` stack slots / operands：`js.opcode` 记录 raw `operand_bytes_hex`、
  operand format、SpiderMonkey stack depth/uses/defs；`TRACE_OPCODE_STACK_SLOTS=0..8`
  可记录栈顶 slot 类型，`TRACE_OPCODE_STACK_PRIMITIVES=1` 才附带 number/boolean/
  null/undefined 值，字符串和对象不展开。
- `[已实现]` PC window：`js.opcode` 增加 script line/column/bytecode length 身份；
  `tools/trace_opcode_analyzer.py` 按 JSScript 分组，统计 hot PC、branch hits 和固定宽度
  候选窗口，输出下一轮可直接使用的 `TRACE_OPCODE_PC_RANGE=start:end`。
- `[已实现]` function/script tier-pin：opcode 模式的 JIT entry、LoopHead OSR、解释器
  inline callee 和事件写入统一按 script URL + 可选 line/column/bytecode length 判断；仅
  目标 JSScript 强制解释执行，其余脚本保留 JIT。分析器输出 `tier_pin_env` 供下一轮使用。
- `[已实现]` VM dispatcher autodetect：`trace_opcode_analyzer.py` 结合 event/PC 重复度、
  LoopHead、branch、element/property access 和 call hits 为每个 JSScript 输出 heuristic
  `dispatcher_candidate` score/confidence；候选按 score 排序，明确标注 heuristic。
- `[已实现]` jsvmp/vm_step：在已确认的 native dispatcher PC 上输出每轮
  `js.vm_step` 标记；要求 `TRACE_VM_STEP=1`、`TRACE_VM_DISPATCH_PC=PC`，并由
  `TRACE_VM_STEP_LIMIT`（默认 10,000，`0=不限`）独立限额。该事件记录脚本 identity、native
  dispatcher PC、栈深度和 `step_index`；它不是虚拟 opcode / virtual PC 的自动解码。vm 开关、
  dispatcher PC 与 limit 均可热更新，且不受 opcode PC display window 限制。
  opcode 配置可用 paused 启动：解释器在配置存在时每 1,024 条 bytecode 刷新 runtime active
  状态，因此 `trace-control start` 可以开启受限窗口，`stop` 也能在同一上限内生效。
  仅 script identity/tier-pin 仍属于 restart-required；PC window、opcode/vm limit 和 vm 参数
  经 runtime control 生效。
- WASM dump/insn trace。

约束：

- 不允许全站直接 opcode。
- 必须先按脚本、函数、时间窗口或 PC 范围收窄。
- limit/sample 仍只做保险丝，不能作为主策略。

opcode window 验收：

- `[已通过]` Gecko 增量 build：2026-07-28。
- `[已通过]` `tests/opcode-window.html?auto=1` 全窗口 smoke：
  `/private/tmp/firefox-trace-opcode-window-smoke-20260728` 生成 194 条
  `js.opcode`；脚本 URL 全部命中 `opcode-window.html`，事件含
  `GlobalOrEvalDeclInstantiation`、`GetGName`、`Call`、`JumpIfFalse` 等真实
  SpiderMonkey opcode 和完整 segment/control 元数据。
- `[已通过]` PC window smoke：
  `/private/tmp/firefox-trace-opcode-pc-window-smoke-20260728` 使用
  `TRACE_OPCODE_PC_RANGE=10:11`，仅输出 PC `10`、`11`。
- `[已通过]` 上限与日志路由 smoke：
  `/private/tmp/firefox-trace-opcode-limit-routing-smoke-20260728` 使用
  `TRACE_OPCODE_LIMIT=5`，输出 5 条 opcode 后在同一 `firefox-js-*.jsonl`
  写出 `trace.degraded module=opcode reason=opcode_limit`；截图正常生成。
- `[已通过]` 通用 VMP fixture：`tests/vmp-fixtures.html` 覆盖 accumulator、
  register、handler table + virtual stack，以及 4,000 轮高频 dispatcher。
  - `/private/tmp/firefox-trace-vmp-simple-20260728`：255 opcode events；
  - `/private/tmp/firefox-trace-vmp-register-20260728`：469 events；
  - `/private/tmp/firefox-trace-vmp-complex-primitive-20260728`：551 events，
    296 条包含 primitive 栈槽值；
  - `/private/tmp/firefox-trace-vmp-complex-types-20260728`：551 events，primitive
    值为 0；
  - `/private/tmp/firefox-trace-vmp-stress-types-20260728`：128 events 后写
    `opcode_limit`，页面仍输出 `stress:126`。
- `[已通过]` PC window 两轮闭环：
  - discover `/private/tmp/firefox-trace-vmp-pc-discover-20260728`：551 events，按
    line/column/bytecode length 拆成 8 个 JSScript 组；主 dispatcher 为 line 40、
    column 19、bytecode length 401，首选窗口 `278:325` 有 126 次命中；
  - target `/private/tmp/firefox-trace-vmp-pc-target-20260728`：严格输出 126 events，
    单一脚本组，实际 PC `278..322`，77 条含 primitive stack slot，无降级，页面仍输出
    `complex:126`。
- `[已通过]` function/script tier-pin：
  - `/private/tmp/firefox-trace-vmp-tier-pin-valid-20260728` 使用 line 40、column 19、
    bytecode length 401，只输出该 JSScript 的 126 events，PC `278..322`；
  - `/private/tmp/firefox-trace-vmp-tier-pin-invalid-20260728` 使用错误 line 41，opcode
    events 为 0，页面仍输出 `complex:126`；
  - 两轮 headless 均约 3 秒完成，相比未 pin 的约 10 秒 smoke 明显减少运行级解释器干扰。
- `[已通过]` VM dispatcher autodetect 通用性：
  - accumulator VMP：主 dispatcher line 9 排名第一，score 47.12 / medium；
  - register VMP：line 24 排名第一，score 77.93 / medium；
  - handler-table + virtual-stack VMP：line 40 排名第一，score 70.64 / medium；
  - 普通 arithmetic loop 负样本 `/private/tmp/firefox-trace-dispatch-negative-20260728`：
    data-access hits 为 0，confidence 保持 low。
- `[已通过]` vm_step 有头验收：
  - `/private/tmp/firefox-trace-vmp-vm-step-headed-20260728`：complex dispatcher 的
    `PC=278` 产生 7 条 `js.vm_step` 和 126 条 opcode；每条 step 均为 identity
    `(line=40,column=19,bytecode_length=401)`，页面完成 `complex:126`。
  - `/private/tmp/firefox-trace-vmp-vm-step-limit-routed-20260728`：`TRACE_VM_STEP_LIMIT=3`
    时保留 3 条 step，并在 `firefox-js-*.jsonl` 写入一条
    `trace.degraded module=vm_step reason=vm_step_limit`。
- `[已通过]` paused opcode/vm_step 验收：启动 paused 的有头实例在页面加载阶段不写 opcode；
  `trace-control start` 后，单一 JSScript + PC window 的有限窗口可写 opcode/vm_step，
  `stop` 后恢复暂停。该路径用于真实页面的短触发窗口，避免页面加载耗尽 event limit。

## P3：UI / Viewer

已实现：

- `[已实现]` 本地 Web 控制台 v1：`tools/trace-console-server.py`。
- `[已实现]` Agent HTTP API：
  - `GET /api/latest`
  - `GET /api/status?trace_dir=...`
  - `GET /api/summary?trace_dir=...`
  - `POST /api/config`
  - `POST /api/new-segment`
  - `POST /api/start`
  - `POST /api/stop`
  - `POST /api/prewarm`
- `[已实现]` 控制台可改目前主要参数：
  preset、profile、JS mode、script/function/hash filter、target match、query fields、
  module 开关、object/value metadata、limit、自定义 `TRACE_*`。
- `[已实现]` API smoke：`/private/tmp/firefox-trace-console-api-smoke`。

待做：

- run/campaign 管理。
- trace preset 配置模板保存/加载。
- request -> JS -> DOM/Cookie/Storage 时间线。
- value/script/source map artifact 查看。
- 多轮对比和报告导出。

## P4 可选：Firefox Trace 自有 MCP

MCP 放到最后可选，不阻塞第一阶段和第二阶段主线。当前优先级更高的是 runtime
trace start/stop、trace query CLI、验证收口、网络/异步边界和 Run Store。

如果后续要做 MCP，目标不是长期依赖外部 `js-reverse-mcp`，而是做一个配套魔改
Firefox 的自有 MCP，让 agent 能操作同一个 Trace 浏览器、控制 trace 开关、查询日志和
做动态调试。

外部 `js-reverse-mcp` 只作为能力参考，不是最终交付依赖。

定位：

- Firefox Trace 内核：负责魔改 Firefox 采集、落盘、字段/调用/环境证据。
- Firefox Trace 自有 MCP：负责操作同一个魔改 Firefox、控制 trace、查询日志、观察网络、
  搜索脚本、断点调试和 evaluate。
- 外部浏览器操控 MCP：只用于参考功能设计、临时补充验证或对照测试。

可选待做：

- Trace 运行控制：
  - `trace.start_run`：启动魔改 Firefox，传 URL/preset/fields/start mode。
  - `trace.control`：start/stop/status，对接 `TRACE_DIR/trace-control.json`。
  - `trace.stop_run`：关闭本轮浏览器并确认日志 flush。
  - `trace.list_runs`：列出 campaign/run/segment。
- Trace 查询：
  - `trace.query_field`：按字段取请求和候选链。
  - `trace.query_request`：按 request_id/url/字段取请求详情和 origin。
  - `trace.query_call`：按 call_id 取 JS 调用上下文。
  - `trace.open_artifact`：打开 value/script/source map。
  - `trace.suggest_next`：输出下一轮 target-values/deep env。
- 浏览器页面操控：
  - `browser.select_page` / `browser.navigate`；
  - `browser.click` / `browser.type` / `browser.scroll` / `browser.wait`；
  - `browser.screenshot`；
  - `browser.evaluate`；
  - `browser.get_dom_state`；
  - `browser.get_storage` / `browser.get_cookies`。
- 网络/脚本观察：
  - `network.list_requests`；
  - `network.get_request`；
  - `network.get_response_preview`；
  - `network.get_websocket_messages`；
  - `script.list` / `script.search` / `script.get_source`。
- 动态调试：
  - `debugger.set_breakpoint`；
  - `debugger.break_on_xhr` / `debugger.break_on_fetch`；
  - `debugger.get_paused_info`；
  - `debugger.evaluate_in_frame`；
  - `debugger.resume`。
- 设计统一关联 ID：
  - `run_id` / `segment_id`；
  - `page_id` / `frame_id`；
  - `request_id`；
  - `call_id`；
  - `script_url` / `script_sha256`。

推荐闭环：

1. `trace.start_run --trace-start paused` 打开魔改 Firefox。
2. 自有 MCP 或人工完成登录/验证码/滑块。
3. `trace.control start`。
4. 自有 MCP 触发目标动作。
5. `trace.control stop`。
6. `trace.query_field` 读取目标字段链。
7. 如仍缺内部变量，再用自有 MCP 对候选脚本/函数下断点验证。
8. 确认后的脚本 URL/hash/函数名写回下一轮 `target-values` / `deep-causal`。

可选验收：

- Agent 能用本项目自有 MCP 完成“启动 paused -> 用户登录/验证码/滑块 -> start
  -> 触发目标 -> stop -> 查询字段”的闭环。
- MCP 操控的是同一个魔改 Firefox 实例；trace 日志、页面操作、网络观察、断点上下文
  必须能用同一 run_id/page_id/request_id/call_id 关联。
- automation surface baseline 不能关闭 MCP 所需控制通道。
- 用本地测试页验证：打开 paused 浏览器、点击按钮前 start、按钮触发 XHR 后 stop，
  trace 能抓到字段和 `trace.control` 边界。
- 用真实页 smoke 验证：前置登录/滑块阶段不 trace，目标动作阶段 trace，页面不卡死。

## P4 可选：外部浏览器操控 MCP 参考

当前环境可能已有浏览器操控/JS 逆向类 MCP，例如 `js-reverse-mcp`。这类 MCP 不属于
Firefox Trace 内核能力，也不是最终交付目标；它只作为设计参考或临时对照，避免我们
闭门造一个能力残缺的 MCP。

可选待做：

- 对照 `js-reverse-mcp` 或同类 MCP，整理我们自有 MCP 必须具备的能力清单：
  - 页面选择/导航；
  - click/type/scroll/wait；
  - DOM/page state/evaluate；
  - network request/response/initiator；
  - WebSocket frame；
  - script search/source read/source map 辅助；
  - XHR/fetch/source breakpoint；
  - paused frame scope/call stack/evaluate/resume。
- 明确连接边界：
  - 如果外部 MCP 控制的是普通 Chrome/Firefox，而不是魔改 Firefox，同一轮只能用于断点验证，
    不能替代 Firefox Trace 日志证据。
  - 如果临时让外部 MCP 控制魔改 Firefox，需要明确后端协议和目标选择方式，但这不是最终方案。
  - 自有 MCP 应优先支持魔改 Firefox 的稳定连接和 run/page/request/call 关联。

可选验收：

- 产出一份能力对照表：`js-reverse-mcp` 有什么、Firefox Trace 自有 MCP 已有什么、缺什么。
- 不把外部 MCP 当最终依赖写进交付路径。

## 长期原则

- 不写站点专用规则；JD/PDD 只作为验收样本。
- 所有影响覆盖率、日志量、页面时序的策略必须可配置。
- `trace.degraded` 出现后，本轮只能用于候选定位，不能做否定结论。
- 每做完一块内核能力，必须 build 并 smoke，再继续下一块。
- 交付的是工具和使用说明，不是站点专用分析脚本。
