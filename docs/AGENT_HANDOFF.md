# Firefox Trace Agent Handoff

更新时间：2026-07-26

## 当前结论

第一阶段核心能力已完成并通过真实站验证。JD `h5st` 和 PDD `anti_content` 都能形成：

1. 首轮轻量 discover 定位目标字段、请求、脚本和调用边界；
2. 从请求 sink / value_store 反推候选脚本或函数；
3. 二轮 target-values 深抓 args/return/object；
4. JS value_store 与请求侧 query/body artifact 用 sha256 对齐。

下一位 agent 可以把第一阶段视为“可交付试用版”，后续重点是补边界、优化体验和进入第二阶段深 trace。

## 用户硬约束

- 最终交付物是魔改 Firefox 浏览器、日志 schema、启动参数和详细使用说明。
- 不要把 JD/PDD/h5st/anti_content 写死进浏览器核心、默认 schema 或默认流程；它们只是验证样本。
- 不要依赖站点专用 Python 分析脚本作为交付路径。开发期 smoke 可以有，但最终应让 AI/用户按使用说明操作。
- 每做完一块内核能力，必须编译，并用本地或真实页面 smoke 验证。
- 如需安装新依赖，暂停，让用户自己安装。
- 所有影响覆盖范围、日志量和页面时序的策略都要可配置；limit/sample 只能当保险丝，不能当主策略。
- 如果出现 `trace.degraded`，该轮日志只能作为候选参考，不能证明链路不存在。
- 用户明确要求过：不要做一半忘记目标；文档要持续同步。
- 不能做“永远返回正常值”的反自动化/风控绕过改动。可做的是：
  - 检查 trace 浏览器是否比 stock Firefox 多暴露异常；
  - 做 stock vs trace fingerprint 差异报告；
  - 修复我们自己 trace 引入的异常；
  - 本地/自有测试页可做受限 override 验证，但不要用于真实站绕过。

## 工作目录和运行路径

项目根目录：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace
```

Gecko 源码：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
```

正确 Firefox 运行路径：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev/obj-aarch64-apple-darwin25.5.0/dist/Nightly.app/Contents/MacOS/firefox
```

不要运行：

```bash
/Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev/obj-aarch64-apple-darwin25.5.0/dist/bin/firefox
```

该路径之前报过：

```text
Couldn't load XPCOM.
```

## 构建命令

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

最近一次构建结果：通过。

## 当前主要能力

### JS trace

- JS call enter/return。
- `TRACE_JS_MODE=boundary|target|deep`。
- `TRACE_SCRIPT_CONTAINS` / `TRACE_FUNCTION_CONTAINS` / `TRACE_SCRIPT_SHA256`。
- `TRACE_TARGET_MATCH=all|any|auto`。
- object/array/typed array preview。
- 长字符串 value_store。
- `values/<value_id>.txt` 保存完整值。
- `origin_call_id` / `parent_call_id` 辅助链路回溯。
- boundary ring buffer：首轮 discover 保调用边界，sink 触发 flush。

### DOM / Cookie / Storage

- DOM get/call signal 模式。
- document.cookie / CookieStore API trace。
- HTTP Set-Cookie。
- CookieStorage lifecycle。
- localStorage/sessionStorage lifecycle。

### XHR / Fetch

- XHR open/send/body/response。
- XHR URL `query_fields` 和 value_store。
- XHR request body bounded preview/store/sha256。
- XHR body 字段抽取：
  - JSON body；
  - form-urlencoded body；
  - 字段名复用 `TRACE_QUERY_FIELDS`。
- Fetch call/request/response/done。
- Fetch request body clone preview/store。
- Fetch response headers。
- Fetch response body clone preview 和 `body_chunk` preview 已有基础能力。

### script.resource

- 外部脚本资源事件 `script.resource`。
- 记录脚本 URL、final URL、content-type、charset、source map header、headers、decoded length。
- 可选 raw capture/store。
- 默认 `TRACE_SCRIPT_RESOURCE_FILTER=web`，避免扩展/chrome 噪声。

## 本轮新增能力

新增 XHR request body 通用 trace：

```bash
TRACE_XHR_REQUEST_BODY=none|preview|full
TRACE_XHR_REQUEST_BODY_MAX_BYTES=65536
TRACE_XHR_REQUEST_BODY_HEX_BYTES=64
TRACE_XHR_REQUEST_BODY_STORE=0|1
```

`xhr.body` 新字段：

- `request_body_mode`
- `request_body_size`
- `request_body_captured_size`
- `request_body_truncated`
- `request_body_sha256`
- `request_body_preview`
- `request_body_bytes_hex`
- `request_body_value_id`
- `request_body_store_path`
- `request_body_stored`
- `body_fields`
- `body_fields_meta`

实现文件：

- `gecko-dev/dom/xhr/XMLHttpRequestMainThread.cpp`
- `gecko-dev/dom/ipc/ContentParent.cpp`
- `tools/run-trace-firefox.sh`

文档：

- `README.md`
- `docs/TRACE_PROGRESS.md`

本地 smoke 页面：

- `tests/xhr-request-body.html`

## 验证证据

### XHR request body smoke

目录：

```bash
/private/tmp/firefox-trace-xhr-request-body-smoke-1785065876
```

结果：

- `xhr.body` 捕获：

```json
{"anti_content":"trace-xhr-request-body-token","nested":{"n":11}}
```

- body sha256：

```text
032277ddb395b4d2805d519fc6fe16ad52730540dd088108c692682f3dec9f05
```

- body artifact：

```bash
values/xhr_req_body_66874_1.txt
```

- 字段 artifact：

```bash
values/qfv_xhr_66874_1.txt
```

- response status 200，说明 trace 没有消费/破坏请求体。

### JD h5st

目录：

```bash
/private/tmp/firefox-trace-jd-firstphase-target-1785065263
```

关键结果：

- 无 `trace.degraded`。
- `h5st` 请求侧命中 34 个 value_store，15 个唯一 sha256。
- 生成/返回侧命中：
  - `_$PI.prototype.signSync`
  - `_$PI.prototype._$sdnmd`
  - `_$Yx.prototype.signSync`
  - `_$Yx.prototype._$sdnmd`
- 至少一组 JS return 与 XHR `h5st` 请求字段 sha256 完全一致：
  - `values/jsv_50839_9.txt`
  - `values/jsv_50839_10.txt`
  - `values/qfv_xhr_50839_2.txt`

结论：JD 能看到生成/返回侧和请求侧，并能做 value 对齐。

### PDD anti_content

discover 目录：

```bash
/private/tmp/firefox-trace-pdd-firstphase-search-1785065942
```

target 目录：

```bash
/private/tmp/firefox-trace-pdd-firstphase-target-search-1785066090
```

测试页：

```text
https://mobile.yangkeduo.com/search_result.html?search_key=%E6%89%8B%E6%9C%BA
```

discover 结果：

- 无 `trace.degraded`。
- `xhr_9`：
  - `POST https://mobile.yangkeduo.com/proxy/api/search?pdduid=0`
  - response status 403，但参数已经生成并发送。
  - `xhr.body` 捕获完整 JSON request body，包含 `anti_content`。
  - body artifact：`values/xhr_req_body_67790_5.txt`
  - 字段 artifact：`values/qfv_xhr_67790_2.txt`

target 结果：

- 对 `search_result` 脚本做 target-values。
- JS 入参 `req_params` 包含完整 `anti_content`。
- 命中函数：
  - `881/t.Ay`
  - `12401/_</<`
  - `12401/x</<`
  - `e`
- 多条 JS value artifact 和 XHR body artifact 内容一致。
- 关键 sha256：

```text
064d819c51dc7bf4c296074d0be4e1f1ce803a1d2ca1042daefc57c73fb37a4e
```

对应：

```bash
values/jsv_70420_1.txt
values/jsv_70420_2.txt
...
values/jsv_70420_10.txt
values/xhr_req_body_70420_5.txt
```

结论：PDD 这轮看到的是组包/发送链路，不是算法内部每一步。已能从请求侧反推到 JS 业务脚本传递点，并用 sha256 证明 JS 入参与最终 XHR body 是同一份参数。

## 推荐工作流

### 首轮 discover

目标：不要预先猜函数名，先保留请求、脚本身份、调用边界和长字符串。

示例：

```bash
TRACE_HEADLESS=1 \
TRACE_DIR=/private/tmp/firefox-trace-discover-$(date +%s) \
TRACE_RUN_LABEL=discover \
TRACE_QUERY_FIELDS=anti_content,h5st,sign,token \
TRACE_QUERY_FIELD_VALUE_STORE=1 \
TRACE_SCRIPT_RESOURCE=1 \
TRACE_SCRIPT_RESOURCE_FILTER=web \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_PREVIEW=body \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
./tools/run-trace-firefox.sh --trace-preset discover-light '<url>'
```

### 二轮 target

目标：根据首轮 sink / script.resource / origin_call_id 反推脚本或函数，再深抓 args/return/object/value_store。

示例：

```bash
TRACE_HEADLESS=1 \
TRACE_DIR=/private/tmp/firefox-trace-target-$(date +%s) \
TRACE_RUN_LABEL=target \
TRACE_QUERY_FIELDS=anti_content,h5st,sign,token \
TRACE_QUERY_FIELD_VALUE_STORE=1 \
TRACE_SCRIPT_RESOURCE=1 \
TRACE_SCRIPT_RESOURCE_FILTER=web \
TRACE_SCRIPT_CONTAINS='<candidate-script-substring>' \
TRACE_FUNCTION_CONTAINS='<candidate-function-substring>' \
TRACE_JS_OBJECT_VALUE_KEYS=anti_content,req_params,h5st,sign,body,data \
TRACE_JS_ARGS=preview \
TRACE_JS_RET=preview \
TRACE_JS_OBJECT_DEPTH=2 \
TRACE_JS_OBJECT_KEYS=64 \
TRACE_JS_VALUE_STORE=1 \
TRACE_XHR_EVENTS=open,send,body,response \
TRACE_XHR_PREVIEW=body \
TRACE_XHR_REQUEST_BODY=preview \
TRACE_XHR_REQUEST_BODY_STORE=1 \
./tools/run-trace-firefox.sh --trace-preset target-values '<url>'
```

## 下一步优先级

### P0：收尾交付文档

把 README 从“开发记录 + 配置表”整理成用户可执行说明：

1. 快速启动；
2. trace preset 怎么选；
3. discover → target 的操作步骤；
4. 每类日志文件怎么看；
5. value_store / sha256 如何对齐；
6. `trace.degraded` 如何处理；
7. 常见卡死/日志爆炸的降载策略。

### P1：ring buffer 体验

继续优化：

- 按目标字段/sink 配置窗口大小；
- flush summary；
- buffer overwrite 后给出自动重跑建议；
- degraded 明确写入当前配置和建议缩窄维度。

### P1：source map / script artifact

继续补：

- source map 文件自动下载/落盘；
- script hash 与 source map 关系；
- script.resource raw capture 在大脚本下的截断策略和重跑建议。

### P2：Worker / keepalive / response body artifact

第一阶段剩余边界：

- Worker fetch；
- keepalive/PFetch；
- 完整 response body artifact；
- WebSocket frame；
- HTTP packet 级别 trace。

### P2：fingerprint 自检

用户问过“浏览器里检测自动化的底层都改成正常值”。不要做真实站反检测绕过。

可做安全替代：

- stock Firefox vs trace Firefox fingerprint surface 差异报告；
- 检查 trace 改动是否额外暴露异常；
- 修掉我们自己引入的异常；
- 本地测试页限定 override。

### P3：第二阶段 deep / opcode / jsvmp

只有在组包/传递链路不足以还原算法时进入：

- opcode window；
- stack slots / operands；
- VM dispatcher autodetect；
- jsvmp/vm_step；
- WASM dump/insn trace。

必须先按脚本、函数、时间窗口或 PC 范围收窄。

## 当前已知边界

- PDD 目前看到的是 `anti_content` 的业务组包/发送链路，不是算法内部每一步。
- PDD 搜索请求返回 403，但验证目标是 trace 能否看到参数生成和发送，不是绕过服务端风控。
- Worker fetch、keepalive/PFetch、完整 response body artifact 仍未闭合。
- UI/配置面板未做，当前主要靠环境变量。
- 真实站长时间运行仍可能日志很大；必须坚持 discover → target 多轮策略。

## 接手检查命令

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
git -C gecko-dev status --short
```

确认构建：

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace/gecko-dev
source ~/.cargo/env
MOZBUILD_STATE_PATH=/Users/empycity/Desktop/JS-tools/firefoxTrace/.mozbuild \
MACH_TELEMETRY_DISABLED=1 \
PATH=/opt/homebrew/opt/lld/bin:$PATH \
python3.11 ./mach build
```

最近验证目录降级检查：

```bash
python3 - <<'PY'
import json, glob
for root in [
  '/private/tmp/firefox-trace-jd-firstphase-target-1785065263',
  '/private/tmp/firefox-trace-pdd-firstphase-search-1785065942',
  '/private/tmp/firefox-trace-pdd-firstphase-target-search-1785066090',
]:
    deg = 0
    for p in glob.glob(root + '/*.jsonl'):
        for line in open(p, errors='replace'):
            if 'trace.degraded' in line:
                deg += 1
    print(root, 'trace.degraded=', deg)
PY
```

当前结果均为 0。
