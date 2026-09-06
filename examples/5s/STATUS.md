# 5s 当前状态

更新时间：2026-09-01

## 结论

standalone runtime 尚未达到最终验收，但已突破到 interactive 阶段。最近一次严格结果为：

```text
stage_gate=passed
final_response_gate=failed
homepage_response_gate=failed
```

权威结果文件：`runtime-data/local-validation-result.json`。

### 2026-09-01 进展摘要

- **修复 Worker realm 原生异步 continuation**（`installRealmJobPump`）：`WebAssembly.instantiate`
  等 host-resolve Promise 之前永远不 resolve，导致 telemetry 缺 WASM/OPFS 结果、提交降级
  `/eb/chl_api_m`。修复后链路首次推进到 **第二次 challenges `/fo/`（72-74KB body）→
  `200 + 127KB` interactive 脚本**。
- **`/eb/chl_api_m` = 失败/降级上报**（服务器回 `ok`）；把该 body 发到 `/fo/` 得 400，
  证明端点选择是语义性的。
- **当前断点**：服务端把我们标记为 interactive（浏览器同 session 类型为静默通过），
  interactive 脚本的 VM 在动态调用 helper 处把 `Object.prototype.toString.call(元素)`
  得到的 `'[object HTMLInputElement]'` 字符串当回调调用而崩溃。三种 transport
  （curl-cffi / requests-go / Firefox BiDi）行为一致，排除 transport 因素。
- 下一步与诊断探针清单见 `HANDOFF.md` A 节 2026-09-01 段。

权威结果文件：`runtime-data/local-validation-result.json`。

`stage_gate=passed` 表示本轮动态脚本已完成受检前置请求语义，不表示已经获得可用的
`cf_clearance`。最终通过必须同时满足：

1. runtime 自己生成目标站点 origin 的动态 `/fo/` 请求；
2. 该请求自己的响应实际包含 `Set-Cookie: cf_clearance`；
3. 同一 session/cookie jar 请求首页得到 `200 text/html`；
4. 首页正文没有 Cloudflare challenge marker；
5. `runtime_errors=[]`。

## 已确认

- ray、orchestrate/frame URL、token、body、cookie 和混淆字段均按轮次动态产生；代码不依赖
  固定 JS 变量名或历史成功值。
- 前置链可动态推进到 origin `/fo/`、Turnstile `/fo/`、`/eb/`、`/i/`、PAT 和 PAT
  后续 Turnstile `/fo/`。
- `/i/` 的 `204 + cf-chl-peek`、PAT 的 `401 + WWW-Authenticate: PrivateToken`、Worker
  Promise/message continuation 已在 standalone 中工作。
- `curl-cffi firefox135` 和 `requests-go TLS_FIREFOX_145` 的严格结果相同，单独替换 TLS
  preset 没有补齐最终链路。
- 14 秒 bridge delay 会触发真实的 5s/10s XHR timeout/retry，但仍未稳定产生最终 origin
  `/fo/`。
- headed Nightly 的真实成功顺序是：origin `/fo/` -> challenges `/fo/` -> PAT + `/i/`
  -> second challenges `/fo/` -> final origin `/fo/` -> `cf_clearance`。

headed 最小证据：`runtime-data/headed-clearance-trace-summary-20260823.json`。其中只保留
cookie 长度和 SHA；trace health 标记 capture incomplete，所以它证明成功顺序和 cookie
出现，不证明某个未观察 producer 一定不存在。

## 旧产物说明

`runtime-data/live-validation-result.json` 是 strict validator 修正前生成的旧文件。它把
challenges origin 的 `/i/ 204` 计成了 `final_response`，所以文件内的三项 `passed` 已失效，
不得用于宣告完成。

`validate-local-chain.js` 与 `validate-live-chain.js` 现已采用严格规则：final response 必须
来自目标站点 origin 的动态 `/fo/`，且该请求响应实际设置 `cf_clearance`。

## 复现

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
node --check examples/5s/cloudflare-runtime.js
node --check examples/5s/validate-local-chain.js
node --check examples/5s/validate-live-chain.js

CLOUDFLARE_MAX_CHALLENGE_ROUNDS=1 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/

jq '{stage_gate,final_response_gate,homepage_response_gate,runtime_errors}' \
  examples/5s/runtime-data/local-validation-result.json
```

只有输出同时为 `passed/passed/passed/[]` 才算完成。

## 剩余问题

当前证据支持两类候选，尚未完成单变量隔离：

1. PAT 后 interactive iframe 的真实控件事件、message/Promise 状态推进没有在 standalone
   中完整复现；
2. Firefox 原生 TLS/HTTP2 连接、cookie/session 绑定和 standalone transport 之间仍有组合
   差异。

下一轮优先使用隔离 headed Nightly native transport，让本地 runtime 负责动态生成请求，
Firefox 只负责原生传输。若仍停在 second challenges `/fo/` 前，继续查 interactive/message
分支；若出现最终 origin `/fo/ + cf_clearance`，则把问题归入 transport/session 并逐项收敛。

## Trace 操作约束

- 使用项目 Nightly：
  `/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox`。
- Agent trace 必须有头，并在启动同轮运行 90 秒、2 GiB watchdog。
- target 命中或 90 秒到达后立即 stop/finalize；检查 `index/trace-health.json`。
- 随后关闭对应 Firefox，并删除 Agent 创建且不再需要的 trace、profile、helper 和临时文件。
- 初始 `seg_001` 的 legacy cookie/network 事件可能没有 `segment_id`；watchdog 已兼容该情况。

详细历史、文件地图和已修 runtime 合同见 [`HANDOFF.md`](HANDOFF.md)，具体诊断命令见
[`DEBUGGING.md`](DEBUGGING.md)。
