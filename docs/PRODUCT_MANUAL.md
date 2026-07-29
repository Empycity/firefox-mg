# Firefox Trace 产品使用手册

版本：当前交付版

本文面向实际使用者，不包含项目历史或站点记录。它按“安装、启动、配置、采集、分析和交付”组织，适用于任意需要浏览器 Trace 的页面流程。

当前交付形态：

- 魔改 Firefox 浏览器；
- 启动器：`tools/run-trace-firefox.sh`；
- Trace 日志：`TRACE_DIR/*.jsonl`；
- 落盘制品：`values/`、`scripts/`、`source_maps/`；
- 离线辅助分析：`tools/trace_analyzer.py`；
- 本地 Web 控制台 / Agent HTTP API：`tools/trace-console-server.py`；
- 静态 Trace Explorer：`viewer/index.html`；
- Gecko patch：`patches/gecko-firefox-trace.patch`。

当前已有本地 Web 控制台 v1。它负责 trace start/stop、segment 切换、preset/filter/value
参数配置和日志摘要。`viewer/index.html` 可作为静态文件直接打开，选择 trace run 目录后离线
查看时间线、segment、request/call 关联事件、已选制品，并导出 filtered JSONL 或 JSON report。

当前也没有本项目自带的 MCP server。仓库里没有 `mcp-server/`、Firefox RDP debugger
adapter、断点工具或 Trace Query MCP 的可运行实现；这些在 README 里属于规划项。
本版 agent 主要通过 shell 启动 Firefox Trace、读取日志和运行 analyzer。

## 1. 总体定位

Firefox Trace 负责“低干扰、可复跑、可落盘”的浏览器内核证据采集。MCP / 动态调试负责“少量、精确、交叉验证”的断点和作用域观察。

| 层 | 负责什么 | 不负责什么 | 典型产物 |
|---|---|---|---|
| Firefox Trace 内核 | 请求、字段、脚本、DOM 环境、Cookie/Storage、JS 调用和值的运行事实 | 不自动猜算法、不替用户完成所有逆向结论 | `firefox-*.jsonl`、`values/`、`scripts/` |
| Launcher | 生成 profile、设置 preset、写 manifest、启动有头浏览器 | 不分析业务逻辑 | `manifest.json` |
| Trace Console | UI/HTTP 控制 `trace-control.json`，切 segment/mode/filter | 不直接操作网页、不做断点调试 | `trace-control.json`、`firefox-control.jsonl` |
| Analyzer | 从日志里找目标字段、候选脚本、候选函数和下一轮建议 | 不替代人工/agent 的最终判断 | 文本报告、`trace-next.env` |
| 外部 MCP 动态调试 | 打开页面、复现操作、断点、查看作用域、运行表达式、抓网络 | 当前项目尚未内置 MCP server | 断点记录、作用域值、实验结论 |

核心原则：

- 首轮先字段和请求，再脚本，再函数，最后才 deep / opcode。
- `trace.degraded` 出现后，本轮只能用于候选定位，不能证明链路不存在。
- 所有会增加时序扰动的能力都要按需开启，例如 response body clone、深层对象 preview、deep 调用树。
- 不写站点专用规则。目标字段由用户或 agent 用 `TRACE_QUERY_FIELDS` 指定。

## 2. Preset 矩阵

| Preset | 何时使用 | 默认打开 | 默认关闭/降载 | 主要产物 | 下一步 |
|---|---|---|---|---|---|
| `discover-light` | 首次进入页面，不知道函数名/hash | XHR、Fetch、DOM signal、Cookie、Storage、script.resource、JS boundary ring buffer | JS args/return/object value 默认不抓，DOM preview 默认轻 | 请求字段、候选脚本、调用边界、环境读取 | 用 analyzer 找候选脚本/函数 |
| `target-return` | 已有候选脚本或函数，要确认返回值 | 目标 JS return、value_store、请求字段 | this/args 关闭，对象 depth=1，非目标函数剪枝 | 目标函数 return、字段值 sha256 | 如果 return 有目标值，进入 target-values |
| `target-values` | 要看目标函数输入依赖 | args/return preview、object preview、value_store | 仍启用脚本/函数过滤和剪枝 | 入参、对象 key/value、长值 artifact | 对齐 Cookie/Storage/环境/API 输入 |
| `deep-causal` | 候选函数确认后，要看局部子调用链 | deep 目标后代、自定义 JS 调用、浅值 | 默认关闭 native/self-hosted 噪声 | 局部调用树、中间 return | 仍看不清再考虑 opcode |
| `opcode-window` | VM/状态机/控制流平坦化场景 | 原生 JS `pc/op`、raw operand、栈深度与可选 slot 类型 | 不适合全站直接开 | opcode 事件 | 必须锁脚本；虚拟 PC/VM step 分阶段推进 |
| `manual` | 完全控制环境变量 | 只按显式配置 | 无 preset 默认 | 自定义 | 特殊配置 |

启动基本格式：

```bash
TRACE_DIR=/private/tmp/firefox-trace-case-$(date +%s) \
TRACE_CAMPAIGN_ID=case-001 \
TRACE_RUN_LABEL=discover \
TRACE_QUERY_FIELDS=sign,signature,token,riskData,fp,nonce,timestamp,captchaId \
tools/run-trace-firefox.sh --trace-preset discover-light 'https://target.example/'
```

## 3. Launcher / Manifest 功能

| 功能 | 作用 | 何时使用 | 关键参数 | 产物 / 判断 |
|---|---|---|---|---|
| 独立 profile | 每轮运行隔离缓存、Cookie、prefs | 每次采集都用 | `PROFILE_DIR`，默认自动生成 | `manifest.json.profile_dir` |
| 独立 trace 目录 | 保存本轮所有日志和制品 | 每轮必须指定或接受默认 | `TRACE_DIR` | `manifest.json.trace_dir` |
| campaign/run label | 多轮同一任务归档 | discover/target/deep 多轮联动 | `TRACE_CAMPAIGN_ID`、`TRACE_RUN_LABEL` | `manifest.json.campaign_id/run_label` |
| 有头/无头 | 当前产品推荐有头 | 正式站点测试用有头 | `TRACE_HEADLESS=0` 默认 | `manifest.json.headless=false` |
| smoke 等待 | 给 headless Firefox 留出落盘窗口 | 自动化验证 | `--trace-wait-seconds N` 或 `TRACE_WAIT_SECONDS=N` | launcher 进程在 N 秒后退出 |
| automation surface | 压平页面可见自动化特征 | 正式站点默认 baseline | `TRACE_AUTOMATION_SURFACE=baseline|stock` | `manifest.json.automation_surface` |
| preset defaults | 快速切换采集强度 | 每轮都应明确 preset | `--trace-preset discover-light` | `manifest.json.preset` |
| runtime trace control | 先完成页面前置操作，目标触发前再采集 | 操作路径较长时 | `--trace-start paused`、`tools/trace-control.sh` | `trace-control.json`、`firefox-control.jsonl` |

`stock` 只用于和 Firefox 原始自动化语义对拍。正式站点不要用 `stock`。

## 4. Runtime Trace Control

目标页面经常需要先完成登录、跳转或其他前置操作。此时不要从浏览器启动就全量 trace，
否则前置动作会污染 boundary buffer。推荐流程是 paused 启动，到目标动作前再 start，目标请求发出后 stop。

```bash
TRACE_QUERY_FIELDS=field_a,field_b \
tools/run-trace-firefox.sh \
  --trace-preset discover-light \
  --trace-start paused \
  'https://target.example/'
```

启动后终端会打印 `TRACE_DIR`，例如：

```text
TRACE_DIR=/private/tmp/firefox-trace-1785146389-29562
TRACE_CONTROL_FILE=/private/tmp/firefox-trace-1785146389-29562/trace-control.json
```

在页面里完成登录/滑块/跳转后，目标按钮或请求触发前执行：

```bash
tools/trace-control.sh /private/tmp/firefox-trace-1785146389-29562 start target-action
```

目标请求触发后执行：

```bash
tools/trace-control.sh /private/tmp/firefox-trace-1785146389-29562 stop after-target
```

查看当前状态：

```bash
tools/trace-control.sh /private/tmp/firefox-trace-1785146389-29562 status
```

控制台的 `/api/status` 会返回 `config_applied`。多 content process 时，`ready=true`
只表示至少一个进程已应用当前配置，不能证明目标页面已就绪。应从目标 XHR/Fetch 事件取
`pid`，并查询 `?target_pid=<pid>`；此时只有该 PID 出现当前 `control.version` 与
`config_hash` 相同的 ACK，`target_ready=true`（也即 `ready=true`）才表示目标页面已经安装
本轮配置。写入 `trace-control.json` 本身不等于配置已经生效。

ACK 推送已在 2026-07-28 的 headless paused smoke 回归通过：初始 paused、`config --module
js=0` 和 `start` 都收到与当前 `version/config_hash` 相同的 ACK；随后首个 XHR 事件带相同的
控制版本/hash，且未生成 JS trace。对关键动作仍应先等待 `/api/status.config_applied` 匹配当前
控制文件，再触发请求。`firefox-control-acks.jsonl` 中的 `trace.config.push` 仅用于诊断发送路径，
以 `trace.config.applied` 为唯一生效凭据。

也可以启动本地控制台：

```bash
tools/trace-console.sh \
  --host 127.0.0.1 \
  --port 8788 \
  --trace-dir "$TRACE_DIR"
```

Python 环境固定使用 `/opt/miniconda3/envs/firefox-trace/bin/python`。
`tools/trace-console.sh`、`tools/trace-analyzer.sh`、`tools/trace-control.sh` 和
`tools/run-trace-firefox.sh` 默认都走这个 conda 环境；如需临时替换，显式设置
`FIREFOX_TRACE_PYTHON=/path/to/python`。

静态 Explorer 不依赖 Python 或 HTTP 服务。直接打开 `viewer/index.html`，选择包含
`firefox-*.jsonl`、`values/`、`scripts/` 的 trace run 目录；选择目录时浏览器会同时加载可用
artifact，未选中的 artifact 在详情面板会显示缺失状态。

打开：

```text
http://127.0.0.1:8788/
```

Agent 可直接调 HTTP API：

```bash
curl -sS "http://127.0.0.1:8788/api/status?trace_dir=$TRACE_DIR&target_pid=<xhr-pid>"
curl -sS http://127.0.0.1:8788/api/summary?trace_dir="$TRACE_DIR"
curl -sS http://127.0.0.1:8788/api/config \
  -H 'content-type: application/json' \
  -d '{"trace_dir":"'"$TRACE_DIR"'","segment":"target","preset":"target-values","options":{"script_contains":"target.js","function_contains":"sign","object_depth":"2"}}'
curl -sS http://127.0.0.1:8788/api/start \
  -H 'content-type: application/json' \
  -d '{"trace_dir":"'"$TRACE_DIR"'","label":"target"}'
```

不重开浏览器切换采集模式：

```bash
tools/trace-control.sh "$TRACE_DIR" config \
  --segment discover \
  --preset discover-light \
  --query-fields field_a,field_b
tools/trace-control.sh "$TRACE_DIR" start discover
# 触发一次目标动作
tools/trace-control.sh "$TRACE_DIR" stop after-discover

tools/trace-control.sh "$TRACE_DIR" new-segment target-values
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --script-contains 'target-script-substring' \
  --function-contains 'candidateFn,anotherFn' \
  --query-fields field_a,field_b \
  --object-depth 2
tools/trace-control.sh "$TRACE_DIR" start target-values
# 再触发一次目标动作
tools/trace-control.sh "$TRACE_DIR" stop after-target
```

每条 JSONL 事件会尽量带上 `segment_id`、`control_version`、`config_hash`。
切换到 target/deep 后，content 进程通过 IPC 接收新配置；控制台/UI 必须确认目标
`control_version` 的 `config_applied` ACK 后再提示触发关键动作。`paused` 后可执行
`config --module ...` 和 `start`，但不能仅依据控制文件已写入。

模式语义：

| 模式 | 行为 | 典型用途 |
|---|---|---|
| `active` | 启动即采集 | 本地页面、短流程、确定不会卡的目标 |
| `paused` | 启动不写业务 trace，也不走主要 trace 重活 | 登录、跳转或其他前置流程 |
| `prewarm` | 预留轻量脚本身份阶段 | 后续扩展；当前不建议作为主流程 |

运行时已可改常用 trace 参数：preset/profile/js-mode、脚本/函数/hash 过滤、query fields、
object/value metadata、limit 和模块开关。仍建议重启浏览器的配置包括 automation surface、
profile prefs、Marionette/RemoteAgent 端口、JIT/tier/opcode 这类底层执行策略。

模块开关说明：

- `js` 对应 `FIREFOX_TRACE_JS` / `TRACE_JS`。启动器默认写入 `FIREFOX_TRACE_JS=1`；
  `trace-control.sh config --module js=0|1` 会同步更新这个内核门控变量，不能只改
  `TRACE_JS_MODE` / `TRACE_PROFILE`；
- `xhr/fetch/dom/cookie/storage/script` 对应各自 `FIREFOX_TRACE_*` 或 `TRACE_*` 开关；
- 关闭某个模块只应停止该模块日志和相关重活，不应阻断其它开启模块。

注意：2026-07-28 最新补丁已把 `js` 模块开关下沉到 JS trace 入口。启动级
`FIREFOX_TRACE_JS=0` 已通过 smoke：XHR/DOM 仍写日志，`firefox-js-*.jsonl` 不生成。
控制台/CLI 的 paused 热切换关闭 JS 已回归：等待 ACK 后首个 XHR 正常写入，且不生成 JS trace。

## 5. 自动化 / 指纹可见面

| 功能 | 解决什么问题 | 当前状态 | 何时使用 | 注意 |
|---|---|---|---|---|
| `navigator.webdriver` baseline | 页面检测自动化时不再直接看到 true | 已实现，默认 baseline 返回 false | 所有正式站点默认使用 | 不关闭 Marionette/RemoteAgent |
| 有头远控提示 UI | 避免窗口顶部显示远程控制提示 | 已实现，baseline 默认隐藏 | 有头实战测试 | `stock` 会保留原始提示 |
| `about:support` RemoteAgent | 避免排障页暴露 RemoteAgent 监听信息 | 已实现，baseline 默认隐藏 | BrowserScan/人工检查 | 只是页面可见面，不关控制通道 |
| Remote Settings 后台噪声 | 降低启动/关闭阶段 chrome 后台请求和 console 噪声 | 已实现 baseline gate | 默认启用 | 不修改网页 UA/language/timezone/WebGL |
| 本地 surface 对拍页 | 检查页面可见自动化/环境面 | 已实现 | 版本验收、回归 | `tests/automation-surface.html` |

## 6. 请求与字段 Trace

| 功能 | 覆盖范围 | 何时开启 | 关键参数 | 看哪里 |
|---|---|---|---|---|
| XHR 生命周期 | `open/send/body/response` 等 | 风控请求走 XHR 时 | `TRACE_XHR_EVENTS=open,send,body,response` | `firefox-xhr-*.jsonl` |
| XHR request body | JSON、form-urlencoded、string 等可观察 body | 字段在 POST body 里时 | `TRACE_XHR_REQUEST_BODY=preview|full`、`TRACE_XHR_REQUEST_BODY_STORE=1` | `xhr.body`、`values/xhr_req_body_*` |
| XHR body 字段抽取 | 从 JSON/form body 抽 `TRACE_QUERY_FIELDS` | 字段在请求体中 | `TRACE_QUERY_FIELDS=field_a,field_b` | `body_fields`、`body_fields_meta` |
| Fetch 生命周期 | `fetch.call/request/response/done/body_chunk` | 请求走 fetch 时 | `TRACE_FETCH_EVENTS=all` | `firefox-fetch-*.jsonl` |
| Fetch request body | clone InternalRequest body，不消费真实请求体 | 字段在 fetch POST body 时 | `TRACE_FETCH_REQUEST_BODY=preview|full`、`TRACE_FETCH_REQUEST_BODY_STORE=1` | `fetch.request`、`values/fetch_req_body_*` |
| Fetch response headers | 看响应状态、headers、redirect | 默认可用 | `TRACE_FETCH_RESPONSE_HEADERS=preview|full` | `fetch.response` |
| Fetch response body preview / artifact | 尝试读取响应 body；完整 clone 可写 artifact | 需要看返回 token/配置时 | `TRACE_FETCH_RESPONSE_BODY=preview|full`、`TRACE_FETCH_RESPONSE_BODY_STORE=1` | `fetch.response`、`fetch.body_chunk`、`values/fetch_body_*` |
| WebSocket logical frame | 成功 send 与接收分发前的帧边界 | 页面使用 WebSocket 时 | `TRACE_WS=1`、`TRACE_WS_PREVIEW_BYTES=512` | `firefox-websocket-*.jsonl`、`websocket.frame` |
| HTTP response raw chunk | parent HTTP channel 已读响应块的 bounded hex | 需要字节级响应证据时 | `TRACE_HTTP_RAW=1`、`TRACE_HTTP_RAW_EVENTS/MAX_BYTES/HEX_BYTES` | `firefox-http-raw-*.jsonl`、`http.raw_chunk` |
| WASM module / byte trace | 成功 WASM compile 的模块身份、可选 dump 和 code-section byte | 页面使用 WASM 时 | `TRACE_WASM=1`、`TRACE_WASM_DUMP=1`、`TRACE_WASM_INSN=1` | `firefox-wasm-*.jsonl`、`wasm.module`、`wasm.insn` |
| URL query 字段抽取 | 从完整 URL 抽目标字段 | 首轮默认使用 | `TRACE_QUERY_FIELDS=sign,token,...` | `query_fields`、`query_fields_meta` |
| 字段 value_store | 请求字段完整落盘并算 sha256 | 要和 JS return/value 对齐时 | `TRACE_QUERY_FIELD_VALUE_STORE=1` | `values/qfv_*`、`sha256` |
| URL 降载 | 长 URL 不全量写日志，但仍抽字段 | URL 巨大或日志爆量 | `TRACE_REQUEST_URL=preview|none` | `url_preview`、字段仍在 |

请求侧判断标准：

- 目标字段在 `query_fields` 或 `body_fields` 中出现；
- `origin_call_id` 能连到 JS boundary / target 事件；
- `value_store_path` 和 `sha256` 可与 JS 侧值对齐；
- body store 文件内容与目标请求实际字段一致。

若 `fetch.response` 的 `body_value_stored=true` 且 `body_value_truncated=false`，对应的
`body_value_store_path` 是完整 clone 制品，`body_sha256` 可用于离线确认。运行
`tools/trace_check.py fetch-body TRACE_DIR` 会验证路径、未截断状态和 SHA-256。

WebSocket 默认关闭。启用后，文本 frame 记录 escape 后的 bounded `preview`，二进制 frame
记录 bounded `preview_hex`，Blob/stream send 只记录 `size` 和
`preview_available=false`。使用 `tools/trace-control.sh TRACE_DIR config --module ws=1`
可在下一个 segment 启用；采集后运行 `tools/trace_check.py websocket TRACE_DIR` 校验输出。

HTTP raw 默认关闭，记录的是 `HttpChannelParent::OnDataAvailable` 已读到的 HTTP
响应块，不是 TCP packet。事件包含 `channel_id`、offset、URL、bounded `payload_hex` 和
`browsing_context_id/top_level_browsing_context_id`；与 XHR/Fetch 的同名 context 标识、URL
及时间联合关联。parent 直接读取当前 `trace-control.json`，所以 `start`、`stop` 和
`config --module http_raw=...` 会影响该模块。

WASM 默认关闭。启用后 `wasm.module` 记录模块 SHA-1、模块/代码段大小、函数数和 bounded
hex preview；`TRACE_WASM_DUMP=1` 在上限内请求落盘 `wasm/<sha1>.wasm`；
`TRACE_WASM_INSN=1` 输出明确标注为 `raw_code_section_byte` 的字节事件，并非已解码的
WASM opcode。模块与字节限额分别为 `TRACE_WASM_MODULE_LIMIT` 和
`TRACE_WASM_INSN_LIMIT`。控制台或 `trace-control.sh TRACE_DIR config --module wasm=1`
可启用模块，`tools/trace_check.py wasm TRACE_DIR` 验证输出结构。

## 7. JS Trace 功能

| 功能 | 适用阶段 | 作用 | 关键参数 | 产物 |
|---|---|---|---|---|
| `boundary` 模式 | 首轮 discover | 只记录轻量调用边界，不抓 args/return | `TRACE_JS_MODE=boundary` | `js.call.enter/return`、`call_id` |
| boundary ring buffer | 首轮 discover | JS 调用先缓存，XHR/fetch/DOM/Cookie/Storage sink 命中后 flush 最近窗口 | `TRACE_JS_BOUNDARY_BUFFER=1` | `js.boundary.flush_summary` |
| sink 级窗口 | 首轮和二轮 | 给不同 sink 不同历史窗口 | `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY=16384` | `window_capacity_source` |
| 字段级窗口 | 目标字段已知 | 给某字段更大窗口 | `TRACE_JS_BOUNDARY_BUFFER_EVENTS_XHR_BODY_FIELD_A=20000` | `reason=xhr.body.field_a` |
| flush 限制 | 降低日志量 | 只让关键 sink 触发 flush | `TRACE_JS_BOUNDARY_FLUSH_ON=xhr.body,fetch.call` | 更少 JS 日志 |
| `target` 模式 | 二轮 | 只抓命中脚本/函数/hash 的 args/return | `TRACE_JS_MODE=target` | `js.call.enter/return` 带 preview |
| `deep` 模式 | 三轮 | 抓目标函数及其后代调用 | `TRACE_JS_MODE=deep` | 局部调用树 |
| 脚本过滤 | 二轮以后 | 降低非目标脚本开销 | `TRACE_SCRIPT_CONTAINS`、`TRACE_SCRIPT_SHA256` | `early_script_filter=true` |
| 函数过滤 | 二轮以后 | 只抓候选函数 | `TRACE_FUNCTION_CONTAINS` | 命中函数事件 |
| 非目标函数剪枝 | 页面保活 | 目标脚本内非目标热函数不维护完整栈 | `TRACE_JS_PRUNE_NON_TARGET_FUNCTIONS=1` | `non_target_function_stack_skipped=true` |
| args/return preview | 目标函数确认 | 看输入输出 | `TRACE_JS_ARGS=preview`、`TRACE_JS_RET=preview` | `data.args`、`data.return` |
| 对象 preview | 看对象内部字段 | 参数是 object/Proxy/嵌套对象时 | `TRACE_JS_OBJECT_DEPTH`、`TRACE_JS_OBJECT_KEYS` | `props` |
| 对象 key 过滤 | 降低 getter/Proxy 副作用 | 只关心少数字段时 | `TRACE_JS_OBJECT_VALUE_KEYS=field_a,field_b` | 未命中 key 写 `value_skipped` |
| JS value_store | 长字符串/对象字段完整值 | 要和请求字段 sha256 对齐时 | `TRACE_JS_VALUE_STORE=1` | `values/<sha256>.txt`、`sha256` |
| JS value metadata | 短字符串字段/对象属性元数据 | 要看分段字段时 | `TRACE_JS_VALUE_METADATA=1` | `js.value.store stored=false`、`preview`、`sha256`、`value_path` |
| JS primitive metadata | number/boolean 轻量元数据 | 时间戳、开关位、数字版本号不进入 string metadata 时 | `TRACE_JS_PRIMITIVE_METADATA=1` | `value_type=number|boolean`、`preview`、`sha256`、`value_path` |
| native/self-hosted | 字符串/数组底层细节 | deep 后仍看不清时 | `TRACE_JS_DEEP_NATIVE=1`、`TRACE_JS_DEEP_SELFHOSTED=1` | 更多子调用 |
| suppression | deep 日志爆量 | 临时压掉高频函数 | `TRACE_JS_DEEP_SUPPRESS_FUNCTIONS='=push,=pop'` | `trace.suppressed` |

Worker 线程不会直接使用 content IPC。Worker JS event、value 或 script artifact 首次被跳过时，
JS 日志会写 `trace.suppressed reason=worker_thread_ipc_unsupported`；该轮不能据此断言 Worker
代码未执行。

JS 侧判断标准：

- `call_id` / `parent_call_id` 能形成候选链；
- 请求事件的 `origin_call_id` 能命中 JS 事件；
- return/args/object value 与请求字段 sha256 一致；
- `complete_window=false` 时只做候选，不做否定结论。

### 7.1 IPC 预算与保活

Trace 事件离开 content process 前受可配置的每秒预算保护。它的目的不是替代脚本/函数
过滤，而是在异常热点、错误的 deep 配置或页面突发行为时，阻止 IPC 队列和磁盘写入继续放大，
从而保护页面响应。

等待用户手动触发且目标脚本本身存在高频调用时，可在 `target-return` / `target-values` 加
`TRACE_JS_TARGET_BOUNDARY_BUFFER=1`。它仍保留 target 的脚本/函数过滤和 return/value_store，
但先将命中事件放入 ring buffer，仅在 `TRACE_JS_BOUNDARY_FLUSH_ON` 的 sink 出现时写出最近窗口。

```bash
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-return \
  --script-contains 'candidate-script.js' \
  --set TRACE_JS_TARGET_BOUNDARY_BUFFER=1 \
  --set TRACE_JS_BOUNDARY_FLUSH_ON=xhr.header,xhr.send
tools/trace-control.sh "$TRACE_DIR" start target-boundary
```

| 参数 | 含义 | preset 默认 |
|---|---|---|
| `TRACE_IPC_MAX_EVENTS_PER_SECOND` | content 到 Parent 的最大事件数/秒 | discover 16000；target-return 10000；target-values 8000；deep 5000 |
| `TRACE_IPC_MAX_BYTES_PER_SECOND` | content 到 Parent 的最大 JSONL 字节数/秒 | 8 MiB |

预算超限时，本秒后续事件会被丢弃，并只写一次
`trace.degraded module=ipc reason=event_budget`。该段日志只能用于候选定位。应先收窄
`TRACE_SCRIPT_SHA256` / `TRACE_FUNCTION_CONTAINS`，降低对象深度和 metadata，再考虑提高预算。
完整长值制品按 SHA-256 去重，同一内容在多次 args/return 出现只保留一份 artifact；每个
`js.value.store` 事件仍保留自己的 `value_id`、调用位置和同一个 `sha256`。

### 7.2 Opcode / VM 窗口

`opcode-window` 用于需要观察解释器 bytecode 的页面逻辑。它记录的是 SpiderMonkey
bytecode 的 `pc`、`op_name`、operand、栈深度与可选栈槽类型，不把这些事件标记为页面
自定义 VM 的虚拟指令。

必须先锁定候选脚本，再启动 opcode：

```bash
TRACE_SCRIPT_CONTAINS='candidate-script.js' \
TRACE_OPCODE_LIMIT=3000 \
TRACE_OPCODE_OPERANDS=1 \
TRACE_OPCODE_STACK_SLOTS=4 \
tools/run-trace-firefox.sh \
  --trace-preset opcode-window \
  'https://target.example/'
```

首轮结束后，用分析器按 JSScript identity、热点 PC、循环和数据访问特征生成收窄建议：

```bash
python3 tools/trace_opcode_analyzer.py "$TRACE_DIR" \
  --script-contains 'candidate-script.js' \
  --width 64 \
  --top-windows 3
```

将输出中的 `TRACE_OPCODE_SCRIPT_LINE`、`TRACE_OPCODE_SCRIPT_COLUMN`、
`TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH` 和 `TRACE_OPCODE_PC_RANGE` 带入下一轮。只有在
分析器给出明确 dispatcher candidate 时才开启 `vm_step`：

```bash
TRACE_SCRIPT_CONTAINS='candidate-script.js' \
TRACE_OPCODE_SCRIPT_LINE=LINE \
TRACE_OPCODE_SCRIPT_COLUMN=COLUMN \
TRACE_OPCODE_SCRIPT_BYTECODE_LENGTH=LENGTH \
TRACE_OPCODE_PC_RANGE=START:END \
TRACE_OPCODE_LIMIT=1500 \
TRACE_VM_STEP=1 \
TRACE_VM_DISPATCH_PC=START \
TRACE_VM_STEP_LIMIT=200 \
tools/run-trace-firefox.sh \
  --trace-preset opcode-window \
  'https://target.example/'
```

检查 `firefox-js-*.jsonl` 中的 `js.opcode` 和 `js.vm_step`：它们的脚本 URL、line、column、
bytecode length 与配置应一致。若出现 `trace.degraded module=opcode` 或
`trace.degraded module=vm_step`，本轮仅用于定位热点，降低窗口或缩短触发路径后再重跑。

### 7.3 分段参数 / 复合签名字段归因

很多风控字段不是单一 hash，而是由多个分段拼成，例如：

```text
part0;part1;part2;part3;part4;...
```

这类字段不要写站点专用解析规则。通用处理流程是：

1. 请求侧先保存完整字段：

   ```bash
   TRACE_QUERY_FIELDS=field_a,field_b
   TRACE_QUERY_FIELD_VALUE_STORE=1
   ```

2. 二轮 target/deep 对候选脚本开启短字符串 metadata：

   ```bash
   TRACE_JS_VALUE_STORE=1
   TRACE_JS_VALUE_METADATA=1
   TRACE_JS_VALUE_METADATA_MIN_BYTES=1
   TRACE_JS_VALUE_STORE_MIN_BYTES=256
   TRACE_JS_OBJECT_DEPTH=2
   TRACE_JS_OBJECT_KEYS=64
   ```

3. 对请求字段完整值做通用拆分：
   - 常见分隔符：`;`、`&`、`,`、`|`、`.`；
   - JSON / form body 按字段路径拆；
   - 高熵长串同时按 sha256 做反查。

4. 对每个分段按三种证据反查 JS：
   - `exact`：JS metadata 的 `preview` 或 value_store 完整值等于该分段；
   - `digest/source-string`：某个 JS 值的 `sha256` 等于该分段，说明该分段是前置材料的 digest；
   - `contains`：该分段只出现在最终串或结果对象里，只能证明组装后存在，不能证明独立生成点。

5. 看 `value_role` 和 `value_path` 判断位置：
   - `value_role=return`：该函数产出了该值；
   - `value_role=arg`：该函数接收/传递该值；
   - `value_path=fp/signStr/tk/[i].value`：对象或数组内部字段路径。

6. 如果某个分段只在 `data.args` / `data.return` 中以 `type=number`、`boolean` 出现，
   开启 `TRACE_JS_PRIMITIVE_METADATA=1` 后会输出同一套 metadata，只是不写文件：
   `stored=false`，并带 `value_type=number|boolean`。

判断强度：

| 证据 | 结论强度 |
|---|---|
| 请求字段 sha256 == JS return sha256 | 强，可以证明目标值由该 JS return 产出或传递 |
| 分段 exact 命中 JS return/arg/object path | 强，可以定位该分段的生成/传递函数 |
| 分段等于某 JS 值 sha256 | 强，可以定位 digest 的输入材料 |
| 分段只 contains 于最终串 | 中，只能说明组装后存在 |
| 只有时间接近、无 sha/exact/origin | 弱，只能作为下一轮候选 |

日志量控制：

- `TRACE_JS_VALUE_METADATA=1` 会显著增加 JS metadata 行数，必须配合脚本/函数/hash 过滤使用；
- `TRACE_JS_PRIMITIVE_METADATA=1` 会把 number/boolean 也纳入 metadata，适合 target/deep，
  不适合首轮全站开启；
- `TRACE_JS_VALUE_STORE_MIN_BYTES` 用来避免短值全部写文件；
- 短值默认 `stored=false`，主日志只写 preview/sha/path，避免 `values/` 爆炸；
- 若出现 `trace.degraded` 或 limit/hot-function 抑制，本轮不能用来证明某个分段“不存在”。

## 8. DOM / 浏览器环境 Trace

| 功能 | 覆盖什么 | 何时使用 | 关键参数 | 注意 |
|---|---|---|---|---|
| DOM signal 模式 | 常见风控环境面 | 首轮默认 | `TRACE_DOM_MODE=signal` | 默认低噪声 |
| DOM all 模式 | 全量 DOM binding get/set/call/construct | 目标环境面不在 signal 内时 | `TRACE_DOM_MODE=all` | 容易爆量 |
| 指定 DOM member | 临时扩展某个属性/方法 | 已知目标读某 API | `TRACE_DOM_MEMBERS=Navigator.userAgent,Document.createElement` | 优先于全量 |
| 指定 DOM interface | 扩展整个接口 | 需要观察某类对象 | `TRACE_DOM_INTERFACES=Navigator,Screen` | 比 member 更重 |
| DOM 事件类型 | 只抓 get/call 等 | 页面卡顿时降载 | `TRACE_DOM_EVENTS=get,call` | `set/construct` 可按需打开 |
| DOM preview | 控制 args/value/page/caller 输出 | 首轮建议 none | `TRACE_DOM_PREVIEW=none|all` | none 仍保留结构和 origin |
| 热点成员保险丝 | 高频 DOM 读写降噪 | 单 API 爆量时 | `TRACE_DOM_HOT_MEMBER_LIMIT`、`TRACE_DOM_HOT_MEMBER_SAMPLE` | 触发后本轮不完整 |

signal 默认覆盖：`Navigator`、`Screen`、窗口尺寸、`Document` 状态、Canvas/WebGL、Crypto/SubtleCrypto、Performance、History、Location、Permissions、RTCPeerConnection 等常见风控读取面。

## 9. Cookie / Storage Trace

| 功能 | 作用 | 何时使用 | 产物 | 注意 |
|---|---|---|---|---|
| `document.cookie` | 记录 JS cookie 读写 | 首轮默认 | `firefox-cookie-*.jsonl` | 可结合 `origin_call_id` 看调用上下文 |
| CookieStore API | 记录现代 CookieStore 访问 | 站点使用 CookieStore 时 | `firefox-cookie-*.jsonl` | 事件来源更接近 JS API |
| HTTP Set-Cookie | 看服务端下发值 | 登录/风控配置下发时 | `firefox-cookie-*.jsonl` | 和请求字段一起分析 |
| CookieStorage lifecycle | delete/overwrite/expired/purge/eviction/removeAll | 排查 Cookie 被覆盖或清理 | `cookie.lifecycle` | 不一定带 JS 调用上下文 |
| localStorage/sessionStorage | 记录 Storage 读写 | 首轮默认 | `firefox-storage-*.jsonl` | 长值完整落盘不是当前主能力 |
| Storage lifecycle | 底层 set/remove/clear 等 | 排查状态变化 | `firefox-storage-*.jsonl` | 结合 JS/DOM 事件判断来源 |

用法：

```bash
FIREFOX_TRACE_COOKIE=1
FIREFOX_TRACE_STORAGE=1
```

页面卡顿或日志爆量时可临时关闭非目标模块：

```bash
FIREFOX_TRACE_COOKIE=0
FIREFOX_TRACE_STORAGE=0
```

## 10. Script / Source Map / Artifact

| 功能 | 作用 | 何时使用 | 关键参数 | 产物 |
|---|---|---|---|---|
| `script.resource` | 记录外部脚本 URL、final URL、content-type、charset、headers、source map | 首轮默认 | `TRACE_SCRIPT_RESOURCE=1` | `firefox-script-*.jsonl` |
| 脚本过滤 | 只记录 web/chrome/all | 默认 web | `TRACE_SCRIPT_RESOURCE_FILTER=web|chrome|all` | 减少 chrome 噪声 |
| raw capture | 缓存脚本原始响应用于 hash/artifact | 要保存脚本正文时 | `TRACE_SCRIPT_RESOURCE_CAPTURE=1` | `raw_sha256` |
| raw store | 写入 `scripts/<sha256>.js` | 需要离线分析脚本时 | `TRACE_SCRIPT_RESOURCE_STORE=1` | `scripts/*.js` |
| 截断建议 | 大脚本超过上限时提示重跑 | raw capture 开启时 | `TRACE_SCRIPT_RESOURCE_MAX_BYTES` | `raw_capture_suggestion` |
| source map 关系 | 输出 source map URL 和绝对 URL | 脚本声明 source map 时 | 默认记录元数据 | `source_map_url`、`source_map_resolved_url` |
| source map 下载工具 | 运行后显式下载 map | 需要映射源码时 | `tools/fetch_source_maps.py "$TRACE_DIR"` | `source_maps/*.map`、`index.jsonl` |

重要约束：

- 浏览器不会后台自动下载 source map，避免改变目标站网络行为。
- source map 工具是运行后显式工具。
- `raw_truncated=true` 时脚本正文不完整，不应拿该 artifact 做完整源码结论。

## 11. Analyzer 能力

| 功能 | 作用 | 何时使用 | 命令 |
|---|---|---|---|
| generic 字段发现 | 从日志里找常见 sign/token/risk/fp 等字段 | 首轮结束后 | `python3 tools/trace_analyzer.py "$TRACE_DIR" --preset generic` |
| 指定字段发现 | 找目标字段 | 字段已知 | `python3 tools/trace_analyzer.py "$TRACE_DIR" --preset none --field field_a` |
| 高熵值提示 | 从 URL/body/value_store 中找疑似 token/sign | 没有明确字段名时 | `--preset generic` |
| origin call chain | 从请求回连 JS 调用 | 请求事件带 `origin_call_id` 时 | 默认输出 |
| 邻近 JS 调用 | 没有精确 origin 时做时间窗口候选 | 旧事件或缺口场景 | `--nearby-window-us 500000` |
| 二轮 env 建议 | 生成下一轮候选配置 | 首轮后 | `--write-next-env` |
| JSON 输出 | 给其他 agent / UI 消费 | 自动化处理 | `--json` |

Analyzer 的输出是候选和建议，不是最终证明。最终结论应回到 Trace 事件、sha256、脚本 hash 和源码位置。

## 12. MCP 状态

当前版本不包含 MCP。Firefox Trace 的 launcher、运行时控制、日志、制品、Analyzer 和 Viewer 都可独立使用。

## 13. 功能组合策略

| 目标 | 推荐组合 | 不建议 |
|---|---|---|
| 第一次采集页面 | `discover-light` + `TRACE_QUERY_FIELDS` + XHR/Fetch body preview | 直接 deep 全站 |
| 字段在 POST body | XHR/Fetch request body preview/store + body_fields | 只看 URL query |
| 要证明 JS 值进入请求字段 | 请求字段 value_store + JS value_store + sha256 对齐 | 只靠时间接近 |
| 页面卡顿 | DOM preview none、JS capture values off、只开关键 flush sink | 加大所有 preview |
| 目标函数已知 | `target-return`，先 return-only | 直接开 args/object 深层 |
| 目标参数是对象 | `target-values` + `TRACE_JS_OBJECT_VALUE_KEYS` | 全对象无限展开 |
| 候选函数太大 | `deep-causal` + suppression | 全站 native/self-hosted |
| 脚本压缩混淆但有 source map | script raw store + source map 工具 | 浏览器后台自动取 map |
| 怀疑自建 VM | 先 target/deep 确认，再 opcode-window | 首轮 opcode 全站跑 |
| 需要前后对比 | 使用相同配置保留两轮 `TRACE_DIR` | 只改浏览器默认值后下结论 |

## 14. 首轮采集模板

```bash
RUN_ID=run-$(date +%Y%m%d-%H%M%S)
TRACE_DIR=/private/tmp/firefox-trace-$RUN_ID \
TRACE_CAMPAIGN_ID=$RUN_ID \
TRACE_RUN_LABEL=discover \
TRACE_QUERY_FIELDS=sign,signature,token,riskData,fp,nonce,timestamp,captchaId \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
TRACE_FETCH_REQUEST_BODY=preview \
TRACE_FETCH_REQUEST_BODY_STORE=1 \
TRACE_JS_BOUNDARY_FLUSH_ON=xhr.body,fetch.call,xhr.send \
tools/run-trace-firefox.sh --trace-preset discover-light 'https://target.example/'
```

操作要求：

1. 正常完成页面操作路径。
2. 等目标请求发出。
3. 关闭浏览器。
4. 保存整个 `TRACE_DIR`。

首轮查看：

```bash
python3 tools/trace_analyzer.py "$TRACE_DIR" --preset generic
grep -h '"query_fields"' "$TRACE_DIR"/firefox-xhr-*.jsonl "$TRACE_DIR"/firefox-fetch-*.jsonl
grep -h '"body_fields"' "$TRACE_DIR"/firefox-xhr-*.jsonl "$TRACE_DIR"/firefox-fetch-*.jsonl
grep -h '"trace.degraded"' "$TRACE_DIR"/*.jsonl
```

## 15. 收窄采集模板

确认 return：

```bash
TRACE_DIR=/private/tmp/firefox-trace-$RUN_ID-target-return \
TRACE_CAMPAIGN_ID=$RUN_ID \
TRACE_RUN_LABEL=target-return \
TRACE_QUERY_FIELDS=sign,signature,token,riskData,fp,nonce,timestamp,captchaId \
TRACE_SCRIPT_CONTAINS='候选脚本URL片段' \
TRACE_FUNCTION_CONTAINS='候选函数名片段' \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
tools/run-trace-firefox.sh --trace-preset target-return 'https://target.example/'
```

看输入依赖：

```bash
TRACE_DIR=/private/tmp/firefox-trace-$RUN_ID-target-values \
TRACE_CAMPAIGN_ID=$RUN_ID \
TRACE_RUN_LABEL=target-values \
TRACE_QUERY_FIELDS=sign,signature,token,riskData,fp,nonce,timestamp,captchaId \
TRACE_SCRIPT_CONTAINS='候选脚本URL片段' \
TRACE_FUNCTION_CONTAINS='候选函数名片段' \
TRACE_JS_OBJECT_VALUE_KEYS=field_a,field_b \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
tools/run-trace-firefox.sh --trace-preset target-values 'https://target.example/'
```

## 16. 运行包要求

每个采集任务至少保留：

| 材料 | 说明 |
|---|---|
| `TRACE_DIR` 完整目录 | 必须包含 `manifest.json` 和所有 jsonl/artifact |
| 目标页面 URL | 写清入口页面 |
| 操作路径 | 从打开页面到目标请求发出的步骤 |
| 目标字段 | 写清需要关联的字段名 |
| 多轮目录 | 同一 `TRACE_CAMPAIGN_ID` 下 discover/target/deep 都要保留 |
| degraded 状态 | 是否出现 `trace.degraded`，出现在哪个模块 |

打包：

```bash
tar -czf "$RUN_ID-trace.tar.gz" -C "$(dirname "$TRACE_DIR")" "$(basename "$TRACE_DIR")"
```

## 17. 当前版本说明

完整待做清单见 [TODO.md](TODO.md)。本节只保留用户侧边界，避免产品手册变成开发排期。

当前交付已包含：

- 有头 baseline 自动化可见面；
- XHR/Fetch URL 字段和 request body 字段；
- Fetch response headers 和 bounded response body preview/chunk；
- Cookie、Storage、DOM signal；
- JS boundary ring buffer、sink/字段级窗口、flush summary；
- target/deep JS args/return/object/value_store；
- script.resource、脚本 hash、raw artifact、source map 关系；
- 运行后 source map 显式下载工具；
- analyzer 首轮候选和二轮 env 建议；
- runtime start/stop、segment 与模块控制；
- Worker Fetch、WebSocket logical frame、HTTP raw、WASM module/byte trace；
- run/campaign 管理、静态 viewer、制品预览和导出；
- opcode window、dispatcher candidate 分析与受限 vm_step。

当前版本不包含 MCP。可选能力的后续拆分以 [TODO.md](TODO.md) 为准。
