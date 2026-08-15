# 抖音连续发布链路排查交接（已按本轮实测更新）

更新时间：2026-08-12（Asia/Shanghai）

## 1. 当前结论

本轮问题已经定位并验证：之前“本地第三次必 403 / Cookie 直接失效”的判断不准确。
真正差异在本地安全运行态的**更新时机**：

1. 浏览器不是每个创作者接口都刷新三枚 `__security_mc_*` Cookie；
2. 浏览器是在一次发布任务开始时刷新三枚 marker，并在该任务内部从
   `upload/auth/v5` 到最终 `create_v2` 保持同一组 marker；
3. 浏览器三次成功 `create_v2` 中，`bd-ticket-guard-client-data`、CSRF、
   `x-tt-session-dtrait`、REE public key 和 query `msToken` 都保持固定；
4. `create_v2` 响应头里的 `x-ms-token` 会变化，但浏览器没有把它写回下一次
   `create_v2` 的 query `msToken`；
5. 上游上传链路响应没有发现需要喂给后续 `create_v2` 的 Cookie 或安全态。

代码已按上述行为修改，并已完成本地连续 5 视频验证：五次均
`HTTP 200 + status_code=0 + item_id`，没有第三次 403 或第五次异常。验证日志：
`log/run-agent-verify-5videos.log`。

## 2. 本轮浏览器证据

浏览器页面：

```text
https://creator.douyin.com/creator-micro/content/upload
```

使用 js-reverse MCP 在真实浏览器会话里连续触发三次发布，并导出三条成功的
`create_v2`：

```text
log/browser-success-699-all.json    HTTP 200
log/browser-success-1014-all.json   HTTP 200
log/browser-success-1549-all.json   HTTP 200
```

三次成功请求的脱敏特征：

| 字段 | 三次行为 | 长度 | SHA256 前 16 位 |
|---|---|---:|---|
| query `msToken` | 完全相同 | 184 | `753b724c0637646e` |
| `bd-ticket-guard-client-data` | 完全相同 | 356 | `838ac13e54df74ba` |
| `x-secsdk-csrf-token` | 完全相同 | 92 | `f182d58dae93cdae` |
| `x-tt-session-dtrait` | 完全相同 | 840 | `8ca6f99cbe391faf` |
| REE public key | 完全相同 | 88 | `db52ff502984ff55` |
| `a_bogus` | 每次不同 | 动态 | 不比较值 |
| body | 每个视频不同 | 动态 | 不比较值 |
| 响应 `x-ms-token` | 每次可能不同 | 动态 | 只观测，不写回 |

同一发布任务内部的 marker 对比：

```text
任务 1：log/browser-chain-416-upload-auth.json  与 log/browser-success-699-all.json  三枚 marker 一致
任务 2：log/browser-chain-811-upload-auth.json  与 log/browser-success-1014-all.json 三枚 marker 一致
任务 3：log/browser-chain-1224-upload-auth.json 与 log/browser-success-1549-all.json 三枚 marker 一致
```

结论：三枚 `__security_mc_1_s_sdk_*` marker 的粒度是**发布任务级**，不是
`create_v2` 单接口级，也不是每一次 `signed_creator_url()` 调用级。

## 3. 上游链路响应结论

按“从上传开始读整条链路”的要求，本轮查看了 `create_v2` 前面的关键请求：

1. `/web/api/media/upload/auth/v5/`
   - 返回媒体临时凭证；
   - 没有发现需要写入后续 `create_v2` 的 `Set-Cookie`；
   - 同一任务内它和最终 `create_v2` 使用同一组三枚 `__security_mc_*` marker。
2. VOD `ApplyUploadInner`
   - 不走创作者 Cookie 安全态；
   - 主要返回 `Vid`、`StoreUri`、`UploadID`、`Auth`、`UploadHost`、`SessionKey`；
   - 这些只进入上传/Commit 或最终 body，不更新浏览器安全运行态。
3. 视频二进制上传
   - 使用 Apply 返回的 `Auth/StoreUri/UploadHost` 和本地 CRC32；
   - 不产生后续 `create_v2` 需要合并的浏览器安全态。
4. VOD `CommitUploadInner`
   - 使用同一次 Apply 的 `SessionKey`；
   - 返回视频元数据和 `Vid`；
   - 不产生后续安全头状态。
5. `video/enable`、`video/transend`、封面上传/校验
   - 只确认视频处理完成和封面 `StoreUri`；
   - 没有发现“必须把响应头写入最终发布”的链路状态。

因此，本地第三次 403 不是因为少读了前序响应中的某个 `token`，而是本地对
marker 与 Ticket Guard client data 的生命周期模拟错了。

## 4. 已修改的代码行为

### 4.1 `bd-ticket-guard-client-data` 固定复用浏览器导出值

文件：`creator_publish.py`

`LocalSecurityRuntime.headers()` 现在优先读取 `security-runtime.json` 中的：

```text
bd_ticket_guard_client_data_header
```

有该字段时逐字节复用浏览器成功请求里的 header。缺少该字段时才使用旧的本地
HMAC 生成逻辑作为兼容回退。

文件：`更新运行态.py`

从人工 Copy as cURL 或结构化请求快照重建运行态时，会把请求头
`bd-ticket-guard-client-data` 保存进 `security-runtime.json`。当前换账号最终流程以
人工 Copy as cURL 为准。

### 4.2 三枚 `__security_mc_*` 改为发布任务级轮换

三枚 marker：

```text
__security_mc_1_s_sdk_cert_key
__security_mc_1_s_sdk_crypt_sdk
__security_mc_1_s_sdk_sign_data_key_web_protect
```

当前规则：

```text
批量视频：每个视频任务开始前 rotate 一次；任务内 upload-auth -> create_v2 保持不变。
单视频：任务开始前 rotate 一次。
图片发布：任务开始前 rotate 一次。
signed_creator_url()：不再 rotate。
```

这和浏览器样本一致：每个发布任务一组三枚 marker，同一任务内部不变，下一任务
换一组。

### 4.3 `x-ms-token` 只记录，不写回

`HttpClient.request()` 仍会打印响应 `x-ms-token` 的长度和哈希，便于排查，但不会
把它覆盖进 Session Cookie。浏览器三次成功请求已经证明下一次 query `msToken`
仍是原值。

保留 `Set-Cookie` 的正常合并逻辑：如果服务端通过标准 Cookie 机制更新 Cookie，
`curl_cffi` Session 会接收；只是 `x-ms-token` 这个响应头不参与覆盖。

### 4.4 发布 body 使用浏览器实测 immediate 值

本轮浏览器成功 body 使用：

```text
visibility_type = 1
下载 download = 1
timing = 0
media_type = 4
```

因此文档、脚本和默认参数均按 `timing=0` 记录为当前稳定立即发布值。

## 5. 本地验证

### 5.1 连续 5 视频最终验证

运行命令：

```bash
PYTHONUNBUFFERED=1 /opt/miniconda3/envs/pythonProject/bin/python creator_publish.py \
  --video-batch test-videos/test-video-1.mp4 test-videos/test-video-2.mp4 test-videos/test-video-3.mp4 test-videos/test-video-4.mp4 test-videos/test-video-5.mp4 \
  --cookie-file cookie.txt \
  --text "连续发布稳定性演示" \
  --visibility-type 1 \
  --download 1 \
  --timing 0 \
  --impersonate chrome136 \
  --retries 2 2>&1 | tee log/run-agent-verify-5videos.log
```

结果：

```text
5 个任务均进入 create_v2
5 个任务均返回 status_code=0
5 个任务均返回 item_id
未出现第三次 403，也未出现第五次异常
```

日志中关键不变量：

```text
dtrait_sha256       = 8ca6f99cbe391faf
csrf_sha256         = f182d58dae93cdae
client_data_sha256  = 838ac13e54df74ba
```

三枚 `__security_mc_*` 在每个任务开始时变化；同一任务内部保持不变。连续五次日志中五组 marker 均不同，client data / CSRF / dtrait 哈希保持固定。

## 6. 当前运行入口

推荐直接运行：

```bash
./连续发布5次视频.sh
```

或显式命令：

```bash
PYTHONUNBUFFERED=1 /opt/miniconda3/envs/pythonProject/bin/python creator_publish.py \
  --video-batch test-videos/test-video-1.mp4 test-videos/test-video-2.mp4 test-videos/test-video-3.mp4 test-videos/test-video-4.mp4 test-videos/test-video-5.mp4 \
  --cookie-file cookie.txt \
  --text "连续发布稳定性演示" \
  --visibility-type 1 \
  --download 1 \
  --timing 0 \
  --impersonate chrome136 \
  --retries 2
```

成功标准：每个任务 `HTTP 200`、业务 `status_code=0`，且返回 `item_id`。

## 7. 403 处理约定

虽然本轮第三次 403 已经解决，但 `create_v2` 仍不做自动重试。原因是发布请求的
网络结果不明确时，重复提交可能产生重复作品。

如果后续再次出现 `create_v2 HTTP 403`：

1. 立即停止当前批次；
2. 不重试同一个 `create_v2`；
3. 先检查作品列表，确认是否已经创建作品；
4. 用同一浏览器、同一时刻的一条成功 `create_v2` 和完整 Storage 重建：

```bash
/opt/miniconda3/envs/pythonProject/bin/python 更新运行态.py \
  --curl create-v2.curl \
  --storage browser-storage-current.json \
  --dir .
```

5. 核对脱敏哈希：`sessionid/sid_guard/uid_tt/ttwid`、三枚 `__security_mc_*`、
   query `msToken`、`bd-ticket-guard-client-data`、CSRF、dtrait、REE public key；
6. 再运行单视频或三视频验证，最后运行五视频脚本。
