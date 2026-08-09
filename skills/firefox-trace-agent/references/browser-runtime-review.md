# Browser Runtime Review

更新时间：2026-08-06

这份记录总结 Firefox Trace 运行时的通用能力边界和审计方法。站点、脚本、字段、
trace 路径和具体差异必须写在对应的 `examples/<case>/`，不写入这里。

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
