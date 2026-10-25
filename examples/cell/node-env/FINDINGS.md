# Cell Node 补环境：当前证据与边界

## 会话素材

- 证据 trace：`../traces/round3-transport`（runtime-v2 采集，75.5s 命中 cf_clearance，degraded=0）。
- 浏览器内验证链（captured，全部有制品）：
  1. GET `https://www.cell.com/` → 403 挑战页（`cf-mitigated: challenge`，`_cf_chl_opt`：cRay/cH/cUPMDTk/fa/md/cType=managed/cvId=3）
  2. GET `/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=<cRay>`（~260KB 混淆 VM）
  3. XHR POST `www.cell.com /cdn-cgi/.../fo/…`（body 2295B，专有编码）→ 响应 107KB（stage-2 JS）
  4. Turnstile `challenges.cloudflare.com/turnstile/v0/b/d2d3316b729e/api.js` + iframe
  5. XHR POST `challenges.cloudflare.com /cdn-cgi/.../fo/…`（body 5346B）→ 响应 824KB 载荷（iframe VM）
  6. fetch `brunhild.challenges.cloudflare.com /cdn-cgi/.../i/…` → 204（遥测）
  7. fetch `challenges.cloudflare.com /cdn-cgi/.../pat/…` → **401（PAT 不可用，走 JS PoW 回退）**
  8. XHR POST `www.cell.com /cdn-cgi/.../fo/…`（body 5762B）→ 响应 Set-Cookie `cf_clearance`（HttpOnly/Secure/Partitioned）
- 环境读取清单（122 个唯一成员）来自 round3 `index/environment-contract.json` + dom 日志：iframe postMessage 系、WebGL（vendor=Mozilla）、OffscreenCanvas 2D 文本度量、PerformanceResourceTiming、crypto.subtle/randomUUID/getRandomValues、Worker×4、RTCPeerConnection、BroadcastChannel。

## harness.js 已通过的层（纯 Node，无浏览器）

1. 字符串 VM / 控制流平坦化初始求值。
2. **iframe realm 反篡改检查**：contentWindow.frameElement===iframe、contentDocument.defaultView===contentWindow 交叉身份。做法：`contentWindow` 返回真实 `vm.createContext` 子 realm，且 frameElement/parent/self 指回 contextified 代理（不是裸对象）。
3. **原始内建抓取（Sw）**：从子 realm 取 Function/Array/ArrayBuffer.isView/Reflect.ownKeys/Object/String/Symbol/DataView/TextEncoder/Map/WeakSet/Math 并 typeof 校验。做法：realm 内 `runInContext(name, ctx)` 把内建显式挂到 realm 对象（vm 上下文外部读内建全是 undefined）。
4. 挑战页真 DOM（从 HTML 微解析）+ classList/节点家族方法。
5. Worker 特性探测的 Blob→`URL.createObjectURL`→Worker 链（13B 测试 worker 成功启动）。
6. 首个出站请求：XHR open POST `/cdn-cgi/challenge-platform/h/b/eb/731335211:1792775439:…`（eb 事件信标；路径段是站点级缓变密钥，15+ 分钟有效）。
7. 轮询每会话回调全局（`window.coTgT4/MkvrI5/THirw9/IXEYu6/nOLY0` 等，Turnstile/后续 stage 注入）。

## 当前墙（精确缺口）

- `orchestrate.js` Worker 特性检测函数（pinned 副本 `4:130578`，`to` 函数）读取 `window.<随机名>.prototype.<名>`；这些每会话随机全局由 **Turnstile iframe 内的 824KB 载荷 VM** 定义。无 iframe VM 执行，链路停在第 6 步：eb/ 信标 open 后不 send（等待 PoW Worker 结果，而 PoW 依赖的回调全局不存在）。
- 即浏览器无关拿 cf_clearance 的剩余距离 = 复现 Turnstile iframe VM（JSVMP，正是 firefox-trace VM window/opcode 的目标场景），不是单点补 API。

## 下一步（按项目方法论）

1. 对 `challenges.cloudflare.com` iframe 脚本跑一轮 `vm-window`（65536×80B 记录），拿 dispatcher 与 PoW 输入输出；`target-candidates` 已能自动给 script sha。
2. 或（更近路）：eb/ 信标 send 之前 orchestrate 等待的具体全局名可从 round3 js 日志的 `window.<name>` MISS 序列反查（round3 trace 里该序列完整存在）。
3. Python 侧 `client.py` 已接管编排与 cookie jar；Node 层通过后无需改动即可收 cf_clearance。

## 文件

- `harness.js`：补环境 harness（lenient Proxy 日志、真子 realm iframe、Worker、微 DOM、XHR→fetch 桥）。
- `orchestrate-pinned.js`：钉住的 orchestrate 快照（sha256 前 16 位 `b25f6e4f9343fdea`；线上每 fetch 变体不同，离线迭代必须钉住）。
- `page-live.html` / `opt-live.json` / `harness-log.json`：最近一轮运行的现场。
- `client.py`：Python 客户端骨架（诚实汇报阶段，不伪造 clearance）。

---

## 2026-10-24 深夜追加：VM window 公式打通 + harness 再推三层

### VM window 可用公式（round8 实证）

同时满足才会在 content 进程记录解释器窗口并在目标命中时冻结：

- `TRACE_VM_WINDOW=1` + `TRACE_VM_WINDOW_RECORDS=65536`
- `TRACE_EXECUTION_MODE=opcode`（关键！否则 JIT 接管，环形缓冲永远为空——round4-7 的 0 制品全因这个）
- `TRACE_OPCODE_SCRIPT_CONTAINS` CSV 钉脚本 URL 子串（如 `chl_page,turnstile/f/av0`）
- 冻结触发器只吃**命名字段**匹配：`TRACE_HEADER_FIELDS=cf-chl`（fo/ POST 固定头）在第一次 PoW 前的 header 设置点触发；cookie.http_set 走父进程 CookieService，触发不到 content 环。

成品：`traces/round8-vmwindow/firefox-vm-window-49646-100f300f0-1.bin`（65,536×80B，覆盖冻结前 1.44s / 403 万条解释器指令中的尾部，4,043 个 PC，2,552 个 origin）。解析器 `vm_parse.py`。

### harness 新增通过/发现

- 子 realm 需注入流/套接字构造器面（ReadableStream/WebSocket/MessageChannel…Node 自带但 vm 上下文外不可见）→ Worker 特性检测过。
- `RTCPeerConnection.createOffer` 返回永 pending Promise 即可（round3 health 证实真实浏览器也 pending）。
- 手工注入 turnstile api.js 成功执行（需先造带 src 的 script 标签 + `document.currentScript`），定义 `window.turnstile` + 随机全局；但 **`coTgT4` 不是 api.js 定义的**，orchestrate 注入后依旧等它。
- 浏览器侧（round5 DOM 时间线）：api.js 标签由 orchestrate 在 init 后 ~4s 自建；harness 里该 append 分支从未执行 → coTgT4 的定义者仍未知（候选：fo/#1 的 107KB stage-2 响应 eval、或 orchestrate 未走到的分支）。
- round5 时间线：api.js 4.0s → fo#1 open 4.16s → **send 9.5s（5.3s = PoW 计算窗）** → chl fo#2 50.5s → pat 401 → fo#3 115.2s → cf_clearance。

### 下一步（按证据）

用 vm_parse.py 对冻结窗口做 origin/PC 聚类，取 `origin 182390`（11,696 条）的重现循环反推 PoW 输入；对照 harness 停车点（coTgT4 轮询）找浏览器在该时刻的下一个外部依赖。

---

## 2026-10-24 凌晨终章：coTgT4 已通，墙移至 widget 会话层

### 本轮突破

1. **JSOp 精确编号表**（从 Opcodes.h FOR_EACH_OPCODE 顺序导出，共 242）：`GetArg=191 GetLocal=193 GetAliasedVar=196 GetElem=77 JumpTarget=153 Case=161 TableSwitch=163 Return=164 Pop=228 Dup=230 SetGName=205 GetGName=190 Call=117 BitXor=23 BitAnd=24`。round8 窗口的热点 `153/161/163` 组合 = **JSVMP switch 派发循环实锤**；sv 字节级值（0xec/0xae/0xea…）= hash/codec 特征。
2. **round9 满环**（262,144×80B，5.49s，fo/#3 前的 Turnstile iframe VM 全窗；262,144 记录≈5.5s 是实测换算）。冻结点确认规律：watchdog 晚于 fo/#1 启动则窗口落在 fo/#3；要 fo/#1 窗口必须 watchdog 先于浏览器启动（round10 尝试因后台启动竞态失败，待重试）。
3. **harness 连破两层**：
   - `PerformanceObserver` 需要**真回调**（带 api.js 的 resource 条目，且条目必须在 api.js eval 前注册）——浏览器时间线证实 api.js 加载后第一件事就是 observer 读自身资源条目。
   - **`coTgT4` 已定义并触发**：注入 `api.js?onload=coTgT4` + 预定义同名回调 → api.js 调用之（`CALLBACK coTgT4 fired`），orchestrate 的 30 次轮询立即停止。
4. **当前墙**：coTgT4 触发后 orchestrate 进入静默等待，未调 `window.turnstile.*`（已套 Proxy 记录，零调用）。浏览器对应时刻（round9 js 日志 +0.9s）：orchestrate 以 `this=jsobj_…` 反复调 `P/H/a6/e` 等短名方法构建 widget（+1.27s `querySelector` 建 `*-wrapper` div）。下一步：origin→函数映射用的 round9 js 日志已在磁盘清理中删除——按已固化公式重采一轮（保留 js 日志）即可把 VM 记录的 origin 映射到函数名，再反查 `jsobj` 构造来源，即为 harness 需要补的下一个对象。

### 结论

`cf_clearance` 脱离浏览器未达成（client.py 如实报 null）。已完成：采集器改造+验证、cell 浏览器侧验证链（多轮通过）、VM window 双窗（fo/#3 全窗在手，fo/#1 待采）、harness 十余层反 bot 检查通过、coTgT4 打通。剩余：widget 会话对象 + iframe postMessage 协议 + Turnstile iframe VM 本体。

---

## 2026-10-24 03:40 终稿：fo/#1 冻结窗 + 函数映射完成

### round11（fo/#1 窗口，js 日志保留）

- watchdog 抢在 fo/#1 的 `cf-chl` header 处冻结（request_id=xhr_1），262,144 满环 + 381MB js 日志（原始流保留，categorized 副本已删）。
- **映射结论**（vm_map.py）：
  - PoW 执行器 = orchestrate 内函数 **`run`**（`run(0, 26, …)`，多个 call 实例共 ~4 万条 VM 记录）；其 `this` 对象由 **`new Hl`（脚本 line 2 col 7539）构造** = JSVMP 实例类。
  - 指令处理器 = **`a6`**（VM 每步调用，@3:37065），外层调度 `GH`/`tV`；async 边界回调 `Gc/tZ<`（@3:7028，parent=None）驱动 VM 续跑。
  - api.js 加载前 `eA@2:104846` 两次返回对象（widget/容器工厂，−1.38s/−0.25s）。
  - api.js 加载时刻（+0.012s）自身工厂链：`anonymous@1:23 → de/ne/tr/rr/nr/ot/wt/ue/Rt/At/ae< @2:44xx-59xx → te` 系列。
- **脚本源码制品**（scripts/，全保留）：`d7af3b58…js`（orchestrate 261KB，fo/#1 本轮）、`18075576…js`（api.js 86KB）、`f5a82ee…js`。

### harness 剩余缺口（精确）

浏览器里 orchestrate 的 VM（Hl 实例.run）在 api.js 就绪后经 `Gc/tZ` 回调继续执行 → +0.9s 起以 `this=<widget 对象>` 调 P/H/a6/e 构建 widget → +1.3s `querySelector` 建 `*-wrapper` → fo/#1。harness 侧 coTgT4 已定义且 api.js 回调已触发，但 VM 未进入 `Gc/tZ` 续跑段——缺的是 VM 等待的下一个外部输入（候选：api.js 就绪后写入的另一个全局/回调注册，或 VM 内部 poll 的返回值）。下一会话从 round11 js 日志按 `Gc/tZ` 的注册点（谁把 Gc/tZ 挂到了什么事件上）反查即可闭环。

---

## 2026-10-24 04:00 终稿二：Gc/tZ 已解 = PerformanceObserver 事件泵，VM 推进至 widget 构建段

### Gc/tZ 注册点（本轮 verifier 问题的答案）

源码 `@3:7028` 解码（orchestrate `d7af3b58…js`）：

```js
function Gc() {
  tM = performance.getEntries();
  for (each entry) GH(entry);                      // 存量条目直接喂 VM
  tZ = new PerformanceObserver(cb);                // cb = js 日志里的 Gc/tZ<
  cb = (list) => { for (e of list.getEntries()) GH(e); };
  tZ.observe({entryTypes: ['resource','navigation']});
}
```

**VM 的异步驱动 = performance 条目事件泵**：每个资源加载条目都是 VM 状态机事件（GH 处理器）。api.js 加载 = VM 等待的续跑信号。

### harness 实装与推进（本轮新增）

- 完整事件系统：`__perfObservers` 注册表 + `__notifyResource(url)`（真 `PerformanceResourceTiming` 实例、相对当前时钟的新鲜时间戳）+ httpReq 完成即通知。
- 实测推进（runH1–H5）：**VM 注册 observer（types=[resource,navigation]）→ 收到 api.js 条目（perf notify 触发）→ 进入 widget 构建段：`querySelector(.main-content/.main-wrapper)` 命中真 DOM、`new URL(api.js)` + `new URLSearchParams('onload=coTgT4&render=explicit')` 解析** —— 与浏览器序列逐级对齐（round11 +0.05s 段）。
- 剩余停车点（精确到函数）：浏览器链 `URL解析 → GZ/<@3:17972 → a6 → GE/Gl@3:19444 → tW@3:20138 → Gn@2:115972 → run@2:9386（PoW，+0.054s）`。harness 在 **GZ 内部、GE 之前**停住（GE 的 `setTimeout(cb,3500ms)` 从未注册）。GZ 是 switch 状态机，等待某个值级校验通过——下会话直接用 vm 单步/断点在 GZ 的 switch case 上对拍 harness 与浏览器值。
- 长等待探针结论：停车非定时器（仅 1s 轮询 + 1h failsafe），是 VM 内部 await/校验。

### 状态

`cf_clearance` 仍未拿到（client.py null）。但 verifier 指定的 Gc/tZ 问题已完全解答并实装，VM 推进至 widget 构建段（比上轮又深两级：observer 注册 → 条目消费 → URL 参数解析）。

---

## 2026-10-24 04:30 终稿三：值级对拍工具交付（step_debug.js）

- **`node-env/step_debug.js`**：Node inspector 的无头 CDP 驱动（原生 WebSocket）——attach `--inspect-brk` 子进程 → `Runtime.runIfWaitingForDebugger` 释放（Node 26 的 brake 机制，不是 paused 事件）→ 命中 harness `__notifyResource` 内的 `debugger;` → `Debugger.stepOver` 逐步记录 VM 帧位置到 `step-trace.json`。实测 400 步全通。
- 条目字段级对拍已完成：GH 按固定顺序读完 entryType/name/initiatorType/全部 timing/transferSize/encodedBodySize/decodedBodySize/nextHopProtocol/workerStart（值合理），随后停车——分歧不在条目值本身。
- 下会话用法：把断点精确设到 notify 回调（setBreakpointByUrl + harness 内 `debugger;` 行号），stepInto（非 stepOver）进 GH，逐 case 对拍 GZ switch 的输入；浏览器侧基准 = round11 js 日志同窗口调用链（已存 FINDINGS）。
- 状态不变：`cf_clearance` 未拿到（client.py null）。四项要求：①✅②✅③❌（墙=GZ switch 内一处分歧，工具已就位）④✅。

---

## 2026-10-24 05:20 终稿四：确定性调试闭环（pinned + 单步进 VM 成功）

### 本轮四大成果

1. **确定性会话**：`pinned-page.html / pinned-opt.json / pinned-orchestrate.js` + `HARNESS_PINNED=1`——消灭"每跑一变"的随机路径，停车点可复现。
2. **CF 动态反调试发现**：orchestrate 源码 0 个静态 `debugger`，陷阱全部经 `Function('debugger')` 动态注入——调试器一 attach 就把 VM 冻死。已在 vm prelude 用 Function 包装器（剥离动态源里的 `debugger`）中和。
3. **单步进 VM 成功**：step_debug.js 现在精确命中 notify 断点（DBG_LINE 运行时计算——prelude 改动会漂移行号，踩过）并 stepInto 捕获 **GH 续跑全程 88 步**：
   - 观察者回调区 `(anon)@5:8850-9000`
   - VM 派发蹦床 `b4@5:73652/73665`（每步间必经）
   - 处理器 `h@5:73410-73546`
   - **状态光标 `hl@5:30944→31540` 稳步推进后回调正常返回**——回调内无停车！
4. **停车点重定位**：GH 回调完成后 VM 等待下一个输入（光标停在 31540 之后）。浏览器同段在 +0.024s 由 GH 路径同步完成 URL 解析——harness 的 GH 段未到达 URL 解析即返回。种子条目时序值已改浏览器量级（1741.46/2032.8/104226 等），无行为变化。

### 下会话最短路径

用 step_debug 继续走：断点命中后先 `Debugger.resume` 跳过回调，再在**回调返回后的下一个 orchestrate 暂停**（若有）或对 `b4@73652` 设条件断点记录每次调用的光标参数；同时给 harness 的 XHR pump 加"浏览器 fo/ 端点 403 重试后 URL 变化"的对拍。素材：step-trace.json（88 步）、stall-scope 机制已内置。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（墙=GH 回调后 VM 等待的下一个输入，工具全部就绪）④✅

---

## 2026-10-24 06:00 终稿五：等待循环完全解码 + 登记机制实装

### 决定性解码（b4 蹦床 + 条件断点 + 调用帧求值）

`b4($i){return b3[$i]}` 只是字符串表读取器。等待循环（cursors 12→1122→1123→1078→707→12→12→50 有界重试）的真身（pinned 会话）：

```js
f(Sz) = window._cf_chl_opt.CNmxZ4 && window._cf_chl_opt.CNmxZ4.includes(Sz)
// b4(12)='_cf_chl_opt'  b4(707)='CNmxZ4'  b4(50)='includes'
// b4(1122)='AKECH4'  b4(1123)='coTgT4'  b4(1078)='XnuWO5'
```

**VM 等的是回调注册名单**：`_cf_chl_opt.CNmxZ4`（逗号分隔的名字表，浏览器中由各回调定义方登记；harness 中为空串 → 有界重试耗尽 → 停车）。

### harness 实装与验证

- eval 前预登记 `CNmxZ4='coTgT4,AKECH4,XnuWO5'` + 预定义三个回调全局。
- 步进器求值证实 VM 视角 `includes` 全部通过（`zTarget=',coTgT4,AKECH4,XnuWO5'`）。
- 该层等待清除后 VM 推进至**下一层等待**（非 XHR）——链条继续加深（预期后续：widget render → iframe postMessage 握手 → Turnstile VM → PoW）。

### 方法论闭环（可复用）

1. `HARNESS_PINNED=1`（确定性）
2. step_debug 命中 notify 断点 → 对 `b4@5:73652` 设 `arguments[0]===<cursor>` 条件断点
3. `Debugger.evaluateOnCallFrame` 跑 `cN(<idx>)`/`$i`/局部变量 → 直接读出等待表达式
4. harness 预置对应值/登记 → 重跑步进器看新终态循环 → 解码下一层

### 状态

`cf_clearance` 未拿到（client.py null）。四项：①✅②✅③❌（等待链已从"未知停车"推进到"CNmxZ4 登记机制已知、当前在下一层等待"，解码循环每层约 10 分钟）④✅

---

## 2026-10-24 06:40 终稿六：等待机制全链闭环——触发语义是"外部调用"

### 本轮逐段求值证据（f 帧内、VM 运行时）

```json
{"expr":"true","zIsWin":true,"zAKE":"function","zcoT":"function","zXnu":"function","cnmxz4":",coTgT4,AKECH4,XnuWO5"}
```

- 等待表达式**已全真**（Z===window、三回调均为 function、CNmxZ4 已含三名）。
- 外层 `i@5:31739`（VM 步进器）局部 `SV=1`，8 光标循环照转 → 循环退出条件**不是** f 的返回值。
- 循环全程零回调调用（stub 有调用日志，仅 api.js onload 触发过 coTgT4 一次）。

### 结论（浏览器 vs harness 的语义差）

浏览器真实序：orchestrate **自己定义** `window.coTgT4/AKECH4/XnuWO5` 为桥接处理器并自登记入 CNmxZ4 → 等待 **Turnstile widget（真 iframe）**经 postMessage→api.js **调用**这些桥 → 桥更新 VM 状态（SV）→ 循环退出 → widget 构建 → fo/#1。

harness 中：预定义的 stub 不是 orchestrate 的桥（无 VM 状态副作用），也无人按正确语义调用它们 → 等待无限。

**剩余距离 = Turnstile widget 本体仿真**（824KB iframe 载荷 VM + postMessage 协议 + PoW），与终稿二判断一致；orchestrate 侧（chl_page）的可补环境部分已全部补完。

### 交付清单（全部就绪，供续作）

- 确定性：`HARNESS_PINNED=1` + pinned-* 三件套
- 步进器终版 `step_debug.js`：断点命中→b4 全采样→终态循环检测→调用帧逐段求值（一轮出全部证据）
- harness 已通过层：反篡改/内建/Worker/RTC/PerformanceObserver 事件泵/CNmxZ4 登记
- 浏览器基准：round11 冻结窗 + js 日志 + 源码制品；VM window 公式（round8/9）
- 下一跳建议：不再深挖 chl_page 等待，转向 turnstile/f/av0 载荷的独立仿真（用 round8/9 的 VM 窗口做其 PoW 的逐指令基准）

---

## 2026-10-24 07:00 终稿七：postMessage 协议提取现状与内核增强规格

### 已提取（现有 trace）

- round3 完整对话：**310 个消息事件**（parent↔widget 双向）、186 次 `MessageEvent.data` 读取、93 次 `Window.postMessage` 调用；调用形如 `postMessage(<data 对象>, 'https://challenges.cloudflare.com')`（方向 parent→widget；widget→parent 亦有）。
- 消息对象**仅身份元数据**（object_id/class/realm/prototype），payload 内容未被展开——所有已有 trace 的 DOM 对象捕获为深度 0，`TRACE_DOM_OBJECT_VALUES` 只有开关无深度旋钮。

### 下会话内核增强规格（走已验证的构建管线）

1. 在 `Window.postMessage` 调用点与 `MessageEvent.data` getter 处对 data 参数做**定向深度 2 展开**（复用 `AutoFirefoxTraceJSCall::writeObjectProps` 的预入防递归护栏；新 env 如 `TRACE_DOM_ARG_OBJECT_DEPTH`，只对这两个成员生效，避免全站对象展开）。
2. 重建（`examples/cell/lab/mozconfig` 管线，增量 ~15 分钟）→ 重采一轮完整验证（round12）→ 得到逐字段 postMessage 协议规格。
3. 之后的 widget 仿真按协议规格驱动 `turnstile/f/av0` 载荷（round8/9 VM 窗口为其 PoW 逐指令基准），桥接调用 coTgT4/AKECH4/XnuWO5。

### 会话总结（七轮递进的完整证据链）

采集器改造（不卡死+证据保留）→ cell 多轮验证通过 → VM window 公式 → fo/#1 冻结窗+函数映射 → Gc/tZ 解码 → 等待循环解码（CNmxZ4）→ 触发语义闭环（外部调用）。`cf_clearance` 脱离浏览器未达成；剩余=按上述规格的内核增强+widget 仿真工程。

---

## 2026-10-24 08:00 终稿八：内核增强落地，Turnstile postMessage 协议完整提取 ✅

### 内核增强（已构建+安装 runtime-v2+同步主补丁）

- 新开关 `TRACE_DOM_ARG_OBJECT_DEPTH`（0-4，默认 0 不改变旧行为）
- `FirefoxTraceAppendExpandedValue/Object`：JS_Enumerate+JS_GetPropertyById 定向展开（32 键/16 元素上限、跨 compartment 停在身份、复用 `sFirefoxTraceDOMInternalReadDepth` 防递归）
- 接线两处：`Window.postMessage` arg0 → `arg_object`；`MessageEvent.data` → `value_object`
- 构建一次通过（修正字面量转义与 `JS::IsArrayObject` 现代签名），runtime-v2 已重装并签名验证

### round12（完整验证 84.4s 命中 cf_clearance，degraded=0）

**323 条逐字段协议消息**已导出 `traces/round12-payload/postmessage-protocol.json`：

| event | 方向 | 语义 |
|---|---|---|
| `meow`(seq) ×146 | widget↔parent | 心跳握手 ping |
| `food`(seq) ×144 | 双向 | 心跳 pong |
| `init`(kills…) | parent→widget | 初始化 |
| `requestExtraParams` / `extraParams` | 请求/响应 | 参数交换 |
| `translationInit`(displayLanguage) | parent→widget | 语言配置 |
| **`execute`(cs:[挑战数组])** | parent→widget | **挑战执行命令** |
| `overrunBegin` | widget→parent | 长任务标记 |

公共字段：`source:'cloudflare-challenge'`、`widgetId`（会话内稳定，如 'ly5ux'）。

### 对剩余工程的意义

widget 仿真的**驱动层规格已齐**：harness 只需按此时序向伪装 iframe realm 投递 `init→requestExtraParams→execute`，并以 `meow/food` 维持心跳——再往内就是 824KB 载荷的 PoW 本体（round8/9 VM 窗口基准在手）。`execute` 的 `cs` 数组字段值即挑战种子（下一步展开深度 3 即可读全）。

### 状态

内核增强=verifier 指定的"第一个最小解锁步骤"已完成并产出协议制品。`cf_clearance` 脱离浏览器仍未达成（client.py null）。

---

## 2026-10-24 09:00 终稿九：协议驱动器接入 + 双等待循环判定

### 本轮交付

1. **round13（深度 3）**：`execute.cs` 种子完整解码并导出 `traces/round13-seed/execute-challenge-seed.json`：`cs=[[0, 39974, "<跨 orchestrate/api.js 的调用栈证明串（ho/Ne/Se/sj/l/IU/run/sq/KP 链）>", 1]]`——**难度 39974 + 栈证明**，即 PoW 的输入形态。
2. **`node-env/protocol-driver.js`**：按 round12 协议时序的 widget/parent 双端驱动骨架（meow/food 心跳、extraParams/translationInit/execute 投递、init/requestExtraParams/overrunBegin 处理）。
3. **harness 关键修正**：撤掉全部桥预定义/预登记（此前我们的 stub 占位阻止了 orchestrate 自主定义）；接入 widget→parent 消息投递（init/meow/requestExtraParams → 2 个 message 监听器确认送达）。结果：**orchestrate 在 notify+api.js+widget 消息齐备后仍未定义桥**（bridges=undefined 贯穿全程），且等待循环升级为**双环**：
   - 环 A（f@5:35728）：`_cf_chl_opt.CNmxZ4.includes('XnuWO5'/'AKECH4'/'coTgT4')` — zAKE/zcoT=undefined 故 false
   - 环 B（@4:1693-1742，调用帧 p9，`SV=10000` 重试预算）：新光标 856/857，与环 A 同族检查
4. step_debug 采样升级：光标变化即采样 + 调用帧解码器动态选择。

### 判定（更新终稿六）

orchestrate 定义桥的分支在 harness 中从未执行——它位于**尚未满足的更上游条件**之后（候选：api.js onload 必须由真实 script load 事件触发而非手动 eval、或 widget iframe 内真实载荷的首次 postMessage 握手先于桥定义）。桥定义→CNmxZ4 登记→环 A/B 清除→widget 构建→execute→PoW 的链条次序已完全确定，剩余全部收敛于"让 orchestrate 走到定义桥分支"这一个上游门。

### 下会话最短路径

step_debug 对环 B 的 856/857 用**帧内正确解码器**（该帧用 dF 之外的表）解码两字符串；并对 `i@5:31741`（SV=1 状态机）设条件断点抓它读取的判定值——两个探针各约 10 分钟，可定位上游门的确切检查项。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌④✅（round13 大流已清）

---

## 2026-10-24 10:00 终稿十：环 B 门破解——HKul9/QPUYE4，VM 抵达 widget iframe 创建

### 两探针结果（probe_gate.js，一次运行出全部证据）

- **环 B 光标解码**：856='HKul9'、857='QPUYE4'——第三/四个会话随机桥名（与 coTgT4/AKECH4/XnuWO5 同族）。
- **状态机 i@5:31741**：局部仅 oz/de/SV=1，判定值在更深的表里（未展开）。

### 决定性实验

预定义 `window.HKul9/QPUYE4`（stub）+ 登记 `CNmxZ4='HKul9,QPUYE4'` → **VM 越过环 B，创建 widget iframe**（createElement('iframe')，harness 首次）——上游门确认就是这个登记对。

### 新发现：CNmxZ4 归 orchestrate 所有

登记后 orchestrate 将其**重置为空**并随自身定义桥逐个写回（BRIDGE 日志：CNmxZ4=[] 贯穿）——即浏览器语义是"orchestrate 定义桥→自行登记"，外部抢注会被清掉。环 A（coTgT4/AKECH4/XnuWO5）等的是 orchestrate 自己定义它们，而这发生在 iframe 交接之后。

### 下会话最短路径（两步）

1. **抓 iframe src**：VM 创建 iframe 后会给 src（turnstile 小部件 URL，含 widgetId 与挑战参数）——在 Elem 上加 src setter 日志（当前属性直赋未记录），拿到 URL 后在伪 iframe realm 里 GET 其 HTML 并执行其中的载荷引导。
2. 载荷（round3 values/05e7*.txt = 824KB）在伪 realm 内运行后会按协议向 parent postMessage（init/nextRcV、meow…）——此时 orchestrate 定义桥、填 CNmxZ4，链条自动续跑至 execute→PoW（种子形态 `[[0,39974,<栈证明>,1]]` 已知，round8/9 VM 窗口为逐指令基准）。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（又退一环：从"双环等待"推进到"widget iframe 已创建，待抓 src"）④✅

---

## 2026-10-24 11:00 终稿十一：widget realm 内 api.js 完整运行 ✅

### 本轮交付

1. **iframe src 机制查明**：VM 创建的 iframe 无 src（about:blank 型），浏览器语义是 api.js 经 contentWindow 注入——补丁改为"api.js 灌入伪 iframe realm"。
2. **realm 环境补齐**（三轮迭代：HTMLScriptElement→getElementsByTagName 可迭代数组/querySelectorAll 真 Array/styleSheets→URL/URLSearchParams/XHR/fetch/crypto/timers/PerfObserver/parent 指回主窗）→ **`api.js evaluated inside widget realm (86732B)` 无错完成**。
3. **widget 侧控制器激活**：realm api.js 注册了第 3 个 message 监听器（此前 2 个=orchestrate）——双向协议的两个端点在 harness 中首次同时在线。
4. iframe src 抓取管线（lenientProxy set 陷阱 + queueIframeLoad + realm script pump）为通用能力保留。

### 当前挂点

realm api.js 注册监听后静默等待（未 postMessage 回 parent）——它等的是自己的启动输入（render 参数/rendered 容器/extraParams）。下一步：向 realm 投递 parent→widget 方向消息（extraParams 含 apiJsResourceTiming、translationInit），并把 orchestrate 创建的 iframe 传给 realm api.js 作为渲染目标（浏览器中 turnstile.render(container) 由页面调用；managed 模式由 orchestrate 驱动）。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（widget 控制器已在 harness 内上线，双向端点齐备）④✅

---

## 2026-10-24 12:00 终稿十二：双向协议全通，realm 处理器确认收到消息

### 本轮打通（pinZ2 实证）

1. **realm→parent 路由**：realm 的 `postMessage` 现在真实投递进 parent 的 message 监听器（`__deliverToParent`）。
2. **parent→realm 投递**：`deliverToRealms` 按协议序投递 `extraParams`(含 apiJsResourceTiming)→`translationInit`→`food`(心跳应答)——**全部到达 realm api.js 的监听器，零 handler 错误**。
3. realm message 监听器确认存在（+1）。

### 挂点（精确）

realm api.js 收到消息后不回应。两个候选原因（下会话各 10 分钟验证）：
1. **跨 realm 品牌检查**：我们投递的是普通对象，api.js 可能要求真 MessageEvent 实例（用 realm 内构造器 `new realm.MessageEvent(...)` 构造再投）。
2. **启动配置缺失**：浏览器中 iframe 引导由 document.write 写入配置 JSON（widgetId/render 参数）；realm api.js 在收到配置前忽略消息。

### 环境自吐（进行中）

`__deliverToParent` 已挂 parent 侧；完整的属性读取记录器（window/realm 每次 get 记 key+值预览，退出写 env-access.json）骨架在 window literal（`__accessDump`），下会话接 Proxy get 钩子完成。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（双向协议全通、投递确认、剩品牌/配置两候选）④✅

---

## 2026-10-24 13:00 终稿十三：按 trace 重建 realm（原型链 + 账本值）✅

### 方法论修正（用户指正，已落实）

补环境一律以 trace 为源：**值**取自 dom 日志账本（widget realm 92 个读取全带真实值），**原型链**取自 environment-contract（realm_26a150bb1030：362 对象，`MessageEventPrototype→EventPrototype→Object`、SVG 五级链、`CSS2PropertiesPrototype→CSSStyleDeclarationPrototype→Object` 等，descriptor 全为 accessor 挂 *Prototype*）。

### 实现（harness.js buildRealmClasses）

- `REALM_CHAINS` 表 = 合约链的逐字转录（含 EventTargetPrototype 补全）；`getProto` 带缓存（修复 Object/EventTargetPrototype 递归爆栈）。
- `defClass(iface)` 同时暴露构造器与 `XPrototype` 对象（合约证明反爬会查 holder 身份）；`D.createElement` 按 TAG_IFACE 把实例原型设到对应叶子——`instanceof` / 原型链遍历与浏览器一致。
- realm 按 round3 账本回值：`innerWidth=300/innerHeight=65/screenX=4/screenY=33`、navigator 全套（en-US/oscpu='Intel Mac OS X 10.15'/hardwareConcurrency=12/plugins/mimeTypes/permissions）、`location.search='?lang=auto'`、性能条目 transferSize=0/responseEnd=13.88/duration=2163.54（缓存命中特征）。

### 实测

api.js 在 trace 构建 realm 内无错评估（修复 RangeError 后），message 监听在线，extraParams/translationInit/food 全部送达零错误。realm api.js 收到后仍静默——它等自身启动条件（DOMContentLoaded 或 turnstile.render；managed 流的渲染触发在 orchestrate 侧桥接之后）。

### 下会话两针

1. realm 内补 `document.readyState`/DOMContentLoaded 派发 + `W.turnstile.render` 缺口观察（api.js IIFE 的启动门槛）。
2. 对 realm api.js 的静默段用 probe_gate 同款断点采样其等待光标（同方法论）。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌④✅

---

## 2026-10-24 14:00 终稿十四：orchestrate 建签分支已达成，api.js 标签校验为当前单点

### 本轮达成（pinZ 系列）

1. **手动注入退役**：改走 orchestrate 自建 script 标签的浏览器语义路径（pump 带 `document.currentScript` 上下文 eval，标签真实入树）。
2. **全 5 桥预定义** + **CNmxZ4 post-eval 登记**（orchestrate 会 clobber 评估前写入；post-eval 写入稳定存续 `HKul9,QPUYE4,coTgT4,AKECH4,XnuWO5`）→ **VM 越过等待环，走到建签分支**（createElement('script') + appendChild，src=DraY9 URL 入队）。
3. **队列归属修复**：realm Elem 的 appendChild 不再污染主队列（`__isRealm` 标记分路由）。
4. **DOM 构造器家族**（Document/Location/ShadowRoot/NodeList…47 个）自动补齐 + pump 的 `instanceof X` 缺失扫描自动定义（api.js 裸 instanceof 不再抛）。
5. **api.js 校验逻辑解码**（pinned-api.js 源码）：`Mt()` 要求 `currentScript instanceof HTMLScriptElement` 且 src 匹配 `^https://challenges.cloudflare.com/turnstile/v0(/.*)?/api.js`，否则遍历 `querySelectorAll('script')`。

### 当前单点（下会话第一个动作）

pump eval 报 "Could not find Turnstile valid script tag"——`Mt()` 未命中。已修 allElems 漏 head 子树；待查：orchestrate tag 的 src 赋值路径（0 条 `SET el<script>.src`——src 可能经 defineProperty/setAttribute 设置，set 陷阱与 setAttribute 日志需各加一路），以及 `currentScript` defineProperty 转发是否生效。修复后 api.js 校验通过 → 调 `window.DraY9()` → orchestrate 续跑 → render → widgetMap 注册 → 消息链全通 → execute → PoW。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（链条推进到"api.js 标签校验"单点）④✅

---

## 2026-10-24 15:00 终稿十五：CNmxZ4 真身=数组（VM 自管），unified 类后 iframe 检查新岔路

### 决定性证据（pinZ25/26）

- orchestrate eval 顶部自己执行 `window._cf_chl_opt.CNmxZ4=[]` —— **注册表是数组、VM 全权管理**：定义一个桥 push 一个名字，等待环 `includes()` 查数组。外部登记字符串/数组都会被 eval 顶部的 `=[]` 重置（post-eval 写入虽存续但语义不对——正确做法是让 VM 自己 push）。
- 主窗类统一（buildRealmClasses 用于主窗）后，orchestrate 在 `el<iframe>.remove()`（finally 清理）之后抛**裸 TypeError** = `Sw(SQ)===null` 分支——iframe 检查里 SQ 的取值/内容与 unified 原型交互出现新岔路（此前该检查已通过）。realm 未被创建（Sw self-test 无日志）→ SQ 不是 contentWindow，候选=src/srcdoc 字符串（我们的 Elem src getter 返回 ''）。

### 已固化的正确认知链

`CNmxZ4=[]` + VM 自 push → 等待环天然清除（无需外部登记）→ 桥定义分支的前提是**通过 iframe 检查**（Sw 非空）→ iframe 检查需要 SQ 正确（src/contentWindow 语义）→ 之后 orchestrate 建签→DraY9→render→widgetMap→消息链→execute→PoW（种子已知）。

### 下会话第一动作

step_debug 断 `5:31741`（状态机 i）与 f 环，抓 `Sw(SQ)` 的 SQ 实参内容（src 字符串? contentWindow?）——一次运行即可确定 iframe 检查的确切期望值；按值补 Elem（如 iframe src 返回浏览器同款 about:blank/srcdoc、或 contentWindow 触发时机）。

### 状态

`cf_clearance` 未拿到（client.py null）。①✅②✅③❌（又前进一步：注册表真身=VM 自管数组）④✅

---

## 2026-10-24 13:05 终稿十六：默认模式过不去的根因=修复未替换进默认 runtime（已修复）

用户 12:54 用中控默认模式重跑（ui-20261024-125420，写入 round2-values）：manifest 显示 firefox_bin=examples/cell/runtime/Nightly.app（round2 时代旧 XUL，无值传输 v2）→ 3 次 "terminated by timeout" 重演、1.19M 事件 4.7G——与用户判断"更新了没替换"完全一致。

修复：v2 XUL（含值传输 v2 + TRACE_DOM_ARG_OBJECT_DEPTH，sha256 2728d153…）已安装进全部三个 runtime 并签名验证：
1. examples/cell/runtime/Nightly.app（案例旧 runtime）
2. /Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app（中控默认）
3. examples/cell/runtime-v2/Nightly.app

三者 XUL 哈希一致。此后中控默认模式即带全部采集器修复；预期与 round3-13 同水平（60-96s 过验证）。失败轮 4.7G 原始 JS 流已清（manifest+health 凭证保留），cell 目录回到 1.8G。

---

## 2026-10-24 13:10 终稿十七：默认模式（v2 runtime）实测——cf_clearance 已发，剩余拖慢=Firefox 10s 脚本看门狗（已修）

用户 13:01 默认模式重跑（v2 runtime 已生效：制品引用 18,538、行峰值 1.34MB→122KB）实测结果：
- **cf_clearance 已签发**（cookie.http_set accepted、.cell.com、一年期）——验证实际通过；
- 2 次 "Script terminated by timeout" = **Firefox 自身 10s 内容脚本看门狗**杀 widget PoW 热循环（trace 每调用开销使其超 10s）→ CF 自动重试 → 全程变慢但最终完成。

修复（不丢任何证据）：`profiles/trace-user.js` 增加 `dom.max_script_run_time=120`（含 about_blank/ext 变体），launcher 每次启动自动拷入 profile——被 trace 的 PoW 一口气跑完，不再被杀重试。skills 发布副本已同步。

结论：runtime 替换 + 看门狗阈值两项后，默认 full-chain 模式预期单程通过；round2 时代"过不去"的两个根因（旧采集器拖垮 + 看门狗杀 PoW）均已消除。

---

## 2026-10-24 13:25 终稿十八：cookie 已跑出（597B 全值）+ 可用性判定

### 交付

- `artifacts/cf-clearance-extracted.json`：traces/test（用户 13:11 默认模式，Ai_MCP v2 runtime）profile 提取的 **cf_clearance 完整 597 字符值** + MAID/MACHINE_LAST_SEEN/OptanonConsent。
- 验证时间线（trace 实证）：首请求→签发 **56.7s**（正常 <10s）；签发后 +9.8s 内仍有 2 轮 fo/（CF 二次校验）；2 次 "Script terminated by timeout"（其中一次在 www.cell.com 自身 line 13——orchestrate 单事件循环块在 trace 下超阈值）。
- prefs 已确认生效（profile user.js 含 max_script_run_time，值=120）——120s 仍被单块超出，下次如需可再放宽或接受重试。

### 可用性判定（用户：能不能用另说）

curl 带 597B clearance 直接访问 www.cell.com → **403**。原因（预期内）：clearance 与签发时的 TLS/HTTP2 指纹 + 完整 UA/头序绑定（FINDINGS 终稿十一前的 standalone transport gate 规则）——curl 指纹不匹配即拒。**这不是 cookie 无效，是传输指纹门**；链路还原价值不受影响：597B 值 + 签发时序 + 签发轮全部 trace 证据在手。

### 状态

浏览器侧"把 cookie 跑出来"✅（默认模式、trace 全开、degraded=0）。脱离浏览器复刻仍未完成（widget VM 仿真，见终稿十/十四/十五）。

---

## 2026-10-24 16:00 终稿十九：原型链嫁接修复 + 控制器上线（链条最大突破）

### 根因与修复（本轮核心）

unified 类把实例原型换成 trace 链后**链上没有方法**——setAttribute/contentWindow 等全在 Elem.prototype 上被截断 → orchestrate 拿到空壳 iframe → 裸 TypeError。修复 = `graftElemMethods`：把 Elem 方法按 WebIDL 语义嫁接到链的正确节点（setAttribute→ElementPrototype、appendChild→NodePrototype、contentWindow/src→HTMLIFrameElementPrototype…），主窗与 realm 双侧生效（defClass 带 srcProto 参数穿透模块边界）。

### 修复后链条状态（pinW23，全部实证）

- orchestrate：**首次完整 eval 通过**（无裸 TypeError）→ 建签 → pump 单次加载 api.js（去重生效）→ **Mt 标签校验通过**（isElem:true/csProto:true）→ **api.js 控制器在主 realm 完整上线**（注册 message 处理器 I）→ **解析 DraY9 并成功触发**（无 'Unable to find onload' 警告）。
- widget 消息投递现在真正到达控制器 I（此前 1 个监听器即 I）——I 因 `widgetMap` 空忽略（render 未调用的正确行为）。

### 剩余一环

orchestrate 收到 DraY9 后应调 `turnstile.render()` 注册 widget（controller 建 iframe）——本轮未观察到 controller 建 iframe。下会话两步：① api.js eval 后给 `window.turnstile` 套日志代理（旧代理在已退役的注入路径里）观察 render 调用与参数；② 若 render 未被调，step_debug 断 DraY9 之后的 orchestrate 等待（同方法论）。render 一旦走通：controller 建 widget iframe → realm 载荷（824KB）→ init/nextRcV → 桥调用 → execute → PoW（种子已知）。

### 状态

浏览器侧 cookie 已跑出（终稿十八）。离线复刻推进至"控制器在线、等 render 触发"。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

---

## 2026-10-24 17:00 终稿二十：stage-2 解码 = fo/ 响应 JS；等待环全清；进入 mismatch-reload 阶段

### 决定性解码

stage-2 脚本（round11 `scripts/f5a82ee…js`，3305B）头部 = `window._cf_chl_opt={cH:'<新令牌>'…}` + `window.THirw9/IXEYu6=…` ——**它就是 fo/#1 响应里被 orchestrate eval 的 JS**：重写挑战参数（新 cH 令牌）+ 定义全部会话桥。CNmxZ4 由它重置后由 orchestrate 按 push 管理。

### harness 实装结果（pinT3，全部实证）

按浏览器语义在 orchestrate eval 后立即 eval stage-2 字节（trace 捕获原件）：
- **桥全部定义**（coTgT4/AKECH4/XnuWO5/THirw9=function）+ cH 令牌重写 ✓
- **等待环 A/B 全部清除**（bridges 存在 + CNmxZ4 登记）✓
- orchestrate 进入下一阶段：**apiJsMismatchReload 自重载循环**——反复 createElement('script') src=chl_page 自身，且主 realm api.js eval 后 `window.turnstile` 未导出（MISS）

### 下会话两步

1. 查主 api.js eval 后 turnstile 未导出的原因：`(wr||(window.turnstile=xr))` 分支——'turnstile' in window 在 eval 时必须为 false（首次加载），若我们 env 残留 turnstile 则走 upgrade 分支不导出；同时抓 api.js 异步 boot（Li）的静默异常（unhandledRejection 已有钩子）。
2. mismatch-reload 的判定条件解码（api.js 源码 `apiJsMismatchReloadAttempts` 附近）——预期是我们 realm/标签状态与其期望不符；按 trace 修正。

### 状态

浏览器侧 cookie ✅。离线复刻：等待环清 ✅、桥定义 ✅、进入 render 前的 reload 阶段。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅（test 轮原始流已清，cell 2.9G）

---

## 2026-10-24 18:00 终稿二十一：widget 载荷已加载进 realm 并开始 boot

### 本轮达成（pinT8-13）

1. **架构真相**：浏览器里 widget iframe 由 orchestrate 自建、src 直接指向 `f/av0` 挑战页 HTML（267KB，含 payload）——api.js 控制器只管消息。harness 已按此接线：撤错误的 realm 住户（controller），iframe src=f/av0 → HTML 200 抓取 → **realm DOM 构建 + 272KB 载荷脚本在 realm 内 eval**（"api.js evaluated inside widget realm 261-272KB"）。
2. **realm 环境补齐**：atob/btoa/origin、可迭代 getElementsByTagName、walk 化 querySelector(All)/getElementById/getElementsByClassName。
3. f/av0 URL 实证可独立抓取（200/267KB，rch/<id> 段会话性待定——本轮用 round12 警告里的 URL 成功取到页面）。

### 当前挂点（单一）

载荷 boot 中 realm 查询返回 null（'null.classList'）——realm 树里 body 子树挂在解析出的 <body> 元素下而非 D.body（计数 0 的原因），且载荷的选择器目标未命中。修复=解析器把 <body> 子树挂到 D.body + 对账载荷首查询的选择器。

### 距离链条全通

载荷 boot 完成 → 按 round12 协议 postMessage init/nextRcV → orchestrate 桥/环自清 → execute → PoW（种子已知）→ challenge 完成 → POST fo/#3 → Set-Cookie。每一步的期望形状都有 trace 制品。

### 状态

浏览器侧 cookie ✅（终稿十八）。脱离浏览器：载荷已在 realm 内 boot，剩 DOM 查询语义收尾。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

---

## 2026-10-24 19:00 终稿二十二：载荷调用桥已证实，boot 死于未知对象缺方法

### 本轮实证

1. **realm DOM 解析修复**（body/head/html 正确挂接）+ realm 文档方法袋（createTextNode/Fragment/Comment/createEvent/importNode/adoptNode/elementFromPoint/hasFocus + `__docFire`）。
2. **f/av0 的 body 天生为空**（267KB 全是内联 script）——载荷自己 createElement 建 DOM；'0 nodes' 非缺陷。
3. **载荷调用 orchestrate 桥已证实**：错误栈出现 `Object.Mj [as ivcgo1]`——ivcgo1 是会话回调名，载荷内部调用了桥命名空间的函数。
4. document 无缺失成员（DOCMISS=0）。

### 当前挂点（单一，精确）

载荷 boot 计时器里 `x[ro][aS(...)] is not a function`（变量名每会话随机，evalmachine 1:186830）——**某个 realm 对象缺一个方法**，build 中断 → 后续 querySelector null → classList 崩。document 已排除；候选=W（window）或 navigator/performance/location 上的缺失方法。

### 下会话第一动作（两选一，均 ≤30 分钟）

A. realm W 级 MISS 追踪：`vm.createContext(new Proxy(W,{get(t,k){ if(!(k in t)) log('WMISS',k); return t[k];}}))` ——直接打出缺失方法名（需验证不影响 Sw/orchestrate 身份检查）。
B. Node inspector 局部变量转储（step_debug 同款）：断在 realm timer 错误处，`evaluateOnCallFrame` 读 x/ro 的实际对象与缺失属性名。

拿到方法名后补一行 realm stub，链条继续：载荷 boot → init/nextRcV postMessage → 桥/环自清 → execute → PoW。

### 状态

浏览器侧 cookie ✅。脱离浏览器：载荷 boot 阶段，缺一个方法名。`cf_clearance` 未拿到；①✅②✅③❌④✅

---

## 2026-10-24 20:00 终稿二十三：探针 A 完成—— realm 缺失面批量补齐，载荷逐层深入

### 探针 A 结果（W 级 MISS 全清）

| 缺失 | 修复 |
|---|---|
| parseInt/parseFloat/isNaN/isFinite 族 + Infinity/NaN | bootstrap ctxRaw 暴露清单扩充 |
| **Uint8Array**（realm 暴露清单漏项——只加了变体） | 补入清单 |
| TextEncoder/TextDecoder 等 Node 全局时序缺口 | bootstrap 后立即从 globalThis 镜像 |
| trustedTypes | createPolicy 默认策略 stub |
| 5+4 桥镜像到 realm window | 载荷在自身 frame 读 window.<桥> |
| canvas getContext 缺失（HTMLCanvasElement 不在 realm 类清单） | defClass + TAG_IFACE 补 Canvas + getContext 2d/webgl stub（按 round12 账本值）+ toDataURL |
| canvas stub 方法缺失类崩溃 | stub 升级 selfHeal 代理：缺方法→CANVASMISS 日志+no-op 返回 |

### 当前位置

载荷 boot 推进到**自身嵌套 VM 层**（错误列落在 SVG 数据串/不同 evalmachine 帧，`P[Zy][bQ(..)]` 型）。每轮错误列前移=逐层深入中。此阶段的循环方法：跑 → 抓错误列/栈 → 定位缺的 API → stub → 重跑。全部基础设施（探针/嫁接/自愈 stub/pump）已就位，剩余为同型迭代直至载荷 boot 完成 → postMessage init/nextRcV → execute → PoW。

### 状态

浏览器侧 cookie ✅。脱离浏览器：载荷逐层 boot 中。`cf_clearance` 未拿到；①✅②✅③❌④✅

---

## 2026-10-24 (session 2) 终稿二十四：调度链全图解码——六处根因修复，链路推进到 Gz 渲染门前

### 本轮修复（全部实证，按解码顺序）

1. **attachShadow/remove**（realm+主窗）：载荷 boot 的 iframe 检查 `Li.remove()` 缺失 → ELEM_GRAFTS 加 remove + makeAttachShadow（closed 模式 host.shadowRoot=null，ShadowRootPrototype 链=Node→EventTarget→Object，trace col 252319/199868/76651 证实）。
2. **pinned-api.js 污染**：mismatch-reload 的 live orchestrate 抓回后被存进 pinned-api.js（254882B 假 api.js）→ 只存 /turnstile/v0/*/api.js；**pinned-orchestrate 换成 round11 原件**（d7af3b58，261353B——旧 pin 是别的会话！）；chl_page 重载走**缓存语义**（round11 网络账本：orchestrate 只 GET 一次）。
3. **时钟门**：orchestrate 比对 Date.now()/1000 vs cITimeS，偏差>阈值渲染 "Incorrect device time" 并中止 → VM Date 平移到会话签发时间（值取自 opt.cITimeS，live 模式偏移≈0）。
4. **跨 realm 内建身份**：VM 迁入 sandbox realm 后轮询 window.Reflect / window.eval 直到等于自己 realm 的内建（100% CPU 自旋）→ 主窗镜像 VM 上下文内建（Date 除外，保时钟平移）+ eval 用 ctx 原生 eval。
5. **CNmxZ4 heal**：机器轮询 includes(<桥名>) 超时走失败 UI（注册方=被下游卡死的 api.js/握手链）→ 首次询问即注册（运行时观察，无硬编码；CNMX_HEAL=0 关）。**实证：CcZOJ8/rbNT3/UmGKr6 注册后 GE 立即建 api.js 标签 + GN 的 7 个交互监听器全注册**。
6. **error 事件派发**：VM 相位用裸 TypeError 作重试信号，浏览器走 window error 事件 → harness timer catch 派发给 error 监听器 → orchestrate 恢复链启动（eb/ POST 出现）。
7. **cookie jar**：Gz 渲染门 `parseInt(cookie[s()])>=50`，s() 映射 cType→cookie 名（interactive→cf_chl_rc_i / managed→cf_chl_rc_m / 默认 cf_chl_rc_ni，解码自挑战自己的表）。浏览器由页面响应 Set-Cookie 提供；我们的 fetch 被服务端指纹门挡掉收不到 → 主窗+realm 双侧真 cookie jar + 按解码名播种最小通过值 50。

### 调度链地图（本次解码成果，防重走）

```
eval → IIFE2(主boot: i18n/UI/sandbox检查/256字节表loop/class Hl)
     → Hl[aB]=runner 静态调用（[ct(qW.aB)](50闭包) 是永远 TypeError 的诱饵，浏览器同样抛+吞）
     → l[ct(qW.aC)]=runner（new Hl(HB).run(0,26,[]) — VM 解释器）
     → 定时报告 IIFE(24172) → eval 结束
tick(1s): !HKul9.QPUYE4 && !G3 && !navigator.X && now-Gb>1e4 ? tp() : G0()
  tp(): 计数器++ → W=true → Gn()；G0(): h('XnuWO5') 检查 → W!==false 才 tP()
  GI() 翻 QPUYE4=true（Ga/Gu 超时恢复路径，浏览器里也发生）
外层机器(17963): a3=setInterval重挂 → a5=GV()能力检查(全过) → t=atAFr0报告
  → ab=G(539269,GE,[]) 建标签 → ac=cookieEnabled → D=状态检查 → G=G(539269,Gz,[任务数组])
Gz=widget渲染器: tk=parseInt(cookie[s()]) 门 → 容器div+iframe+后续任务
GE=api.js标签(19584=createElement) → api.js eval 需要全局 r（stage2/VM 后续相位定义）
driver a(20807)=fo/ 请求器: open+timeout 5s*(1+重试)+onload 大状态机，门=includes('QDNrr8')（完成标记）
任务机器(15416): case h: setTimeout(a,100,tx,tC) 驱动 fo/ 拉取
```

### 当前精确挂点（三选一推进）

- **api.js eval 'r is not defined'**：r 由 stage2（fo/#1 响应 JS）或 VM 后续相位定义；fo/ 拉取靠任务机器 case h → 任务数组派发器（Gz 内部继续派发）未到达。defer 重试机制已就位（40 次上限），等 `r` 出现即过。
- **Gz 门后的任务派发**：case D 的状态检查（`_cf_chl_opt[tW]!==tc`）与 case G 之间的相位序列尚未全解码。
- **realm document 缺 ak(257) 属性**（s() 走 default 分支）——已用三名字播种兜底。

### 工具资产（全部可复用）

- **b4_sample.js**：CDP 前置断点（harness eval 行先断→urlRegex 断点编译时生效→放行）+ STEPCHAIN 步进 + STEP_EXPR/UP_EXPRS/TICK_EXPRS 帧内求值。**CDP lineNumber 是 0 基；prelude 有 3 个换行（VM 行=源行+3，源行1 并入 prelude 尾行=VM4）**。
- iife_trace.js（stepOver/stepInto 混合扫顶层路径）、machine_trace.js、coverage_probe.js（Node22 Profiler 不可用）、frame_dump.js（异常暂停+多帧转储）。
- SIGUSR1 动态开 inspector + Debugger.pause 抓运行中栈（抓到 Reflect/eval 自旋）。

### 状态

浏览器侧 cookie ✅（终稿十八）。离线复刻：调度链前 60% 全通（时钟/内建/桥/标签/GN/error恢复/cookie jar），挂 Gz 渲染门后的相位序列。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

---

## 2026-10-24 (session 3) 终稿二十五：VM eval 链修复+相位脚本自旋的精确位置

### 追加修复（继终稿二十四）

8. **env.window.eval=undefined 根因**：`vm.runInContext('eval', ctx)` 经由 loggedWindow 代理解析 `eval`，MISS 分支（'eval' in env.window 当时为 false）返回 undefined——**上下文自己的 eval 一直被代理遮蔽**，VM 的 tM('eval') 断言（typeof!=='function'→throw）因此炸。修复=直接赋 harness 函数（VM 的 eval 标识符与 window.eval 归一为同一可调用，身份检查自然通过）。
9. **realm eval 目标**：VM 迁入 sandbox realm 后调 eval，realm 的 W.eval 原实现每次 new 一个一次性空 context——相位代码被 eval 进真空。修复=eval 进 realm 自己的 ctx。
10. **tick 内禁 heal**：tp() 的门=includes('XnuWO5')（"握手完成则跳过"），heal 会把 tp 锁死 → __inTick 标志，tick 执行期间 includes 不 heal。修复后 GI 不再提前触发（无 REG set），tp 链全程存活。

### 当前精确位置（本轮终点）

VM 相位脚本（eval 进 realm 的动态代码）在自旋：fn=t@3:26750 ← G@3:26475 ← run@4:14820，locals B=1/P=48828/l=791/H=undefined。相位脚本是自己 eval 的代码（源码不在 pinned 文件里，url=''），其 poll 对象 t 与其自身的 Reflect 全局跨 realm 不一致。**下一步**：捕获相位脚本源码（realm-eval 的 code 参数全量 dump）+ 比对浏览器同相位（round11 ts 时间线的同段），确定 poll 对象应是哪个 window。REALMEVAL 日志钩子已加（W.eval 入口 dump code 前 160B）——本轮未触发说明 VM 的 eval 走的是主窗 page-eval 路径而非 realm eval，需确认 VM 的 eval 解析路径（direct eval 继承 VM 所在 scope=主 ctx）。

### 状态

浏览器侧 cookie ✅。离线复刻：调度链前 70% 全通（新增：VM 相位链不再 TypeError 中断、GI 时序正确化、realm eval 目标修正）。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

### 终稿二十五补遗（本轮最后捕获）

- **pageeval-dump.js**：page-eval 的 code 全量 dump 钩子已加（env.window.eval 入口 appendFileSync）。首次捕获：VM eval 的代码=`function AwUcP3(s){return function(k){...o[i]=k[i]^s.charCodeAt(i%s.length)...}}`——**XOR 解码器工厂**。VM 相位脚本=eval 进主 ctx 的动态代码；自旋（fn=t@3:26750←run@4:14820，locals B=1/P=48828/l=791/H=undefined）=VM 循环调 XOR 解码器等待数据匹配。
- **realm 内建共享实验**（W 上镜像主 ctx 内建）未解除自旋——poll 对象 t 不是 realm W，或比较的不是对象身份。**下会话第一动作**：①在 XOR 解码器调用点断点（pageeval-dump 的函数被调用处）拿 B/P/l/H 的真实语义；②dump 全部 PAGEEVAL code（本次只 eval 了一条；VM 后续相位会 eval 更多）；③比对 round11 同相位。
- disk 清理完成（pinX*/pinW*/live*/临时 dump 全清，FINDINGS+memory 为准）。

---

## 2026-10-25 终稿二十六：虚拟时间架构落地 + api.js 全链首次打通 + 卡点=V() 容器查询

### 本轮架构级变更（用户指示：时间全模拟不真实定时）
- **虚拟时钟+虚拟定时器队列**：V={now,base,q}，主窗/realm 的 setTimeout/setInterval/rAF 全部入队；pump 每 5ms 真实时间推进虚拟钟 100ms（队列空时跳到下一定时器），vDrain 清空到期回调；Date.now=V.now（pinned 平移到 cITimeS 基准）、performance.now=V.now-V.t0。60s+ 浏览器时间线毫秒级回放，全程确定性，CPU~1%。
- **PDUMP**：虚拟队列+glEe8+body 子树+未发送 XHR+V() 直测 的周期快照（20s）。

### 修复链（全部浏览器语义）
1. `document.cookie` 必须是 accessor（对象字面量赋值使 j() 的 cookie.split 炸）→ Object.defineProperty get/set。
2. `env.window.eval = eval`（host 原生 eval=页面 realm 的 eval——指纹 [native code]，VM 的 eval 轮询解除；一次性 context 版本使相位脚本真空自旋）。
3. api.js URL 正则 `/v0/(?:[^/]+\/)*api\.js/`（[^/]+ 只匹配一段导致 pinned 缓存/资源条目/readyState 全不触发）。
4. 脚本加载双集合：scan 去重（__scanSeen）≠ 已加载（__loadedSrcs）——共用一个集合使 scan 见过的 URL 永不加载。
5. `lenientProxy` src SET 源头捕获（__srcSetScripts）——树扫描漏掉 re-parent 的升级标签。
6. message `event.origin`=发送者真实 origin（targetOrigin '*' 只是投递过滤）——控制器 "wrong origin" 消除。
7. DOMException、Elem.replaceChild、window.removeEventListener、document.location===window.location+reload/replace/assign。
8. `Elem.querySelector/All` 真子树实现（id/class/tag，兼容 __id/attrs.id）——原 null stub 使 V() 永远 null。
9. `Elem.id` accessor（__id/attrs.id 后备）。
10. api.js 家族（含 _upgrade/_cb）pinned 缓存服务；fetch 20s 超时防 pump 卡死。
11. **自伤 bug**：pump 里 else 块外的 `r.text` 引用（harness 侧 ReferenceError 'r'）伪装成"等全局 r"300 次重试——改 respText。

### 链路状态（live 一致会话，虚拟时间）
eval→GE 建 api.js 标签→api.js eval ok（+资源条目+readyState complete）→**控制器上线（turnstile 导出、DraY9 触发=QBEM0=true、Gl 兜底取消）**→控制器版本检查→_upgrade 重载标签（源捕获→pinned 服务→三轮 eval 全 ok）→orchestrate 相位（error 事件驱动）→eb/ 遥测 POST→Gz 渲染门：`V()=_cf_chl_opt.glEe8.querySelector('#<容器id>')`，glEe8 由注册表处理器 R4 设置（live 实测=BODY）。

### 当前唯一卡点
V() 返回 null：容器 div（XWAst9 等）被 orchestrate append 进了 `[object Object]` 父节点（疑似 makeAttachShadow 的 sr——游离于 body 子树外；live 会话选择器需重新解码，round11 的 #XWAst9 不一定适用 live 表）。**下会话第一动作**：①live 字节上 b4_sample 解码 V() 的真实选择器（断 orchestrate V 函数或直接 vm 求值 `String(HKul9.MPUK6)` 源码）；②查 UI 容器的 append 目标（appendChild id 日志已加）并把 attachShadow/UI 树接到 body 可查询位置（浏览器语义：glEe8 查询得到容器）。

### 状态
浏览器侧 cookie ✅。离线复刻：调度链 90% 全通（虚拟时间+api.js 链+控制器 boot+Gz 门就位），卡 V() 容器查询。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

### 终稿二十六补遗（V() 门攻克）
- **id 登记表移到 proxy SET 层**（元素实现混杂：class Elem/plain object——VM 用的 document 返回普通对象，ctor:Object 实证；类 setter 只覆盖一半）。`Elem.querySelector('#x')` 加注册表兜底 → **V()=glEe8.querySelector('#XWAst9') 命中（got:true, DIV#XWAst9，PDUMP 实证）**。
- Gz 成功分支：`tD=V()` 真值 → appendChild+`setInterval(150ms,tK)` → tK 轮询 `_cf_chl_opt.glEe8...` 就绪后 `tz()`=任务机器 → `setTimeout(a,100)` 相位链。**尾点：Gz 在 eval 期只跑过一次（当时走了失败分支），V() 修复后需要外层机器重入再调 Gz**——重入靠 tick（G0/tp/W 状态机），下一会话从"tick 为何不再触发外层机器"继续（先查 W/QPUYE4 实时值 + tp 的 Gn 是否重派发 case G）。
- 工具增量：IDCHAIN/idElems/qs-reg/GLEE/appendChild-parent-tag/ctor 探针全部内建 harness；live 会话名字在表内反存（'9tsAWX'）。

### 状态
浏览器侧 cookie ✅。离线复刻：调度链 95%（V() 渲染门已过），剩 tick 重入 Gz→150ms 轮询→tz() 任务机器→a() 相位→execute→PoW→fo/→cookie。`cf_clearance`（脱离浏览器）未拿到；①✅②✅③❌④✅

### 终稿二十六终笔（完整闭环地图 + 唯一剩余环节）
- **tp/tP/GT 链实证运转**（bp 命中 tp@110394）；外层机器重入被 case D 一次性门挡死：eval 首跑设 `_cf_chl_opt.hXht2='d'` → 每次重入 `if(hXht2!=='d')…else return` 提前退出，case G（Gz 再派发）永不再达。VM 从未再调 V()（首个 #XWAst9 查询是 PDUMP 手动 V()——实证）。
- **hXht2 的重置者=api.js 控制器→注册表回调链**（trace 实证 'Object.Mj [as ivcgo1]'——控制器调 orchestrate 注册表的 ivcgo1 等命名处理器）。我们的控制器 Go(900ms) 在轮询其门，未发起注册表调用。
- **闭环地图**：控制器就绪→调注册表（ivcgo1/R4…）→orchestrate 相位重置（hXht2 等）→外层机器重入→case G→Gz（V() 现已可命中）→150ms tK→tz() 任务机器→setTimeout(a,100)→a() fo/ 驱动→execute→PoW→POST fo/→Set-Cookie cf_clearance。
- **下会话第一动作**：①解码控制器 Go(e) 的轮询门（断 api.js watchCatInterval/Go 函数，取其条件表达式）——它等什么，补什么（大概率=widget 握手或 orchestrate 桥就绪信号）；②或直接断注册表调用点（window.HKul9.ivcgo1 的调用者栈），从浏览器 round12 js 账本找控制器调 ivcgo1 的时点与前置条件对齐。
- 磁盘已清（zfinal.log 保留供下会话快速对照，可删）。

---

## 2026-10-25 终稿二十七:eval 域根因破案 + 三大根因修复 + 等待链真身(opt 会话键)

### 本轮修复(全部行为级,已落地 harness.js)
1. **env.window.eval = vm.runInContext('eval', ctx)**(替换 host eval 别名):host eval 是间接调用,把 VM 相位脚本 eval 进 Node globalThis——脚本的全局(Reflect/AwUcP3 工厂/MkvrI5 key)落在 Node 全局而 window 看不见,且脚本自己的 Reflect(Node 的)与 window.Reflect(主 ctx 的)永不相等 → VM 嵌套 run(5:6012→to→Hl.run)7.4 亿次 Reflect 身份自旋。ctx 原生 eval 指纹天然 [native code],相位脚本进 ctx,身份全对,自旋根除(SPINSTACK 消失)。
2. **V.t0 = V.now**(虚拟钟起点):pinned 平移把 V.now 移到 cITimeS 而 V.t0 还是真实钟 → performance.now()=V.now-V.t0≈-1.18 亿,**api.js 资源条目时间戳全负 → AH(entry) 的新鲜度门丢弃全部条目**。修后条目正值(responseStart=705 等)。
3. **__inTick 收窄到慢 interval(≥1000ms)**:原实现所有 setInterval 回调都置 __inTick=true → CNmxZ4 heal 对高频 VM 泵里的 includes 轮询全部失效。VM 泵(高频 interval,读 opt.CNmxZ4)恢复 heal 能力。tick(1s)的门检查仍然豁免(tp 不死锁)。
4. **globalThis 兜底 + 内建黑名单**(观测性防御):window 缺失键从 globalThis 兜底(同 realm 模型的正确投影),但内建/Node 内部名全部排除——曾把 window.Reflect 兜成 Node 的 Reflect 引发身份自旋,黑名单后无此路径。

### 等待链真身(对此前两轮的关键修正)
- **coTgT4/AKECH4/XnuWO5 都是 `_cf_chl_opt` 上的会话键**,不是 window 全局!harness 的 BRIDGE 日志打印 window.coTgT4 一直是打错位置(浏览器从未读 window 级)。h(name)=`l[opt][XnuWO5] && l[opt][XnuWO5][method](name)`(@2:107809),G0 门=`if(h(ak(927)))return`。
- **名字表在字节内固定**(z/a3/a6 解码,跨会话同名:coTgT4/XnuWO5/AKECH4/DraY9/QBEM0/ivcgo1/HKul9/XWAst9),但每代字节混淆后槽位编号和局部变量名不同——调试工具可用会话名,补丁不可。
- **tick 三元真身**:`!(!window.coTgT4 && !Bh() && !opt.hXht2 && 超时10s) ? n1() : By()`——n1=一次性启动器(p 标记,首次调 Bs 外层机器),By=超时兜底。tick 每秒空转是 n1 的 p 已置位,**正常**,不是卡点。
- **GZ 的触发不靠 tick 重入**:浏览器账本 api.js eval 微任务序列(Wi/Su/Mt 标签校验→cu 升级检查→params forEach→Dn)后 1μs,GZ/<(async 前半)带 body 参数 resume(152619),GE/Gl<、tW、Gn(交互监听注册)相继重入。
- **VM 泵=interval(5:2069 等价位,高频)驱动 Hl.run**,读 opt.CNmxZ4.includes(名字) 轮询——浏览器 eval 后全程自旋(+2.9~58s,10.6 万 enter),我们 400/s 活着但只轻轮询。

### 浏览器 vs 我们(决定性差异,当前唯一前沿)
- **浏览器 +13.8~35s:5000/s 密集 VM 计算相位**(anonymous@2:81001×550 / 11163×489 等簇),**35.0s 簇停止=等待解除**,35.2s h('XnuWO5') 返回 '278'(opt.XnuWO5 已写入且 truthy)→ G0 提前 return。
- **我们:VM 泵 400/s 轻轮询 includes(XnuWO5)=false 永等**(不强制 heal 时 3000+ 次 false;CNMX_FORCE=XnuWO5 可越但走偏路,进入等 opt.AKECH4 的新等待——浏览器 round11 从未读 opt.AKECH4,是偏路产物)。
- **结论:缺的是 13.8~35s 那段高频计算相位的启动**。该相位由 eval 后某事件触发(候选:VM 泵内部状态推进/某资源条目/realm 内派发),21 秒计算(疑似密钥/PoW 预计算)完成后写 opt.XnuWO5。REALMEVAL 零次=VM 从未把相位脚本 eval 进 realm(浏览器有嵌套 Hl.run,主窗+realm 双 VM)。
- 附带收获:Gz 真名函数在 live 字节里就叫 Gz(4:67222),GZ 失败会 AC(类型断言)→TypeError→eb/ 遥测——这些 TypeError 是 VM 相位正常重试信号,不是死结。

### 工具增量(全部已入 harness/frame_dump)
- HARNESS_MISS_STACK=<name|*>(MISS 栈/指纹分布)、HARNESS_KEY_STACK=<key>+HARNESS_KEY_EVERY(存在键的读取栈采样)、HARNESS_OPT_FIELDS=1(opt 字段读取计数,CNmxZ4/AKECH4 高频直读可见)、MKENTRY/ENTRY(条目制造与 AH 字段读取观测)、SPINSTACK(WGDUMP 自计数器首触发的同步自旋栈)、CNMX_FORCE=<name>(单名强制 heal,一次性观察)、frame_dump 的 tM/Gz 帧捕获+变量 dump(TF/HH/Hp+window[HH])。
- js-reverse MCP(会话已装)是浏览器 CDP 向,不能连 Node inspector——当前 Node 离线调试用不上;将来做真浏览器对照(断 cell.com 的 opt.XnuWO5 写入点)时正好用它。

### 下会话第一动作
浏览器 +13.8s 起 5000/s 计算相位的**触发事件**是什么(在 round11 账本 +10~14s 窗口找非 a6/G/t 的新函数首现时刻与其 parent),对齐我们环境补上该触发;随后 21s 计算相位在虚拟时间下应毫秒级完成(纯 JS,无真实等待),写 opt.XnuWO5 → G0 门过 → GZ(容器已通)→ iframe → fav0 → opt.AKECH4 → PoW → fo/ → cf_clearance。

### 状态
浏览器侧 cookie ✅。离线复刻:eval 域/时钟域/heal 域三大根因已修,VM 身份自旋根除,api.js 条目时间正常;卡 eval 后高频计算相位未启动(opt.XnuWO5 无写入者)。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

### 终稿二十七补遗(任务链拼图,本轮最后解出)
- **3500ms 兜底回调真身(pinned 代全文)**:`function(f8,az,tq,tk){...tq[ax(163)]=ax(164),tk=tq,tW(tk[ax(163)])}` = **tW(名)**。
- **tW(name)=`Object.keys(tz).includes(name)||(tz[name]=[]); tz[name].push(任务)`**(源行3 col30493)——**任务注册器**;紧邻的 `l[opt][ak(qX.K)]=fn` 是任务分类器(f/N 分支);Gx=任务/计算机器。
- **opt.AKECH4=任务/数据槽**(p5 OPTFIELDS:169/s 高频读;push 是数组变异不触发 OPTSET)。**VM 泵轮询 opt.AKECH4 等任务,有任务→new Hl(HB).run(0,26,[])=计算 VM**(浏览器 13.73s run@2:9386,21s 计算至 35s 写 opt.XnuWO5)。
- **eval 期主机器链(浏览器)**:eval 尾(4.79s)anonymous@2:17386 启动(parent=native timer=3500ms resume),`l[opt][aC]=function(HB){new Hl(HB)[run](0,26,[])}` 注册计算回调;主机器 9s 静默(await)后 13.73s 调 run@2:9386(VM 主解释器,计算相位)。
- **我们现状**:3500ms tW 注册任务 ✓(p7),VM 泵读 opt.AKECH4 ✓(2538 次)但**不消费**——消费分支内部的门(j@5:5466 形态 `R[1086][1087](oV)` 调 AKECH4 的方法)未过。eval 期 opt 全部 35 次写零函数类型(opt[aC] 回调注册未发生——与 17386 机器未启动一致,它由 3500ms resume 触发)。
- **下会话第一动作(更新)**:断/观测 VM 泵对 opt.AKECH4 的方法调用(p5 栈:VM 泵 j@5:5443/5466 → R[118][1086] 形态;用 OPT proxy 把 AKECH4 的 get 返回值包成带日志 proxy 或 frame_dump 断 j),解码消费门的真实条件(任务格式/名字匹配/数组形态),对照浏览器 tW push 的任务结构补齐——补上即:任务消费→计算相位(虚拟时间毫秒级)→opt.XnuWO5→G0 门过→GZ(容器已通)→iframe→fav0→opt.AKECH4(载荷写)→PoW→fo/→cf_clearance。

---

## 2026-10-25 终稿二十八:真浏览器断点实证(fo/#1 现场快照)——桥注册结论作废,fo/#1 不依赖桥

### 方法(js-reverse MCP 实战验证通过)
clear_site_data → reload → `break_on_xhr('/h/b/fo/')` → 断住立即 `evaluate_script` dump `_cf_chl_opt` → remove_breakpoint + resume。断点拖 ~2 分钟流程仍活(fo/ 重试强),但按用户要求每轮快取快放。orchestrate script eval 后被引擎丢弃,**事后 search_in_sources 搜不到,必须在挑战窗口内操作**;`(0,26,[])` 等源码特征同样搜不到(GC)。

### fo/#1 断住时刻的 opt 快照(全量,XHR 断点栈 s@chl_page:3:32200,VM 泵 async 顶层)
- **CNmxZ4 = 空数组(arr[0])**——**桥零注册**!
- **无任何 XnuWO5/AKECH4 类会话键**(此代字节这些名字根本不存在)。
- **jLEVv0 = arr[6]**,首任务 {OROhR9:'https://www.cell.com/', JeJZR2:0, xYfm0:225, ePsF3:0, TypqR7:390,...}(页面度量/任务数据;我们离线 eval 后也有 4 个 push——形态一致)。
- hXht2='d'、buiX8='managed'、glEe8=空 obj、BuWQ0={LQfqz0,toJSON}、bwDXz7=i18n 文案表(bHyYk2/uGhU3/... 是文案分组键,不是桥名)。
- 断点闭包:fo/ 请求器带重试函数 `Zw++,Z(458063,s,[wv,wK,wN+1])`(wv=fo/ URL,wN=重试计数);名字表 z(1546)/a4(1536),y($i)=$i-252 反转解码,a5($i)=a4[$i]。

### 颠覆性结论
1. **"桥注册(CNmxZ4 includes)是 fo/ 前置"被证伪**:浏览器 fo/#1 发出时 CNmxZ4 空、无桥。我们离线卡的"VM 等 includes(XnuWO5)"是 **fo/ 之后的阶段**;fo/#1 走的是不依赖桥注册的路径。
2. **名字表结构+会话名每代字节全变**(z/a4 表大小、键名、解码偏移都变;XnuWO5/AKECH4/coTgT4/CcZOJ8 只是 round11 一代的名字)——**"名字表字节内固定"结论作废**。多代同名是同模板混淆的巧合。**行为级补丁是唯一正路**(与用户方法论一致)。
3. **真实时间线(本轮实测)**:orchestrate GET → **0.6s → fo/#1(主域)** → f/av0 iframe → fo/(iframe 域) → pat(401)/brunhild i(204)/ci(image) 遥测 → fo/ 终(主域,**set-cookie cf_clearance**) → precursor(main.js → precursor POST,**二发 cf_clearance**)。round11 的 +107s 是 trace 注入拖慢,真实只需 0.6s 到 fo/#1、~5s 全通。
4. **离线新焦点**:我们 eval 后只有 eb/(错误遥测)没有 fo/#1——分叉在 eval 期(泵走错误分支 vs fo/ 分支)。

### 下会话第一动作
①再次浏览器断点(clear→reload→XHR 断 /h/b/fo/),断住时 step/evaluate 拿 s 帧完整 locals(wK/wb/wA/wd/wr/wu 值语义)+ 单步 2-3 帧看 fo/ 分支的判定条件;②对照离线泵的 eb/ 分支(同一台机器的错误路),找出"错误分支 vs fo/ 分支"的分叉条件(大概率是 eval 期某环境检查结果),补齐后离线直发 fo/#1——**fo/#1 不需要桥注册,离线卡了几轮的桥等待其实都在 fo/ 之后的阶段,先拿 fo/#1 是更短路径**。

### 状态
浏览器侧 cookie ✅(断点拖 2 分钟仍全通,重放方法论可靠)。离线复刻:三大域根因已修(终稿二十七);桥注册叙事重构,新焦点=eval 期 fo/#1 分支。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

---

## 2026-10-25 终稿二十九:Proxy-global 掘墓——contextify 被劫持是三代根因的总闸;GZ 成功分支首次打通

### 决定性单测(一句话根因)
`vm.createContext(Proxy(sandbox, {get, has}))` 下 `runInContext('eval'/'Reflect')` 返回 **undefined**;plain sandbox 下正常。**Proxy 做 ctx 的 global 时 V8 contextify 不注入词法内建**,所有内建解析退化为 proxy 属性读(MISS→undefined)。这解释了此前的全部三代病症:
- window.eval undefined → lu/tM 断言炸(eb/ 错误分支)
- window.Reflect undefined → VM 身份比较永假(7.4 亿次自旋)
- 相位脚本产物(AwUcP3 等)无处安放

### 修复(三步,已落地)
1. **ctx 的 global 用 plain env.window**(`vm.createContext(env.window)`):contextify 正常注入内建(env.window 获得真内建 own 属性=镜像的目标自动达成);观测 proxy(loggedWindow)退役为诊断用,不再做 realm。
2. **has-trap 教训存档**:观测 proxy 曾无条件 `has:()=>true`——即使 get 层修好,has 全 true 也会把内建解析劫持到属性层。任何 future proxy-global 必须 `has:(t,k)=>k in t`。
3. **eval 前镜像清单保留**(plain ctx 下自动有效)+ window.eval=ctx 词法 eval(现在能取到)。

### 效果(r4-r8 实证,一次跳 N 层)
- **零 THROW**(lu/tM TypeError 断言链消失——eval 期分叉根除)
- **GZ 成功分支首次执行**:cookie 门过(50→51)→**第二个 iframe(width=0,height=0,sandbox=allow-same-origin)创建**→realm 2 建立→UI 到 "Verification successful. Waiting for www.cell.com to respond"
- **进入计算相位**:CPU 满载,CPU profiler 热点 = to@5:56493(async 机器步进 2130x)+ tz@5:66413(任务机器 1367x)+ G@4:26295(Reflect.apply 1111x)+ lp/l1/tN——**外层任务机器在密集计算**(浏览器 13.73~35s 计算相位的等价物;解释执行慢数倍,>60s 仍在跑,是否终止待 5 分钟长跑验证)。
- queueIframeLoad 尚未被调(第二 iframe 的 fav0 加载在计算完成后进行——浏览器顺序:计算(35s)先于 widget iframe?否——浏览器 GZ 建 iframe 在计算前……我们顺序=GZ(iframe)→计算:VM 先建壳再算,与浏览器一致)。

### 工具增量
- prof2.js(--inspect 早期 CPU profiler;注意 --inspect-brk 在 Node22 需 Debugger.resume 且 profiler 期间 resume 响应可能饿死,直接用 --inspect 不断点)。
- realm W 自旋计数(RWGDUMP,自 trap dump);FAV0EVAL 埋点(inline eval 计时)。
- frame_dump 的 164 行断点因 harness 行号漂移会绑错帧——埋点日志比行号断点可靠。

### 下一步(取决于 5 分钟长跑)
- 计算完成→FAV0EVAL(inline 258KB 进 realm 2)→载荷 boot→握手→PoW→fo/→cf_clearance。
- 不完成(死循环)→profiler 热点+断点 to/tz 内部,找循环退出条件(对照 opt 数据/任务形态)。

### 状态
浏览器侧 cookie ✅。离线复刻:**GZ 成功分支+widget iframe+计算相位已通**(此前卡在 eval 期分叉),现处计算相位执行中。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

---

## 2026-10-25 终稿三十:VM 死循环特征化完成(pc 1121-1258)+ 真实数据管道打通;前沿=字节码反汇编

### 本轮验证链(s1-s14)
- **关 heal(CNMX_HEAL=0)同卡**→排除 heal 干扰。
- **CPU profiler 调用树**:to@5:56493(async 步进,2130x)← HP.<computed>(Ht 适配器)@5:5993 ← lR@5:60093 ← G@4:26295 ← HP@5:11359 ← to(自嵌套)。to 是 async 机器 reducer、G=Reflect.apply、lR/lp/ly/lv=VM 指令 handler(全部混淆 jump-table,静态读法无效)。
- **VM 主解释循环定位**(run@5:16020,for 头@14635):`for(;Hv.length!==BT+BT;){pc=HB[HY];...switch(混淆分派)}`——Hv=操作数栈,HB=寄存器文件(pc 在 HB[HY])。
- **stepOver TRAIL**(断点+单步记录 opcode 列):14635→14667→14679→14699→14746→14782→14792→14866→(14899)→跳回 14635。
- **VM_TICK instrumentation**(scriptSrc 注入计数,锚点 `let HT=HB[HY];` 全字节唯一):**pc 周期=1121→1258 循环,周期 1800 万 tick**;栈恒 [undefined,undefined,arr];**HB[HI](寄存器0)=GZ 的 iframe 元素(HTMLIFrameElement)**。
- **浏览器对照(断点实测)**:GZ iframe **src=""(空)同我们**,w/h 空——fav0 不是经 src 加载,orchestrate 自己填充。
- **真实数据管道**:browser-perf-entries.json(fo/#1 时刻 5 条真实条目:orchestrate/api.js/favicon×2/navigation 完整时序)→ 种子(真实存在时压制旧合成种子)→ **任务值已真实化**(291,324,103070 / 0,1,0 / 3058,0,0 / 3071,0,0 / 1,248,3896)。api.js 条目 push 进 buffer(浏览器语义)已补。
- **fav0 autofeed**(realm 2 创建时 setImmediate 喂 pinned fav0)实现但**死锁结构确认**:VM 同步循环占死主线程→setImmediate/queueIframeLoad 的异步永远不跑——**浏览器里 VM 循环必然有 yield 机制(指令层),我们没有触发**。
- **VM 死循环期间**:realm 2 的 W 零访问(RWGDUMP/WMISS 空)——VM 拿着 iframe 但不读 realm window;操作数组的对象槽 keys=[1,6,7,9]。

### 结论与下轮前沿
- **唯一卡点=VM 字节码程序在 pc 1121-1258 循环不退出**(栈长锁 3,退出条件 Hv.length===N 永不达)。浏览器同字节码几毫秒退出——**它等/yield 的机制在指令层,需反汇编**。
- **下轮第一动作**:修 VMBYTES instrumentation(本次 patch 未生效——旧 instrumentation 分支还在文件里,先清理成单版本),dump HB[1100:1270] 字节+寄存器名表,对照 run 的 case 分派表逐条反汇编 137 字节循环体,找退出比较读的值;再对照浏览器(同 VM 用 js-reverse 在 fo/#1 前断点采样其 pc/栈演化)。
- 备选快路:VM 循环体若在读数组 [1276,160,{1,6,7,9},2] 做几何/布局判定,喂真实值可能直接过。

### 状态
浏览器侧 cookie ✅。离线:GZ 成功分支+widget iframe+真实数据管道全通;卡 VM 字节码循环(已特征化到 137 字节窗口)。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

---

## 2026-10-25 终稿三十一:**死循环破案+载荷首次 boot**(eval 身份归一)+ 真实 init 协议发声

### 死循环根因(终稿三十的 VM pc 1121-1258)
VMLOOP 的 VMSTACK dump 破案:**VM 相位数组里同时装着两个 eval——`{o:'function eval() { [native code] }'}`(ctx 词法)与 `{o:REALMEVAL 包装}`(realm W.eval)——VM 比较二者身份,永不相等→for(Hv.length!==N) 永不退出**(1.1 亿 tick 实测)。
**修复**:`W.eval = env.window.eval`(realm 与主窗归一同一可调用,相位脚本与全局落主 ctx,身份恒等成立)——**一处改动,死循环立即消失**。

### 修复后链路(t2,历史最远)
- VM 死循环除→**GZ 成功分支→widget 壳 iframe→fav0 载荷 258KB boot 成功**(FAV0EVAL eval done 7ms,realm 2-6 递进)
- **载荷真实发声**:`postMessage {source:'cloudflare-challenge', widgetId:'h14dt', event:'init', mode:'managed', nextRcV:'jvTXF...'}` + `requestExtraParams`(round12 协议原样!)——init 重发 12 次
- eb/ POST 真发(body=1036B);UI 走到"verification"态;HTTP 层 fav0 live 抓取 3 次成功(268/279/266KB)
- **init 无人认领**:api.js 的 message 处理器 I:`if(widgetId===''||widgetMap.has(widgetId)){...}`——**widgetMap 空没有 h14dt→静默丢弃**。widgetMap 唯一填充点=turnstile.render() 内部(api.js 75889 区,widgetMap.set 后 watchcat/fn 启动)。**orchestrate 从不调 render(t2 TURNSTILE 零调用,只读 constructor)**。

### 前沿(下一环)
- **谁调 turnstile.render(浏览器)**:主 suspect=**fo/#1 响应的 stage2 JS**(浏览器时序:VM 计算(0.6s)→fo/#1→render→widgetMap→载荷→握手→PoW→fo/ 终→cookie)。我们 **fo/#1 未发**(VM 计算后的下一步没走)——t2 的 GZ/autofeed 链可能抢跑(autofeed 是诊断 hack)。
- **行动**:①离线去掉 autofeed,看 VM 计算完成后自然的下一相位(应发 fo/#1:XHR open 带 URL(opt 拼)+body);②浏览器侧用断点验证 render 调用者(api.js 的 render 内部文本 'Turnstile Initialization Error'——需在挑战窗口内装断点,XHR 断点对 script 标签无效,js-reverse 的 text 断点只认已加载源;可用 fo/ XHR 断点断住时装 text 断点再放行,render 若在 fo/ 后调用即可命中)。
- 备忘:浏览器 GZ 壳 iframe src=''(空)与离线一致——载荷不经 src 加载,由 render/填充流程注入;widgetId=fav0 URL 的 build 段(h14dt)。

### 状态
浏览器侧 cookie ✅。离线:**eval 归一除死循环+载荷真实 boot+init 协议原声**——离最终 cookie 只差"render/控制器认领"一环。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

### 终稿三十一补遗(收尾快照)
- 撤 autofeed(HARNESS_AUTOFEED=1 才启用)后自然相位:GZ 建完 widget UI(WlHX2 树),VM 转**慢轮询 includes(XnuWO5)=false(3.7/s)**,无 fo/、无载荷——确认 autofeed 是载荷 boot 的唯一来路,自然路径 VM 计算后等 XnuWO5 而浏览器 0.6s 就发 fo/(分叉条件未定位)。
- CNMX_FORCE=XnuWO5(无 autofeed)同样只 eb/——force 不解锁 fo/。
- **关键数据制品**:browser-fo1.json(浏览器 fo/#1 完整:URL+requestBody 2338B 的 $ 分段 base64-ish 编码=VM 计算产物+timing+headers);browser-perf-entries.json(fo/#1 时刻 5 条真实 perf 条目)。
- eb/ body(1036B)与 fo/ body 同编码($ 分段),内容不可直读——错误原因无法直接解。
- js-reverse 实战补充:XHR 断点对 `<script src>`(api.js)无效;text 断点只认已加载源;mainWorld evaluate 在挑战页 turnstile 出现前装 hook 会被挑战完成的跳转清掉(sessionStorage 中转也死于 interval);每轮重放 3-5 秒全通,工具链要一气呵成。

---

## 2026-10-25 终稿三十二:fo/ 发射链全线解码——RTC(createOffer.then)+ window.fpwv7 等待门

### 浏览器断点实锤(fo/#1 现场 stepOut+栈)
- **fo/ 的 XHR.open 发生在 RTCPeerConnection 回调链里**:栈=`eval 相位脚本:3:49 ← eval:3:157 ← eval:21:7 ← RTCPeerConnection.<anonymous>@2:15152`(三层 VM eval 相位脚本嵌套在 createOffer 的 .then 里)。
- **round12 bom 账本确认 RTC 形态**:construct → `createDataChannel('')` → `createOffer(options)`(promise.observe=await)→ close(主窗+iframe 载荷各一轮,iframe 侧还读一次 iceGatheringState)。**无 onicecandidate 事件**——指纹材料=offer(SDP)。
- **浏览器 fo/#1 时刻快照**:CNmxZ4=空、iframe=0、tasks=6(含 api.js 条目 0/2/18/0/27978)、turnstile._private 就绪——**fo/ 与桥注册/iframe 完全无关**。
- **任务已 6/6 全对齐**(离线 FINAL dump:orchestrate/api.js(27978!)/favicon×2/主文档 + mkResourceEntry 的 api.js;与浏览器逐字段形态一致)。

### 离线修复(已落地)
- **RTCPeerConnection 浏览器化**:createOffer 返回 resolve(Firefox 形态 SDP:随机 ice-ufrag/pwd+模板 fingerprint+sctp-datachannel m 行),iceGatheringState='complete',close 打日志,createDataChannel 返回 readyState:'open'。链未到达(VM 还在前置等待)。
- 槽位解码(HARNESS_VM_TICK 的 NAMES dump,pinned 字节 al() 运行时解码):118=**fpwv7**、939=YODI6、250=cOgUQuery、300=YSwJ0、222=Mfpwg0、990=AKECH4、991=coTgT4、24=_cf_chl_opt、23=now。

### 当前精确卡点(单一)
**VM 泵的等待轮询 j=`window.fpwv7[子键] && ...[方法](名)`——window.fpwv7=undefined**(opt.fpwv7=0 number 存在但不在 window 上)。浏览器里 window.fpwv7 必然存在(VM 此门瞬过才能 0.7s 到 fo/)。**下一动作:浏览器断点读 window.fpwv7 的真身**(值/类型/谁挂的——大概率 orchestrate eval 期或 api.js 挂的会话对象),补齐形态→VM 泵过门→计算相位→createOffer→fo/。
- 辅证:v5(force XnuWO5+新 RTC+6 任务)仍只有 eb/——门在 fpwv7 链上,XnuWO5/AKECH4 只是名字表里不同槽的轮询表象。

### 状态
浏览器侧 cookie ✅。离线:fo/ 发射链全图在握(RTC.then→XHR open),任务 6/6 对齐,RTC stub 浏览器化;卡 window.fpwv7 等待门(一环)。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

### 终稿三十二补遗(force 生效实证+浏览器会话全局金表)
- **浏览器 fo/#1 时刻 window 会话全局金表**(断点 dump):HKul9(注册表)/LeviO5=30/QBEM0=true/**dSvRK1=[null,null,null,null]**(4 槽 VM 数组)/lffN9='qCZq4'/**qrht8=['token$/token'](1 元素编码数组)**/nTlR0(8 键容器)/xrbo0(9 键容器)/MpSwI7(空 obj)/vMhC1=-11/vyix0=false/vvfHL3={}。
- **离线对照几乎全同**(连 lffN9='qCZq4' 同值):差异=qrht8 我们 3 元素(浏览器 1)、vMhC1 -605 vs -11、vyix0 true vs false、**缺 xrbo0(9键)与 MpSwI7**。
- **CNMX_FORCE=XnuWO5 实际生效**:includes #1 false→注册→#7+ 全 true(此前误读日志)。**VM 过 XnuWO5 门后**:`lM: Cannot create proxy with a non-object as target`(@5:21834←Hl.run←to,2 次被吞)——VM 相位给某 undefined 值 new Proxy(指纹检测/包装);泵继续轮询 includes=true(55 次)但未达 RTC——**同循环还有下一个未满足条件**(此前 p5 观察 opt.AKECH4 高频读)。
- fpwv7 探针(HARNESS_FPWV7=1 seed 容器)无效——VM 0 次读 window.fpwv7,**NAMES 槽位解码系误读**(al 在注入作用域非解码器)。

### 下一步(未变,更聚焦)
VM 泵同循环的下一条件(候选 opt.AKECH4 或 lM 的 Proxy target 值);frame_dump 断 lM 的 new Proxy 行读 target 实参即知缺哪个全局。

---

## 2026-10-25 终稿三十三:lM Proxy 错误定性(apply-trap 包装)+ AKECH4.join 轮询模式 + 空 eval 轮询

### lM Proxy 错误(frame_dump 捕获,定性=噪音或小缺环)
- 栈:GZ(6:17922)→5:6041→HP→to→Hl.run→lM(@5:21833,源行2 col 0基21832=case Hh[d7(oB.m)] 区)。
- **操作数栈=["undefined", {apply:Object}]**——VM 执行 `new Proxy(某函数, {apply})`(apply-trap 函数包装,反检测/监控技术);target 该是函数但 load 成 undefined。寄存器文件几乎全 0(新 VM 实例)。
- 错误 2 次被吞,VM 继续;orchestrate 全局错误 handler 打 `[Cloudflare Turnstile] Unhandled error ... with debug info: <qrht8[0] token>`(错误链活着)。
- navigator.sendBeacon/scheduling + window.speechSynthesis/MediaSource/Worklet 已补(浏览器有我们缺),未消除该错误——target 另有所指。

### VM 泵等待模式(OPTPROXY 迁移到 plain ctx 后重新可见)
- **CNmxZ4**:includes(485)+索引 0-5 遍历(0:267,1-5:~28)+toJSON+push6;**AKECH4**:valueOf/toString/**join 各 237 次**——VM 每圈序列化 AKECH4 与 CNmxZ4 内容做比较(等计算输出写入)。seed arr/arrok/obj 三形态读取数不变(内容比较,非存在性)。
- **phase-evals.log(HARNESS_PHASE_DUMP=1)**:504 次空白 eval(42/s,VM 的 eval 存在性轮询)+1 次 AwUcP3 XOR 工厂(正常)。VM 相位机器的"真代码"不经 window.eval(在 VM 字节码内解释,不 eval)。

### 工具增量
- OPTPROXY(plain-ctx 模式 opt 观测:OPTFIELDS/OPTARRSUM/OPTSET 全恢复);PHASE dump(eval 观测);HARNESS_AKECH4(seed 探针);PROXYSPY(ctx Proxy 构造观测,本轮 install 未生效待查)。

### 下一步(聚焦两选一)
A. **lM apply-Proxy target 溯源**:给 window 的函数属性装一次性 getter 探针(错误前谁被读成 undefined)——或 PROXYSPY 修复后直接看 target。
B. **AKECH4 内容破译**:VM 每圈 join(AKECH4) 比较预期串——浏览器 fo/ 前该键(round11 名)由计算写入;**从 round11 账本找该键首次写入的值形态**(js 账本 return 值)照抄内容。

### 状态
浏览器侧 cookie ✅。离线:fo/ 链全图+数据 6/6+多观测器恢复;卡 VM 泵内容比较环(AKECH4.join)+lM apply-Proxy target。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

---

## 2026-10-25 终稿三十四:TextEncoder 崩溃修复(host 兜底镜像)+ VM 基础设施解码(字节码/对象池/指令 l7)

### 修复(已落地)
- **TextEncoder ReferenceError**(VM 直接 eval 的相位脚本开场崩,frame_dump 首次捕获):**contextify 不注入非标准内建**(TextEncoder/TextDecoder 等 Web API)——镜像循环里 `runInContext(n)===undefined` 的键全部跳过了。修=**host 兜底**(`v===undefined && globalThis[n]!==undefined` 时用 host 的)。修后 TextEncoder 错误消失。

### VM 基础设施解码(frame_dump 寄存器 dump)
- **VM 实例结构**:r1=**字节码 Uint8Array**(指令流)、r4=**对象池 Array**(load 源,内含对象/函数槽);操作数栈=[undefined,{apply}] 时 apply-Proxy 的 target 即来自池中 undefined 槽的 load。
- **iframe 建立者=VM 字节码指令 l7@5:36024**(IFRSET 栈实证:l7←Hl.run←to←HP)——**不是 GZ 函数**(GZ@l3:7181 的 jump-table case 打点全程零触发,7181-18560 区的 case 从未执行)。浏览器"GZ/<"帧的调用链与我们 VM 泵同构,只是名字误导。
- **PROXYSPY 修复启用**(模板字符串缺右括号):确认 target=undefined+keys=apply,**构造点=evalmachine:1:337**(VM 直接 eval 的相位脚本,栈 `new <anonymous>(evalmachine:1:337)←lM`)。**词法直接 eval 无法用 window.eval 观测器拦截**(PHASE dump 只见 489 次空白轮询)——需断点(Debugger.setBreakpointByUrl urlRegex evalmachine;本次 col 漂移抓到 harness 自身 Mt probe,待按 scriptId 精确匹配再抓)。

### 当前卡点(单一,精确定位到列)
**VM 相位脚本(evalmachine:1:337)里 `new Proxy(某函数, {apply})` 的 target=undefined**——该函数从 VM 对象池(r4)load,池中该槽 undefined。**抓到相位脚本全文+池槽位对照即破**。

### 状态
浏览器侧 cookie ✅。离线:TextEncoder 崩溃修复+VM 基础设施(字节码/池/指令)解码+PROXYSPY;卡 apply-Proxy target(相位脚本:337)。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

---

## 2026-10-25 终稿三十五:apply-Proxy 修复成功(qrht8 归一)+ fo/ 发射帧参数捕获 + runProgram 全文

### 离线修复(全部落地)
1. **WSET 观测器复活**(plain-ctx):Proxy(env.window) 在 contextify 前挂 set-trap(HARNESS_WSET=1)。**函数全局 20/20 与浏览器全对齐**(THirw9/IXEYu6/nOLY0/DraY9/uEeN6/AwUcP3/MkvrI5/AGRfA7/qpPe1/atAFr0/SABtz7/FIac3/RpzJz6/QSqpx9/ueZh9/FBBK4/ZliED2/NmGWd6/vUAjb0/zCGb4),差异仅 runProgram(浏览器本代未导出)。
2. **apply-Proxy 修复**(HARNESS_LM_FIX=1):lM case-q 探针实证 Hp=Proxy 构造器(合法)、Hf[1]={apply} 合法、**Hf[0]=UNDEF**——lo=Reflect.construct(实锤,LOSRC=function construct()),即 `Reflect.construct(Proxy,[undefined,{apply}])`。**stub Hf[0]=function(){return 1} 后**:
   - `Cannot create proxy` 错误消失(0)
   - **qrht8 3→1 元素(与浏览器金表一致!)**
   - **vvfHL3 0→3 元素** ['.eGISn6','.HGDZ8','.AaOL8'](UI 错误链选择器,浏览器同款)
   - T550 机器 1120+ 圈零异常运转
3. **550ms wrapper bug 修复**(patch 里 V.q.set 用了未定义的 d/a,13224 次注册零执行→vSchedule 修正后 460+ 次真实执行)。
4. TextEncoder host 兜底实证有效(z13 重跑 0 次 ReferenceError)。

### 浏览器 fo/ 发射帧(F@3:67653)参数捕获
- **Dj=Array(15)**=['3962','3956','3954','3958','3961','3960','3963','3967','3965','3957','3964','3966','3952','3953','3955'](**VM 计算输出槽序号表**——15 个指纹项的编号);Dk=3974(总槽位数);Du='BuWQ0'(结果写入 opt 键名)。
- **opt.BuWQ0={LQfqz0:'chejv1',toJSON}**——LQfqz0 是 6 字符会话串;**3962 等编号在 window/opt 都无键**=VM 内部对象池槽号(非全局)。fo/ body=15 项指纹串的 $ 分段拼接(2338B 实物在 browser-fo1.json)。
- **fo/ 发射帧栈=顶层 k/F(无 RTC!)**——RTC createOffer.then 是**另一条并行相位的发射点**(round12 bom 里 pat/i 遥测),fo/ 主链是 VM 指令直接调 XHR。
- fo/ URL 模板(pinned 字节):`<opt[cNzone]>/<opt[el]>/fo/698082038:1792779014:7TbuL.../<opt[bb][e5]>/<opt[J][bc]>`(构造器在 eval 期 async 机器 case 内,我们环境**该构造器未执行**——FOURL 探针 0 次命中)。

### 当前卡点(单一)
**VM eval 期 async 主机器的 fo/-case 从未到达**——apply-Proxy 修复后机器运转正常(T550 1120 圈),但 AKECH4 轮询仍在(457 次,纯轮询非阻塞),fo/ URL 构造 case 未跑。**下轮:VM 泵 pc 采样(修复后重跑 VMTICK)找新 pc 停点**,或对照浏览器 fo/ 前的 VM 状态差(dSvRK1 浏览器=[null×4] 同我们;qrht8 已归一)。

---

## 2026-10-25 终稿三十六:apply-Proxy 修复后机器复活确认+相位数组真身(honk 填充脚本)+ VM 现状态精测

### 关键测量(修复后重跑 VMTICK)
- **VM 不再死循环**:20k tick 阈值 12 秒内零 VMTICK(此前 1.1 亿/20s)——CPU 从 99% 降为轻负载,T550 正常节奏(320-480 圈/15s)。
- **VMBYTES/VMREGS/VMSTACK 一次性 dump 成功**(VM 循环至少进 1121-1258 一次):
  - VMREGS:寄存器 1=querySelectorA(All)、3=querySelector、4=Document、5=Element、7=style、8=prototype、9=window、**12=xrbo0**——**浏览器金表里的 xrbo0 出现在 VM 寄存器!**(本代字节对应容器的名字)
  - VMSTACK:3 层嵌套 [null,null,[1276,160,<phase-array>,2]];phase-array 25 槽,槽 6=时间戳对象、槽 7/9=两个 eval(已归一同体)、**槽 10=133.7 万空格+`0, /.*honk.*/,` 的填充脚本**(浏览器同款 honk padding,跨代一致!)、槽 12/15/24={}。

### 结论
- apply-Proxy stub 修复让 VM 越过崩溃点继续执行;xrbo0(浏览器金表的 9 键容器)在 VM 寄存器 12 被引用——**下一个 undefined load 大概率仍是容器类**(xrbo0 本代未挂 window)。对照:离线 WINGLOBALS 无 xrbo0,浏览器有(9 键)。
- 相位数组结构与浏览器 round12 协议同构;honk padding 是跨代稳定特征(可作指纹锚)。

### 下一步(聚焦)
1. **VMREGS 12=xrbo0 的 load 检查**:给 window 补 xrbo0 容器(9 键,值形态照浏览器断点)→ 看相位是否推进(VMBYTES 二次触发或 T550 加速)。
2. 若不动,断 VMREGS 20(唯一 undefined 寄存器)的用途。
3. 终局路径不变:相位推进→fo/-case(URL 构造探针 HARNESS_FO_TRACE=1)→XHR POST→stage2/render→载荷握手→PoW→cf_clearance。

### 终稿三十六补遗(收尾)
- **xrbo0 假设证伪**:seed(9 键,值 0/函数两形态)后 VM 零读取(HIT 路径探针 0 次)——VMREGS 12=xrbo0 只是寄存器持有名字符串,未被 window 路径读。srbo0(9键)在浏览器由 VM 自己挂(eval 期),我们的 VM 同样会在自己相位挂,无需外部补。
- honk 填充脚本(133 万空格+`0, /.*honk.*/,`)与两 eval 同体(槽 7/9)、phase-array 25 槽结构——全部跨代稳定。
- 下轮单点:VM 相位数组槽 12/15/24(空 obj,浏览器对应槽内容未知)——VM 循环中给这些槽赋值的指令即推进点;或断 VM 1121-1258 区出口(pc>1258 首次出现时 dump 全栈),看走出循环需要的栈形态。

---

## 2026-10-25 终稿三十七:tick 短路机制破案(G3 标志)+ 异步机器 park 点实锤 + 注册表启动链(tO/tg)

### 决定性测量(TOTRACE/TICKTRACE)
- **异步机器 park 死**:to() 每圈 pc 恒定(i:214,j:21 或 111,172),状态对象 {u:字节码A128, h:寄存器A256, C:U→window→function, B:0→739780719→179635247, l:191, j:21, i:214, v:66, m:71, A:A29}——机器 await 一个永不 resolve 的 promise,每 550ms 重试。
- **tick 短路破案**:G0/Gn 各只执行 1 次!tick 门=`!l[optXnuWO5]&&!ty()&&...?tp():G0()`,**ty()=return G3**(全局标志),eval 期 `G3=!Y` 置 true → 每秒 tick 直接短路,永不进 G0/tp 推进链。
- **G3 生命周期**:`G3=!Y`(eval,44464)→ `G3=!0`(**tO()**,180165:先打日志→G3=!0→M()(时钟锚)→w→G0→G1→tv——启动序列!)→ `G3=!1`(**tg()**,222221,switch-case 状态机里 case c)。
- **tO/tg 都注册在 window.HKul9**:CgDs1:tO、cKYwE2:tg——**注册表回调就是启动开关**。调用者=orchestrate 相位机器经 h('XnuWO5') 会话对象方法,或浏览器里的对应触发。
- **xrbo0 accessor 实证**:VM 指令 l2@5:25460 读 window.xrbo0(1 次,eval 期初始化)——之前 seed 无效是探针挂在退役代理上。

### 逻辑闭环(本轮最大成果)
浏览器:相位机器跑完 → 调 tg/tO(注册表)→ G3 切换 → tick 恢复 G0/tp 链 → 相位推进 → fo/。
我们:G3=true 卡死 tick;机器 park 在 await;**h('XnuWO5') 短路(opt.XnuWO5 会话对象不存在——force heal 只 push 了 CNmxZ4 数组,没写 opt.XnuWO5)**。
**下轮第一动作**:①给 opt 写会话对象 opt.XnuWO5={方法表}(形态从 round11 账本 h('XnuWO5') 返回 '278' 反推:对象有编号方法);②或直接调 window.HKul9.CgDs1()/cKYwE2() 模拟注册表回调触发(行为级:浏览器里这些回调确实会被调);③观察 G3 切换后 tick→G0/tp→相位推进→fo/。

---

## 2026-10-25 终稿三十八:注册表 24 回调全景实测(行为级调用)+ 会话对象实参需求实锤

### REGCALL 实验(HARNESS_REG_CALL=1,v+8s 逐个调用 window.HKul9 全部回调)
- **24 个回调全执行**,结果分类:
  - 无参成功:Rcdr8→false、**ivcgo1→true**、YuOpI3→object、OElR3→''、MWrWa2→false、RHXmy7→5、YVDgD5→false、cKYwE2(tg)→undefined、**CgDs1(tO 启动序列)→undefined**、GWmo4/nqgGN8/AYmdK7/wRHZ2/QHuc0/ouUsd0/OOXF0→undefined、XzQJn5→false、iTKb7→false、ycPG8→null、MPUK6→HTMLDivElementPrototype(V() 渲染查询!)
  - **抛错缺会话实参**:Afjo3/oWPf2 `Cannot read properties of undefined (reading 'bRsU6')`、HDQZU4 `'coza6'`——**这三个回调需要 widget 会话对象作实参**(读 X.bRsU6/X.coza6 会话键)
- 调用后机器未推进(T550 继续,无 fo/)——**缺的不是"调了没"而是"调了但没带会话对象"**。
- HKul9 依赖 WSET run 才出现在 window(z15 实证有写);无 WSET 时 REGCALL 报 no registry——**写入路径经 winObs proxy,plain 赋值路径仍有差异待查**(或时序:REGCALL 在写入前)。

### 全链逻辑(至此完整)
1. orchestrate eval → 注册表 HKul9 挂载(24 回调)
2. 相位机器 park(await);G3 标志卡 tick(终稿三十七)
3. **浏览器:控制器与 orchestrate 经会话对象握手 → 注册表回调携会话对象实参被调(Afjo3/HDQZU4/oWPf2)→ 相位推进 → fo/#1**
4. 我们:会话对象不存在(载荷发过 init/requestExtraParams 但 widgetMap 空,控制器不认领;render 无调用者)

### 下轮抓手(精确)
①**Afjo3(X) 的 X 形态**:从抛错栈帧 dump 实参读取路径(X.bRsU6),bRsU6/coza6=会话对象键名(本代);对照浏览器 fo/ 前断点读同名实参的值形态;②**会话对象创建者**:载荷发 init 后控制器流程(api.js message handler P(v) 的 case init)——widgetMap 空是死结,找 render 的真实调用者(可能=注册表某回调如 NmGWd6 嵌套调用链);③备选:浏览器断 fo/ 前在 window 上枚举带 bRsU6 同构键的对象(本代名不同,按 9 键容器形态扫)。

---

## 2026-10-25 终稿三十九:三回调源码静态解码完成——会话对象真身=DOM 元素(UI 挂载/勾选协议),纠正"握手对象"猜想

### 本轮成果(纯静态源码解码+NAMES2 运行时验证,零浏览器消耗)
1. **注册表字面量源码定位**(pinned round11 orchestrate 44737):`l[ak(qX.a9)]={"QPUYE4":!Y,"Rcdr8":h,"ivcgo1":th,"Afjo3":tA,"YuOpI3":tR,"HDQZU4":td,"oWPf2":tS,...,"cKYwE2":tg,"CgDs1":tO,...,"MPUK6":V}` —— 三回调真身:**Afjo3=tA、HDQZU4=td、oWPf2=tS**;注意同代里 ak(68)=HKul9、ak(9)=_0x660e(qX.a9 的 9 是另一作用域映射,注册表容器名以 ak(68)=HKul9 为准——再次验证动态映射勿静态臆断)。
2. **三函数源码+语义**(混淆表 ak(N) 已由 NAMES2 探针运行时解码):
   - `tA(X)`(Afjo3):`tV=X[ak(972)]; tV&&tV[ak(215)]&&tV[ak(215)][ak(216)](tV)` → **X.bRsU6.parentNode.removeChild(X.bRsU6)**——卸载 widget 元素。
   - `td(X)`(HDQZU4):`tV={'_0x8fe0':'true'}; tM=X[ak(973)]; tM[ak(987)]=!0; tM[ak(177)](ak(988), tV[ak(986)])` → **X.coza6.disabled=true; X.coza6.setAttribute('aria-checked','true')**——勾选+禁用 checkbox(完成态)。
   - `tS(X)`(oWPf2):`tZ=X[ak(972)]; tV=G(290725,V,[]); tV? tV[ak(181)](tZ) : (log+!1); return !0` → **V()(glEe8 容器查询,=MPUK6)存在则 appendChild(X.bRsU6),否则报错**——挂载 widget 元素进挑战容器。
3. **会话对象 X 真身**:`{bRsU6:<widget 元素>, coza6:<checkbox 元素>}` —— 注册表是 **UI 挂载/勾选协议**(VM 相位机器造出假 widget UI→挂载→勾选→完成态),**不是**终稿三十八猜的"控制器握手对象"。REGCALL 的 `Cannot read properties of undefined (reading 'bRsU6')` 即 X=undefined。
4. **NAMES2 探针已固化**(harness.js VM_TICK 注入锚内,槽位表 9/215/216/181/177/988/733/986/987/972/973/984/985/76/180):本代解码 215=parentNode/216=removeChild/181=appendChild/177=setAttribute/988=aria-checked/987=disabled/972=bRsU6/973=coza6/68=HKul9/161=QPUYE4/24=_cf_chl_opt。
5. 运行环境坑:macOS 无 `timeout`(exit 127)→ 用 `(... & echo $! > pid); sleep N; kill`;Bash 工具两次调用间 cwd 重置(必 cd);harness 必须从 node-env 目录启动(相对路径 pinned-* 文件)。
6. 本轮复跑确认:VM 活跃(pc 1050/1152 循环)、GLEE 打点(glEe8=BODY,经 orchestrate K fn)、REGCALL 24 回调行为与前轮一致。

### 下轮第一动作(精确到操作)
①**造会话对象喂三回调**:env.document 造 `<div bRsU6>`(内含 `<input coza6>`),`HKul9.oWPf2({bRsU6:el, coza6:input})` → 观察 V() 容器(先验 glEe8.querySelector('#XWAst9') 是否有值,REGCALL 时 glEe8=BODY,V() 可能返回 null→tS 走报错分支);②**调用者溯源**:源码里搜对 tA/td/tS 的引用(它们是函数名,可 grep `tA(` `td(` `tS(`——比搜动态注册表名可靠),找到相位机器里带实参的调用点=会话对象工厂;③若 tS 报错分支,先把 glEe8 设成带 #XWAst9 子元素的元素再喂。
- 备选:REGCALL 顺序敏感——oWPf2(挂载)应在 HDQZU4(勾选)前;浏览器侧若要实证,fo/ XHR 断点处 dump `window.HKul9` 同名回调 toString 对照本代源码。

### 状态
浏览器侧 cookie ✅。离线:三回调语义全解码(UI 协议),REGCALL 实参形态已知,VM 活跃;**下一步=造 DOM 会话对象+找调用点**。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

### 终稿三十九补遗(调用点溯源)
- grep `tA(`/`td(`/`tS(` 全文仅命中函数定义本身,**零明文调用点**——三回调经注册表对象以计算键访问被调(VM 字节码内),静态 grep 名字无效。
- **下轮实操修正**:不要 grep 名字;给 window.HKul9 装 method-wrap 探针(REG 分支已存,扩展为包装 oWPf2/Afjo3/HDQZU4 记录调用栈+实参 JSON 形态),离线喂自己造的 X 前先跑一轮看 VM 是否自发调用(也许 X 就位后 VM 自己来调——那才是浏览器同构路径)。

---

## 2026-10-25 终稿四十:浏览器 fo/ 金表全景+挑战页真实 DOM——xrbo0=RTC 采集容器;离线门仍在更上游

### 本轮验证链(浏览器断点 2 轮 + 离线 10+ 轮)
1. **SESS_FEED 实验**:造 DOM 会话对象 {bRsU6:div, coza6:input} 喂三回调**全成功**——oWPf2 挂载进真实容器(V()→<DIV>,ak(932)='#XWAst9' 实证存在)、HDQZU4 勾选成功(aria-checked=true)、Afjo3 卸载成功。**但机器不推进(to 仍 park)+VM 零自发调用**→UI 协议是下游动作,上游有更早的门。
2. **PROMFEED 实验**:ctx 内整轮**零 `new Promise`**——机器 park 不是真 Promise await,是解释器级 yield(T550 550ms 重试,每轮执行 ~700 条字节码再 park,pc 每 run 漂:100/131/196/204/207/218)。
3. **park 机器名字表全 dump(PARKNAMES)**:defineProperty/window/iframe/BuWQ0/contentWindow/vvfHL3/Proxy/LQfqz0/apply/createElement/keys/now/**visibility**/atAFr0/angular/width/vMhC1/**whenStable**/hidden/RTCPeerConnection/lffN9/setTimeout/eval/qCZq4/honk/remove/IXEYu6/push/MkvrI5/position/dSvRK1/configurable/Element/getTestability/Document/String/HKul9/enumerable/_cf_chl_opt/top/frameElement/glEe8/get/push/document/left。寄存器持 'xrbo0'(29)+atAFr0(30)。**BuWQ0/LQfqz0(fo/ 写入键)在这台机器上——它就是 fo/ 发射机的家族**。whenStable/getTestability 是 orchestrate 内部函数(api.js 无)。
4. **泵循环 pc 1050↔1152 非死旋**(~1300 tick/s=每 550ms 重试跑一段);相位数组 25 槽解码:**槽24=T550 wrapper 函数、槽7/9=eval、槽10=honk padding、槽6=0、槽1/12/15=undefined(空位)**。
5. **api.js 链全通实证**:DraY9 onload 回调**有被调**(harness 自带 CALLBACK tracer;此前我的 ONLOAD 探针误报 calls=0——被 tracer 覆盖+时序错误);api.js boot 零错误、turnstile 挂载、self-tag 定位全过(PUMP Mt probe 全 true);**turnstile.render 依旧零调用**。
6. **浏览器 fo/ 断点金表(本代 ray=a50141b36a9f53e6)**:
   - **xrbo0 真身=RTC 采集容器**:`{rdIO7:{}, RAAZ3:[6×{ltzT3:'candidate:… .local … typ host generation 0 ufrag eJWt network-cost 999', vuCS3:41|42}], GayZ4:<offer时刻ts>, zBvVa5:<完整 SDP>}`——SDP=Firefox 形 audio+video+application 三 m-line(ice-ufrag 4字符/ice-pwd 24/fingerprint/opus+VP8+H264+AV1 全家桶);candidates=2 个 mDNS UUID.local×3 端口。
   - **dSvRK1=[querySelector, querySelectorAll, querySelector, querySelectorAll](4 个原生 fn!)**(离线=[null×4]→后见部分填充+假 fn)。
   - vvfHL3=**空数组**(离线 LM_FIX 后 3 个选择器——差异!)、nTlR0={8 旗标:rRfi2:1,gmGY7:1,余0}、MpSwI7={}、vMhC1=-13、QBEM0=true、lffN9='qCZq4'、LeviO5=30。
   - **注册表键名跨代稳定**(本代 HKul9 同键:QPUYE4/Afjo3/HDQZU4/oWPf2/CgDs1/cKYwE2/MPUK6…,函数内名变 tA→QV)——**窗口级协议名≠每代混淆名,大概率稳定**;XWAst9 亦跨代稳定(round11 ak(932)=本代 DOM id)。
   - atAFr0 源码:`function(QK,ep,aB,Qn,QC,QL,QF){ep={a:104,b:107,c:3,d:99},aB=…`。
7. **挑战页真实 DOM 骨架**(fo/ 时刻,28.7KB 全页存 browser-challenge-page-full.html,body 骨架 browser-challenge-body-skeleton.html):`main-wrapper>main-content>[QTNHm2(favicon+h1)]+[H2#znon2 标题]+[P#zezB9 提示]+[#XWAst9 空容器]+[#tSBMk0 display:none 成功提示]+[#VhSYB2 spinner 内联 style="display:block; visibility:visible" 含 .ybQTR8 4 div]+noscript`;**iframes=[](fo/ 时零 iframe!)**。
8. **pinned-page.html 旧抓取 body 残缺**(仅 main-wrapper>noscript,H2/容器/spinner 全无)→ **已注入骨架**(备份 pinned-page.html.bak);+ getComputedStyle 真实值化(visibility:'visible' 等);+ RTC stub 浏览器化(三 m-line SDP+6 mDNS candidates 事件+gathering 状态机);+ 假 DOM querySelector 系 toString 原生伪装(natMask)。**结果:机器仍 park,RTC 构造 0 次,fo/ 未发——门在 RTC 相位之前的更上游**。

### 工具与坑(本轮新增)
- **HARNESS_MAX_MS 看门狗**(正常 exit 刷盘;kill 会丢 stdio 缓冲导致日志假缺失)。
- **pinned-api.js 会被 serving 路径写回**——注入 trace 必须禁写回(HARNESS_API_TRACE 已修);曾污染→按标记清洗恢复(86732B,md5 aec21eb4…)。
- FO_TRACE 注入在重 pin 的字节里语法坏(锚处于表达式上下文)→已禁用,fo/ 看 [XHR] 日志。
- PARKOPS/PARKREGS/PARKNAMES/PHASEARR/NAMES2 全部固化在 harness.js(VM_TICK 锚+TO 锚)。
- ONLOAD 探针教训:post-eval 装的 accessor 会被 harness 自带 tracer 的直接赋值覆盖;先查已有探针再写新的。
- 浏览器复现实操:clear_site_data→break_on_xhr /fo/→reload→sleep 2→get_paused_info(断点附加有竞态,首航会全速跑完,第二航必中);暂停窗口内 evaluate_script(frameIndex=0)随意 dump;完事 remove_breakpoint+resume。

### 下轮第一动作(浏览器 oracle 优先)
A. **fo/ 断点处 step-out 全链**:在 fo/ XHR 暂停帧连续 step out/out 记录完整调用链(eval 相位脚本→机器 case→XHR),拿到从 eval 到 fo/ 的机器路径骨架;对照我们 park 的 to() 状态字段(i/j/l/v/m)。
B. **RTC 断点**:set_breakpoint_on_text 'createDataChannel'(orchestrate scriptId,断点须在源已加载后装;orchestrate 是 eval 源,可在 fo/ 断住时装 text 断点再 resume 到下一轮?不行——fo/ 后 RTC 不再来。应在页面刚 load 时快速断)→ 看机器进 RTC 相位前最后读的 window/opt 键。
C. **dSvRK1 填充者溯源**:浏览器 fo/ 时 4 槽=原生 querySelector/All;离线 WSET 显示部分填充('' ,'' ,querySelector…)——找到写它的函数(浏览器在 DraY9 后?)补全+原生化。
D. 离线组合拳再验:骨架+RTC+natMask+computedStyle 已齐,若 A/B 给出新缺失键(如 opt 上某会话键),按浏览器值形态补。

### 状态
浏览器侧 cookie ✅(本轮两次复现通过)。离线:UI 协议三回调语义+会话对象形态已破解并实测可喂;park 机器名字表/相位数组全解码;api.js 链确认通;**单一卡点=机器 park 在 RTC 之前,等的事件/条件未定位**。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅

### 终稿四十一补遗(浏览器 oracle 深挖:调用链+轮询定性)
1. **fo/ 发射的触发器=ICE 事件**(step-out 全链):fo/ XHR ← Mi(VM 指令)@2:67445 ← 事件适配器@2:14089/14108(局部变量 Pm='RTCPeerConnectionIceEvent',args={isTrusted:true})。**浏览器的 RTC 构造发生在 DOMContentLoaded 之前(eval 早期)**——RTC 构造钩子(mainWorld 装在 DCL)读到 __rtcLog=[] 证明错过。机器模型修正:**eval 期同步完成早期相位(含 RTC 构造+offer)→ ICE candidates 事件流异步喂机器 → 收集完(null candidate)→ 写 opt.BuWQ0 → 发射 fo/**。
2. **fo/ 时 opt 全景(浏览器)**:BuWQ0={LQfqz0,toJSON} **已存在**、jLEVv0=6 任务数组(OROhR9/JeJZR2/xYfm0/ePsF3/TypqR7 形)、CNmxZ4=[](空!)、fpwv7='0'、glEe8=obj(容器)、bwDXz7=6 键参数对象;**location=裸 https://www.cell.com/(无 token!)**——URL token 门排除(cUPMDTk 是跳转中间态)。
3. **离线 pc 采样(VMTICK __pcs)**:pc 在 1040-1370 窗口游走、20 样本全不重复——机器每 550ms 重试执行 ~700 条指令的**轮询检查**再 park(非死循环、非卡死)。速度 ~1333 tick/s 由重试节流决定。
4. **离线种子实验(全部无效)**:opt.BuWQ0={LQfqz0:'chejv1',toJSON} 种子(HARNESS_BUW0=1)→ park 不变;URL token(cUPMDTk 作 location)→ 不变;UI 骨架 DOM→不变;getComputedStyle 真实值→不变;RTC stub 浏览器化→不变(机器根本没到 RTC 构造);querySelector natMask→不变。**离线机器 park 在早期相位,等的事件/条件仍未定位**。
5. 工具教训:VM_TICK 注入新增代码必须 try/catch(首 tick 抛错被 orchestrate 静默吞,机器假死、零日志);[...new Set] 改 Array.from 保险。
6. **下轮唯一抓手**:浏览器与离线的**机器状态字段差**(浏览器 park 间隙的 to() i/j/l/v/m vs 离线 i:100-218)——用 CDP 在浏览器机器 park 时的 pause(pause_or_resume 手动断点在 to 入口?不可行,to 是普通函数)。替代:**给浏览器 orchestrate 装 console 探针不可行(CSP/一次性);转向离线把 550ms 重试改成 10ms(加速轮询)+在重试 wrapper 里 dump 每轮读过的 window 键(winObs get 记录)**——轮询条件必在每轮 700 条指令的读取里。

---

## 2026-10-25 终稿四十二:轮询键锁定(CNmxZ4×2+AKECH4×1 每轮)+ 相位槽空位定性

### 本轮成果
1. **WGET(winObs get 计数,WGETSUM 每 8s)**:机器高频读 window 键=_cf_chl_opt:11805/Reflect:10488/Date+HKul9+coTgT4:~3890(tick 固定动作)。**coTgT4 浏览器 fo/ 时也是 undefined(非门)**;location=裸 origin(URL token 门排除)。
2. **OGET(pre-eval opt 读记录,修复 OPTPROXY 被绕过)**:**机器每轮读 opt.CNmxZ4×2 + opt.AKECH4×1**,其余全低频(setup)。OSET 显示 eval 期 orchestrate 写 qFyP3/kEhL4/VBVo1/CNmxZ4/PIer3/bwDXz7。
3. **浏览器 fo/ 时 opt 无 AKECH4 键、CNmxZ4=[] 空**——浏览器机器的同构轮询读的是本代动态槽名,pinned 代轮询 CNmxZ4/AKECH4。**AKECH4=计算完成标志(无人写=死等);写它的执行流=ICE 事件驱动的机器分支**。
4. **离线相位数组槽 1/12/15=undefined(空位)**,槽 24=T550 wrapper/7,9=eval/10=honk/6=0——**机器在等空槽被填充**;eval 期真相位脚本只有 1 次 AwUcP3 XOR 工厂+504 空白 eval,**RTC 构造相位从未进 eval**。
5. vTimer 异常:机器调度的定时器回调(lu@5:101569←tM@5:89196)抛空消息 TypeError,3 次/30s,被 vTimer 捕获——机器代码在自己的调度回调里主动 `new TypeError()`(校验失败?)。
6. 工具:WGETSUM/WGETRARE(winObs get 计数+周期输出,interval 必须 .unref()+早注册,process.exit 跳过收尾段)/OGETSUM(pre-eval opt Proxy,修复 post-eval 装被绕过的问题)。

### 完整因果链(当前最佳模型)
浏览器:eval(顶层同步:早期相位+RTC 构造+createOffer)→ ICE 事件流(40ms,6 candidates+null)→ 事件适配器喂 VM→机器写 AKECH4/BuWQ0→fo/ XHR←ICE 事件适配器(step-out 实证)。
离线:eval 早期相位分叉(RTC 构造分支未走)→机器进轮询(CNmxZ4/AKECH4/相位槽 1,12,15)→550ms 重试 park 永远。
**缺失=让早期相位走通到 RTC 构造的那个输入**(DraY9 已调、骨架已有、样式已真、token 无关)。

### 下轮第一动作
①**eval 期相位脚本观测升级**:HARNESS_PHASE_DUMP 记录 eval 的脚本全文长度分布+来源栈,找出 504 空白 eval 的调用者与 1 次 XOR 工厂的上下文;②**槽填充者溯源**:给相位数组(VMREGS2 里 25 长数组)装 host 侧包装(Array 实例替换成记录型代理?相位数组在 VM 寄存器内,不可直接包——改为在 eval 期 hook 数组构造/在 honk 脚本 eval 后对比槽差);③**浏览器对照**:同代活字节跑离线(live 模式)+浏览器同代断点对照相位槽状态。

---

## 2026-10-25 终稿四十三:render 全链打通——widget iframe 真实创建!三 bug 连修(lenientProxy 槽污染/解析树原型/循环 stringify)

### 浏览器 oracle(render 断点 44 帧全链)
- **render 调用者=orchestrate VM 机器**(widgetMap.set 断点实测):api.js xe(render 工人)←Se←**Ql@chl_page:107910←Vk@96650**←p←GZ.<computed>←run←QX←Gm.<computed>...44 帧嵌套 VM 相位机器。render 不是 api.js 自主行为,是机器指令直接调用(与"orchestrate 从不调 render"的旧结论相反——旧观察受限于离线机器 park)。
- **render 实参全捕获**:{sitekey:'0x4AAAAAAADnPIDROrmt1Wwj', theme:'light', action:'managed', cData:<cRay>, chlPageData:<opt.md>, retry/'refresh-expired'/'refresh-timeout':'never', callback/expired/error/timeout/before-interactive/after-interactive-callback:fn},container=#XWAst9 div,execution='explicit'。**全来自 opt/站点常量,离线可复刻**。
- 消息侧:P 处理器局部 h=widgetId('w1m4l')已在 widgetMap;流程后期 window 上桥名全部消失(消费后删除),cf-chl-widget-<id>_response 元素留存,iframe 完成后移除。

### 离线复刻(HARNESS_RENDER_CALL=1,v+8s 行为级注入 render)——三 bug 连修后**widget iframe 真实创建**
1. **bug A:TURNSTILE 日志代理 JSON.stringify(循环引用容器)直接炸**→真 render 没执行还误报;修=安全 stringify(两处)。
2. **bug B:解析树元素无接口原型**(主页面解析用 new Elem,绕过 createElement 的 MAIN_TAGS setPrototypeOf)→`container instanceof HTMLElement=false`→render 拒绝。修=wireAll 全树重绑;**关键坑:解析树根在 document.children(栈初始[body,document],top=document),不在 document.body——wire body 只见 2 节点,wire document 才见 48/wired 32**。
3. **bug C:lenientProxy 的 MISS stub 污染内部槽**:miss 分支对 `__shadowRoot` 返回 truthy 函数 stub→attachShadow 的 `if(this.__shadowRoot) return this.__shadowRoot` 缓存命中直接返回 stub→"Xt.appendChild is not a function"(Xt=attachShadow({mode:'closed'})的 ShadowRoot,api.js@74836)。修=`__` 前缀键读穿透。
- **修后链路(实测日志)**:render()→**返回 widgetId(cf-chl-widget-rjboj/6jrat)**;shadow appendChild<IFRAME id=cf-chl-widget-…>;setAttribute(src=fav0 URL 完整);**机器被唤醒自行发起第二次 render(container=null,cData 空——VM 相位机器活了!)**;iframe realm 创建 ×2。
- 补修:iframe src 经 **setAttribute**(api.js 用 setAttribute 非直赋)也触发 queueIframeLoad(此前只挂 proxy set-trap)。

### 当前卡点(两处,精确)
1. **"Cloned widget is not an iframe"**(api.js H@69549,循环):widget 克隆/校验链认为克隆产物非 iframe——疑似假 iframe 的 cloneNode/instanceof HTMLIFrameElement 问题。
2. **机器定时器回调循环抛空 TypeError**(tM 调用校验器,VM CALL 指令 `tM(Hp)(HH[HB],...)` 的 Hp=undefined callee,与 apply-Proxy 同族)→eb/ 错误上报循环(48 次/20s)。
- 栈映射注意:served orchestrate=prelude(4 行,末尾无换行直接接 scriptSrc)+pinned 3 行→栈 line5=pinned 行2;行2 内 tM 定义两处(@88534 校验 typeof、@176691 另一形态);throw 帧 col 89196 落 lW 区段,帧归属仍偏移——tM 探针(@88534 版)注入成功但 0 命中,抛错者另有其人(下一步给 @176691 版+catch-all `new TypeError` 探针)。

### 下轮第一动作
①api.js H@69549 "Cloned widget" 检查源码定位(pinned-api.js 明文可搜)→修假 iframe cloneNode/instanceof;②catch-all TypeError 探针(`new TypeError`→`new (console.error('[TE]…'),TypeError)`)抓真凶实参;③机器二次 render(container=null)是它自己的 UI 相位——让它走通即可见桥注册(window.<slot> 出现)→CNmxZ4/AKECH4 轮询过→fo/。

### 状态
浏览器侧 cookie ✅。离线:**render 全链打通(widget iframe 创建+机器复活二次 render)**;卡克隆校验+VM CALL undefined callee。距 fo/ 只剩这两环。`cf_clearance`(脱离浏览器)未拿到;①✅②✅③❌④✅
