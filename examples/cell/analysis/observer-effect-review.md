# Cell：轻量成功轮与 full-chain 失败轮的观察者效应分析

## 结论

**Observed**：轻量轮日志显示站点产品/首页资源、会话 Cookie 和 `/ssoSessionCheck` 请求；结合用户已进入首页的观察，它是本轮正常导航的行为基线。新一轮记录了 4 次 `Script terminated by timeout`，随后还出现独立的退出阶段 AsyncShutdown 超时。界面没有卡死，不等于页面 JS 正常完成。

**Inferred**：目前证据支持高成本 Trace 对页面执行/时序造成明显扰动；还没有受控 A/B 或 CPU 栈采样把全部原因唯一归到某个开关。两轮的浏览器构建、profile、时间和采集面都不同，不把它们假称为单变量实验，也不把服务器响应状态单独当作验证结论。

当前日志已经足够推进**采集器性能与证据表示**分析，先不要求再抓一轮全量数据。本轮仅新增分析文件；没有启动浏览器、修改源码、修改下一轮配置或改写用户日志。

## 直接证据

| 指标 | round1 轻量轮 | round2-values |
|---|---:|---:|
| 原始 JS JSONL | 200,993,170 bytes（191.7 MiB） | 1,938,006,918 bytes（1.80 GiB） |
| JS 事件 | 350,084 | 1,155,529 |
| JS 时间跨度 | 55.496 s | 182.844 s |
| js.script.enter/return | 0 | 518,777 |
| 页面脚本被超时终止 | 0 | 4 |
| trace.degraded | 23 | 0 |
| 首页相关资源/会话链 | 有 | 未出现与轻量轮相同的推进 |

脚本超时警告位于 `/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/traces/round2-values/ui-launcher.log` 第 54、66、92、120 行。退出阶段的 Fatal AsyncShutdown 在第 161 行，属于另一个问题，不混为验证阶段失败原因。

新轮某些 XHR 的 open→send 间隔为 12.090 s、23.715 s，send→response 间隔最长 37.594 s。后者包括网络、页面调度、IPC 与回调交付，不称作纯服务器响应时间。轻量轮自身也有慢段，单个请求时长不构成唯一归因；明确的脚本超时终止更直接。

## 真正昂贵的部分仍在热路径

**Observed：长值在主 JSONL 中重复展开。**

- JS string preview 共 60,577 次，累计 766,859,227 个字符。
- 超过 4096 字符的 preview 只有 607 次，却贡献 766,233,551 字符；最大单个 preview 为 1,337,359 字符。
- 最大单条 call JSONL 为 1,338,900 bytes，约 1.28 MiB。
- JS 值制品引用 60,147 次，只对应 7,512 个不同路径；重复引用 52,635 次，单制品最多被引用 978 次。
- 额外 script enter/return 记录占 378,188,176 bytes；该事件面是轻量轮没有的，因此也要计入采集面扩张，而不是把所有增长都归到业务活动。

**Observed：源码的值路径不等同于异步日志批处理。**

1. `TRACE_JS_MAX_VALUE_BYTES=0` 在 `FirefoxTraceJSMaxValueBytes()` 中转换成 `0xffffffff`，长 preview 也被完整转码/转义写入 JSONL。
2. full-spool 只让 JS 事件批量输送；字符串值的 deferred pool 分支还额外要求 `!FirefoxTraceJSFullSpoolEnabled()`，因此本轮会走逐次 value-to-parent 路径。
3. 父进程虽按 SHA 文件存在性避免重复写文件，但判断发生在 IPC 到达以后；发送端的值编码、哈希、数据复制与消息成本依然存在。
4. 本轮没有单独的 `js.value.store` 事件。summary 中 636,161 个 value-capture event 是带值的 call 记录数，正好对应 call enter/return，不误报为“额外生成了 63 万条 value.store”。

**Inferred**：上一轮批次复用文件句柄消除了一个文件开关放大点，但没有解决这些值编码/大 JSON/逐值 IPC 开销。本地小靶场通过也没有证明高频页面的端到端时序不受影响。

## 证据保留有两层问题

新轮 health 的唯一 incomplete reason 是 `request:target_value_without_complete_artifact`：11 个 Cookie 索引记录声明完整值 597 bytes，却仅保留 512 字符 preview，且没有 artifact 路径。

其中两条原始 `cookie.http_set` 和一条 `cookie.lifecycle` 仍包含完整标量；已用 SHA 相等比较确认，未输出 Cookie 内容。故应区分“原始源事件保留”与“派生索引未指向完整值”，不能把三条源数据也误报为已丢失。其余 HTTP header 来源尚未从合并 header 中逐项重建，本轮不宣称全部字段已补齐。

新轮有两次服务端 Cookie 下发，但后续仍重复初始化并发生脚本超时，因此既不称作“完全没有收到状态”，也不把 Cookie 下发本身称为整个导航验证成功。

另有一个配置审计问题：manifest 的环境变量白名单没有记录 full-spool、script dump/hash 等键，而 trace-control.json 中保留了它们。缺少 manifest 字段不等于配置没有加载；这属于清单可审计性缺口。

## 接下来优先改什么（本轮尚未实施）

优先改通用采集器，不要求再跑这份重配置：

1. **有界 JSON preview + 完整独立制品**：限制展示文本，不限制实际值证据；每次调用仍保留 call_id、参数位置/顺序、类型、完整长度、SHA 与制品引用。
2. **发送端按内容去重 + 批量制品队列**：重复出现时输送引用，避免同一内容每次都跨 IPC。保留每次出现的事件，不通过抽样丢掉因果关系。
3. **stop/drain/ACK 完整性**：制品持久化成功后再声明 stored；停采等待队列落盘，失败写明 health 缺口，避免性能优化变成静默丢证据。
4. **补齐派生索引与 manifest**：原始完整值应生成可检索制品/引用，关键实际开关应记入清单。
5. 先在自包含本地负载上验证正常计算结果、时序/心跳、证据字节和队列排空；远端行为只能作为后续实际浏览结果，不把微基准倍数当作整站提速。

轻量轮足够作当前行为基线，但其缺失的调用、值和源脚本仍是缺失，后续如需更细 VM 状态，按具体证据缺口处理，不把不同轮次动态值拼成一个完整向量。

## 文件

- 原始输入：`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/traces/round1`、`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/traces/round2-values`，均只读消费。
- 结构化统计与输入 SHA：`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/analysis/observer-effect-comparison.json`。
- 本报告不包含会话令牌、请求 payload 或站点算法源码。
