# 5s Cloudflare 本地链路交接

> **给下一位 Agent 的快速接手页（先读这一节，再看后面的历史记录）**

## A. 当前结论（2026-09-01，严格门禁）

本案例**尚未完成**，但链路已推进到此前从未到达的 interactive 阶段。最近一次 standalone 结果：

```text
stage_gate=passed
final_response_gate=failed
homepage_response_gate=failed
```

### 2026-09-01 重大突破（接手者必读）

1. **Worker realm 原生异步 continuation 根因已修复**。`WebAssembly.instantiate()/.then()`
   等 host 侧 resolve 的 Promise 永远不会执行——`microtaskMode:'afterEvaluate'` 只在脚本
   结束时泵一次微任务，而 native completion 晚于该时刻。修复：
   `cloudflare-runtime.js` 新增 `installRealmJobPump(context, label)`（env
   `CLOUDFLARE_REALM_PUMP=0` 可关），对 main/frame/worker 三个 vm realm 每 20ms 泵一个
   noop。修复后 standalone 首次产出 **72-74KB 的第二次 challenges `/fo/` POST，服务器返回
   `200 + 127KB` interactive 脚本**（此前一律降级 `/eb/chl_api_m`）。
2. **`/eb/chl_api_m` 语义确认**：它是错误/降级上报（服务器回 `ok` 2 字节）。把 `/eb/`
   的 body 原样改发到 `/fo/`（env `CLOUDFLARE_SUBMIT_ENDPOINT=fo` 实验已实现）得到
   `400`——端点选择是语义性的，客户端确实有失败要上报。
3. **当前断点：interactive 阶段**。服务器对我们 74KB body 返回 127KB interactive 脚本
   （浏览器成功会话同位置是 86KB body → 6860B 通过指令）。交互脚本在 VM dispatcher 处
   抛 `X is not a function`（名字每轮轮换：gh/re/gt...）。已定位：字符串表含
   `#dbrMC3` 选择器与 `mousemove/capture/createElement`，交互探针把 `querySelector`
   得到的元素经 `Object.prototype.toString` 变成 `'[object HTMLInputElement]'` 字符串后
   当作回调调用（dynamic-call helper 如 `function(a,b){return a(b)}`）。已加探针：
   - `frame.bad-call`（worker_log）：dynamic-call helper 收到非函数时记录 arg_type/arg/stack；
   - `element.toPrimitive`（env `CLOUDFLARE_TRACE_TOSTRING=1`）：未命中，说明字符串由
     VM 用 `Object.prototype.toString.call` 自建，不经过 toPrimitive；
   - `timer.member-error`、`frame.execute-cs-meta`、`message.long-string`、
     `frame.interactive-click`、`frame.dynamic-call-probe`（53 处 helper 已插桩）。
4. **transport 不是 interactive 的成因**：`requests-go TLS_FIREFOX_145`、`curl-cffi
   firefox135`、Firefox 原生 BiDi transport（live-chain，74KB body 逐字节对齐浏览器）
   三种 transport 都得到 127KB interactive 响应。交互标记取决于 body 内容/会话状态。
5. **下一步（优先级序）**：
   1. 修交互 VM 的对象/函数寄存器错位：从 `frame.bad-call` 的 stack 定位发出
      `String(element)` 的 VM op；对比浏览器同 session 的探针结果（浏览器无此调用）；
   2. 检查 `WeakMap`/事件 listener registry 跨 realm 键身份（widget 用元素做 key 存
      回调，查找失败→字符串化）；
   3. 若交互 VM 修复，确认 interactive 完成 → 最终 origin `/fo/` → `cf_clearance`；
   4. 三个 gate 连续两轮 passed 后按 G 节收尾。
6. **本轮新增诊断开关**：`CLOUDFLARE_REALM_PUMP`（默认 1）、
   `CLOUDFLARE_SUBMIT_ENDPOINT=fo`（端点覆盖实验）、`CLOUDFLARE_TRACE_TOSTRING`、
   `CLOUDFLARE_VIRTUAL_TIME_SCALE`（已证实与真实定时器冲突，勿用）。合成点击
   （interactive checkbox）默认关闭，如需启用设 runtime `interactiveClickEnabled === true`。
7. 新 trace 日志位于 `trace-logs/ff-trace-5s-clearance-20260901-150432/`（成功浏览器
   会话 full-chain，含 cf_clearance 完整因果链）。`runtime-data` 已清理至 14MB，
   4257 个历史运行产物已删。

### 历史结论（2026-08-23）

最近一次严格 standalone 结果在
`runtime-data/local-validation-result.json`：前置动态链已经通过，但没有最终 origin
`/fo/ + Set-Cookie: cf_clearance`，同一 cookie jar 的首页 GET 仍得到 `403 Just a
moment...`。`runtime_errors=[]` 只表示本地 runtime 没有抛错，不表示 Cloudflare
完成态已经到达。

当前请求序列已经可动态推进到 origin `/fo/`、Turnstile `/fo/`、`/eb/`、`/i/`、PAT
及 PAT 后续 Turnstile `/fo/`。ray、URL、body、token、cookie 和脚本混淆字段均来自
本轮响应/执行，没有复制历史成功值。剩余断点在 PAT 后的交互/状态推进与最终 origin
提交，或者 Firefox 原生连接/session 与 standalone transport 的组合差异。

`runtime-data/live-validation-result.json` 是严格 validator 修正前的旧产物，其中把
challenges origin 的 `/i/ 204` 误计为 `final_response`，其三项 passed **不再是当前
验收证据**。当前 validator 只接受目标站点 origin 的动态 `/fo/`，且该请求自己的响应
必须实际带 `Set-Cookie: cf_clearance`。

### 立即执行的第一步

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
node --check examples/5s/cloudflare-runtime.js
CLOUDFLARE_MAX_CHALLENGE_ROUNDS=1 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/
```

读取结果：

```bash
jq '{stage_gate,final_response_gate,homepage_response_gate,runtime_errors}' \
  examples/5s/runtime-data/local-validation-result.json
```

只有三个 gate 全部为 `passed` 才能报告完成。

### 已做过的单变量 A/B

- `curl-cffi firefox135`：`stage=passed`，最终和首页 gate 失败；
- `requests-go TLS_FIREFOX_145`：结果相同，单独替换 TLS preset 不足；
- bridge 响应延迟 14 秒：真实触发 `/fo/` 的 5s/10s timeout retry，但仍未进入最终
  origin `/fo/`；
- headed Nightly 成功证据：真实顺序为 origin `/fo/` -> challenges `/fo/` -> PAT +
  `/i/` -> second challenges `/fo/` -> final origin `/fo/` -> `cf_clearance`。

最小 headed 摘要保存在
`runtime-data/headed-clearance-trace-summary-20260823.json`，只保留 cookie 长度/SHA，
不把 cookie 值写入 runtime。该 trace 的 health 有 capture incomplete 标记，因此它用于
证明成功请求顺序和 cookie 出现，不用于证明未观察 producer 的绝对缺失。

## B. 文件地图

| 文件 | 用途 |
|---|---|
| `cloudflare-runtime.js` | 案例专用 VM/DOM/frame/Worker/runtime；主要修改点在这里 |
| `validate-local-chain.js` | standalone 验收入口、阶段门禁、首页复验 |
| `validate-live-chain.js` | 项目 Firefox transport 对照；不能作为脱离浏览器成功证据 |
| `browser-environment-profile.json` | 已从项目 Firefox 观察出的稳定环境合同 |
| `README.md` | 案例范围、验收定义和已确认环境点 |
| `first-trace-analysis.md` | 初始 trace 分析和请求阶段说明 |
| `runtime-data/local-validation-result.json` | 最近一次本地 gate 结果 |
| `runtime-data/local-validation-runner.json` | 最近一次运行的请求、Worker、frame、encoder 诊断 |
| `runtime-data/success-firefox-encoder-object-100.json` | 成功 Firefox 的最小对象证据；仅用于结构对照 |
| `log/trace-fixture/manifest.json` | 可移植 trace fixture 的 SHA/文件清单 |

## C. 已修复、不要重复改的部分

1. VM realm 与 host realm 的 EventTarget listener registry 已对齐，`parent.postMessage()`
   不再因 listener 数量为 0 而丢失。
2. Worker 使用 VM realm 自己的 Promise，`fetch().then()` 能继续执行并回传 `/i/` 的
   `cf-chl-peek`。
3. Worker `Headers` 已补 `forEach` 等行为；WebGL 返回带 brand/prototype 的对象。
4. WebRTC、`frameElement`、plugins/mimeTypes、`navigator.getGamepads()` 已补入案例 runtime。
5. Resource Timing 已按所属 realm 的 `performance.now()` 生成，不能再用固定历史耗时。

这些修复只证明前置阶段正确，**不等于最终 clearance 成功**。

## D. 当前真正的追踪目标

成功 Firefox 的对象是“先创建、后追加”，不是一次性静态字典。下一位 Agent 应：

1. 对同一轮当前 `/orchestrate/` 脚本按结构匹配 `setTimeout(...,100,..., telemetry)`，
   不按 `DP`、`CS` 等混淆变量名匹配。
2. 记录 100ms 回调进入、返回、Promise continuation、frame/Worker message dispatch。
3. 比较本地与成功 Firefox 的 `yQYB9`、`FELcX1`、`qOeu1` 和数字键来源。
4. 先找“第一个追加动作”的来源，再修通用 runtime 合同；不要直接向对象补 `1..39`。
5. 每次只改一个环境点，固定同一 transport 重跑，并保留前后 JSON 结果。

## E. 调试技巧

### E.1 结构匹配，不追混淆名字

动态脚本每轮都会换变量名。优先匹配稳定结构，例如：

```js
setTimeout(<callback>, 100, <frame_state>, <telemetry_object>)
```

或对象尾部的稳定字段组合：`Cplz9/zcNj0/gAMzq7/NWUB3/WpIu5`。正则只用于诊断和
单轮证据，必须记录命中数、脚本 SHA、脚本 URL；命中数不是 1 时立即停止。

### E.2 先看因果链，再看最终 body

推荐顺序：

```text
script load
→ frame/worker construct
→ message send/clone/enqueue/dispatch
→ Promise continuation
→ telemetry write
→ encoder input
→ /fo/ body
→ /pat/ /i/ /clearance
```

只比较 body 长度或 SHA 接近没有诊断价值；必须找到第一个分叉事件。

### E.3 浏览器对象探针

只读取对象合同时使用窄探针，不重新采 full trace：

```bash
node examples/5s/probe-error-stack.js
node examples/5s/probe-browser-contracts.js
node examples/5s/probe-dom-contracts.js
```

保存结果到 `runtime-data/browser-console-*.json`，记录 Firefox build、页面 URL、表达式、
原始结果。只复制类型、原型、属性描述符和调用链形状；不复制会话动态值。

### E.4 Trace 必须有熔断

启动 full trace 后立刻开 watchdog：

```bash
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 --max-bytes 2147483648 \
  --url-contains __agent_probe_sentinel__ &
```

结束顺序：

```bash
tools/trace-control.sh "$TRACE_DIR" stop handoff-stop
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

确认最小 fixture 已通过 manifest SHA 校验后，再删除 `/private/tmp` 的 trace/profile。

## F. 常见坑（下一位不要踩）

- **把 live Firefox 成功当 standalone 成功**：live runner 可能复用已经拿到 clearance 的 user context。
- **把 49 项旧对象用于当前 46/48 项脚本**：脚本版本和字段 schema 会变化。
- **固定 `ray/token/Cookie/body/时间/随机数/UUID`**：会让下一轮立即失效。
- **按混淆变量名 patch**：`DP`、`CS`、函数名每轮都可能不同；应按结构和当前脚本 SHA。
- **把 204 当作通过**：`/i/` 204 只代表 Worker fetch 阶段语义正确，后续 clearance 仍可能失败。
- **把 `cf-chl-peek` 当作 `cf_clearance`**：前者是响应头，后者必须实际写入 Cookie jar。
- **把 body 长度接近当成功**：必须看最终 URL、body、状态、关键 header、Cookie 和首页 200。
- **使用 host Promise/host EventTarget 代替 VM realm**：会破坏 continuation 或 message 因果链。
- **全量 trace 无上限**：会产生 GB 级文件；优先窄采集 encoder、Worker、frame message。
- **调试 probe 留在最终运行**：最终验收必须关闭 diagnostic/debug/源码注入并连续跑两轮。

## G. 最终收尾清单

- [ ] 三个 gate 连续两轮全部 `passed`
- [ ] ray、token、body SHA、Cookie 值每轮动态变化
- [ ] 首页为 200 HTML，无 challenge marker
- [ ] `cf_clearance` 非空且属性正确，首页请求带同一值
- [ ] 关闭 `CLOUDFLARE_DIAGNOSTIC_ENCODER`、`CLOUDFLARE_DEBUG_VM`、所有 probe patch
- [ ] 保留最小 fixture、最终结果 JSON、必要浏览器合同
- [ ] 清理临时 trace/profile 和无关 response artifact


更新时间：2026-08-18

## 0.4 2026-08-19 Worker fetch continuation 修复

## 0.5 2026-08-20 分支定向 patch 机制落地

## 0.6 2026-08-20 环境 profile 与 telemetry 边界确认

新增 `browser-environment-profile.json`，runtime 的 navigator、screen、main/frame window、
storage、Canvas 2D、FontFaceSet、MediaDevices 已从稳定浏览器合同读取；时间、随机数、
UUID、ray、token、Cookie 和请求体仍由当前动态脚本生成。

新增的诊断入口从 `setTimeout` 的额外参数捕获当前会话 telemetry 对象，不依赖混淆变量名。
最新运行已经捕获到当前脚本实际生成的 48 项对象（当前会话脚本不是旧 trace 的 49 项版本），
证明对象确实由动态脚本构造并传入 timer，而不是需要手工写入 runtime。当前样本关键值为：

```text
gAMzq7=4, NWUB3=13, WpIu5=13
kytBC0=1141, WAiB1=600, XNan0=560
xRRo8=3, VrJt8=0, DoKk0=4, yJEso5=37
FELcX1[0].t=541, yQYB9=2 项
```

这一步排除了“固定变量名写错导致对象没生成”的猜测。当前差异集中在对象内部的运行时
输入，尤其是 Resource Timing/异步时间轴和 Error stack；不能把旧浏览器的 49 项数值直接
复制到当前会话。最新 standalone gate 仍未完成。

`cloudflare-runtime.js` 现已加入案例专用、默认关闭的 `--force-frame-branch`。参数要求
JSON：`{"sha256":"...","anchor":"...","replacement":"..."}`。运行时会在 iframe
脚本执行前校验脚本 SHA，要求锚点恰好命中 1 次，只替换该锚点，并把
`script_sha256/anchor/match_count/replacement/applied` 写入 `vm_probe_patches`；不构造
PAT URL、不固化 token，失败即中止该脚本，便于回滚。

机制已通过语法检查，但当前尚未取得可安全使用的 PAT 分支唯一锚点；最新 standalone
回归仍为 `stage_gate=passed`、`final_response_gate=failed`、`homepage_response_gate=failed`。
因此不能把“patch 入口已存在”表述为 5s 已解决。下一步仍需从成功浏览器会话的第二个
`/fo/` 动态 frame 中提取唯一谓词，再用真实 `/pat/`、后续 `/fo/` 和首页 200 验收。

`/i/` 的跨域 Worker fetch 已完成一次 standalone 回归核验。此前 worker realm 复用了
host `Promise`，bridge fetch 返回后 Promise continuation 没有稳定进入 worker 任务链；现
改为使用 VM worker realm 的原生 `Promise`，并保留通用 fetch resolve/reject 诊断。

最新证据：

```text
worker.fetch.resolve: status=204
worker.postMessage: {pmsnv8:1, XWUJj6:204, MegOA4:[..., cf-chl-peek, ...]}
worker.main-message.dispatch: terminated=false
```

这确认了 `/i/` 响应、`headers.forEach`、Worker 回传和主线程 dispatch 均已贯通。回传后
当前会话仍没有产生 `/pat/` 或后续 origin `/fo/`，Cookie 仍只有 `__cf_bm`，因此三道
最终门禁仍为 `stage_gate=passed`、`final_response_gate=failed`、
`homepage_response_gate=failed`。剩余问题已从 Worker Promise runtime 缩小到
challenge acceptance/clearance 回传分支，不能宣称 standalone 已完成。

## 0.3 2026-08-19 standalone 回归与 realm 修复

本轮确认并修复了一个通用运行时缺口：VM realm 的 `globalThis` 与 host
`WindowShim` 是不同对象，而 `addEventListener` 被绑定在 host，导致 iframe
`parent.postMessage()` 派发时监听器计数为 0，Turnstile 消息被丢弃。runtime 现在让
主窗口和 iframe 的两个 realm identity 共用 EventTarget listener registry。

修复后的证据：

```text
frame.parent.message.dispatch.listener_count = 1
动态请求：origin /fo/ -> challenges /fo/ -> /eb/chl_api_m -> /i/
四个阶段：URL、body size、status 和阶段语义全部匹配
stage_gate=passed
```

同时修正 `validate-local-chain.js` 的统计误报：Turnstile `api.js` 和 iframe bridge
资源不再计入 generated XHR/fetch 阶段数量。该修正只影响 validator，不改变运行时。

standalone 最终门禁仍未完成：`/i/` 返回 204 且含 `cf-chl-peek`，但独立 Cookie jar
仍只有 `__cf_bm`，没有 `cf_clearance`；复验首页仍为 403 `Just a moment...`。
因此当前真实结论是 `stage_gate=passed`，`final_response_gate=failed`，
`homepage_response_gate=failed`。下一步应追 `/i/` 之后的 clearance/导航回传阶段，
不是继续修改前面的 Turnstile 消息派发。

## 0.2 2026-08-19 Firefox transport 对照实验

使用项目 headed Nightly 与 `examples/5s/validate-live-chain.js` 完成一轮全新会话验证。
Node 侧动态脚本请求通过 Firefox BiDi bridge 发出；对于跨域 `/i/`，页面 `fetch()` 的
CORS 可见性会抛 `NetworkError`，但 Firefox `network.responseCompleted` 同时确认了原始
请求已经发出并收到语义正确的响应，因此 validator 现在以原生网络事件作为该类请求的
响应证据。Turnstile `api.js` 等辅助资源不再被错误地当成阶段请求计数。

本轮只证明若干 Node 生成的单阶段请求可由 Firefox transport 接受：

```text
validator 内部 stage_gate=passed
validator 内部 final_response_gate=passed
validator 内部 homepage_response_gate=passed
最终阶段：GET /cdn-cgi/challenge-platform/.../i/ -> 204，含 cf-chl-peek
首页：200 text/html，标题 Ripley.com | Tienda online con las mejores ofertas
首页正文：234558 bytes，无 challenge marker
```

对应结果文件：`examples/5s/runtime-data/live-validation-result.json`。
这不是脱离浏览器复现，也不满足本案例完成标准。该 runner 为抓 `_cf_chl_opt` 先在同一
Firefox user context 导航真实挑战页，原生页面挑战会并行运行并可能先取得 clearance，
因此最后的首页 200 存在会话污染，三个内部 gate 不构成完整 Node bridge 链成功证据。
可保留的结论仅是已逐项匹配的请求 URL/body 和 `/i/` 原生网络响应；
`local-validation-result.json` 才是脱离浏览器链路的当前结果。

## 0. 2026-08-18 13:45 最新浏览器复查结论

使用更新后的项目 Nightly 完成了一轮 Worker 因果窄 trace。真实浏览器再次通过挑战，
首个 `cf_clearance` 在 `1787031749691581 us` 出现，属性为 `.ripley.com.pe`、
`Secure`、`HttpOnly`、`SameSite=None`、`Partitioned`。因此当前浏览器运行环境足以完成
挑战；本地 Node 链仍未完成，不能把本轮成功等同于本地复现完成。

本轮真实请求顺序为：

```text
origin /fo/
challenges /fo/
并发 /i/ + /pat/
second challenges /fo/
origin /fo/
cf_clearance
```

本轮记录到 9 条完整的 Worker 消息，每条都有 `send -> clone -> enqueue -> dispatch`：

```text
navigator source -> navigator result
/i/ source
PAT source
performance.now source -> performance result
WASM source
10-second delay source
OPFS source
```

当前 Trace 对单次消息分发是完整的，但 Worker 内 `fetch().then()`、Promise continuation
和 OPFS Promise 完成后的后续 `postMessage()` 没有继承原消息任务上下文。这个问题属于
浏览器的通用异步因果 Trace 缺口，值得在 Gecko runtime 中修复；它没有阻止挑战成功，
也不是当前本地 Node 链失败的直接证据。

第一个 challenges `/fo/` 前的 49 项对象新值为：

```text
gAMzq7=267, NWUB3=1245, WpIu5=1245
kytBC0=5810, WAiB1=4114, XNan0=4052
xRRo8=11, VrJt8=11, DoKk0=407, yJEso5=40, DCkwl7=1623
FELcX1[0]: m="a", t=1696, c=1, stack=21 行
```

此时 `yQYB9` 确实只有 iframe navigation 与 `api.js` 两项；稍后随着资源完成动态增长
为 3 项、4 项。结论是本地 runtime 在第一请求阶段保持 2 项没有直接错误，但实现必须
随 Resource Timing 动态增长，不能永久固定长度。

旧 trace 的 `FELcX1[0].t=20` 不是稳定目标。本轮成功浏览器为 `1696`，与本地诊断值
`1835` 接近，因此将它从最高优先级降级。更稳定的待查差异是
`gAMzq7/NWUB3/WpIu5`、`WAiB1/XNan0`、`xRRo8/VrJt8/DoKk0` 和 `DCkwl7` 的 producer；
`FELcX1.s` 的调用链形状仍需比对。

本轮 watchdog 没有在 Cookie 出现时停止，是通用识别脚本缺陷：`cookie.http_set` 使用
`host_url/channel_url/final_url` 和顶层 `key/value_preview`，旧脚本只检查 `url` 与
嵌套 `cookie_fields`。这只影响自动停止与证据体积，不影响浏览器是否通过挑战。

下一项判别实验应使用更新后的项目 Firefox，通过 `validate-live-chain.js` 的 BiDi bridge
发送同一套本地动态生成请求。若 Firefox 原生 transport 仍在相同阶段分叉，继续查生成
环境与上述稳定标量 producer；若它通过，则把剩余问题归入 standalone transport/session。

## 0.1 2026-08-18 12:07 上一轮续查结论

## 0.2 2026-08-20 Resource Timing 复验结论

本轮对动态插入 `api.js` 的 Resource Timing 做了单变量复验：`startTime/fetchStart`
现在在桥接请求发起前从所属 realm 的 `performance.now()` 取得，`responseStart` 仍保持
跨域 Firefox 隐私合同的 `0`，entry 的结束时间在脚本执行完成后只允许向后扩展，不会
覆盖为更短的网络耗时。语法检查通过，并用 `curl-cffi/firefox135` 连续跑了三轮。

结果：三个 gate 仍为 `stage_gate=passed`、`final_response_gate=failed`、
`homepage_response_gate=failed`；请求稳定停在第二个 `/fo/` 后的 `/eb/` 与 `/i/`
204，未出现 `/pat/`、最终 origin `/fo/` 或 `cf_clearance`。这排除了“只把 API
Resource Timing 的网络段改成请求前 start”作为唯一分叉原因，也排除了简单统一延长

## 0.3 2026-08-20 Navigator 环境补丁复验

成功 Firefox 的 Turnstile realm 明确读取到 `navigator.plugins.length = 5`，而 standalone
原先固定为 `0`；同时成功 trace 记录了 `navigator.getGamepads()`，返回空数组。已在
`cloudflare-runtime.js` 中补入由通用 Navigator shim 生成的 5 个内置 PDF plugin、对应
`mimeTypes`，以及 `getGamepads() => []`，并保持 Worker realm 不暴露页面专有成员。

单变量回归结果：第二个 `/fo/` body 从 `4396` 变为 `4428`（plugins），再变为 `4460`
（加 getGamepads）；`stage_gate` 仍为 `passed`，`final_response_gate` 与
`homepage_response_gate` 仍为 `failed`。这证明两个缺口确实进入 telemetry，但尚未解释
成功 Firefox 的 `4439` body，不能把长度接近当作完成。

本轮针对 `bK<` 的 object overlay 没有命中，因为 Turnstile iframe 每轮函数名动态变化；
后续需要按同一轮 trace 的 `script_id/function_name` 生成精确 overlay，抓编码前对象字段，
而不是继续猜字段或固定 body。
脚本执行时间的办法：启发式延长曾把 API duration 拉到 3.5 秒，分支仍不变，随后已撤回。

当前诊断对象是当前会话脚本动态生成的 46 项（旧 trace 的 49 项属于另一脚本版本），
不能按旧字段名或旧数值补齐。下一优先级转为第二个 `/fo/` 前 telemetry 的嵌套值、
iframe navigation timing 与当前动态脚本版本的对象 schema 对齐；浏览器环境 profile
保持“固定设备级合同、动态脚本自己生成会话产物”的原则。

最终门禁仍未通过。当前代码完成了一轮新的 `curl-cffi/firefox135` 诊断链，服务端请求
序列仍为：

```text
origin /fo/ -> challenges /fo/ -> /eb/ (1~3 次) -> /i/
```

仍未出现 `/pat/`、第二次 challenges `/fo/`、最终 origin `/fo/` 和
`cf_clearance`；三个 gate 均为 `failed`，首页为 `403 Just a moment...`。

本轮曾从临时 values trace 提取成功浏览器第二个 `/fo/` 前的完整关键值；该 trace 已在
便携 fixture 校验后清理，以下数值与必要制品保留在案例目录中：

```text
49-key: gAMzq7=221, NWUB3=1291, WpIu5=1291
kytBC0=1665, WAiB1=1645, XNan0=1596
xRRo8=12, VrJt8=4, DoKk0=352, yJEso5=32, DCkwl7=1573
qOeu1="[]"
yCCo2: 8 个字段均为 0
FELcX1[0]: m="a", t=20, c=1，Firefox 原生 stack（8 行）
yQYB9[0]: dMHi2=11, QUyj4=0, DBlct1=1447, aelS9=0, Zcgk7=0
yQYB9[1]: dMHi2=2119, QUyj4=0, DBlct1=2382,
           aelS9=26766, Zcgk7=26466
```

对应最新本地诊断对象（动态时间每轮变化）为：

```text
gAMzq7=3, NWUB3=20, WpIu5=20
kytBC0=2852, WAiB1=1017, XNan0=993
xRRo8=2, VrJt8=1, DoKk0=4, yJEso5=21, DCkwl7=122
qOeu1="[]"
yCCo2: 8 个字段均为 0
FELcX1[0]: m="a", t=1835, c=1，stack 形状已是 Firefox 风格但调用链不同
```

新增并保留的证据修复：

- `validate-local-chain.js` 不再把解压后的 API 脚本大小 `82465` 当成
  `encodedBodySize`；当 transport 未返回 `content-length` 时，按实际
  `content-encoding` 动态压缩计算。本轮 `br` 得到 `26452`，与浏览器 `26466`
  只差 14 字节，且没有固化历史值。
- API resource timing 现在使用动态实测请求耗时，并按 Firefox 跨域 Resource Timing
  隐私合同令 `responseStart=0`；duration 被约束在当前 performance 时间轴内。

这两项修复后服务端仍未下发 PAT，证明压缩尺寸和 `responseStart` 不是剩余的唯一根因。
该轮曾把 `FELcX1[0].t=20` 列为最高优先级；13:45 的成功浏览器复查已证明该值不稳定，
现已降级。继续优先追踪多轮都稳定偏小的标量 producer，不要使用统一倍率或固定 sleep
调整时序。

## 1. 目标与完成标准

目标站点：`https://simple.ripley.com.pe/`

本案例的最终目标不是复用浏览器 Cookie，也不是重放历史请求，而是让原始动态
Cloudflare 脚本在 Node 补充环境中运行，并通过独立 HTTP transport 完成同一条链。

只有以下条件全部满足才算完成：

1. Node 本地执行当前会话动态下载的 orchestrate、Turnstile API 和 iframe 脚本。
2. ray、token、时间、随机数、UUID、IP、端口和请求体保持动态，禁止固化 trace 值。
3. 第二个 Turnstile `/fo/` 后出现浏览器同类的 `/pat/`、`/i/` 和后续 origin `/fo/`。
4. Cookie jar 收到非空 `cf_clearance`。
5. `cf_clearance` 属性与浏览器证据一致：目标域、`Path=/`、`Secure`、
   `HttpOnly`、`SameSite=None`、`Partitioned` 和有效期均适用。
6. 使用同一 Node 会话 Cookie 请求首页，得到 `200 text/html`，正文大于 10 KiB，
   且不含 `_cf_chl_opt`、`/cdn-cgi/challenge-platform/`、`Just a moment` 或
   `Enable JavaScript and cookies to continue`。
7. `local-validation-result.json` 中 `stage_gate`、`final_response_gate`、
   `homepage_response_gate` 全部为 `passed`。

## 2. 权威输入与保留证据

所有 5s 外部完整 trace、聚焦 trace 和 profile 已于 2026-08-18 清理。权威便携证据为：

```text
examples/5s/log/trace-fixture/
examples/5s/runtime-data/final-evidence-vector.json
```

`trace-fixture/manifest.json` 的 12 个文件已逐项通过 size 与 SHA-256 校验。后续分析不得
依赖已删除的外部目录；新 trace 仍按 Skill 门禁提取最小证据后立即清理。

## 3. 当前结果

当前状态：**未完成；完全脱离浏览器的 standalone 链仍未通过**。

Firefox live 对照实验只证明生成结果交给浏览器 transport 后可被接受，并以原生网络事件
补足跨域 fetch 的响应可见性。standalone `local-validation` 仍未拿到 `cf_clearance`，
因此本案例继续以 standalone 三道 gate 全部通过作为唯一完成判据。

最新真实本地链使用 `curl-cffi/firefox135`，请求序列为：

```text
origin fo -> challenges fo -> eb -> eb -> eb -> i
```

关键结果：

- 两个 `/fo/` 均返回 `200` 和非空响应体。
- `/i/` 返回 `204`，响应头含非空动态 `cf-chl-peek`。
- iframe Worker 能收到并向主线程回传 `/i/` 的 status/header 列表。
- 服务端在第二个 `/fo/` 后没有下发 PAT Worker，而是下发 `/i/` 和一个计时 Worker，
  随后脚本发送 `/eb/.../chl_api_m`。
- Cookie jar 只有动态 `__cf_bm`，没有 `cf_clearance`。
- 首页复验为 `403 text/html`，标题 `Just a moment...`，challenge 标记仍存在。
- 最新门禁：`stage_gate=failed`、`final_response_gate=failed`、
  `homepage_response_gate=failed`。

最新结果文件：

```text
examples/5s/runtime-data/local-validation-runner.json
examples/5s/runtime-data/local-validation-result.json
examples/5s/runtime-data/local-validation-node.stderr
```

不要用请求体长度判断成功。最新第二个本地 `/fo/` body 为 4407 字节，浏览器 retained
vector 为 4524 字节；长度接近只说明外层编码路径相近，不证明 telemetry 内容正确。

## 4. 浏览器成功链的关键事实

成功 trace 中的 Turnstile Worker 下发顺序：

```text
1. navigator Worker
2. PAT Worker
3. /i/ Worker
4. OPFS navigator.storage.getDirectory Worker
5. 延迟 Worker
6. performance.now 计时 Worker
```

PAT Worker 是 iframe 原始脚本动态构造并通过 `Worker.postMessage(string)` 下发的：

```js
fetch(PAT_URL, { cache: "no-cache", redirect: "follow" })
  .then(r => r.text().then(body => postMessage({
    XVzOM0: 1,
    juZJ4: r.status,
    JiqKP8: r.ok ? 1 : 0,
    HZds9: body
  })))
  .catch(error => postMessage({ XVzOM0: 1, GQAX1: String(error) }));
```

浏览器 PAT 请求返回 `401`、一字节正文 `J`，并带
`WWW-Authenticate: PrivateToken ...`。PAT 不是最终 Cookie 响应；之后浏览器继续发送
Turnstile `/fo/`，最终 origin `/fo/` 才设置 `cf_clearance`。

成功 trace 的请求时间线大致为：

```text
origin fo
challenges fo
pat + i
challenges fo
origin fo -> Set-Cookie: cf_clearance
homepage reload -> normal application HTML
```

成功 `cf_clearance` 证据位于：

```text
.../firefox-trace-20260816-5s-cloudflare-final-evidence/categorized/state.jsonl
```

## 5. 已完成的本地环境工作

主要实现：

```text
examples/5s/cloudflare-runtime.js
examples/5s/validate-local-chain.js
examples/5s/curl-cffi-request.py
examples/5s/requests-go-request.py
```

已经落地并经过至少一轮链路运行的能力：

- 动态获取当前会话 orchestrate、Turnstile API 和 iframe 脚本。
- 动态插入的 `api.js` 使用同一 `LocalSession` 下载，不固定 URL、内容或耗时。
- 动态脚本在所属 document/realm 执行，并保持真实 `document.currentScript` 节点身份。
- API 脚本自行解析 `onload` 并调度回调；已移除 runtime 的重复手动 onload 调用。
- main、iframe 和 Worker 使用独立 VM realm。
- PerformanceObserver 不再默认重放历史记录；只有 `{type, buffered:true}` 才回放，
  注册后只接收新 entry。
- `yQYB9` 已从错误的 3 项修正为浏览器同类的 2 项：iframe navigation 和动态 API
  resource timing。
- Fetch `Response.headers` 支持 `Headers.forEach` 和浏览器迭代顺序。
- WebGL 对象、WebRTC candidate/event、iframe `frameElement`、srcdoc iframe lifecycle、
  Worker 消息和定时器等已按 trace/浏览器探针补充。
- transport 可切换 Node、`requests-go TLS_FIREFOX_145`、
  `curl-cffi firefox135`。三种 transport 都曾停在第二个 `/fo/` 后，因此 transport
  不是当前第一卡点。
- 每次运行保留动态请求的 method、URL、body size/SHA、响应 status/header/body
  artifact，并以同一 Cookie jar 请求首页。

## 6. 当前最明确的分叉点

分叉已经发生在第二个 challenges `/fo/` 的服务端判定：

- 浏览器响应驱动 iframe 构造 PAT、`/i/`、OPFS 和其他 Worker 任务。
- 本地响应只驱动 `/i/` 和计时任务，随后进入 `/eb/`。

因此下一步应继续比对**第二个 `/fo/` 的编码前 telemetry 对象及其嵌套内容**。
不要手工拼接 PAT URL，也不要把历史 PAT token 固化到 runtime；这样不会修正服务端判定，
也不满足动态验收。

聚焦 trace 中的关键 producer：

```text
PID: 12619
49-key builder: call_15928, function nKDoI
encoder: call_15930, function zn
parent: call_15860
frame script column: 47625 / builder column 92063
```

49 项外层 key/type 已基本一致，但嵌套内容仍可能不同。聚焦 trace 的浏览器标量包括：

```text
gAMzq7=338
NWUB3=2184
WpIu5=2184
kytBC0=1831
WAiB1=1806
XNan0=1751
xRRo8=15
VrJt8=4
DoKk0=552
yJEso5=36
DCkwl7=2890
```

这些是历史诊断值，只用于理解 producer 时间窗口，禁止硬编码或使用统一倍率。

## 7. 最近修改与注意事项

`cloudflare-runtime.js` 最近增加了 `installFirefoxErrorStack(context)`，并让 main、iframe、
Worker realm 使用 Firefox 风格的 `function@url:line:column` 栈，同时过滤 Node、runtime
和 `evalmachine` 内部帧。定时器回调也改为直接调用已注册 realm 函数，避免人为增加
匿名 VM 包装帧。

修改原因：此前本地 49 项对象的 `FELcX1[0].s` 明确包含：

```text
Error
    at ...
    at evalmachine.<anonymous>:1:109
    at evalmachine.<anonymous>:1:158
```

这与 Firefox 的 Error stack 合同不符，并且该字符串会进入第二个 `/fo/`。

该改动只经过语法检查和一轮真实链路运行，尚未用 Firefox 控制台保存独立
`browser-console-observed` 证据，也尚未在启用 diagnostic encoder 的运行中重新读取
`FELcX1`。下一位 Agent 应先做第 9 节的最小探针和诊断运行，再决定保留或调整。

最新运行的 `encoder_input_log` 为 0 是因为执行时没有设置
`CLOUDFLARE_DIAGNOSTIC_ENCODER=1`，不是 producer 消失。诊断注入只用于分析，最终验收
必须关闭。

## 8. 本地复现命令

基础检查：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
node --check examples/5s/cloudflare-runtime.js
node --check examples/5s/validate-local-chain.js
git diff --check
```

使用 curl-cffi 跑真实完整链：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
CLOUDFLARE_TRANSPORT=curl-cffi \
CURL_CFFI_PYTHON=/opt/miniconda3/envs/pythonProject/bin/python \
CURL_CFFI_IMPERSONATE=firefox135 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/
```

使用 requests-go：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
CLOUDFLARE_TRANSPORT=requests-go \
REQUESTS_GO_PYTHON=/opt/miniconda3/envs/feapder/bin/python \
REQUESTS_GO_PRESET=TLS_FIREFOX_145 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/
```

启用 49 项对象诊断：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
CLOUDFLARE_DIAGNOSTIC_ENCODER=1 \
CLOUDFLARE_TRANSPORT=curl-cffi \
CURL_CFFI_PYTHON=/opt/miniconda3/envs/pythonProject/bin/python \
CURL_CFFI_IMPERSONATE=firefox135 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/
```

诊断后读取 49 项对象：

```bash
jq -c '.encoder_input_log[] | select(.key_count==49) | .value' \
  examples/5s/runtime-data/local-validation-runner.json
```

读取动态阶段序列：

```bash
jq -r '.observed_dynamic_requests[] |
  [.seq,.transport,.method,.path,.body.size,.bridge_response.status] | @tsv' \
  examples/5s/runtime-data/local-validation-runner.json
```

读取最终门禁和 Cookie：

```bash
jq '{stage_gate,final_response_gate,homepage_response_gate,cookies,homepage}' \
  examples/5s/runtime-data/local-validation-result.json
```

## 9. 项目 Firefox 启动方式

必须使用项目打包的 Nightly，不要打开系统 Firefox：

```text
/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox
```

### 9.1 仅做浏览器对象探针

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace

TRACE_DIR=/private/tmp/firefox-trace-5s-probe-$(date +%Y%m%d-%H%M%S) \
PROFILE_DIR=/private/tmp/firefox-trace-profile-5s-probe-$$ \
TRACE_HEADLESS=0 \
FIREFOX_BIN=/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox \
FIREFOX_TRACE_PYTHON=/opt/miniconda3/envs/firefox-trace/bin/python \
tools/run-trace-firefox.sh \
  --trace-preset manual \
  --trace-start paused \
  https://simple.ripley.com.pe/
```

启动后使用 Firefox 可见 DevTools Console。macOS 可按 `F12` 或
`Cmd+Option+K` 打开 Web Console。对象探针优先在当前页面直接执行，不必为读取一个
内置对象重新采集 full trace。

验证 Error stack 的最小表达式：

```js
(() => ({
  page: location.href,
  userAgent: navigator.userAgent,
  stack: new Error("probe").stack,
  errorTag: Object.prototype.toString.call(new Error()),
  errorPrototype: Object.getPrototypeOf(new Error()).constructor.name,
  prepareStackTrace: Object.getOwnPropertyDescriptor(Error, "prepareStackTrace") || null
}))()
```

将结果保存为：

```text
examples/5s/runtime-data/browser-console-error-stack-YYYYMMDD.json
```

文件应记录 page URL、profile、Firefox build、表达式和结果。只把观察到的格式补入
runtime，不复制历史动态值。

### 9.2 启动完整 Trace

Agent 自己启动 trace 时，必须同时启动 watchdog，最长 120 秒或 2 GiB 后自动停止：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace

export TRACE_DIR=/private/tmp/firefox-trace-5s-next-$(date +%Y%m%d-%H%M%S)
export PROFILE_DIR=/private/tmp/firefox-trace-profile-5s-next-$$
export TRACE_HEADLESS=0
export FIREFOX_BIN=/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox
export FIREFOX_TRACE_PYTHON=/opt/miniconda3/envs/firefox-trace/bin/python

tools/run-trace-firefox.sh \
  --trace-plan full-chain \
  --trace-start active \
  https://simple.ripley.com.pe/
```

另一个终端立即运行 watchdog。若只是人工观察，使用不会命中的 sentinel，让时间/大小
熔断负责兜底：

```bash
python3 tools/trace-stop-on-target.py "$TRACE_DIR" \
  --max-seconds 120 \
  --max-bytes 2147483648 \
  --url-contains __agent_probe_sentinel__ \
  >"$TRACE_DIR/stop-on-target-receipt.json" 2>&1 &
```

手动停止并整理：

```bash
tools/trace-control.sh "$TRACE_DIR" stop manual-stop
python3 tools/trace_finalize.py "$TRACE_DIR" --json
```

检查状态：

```bash
tools/trace-control.sh "$TRACE_DIR" status
jq . "$TRACE_DIR/trace-control.json"
jq . "$TRACE_DIR/trace-health.json"
```

### 9.3 桌面控制台

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
open "Firefox Trace Console.app"
```

若 app 没显示窗口：

```bash
tools/trace-desktop.sh
```

一个 session 只使用一个 Firefox、一个 profile 和一个 `TRACE_DIR`，不要重复双击创建
多个实例。

## 10. 调试建议与下一步顺序

下一位 Agent 按以下顺序推进，不要先改时间倍率或 transport：

1. 用第 9.1 节启动项目 Firefox，保存真实 `Error.stack` 合同。
2. 开启 `CLOUDFLARE_DIAGNOSTIC_ENCODER=1` 跑一轮本地链，确认最新 49 项对象重新进入
   `encoder_input_log`，读取 `FELcX1[0].s`、`qOeu1`、`yQYB9`、`FELcX1` 嵌套值。
3. 若 stack 仍含 V8/Node 帧，按浏览器探针修正 `installFirefoxErrorStack`；若已一致，
   保留该修复并继续下一项。
4. 对聚焦 trace `call_15928` 的 49 项浏览器对象做递归结构提取。现有 trace 的外层
   preview 只证明 key/type/array length，不证明 `FELcX1`、`yQYB9` 内部标量一致。
5. 优先检查会直接泄露 Node/VM 的内容：Error stack、Function/String 输出、realm
   constructor、事件 `origin/source/isTrusted`、DOM 节点身份、performance entry 字段。
6. 每次只修复一个有浏览器证据的对象合同，然后重跑同一 transport。记录第二个
   `/fo/` 后 Worker 下发列表是否从 `/i/ + timing` 变为 `pat + i + OPFS + timing`。
7. PAT 出现后继续观察后续 challenges `/fo/` 和 origin `/fo/`，不要在 PAT 401 时提前
   判定成功。
8. 收到 `cf_clearance` 后检查属性，再由 `validate-local-chain.js` 使用同一 Cookie jar
   请求首页；三个门禁全部通过后才收尾。
9. 最终验收关闭 `CLOUDFLARE_DIAGNOSTIC_ENCODER`、`CLOUDFLARE_DEBUG_VM` 和所有源码
   probe/正则注入，连续跑两轮确认 ray、token、body SHA 和 Cookie 都动态变化。

如果需要新 trace，优先围绕第二个 `/fo/` 前的 49 项 builder、encoder 和 Worker
`postMessage` 做窄采集；不要再采一份无目标的长 full trace。

## 11. 工作区注意事项

当前 worktree 有其他用户改动和未跟踪目录。`examples/5s/` 整体目前未跟踪，处理时：

- 不要还原与本案例无关的文件。
- 不要用 `git clean`、`git reset --hard` 或宽泛删除命令。
- runtime-data 中存在多轮动态响应 artifact；最终完成后只保留最终验收结果、便携
  trace fixture、必要浏览器探针和最小复现文件。
- 删除 Agent trace/profile 前先确认 `examples/5s/log/trace-fixture` 可独立运行且 manifest
  SHA 校验通过。
### 2026-08-20 numeric telemetry follow-up

成功 Firefox 的编码输入对象不是静态 49-key 对象：同一对象先出现 1..11，随后在编码前扩展到 1..39；`Cplz9` 与数字键数量同步。当前 standalone 的对象在首次进入 100ms timer 参数时即为 `Cplz9=0` 且无数字键，直到编码前仍未扩展。说明缺口发生在 telemetry builder 的异步采集/追加阶段，而非 encoder 或 transport。已在 runtime 加入诊断探针 `frame-object-numeric`、`telemetry-write`、`telemetry-define`，下一轮应围绕 100ms 回调内负责追加数字键的函数和 Promise/message 返回继续追踪；不要复制成功对象值。

## 0.7 2026-08-21 Firefox Trace telemetry probe

本轮按 `firefox-trace-reverse` skill 启动 headed Nightly，并用 120 秒/2 GiB watchdog 控制。
同一 Firefox Trace 实例已实际进入目标页，捕获到 4 个 XHR、`/pat/` 与 `/i/` fetch。
持久化 BiDi 探针在 100ms timer 上得到：

- `timer-scheduled` / `timer-enter`：telemetry 对象 22 个稳定字符串键，`Cplz9=0`，数字键 0；
- `timer-return`：对象增加 `DCkwl7`，共 23 键，数字键仍为 0；
- 当前 Firefox 会话本身未产生历史 trace 中的 `1..N` 数字键，因此不能把旧对象键增长直接作为本轮缺口；当前分叉更接近 timer 回调返回值之后的后续分支。

保留证据：`runtime-data/browser-console-live-telemetry-persist.json`、
`runtime-data/browser-trace-telemetry-summary.json`、`runtime-data/browser-trace-request-summary.json`。
Trace 原始目录已停止并 finalize；本轮没有把历史动态 token/body 写入 runtime。

## 0.8 2026-08-21 结构诊断约束

后续诊断不得依赖动态脚本的混淆变量名或属性名。已移除 orchestrate 源码注入，保留
运行时结构观察：`setTimeout` delay、额外参数位置、普通对象键数量、数字键数量，以及
timer enter/return/microtask/延迟快照。当前 standalone 回归恢复为 `stage_gate=passed`，
无 runtime error；对象快照为 `22 -> 23` 和 `48 -> 49`，数字键均为 0。当前差分应从
第二个 `/fo/` 的 body/schema 和其后的消息/Promise 因果链继续定位，不得复制历史字段。

## 0.9 2026-08-21 iframe 分支与 XHR 进度对照

新一轮项目 Firefox Trace 的真实顺序为：首个 first-party `/fo/`、首个 Turnstile
`/fo/`、两次 `chl_api_m`、`/i/`，随后仍未产生第二个 iframe `/fo/` 或最终 origin
`/fo/`。该轮 trace 的首个 Turnstile XHR body 为动态约 4.4 KiB，响应约 823 KiB；
standalone 同轮也走到相同的 `/i/` 阶段。Firefox 对大 XHR 的 `readyState=3` 进度是
三段累计，比例为约 1/3、2/3、完整；standalone 默认实现保持同样的结构。新增的
`--xhr-progress-mode complete-only` 仅用于 A/B 诊断，默认仍为 `staged`，没有作为修复
或最终运行配置。当前证据不支持把 XHR 分块当作首个差异；下一处应继续比较 Turnstile
首个 `/fo/` 响应后的 iframe message / Promise continuation 和动态响应分支。

## 0.10 2026-08-21 headed continuation and transport A/B

使用完整构建 bundle
`gecko-dev/obj-aarch64-apple-darwin25.6.0/dist/Nightly.app/Contents/MacOS/firefox`
重新执行 headed Trace，受 120 秒/2 GiB watchdog 控制并成功 ACK/finalize。真实 Firefox
在同一 Worker 初始化结果后并行下发 `/pat/` 与 `/i/`；`/i/` 对 Worker 可见结果为
status 0/error，`/pat/` 网络响应为 401。页面随后反复创建 Turnstile challenge，并
出现站点自身 Next.js chunk load error，首页保持 challenge。

Trace 的 final HTTP channel 记录了 challenge POST 的浏览器传输合同：动态
`Idempotency-Key`、`Content-Type: text/plain;charset=UTF-8`、`Origin`、完整 iframe
`Referer` 和 `Sec-Fetch-*`。standalone 原先只发送脚本显式设置的 `cf-chl`/
`cf-chl-ra`；现已补充 fresh idempotency key、POST content type、Sec-Fetch 元数据，
并在 runtime 到 bridge 的合同中传递动态 `realm_url`，以保留 iframe referer。A/B
结果：第二个 `/fo/` 响应由约 822 KiB 变为约 846 KiB，并继续出现额外
`chl_api_m`，但仍未产生 PAT/clearance。该结果证明传输头与 referer 是真实输入，
剩余缺口仍在 `/fo/` body 的运行时输入或服务端分支；不得复制历史 token、body 或
混淆变量名。
## 0.11 XHR timeout/retry contract

在 2026-08-21 的同构时序复现中，`CLOUDFLARE_BRIDGE_RESPONSE_DELAY_MS=14000`
使前两轮 `/fo/` 超过 5s/10s XHR timeout，第三轮在 15s timeout 前完成交付，随后
动态最终 `/fo/` 返回 clearance。runtime 已将该响应时序设为默认，并实现了真实
XHR 的 `timeout -> loadend` 结算和迟到响应丢弃。

最终响应后的旧页面 realm 会被顶层导航销毁；runtime 根据响应中动态出现的
`cf_clearance` Set-Cookie 识别该生命周期边界，避免执行旧 realm 的排队 timer。
同时保留 curl-cffi Session 的多条 Set-Cookie，首页导航使用 Trace 观察到的
`Sec-Fetch-Site: cross-site`、`Priority: u=0, i` 合同。当前连续本地运行已稳定通过
`stage_gate` 与 `final_response_gate`，但 standalone 首页 GET 仍收到 403 challenge，
说明剩余差异属于 Cloudflare 对原生 Firefox 页面导航/连接状态的会话绑定，而不是
动态 ray、body、token、Cookie 生成或 XHR retry 合同。

最新 A/B 证据确认动态 Turnstile frame 会为每次 `/fo/` XHR 设置递增 timeout：约 `5s`、`10s`、`15s`，超时后重新构造并发送下一轮 body。standalone shim 之前只暴露 `timeout`/`ontimeout`，没有真正的计时器，因此长响应不会触发 Firefox 的 retry 时序。

已在 `cloudflare-runtime.js` 的 bridge XHR 路径加入：

- 按实例 `timeout` 启动计时器；
- timeout 时清空响应、派发 `timeout` 与 `loadend`；
- 迟到 bridge 响应丢弃，避免过期响应继续推进旧请求；
- 正常响应与 bridge error 只结算一次。

验证结果：设置 `CLOUDFLARE_BRIDGE_RESPONSE_DELAY_MS=30000` 后，runner 日志出现 `5000/10000/15000ms` 三次 timeout，并发送三轮动态 `/fo/`；当前仍未进入 `/pat/`，说明剩余缺口在 timeout 触发后的遥测/VM 事件生产，不是单纯 transport delay。

## 0.12 2026-08-21 headed 两轮导航合同

最新 headed Trace `/private/tmp/firefox-trace-5s-headed-20260821-03` 证明成功链为两轮
challenge：第一轮最终 `/fo/` 后 GET `/` 进入第二轮；第二轮最终 `/fo/` 后由当前动态
脚本创建 form、三个 hidden input 并调用 `HTMLFormElement.submit()`，以动态
`application/x-www-form-urlencoded` body POST `/`，随后返回业务首页。不能硬编码
Trace 中的字段名、token、body 或长度。

standalone 已改成同一 Session 的多轮执行，并补齐 `HTMLFormElement`、
`HTMLFormControlsCollection`、`History`、`Location`、表单序列化、runtime 级导航日志、
动态 Referer，以及 script-visible cookie 写入/删除语义。生命周期截断现按“本轮开始前
是否已有 clearance”判断，不再对每个 clearance 响应一律销毁旧 realm。

当前两轮回归稳定为 `stage_gate=passed`、`final_response_gate=passed`、
`runtime_errors=0`，但第二轮仍未生成 form navigation，最终验证器回退 GET，故
`homepage_response_gate=failed`。当轮 `document.cookie` 结束为 `cf_chl_rc_ni=2`，而
真实成功 Trace 在 form submit 前删除 `cf_chl_rc_ni`；下一步应继续对照最终 origin
`/fo/` 响应后的结构化状态/消息分支，定位为什么 standalone 选择 retry 状态而非 form
提交状态。继续禁止依赖混淆变量名。

## 0.13 2026-08-22 completion 分支回归

本轮对 headed Trace 的异步时序做了 A/B：最终 `/fo/` 已返回并设置动态
`cf_clearance`，随后 Turnstile iframe 可能异步抛出 `api.js` 内部 `300010` 诊断异常。
该异常已被 runtime 记录为页面诊断，不再终止父 realm 的完成 continuation；两轮回归均
稳定通过 `stage_gate` 与 `final_response_gate`，且 `runtime_errors=0`。

进一步对 `document.cookie` 的动态 retry marker 做了 getter/setter 语义对齐：最终响应后
`cf_chl_rc_ni` 会从脚本可见 cookie 视图移除，避免固定名称/值参与请求生成。结果仍未出现
`document.createElement('form')`、hidden input 或 `HTMLFormElement.submit()`，说明剩余差异
已经收敛到最终响应 body 解密后的状态机/消息 Promise 分支，而非 cookie、XHR timeout、
form shim 或动态字段名。当前最新验收仍为：

```text
stage_gate=passed
final_response_gate=passed
homepage_response_gate=failed
```

验证器正确回退 GET 后收到新的 403 challenge；该结果保留为失败证据，不将 clearance
响应误报为业务首页成功。后续应继续使用 headed Trace 对比最终 `/fo/` 响应后的
`PerformanceObserver`、message/Promise settlement 和 response 解密状态，按对象结构、
SHA 与调用关系定位，不依赖每轮变化的变量名。

本轮又定位到一个独立 runtime 缺口：challenge 脚本的 250ms timer 会反复调度同一
函数，本地 VM 在 `setTimeout#158` 触发 `Maximum call stack size exceeded`，真实 Firefox
不会出现该栈溢出。runtime 已加入按函数身份的递归 timer 熔断；回归后该异常消失，
但 form 分支仍未进入，因此当前剩余差异继续收敛在熔断后的 message/Promise 状态推进，
而不是栈溢出本身。
## 0.11 2026-08-23 PAT 后链路结论与收口

本节后的 validator 修正：`final_response` 现在只接受目标 origin 的动态 `/fo/`，且
响应必须实际包含 `cf_clearance`。第二个 Turnstile `/fo/`、`/eb/` 或 `/i/` 即使状态
正确，也只计入 `stage_comparison`，不再计入 `final_response_gate`。

本轮 A/B 结果：`curl-cffi firefox135` 与 `requests-go TLS_FIREFOX_145` 都能动态完成
前置 `/fo/`、`/eb/`、`/i/`、PAT，但均未稳定进入最终 origin `/fo/`，所以仅更换 TLS
preset 还不足以解释缺口。

另做了一轮 `cf_clearance` 窄 headed trace。真实 cookie 事件已经落盘（值只作为 trace
证据，不进入代码），但旧 watchdog 因为严格要求 `seg_001`、而 cookie 事件没有
`segment_id`，错过了 target-hit，直到 time fuse 才停止。已修复 watchdog：初始
`seg_001` 接受未标注的历史 cookie/network 事件，后续 segment 仍严格按 segment 过滤，
并增加了对应单元测试。

### 当前结论

本地 `examples/5s/validate-local-chain.js` 已经动态完成以下阶段，未使用固定变量名、
历史 token、ray、URL、body 或 cookie：

1. origin `/fo/`；
2. Turnstile `/fo/`；
3. 两次 `/eb/.../chl_api_m`；
4. `/i/` fetch，状态 `204`，脚本可读到动态 `cf-chl-peek`；
5. PAT fetch，状态 `401`，响应包含 `WWW-Authenticate: PrivateToken`；
6. PAT 之后第二个 Turnstile `/fo/`，动态 body 已进入 runtime。

最新完整 runner 的关键事件是 `worker.fetch.resolve`、`worker.postMessage`、
`worker.main-message.dispatch/complete`，以及 `/i/` 的 `cf-chl-peek` header 回传。
`runtime_errors=[]`。因此缺口不在 PAT Promise 续接或多值 response header 的基础传递。

### 尚未通过的 gate

当前仍未稳定产生最终 origin `/fo/`、`Set-Cookie: cf_clearance`、form navigation，
以及携带 clearance 的首页 `200`。本地 runtime 在某些完整 runner 中已进入
`interactiveBegin`，但没有真实控件交互后的最终提交链；一次长回归在该分支等待未
排空，已手动中止，不能把半截 runner 当作验收结果。

### headed trace 记录

按 `firefox-trace-reverse` skill 启动了项目打包的有头 Nightly：

`/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox`

trace 目录为 `/private/tmp/firefox-trace-5s-20260823-1825`，watchdog 使用
`trace-stop-on-target.py --max-seconds 90`。用户要求收口后已发送 stop、关闭浏览器并
执行 finalize；该临时 trace/profile 不属于最终交付物，应在确认索引证据后清理。

### 对 TLS / 指纹问题的判断

headed Firefox 成功样本使用 Firefox 142 原生网络栈；本地默认 transport 是
`curl-cffi` 的 `firefox135` preset，同时 UA 是 Firefox 142。这个组合并非 TLS/HTTP2
完全一致，因而只能把当前结果归类为 `transport/session gap` 候选，不能据此否定动态
字段算法。下一次 A/B 应保持同一动态 runtime，只替换 transport，并记录最终 `/fo/`
响应语义、`Set-Cookie` 属性和首页请求 Cookie；不要固定任何成功样本值。

### 下一步

1. 为 interactive 分支补真实 iframe 控件的点击/指针目标和 click 坐标，而不是只向
   top-level `document` 派发 click；保留动态 DOM 事件顺序。
2. 用 Firefox 原生 transport 做同一动态请求回放，或将 curl-cffi preset/UA 调整为
   同版本并逐项记录 TLS、HTTP/2、请求头和 cookie 差异。
3. 只有看到最终 origin `/fo/` 的动态 `Set-Cookie: cf_clearance` 后，才进入首页
   reload gate。
4. 每轮 trace 继续使用 90 秒 watchdog，结束后立即 stop/finalize/关闭 Firefox，
   删除 Agent 创建的 trace、profile、watchdog receipt 和 `/tmp` 中间文件。
