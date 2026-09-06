# 5s 案例调试手册

本文只记录本案例的实操方法和易错点。状态、文件地图和接手顺序见
[`HANDOFF.md`](HANDOFF.md)。

## 1. 一轮本地诊断

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
node --check examples/5s/cloudflare-runtime.js
CLOUDFLARE_DIAGNOSTIC_ENCODER=1 \
node examples/5s/validate-local-chain.js https://simple.ripley.com.pe/
```

优先读取：

```bash
jq '{stage_gate,final_response_gate,homepage_response_gate,cookies,homepage}' \
  examples/5s/runtime-data/local-validation-result.json

jq -r '.observed_dynamic_requests[] |
  [.seq,.transport,.method,.path,.body.size,.bridge_response.status] | @tsv' \
  examples/5s/runtime-data/local-validation-runner.json

jq -r '.worker_log[] | select(.op|test("postMessage|message|fetch")) |
  [.op,(.url // .frame // ""),((.preview // "")|tostring)] | @tsv' \
  examples/5s/runtime-data/local-validation-runner.json
```

## 2. Encoder/telemetry 定位

不要假设对象固定为 49 项。先列出所有捕获：

```bash
jq -r '.encoder_input_log[] |
  [.meta.kind,.key_count,(.value.Cplz9 // ""),
   ([.keys[]|select(test("^[0-9]+$"))]|length)] | @tsv' \
  examples/5s/runtime-data/local-validation-runner.json
```

数字键存在时再展开：

```bash
jq '.encoder_input_log[] |
  select(([.keys[]|select(test("^[0-9]+$"))]|length)>0) |
  {meta,key_count,keys,value}' \
  examples/5s/runtime-data/local-validation-runner.json
```

匹配动态脚本时使用结构和脚本 SHA，不使用 `DP`、`CS`、`eSWHg` 等本轮混淆名。
推荐稳定锚点：

```text
setTimeout(callback, 100, state, telemetry)
Cplz9 + zcNj0 + gAMzq7 + NWUB3 + WpIu5
encoder 调用前的对象 key_count / numeric_count
```

## 3. Patch 策略

只在已经证明某个条件错误、且替换不会伪造动态结果时使用定向 patch：

1. 锁定当前脚本 SHA-256；
2. 选择唯一锚点；
3. 断言命中数恰好为 1；
4. 记录原锚点、替换内容、SHA 和运行结果；
5. patch 只改变控制路径，动态 token/body/对象仍由脚本生成；
6. 用真实后续请求和最终 gate 验证，不以“进入分支”作为成功。

案例 runtime 的 `--force-frame-branch` 已实现上述校验。若脚本 SHA 或命中数变化，
重新取证，不放宽为全局字符串替换。

## 4. Trace 策略

优先顺序：

1. 浏览器 Console/BiDi 对象探针；
2. 目标 request/field 窄 trace；
3. encoder builder/Worker message 定向 trace；
4. 最后才是有 90 秒和 2 GiB 熔断的 full trace。

每轮只回答一个问题，例如：

- 100ms callback 是否进入？
- 哪个 Promise fulfillment 后第一次写入数字键？
- Worker `postMessage` 到主线程是否完成 dispatch？
- 成功 Firefox 和本地第一次不同的对象 brand/字段是什么？

避免“一轮同时抓所有函数、所有对象深度、所有 opcode”。

Agent 启动的每轮 trace 必须在同一轮启动 watchdog：

```bash
python3 tools/trace-stop-on-target.py TRACE_DIR \
  --max-seconds 90 \
  --max-bytes 2147483648
```

停止后立即执行 `trace_finalize.py`、检查 `index/trace-health.json`、关闭对应 Nightly，
并删除 Agent 创建且不再需要的 trace/profile/helper/temp。`elapsed_seconds` 可能包含
finalize 时间；采集是否在 90 秒内停止以 receipt 的 `stop_elapsed_seconds` 为准。

## 5. 对比原则

可以固定或复用：

- 同 Firefox build/profile 下稳定的原型、brand、描述符和 API 合同；
- PDF plugin/mime type 这类设备级合同；
- 已验证稳定的 screen/navigator/profile 参数。

保持动态生成：

- ray、token、Cookie、UUID、随机数、时间；
- Worker URL、PAT URL、动态脚本名；
- request body、body SHA、混淆字段名；
- timing 数值、资源列表长度和 telemetry 数字键内容。

## 6. 最常见误判

| 误判 | 正确判断 |
|---|---|
| 第二个 `/fo/` body 长度接近成功样本 | 只说明部分 telemetry 进入 body |
| `/i/` 返回 204 | 只说明该阶段响应语义正确 |
| live runner 首页 200 | 可能被同一 Firefox context 的原生挑战污染 |
| 捕获到旧 49-key 对象 | 当前脚本可能是 46/48/100-key schema |
| patch 后进入 PAT 分支 | 仍需后续 `/fo/`、Cookie 和首页 gate |
| `cf-chl-peek` 已出现 | 它不是 `cf_clearance` Cookie |
| 没有 runtime exception | 服务端仍可能拒绝环境或行为数据 |

## 7. 临时文件和清理

Agent 创建的 trace/profile 使用可识别名称：

```text
/private/tmp/firefox-trace-5s-<purpose>-<timestamp>
/private/tmp/firefox-trace-profile-5s-<purpose>-<timestamp>
```

结束前：

1. 保存最小 JSON/脚本/对象证据到 `examples/5s/runtime-data/`；
2. 更新 `HANDOFF.md` 的当前结论；
3. 确认没有运行中的项目 Firefox；
4. 删除 Agent 自己创建的 trace/profile；
5. 不使用 `git clean` 或宽泛删除 `runtime-data`。

## 8. 成功定义

```text
stage_gate=passed
final_response_gate=passed
homepage_response_gate=passed
```

并且关闭所有 diagnostic/debug/source patch 后连续两轮通过，动态产物确实变化。
