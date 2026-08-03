# Agent 读 Firefox Trace 速查指南

本文是给后续 Agent 的简版工作流。完整 UI 和功能说明见 `docs/PRODUCT_MANUAL.md`。本项目是通用 Trace 工具，默认字段只是候选；以用户指定字段和日志事实为准。

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
| `bom` | navigator、screen、location、history、performance、crypto 等环境面。 |
| `wasm-vm` | WASM module、JS opcode、VM step 线索。 |
| `control-health` | start/stop/config ACK、degraded、boundary window 是否完整。 |

## 3. 标准分析顺序

1. 读 `manifest.json`：确认 URL、plan/preset、启动模式、目标字段、模块开关。
2. 读 `index/summary.json`：看 `degraded_count`、分类计数、目标字段命中数、JS value capture 情况。
3. 读 `categorized/request-fields.jsonl`：选目标字段记录，位置可能是 `url.query`、`body`、`headers`、`cookies`；保留 `request_id`、`origin_call_id`、raw/decoded SHA-256、`value_store_path`。
4. 读 `categorized/network.jsonl`：还原完整 URL、headers、cookies、body 和 response；需要完整值就进 `values/`。
5. 读 `index/target-candidates.json`：确认工具推荐脚本、置信度、自动匹配片段、PC range 和 dispatcher 状态。
6. 读 `index/causal-index.json`：查看 `producer_candidates`。`matched` 是强候选，但仍要核对 `call_id/origin_call_id`。
7. 读 `categorized/js.jsonl`：用 `call_id -> parent_call_id` 回溯局部链，用 `origin_call_id` 和请求关联。
8. 读 `categorized/script.jsonl`、`scripts/`、`web-assets/`、`source_maps/`：定位算法文件。
9. 读 `state/dom/bom`：列出环境和状态依赖。
10. 判断是纯算、补环境，还是混合。
11. 如果缺证据，给出下一轮最窄采集计划，不直接扩大为全站 deep/opcode。

## 4. 证据等级

| 等级 | 含义 |
|---|---|
| `candidate` | 请求附近或同 origin 的线索。 |
| `correlated` | 有调用上下文、脚本身份或时间窗口关联。 |
| `matched` | JS value 与请求字段 full value 或 SHA-256 对齐。 |
| `confirmed` | 单变量 A/B 证明某环境/state 输入影响输出。 |
| `reproduced` | 本地补环境或纯算输出与浏览器 vector 相等。 |

不要把 `same_origin_context` 单独当 producer 结论。producer 至少需要请求字段 SHA-256 与 JS value SHA-256 对齐，并保留 `request_id/origin_call_id/call_id/script_sha256`。

## 5. 复现顺序

先做固定向量的 diff 级字节还原，再做动态生成：

```text
Trace 请求/响应
 -> 字段和请求结构定位（query/body/headers/cookies）
 -> URL / headers / body 固定输入逐字节 diff
 -> 固定向量本地精确复现
 -> 动态值来源建模
 -> 用用户给的实际 URL 发起动态请求
 -> 响应状态、响应内容和业务成功条件通过
```

动态值阶段不要提前手工构造最终参数。先证明固定结构和固定输入完全一致，再让原 SDK 或纯函数生成时间、随机数、nonce、服务端 token、Cookie/Storage 派生值。

## 6. 补环境原则

- 固定环境由 Agent 补：BOM/DOM/state 日志里出现的 `navigator`、`screen`、`document`、`canvas`、`performance`、`crypto`、Cookie、Storage 等。
- 动态值交给原网页脚本或原 SDK 生成：时间、随机数、nonce、服务端下发 token、环境摘要、最终签名字段。
- 不整块重写 SDK 的环境采集函数；只补缺失 API 和固定值。
- UA、headers、TLS 指纹、Cookie/Storage、JS runtime 要保持一致。

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

## 9. 下一轮采集建议模板

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
  采集计划: full-chain 或 discover-light
  Query 字段:
  Body 字段:
  Header 字段:
  Cookie 字段:
  脚本身份: 由 `index/target-candidates.json` 自动推导
  函数线索: 由调用链和值匹配自动推导
  JS mode:
  VM/WASM:
    脚本身份、opcode PC 范围和 dispatcher PC 由工具/Agent 自动推导，用户不填写内部过滤值。

操作：
  打开 Firefox -> 等 ACK -> 开始记录 -> 执行目标动作一次 -> 停止并整理

成功条件：
  request field SHA-256 与 JS value SHA-256 对齐；
  无相关 degraded；
  保存完整 request/response/value/script artifact。
```



## 10. JSVMP / VM 面板解释

给用户解释“分析后自动套用”时按这个说：

```text
先 trace 一轮 -> 工具生成 target-candidates.json -> Agent 审核脚本和热点 PC -> 中控台自动套用 -> 再 trace 一轮窄窗口
```

推荐流程：

1. `full-chain` 默认模块保持开启，先确认目标请求、字段、脚本 artifact、JS producer。
2. 若像 JSVMP：新分段，选择“JSVMP 第1轮：自动定位（先全链路）”，不填写脚本关键词，执行短目标动作。
3. 工具从请求 caller、`origin_call_id`、JS 调用链和值匹配生成候选，并由 `trace_opcode_analyzer.py` 产出热点 `START:END` 与 dispatcher 候选。
4. 下一分段选择“自动套用 PC 窄采”或“自动套用 dispatcher”；中控台自动带入脚本、PC 和 dispatcher，用户只重复同一个动作。
5. 前面的 JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script 默认模块通常保留；只有日志过重或 degraded 时才定向关闭无关模块。

Raw HTTP 的定位：它是底层 HTTP channel payload chunk 证据，用于字节 diff、multipart、压缩、charset、边界字符串、逻辑层请求已对齐但响应异常的排查。普通生成链路优先使用 `network/request-fields/values`。

## VMP checkpoint protocol: Agent actions and user reminders

Treat VMP as a staged investigation. The Agent owns evidence analysis and chooses the next stage; the user only performs the short browser action and fills values the Agent has explicitly produced.

### Gate 0 — decide whether VMP is warranted

Agent reads the request field, producer chain, script identity and `wasm-vm` signals first. Remind the user only when there is evidence of an interpreter/VM pattern: encoded instruction/data arrays, a hot loop, opaque dispatch, or a JS opcode cluster. If the target is ordinary JS or WASM, keep the normal route and do not ask for VMP fields.

User reminder:

```text
先保持默认模块不动；如果确认是 JSVMP，请选择“JSVMP 第1轮：自动定位（先全链路）”，不填写脚本关键词、PC range 或 dispatcher PC，执行一次短目标动作。
```

### Gate 1 — opcode hotspot pass

The tool derives the target script substring from `request caller_url`, `origin_call_id`, the JS call chain and value matches, then analyzes `js.opcode` records with `trace_opcode_analyzer.py`. The Agent reviews the exact script identity and candidate `START:END` range; the UI applies them automatically.

If a hotspot range exists, remind the user:

```text
第一轮已找到 opcode 热点：SCRIPT_SUBSTRING，PC 范围：START:END。请选择“JSVMP 第2轮：自动套用 PC 窄采”，不回填内部参数，再执行一次相同动作。
```

If no stable hotspot exists, remind the user to repeat the same short action; the tool keeps the discovered script identity and does not expose a manual filter field.

### Gate 2 — dispatcher decision

Agent compares opcode PC, function/script identity, call context and request timing. Only when a native interpreter dispatch loop is evidenced does it report one dispatcher PC. A page-defined virtual PC is not automatically a native dispatcher PC.

If confirmed, remind the user:

```text
已确认 dispatcher PC：DISPATCH_PC。请选择“JSVMP 第3轮：自动套用 dispatcher”，工具自动保持脚本与 PC identity 并开启 VM step，执行一次短目标动作。
```

If not confirmed, keep the opcode-window route and ask for no VM step. Stack slot/type and primitive capture are follow-up evidence only when the unresolved question is VM state; WASM dump/raw bytes are follow-up evidence only when a WASM module is actually involved.

### Gate 3 — validate and move on

Agent validates `script_sha256`, PC/dispatcher identity, `call_id`, `origin_call_id`, request field SHA-256 and degraded status. Then report one next action only:

- `fixed-byte`: proceed to URL/headers/cookies/body diff;
- `missing-environment`: run a normal browser-environment segment;
- `missing-vm-state`: enable stack slot/type or primitive values for one short action;
- `dynamic`: fixed bytes match, begin dynamic-value generation and live URL response validation.

Always keep JS/XHR/Fetch/DOM/BOM/Cookie/Storage/Script modules enabled as context unless the trace is degraded or the Agent identifies a concrete overhead source. VM options are additive, not a replacement for the request and environment evidence.
