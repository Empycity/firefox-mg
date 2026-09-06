# 5s Cloudflare Firefox runtime case

当前严格结果和复现入口先看 [`STATUS.md`](STATUS.md)。完整历史、阻塞点和接手记录见
[`HANDOFF.md`](HANDOFF.md)。

调试命令、结构化追踪、patch 使用条件和常见误判见
[`DEBUGGING.md`](DEBUGGING.md)。

本目录记录 `https://simple.ripley.com.pe/` 的项目级环境还原与动态链路验收。
这些结论只属于本案例，不进入通用 Firefox Trace skill。

外部 trace 清理前提取的最小运行证据保存在 `log/trace-fixture`。其中仅包含
runtime 仍会读取的脚本和 value 制品，`manifest.json` 记录文件大小与 SHA-256；
`runtime-data/final-evidence-vector.json` 已全部改用案例内相对路径。

## 本案例已确认的环境点

- Node 本地执行动态原始 orchestrate/frame 脚本，网络请求交给项目 Firefox 原生 transport。
- Fetch 响应的 `headers` 必须表现为 `Headers`：frame Worker 会调用
  `headers.forEach((value, name) => ...)`，并依赖迭代顺序把 `cf-chl-peek`
  回传主线程。缺少该原型方法时 `/i/` 即使返回 204，也会进入 Worker catch。
- WebGL 的 `createShader`、`createProgram`、`createBuffer`、
  `createFramebuffer`、`createRenderbuffer` 必须返回带对应 brand/prototype
  的对象。仅补方法名或返回空对象会令后续 producer 停止。
- WebRTC 事件不能使用普通对象代替。成功 trace 中的链路是
  `RTCPeerConnectionIceEvent -> Event`，其 `candidate` 为
  `RTCIceCandidate -> Object`；frame 首次 `/fo/` 前记录到 62 个 candidate
  对象和 63 个 ICE event，包含动态 mDNS host、IPv4/IPv6 srflx 以及空字符串
  candidate。案例 runtime 按该原型和顺序生成动态对象，不复用历史 candidate。
- Turnstile iframe 会读取 `window.frameElement`。该值必须指向实际创建 iframe
  realm 的 `HTMLIFrameElement`，不能只保存在私有 shim 字段。
- `/i/`、`/pat/`、`/eb/.../chl_api_m` 是动态选支。同一版本脚本在不同
  session/响应下可能出现不同组合，因此验收以同轮 Firefox transport 的实际
  请求序列为基准，不固定要求某一历史 trace 的分支。

## 当前本地门禁状态

最新严格 `curl-cffi/firefox135` 验证结果：

```text
stage_gate=passed
final_response_gate=failed
homepage_response_gate=failed
runtime_errors=[]
```

前置动态链可推进至 PAT 后的第二个 Turnstile `/fo/`；当前仍未稳定产生最终目标 origin
`/fo/`、`cf_clearance` 和业务首页。`runtime-data/live-validation-result.json` 是严格
validator 修正前的旧产物，不能用其中的三项 passed 宣告当前完成。最新事实、A/B 结果
和接手顺序以 [`HANDOFF.md`](HANDOFF.md) 顶部为准。

## 验收标准

`validate-local-chain.js` 对每个 Node 生成请求逐阶段比较：

1. transport、method、完整 URL；
2. request body 字节长度；
3. Firefox 响应状态与阶段语义：
   - `/i/`：204 且存在 `cf-chl-peek`；
   - `/pat/`：401 且 `WWW-Authenticate` 以 `PrivateToken` 开始；
   - `/eb/.../chl_api_m`：200 且响应体为 2 字节；
4. `runtime_errors` 为空；
5. 连续两轮 ray、orchestrate SHA、frame SHA、token、body SHA 动态变化。

`final_response` 只接受目标站点 origin 的动态 `/fo/`，且该请求自己的响应必须实际
包含 `Set-Cookie: cf_clearance`。Turnstile `/fo/`、`/eb/`、`/i/` 只计入阶段比较，
不论状态是否正确都不计作最终响应。只有 `final_response_gate=passed` 才进入首页验收。

随后使用同一 Firefox user context 和 Cookie 会话重新 GET 目标首页，完整响应体按
SHA-256 落盘。`homepage_response_gate` 要求响应为 `200 text/html`、正文大于
10 KiB，并且不再包含 Cloudflare challenge 标记。核心 `cf_clearance` 的验收以
非空动态值、目标域/路径/HTTPS/有效期适用性，以及与浏览器 trace 一致的
`HttpOnly`、`SameSite=None`、`Partitioned`、`Secure` 属性为准；首页请求必须携带
cookie jar 中同一 cookie 值。`value_length` 只用于记录，不参与通过判定。

最终运行不得包含 frame 源码正则改写、固定随机脚本名、固定 ray/token 或诊断注入。
