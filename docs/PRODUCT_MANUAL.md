# Firefox Trace 产品功能介绍与交付手册

版本：当前 UI / tools 交付版
面向：实际使用者 + 后续分析 Agent

Firefox Trace 是一套“可见 Firefox + 软件中控台 + 分类日志 + Agent 分析工作流”。用户在 UI 里输入 URL 和输出目录，打开 Firefox 后自己操作网页；工具在同一个 `TRACE_DIR` 中同时采集 Network、JS Call、DOM/BOM、Cookie/Storage、Script、WebSocket、WASM/VM 等证据，并在停止后整理成 Agent 易读的分类日志和索引。

本工具是通用采集框架，不绑定具体站点或字段名。默认字段只是常见安全参数候选；遇到任意目标字段，都在 UI 的“URL Query 字段 / POST Body 字段 / Request Header 字段 / Cookie 字段”里填写。

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

### 1.2 Web 中控台备用入口

```bash
tools/trace-console.sh --host 127.0.0.1 --port 8788
```

浏览器打开：

```text
http://127.0.0.1:8788/
```

### 1.3 命令行底层入口

```bash
TRACE_DIR="$HOME/Desktop/firefox-trace-outputs/firefox-trace-$(date +%Y%m%d-%H%M%S)" \
tools/run-trace-firefox.sh \
  --trace-preset full-chain \
  --trace-plan full-chain \
  --trace-start active \
  'https://example.com/'
```

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

- 首轮查链路：保持默认勾选，使用 `full-chain` + `打开即记录`。
- 目标字段出现在哪就填哪：query 填 Query，body 填 Body，header 填 Request Header，cookie 填 Cookie。
- JSVMP/WASM 是附加面板，不是替代前面模块；先让 Network/JS/Script/State 证据齐，再追加 VM/WASM。
- `contains` 这类输入是收窄关键词；`PC range`、`dispatcher PC` 是 Agent 看完上一轮日志后回填的分析结果。

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

### 3.2 ② 采集计划 / 目标字段

| UI 项 | 默认值 | 作用 |
|---|---:|---|
| 采集计划 | `full-chain` | 一次操作尽量收齐还原链路需要的多类日志。 |
| URL Query 字段 | `sign,signature,token,riskData,fp,nonce,timestamp,captchaId,securityToken,antiToken,authToken,checksum,digest` | 从 URL query 中抽取这些字段，保存 preview、size、SHA-256、value artifact。 |
| POST Body 字段 | 同上 | 从 XHR/Fetch body 中抽取这些字段。 |
| Request Header 字段 | 同上 | 从 XHR `setRequestHeader`、Fetch request headers，以及 finalize 可识别的 request headers 中抽取字段，输出 `location=headers`。 |
| Cookie 字段 | 同上 | 从 Cookie header、document.cookie、CookieStore、HTTP Set-Cookie、Cookie storage lifecycle 中抽取命名 cookie，输出 `location=cookies`。 |
| 采集强度 | `通用完整值落盘（默认）` | 控制对象预览、TypedArray、VM/WASM 预算等。 |
| 不限普通 JS trace 总事件数 | 默认开启 | 对普通 JS trace 写 `FIREFOX_TRACE_JS_LIMIT_EVENTS=0`。完整值落盘到 `values/`。 |
| 显示高级参数 | 默认关闭 | 展开 JS 对象深度、事件保险丝、VM/WASM 限额等高级项。 |

#### 为什么不是“所有东西直接塞进 JSONL”

长参数、响应体、JS 返回值默认走 `values/` artifact。主 JSONL 只保存：

```text
preview / size / sha256 / value_store_path / stored / truncated
```

这样既保真，又避免单行 JSONL 过大导致 UI 和 Agent 读取困难。`*_MAX_BYTES=0` 在本工具里表示 trace 层不按大小丢弃该 artifact。

#### `full-chain` 与 `discover-light`

| 计划 | 默认用途 | 默认采集 |
|---|---|---|
| `full-chain` | 用户手动操作时的一轮完整证据采集，当前 UI 默认推荐。 | JS boundary + 自动浅层 args/return、DOM/BOM signal、XHR/Fetch request/response、request headers、Cookie/Storage、Script artifact、WebSocket、WASM module 线索、长值落盘、请求触发时 boundary ring buffer flush。 |
| `discover-light` | 低开销首轮定位。页面很重或 full-chain 出现 degraded 时用。 | 请求、脚本、DOM/BOM signal、Cookie/Storage、JS boundary。默认减少值采集和深层对象展开。 |

### 3.3 ③ 模块开关

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
| XHR | `firefox-xhr-*.jsonl` / network | 看接口 URL、query/body、`xhr.header`、response、request_id。 |
| Fetch | `firefox-fetch-*.jsonl` / network | 同 XHR，覆盖 fetch API；`fetch.request.headers` 会按 Request Header 目标字段记录。 |
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
| 脚本 contains | 空 | 只采集 URL/文件名包含指定片段的脚本。二轮收窄使用。 |
| 函数 contains | 空 | 只采集函数名包含指定片段的调用。二轮收窄使用。 |
| target_match | `auto` | 目标匹配策略。底层 target preset 常用 `all`。 |
| 对象深度 | 默认强度写入 `1`；full-chain preset 内核默认浅层为 `0` | 对象递归展开深度。越大越重。 |
| 对象 keys | `0` | `0=不按 key 数截断`。 |
| 数组 items | `0` | `0=不按 items 数截断`。 |
| TypedArray bytes | `256` | TypedArray 预览字节数。 |
| 事件保险丝 | UI 默认强度 `0`，且“不限普通 JS trace”开启时强制 `0` | 普通 JS 总事件数保险丝。`0=不限`。 |
| 值 metadata | `1` | 记录短值/长值的 SHA-256、路径、角色、call_id。 |
| primitive metadata | `1` | number/boolean/null/undefined 也生成 metadata，方便找时间戳、flag、计数器。 |
| 值落盘最小字节 | `1` | 大于等于该大小的值可写入 `values/`。 |
| 值落盘最大字节 | 固定传 `0` | `0=不按大小丢弃 JS value artifact`。 |

### 3.5 ④ VM / WASM 细粒度

VM/WASM 细粒度默认不是全站深抓。它用于脚本已经锁定后分析 JSVM、opcode、WASM。

默认勾选：

```text
raw operands
WASM module 元数据
```

默认关闭：

```text
JS opcode
栈 slot 类型
栈 primitive 值
VM step
WASM 模块 artifact
WASM raw bytes
VM/opcode 也不截断
```

默认保护值：

| 项 | 默认 |
|---|---:|
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

- `目标脚本 contains` 是关键词/子字符串匹配；填脚本 URL、文件名或 chunk 名的一部分即可，不要求完整 URL。
- `opcode PC 范围` 是 SpiderMonkey bytecode PC 的数字范围，格式 `START:END`。
- `dispatcher PC` 是 JSVM/解释器分发循环所在的单个 bytecode PC。
- “分析后填写”的意思是：先 trace 一轮，Agent 读 `wasm-vm/js/script` 日志和 `trace_opcode_analyzer.py` 输出，找出热点 PC 范围或 dispatcher PC；然后你把结果填回 UI，再 trace 第二轮更窄窗口。
- JSVMP 常见顺序：第一轮普通 `full-chain` 找目标请求和脚本；第二轮只勾 `JS opcode`，填 `目标脚本 contains`，`opcode PC 范围 / dispatcher PC` 先留空；Agent 分析后第三轮填 `opcode PC 范围` 或打开 `VM step` 并填 `dispatcher PC`。
- 做 JSVMP 时，前面的默认模块通常保留：JS、XHR、Fetch、DOM/BOM、Cookie、Storage、Script artifact 都继续开；VM 选项是附加细粒度证据。只有页面特别重或出现 degraded，再收窄脚本/函数或关闭无关模块。
- “VM/opcode 也不截断”会写 `TRACE_UNSAFE_ALLOW=1`，只适合锁定脚本后的一次短目标动作。
- 这些保护值是 VM/opcode/WASM 的保险丝，不是普通 full-chain 日志总上限。

### 3.6 VM/JSVMP 阶段预设怎么选

UI 现在提供阶段预设，普通使用不需要手动研究每个 checkbox：

| 预设 | 自动设置 | 你需要填写 |
|---|---|---|
| `默认关闭 VM（普通 full-chain）` | VM 关闭，保留轻量 WASM module 元数据 | 无 |
| `JSVMP 第1轮：opcode 热点定位` | 勾 `JS opcode + raw operands`，关闭栈值、VM step、WASM artifact | 目标脚本关键词 contains |
| `JSVMP 第2轮：填 PC 范围窄采` | 保留 opcode + raw operands | 目标脚本关键词 + Agent 给出的 `START:END` |
| `JSVMP 第3轮：填 dispatcher 开 VM step` | 只开 VM step，减少 opcode 展开 | 目标脚本关键词 + dispatcher PC |
| `WASM：只看模块元数据` | 只看 WASM module 元数据 | 无；需要完整模块时再单独勾 artifact |

最常用的 JSVMP 操作就是：选择“第 1 轮”→ 填 contains → trace；Agent 分析完后选择“第 2 轮”或“第 3 轮”→ 回填结果 → 再 trace。

前面的 JS、XHR、Fetch、DOM/BOM、Cookie、Storage、Script 默认模块继续保留，它们负责把 VM 结果和请求、环境、脚本来源连起来。

### 3.7 ⑤ 额外环境变量（高级）

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

---

## 4. 右侧按钮与状态

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
| `index/causal-index.json` | 请求字段、JS value SHA-256、origin 上下文、候选 producer 的关联索引。 |

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
| `bom` | navigator、screen、location、history、performance、crypto、permissions | 浏览器环境面、UA/screen/timezone/performance/crypto 等输入。 |
| `websocket` | 归在 network 中；原始文件为 `firefox-websocket-*.jsonl` | WebSocket 动态 token、握手、frame payload。 |
| `wasm-vm` | wasm.module、wasm dump、js.opcode、js.vm_step | WASM/JSVM/解释器混淆的定位线索。 |
| `control-health` | config applied、trace.degraded、boundary flush summary | 本轮能否用于结论，哪里丢了证据。 |


### 6.3 还原顺序：先字节级 diff，再动态

Agent 做复现时按这个顺序：

```text
请求/响应完整记录
 -> 字段位置与请求结构定位（query/body/headers/cookies）
 -> 固定输入下做 URL、headers、body 的 diff 级字节还原
 -> 本地固定向量与浏览器 trace 逐字节一致
 -> 再处理时间、随机数、nonce、服务端 token、Cookie/Storage 等动态输入
 -> 使用用户给的实际 URL 发起动态请求
 -> 以响应状态、响应内容和业务成功字段作为最终成功标准
```

动态阶段不要手工拼最终签名字段；固定部分和动态输入来源确认后，让原 SDK 或纯函数按合同生成。

---

## 7. Agent 标准读日志顺序

Agent 拿到一个 `TRACE_DIR` 后按这个顺序：

1. 读 `manifest.json`：确认 URL、plan、启动模式、目标字段、模块开关、普通 JS 是否 `FIREFOX_TRACE_JS_LIMIT_EVENTS=0`。
2. 读 `index/summary.json`：看 `degraded_count`、`request_field_count`、`target_match_count`、分类计数。
3. 读 `categorized/request-fields.jsonl`：确定目标字段的：
   - `request_id`
   - `location`
   - `field_name`
   - `value_sha256_raw`
   - `value_sha256_decoded`
   - `value_store_path`
   - `origin_call_id`
4. 读 `categorized/network.jsonl`：还原完整请求 URL、query/body、headers、response artifact。
5. 读 `index/causal-index.json`：查看 `producer_candidates` 和 `same_origin_context`。
6. 读 `categorized/js.jsonl`：用 `call_id / parent_call_id / origin_call_id` 回溯生成/传递链。
7. 读 `categorized/script.jsonl` 和 `scripts/`：定位算法文件、hash、source map。
8. 读 `categorized/state.jsonl`、`dom.jsonl`、`bom.jsonl`：列环境/state 依赖账本。
9. 如果完整值只在 artifact 中，去 `values/` 读取并用 SHA-256 对齐。
10. 判断：纯算、补环境、混合、需要下一轮深采。

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
4. 填 `脚本 contains` / `函数 contains`，切到更窄的 target/deep 配置。
5. 重新“开始记录 -> 操作一次 -> 停止并整理”。
6. 对 VM/opcode，先填目标脚本 contains；opcode PC 范围和 dispatcher PC 由 analyzer 给出后再填。

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

### 10.3 二轮 target-values

如果首轮只有候选，没有完整生成侧：

```text
新分段 -> 填脚本/函数 contains -> target-values/deep-causal 风格配置 -> 再操作一次
```

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
| `tools/trace-console.sh` | 启动 Web UI / HTTP API。 |
| `tools/run-trace-firefox.sh` | 底层启动 Firefox。 |
| `tools/trace-control.sh` | 对现有 `TRACE_DIR` start/stop/prewarm/config/new-segment/status。 |
| `tools/trace_finalize.py` | 生成 `categorized/`、`index/summary.json`、`index/causal-index.json`。 |
| `tools/trace_analyzer.py` | 离线找字段、脚本、函数和下一轮 env 建议。 |
| `tools/trace_store.py` | 多轮导入 SQLite，按 field/value/call chain 查询。 |
| `tools/trace_opcode_analyzer.py` | 分析 opcode 窗口，找热点 PC/dispatcher 线索。 |
| `tools/fetch_source_maps.py` | 根据 script 日志下载 source map。 |
| `tools/trace_check.py` | 检查 ACK、boundary、source-map、worker、websocket、wasm 等完整性。 |

---

## 12. HTTP API 速查

Web 中控台启动后可用：

```bash
curl -sS "http://127.0.0.1:8788/api/session/status?trace_dir=$TRACE_DIR"
curl -sS "http://127.0.0.1:8788/api/summary?trace_dir=$TRACE_DIR"
curl -sS http://127.0.0.1:8788/api/start \
  -H 'content-type: application/json' \
  -d '{"trace_dir":"'"$TRACE_DIR"'","label":"target"}'
curl -sS http://127.0.0.1:8788/api/stop \
  -H 'content-type: application/json' \
  -d '{"trace_dir":"'"$TRACE_DIR"'","label":"after-target","finalize":true}'
```

运行时修改配置：

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
- `TRACE_DIR/categorized/request-fields.jsonl` 存在；
- 目标操作确实发生在记录窗口内；
- UI 健康状态没有显示严重 degraded；如果有，说明这轮只能当候选；
- 目标字段已填写在 Query 或 Body 字段框里；
- 若需要响应侧 token/配置，确认 Network response artifact 已落盘；
- 若要补环境，保留 Cookie/Storage/Profile 或记录其导出方式；
- 若要纯算，保留 `scripts/`、`web-assets/`、`source_maps/`。
