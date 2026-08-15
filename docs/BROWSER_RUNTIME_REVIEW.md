# Browser Runtime Review

更新时间：2026-08-06

这份记录总结 Firefox Trace 运行时的通用能力边界和审计方法。站点、脚本、字段、
trace 路径和具体差异必须写在对应的 `examples/<case>/`，不写入这里。

## 2026-08-10：无损链路索引改进约束

一次多阶段上传/提交验证暴露了四个通用分析缺口。它们必须通过增量 finalize
索引解决，不通过关闭、采样或截断原始事件解决：

1. 按 `request_id` 生成 `open/call -> explicit headers -> body -> send/request ->
   response -> done` 阶段时间线，保留每个原事件时间戳，用于证明动态字段是在
   URL/open 阶段还是 body/send 阶段产生。
2. 生成 response-to-request 值传播边。用结构化 JSON parser 解析已保存的响应
   artifact，对标量和复合值计算 SHA-256，再匹配同一 segment 内后续 URL query、
   header 和结构化 body leaf。保留所有 exact candidates，不用时间接近单独证明因果。
3. 将请求头分为页面显式 XHR/Fetch header、CookieService/session 自动附加内容、
   最终 HTTP channel 表示。replay exporter 必须能识别最小显式头集合，不能把自动
   Cookie 误判成 JavaScript 输入。
4. 增加 profile Cookie inventory 索引，键包含 host、path、name、HttpOnly、secure、
   origin attributes 和观测时间。`document.cookie` 只是当前 document 的 API 视图，
   不能代表完整会话状态。

完整性强约束：raw JSONL 和配置为 full 的 value artifact 始终是权威证据，新增索引
只能引用、不能替代。finalize 可以按 SHA-256 内容寻址和去重，但每条边必须保留
source file/line、event id、request id、segment id 和 artifact path。二进制请求体
保留精确 size/hash/CRC 和 artifact 或明确的外部输入引用；避免重复内联相同二进制
属于存储去重，不属于事件丢弃。

## 已证实能力

- full-chain 能同时保留 request-field、Fetch body artifact、脚本 artifact、JS
  调用链、DOM/BOM、Cookie/Storage、WASM/VM 和控制健康信息。
- finalizer can mark a target candidate as ready and associate the request sink,
  producer call, and script URL/hash when the evidence is present.
- 异步 JS value spool 和 content-addressed value store 已工作；不需要在每个 JS
  调用热路径同步写文件。
- DOM Promise 现在写入有界的 `observe -> settle` 账本，`promise_id` 将初始状态、
  fulfillment/rejection value 和来源调用配对；停止阶段只等待一个短 drain 窗口，
  不把全页事件继续拖入日志。
- DOM/BOM 合同能输出对象、成员、值、realm/prototype 线索，适合按缺口做定向补环境。
- `script.resource.raw_sha256` 会在 finalize 中按脚本 URL 关联到 JS call/producer，
  候选可直接携带可加载的 artifact hash，避免静态 URL 猜测成为唯一身份。
- 原始请求 body、目标字段和响应 artifact 可以作为固定向量留在案例目录中，由
  `trace-align` 做逐字节比较。

## 2026-08-11：跨 compartment 对象采集约束

DOM binding 参数、receiver、返回值和 Promise 结果可能来自 iframe、Xray wrapper 或
其他 JS realm。Trace 在当前 `JSContext` 中调用 `JS_GetPrototype`、property descriptor、
Promise inspection 或对象快照 API 前，必须验证对象 compartment 与 context 一致。
跨 compartment 时只记录稳定的对象 identity、类型 preview 和
`cross_compartment=true`，不进行原型、descriptor 或属性值深读。

该约束来自一个已符号化的 content crash：`IntersectionObserver` constructor 接收跨
realm callback 后，Trace 的对象合同在 `JS_GetPrototype` 触发 compartment mismatch。
修复覆盖参数合同、receiver/return 合同、对象值快照和 Promise observation。通用回归
夹具为 `tests/trace-cross-realm-constructor.html`；发布门槛同时要求页面完成、content
进程不崩溃，并在开启参数 preview/contract 时观察到跨 compartment marker。

跨 realm marker 是明确的 coverage 边界，不等于对象合同完整。需要该对象内部结构时，
应切换到对象所属 realm 中采集，再用 object/event identity 建立索引；不能从调用方 realm
强行穿透 wrapper。原始事件仍然保留，finalize 只能通过内容寻址和引用去重减少重复存储。

## 2026-08-11：最终请求头与 raw body 解耦

多阶段发布案例暴露出一个配置耦合：parent HTTP channel 已能看到 CookieService、CORS、
安全 SDK 和网络栈合并后的最终请求头，但 `http.request_headers` 曾错误依赖
`TRACE_HTTP_RAW=1`。普通 full-chain 即使开启 `TRACE_FETCH_REQUEST_HEADERS`，raw body
关闭时也可能缺少最终头快照，导致分析者把 Ticket Guard、CSRF 或 session-dtrait 误判
成不必要字段。

修复后，最终请求头只依赖 Trace 总开关和 `TRACE_FETCH_REQUEST_HEADERS`；
`TRACE_HTTP_RAW` 继续只控制响应 raw chunk。事件新增：

```text
stage=final_channel
header_provenance=final_http_channel
```

finalize 同时生成 `index/request-timelines.json`，按逻辑 request_id 保留 XHR/Fetch
`open/call -> header -> body -> send/request -> response/done` 阶段，并把最终 channel
header 快照作为独立来源关联。当前 content request_id 与 parent channel_id 尚未贯通，
关联明确标记 `exact_id=false` 和 `basis=exact_url_method_nearest_time`，只作为相关证据；
存在同 URL 并发请求时必须继续核对时间、body 和 initiator。

本地 smoke 在 `TRACE_HTTP_RAW=0`、`TRACE_FETCH_REQUEST_HEADERS=full` 下只产生
`http.request_headers`，没有 `http.raw` 事件；XHR 和 Fetch POST 均关联到对应逻辑时间线。

## 当前边界

每个 trace 都要分别读取事件计数、degraded、value capture 和
`environment-contract.json` coverage。标量/对象捕获完整，不代表 Promise 履约值、
时序或所有原型成员完整；具体缺口必须以该 trace 的 coverage 和调用记录为准。

Canvas/WebGL、Plugin/mimeTypes、TextMetrics、Function#toString、事件轨迹、
时间/随机和异步结果都属于高风险宿主面，应按实际 producer 调用点核对。

## 验证规则

目标字段必须绑定到同一脚本、同一接口和同一请求向量。回放时加载原始 URL、query、
headers、cookies、body 和序列化顺序，只替换目标字段；所有非目标字段和版本字段
全部保持原值。trace 没捕获的下游请求不能手工拼接后把 HTTP 状态当作算法结论。

验收顺序固定为：

1. 先用 trace 已观察到的环境，在同一 Firefox page/profile 补齐对象和值，生成候选并
   验证它是否进入真实请求；完整 trace 缺少值时，优先用当前 Firefox DevTools 或
   RDP/BiDi `script.evaluate` 读取，不为了一个值重新采集。
2. 要求目标接口的 JSON/业务成功条件和非空业务响应；HTTP 200 只是一层信号。
3. 请求失败后冻结同一完整 request vector，再做 URL、headers、cookies、body 的
   raw/decoded byte diff，逐个定位第一个差异。
4. diff 证明是确定性算法、编码或序列化缺口时再进入纯算；只有确认命名的 Firefox
   native/runtime 缺口时才做最小浏览器 patch，并回归同一 vector。

## Firefox 启动与恢复

启动慢或反复报错时，先固定“一次启动 = 一个 `TRACE_DIR` + 一个临时 Profile”，不要
连续双击应用或把旧 Profile 交给新进程。优先从仓库根目录启动桌面中控台：

```bash
open "Firefox Trace Console.app"
```

Finder 没有窗口时使用同一套 Python/Tk UI：

```bash
tools/trace-desktop.sh
```

UI 内的“打开 Firefox”会调用 `tools/run-trace-firefox.sh`，自动传入
`--new-instance --profile PROFILE_DIR`。首轮保持 Profile 为空（自动生成临时目录）、
输出目录使用新的时间戳目录；需要登录状态时才填写一个明确的持久 Profile，并在同一
Profile 内完成后续 segment。窗口启动后等待 UI 状态变为 `paused` 或 `recording`，再操作
页面；不要在初始化期间刷新或重复点“打开 Firefox”。

命令行等价流程如下，先验证二进制和 Python，再启动：

```bash
export FIREFOX_TRACE_REPO="$PWD"
export FIREFOX_TRACE_RUNTIME_ROOT="/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime"
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON="/opt/miniconda3/envs/firefox-trace/bin/python"
test -x "$FIREFOX_BIN" && "$FIREFOX_BIN" --version
test -x "$FIREFOX_TRACE_PYTHON" && test -x tools/run-trace-firefox.sh
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
PROFILE_DIR="/private/tmp/firefox-trace-profile-$$" \
TRACE_HEADLESS=0 tools/run-trace-firefox.sh \
  --trace-plan full-chain --trace-start paused "TARGET_URL"
```

Agent 启动时显式保留 `TRACE_HEADLESS=0` 并确认有头窗口/进程。watchdog 完成
stop/finalize 后必须关闭该 Firefox 进程组；只停止采集不算运行收尾。

`active` 用于捕获页面加载期脚本和首屏请求，`paused` 用于先登录/准备页面再开始，
`prewarm` 只用于预热运行时。启动失败先读该轮 `TRACE_DIR/ui-launcher.log`、
`manifest.json`、`trace-control.json`：

| 现象 | 先查什么 | 处理 |
|---|---|---|
| `Couldn't load XPCOM` | 是否误用了 `dist/bin/firefox` 或不完整 build | 改用完整 `Nightly.app/Contents/MacOS/firefox` |
| `Code Signature Invalid` / `Invalid Page` | app bundle 或 dylib 是否陈旧/损坏 | 先换完整 Nightly 并执行 `--version`；修复/重签 bundle 后再 trace，不靠换 Profile 掩盖 |
| UI 有状态但无 Firefox 窗口 | `TRACE_HEADLESS`、旧进程、旧 Profile 锁 | 保持 `TRACE_HEADLESS=0`，结束旧 launcher，换临时 Profile，读 `ui-launcher.log` |
| 报已有 `manifest.json` | 输出目录是旧 run | 新建时间戳目录；只有明确要续段时才打开复用 |
| 启动很久 | 是否重复启动、是否在等待页面初始化、是否全量对象/VM 过宽 | 只保留一个进程，等待 `paused/recording`；停止后用 `full-chain + boundary`、VM/WASM 关闭的短窗口重开 |

同一页面缺少 DOM/BOM 内置值时不要重启 Firefox；直接在当前页面控制台取值并记录
build、URL、Profile 和表达式 hash。只有页面/Profile 已丢失、目标状态位于不可访问的
Worker/iframe/closure，或需要新的调用因果证据时，才创建下一轮 trace。

## 浏览器改进方向

Worker 网络请求已纳入通用完整性门槛：Dedicated/Shared/Service Worker 缺少
`page_url` 或当前 JS caller 时，使用持久化的 Worker 脚本 URL 判断内容上下文；XHR
主线程代理从创建起保存 `worker_id/type/script_url/window_id`，因此
`open/header/send/body/response/done` 不会因阶段间 caller 变化而断链。Fetch 的 Worker
来源写在 `fetch.call`，父进程阶段通过同一 `request_id` 关联。验收夹具为
`tests/trace-worker-network.html` 和 `tests/trace-worker-network.js`。

出现只有 `xhr.response`、没有同 request_id 的 open/send/body 时，先标记为采集上下文
缺口，不把它解释为页面没有发送请求；补丁后该形态属于回归失败。

1. finalize 时为每个目标请求保留可重放 vector：URL、method、query、headers、cookie
   snapshot、body artifact、非目标字段 hash 和 origin_call_id。
2. `trace-align` 输出“仅替换目标字段”的证明，列出非目标字段差异，禁止隐式构造
   下游 payload。
3. 继续保留 DOM replay 的每个 API consumed/unconsumed 计数，优先修正顺序和原型链，
   不扩大全局 object depth。
4. Navigator shape 只作为显式 A/B 开关；Window shape、合成 constructor 和全局
   TextEncoder/Uint8Array patch 不进入默认运行时。
5. 启动器在运行时安装后先做 `firefox --version`、关键 `XUL`/dylib 的
   `codesign --verify --strict` 和 `spctl --assess`，把 `CODESIGNING / Invalid Page`
   与 trace 采集错误分开报告；开发 build 的源码资源符号链接不作为单独失败依据，
   以实际有头启动 smoke 为最终门槛。
6. 下一版将 content `request_id` 作为仅内部使用的 Trace metadata 贯通到 parent
   `channel_id`，消除同 URL 并发请求的启发式关联；在完成前索引必须保留
   `exact_id=false`，不得伪装为精确因果边。
7. finalize 增加 response JSON leaf 到后续 query/header/body leaf 的 exact hash 候选边，
   并增加按 host/path/name/originAttributes 组织的 Cookie inventory；两者都引用原始事件，
   不复制或删除权威 artifact。
8. 将跨 compartment、dead wrapper、revoked proxy 和异常 getter 的检查收敛为统一的
   safe-object-inspection 入口。当前跨 compartment crash 已修复，但未来新增对象合同采集
   不允许绕过该入口直接做 prototype/descriptor/property 深读。
