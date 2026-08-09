# Trace 模式与补环境 Playbook

本文是 Agent 生成 `agent-next.json` 和用户运行桌面 UI 的共同准则。每个最终目录必须单独包含初始化、目标请求、脚本、环境合同和值制品；不要拼接多个目录来证明最终结论。

## 1. 先选模式

| 观察到的事实 | 启动方式 | UI 计划 / JS Call | 要填写的字段 | 保持关闭 |
|---|---|---|---|---|
| 目标请求或脚本未知，加载期可能生成字段 | `active` | `full-chain` + `boundary` | 字段所在 Query/Body/Header/Cookie | VM、WASM、Raw HTTP |
| 先登录、验证码、跳页，目标动作可重复 | `paused` | `full-chain` + `boundary` | 同上 | VM、WASM、Raw HTTP |
| 页面很重，只需先找请求、脚本和字段位置 | `active` 或 `paused` | `discover-light` + `boundary` | 同上 | 深对象、VM、WASM、Raw HTTP |
| 请求已存在，JS 参数/返回值在 producer 附近缺失 | 沿用原启动时机 | `full-chain` + `boundary`，定向 scalar/value overlay | 已证实脚本/函数/SHA 与字段 | JS 对象属性展开、VM、全站深对象 |
| 本地 host 缺一个明确 DOM/BOM API 或返回值 | 沿用原启动时机 | `full-chain` + `boundary`，定向 DOM overlay | 目标字段和 `Interface.member` | 全站 DOM、VM |
| 逻辑请求已对齐，仍需检查 multipart/压缩/编码/原始 chunk | 短动作 | `full-chain` + `boundary` + Raw HTTP | 同一目标字段 | VM、对象扩展 |
| 已证实 JSVMP，需保留目标请求前完整执行窗口 | 短动作 | `vm-window` + 普通请求/boundary 锚点 | 脚本身份、目标字段；PC range 可选 | 逐条 opcode JSON、VM step、WASM |
| 已证实本地解释器/JSVMP，缺局部 bytecode 事实 | 短动作 | `opcode-window` | Agent 给出的脚本身份和 PC 范围 | VM step、栈 primitive |
| dispatcher PC 已被上一轮确认 | 短动作 | `VM step` | Agent 写入的 dispatcher PC | 全站 opcode、WASM dump |
| 已证实目标进入 WASM | 短动作 | WASM module metadata | 脚本/模块身份 | WASM artifact/raw bytes，直到需要 |

首轮和“想一轮拿全链路”的情况始终选 `boundary`。`target`、`deep` 只有 `script_contains`、`function_contains` 或 `script_sha256` 至少一个已经由日志确认时才可用；身份为空时必须回退 `boundary`，不能把 JS=0 解读为未执行。

### 当前 runtime 的对象展开限制

当前 Gecko Trace 的 JS 对象预览会在 `writeObjectProps()` 中调用
`JS_GetPropertyById()`。属性是 scripted getter 时，该调用会再次进入
`AutoFirefoxTraceJSCall`；若脚本/函数/SHA 身份同时使
`object_target_match=true`，递归对象预览可造成 content process 栈溢出。

- `agent-next.json` 一旦填写 `script_contains`、`function_contains` 或
  `script_sha256`，必须设置 `object_depth=0`、`TRACE_JS_OBJECT_DEPTH=0`。
- 需要的标量、字符串、TypedArray metadata/value store 继续保留；明确的浏览器对象值
  使用 `TRACE_DOM_MEMBERS` + `TRACE_DOM_OBJECT_VALUES=1` 定向采集。
- 只有 Gecko 已加入 thread-local preview 重入保护，并通过 getter-bearing object
  回归用例后，才恢复 `object_depth=1`。
- 崩溃 dump 若循环出现 `writeObjectProps -> JS_GetPropertyById -> js::CallGetter ->
  AutoFirefoxTraceJSCall`，按源码重入缺陷处理，不按日志量或目标字段数量推断。

## 2. UI 参数清单

### 2.1 会话与目标字段

| UI 字段 | 填写规则 |
|---|---|
| 目标 URL | 本次实际会打开的完整 URL。 |
| 输出目录 | 新目录；仅在同一流程的连续 segment 才复用。 |
| Firefox binary | Trace runtime 的 `Nightly.app/.../firefox`。 |
| Profile directory | 需要保留登录/挑战状态时填固定 profile；要求新环境时填新 profile。 |
| 启动模式 | 需要捕获加载初始化选 active；准备完成后再抓目标动作选 paused。 |
| Query/Body/Header/Cookie | 只在真实位置填写字段名；其他位置填 `__disabled__` 并关闭对应 scope。 |
| 采集计划 | 默认 `full-chain`；只有首轮页面负载明确过高时才用 `discover-light`。 |
| 强度 | 默认“通用完整值落盘”；短窗口、确认需要更深 JS 值时用高保真；不要为 DOM 指纹直接提高全局对象深度。 |
| VM 阶段 | 普通 JS/补环境选“默认关闭 VM”；确认 JSVM 后优先选择 VM window，只有局部缺口再开 opcode/VM step。 |

### 2.2 模块

`full-chain` 默认保留：JS、XHR、Fetch、DOM/BOM、Cookie、Storage、Script artifact、WebSocket；
`discover-light` 关闭 WebSocket 以降低首轮负载。

`Raw HTTP` 只在逻辑层请求已经定位但需要查二进制 body、边界、编码或 chunk 时开启。WASM 模块、artifact、raw bytes 与 VM 不属于普通补环境默认项。

### 2.3 JS Call / 值采集

| 参数 | 首轮 / 一轮完整证据 | 定向 producer / object overlay | 含义 |
|---|---:|---:|---|
| JS mode | `boundary` | `boundary` | 保留完整请求关联上下文。 |
| script/function/SHA | 留空 | 只填日志证实身份 | 空身份不使用 target/deep。 |
| Target match | `all` | `all` | 目标字段多位置时仍保留全部命中。 |
| object depth | `0` | `0` | 当前 runtime 禁止与脚本/函数/SHA 身份组合使用正深度；避免 getter 重入 JS Trace。 |
| object keys | `0` | `0` | depth=0 时不读取对象属性；明确 DOM/BOM 值走定向 DOM overlay。 |
| array items | `0` | `0` | depth=0 时不递归展开数组；TypedArray metadata/value store 仍可独立保留。 |
| TypedArray bytes | `0` | `0` | full-chain 不按字节数裁切 TypedArray/ArrayBuffer/DataView；轻量或定向模式才填写正数预览上限。 |
| value / primitive metadata | `1` | `1` | 保留 SHA、路径、类型和调用关联。 |
| value store min bytes | `1` | `1` | 短字符串、时间和标志值也保留制品，便于逐字节对齐。 |
| value store max bytes | `0` | `0` | 不按 Trace 层长度丢弃制品。 |
| deferred value capture | `1` | `1` | 异步批量落盘，避免 JS 热路径同步写文件；池满会写 health 缺口。 |
| deferred pool bytes | `67108864` | `67108864` 或日志证明后提高 | 满时写 degradation，不能静默忽略。 |
| boundary window events | `8192` | 按目标 sink 定向调整 | 只影响回刷窗口，不等于普通 JS 总数保险丝。 |
| event fuse | full-chain=`0` | light=`50000` 或显式预算 | `0` 表示不以普通 JS 总数截断；命中非零预算必须写入 health/degraded 证据。 |

### 2.4 VM / WASM

| 阶段 | VM window | JS opcode | raw operands | 栈 primitive | VM step | WASM module/artifact/raw |
|---|---:|---:|---:|---:|---:|---:|
| 默认关闭 VM | 关 | 关 | 关 | 关 | 关 | 全关 |
| 一轮还原 | 关 | 关 | 关 | 关 | 关 | 全关 |
| VM window | 开，默认 65536 条 | 关 | 二进制 operand | top-2 primitive | 关 | 全关 |
| 局部 opcode | 关 | 开 | 开 | 按缺口开启 | 关 | 全关 |
| VM step dispatcher | 关 | 关 | 关 | 按缺口开启 | 开 | 全关 |
| WASM 元数据 | 关 | 关 | 关 | 关 | 关 | 仅 module 开 |

安全参数默认：opcode limit `4096`、opcode execution `65536`、VM step `2048`、opcode `2000 events/s`、opcode `4194304 bytes/s`。这些只属于 VM/opcode 细粒度模式。普通 full-chain 的 IPC 为 `0`（不按每秒事件/字节数丢弃），DOM/BOM、JS value、Fetch/XHR body/header、script raw 也不设 trace-side 截断；`0` 表示不截断。`VM/opcode 也不截断` 只用于已锁定脚本的一次短操作。

VM window 每条固定 `80` bytes，默认 `65536` 条约 `5 MiB/目标线程`。热路径
不生成 JSON、不逐条 IPC；配置的 query/body/header/cookie 字段命中后冻结为
`firefox-vm-window-*.bin`。binary 由 sandboxed content 一次发送给 parent
落盘；每个 segment 只接受首次成功目标触发。普通请求、Cookie、script 和
boundary 锚点保留。

Agent 配置已经写入脚本 token、line/column、bytecode length 或 PC range 时，这些显式身份在新输出目录中仍然生效；`target-candidates.json` 只用于补全空白字段，不会覆盖一份完整的 Agent handoff。局部 opcode 需要中间数值时，再在同一脚本/PC 窗口打开 stack slots/primitive；不要把栈采集扩展到全站。

## 3. 补环境证据优先级

1. 同一最终 trace 中的完整 scalar/long-value artifact。
2. 同一 Firefox profile 和页面通过 Firefox DevTools 控制台或 Firefox BiDi 读取的实际值。
3. 前一轮已证明稳定、且 browser/profile/页面版本一致的 Firefox 值。
4. Node trace/Hook 只用于补充访问路径和异常；它不替代 Firefox 返回值。

完整 trace 缺少一个浏览器内置对象或其返回值时，优先复用当前 Firefox 页面执行
定向 console/BiDi probe，保存 descriptor、原型链、brand、选定成员和完整值；这个
动作不需要重新 trace。`{}`、`[]`、长度 0、零向量只可作为标记“存在性探针”的
临时诊断结果，不能进入最终补环境或请求验证。

不要把对象品牌当作其字段值。`null`、`[]`、`{}`、长度 0、零向量和占位 cookie 都不是“已补环境”。每项记录其来源：`trace event`、`values/`、Firefox BiDi、稳定复用或试探。

动态输入不冻结为最终运行值：时间、随机数、nonce、挑战 response、会话 token 和最终签名必须在本次请求运行时生成。历史值只可用于固定 vector 的诊断。

## 4. 指纹对象专项处理

这些对象优先检查 `categorized/dom.jsonl`、`categorized/bom.jsonl` 和 `index/environment-contract.json`：

| 对象 | 必查内容 | 缺口时生成的定向配置 |
|---|---|---|
| Canvas 2D | `measureText` 每次返回的 width/bbox；`toDataURL` 完整 artifact；`getImageData` 的 width/height/data 字节 | `TRACE_DOM_MODE=signal`、interfaces=`CanvasRenderingContext2D,HTMLCanvasElement`、members=`HTMLCanvasElement.getContext,HTMLCanvasElement.toDataURL`、`TRACE_DOM_OBJECT_VALUES=1` |
| WebGL/WebGL2 | `getSupportedExtensions` 元素；`getParameter` 标量和 typed vectors；precision 的 range/precision | interfaces=`WebGL2RenderingContext,HTMLCanvasElement`，members=`HTMLCanvasElement.getContext`，`TRACE_DOM_OBJECT_VALUES=1` |
| Navigator/Plugin | UA/language/languages、plugins/mimeTypes 的 length、每个 name/filename/description/type | interfaces=`Navigator`，按实际缺口补 live Firefox 值；不要把 plugins 伪造为长度 0。 |
| Screen/Viewport/Document | 尺寸、颜色深度、location、readyState、visibility、元素 bbox/样式 | interfaces=`Screen,Window,Document,Element,HTMLElement`，members 仅列 local host 缺失项。 |
| Performance/crypto | timeOrigin、navigation timing、entries、Promise 履约结果、随机/时间调用 | 保留 JS/value spool；异步结果未捕获时从同 profile 页面获得履约状态。 |
| Cookie/Storage | request 前最后 snapshot、读写顺序、服务端下发 token | Cookie/Storage 模块保持开；完整 request replay 只替换目标字段。 |

`TRACE_DOM_OBJECT_VALUES=1` 不是通用递归深度：它只对已命中的安全白名单结果记录有限的 scalar、数组/TypedArray 元素和关键嵌套值，避免 getter 遍历和全站 DOM 造成卡顿。Canvas/WebGL 的内容缺口优先用它，不提高全局 `object_depth`。

Chrome/CDP 的断点或方法包装可用于确认“哪个 API、哪次调用、读取顺序”，但不能把 Chrome UA、GPU、canvas 像素或 plugin 值写入 Firefox 本地 host。最终值来自 Firefox trace、同 profile Firefox 控制台或 Firefox BiDi。

详细 probe、缺失环境报告和“何时才需要下一轮 trace”见
`skills/firefox-trace-agent/references/environment-repair-playbook.md`。

## 5. Agent 生成配置文件

只要下一轮改变任何可见 UI 字段，Agent 在当前工作目录或用户约定项目目录写完整 `agent-next.json`，并报告绝对路径。只改环境变量时才写 `agent-next.env`。JSON 至少包含：

```json
{
  "schema": "firefox_trace.agent_config.v1",
  "kind": "agent-next",
  "version": 1,
  "ui": {"url": "TARGET_URL", "trace_dir": "", "profile_dir": "", "label": "PURPOSE", "plan": "full-chain", "preset": "full-chain", "trace_start": "active", "query_fields": "__disabled__", "body_fields": "TARGET_FIELD", "header_fields": "__disabled__", "cookie_fields": "__disabled__", "field_scopes": {"query": false, "body": true, "header": false, "cookie": false}, "intensity_key": "auto", "unlimited_trace": true, "show_advanced": true, "vm_stage": "默认关闭 VM（普通 full-chain）"},
  "modules": {"js": true, "xhr": true, "fetch": true, "dom": true, "cookie": true, "storage": true, "script": true, "ws": true, "http_raw": false, "wasm": false},
  "options": {"js_mode": "boundary", "script_contains": "", "script_sha256": "", "function_contains": "", "target_match": "all", "object_depth": "0", "object_keys": "0", "array_items": "0", "typed_array_bytes": "128", "value_metadata": "1", "primitive_metadata": "1", "value_store_min_bytes": "1", "value_store_max_bytes": "0", "limit_events": "0"},
  "vm": {"opcode": false, "opcode_operands": false, "opcode_stack": false, "opcode_stack_primitives": false, "vm_step": false, "wasm_module": false, "wasm_dump": false, "wasm_insn": false, "unlimited": false},
  "env": {"TRACE_JS_FULL_SPOOL": "1", "TRACE_JS_CAPTURE_VALUES": "1", "TRACE_JS_VALUE_STORE": "1", "TRACE_DOM_MODE": "signal", "TRACE_DOM_OBJECT_VALUES": "1", "TRACE_WASM": "0"}
}
```

字段 location、profile、脚本身份、对象深度和 `env` 必须按本轮缺口覆写，示例不是盲目默认值。用户操作只需：加载完整配置 -> 应用配置 -> 打开 Firefox/开始记录 -> 重复一次短目标动作 -> 请求发出后停止并整理。

## 6. 验收与下一步

先验证 `firefox-control-acks.jsonl` 有匹配 `config_hash` 的 `trace.config.applied`，再检查 `trace.degraded`、boundary `complete_window` 和目标字段 value artifact。固定输入齐全时用 `trace-align` 做 URL、headers、Cookie、body、raw/decoded field 的字节 diff。动态字段或 host 合同尚未齐全时，先在同一 Firefox profile/page 验证生成值确实进入发出的请求，再验证 response 的 JSON/业务语义。HTTP 200 本身不是完成条件。
