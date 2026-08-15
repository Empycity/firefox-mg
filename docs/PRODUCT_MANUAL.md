# Firefox Trace 产品功能介绍与交付手册

> 当前默认策略校正：`full-chain` 保留原始 DOM/BOM、普通 JS、IPC、XHR full 和
> boundary 覆盖，不自动注入新的总量上限。DOM/BOM 值、对象合同、Promise 观察及其
> 限制均由 Agent 配置显式开启；默认不限的模块不会因 UI 预设被偷偷截断。整理后先读
> `index/trace-health.json`，它区分证据缺口与页面运行结果。

版本：当前 UI / tools 交付版
面向：实际使用者 + 后续分析 Agent

Firefox Trace 是一套“可见 Firefox + 软件中控台 + 分类日志 + Agent 分析工作流”。用户在 UI 里输入 URL 和输出目录，打开 Firefox 后自己操作网页；工具在同一个 `TRACE_DIR` 中同时采集 Network、JS Call、DOM/BOM、Cookie/Storage、Script、WebSocket、WASM/VM 等证据，并在停止后整理成 Agent 易读的分类日志和索引。

本工具是通用采集框架，不绑定具体站点或字段名。默认字段只是常见安全参数候选；遇到任意目标字段，都在 UI 的“URL Query 字段 / POST Body 字段 / Request Header 字段 / Cookie 字段”里填写。

模式选择、所有可填参数、补环境证据优先级和 Agent 配置文件写法以
[TRACE_MODE_PLAYBOOK.md](TRACE_MODE_PLAYBOOK.md) 为准。它是本手册与 Agent
skill 共用的决策表；遇到 canvas/WebGL/TypedArray 等指纹对象时直接按其中的
“指纹对象专项处理”生成定向配置，不提高全局对象深度。

完整的面板控件、JSON/env 字段和“缺什么证据写什么参数”映射见
`skills/firefox-trace-agent/references/ui-parameter-catalog.md`。完整 trace
缺少浏览器内置对象时，先按
`skills/firefox-trace-agent/references/environment-repair-playbook.md`
在当前 Firefox 页面控制台取值；Firefox 启动、Profile 隔离和崩溃排错见
`skills/firefox-trace-agent/references/firefox-startup.md`。

浏览器能力审计和案例复盘见 [BROWSER_RUNTIME_REVIEW.md](BROWSER_RUNTIME_REVIEW.md)。
请求回放必须使用同一脚本对应的完整原始 request vector，只替换目标字段；缺少
原始下游请求时保持未验证状态。

---

## 1. 推荐启动方式

### 1.1 桌面软件 UI

双击项目根目录：

```text
Firefox Trace Console.app
```

或者终端启动：

```bash
tools/trace-desktop.sh
```

这是推荐入口：界面里填写路径和选项，不需要记命令参数。

`Firefox Trace Console.app` 现在可以移动到其他目录；如果仓库也移动了，从终端用
`FIREFOX_TRACE_ROOT=/path/to/firefoxTrace open "/path/to/Firefox Trace Console.app"`。
Nightly runtime 是独立的完整 `Nightly.app`，默认路径为
`/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime`；移动后在 UI 重新选择
`Contents/MacOS/firefox`，或设置 `FIREFOX_TRACE_RUNTIME_ROOT`。

### 1.2 命令行底层入口

```bash
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
tools/run-trace-firefox.sh \
  --trace-preset full-chain \
  --trace-plan full-chain \
  --trace-start active \
  'https://example.com/'
```

### 1.3 更新内核运行时

每次编译后替换 `Nightly.app/Contents/MacOS/XUL` 必须重签整个 macOS app；直接复制
XUL 会被系统以 `CODESIGNING / Invalid Page` 在 Firefox 初始化前终止。使用：

```bash
tools/install-trace-runtime.sh
```

该脚本复制默认 build 输出、执行 ad-hoc `codesign --deep`，并用 `firefox --version`
验证启动加载。需要使用另一份 build 输出时将 XUL 路径作为第一个参数传入。

---

## 2. UI 基本操作流程

1. 打开 `Firefox Trace Console.app`。
2. 填“目标 URL”。
3. 检查“输出目录”，默认在：

   ```text
   ~/Desktop/firefox-trace-outputs/firefox-trace-YYYYMMDD-HHMMSS
   ```

4. 按目标接口填写：
   - `URL Query 字段`
   - `POST Body 字段`
   - `Request Header 字段`
   - `Cookie 字段`
5. 默认使用 `full-chain`，默认勾选主要模块。
6. 点“打开 Firefox”。
7. 在 Firefox 里手动完成登录、跳转、点击、翻页、搜索等目标操作。
8. 如果启动模式是暂停，目标动作前点“开始记录”。
9. 目标请求发出后点“停止并整理”。
10. 把整个 `TRACE_DIR` 发给 Agent。

停止后会自动生成：

```text
categorized/
index/summary.json
index/causal-index.json
web-assets/
```

---

## 3. UI 每个区域和默认值


### 3.0 面板使用总原则

- 首轮查链路：保持默认勾选，使用 `full-chain` + `打开即记录`；当前默认是“通用完整值落盘”，异步 spool 只优化写盘路径，不偷偷减少普通 JS/DOM/BOM/网络覆盖。
- 目标字段出现在哪就填哪：query 填 Query，body 填 Body，header 填 Request Header，cookie 填 Cookie。
- 同一字段会出现在多个接口时，Agent 启动 watchdog 时增加
  `--url-contains '/exact/endpoint/'`；只有 URL 命中该子串且字段制品已落盘才停止，
  避免被更早的无关请求截停。
- 一轮同时拿请求字节、环境和 JS 调用窗口：采集计划选 `full-chain`，JS Call 选 `boundary`，填写实际目标字段，VM/Opcode/WASM 指令保持关闭。字段命中请求后只写出相关 JS 窗口。
- `target` 与 `deep` 是已知脚本身份后的精确模式，必须已有脚本名、函数名或 SHA-256 候选。候选为空时，桌面端会明确切到 `boundary` 并写入日志，避免空 JS Call 产物。
- JSVMP/WASM 是附加面板，不是替代前面模块；先让 Network/JS/Script/State 证据齐，再追加 VM/WASM。
- 脚本身份、PC range、dispatcher PC 都由工具从请求 caller、origin_call_id、JS 调用链和 opcode analyzer 自动推导；用户只需要重复同一个目标动作。

### 3.1 ① 会话

| UI 项 | 默认值 | 作用 |
|---|---:|---|
| 目标 URL | `about:blank` | Firefox 打开的地址。正式采集时改成目标页面。 |
| 输出目录 | `~/Desktop/firefox-trace-outputs/firefox-trace-时间戳` | 本轮所有日志、制品、索引都会写到这里。 |
| Firefox 可执行文件 | 优先 `/Users/empycity/Desktop/Ai_MCP/firefox-trace-runtime/Nightly.app/Contents/MacOS/firefox` | 魔改 Firefox 路径；不存在时可手动选择。 |
| Profile 目录 | 空 | 空表示为本轮创建临时 profile。需要复用登录态时可填固定 profile。 |
| 记录标签 | `manual` | 写入 manifest/control，便于多轮分段区分。 |
| 启动模式 | `打开即记录` / `active` | 控制 Firefox 打开后是否立即记录。 |
| 复用已有输出目录 | 关闭 | 默认新目录。要继续同一目录分段时再打开。 |
| 新建时间戳目录 | 按钮 | 生成一个新的输出目录。 |

#### 启动模式区别

| 模式 | UI 文案 | 何时用 |
|---|---|---|
| `active` | 打开网站就开始 trace | 默认推荐。能抓页面加载期 JS、脚本下载、初始化 Cookie/Storage、首屏请求。查生成链路时优先用它。 |
| `paused` | 先打开但暂停，等我点“开始记录”再 trace | 需要先登录、过验证码、准备页面状态时使用，避免前置动作污染日志。 |
| `prewarm` | 预热记录 | 适合需要浏览器预热、但正式动作稍后开始的场景。 |

### 3.2 ② 首轮采集 / 目标字段

| UI 项 | 默认值 | 作用 |
|---|---:|---|
| 采集计划 | 全量 trace | 只有“全量 trace”和“轻量 trace”两项；内部 key 分别为 `full-chain` 和 `discover-light`。 |
| URL Query 字段 | `signature,token,risk_field,fingerprint,nonce,timestamp,challenge_id,security_token,anti_token,auth_token,checksum,digest` | 从 URL query 中抽取这些字段，保存 preview、size、SHA-256、value artifact。 |
| POST Body 字段 | 同上 | 从 XHR/Fetch body 中抽取这些字段。 |
| Request Header 字段 | 同上 | 从 XHR `setRequestHeader`、Fetch request headers，以及 finalize 可识别的 request headers 中抽取字段，输出 `location=headers`。 |
| Cookie 字段 | 同上 | 从 Cookie header、document.cookie、CookieStore、HTTP Set-Cookie、Cookie storage lifecycle 中抽取命名 cookie，输出 `location=cookies`。 |
| 采集强度 / 总数保险丝 | 高级项 | 全量 trace 默认没有 JS 总数截断；轻量 trace 保留有界保险丝。 |
| 显示高级 / Agent 配置 | 默认关闭 | 展开模块、JS 对象深度、性能保险丝、VM/WASM 和 env。 |

#### 为什么不是“所有东西直接塞进 JSONL”

长参数、响应体、JS 返回值默认走 `values/` artifact。主 JSONL 只保存：

```text
preview / size / sha256 / value_store_path / stored / truncated
```

这样既保真，又避免单行 JSONL 过大导致 UI 和 Agent 读取困难。`*_MAX_BYTES=0` 在本工具里表示 trace 层不按大小丢弃该 artifact。

对象环境不使用递归 JSON 展开。Agent 显式启用 DOM contract overlay 后，`full-chain` 会为实际触达对象记录稳定 `object_id`、realm、原型 class 链、成员 descriptor、构造/调用与返回对象引用，汇总在 `index/environment-contract.json` 的 `objects` 和 `members`。默认 DOM/BOM signal 不自动开启该对象合同。iframe 的原生 `load` 派发顺序会进入 `lifecycle_events`，并通过同一 `object_id` 与监听注册、节点插入关联。该过程只读取引擎元数据，不执行 getter；完整性由 `object_contract_complete` 明确标示。对象来自其他 iframe/Xray realm 时，当前 context 只记录 identity、preview 和 `cross_compartment=true`；原型、descriptor、Promise 和属性快照必须在对象所属 realm 采集。

当对象类型已记录、但 `ImageData.data`、WebGL vector、extension array 或
`TextMetrics` 的内部值仍缺失时，Agent 在下一轮完整配置中加入
`TRACE_DOM_OBJECT_VALUES=1`，并只列目标接口/成员。该能力只采集已命中返回值的
有限白名单字段和数组元素，避免递归遍历页面对象造成 UI 卡顿。

#### `full-chain` 与 `discover-light`

| 计划 | 默认用途 | 默认采集 |
|---|---|---|
| `full-chain` / 全量 trace | 默认的一轮完整证据采集。 | 连续 JS enter/return、script-run 帧、value metadata/artifact、`Math.random` 与 `Date.now`/无参 `new Date()` 的实际返回值、完整 DOM/BOM WebIDL 事件、XHR/Fetch request/response/header、Cookie/Storage、Script artifact、WebSocket。对象值仍不做通用递归展开；JS/value 通过异步 batch spool 送到父进程落盘。VM/WASM 默认关闭。 |
| `discover-light` / 轻量 trace | 重页面的快速发现。 | 请求、脚本、DOM/BOM、Cookie/Storage 与有界 JS boundary；不启用全量 value spool、VM 或 WASM。 |

标准工作流不是固定两轮。首轮 `full-chain` 是完整候选产物：它已经具备目标请求、调用链、环境合同、字段/value artifact 和响应证据时，可以直接用于复现与验收。只有出现明确缺口时，Agent 才写出下一轮完整 `agent-next.json`；用户加载后只重复一次同样的目标动作。多个目录不合并凑证据，后续目录作为最终交付物时必须自身保留从环境/init 到请求字段写入的完整链路、配置和制品。

### 3.3 ③ 模块开关（高级）

默认勾选：

```text
JS 调用
XHR
Fetch
DOM / BOM
Cookie
Storage
Script artifact
WebSocket
```

默认关闭：

```text
Raw HTTP
```

| 模块 | 输出 | Agent 用途 |
|---|---|---|
| JS 调用 | `firefox-js-*.jsonl` / `categorized/js.jsonl` | 找 `call_id`、`parent_call_id`、`origin_call_id`、函数名、args/return、value metadata。 |
| XHR | `firefox-xhr-*.jsonl` / network | 看接口 URL、query/body、`xhr.header`、response、request_id；Worker 请求附带 worker id/type/script/window 上下文。 |
| Fetch | `firefox-fetch-*.jsonl` / network | 同 XHR，覆盖 fetch API；`fetch.request.headers` 会按 Request Header 目标字段记录，Worker 来源由 `fetch.call` 与同 request_id 关联。 |
| DOM / BOM | `firefox-dom-*.jsonl`，finalize 后拆为 dom/bom | 补 `document`、节点、canvas、navigator、screen、location、history、performance、crypto 等环境。 |
| Cookie | `firefox-cookie-*.jsonl` / state | 看 cookie 读写、变化、风控状态。 |
| Storage | `firefox-storage-*.jsonl` / state | 看 localStorage/sessionStorage/IndexedDB 线索。 |
| Script artifact | `firefox-script-*.jsonl` / `scripts/` | 保存脚本 URL、hash、本地 artifact、source map 线索。 |
| WebSocket | `firefox-websocket-*.jsonl` / network | 看 send/recv frame、握手或动态 token。 |
| Raw HTTP | network / `firefox-http-raw-*.jsonl` | Necko HTTP channel 的底层 payload chunk 十六进制证据。用于精确字节、压缩前后、multipart、编码差异、逻辑层 XHR/Fetch 对齐仍有疑问的场景；默认关闭。 |


#### Raw HTTP 何时打开

Raw HTTP 不是普通签名链路首选项。它记录更底层的 HTTP channel chunk，例如：

```text
channel_id / offset / captured_size / payload_hex / url / browsing_context_id
```

适合这些场景：

- XHR/Fetch 逻辑 URL、headers、body 已经对齐，但服务端仍返回异常，需要核对真实发送/接收字节；
- multipart/form-data、二进制 body、压缩、charset、换行、边界字符串存在 diff；
- response body 在 Fetch/XHR artifact 中缺少精确片段，需要看底层 chunk；
- Agent 要证明“逻辑请求结构一致”之外的字节层差异。

普通补环境/纯算优先看 `network + request-fields + values/`；Raw HTTP 开销更高，建议只对短目标动作打开。

### 3.4 ④ JS Call / 值采集（高级）

默认隐藏。常用项：

| UI 项 | 默认值 | 说明 |
|---|---:|---|
| JS mode | `boundary` | 首轮调用边界模式。 |
| 脚本身份 | 自动 | 首轮整理后写入 `index/target-candidates.json`，下一轮由中控台自动套用脚本匹配片段、hash 和精确脚本信息。 |
| 函数线索 | 自动 | 由请求 caller、`origin_call_id`、调用链和值匹配产生，用户无需猜函数名。 |
| target_match | `auto` | 目标匹配策略。底层 target preset 常用 `all`。 |
| 对象深度 | UI full-chain=`1`；CLI 未显式配置时=`0` | `TRACE_JS_OBJECT_TARGET_ONLY=1` 使正深度只作用于命中身份对象；非命中帧保持类型摘要，避免全站枚举对象属性。最终定向配置通常使用深度 `1`、keys `32`、数组 `16`。 |
| 对象 keys | `0` | `0=不按 key 数截断`。 |
| 数组 items | `0` | `0=不按 items 数截断`。 |
| TypedArray bytes | `0` | `0=不按字节数截断`；定向轻量模式才填写正数预览上限。 |
| 事件保险丝 | UI full-chain=`0`；discover-light=`50000` | 普通 JS 总事件数保护。`0=不按总数截断`；非零预算命中后写入 `trace-health.json`，不静默丢证据。 |
| 值 metadata | `1` | 记录短值/长值的 SHA-256、路径、角色、call_id。 |
| primitive metadata | `1` | number/boolean/null/undefined 也生成 metadata，方便找时间戳、flag、计数器。 |
| 值落盘最小字节 | `1` | 短字符串、时间、随机值和标志也写入 `values/`，便于请求字段逐字节对齐。 |
| 值落盘最大字节 | 固定传 `0` | `0=不按大小丢弃 JS value artifact`。 |
| 命中后延迟落盘 | `1` | JS 调用热路径仅保存值引用；命中请求后再批量写入去重制品。 |
| 延迟值池 bytes | `67108864` | 一轮内存值池上限；满时写 `trace.degraded`，不会同步写盘拖住页面。 |
| 请求回溯窗口 events | `8192` | 每个目标请求保留的最近 JS 调用窗口；独立于“普通 JS 总数保险丝”。 |

#### JS mode 选择规则

| 模式 | 何时选择 | 空候选时的结果 |
|---|---|---|
| `boundary` | 首轮、一轮回溯、补环境、按请求字段回刷 JS 调用窗口。 | 正常记录。 |
| `target` | 已加载 Agent 生成的脚本/函数/SHA-256 候选，只看目标函数。 | 自动使用 `boundary` 并提示。 |
| `deep` | 已确认目标函数且需要局部子调用树。 | 自动使用 `boundary` 并提示。 |
| `off` | 只采 Network/DOM/State。 | 不记录 JS Call。 |

首轮不会因空 target 集合得到 `JS=0`；精确 `target/deep` 也不会在没有候选时伪装成已生效。


### 3.7 验证码 / 鼠标轨迹 / 交互参数

默认降载不会关闭交互轨迹相关 DOM/BOM signal。它只关闭全站 JS 深值、全量 response、WASM dump 和全站 opcode 这类高成本项。验证码或风控参数依赖鼠标/触摸/坐标时，Agent 重点看：

```text
categorized/dom.jsonl
categorized/bom.jsonl
categorized/js.jsonl
categorized/network.jsonl
```

DOM signal 覆盖：

```text
addEventListener / removeEventListener / dispatchEvent
MouseEvent / PointerEvent / TouchEvent / WheelEvent / KeyboardEvent / InputEvent
clientX/clientY/pageX/pageY/screenX/screenY/offsetX/offsetY/movementX/movementY
button/buttons/modifier/pointerId/pressure/tilt/twist/pointerType/isPrimary
wheel delta、touch radius/force/changedTouches/touches、keyboard key/code/inputType
getBoundingClientRect/getClientRects/clientWidth/clientHeight/offset*/scroll*/value/dataset
elementFromPoint/elementsFromPoint/querySelector/activeElement
```

如果目标站把轨迹数组只存在 JS 内存里，首轮稳态日志会先给出事件监听、坐标读取、目标请求和候选脚本。Agent 再用自动候选开短窗口深值，而不是让用户手填脚本关键词或 PC。

### 3.8 卡顿处理

出现浏览器明显卡顿时按这个顺序处理：

1. 保持 `full-chain`，确认“普通 JS trace 不设总数保险丝”是打开状态；
2. 保持 Raw HTTP 关闭；
3. 保持 VM opcode / VM step / WASM dump 关闭，只留“一轮还原模式”；
4. 目标字段能确定位置时，只勾对应 query/body/header/cookie；
5. 如仍卡顿，改用 `discover-light` 触发一次目标请求，再让 Agent 根据 `target-candidates.json` 给短窗口补采建议。

### 3.5 ④ VM / WASM 细粒度

VM/WASM 细粒度默认不是全站深抓。它用于脚本已经锁定后分析 JSVM、opcode、WASM。

应用首轮采集计划或“默认关闭 VM”后，VM/WASM 细粒度全部关闭：

```text
JS opcode
VM window
raw operands
栈 slot 类型
栈 primitive 值
VM step
WASM module 元数据
WASM 模块 artifact
WASM raw bytes
VM/opcode 也不截断
```

默认保护值：

| 项 | 默认 |
|---|---:|
| VM window records | 65536（约 5 MiB/目标线程） |
| opcode 上限 | 4096 |
| opcode 执行预算 | 65536 |
| VM step 上限 | 2048 |
| opcode events/s | 2000 |
| opcode bytes/s | 4194304 |
| IPC events/s | 6000 |
| IPC bytes/s | 4194304 |
| stack slots | 2 |
| WASM module 上限 | 16 |
| WASM preview bytes | 128 |
| WASM dump max bytes | 1048576 |
| WASM insn 上限 | 512 |

规则：

- `目标脚本 contains` 是运行时内部过滤值，由工具从 `index/target-candidates.json` 自动生成；用户不填写脚本 URL、文件名或 chunk 关键词。
- `opcode PC 范围` 是 SpiderMonkey bytecode PC 的数字范围，格式 `START:END`。
- `dispatcher PC` 是 JSVM/解释器分发循环所在的单个 bytecode PC。
- “分析后自动套用”的意思是：先 trace 一轮，工具把请求 caller、`origin_call_id`、JS 调用链、值匹配和脚本 artifact 汇总为候选；Agent 只审核候选，下一轮由中控台自动带入脚本身份和已确认的 PC 结果。
- JSVMP 常见顺序：先选“一轮还原模式”拿请求/脚本/value 证据；Agent 写下一轮配置后优先选“VM window”取得目标前完整紧凑窗口；只有窗口摘要仍缺局部事实时才选“局部 opcode”，确认 dispatcher 后再选“VM step”。
- 做 JSVMP 时，前面的默认模块通常保留：JS、XHR、Fetch、DOM/BOM、Cookie、Storage、Script artifact 都继续开；VM 选项是附加细粒度证据。只有页面特别重或出现 degraded，再收窄脚本/函数或关闭无关模块。
- “VM/opcode 也不截断”会写 `TRACE_UNSAFE_ALLOW=1`，只适合锁定脚本后的一次短目标动作。
- 这些保护值是 VM/opcode/WASM 的保险丝，不是普通 full-chain 日志总上限。

### 3.6 VM/JSVMP 阶段预设怎么选

UI 现在提供阶段预设，普通使用不需要手动研究每个 checkbox：

| 预设 | 自动设置 | 你需要填写 |
|---|---|---|
| `一轮还原模式（推荐：请求触发回溯）` | 不开全站 opcode/VM step/raw operands；用请求命中回溯 JS/value/source ring buffer | 执行一次目标动作 |
| `VM window：目标触发环形缓冲` | 目标脚本写固定 80-byte 二进制记录；目标字段命中后一次落盘，不逐条 JSON/IPC | 加载 Agent 配置后执行同一个目标动作 |
| `局部 opcode：自动候选脚本` | 只在已有候选脚本/范围时开 JS opcode + raw operands；用于补 VM 证据 | 执行同一个目标动作 |
| `VM step：已确认 dispatcher` | 仅在 dispatcher PC 已确认后启用 VM step；否则保持局部 opcode/回溯策略 | 执行同一个目标动作 |
| `默认关闭 VM（普通 full-chain）` | VM/WASM 细粒度全部关闭 | 无 |
| `WASM：只看模块元数据` | 只看 WASM module 元数据 | 无；需要完整模块时再单独勾 artifact |

最常用的 JSVMP 操作是：一轮还原 → VM window → 按窗口摘要决定局部 opcode / VM step。多轮只传递脚本、PC 和状态角色，不跨轮复制动态值。

Agent 每到一个 VM 阶段都应该给用户明确提醒：

| 阶段 | Agent 需要告诉用户 |
|---|---|
| 请求/字段还没稳定 | 选“一轮还原模式”；JS opcode/VM step/WASM dump/raw 都不勾；只执行一次目标动作；请求出现后停止整理。 |
| target/value 第二轮 | Agent 先写 `$TRACE_DIR/agent-next.json`；用户点“② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json”。只有 env 文件时才展开“显示高级 / Agent 配置 -> ⑥ 额外环境变量”。 |
| VM window 轮 | 选“VM window：目标触发环形缓冲”；保持 opcode/VM step 关闭；目标字段命中后由 watchdog 停止整理。 |
| opcode 热点轮 | 选“局部 opcode：自动候选脚本”；JS opcode 和 raw operands 勾；VM step、栈 primitive、WASM dump/raw 先不勾；执行同一个短动作一次。 |
| dispatcher 轮 | 只有 Agent 明确给出 dispatcher PC 后选“VM step：已确认 dispatcher”；不要手填 PC；执行同一个短动作一次。 |
| VM 状态补证 | 只有 Agent 指出缺 VM state 时，才短窗口勾“栈 slot 类型”或“栈 primitive 值”。 |

前面的 JS、XHR、Fetch、DOM/BOM、Cookie、Storage、Script 默认模块继续保留，它们负责把 VM 结果和请求、环境、脚本来源连起来。

### 3.7 ⑥ 额外环境变量（高级）

每行一个：

```text
NAME=VALUE
```

常见例子：

```text
TRACE_JS_OBJECT_DEPTH=1
TRACE_FETCH_RESPONSE_BODY_MAX_BYTES=4096
TRACE_XHR_RESPONSE_BODY_STORE=1
TRACE_FETCH_RESPONSE_BODY_STORE_MAX_BYTES=0
```

UI 会把这些值合并进启动环境或运行时 config。显式填写的环境变量优先级最高。

环境变量文件只用于首轮 trace 之后的下一轮。首轮输出目录尚未产生时，⑤ 面板可以留空，不需要 env 文件；首轮停止并整理后，Agent 才根据该轮日志在 `TRACE_DIR` 下生成 `agent-next.env`。如果下一轮同时需要改动页面上的多个可见控件，Agent 应在同一目录生成完整的 `agent-next.json`。

当前 UI 还支持从文件一次加载完整配置或只加载环境变量：

| 按钮 | 作用 |
|---|---|
| `加载 Agent 完整配置…` | 在②采集计划面板直接可见；读取完整 `agent-next.json`，一次回填会话、字段、启用范围、采集强度、模块、JS/value、高级 VM/WASM 参数和 env。 |
| `加载当前目录 agent-next.json` | 在②采集计划面板直接可见；从当前输出目录 `TRACE_DIR/agent-next.json` 加载完整 Agent 配置。 |
| `加载 env 文件…` | 从任意 `.env` / 文本文件读取 `NAME=VALUE` 内容并填入文本框。 |
| `加载当前目录 agent-next.env` | 从当前输出目录 `TRACE_DIR/agent-next.env` 读取 Agent 写好的下一轮建议变量。 |
| `清空` | 清空额外环境变量文本框。 |

完整配置文件 schema 为 `firefox_trace.agent_config.v1`，顶层包含：

```text
ui       会话、目标字段、四个字段启用复选框、采集强度、启动模式、VM 阶段
modules  JS/XHR/Fetch/DOM/Cookie/Storage/Script/WebSocket/Raw HTTP
options  JS mode、脚本/函数过滤、对象/数组深度、值 metadata、事件保险丝
vm       opcode/operands/stack/VM step/WASM 复选框、身份、PC 和所有 limits
env      额外环境变量；可选 env_text 保留原始 NAME=VALUE 文本
```

完整样例见 `skills/firefox-trace-agent/references/agent-next.json.example`。

推荐 Agent 给下一轮配置时直接在当前 trace 输出目录写：

```text
$TRACE_DIR/agent-next.json
$TRACE_DIR/agent-next.env
```

然后告诉用户在 UI 里点击：

```text
② 首轮采集 / 目标字段 -> 加载当前目录 agent-next.json -> 应用配置/打开 Firefox
```

JSON 加载会先应用采集强度/VM 阶段默认，再应用文件中的显式 `options`/`vm` 值，因此 Agent 的窄过滤不会被预设覆盖；`.env` 按钮继续兼容只修改环境变量的旧流程。这样可以避免用户逐项输入、漏勾复选框或把脚本名截断。

---

## 4. 右侧按钮与状态

左右两侧都是可滚动区域。窗口高度不够时，把鼠标放到对应区域内滚动即可查看被遮住的信息；右侧状态、自动推导和日志区域也支持鼠标滚动。


| 按钮 | 作用 |
|---|---|
| 打开 Firefox | 按当前配置启动有头 Firefox。 |
| 应用配置 | 不重开浏览器，把当前模块/字段/JS/VM 设置写入 `trace-control.json`。 |
| 开始记录 | 先应用配置，再 start 当前 segment。 |
| 暂停记录 | stop 当前记录窗口，但不关闭 Firefox。 |
| 停止并整理 | stop 并执行 `trace_finalize.py`，生成 `categorized/` 和 `index/`。 |
| 关闭 Firefox | 先 stop/finalize，再结束本轮 Firefox 进程组。 |
| 打开输出目录 | 用系统文件管理器打开当前 `TRACE_DIR`。 |
| 新分段 | 在同一个 `TRACE_DIR` 中开启新的 segment，适合 discover -> target-values。 |

状态区重点看：

| 状态项 | 含义 |
|---|---|
| 阶段 | idle / opening / paused / recording / closed / exited。 |
| 健康 | 是否出现 `trace.degraded`。 |
| PID | Firefox launcher 进程 PID。 |
| 速率 | 当前每秒事件数。 |
| 累计 | 已看到的事件数与字节数。 |
| 分类日志计数 | dom/bom/js/network/state/script/worker/wasm-vm/control-health 的实时计数。 |

`ACK` 是配置真正生效的依据：写入 `trace-control.json` 只是发配置；`firefox-control-acks.jsonl` 中出现匹配 `control_version/config_hash` 的 `trace.config.applied`，才说明 content process 应用了配置。

---

## 5. 输出目录结构

一次采集输出一个 `TRACE_DIR`：

```text
TRACE_DIR/
  manifest.json
  trace-control.json
  ui-session.json
  ui-launcher.log
  firefox-control.jsonl
  firefox-control-acks*.jsonl
  firefox-js-*.jsonl
  firefox-xhr-*.jsonl
  firefox-fetch-*.jsonl
  firefox-websocket-*.jsonl
  firefox-dom-*.jsonl
  firefox-cookie-*.jsonl
  firefox-storage-*.jsonl
  firefox-script-*.jsonl
  values/
  scripts/
  source_maps/
  web-assets/
  categorized/
    dom.jsonl
    bom.jsonl
    js.jsonl
    network.jsonl
    state.jsonl
    script.jsonl
    worker.jsonl
    wasm-vm.jsonl
    control-health.jsonl
    request-fields.jsonl
index/
  summary.json
  causal-index.json
  request-timelines.json
  target-candidates.json
    web-assets.json
```

### 5.1 关键文件

| 路径 | 作用 |
|---|---|
| `manifest.json` | 目标 URL、preset、plan、启动模式、Firefox 路径、profile、所有关键环境变量。 |
| `trace-control.json` | 当前记录状态、segment、模块开关、config hash。 |
| `firefox-control-acks*.jsonl` | 配置应用 ACK。Agent 判断本轮是否可信要看它。 |
| `values/` | 完整长值、请求字段、body、response、JS args/return/object 的 artifact。 |
| `scripts/` | 浏览器内核捕获的脚本 artifact。 |
| `web-assets/` | finalize 后按页面/日志 URL 最佳努力下载的 HTML/JS。 |
| `categorized/` | 停止后按用途归类的 JSONL，Agent 首选入口。 |
| `index/summary.json` | 本轮总览、分类计数、目标字段命中、degraded 数、生成文件。 |
| `index/causal-index.json` | 请求字段、JS value SHA-256、origin 上下文和 producer 关联索引；`producer_match` 给出最深 exact return，`producer_chain` 给出紧凑父链，`producer_candidates` 保留完整候选。 |
| `index/request-timelines.json` | 按逻辑 request_id 汇总 XHR/Fetch 阶段，区分页面显式头和最终 HTTP channel 头；跨进程启发式关联带 `exact_id=false`。 |
| `index/target-candidates.json` | 工具自动排名的请求关联脚本、脚本匹配片段、精确脚本身份、opcode PC 范围和 dispatcher 候选；下一轮由中控台读取。 |

---

## 6. 每类分类日志怎么读

| 分类 | 看什么 | 能回答什么 |
|---|---|---|
| `request-fields` | 字段名、位置、raw/decoded SHA-256、value_store_path、composite_segments | 目标参数在哪个请求里、完整值在哪、能否拆段。 |
| `network` | XHR/Fetch/WebSocket/Raw HTTP，URL、query/body、headers、response、request_id、origin_call_id | 最终请求、入参、响应、服务端下发状态、请求与 JS 的 origin 关系。 |
| `js` | `js.call.enter/return`、`js.value.store`、args/return/object metadata、`call_id/parent_call_id/origin_call_id` | 目标字段在哪个函数出现、谁返回、谁传递、调用链怎么走。 |
| `script` | 脚本 URL、hash、artifact_path、source map | 算法脚本在哪里，纯算移植读哪个 JS。 |
| `state` | Cookie、localStorage、sessionStorage、IndexedDB 线索 | 哪些状态参与计算，补环境时需要保留哪些缓存/令牌。 |
| `dom` | document、element、canvas、事件、节点调用 | DOM 依赖、canvas 指纹、节点结构依赖。 |
| `bom` | navigator、screen、location、history、performance、crypto、permissions | 浏览器环境面、UA/screen/timezone/performance/crypto 等输入；全量 trace 的标量 getter 值汇总到 `index/environment-contract.json`。 |
| `websocket` | 归在 network 中；原始文件为 `firefox-websocket-*.jsonl` | WebSocket 动态 token、握手、frame payload。 |
| `wasm-vm` | wasm.module、wasm dump、js.opcode、js.vm_step | WASM/JSVM/解释器混淆的定位线索。 |
| `control-health` | config applied、trace.degraded、boundary flush summary | 本轮能否用于结论，哪里丢了证据。 |


### 6.3 还原顺序：先补环境验证，再字节级 diff

Agent 做复现时按这个顺序：

```text
请求/响应完整记录
 -> 字段位置与请求结构定位（query/body/headers/cookies）
 -> 用 trace 或当前 Firefox 页面补齐真实环境对象和值
 -> 在同一 Firefox page/profile 生成候选并验证实际请求和业务响应
 -> 请求失败时冻结完整 request vector，做 URL、headers、body 的 diff 级字节还原
 -> diff 暴露确定性算法缺口时进入纯算拆解
 -> 动态输入实时生成：时间、随机数、nonce、服务端 token、Cookie/Storage
 -> 以响应状态、响应内容和业务成功字段作为最终成功标准
```

动态阶段不要手工拼最终签名字段；固定部分和动态输入来源确认后，让原 SDK 或纯函数按合同生成。

完整 trace 缺少 `navigator`、`screen`、Canvas/WebGL、Storage、Promise
履约对象等浏览器内置值时，保持当前 Firefox 页面打开，使用 DevTools 控制台或
Firefox BiDi/RDP `script.evaluate` 读取目标对象的真实值、descriptor、原型链和
brand。这个动作优先于再次 trace；只有缺少调用因果、Worker/iframe/closure 状态、
请求顺序或原始传输字节时才生成下一轮配置。

---

## 7. Agent 标准读日志顺序

Agent 拿到一个 `TRACE_DIR` 后按这个顺序：

1. 读 `manifest.json`：确认 URL、plan、启动模式、目标字段、模块开关、普通 JS 是否 `FIREFOX_TRACE_JS_LIMIT_EVENTS=0`。
2. 读 `index/summary.json`：看 `degraded_count`、`request_field_count`、`target_field_match_count`（字段是否命中配置）、`target_match_count`（是否已和 JS value artifact 因果匹配）以及分类计数。
3. 读 `categorized/request-fields.jsonl`：确定目标字段的：
   - `request_id`
   - `location`
   - `field_name`
   - `value_sha256_raw`
   - `value_sha256_decoded`
   - `value_store_path`
   - `origin_call_id`
4. 读 `categorized/network.jsonl`：还原完整请求 URL、query/body、headers、response artifact。
5. 读 `index/causal-index.json`：先看 `producer_match` 和 `producer_chain`；需要审计完整匹配集合时再看 `producer_candidates`，`same_origin_context` 只作上下文。
6. 读 `index/target-candidates.json`：确认工具推荐的脚本、置信度、PC range 和下一轮阶段。
7. 读 `categorized/js.jsonl`：用 `call_id / parent_call_id / origin_call_id` 回溯生成/传递链。
8. 读 `categorized/script.jsonl` 和 `scripts/`：定位算法文件、hash、source map。
9. 读 `categorized/state.jsonl`、`dom.jsonl`、`bom.jsonl`：列环境/state 依赖账本。
10. 如果完整值只在 artifact 中，去 `values/` 读取并用 SHA-256 对齐。
11. 判断：纯算、补环境、混合、需要下一轮深采。

---

## 8. 补环境 vs 纯算判断

### 8.1 补环境

适合场景：

- JS 生成函数明确，但它读取大量 `navigator/screen/document/canvas/performance/crypto`。
- 字段依赖 Cookie/Storage/服务端响应状态。
- SDK 内部会动态生成 token、nonce、时间、随机数、环境对象。

正确做法：

```text
固定环境由 Agent 补；
动态值交给原网页 SDK / 原脚本生成；
不要直接手写最终 sign/token。
```

Agent 应做：

- 根据 BOM/DOM/state 日志补缺失 API 和固定属性；
- 保持 UA、headers、TLS 指纹、Cookie、Storage、JS 运行环境一致；
- 保留原 SDK 的动态生成函数，让它自己生成动态段；
- 用同一请求入参和动态时间重跑，比较 response / 字段格式 / SHA-256。

### 8.2 纯算

适合场景：

- 生成函数输入都是业务入参、固定 key、时间戳、nonce 等显式参数；
- DOM/BOM/state 只用于外层传参，不影响核心算法；
- 脚本 artifact 中能还原序列化、hash/crypto、编码和输出拼接。

纯算合同必须写清：

```text
函数名/版本
输入字段和类型
字段顺序
JSON / query 序列化方式
字符编码
hash / crypto primitive
输出编码和放置位置
浏览器 trace vector
本地复现 vector
```

---

## 9. `trace.degraded` 怎么处理

出现以下任一情况，本轮相关结论只能作为候选：

- 有 `trace.degraded`；
- `js.boundary.flush_summary.complete_window=false`；
- 目标字段缺完整 value_store；
- 目标 content process 缺匹配 ACK；
- 用户目标动作发生在 start 前；
- JS 总事件或 VM/opcode 保险丝触发。

处理顺序：

1. 不要直接扩大到全站 deep。
2. 先用 `request-fields` 和 `causal-index` 找候选脚本/函数。
3. 同一个 Firefox 会话点“新分段”。
4. 选择下一阶段；中控台从 `index/target-candidates.json` 自动套用脚本/函数身份。
5. 重新“开始记录 -> 操作一次 -> 停止并整理”。
6. 对 VM/opcode，选择对应阶段即可；脚本、PC 范围和 dispatcher PC 由 analyzer 结果自动带入。

---

## 10. 推荐多轮工作流

### 10.1 一轮 UI full-chain

适合用户要“一次操作尽量齐全”：

```text
active + full-chain + 默认模块
```

产物足够时，Agent 可直接：

```text
request field -> JS producer -> script artifact -> DOM/BOM/state -> reproduction
```

### 10.2 首轮低开销 discover-light

页面太重时：

```text
paused + discover-light
```

只找：

```text
目标请求
字段 SHA-256
origin_call_id
候选脚本
候选函数
环境/state 线索
```

### 10.3 缺口后的最终复现

首轮只有候选、缺少 init 参数、对象字段或生产函数入参/返回值时，Agent 在首轮目录生成完整 `agent-next.json`。用户加载后新建一个目录再执行同一次动作：

```text
full-chain + boundary + 全量 async spool
  + TRACE_JS_OBJECT_TARGET_ONLY=1
  + 自动候选脚本/函数 identity
  + object_depth=1 / keys=32 / array=16
```

这一轮不切到 `target`，因此仍保留全站 JS 边界和环境调用链；只有命中的对象会展开。只有首轮存在该明确缺口时才运行本节；后续最终报告、字节 diff 和离线复现只使用这个新目录，不把首轮日志拼接为证据。

目标：

```text
JS return/arg/object value metadata 与请求字段 SHA-256 对齐
```

### 10.4 VM/WASM 深采

只在这些条件满足后做：

- 已知道目标脚本；
- 已知道候选生成函数或 dispatcher；
- full-chain/target-values 仍解释不了；
- 操作窗口很短。

---

## 11. 常用 tools

| 工具 | 作用 |
|---|---|
| `tools/trace-desktop.sh` | 启动桌面 UI。 |
| `tools/run-trace-firefox.sh` | 底层启动 Firefox。 |
| `tools/trace-control.sh` | 对现有 `TRACE_DIR` start/stop/prewarm/config/new-segment/status。 |
| `tools/trace_finalize.py` | 生成 `categorized/`、`index/summary.json`、`index/causal-index.json`、`index/request-timelines.json`、`index/target-candidates.json`。 |
| `tools/trace_analyzer.py` | 离线找字段、脚本、函数和下一轮 env；当 request origin 只到 transport wrapper 时，用字段 SHA-256 解析最深 JS return producer 及父链。 |
| `tools/trace_store.py` | 多轮导入 SQLite，按 field/value/call chain 查询。 |
| `tools/trace_opcode_analyzer.py` | 分析 opcode 窗口，找热点 PC/dispatcher 线索。 |
| `tools/fetch_source_maps.py` | 根据 script 日志下载 source map。 |
| `tools/trace_check.py` | 检查 ACK、boundary、source-map、worker、websocket、wasm 等完整性。 |

---

## 12. 命令行配置

桌面 UI 会生成和应用这些配置；命令行排查时可直接调用：

```bash
tools/trace-control.sh "$TRACE_DIR" config \
  --preset target-values \
  --script-contains 'target-script.js' \
  --function-contains 'candidateFn' \
  --query-fields 'fieldA,fieldB' \
  --body-fields 'fieldC'
```

---

## 13. 交付检查清单

交给 Agent 前确认：

- `TRACE_DIR/manifest.json` 存在；
- `TRACE_DIR/index/summary.json` 存在；
- `TRACE_DIR/index/causal-index.json` 存在；
- `TRACE_DIR/index/target-candidates.json` 存在；
- `TRACE_DIR/categorized/request-fields.jsonl` 存在；
- 目标操作确实发生在记录窗口内；
- UI 健康状态没有显示严重 degraded；如果有，说明这轮只能当候选；
- 目标字段已填写在 Query 或 Body 字段框里；
- 若需要响应侧 token/配置，确认 Network response artifact 已落盘；
- 若要补环境，保留 Cookie/Storage/Profile 或记录其导出方式；
- 若要纯算，保留 `scripts/`、`web-assets/`、`source_maps/`。
