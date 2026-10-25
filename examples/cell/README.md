# Cell：Trace 性能与证据保留

## 当前状态（2026-10-24）

- **collector-v2（值传输改造）已构建并验收**：`runtime-v2/Nightly.app`。发送端按内容去重、内联 preview 512B 封顶（有制品时）、NUL 安全长度、真实 IPC 发送结果、stop 前 flush。本地 A/B：三测试值（含内嵌 NUL）制品级全等、`max inline 515B`、同负载 JS 日志 3.77MB→0.25MB（-93%）、心跳 380ms、零 artifact 错误。单测 7/7（`tests/test_trace_value_transport.py`、`tests/test_trace_batch_writer.py`）。
- **round3（runtime-v2 实采）验证通过**：watchdog 75.5 秒命中 `cf_clearance`（`cookie.http_set`，来自 `www.cell.com/cdn-cgi/challenge-platform/h/b/fo/…` 响应），`trace.degraded=0`，值捕获完整，17.2 万 JS 事件。round2 过不去的验证这次通过了。产物在 `traces/round3-transport`。
- **Node 补环境推进到 Turnstile VM 墙**：`node-env/harness.js` 纯 Node 跑通 chl_page VM 初始化、iframe realm 反篡改、原始内建抓取、Worker 探测，并发出首个 `eb/` 信标 open；最终 `fo/` 清除 POST 依赖 Turnstile iframe 载荷（824KB VM）定义的每会话全局。详见 `node-env/FINDINGS.md`；Python 编排骨架 `node-env/client.py`。
- **VM window 公式打通（round8）**：`TRACE_EXECUTION_MODE=opcode`（否则 JIT 让环形缓冲恒空）+ `TRACE_OPCODE_SCRIPT_CONTAINS=chl_page,turnstile/f/av0` + `TRACE_HEADER_FIELDS=cf-chl` 触发冻结。制品 `traces/round8-vmwindow/firefox-vm-window-*.bin`（65,536×80B，冻结前 1.44s/403 万条指令尾部），解析器 `node-env/vm_parse.py`。rounds 4-7 为推导该公式的失败尝试（已清至索引级）。
- **CNmxZ4 真身（15:00）**：=VM 自管**数组**（eval 顶部 `=[]`，定义桥即 push）——外部登记无效，等待环随 VM 自身定义桥自然清除；当前岔路=unified 类后 iframe 检查 `Sw(SQ)===null` 裸 TypeError，下一步步进抓 SQ 实参。
- **建签分支达成（14:00）**：全 5 桥定义+CNmxZ4 post-eval 登记→VM 走到自建 script 标签（DraY9 URL）；当前单点=api.js 的 Mt() 标签校验（解码完成：instanceof HTMLScriptElement + src 正则），修复后链条直通 render→PoW。
- **按 trace 重建 realm（13:00）**：值取 dom 账本（92 读取）、原型链取 environment-contract（362 对象链逐字转录），buildRealmClasses 暴露构造器+XPrototype holder；api.js 在其中无错运行。
- **widget realm 上线（11:00）**：api.js 在伪 iframe realm 内完整评估（86KB 无错），注册第 3 个 message 监听器——双向协议端点首次同时在线；挂点=realm api.js 等启动输入（extraParams/渲染目标）。
- **探针 A 完成+载荷逐层 boot（20:00）**：W 级缺失面批量补齐（parseInt 族/Uint8Array/TextEncoder/trustedTypes/桥镜像/canvas selfHeal）；载荷 boot 深入至自身嵌套 VM 层，按"跑→抓错→stub→重跑"循环推进。
- **stage-2 解码+等待环全清（17:00）**：fo/#1 响应 JS（3305B，cH 重写+桥定义）已按浏览器语义 eval→桥全部就位→等待环 A/B 清除→orchestrate 进入 apiJsMismatchReload 阶段（下一步：turnstile 导出与 reload 判定解码）。
- **环 B 门破解（10:00）**：856/857='HKul9'/'QPUYE4'（probe_gate.js 解码），预登记后 VM **创建 widget iframe**（新里程碑）；CNmxZ4 归 orchestrate 所有（外部抢注被重置）。下一步抓 iframe src。
- **种子解码+协议驱动器（09:00）**：`execute.cs=[[0,39974,栈证明,1]]`（PoW 输入形态）；protocol-driver.js 按协议时序驱动；harness 撤桥预定义后判定：orchestrate 定义桥分支的上游门未过（双等待环 A/B 同族，SV=10000 重试预算）。
- **协议完整提取（08:00）**：内核增强（TRACE_DOM_ARG_OBJECT_DEPTH）构建落地，round12 提取 **323 条逐字段 postMessage 协议**（meow/food 心跳、init、execute 挑战命令等）→ `traces/round12-payload/postmessage-protocol.json`。widget 仿真驱动层规格已齐。
- **协议提取现状（07:00）**：310 事件 postMessage 对话已录（双向），payload 需内核定向展开增强（规格已写入 FINDINGS 终稿七，走已验证管线）。
- **等待循环解码（06:00）**：VM 停车真身=`_cf_chl_opt.CNmxZ4.includes('XnuWO5'/'AKECH4'/'coTgT4')` 回调登记名单轮询（b4=字符串表读取器，条件断点+调用帧求值直接读出）。登记机制已实装，该层已清，推进至下一层等待。方法论闭环写入 FINDINGS。
- **确定性调试闭环（05:20）**：pinned 会话 + CF 动态反调试中和（Function 包装）+ 单步进 VM 成功（GH 续跑 88 步实录：b4 派发/h 处理器/hl 光标 30944→31540 后正常返回）。停车重定位在回调返回后。
- **值级对拍工具交付（04:30）**：`node-env/step_debug.js`（无头 CDP 单步器，400 步实测）+ 条目字段级对拍完成（GH 全字段读取序列已录）。停车不在条目值；下会话 stepInto GH 逐 case 对拍 GZ。
- **Gc/tZ 已解 + VM 入 widget 段（04:00）**：Gc/tZ=PerformanceObserver 回调，VM 以 performance 条目为事件泵；harness 实装后 VM 推进至 `querySelector(.main-content)`+`URLSearchParams('onload=…&render=explicit')` 解析段，剩余停车在 `GZ` switch 内（GE 的 3500ms 定时器未注册前）。
- **fo/#1 冻结窗 + 函数映射（round11）**：watchdog 抢在第一条 `cf-chl` 处冻结，262,144 满环 + js 日志保留。映射：PoW=orchestrate 内 `run(0,26,…)`，VM 类 `new Hl@2:7539`，指令处理器 `a6@3:37065`，async 驱动 `Gc/tZ<@3:7028`，api.js 前置工厂 `eA@2:104846`。详见 `node-env/FINDINGS.md`。
- **VM 双窗 + JSOp 精确映射（round9）**：262,144×80B 满环覆盖 fo/#3 前完整 Turnstile iframe VM（5.49s）；JSOp 编号表已导出，窗口热点 `JumpTarget/Case/TableSwitch` = JSVMP switch 派发循环实锤。
- **Node harness 连破 PerformanceObserver 真回调与 coTgT4**（`api.js?onload=coTgT4` 注入后回调真实触发、orchestrate 轮询停止）；当前墙：widget 会话对象（`jsobj`，orchestrate 以 this 反复调其方法）尚未还原。
- **Node harness 再推三层**：流/套接字构造器面注入过 Worker 检测、RTCPeerConnection 永_pending Promise、手工注入 turnstile api.js 成功执行并定义 `window.turnstile`；剩余墙：`coTgT4` 全局定义者未定位（非 api.js），orchestrate 停在轮询它。详见 `node-env/FINDINGS.md`。
- **磁盘清理（第二轮）**：rounds 3-8 原始 JS 流与 profile 缓存已删（值制品/脚本/索引/VM 制品全保留），case 目录 6.3G→1.8G。

## 直接使用（下一轮：VM window 公式已验证版）

完整下一轮配置：`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/agent-next.json`（round9-vmwindow，round8 实证公式）。

1. 先关闭仍在运行的 Firefox 会话。
2. 中控台 **② 首轮采集 / 目标字段 → 加载 Agent 完整配置…** 选择该 JSON。
3. 打开即记录，完成一次验证；第一条 `cf-chl` 头出现时 VM 窗口即冻结（第一次 PoW），页面进入正常内容后停止整理。

rounds 3-8 已由 Agent 执行完毕（round3 完整证据轮；round8 VM 制品轮），无需重复。

## round1：已观察到什么

- `discover-light`、`boundary`、JIT、active 启动；四个目标字段 scope 全部禁用，request-fields 为 0。
- JS 流 **350,084 条 / 200,993,170 bytes**，不是轻量模式就天然低开销。配置虽写了 50,000 事件预算，实际流已超出该数；当前源码的 boundary 入缓冲路径在总数保险丝检查前返回，不能把该数字当作已生效的保真/生命周期保障。
- health 明确不完整：`ipc:event_budget`、`js:boundary_buffer_overwrite`、`environment:value_capture_incomplete`。
- 两条 boundary 覆盖记录分别为 6,252 和 52,914；另有 21 条 IPC budget 标记。JS value 制品为 0，6 条 script.resource 都未保存原始脚本。
- 主挑战页面和挑战 iframe 的脚本占绝大多数 JS 事件；11 个网络 origin 锚点只找到 6 个，其中挑战相关的 5 个未保留到可回溯的 call。
- 可观察链路：顶层初始化 → iframe/子请求 → 多次请求响应 → 服务端设置 `cf_clearance` → 站点普通资源与会话检查。这里的时间顺序属于上下文证据；HTTP 200、401、204 各自不代表整个业务验证成功。
- `cf_clearance` 是服务器发出的 Cookie 状态里程碑，不是已找到的客户端 JS return。
- `product.js` 排名来自 **static-fallback**，不是已证明的 VM/producer 身份。未观察到 opcode、VM window、VM step 或 WASM 证据，尚无经过验证的 PC/dispatcher。

完整、可重复生成的脱敏清单见 `analysis/round1-review.json`；原始 round1 日志保留且没有重新 finalize 或改写。

## 下一轮配置为什么这样选

已逐项阅读 PRODUCT_MANUAL、TRACE_MODE_PLAYBOOK、Skill 和 UI 参数映射，并用真实桌面加载器验证：

| 项 | 本轮值 | 目的/边界 |
|---|---|---|
| 计划 / JS | full-chain / boundary | 保留请求关联与调用边界，不进入全站 deep |
| 启动 | active，新 profile / 新输出目录 | 捕获加载期初始化；不复用上一轮已经发放的挑战状态 |
| 普通 JS 总数 / IPC 速率上限 | 0 / 0 | 不靠丢掉调用或 IPC 事件降低负载 |
| full spool / value store | 开启 | 连续批量输出，保留可用的标量、字符串与值制品 |
| JS 对象深度 | 0 | 不递归访问 getter/Proxy，不做全站对象图遍历；深层对象状态留待明确缺口后的定向补采 |
| DOM/BOM | signal，all 事件类别/preview，合同和值启用 | 保留信号 API；这不是所有非 signal WebIDL 成员的全量覆盖 |
| XHR / Fetch | 请求体、响应体、头、完整 URL | 即使 opaque body 没有可命名字段，仍保留整个逻辑报文制品 |
| Script | resource capture/store + JS script dump/hash | 不依赖 finalize 事后下载来冒充同轮源脚本 |
| 目标字段 | Cookie=cf_clearance，其余禁用 | 位置来自日志；不乱填 sign/token，也不把服务端 Cookie 当作 JS producer |
| opcode / VM window / VM step / WASM / Raw HTTP | 全关 | 当前没有足以选择细粒度 VM 的身份或 PC 证据 |

这轮是**标量/脚本/请求证据补齐轮**。配置承诺的是明确的采集范围，不承诺递归对象、每条 JIT 内联调用或整段 VM 状态都已覆盖；完整性以新一轮 health、ACK、脚本和值制品逐项验收为准。后续若确有 VM 缺口，先锁真实脚本，再选紧凑二进制 VM window，最后才是局部 opcode/dispatcher。

## 已落地的通用修复

1. **父进程批量写盘**：原先 batch receiver 仍逐行 `mkdir/fopen/fwrite/fclose`；现为每个 IPC batch、每个模块复用句柄，批次结束关闭。仍逐条执行原来的过滤、模块路由和 segment/config 装饰，不抽样、不改字段、不重排模块内事件。
2. **watchdog Cookie URL**：document.cookie 只有 page_url，原 URL 过滤漏掉它。现仅在 Cookie 无显式 URL 时回退 page_url；有真实请求 URL 时仍按请求端点匹配，避免别的 XHR/Fetch 抢停。
3. **首次启动后的签名**：开发产物 `.purgecaches` 会在首次运行时被消费，原打包把它封进签名后会变成缺失资源。两个安装脚本在签名前只清理 bundle 内该标记；最终运行后整包严格签名验证通过。

这些修复不含站点字段或站点专用内核逻辑。Gecko 改动已同步进主补丁包；工具副本按原文件分别打补丁，没有把不同安装器整份替换为同一实现。

## 验证结果与尚待验证项

- 同一原始 JS 流写盘微基准：baseline 14.749s / batch 0.321s / rollback 15.727s；打开文件次数 350,084 → 384。
- 三次输出均为 350,084 条、200,993,170 bytes，SHA-256 均为 `febf90bb85b4403cb61f0877ef4effb22e9c2e2b9358477224a13a6a52cc8823`。这是**写盘路径微基准**，不代表整个浏览器或 Cell 页面同等提速。
- dom/ipc 实际编译、libxul 实际链接通过；新 runtime 仅装到本案例目录。
- 最终 localhost 有头靶场：2,000 次合成算术 dispatch；耗时 236 ms，5 次心跳，最大心跳间隔 152 ms。watchdog 命中后 stop/ACK/finalize 均成功；health 无 degraded，保留请求、完整字符串制品和内联脚本 source。
- 配置经过 `apply_agent_config → open_payload → resolve_payload_* → startup_env_from_payload` 的真实逻辑，24 项关键 env 验证通过，不只是 JSON 语法检查。
- Trace 单元测试与手册同步测试见 `verification/tests.log`、`verification/manual-sync-tests.log`。一次全套测试在无 Pillow 的解释器上导入既有站点发布用例失败；该依赖问题单独保留在 `verification/all-tests.log`，不伪报全套通过。
- **NOT RUN：Cell 远端重采与实际性能验收**，由用户加载配置后执行。旧日志没有性能采样栈，因此父进程写盘是源码/回放证实的放大点，不是所有卡死原因的唯一归因。对象序列化、逐值 artifact IPC 和长任务仍需新日志观察。

## 修改、验证与回滚

- MODIFIED：Gecko ContentParent/BatchWriter、主 Gecko patch、watchdog 与安装器及其分发副本、回归测试；清单与修改前后 SHA 见 `verification/change-manifest.json`。
- DIFF：`verification/DIFF.patch`，相对本次开始时的状态，保留原有 Gecko 修改。
- VERIFICATION：`verification/VERIFICATION.txt`，含实际编译、回放、配置加载、运行和回滚记录。
- ROLLBACK：`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/ROLLBACK.sh` 默认只校验；`--apply` 恢复本次修改前的源码/工具；遇到后续用户编辑时按 SHA 停止。浏览器回滚可在中控选择原运行时，原 app 从未被覆盖。

## 本地靶场复现

本地 HTML 不包含网站 SDK，仅有 switch 算术分发、心跳、一个 localhost 请求与完成 Cookie：

```bash
CELL_SMOKE_LABEL=local-$(date +%s) /opt/miniconda3/envs/firefox-trace/bin/python -B "/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/lab/run_smoke.py"
```

该脚本只打开一个独立有头 Firefox，立即启动 120 秒/2 GiB watchdog；目标出现后 stop/finalize，再关闭自己创建的进程组。输出仍在本 cell 文件夹。需要窗口环境及正常 macOS 应用进程权限。
