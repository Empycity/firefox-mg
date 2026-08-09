# Agent 读 Firefox Trace 速查指南

本文是给后续 Agent 的简版工作流。完整 UI 和功能说明见 `docs/PRODUCT_MANUAL.md`。本项目是通用 Trace 工具，默认字段只是候选；以用户指定字段和日志事实为准。

模式决策、完整 UI 参数、指纹对象处理和 `agent-next.json` 结构见
`docs/TRACE_MODE_PLAYBOOK.md`。遇到明确缺口时按该表生成配置，不要求用户手填
脚本关键词、PC 或长环境变量。

浏览器能力边界和审计方法见 `docs/BROWSER_RUNTIME_REVIEW.md`。特别是请求回放：
一个目标字段只能绑定同一脚本、同一接口和同一原始请求向量；只替换目标字段，其余
非目标参数、query、headers、cookies、body 和序列化顺序全部沿用原请求。
原始 trace 没有下游请求向量时，不拼手工 payload，也不把该请求的 HTTP 状态写成
算法结论。

## 1. 输入

用户通常会给一个目录：

```text
TRACE_DIR=/path/to/firefox-trace-...
```

先检查：

```text
manifest.json
index/summary.json
index/causal-index.json
index/target-candidates.json
categorized/request-fields.jsonl
categorized/network.jsonl
categorized/js.jsonl
categorized/script.jsonl
categorized/state.jsonl
categorized/dom.jsonl
categorized/bom.jsonl
```

如果 `categorized/` 或 `index/` 缺失，先运行：

```bash
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

## 2. 日志用途

| 分类 | 用途 |
|---|---|
| `request-fields` | 找目标字段、请求位置、raw/decoded SHA-256、完整 artifact、复合字段分段。 |
| `network` | 还原 XHR/Fetch/WebSocket 请求、headers、body、response、`request_id`、`origin_call_id`。 |
| `js` | 还原调用链、producer、args/return/object、`call_id`、`parent_call_id`、`value_store_path`。 |
| `script` | 找脚本 URL/hash/artifact/source map。 |
| `state` | Cookie、localStorage、sessionStorage、IndexedDB 依赖。 |
| `dom` | document、element、canvas、节点和事件依赖。 |
| `bom` | navigator、screen、location、history、performance、crypto 等环境面；全量 trace 会将标量值、实际构造的 WebIDL 对象、原型链和成员 descriptor 汇总进 `index/environment-contract.json`。 |
| `wasm-vm` | WASM module、JS opcode、VM step 线索。 |
| `control-health` | start/stop/config ACK、degraded、boundary window 是否完整。 |

## 3. 标准分析顺序

1. 读 `manifest.json`：确认 URL、plan/preset、启动模式、目标字段、模块开关。
2. 读 `index/summary.json`：看 `degraded_count`、分类计数、目标字段命中数、JS value capture 情况和 `environment_contract` coverage。
3. 读 `index/environment-contract.json`：离线补环境须同时满足 `value_capture_complete=true` 与 `object_contract_complete=true`。`values` 是完整标量制品索引，`objects/members` 是已触达环境对象的 realm、原型链和 descriptor 引用图；任一标记为 false 时仅用于定位缺失宿主依赖。
3. 读 `categorized/request-fields.jsonl`：选目标字段记录，位置可能是 `url.query`、`body`、`headers`、`cookies`；保留 `request_id`、`origin_call_id`、raw/decoded SHA-256、`value_store_path`。
4. 读 `categorized/network.jsonl`：还原完整 URL、headers、cookies、body 和 response；需要完整值就进 `values/`。
5. 读 `index/target-candidates.json`：确认工具推荐脚本、置信度、自动匹配片段、PC range 和 dispatcher 状态。
6. 读 `index/causal-index.json`：查看 `producer_candidates`。`matched` 是强候选，但仍要核对 `call_id/origin_call_id`。
7. `origin_call_id` 只落到请求 wrapper 时，运行 `tools/trace_analyzer.py`，用请求字段 SHA-256 对齐同进程、同 segment、请求前的 JS return；优先父链最深的 exact return，并沿 `parent_call_id` 输出 producer 链。
7. 读 `categorized/js.jsonl`：用 `call_id -> parent_call_id` 回溯局部链，用 `origin_call_id` 和请求关联。
8. 读 `categorized/script.jsonl`、`scripts/`、`web-assets/`、`source_maps/`：定位算法文件。
9. 读 `state/dom/bom`：列出环境和状态依赖。
10. 判断是纯算、补环境，还是混合。
11. 如果缺证据，给出下一轮最窄采集计划，不直接扩大为全站 deep/opcode。

首轮或“一轮回溯”要求 JS Call 使用 `boundary`。`target/deep` 只有在配置中已有 `script_contains`、`function_contains` 或 `script_sha256` 时才是有效精确模式；空候选导致的 target/deep 必须报告为配置问题，桌面中控台会显式回退为 boundary，不能把 `categorized/js.jsonl=0` 当成浏览器未触发。

## 4. 证据等级

| 等级 | 含义 |
|---|---|
| `candidate` | 请求附近或同 origin 的线索。 |
| `correlated` | 有调用上下文、脚本身份或时间窗口关联。 |
| `matched` | JS value 与请求字段 full value 或 SHA-256 对齐。 |
| `confirmed` | 单变量 A/B 证明某环境/state 输入影响输出。 |
| `reproduced` | 本地补环境或纯算输出与浏览器 vector 相等。 |

不要把 `same_origin_context` 单独当 producer 结论。producer 至少需要请求字段 SHA-256 与 JS value SHA-256 对齐，并保留 `request_id/origin_call_id/call_id/script_sha256`。

Agent 自己启动 trace 时显式设置 `TRACE_HEADLESS=0`，确认有头 Firefox
窗口/进程存在；watchdog 完成 stop/finalize 后关闭 Firefox 进程组。只关闭采集
而保留 Agent 启动的浏览器不算任务收尾。

## 5. 复现与验收顺序

优先做固定向量的 diff 级字节还原，再做动态生成：

```text
Trace 请求/响应
 -> 字段和请求结构定位（query/body/headers/cookies）
 -> URL / headers / body 固定输入逐字节 diff
 -> 固定向量本地精确复现
 -> 动态值来源建模
 -> 用用户给的实际 URL 发起动态请求
 -> 响应状态、响应内容和业务成功条件通过
```

先把每个输入分为固定、会话派生和每请求动态三类。固定结构和固定输入必须尽量逐字节一致；trace 中的时间、随机数只用于冻结旧 vector 的诊断，最终请求必须实时生成时间、随机数、nonce、挑战状态和签名字段，不能复用历史值。

### 5.1 未完全对齐时如何验证

历史字段无法 byte diff 对齐不自动等于算法错误：可能是字段本身动态，也可能是 `environment-contract` 尚未包含完整宿主图。此时按下面的验收阶梯推进，并明确报告处于哪一层：

| 层级 | 前提 | 操作 | 通过标准 |
|---|---|---|---|
| Diff vector | 固定输入和值制品齐全 | 对齐 URL、headers、body、Cookie、raw/decoded 字段和 bytes | `trace-align` 为 `aligned` |
| Firefox 页面 | 动态字段或宿主合同不完整 | 本地生成新字段，写入目标页面的同一请求向量 | 发送前后字段 hash 相同，且 HTTP + JSON/业务 payload 均成功 |
| 独立协议客户端 | 页面内验收已通过且交付需要客户端 | 取活动 profile/session 状态，只替换候选字段 | 与页面相同的业务成功条件 |

页面通过、协议客户端失败时，结论是 transport/session 差异，不是直接否定字段算法。客户端 Cookie/state 最小化先以完整会话为通过基线，再做二分子集，最后用新的动态字段复验最小集合和“移除该项后的完整集合”。

## 6. 补环境原则

- 固定环境由 Agent 补：BOM/DOM/state 日志里出现的 `navigator`、`screen`、`document`、`canvas`、`performance`、`crypto`、Cookie、Storage 等。
- 对超过 preview 上限的 DOM 字符串返回值，读取事件的 `value_store_path` 指向的完整 `values/` 制品；`value_preview_truncated=true` 且 `value_stored=false` 时，该环境合同不完整，不能以截断字符串作为离线返回值。
- 动态值交给原网页脚本或原 SDK 生成：时间、随机数、nonce、服务端下发 token、环境摘要、最终签名字段。
- 不整块重写 SDK 的环境采集函数；只补缺失 API 和固定值。
- 本地 host 已执行到明确 `Interface.member`、但当前日志缺少其调用或返回值时，下一轮保持 `TRACE_DOM_MODE=signal`，仅通过 `TRACE_DOM_INTERFACES` 或 `TRACE_DOM_MEMBERS` 追加该实际接口；不因单个 canvas、WebGL 或样式 API 开启全站 DOM。新目录替换不完整证据，不混合旧目录。
- 指纹对象先区分“品牌缺失”和“品牌存在、内部值缺失”。后者保持定向接口/成员，加入 `TRACE_DOM_OBJECT_VALUES=1`：Canvas 必查 `measureText` metrics、`toDataURL` artifact、`getImageData.data`；WebGL 必查 extension 元素、`getParameter` typed vector、precision；Navigator/Plugin 必查 languages、plugins/mimeTypes 的实际条目。不要以空数组、零长度或零向量替代未采值内容。
- 当完整 trace 缺少浏览器内置对象或返回值时，优先复用当前 Firefox 页面：用 DevTools 控制台或 Firefox BiDi/RDP `script.evaluate` 读取目标对象、descriptor、原型链、brand 和指定成员；这个动作不需要重新 trace。结果标记为 `browser-console-observed`，只证明 Firefox 当前页面的真实合同，producer 因果仍以 Trace 为准。
- Chrome/CDP 可用于确认 API 读取路径和调用顺序，最终 Firefox 本地 host 的具体 UA、GPU、canvas、plugin 值只取 Firefox trace、同 profile Firefox 控制台或 Firefox BiDi。
- 检查 `index/environment-contract.json` 的异步账本：`promise_ledger` 以
  `promise_id` 配对调用、初始 `pending`、`fulfilled/rejected` settlement；
  `coverage.async_result_pending` 是停止时仍未履约的数量，
  `async_result_values_captured=false` 时先从同一 Firefox profile/页面取得实际
  履约状态，再进行离线字节对齐判断。停止动作默认给已观察 Promise 一个 250ms
  有界 drain（可通过 `promise_drain_ms` 调到 0-2000ms）。
- `script.resource.raw_sha256` 会按 `url/final_url/original_url` 自动关联到 JS
  调用；候选里的 `script_sha256` 若来自资源 artifact，会同时标记
  `script_hash_source=script.resource.raw_sha256`。这解决了 JS 调用存在、资源 hash
  却分属两条日志流时的空身份问题。
- UA、headers、TLS 指纹、Cookie/Storage、JS runtime 要保持一致。

直接对象 probe、缺失环境报告和“何时才需要下一轮 Trace”见
`skills/firefox-trace-agent/references/environment-repair-playbook.md`；Firefox
启动、Profile 隔离和崩溃恢复见
`skills/firefox-trace-agent/references/firefox-startup.md`。

## 7. 纯算原则

纯算合同必须包含：

```text
函数/脚本版本
输入 JSON
字段顺序
序列化方式
字符编码
hash/crypto primitive
输出编码
浏览器 trace vector
本地复现 vector
```

浏览器读取环境和 Cookie/Storage 的逻辑放在 adapter；核心纯函数只吃显式入参。

Agent 先把“补环境运行原 SDK”“混合 adapter”“纯算函数”三个可行交付路线和证据缺口列出来。只有用户明确选择纯算交付，才开始抽离算法；默认保持当前可验证的补环境/页面运行方案。

## 8. trace health

以下情况只给候选结论：

- `trace.degraded`；
- `js.boundary.flush_summary.complete_window=false`；
- 目标字段缺 value artifact；
- 目标 content process 没有匹配 `config_hash` 的 ACK；
- 目标动作发生在记录开始前；
- VM/opcode/IPC 预算触发。

修复时优先收窄：

```text
字段 -> 自动脚本候选 -> target-values -> deep-causal -> opcode-window
```

## 9. 下一轮 Trace 模式选择

第一轮 `full-chain` 是完整候选产物，不是固定的 discovery 废件。它已包含目标请求、字段 artifact、脚本身份、环境合同和响应证据时，直接进入复现/验收；只有存在明确缺口才重跑。新目录作为最终证据必须独立完整，不能拼接多个目录凑链路。

| 当前缺口 | 启动模式 | 采集计划 / JS 模式 | 需要预填 | 保持关闭 |
|---|---|---|---|---|
| 尚未定位目标请求或脚本 | `active` | `full-chain` / `boundary` | 目标字段位置和名称 | VM/opcode/WASM instruction |
| 需要先登录或准备页面 | `paused` | `full-chain` / `boundary` | 目标字段；准备完成后开始记录 | VM/opcode |
| 请求已找到但 args/return/关键对象缺失 | 同目标动作 | `target-values` 或 full-chain object overlay / `boundary` | 已证实的 script/function/SHA | 全站对象展开、VM/opcode |
| 目标函数内部链路缺失 | 同目标动作 | `deep-causal` | 稳定 script/function/SHA | 无关脚本与 VM step |
| 已证实解释器/VM 且缺局部执行证据 | 同目标动作 | `opcode-window` | 脚本身份和 analyzer 给出的 PC range | VM step，直到 dispatcher 确认 |

Agent 必须写出可见 UI 配置和长环境变量的 `agent-next.json`，并告诉用户加载它后只重复一次相同目标动作。不要让用户手填脚本关键词、PC 或 dispatcher。

## 10. 下一轮采集建议模板

```text
目的：
  确认 FIELD 的 producer / 输入依赖 / VM 窗口

沿用：
  TRACE_DIR:
  campaign_id:
  target URL:
  target action:

UI 设置：
  启动模式: active 或 paused
  采集计划: 全量 trace（默认）或轻量 trace
  Query 字段:
  Body 字段:
  Header 字段:
  Cookie 字段:
  脚本身份: 由 `index/target-candidates.json` 自动推导；长 TRACE_* 和页面配置建议写入 `$TRACE_DIR/agent-next.json`（仅环境变量时可写 `$TRACE_DIR/agent-next.env`）
  函数线索: 由调用链和值匹配自动推导
  JS mode:
  VM/WASM:
    第二轮 target/value 通常选“一轮还原模式”；脚本身份、opcode PC 范围和 dispatcher PC 由工具/Agent 自动推导，用户不填写内部过滤值。
  加载完整配置:
    ② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json
  仅加载 env:
    显示高级 / Agent 配置 -> ⑥ 额外环境变量（高级） -> 加载当前目录 agent-next.env

操作：
  打开 Firefox -> 等 ACK -> 开始记录 -> 执行目标动作一次 -> 停止并整理

成功条件：
  request field SHA-256 与 JS value SHA-256 对齐；
  无相关 degraded；
  保存完整 request/response/value/script artifact。
```



## 11. JSVMP / VM 面板解释

当前 VM 策略改为“一轮回溯优先”：

```text
full-chain 完整候选 -> target-candidates.json 自动找请求/脚本/函数/source 上下文 -> 仅缺对象/value 时生成 `agent-next.json` -> fresh full-chain object-overlay 作为最终目录 -> 必要时才判断局部 opcode/VM step
```

推荐流程：

1. `全量 trace` 默认保留连续 JS/value/网络/环境，VM/WASM 保持关闭。用户只执行一次短目标动作。
2. Agent 先用 request-fields、network、script、js boundary、dom/bom/state 判断目标字段链路。
3. 若已能固定向量字节还原，直接进入补环境或纯算动态化。
4. 若确认存在 VM/解释器证据，再让用户新分段并使用自动候选；脚本关键词、PC range、dispatcher PC 仍由工具/Agent 自动套用。
5. opcode/VM step 是局部补证据，不作为首轮默认采集。重页面先保证目标请求和候选脚本稳定落盘。
6. 不合并多个目录的日志。首轮证据完整就直接使用；只有补跑时，新目录必须独立包含完整调用链、环境、目标请求和值制品，才可用于最终字节 diff 与复现。

Raw HTTP 的定位：它是底层 HTTP channel payload chunk 证据，用于字节 diff、multipart、压缩、charset、边界字符串、逻辑层请求已对齐但响应异常的排查。普通生成链路优先使用 `network/request-fields/values`。

## VMP checkpoint protocol: Agent actions and user reminders

Treat VMP as a staged investigation. The Agent owns evidence analysis and chooses the next stage; the user only performs the short browser action and loads values the Agent has explicitly produced. At every VM stage, tell the user exactly which UI preset to select, which boxes to leave checked/unchecked, whether to load `agent-next.json` (or the env-only compatibility file), what browser action to repeat, and when to stop.

### Gate 0 — decide whether VMP is warranted

Agent reads the request field, producer chain, script identity, `target-candidates.json`, and `wasm-vm` signals first. Remind the user only when there is evidence of an interpreter/VM pattern: encoded instruction/data arrays, a hot loop, opaque dispatch, or a JS opcode cluster. If the target is ordinary JS or WASM, keep the normal route and do not ask for VMP fields.

User reminder template:

```text
现在先不进 opcode/VM。VM/JSVMP 阶段预设选“一轮还原模式（推荐：请求触发回溯）”。
勾选状态：JS opcode 不勾；raw operands 保留默认；栈 slot 类型不勾；栈 primitive 值不勾；VM step 不勾；WASM module 元数据按 Agent 要求开/关；WASM 模块 artifact 不勾；WASM raw bytes 不勾；VM/opcode 也不截断不勾。
操作：打开/开始记录后，只执行一次目标动作；目标请求出现后马上点“停止并整理”。不要手填脚本关键词、PC range 或 dispatcher PC。
```

### Gate 1 — target/value pass before opcode

If the first pass found the request field but the JS/value chain is too noisy or missing, write the next target/value handoff before asking the user to run again:

```text
$TRACE_DIR/agent-next.json
$TRACE_DIR/agent-next.env
```

Prefer `agent-next.json` when any visible UI value changes. It uses schema
`firefox_trace.agent_config.v1` and contains `ui`, `modules`, `options`, `vm`
and `env`, so the user can load every field with one click. Keep
`agent-next.env` as a compatibility file when only environment variables
change. The JSON should contain the Agent-approved `TRACE_PROFILE`,
`TRACE_JS_MODE`, `TRACE_SCRIPT_CONTAINS`, target fields, value capture and
VM-off settings. Prefer script-only narrowing first; add function filters only
when the previous trace proves they are stable.

User reminder template:

```text
我已经把下一轮完整配置写到：$TRACE_DIR/agent-next.json。
UI 操作：在②首轮采集 / 目标字段面板点“加载当前目录 agent-next.json”。
VM/JSVMP 阶段预设仍选“一轮还原模式”。JS opcode、VM step、WASM dump/raw 都不勾。
然后点“应用配置”或重启后“打开 Firefox”；页面准备好后点“开始记录”，只触发同一个目标动作一次，看到目标请求后立刻“停止并整理”。
```

### Gate 2 — local opcode hotspot pass

The tool derives the target script substring from request caller/origin call/value evidence and analyzes `js.opcode` records with `trace_opcode_analyzer.py`. The Agent reviews the exact script identity and candidate `START:END` PC range; the UI/env applies them automatically.

If a hotspot range exists, write or confirm `agent-next.json` with the script identity/PC window and remind the user:

```text
已找到 opcode 热点：SCRIPT_SUBSTRING，PC 范围：START:END。
UI 选择：VM/JSVMP 阶段预设选“局部 opcode：自动候选脚本”。
勾选状态：JS opcode 勾；raw operands 勾；栈 slot 类型先不勾；栈 primitive 值先不勾；VM step 不勾；WASM 相关不勾；VM/opcode 也不截断不勾。
如果我写了 agent-next.json，先加载它。然后执行同一个短目标动作一次；目标请求出现后马上停止整理。
```

If no stable hotspot exists, keep the target/value route and ask for another one-shot action; keep filters in `agent-next.json`, and do not ask the user to invent manual PC values.

### Gate 3 — dispatcher / VM step decision

Agent compares opcode PC, function/script identity, call context and request timing. Only when a native interpreter dispatch loop is evidenced does it report one dispatcher PC. A page-defined virtual PC is not automatically a native dispatcher PC.

If confirmed, write or confirm `agent-next.json` with dispatcher identity and remind the user:

```text
已确认 dispatcher PC：DISPATCH_PC。
UI 选择：VM/JSVMP 阶段预设选“VM step：已确认 dispatcher”。
勾选状态：VM step 勾；JS opcode 按 Agent 提醒开/关；raw operands 按默认；栈 slot 类型/primitive 值只有我要求看 VM 状态时才勾；WASM 相关不勾；VM/opcode 也不截断不勾。
不要自己填写 PC。加载 agent-next.json 后执行同一个短目标动作一次；请求出现后马上停止整理。
```

If not confirmed, stay on `局部 opcode：自动候选脚本`; stack slot/type and primitive capture are follow-up evidence only when the unresolved question is VM state; WASM dump/raw bytes are follow-up evidence only when a WASM module is actually involved.

### Gate 4 — validate and move on

Agent validates `script_sha256`, PC/dispatcher identity, `call_id`, `origin_call_id`, request field SHA-256 and degraded status. Then report one next action only:

- `fixed-byte`: proceed to URL/headers/cookies/body diff;
- `missing-environment`: run a normal browser-environment segment;
- `missing-vm-state`: enable stack slot/type or primitive values for one short action;
- `dynamic`: fixed bytes match, begin dynamic-value generation and live URL response validation.

Always keep JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script modules enabled as context unless the trace is degraded or the Agent identifies a concrete overhead source. VM options are additive, not a replacement for the request and environment evidence.
