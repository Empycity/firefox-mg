# 阿里云验证码 V2（51job 场景）全链路还原 — 验证报告

- 日期：2026-08-28 ~ 2026-09-02
- 样本站点：`https://we.51job.com/api/job/search-pc?api_key=51job`（阿里云 WAF + 阿里云验证码 V2 滑块）
- 方法：Firefox Trace 魔改浏览器采集（boundary + 值制品 + http_raw），本地 VM 重放，真实请求消融实验
- 所有结论均有真实服务器请求/响应支撑；制品索引见各节

## -1. 2026-09-02 下午：FeiLin005 轮换 + 004 逐字段对齐完成

- 约 12:35 线上轮换到 `feilin005.628a9a09…`（chunk[3]）。005 会话套用 004 模板
  （`FEILIN004_LEGACY_TEMPLATE=1 FEILIN004_LEGACY_SUB1=1`）Verify 返回 `F001`，
  证明 005 明文结构相对 004 有变化。已写好 `agent-next.json`（feilin005 采集配置）
  待用户加载采集 005 浏览器 T001 样本。
- 当日上午用 004 浏览器 T001 样本
  （`traces/firefox-trace-51job-feilin004-diff-20260902`，`evidence_complete=true`）
  完成首次**解密态逐字段 diff**，并落地三项修正：
  1. Log2 `f126`：本地模板尾部 `\n` 曾进入明文，原生为空串 → `build_log2_payload` rstrip。
  2. `f43` 值域：对齐 004 原生 `20-936|23-3104|30-1|40-130|41-9187|70-9241`
     （+DT 追加段 `71+662/80=71/81+157/93+2742/94+314`）。
  3. `GatherCost`：原生 7581，代理值 3500–4800 → 6500–8500。
- 修正后离线重放与浏览器明文 127 字段 diff 只剩设计内随机项（f43 随机值、
  f52 末 5 位、f21、token 对）。
- 结构性确认：`f21` 为 8 字节环境计数标记（随机可行，00:00 swapfull T001 支持）；
  Log2/Verify 签名公式（sorted params + 组 secret）与浏览器逐字节一致；
  参数顺序/头序/无 Cookie 与浏览器 final channel 一致。
- 时间线（基准=seg1 ts）：Init 前 293ms 发出 → UploadLog +988ms → Log2 +11699ms →
  Log3 +15393ms → Verify +17102ms。
- 004 修正未能在真实 004 会话完成线上验证即被 005 轮换打断；004 修正保留，
  待 005 适配后回归。

## 0. 2026-09-02 当日上午进度（FeiLin004）

本节覆盖旧记录中“纯本地已闭环”的表述，按最新 FeiLin004 样本为准。自动化浏览器
本轮真实滑动已返回 **`VerifyCode=T001` / `VerifyResult=true`**，trace 目录为：
`traces/firefox-trace-51job-feilin004-diff-20260902`。该轮 `trace-health.evidence_complete=true`、
`degraded_count=0`，Init、UploadLog、Log2、Log3、Verify 请求体和 FeiLin004 脚本均完整落盘。

当前纯本地 `dynamic_client/verify_run.py` 在同一 FeiLin004 周期仍返回 `F001`；因此不能把旧版
“纯本地 T001”结论继续当作 004 的验收结果。现阶段主假设是**前置请求/设备采集字段的固定性
或动态性与浏览器不一致**，不是 IP、TLS、HTTP/2 或 trace 停止问题。

### 已从 T001 浏览器样本确认的 004 字段

- DeviceConfig：`chunk[3]=feilin004...`，`chunk[8]` 是本轮 payload `f42` 的 IP 来源。
- payload 为 127 字段；`f68=0`、`f77=certifyId`，`f88` 使用当前位图。
- `f21` 是 8 字节 Base64 标记，DeviceToken 与 Log2 共用，但每轮刷新。
- `f71/f73` 是两个 40 字符 token；两处共用 token 字节，`f72/f74` 是各自产生时间戳。
- `f43` 是完整 11 段链（20/23/30/40/41/70/71/80/81/93/94），不能套旧的 8 段模板。
- DeviceToken 与 Log2 的 `f74` 不同：本轮约为 `seg1` 后 15.1 秒与 11.5 秒。
- DeviceToken 外层 `GatherCost` 与 Log2 外层成本相同；本轮实测为 `7581`。
- Log2 `f52` 保留 50 位固定骨架，只变化末 5 位；不能 50 位全随机。

### 已落地修正与待验证项

已将 Log2 004 的 `f52` 生成改为“固定骨架 + 末 5 位随机”，并保留双 `f74`、完整 `f43`、
动态 `f21`/token/IP/位图。下一轮应继续逐项比较 UploadLog、Log2、Log3、DeviceToken 和
Verify 的明文，而不是继续调整 sleep；时间只作为 payload 状态字段，默认提交不等待。

### 004 固定/动态字段清单

当前排查只接受单变量证据。`chunk[0]`/`[2]`/`[3]`/`[8]`、session key、seg1、FeiLin 路径和
服务端 IP 必须每轮从 Init 读取；`f21`、`f71/f73`、`f72/f74`、`f43`、位图和 `si` 属于
当轮运行态；`f52` 仅末 5 位随机，前 45 位保持 004 浏览器骨架；AES/HMAC/盐/R1 key 属于
已回归的固定算法常量。DeviceToken 与 Log2 共享 token 字节、`f21` 和 GatherCost，但两者
的 `f74` 独立。旧版 111 字段、8 段 `f43` 或全随机 `f52` 均不可直接套用。

下一轮顺序固定为：Init 请求/响应 → UploadLog `js/rt` → Log2/Log3 `seq/cost`、明文字段
顺序与时间链 → DeviceToken/Verify。每次只替换一个字段，保留浏览器 T001 请求体、本地请求体、
首个差异位置和最终业务码；`HTTP 200` 或 Log2/Log3 单独成功不算 Verify 通过。

## 1. 请求链与还原状态（协议层已还原，004 Verify 尚未闭环）

```
GET search-pc                    挑战页（renderData: sceneId/userId/userUserId/traceid）
POST InitCaptchaV2               Signature + DeviceData            → DeviceConfig/StaticPath
POST UploadLog                   log 明文 JSON（时序日志）           → Code:Success
POST Log2/Log3 (device)          AES 嵌套指纹包                     → ResultObject:true
[用户滑动]
POST VerifyCaptchaV2             deviceToken + data                → T001 / F001 / F008
```

| 参数/环节 | 算法 | 状态 |
|---|---|---|
| Signature | b64(HMAC-SHA1("POST&%2F&"+pct(排序query), KEY_SECRET+"&"))，双组密钥 | ✅ reproduced |
| DeviceData | AES(45f8ac1e1de14397, appKey#W#b64(AES(c175a358550d02e2, 场景串))#W20220202#CLOUD#) | ✅ byte-exact |
| DeviceConfig | 解密 87f879f135f27da7；chunk[0]=session_key、[2]=seg1、[3]=feilin版本路径、[8]=服务端记录IP、[9]='0' | ✅ 全字段 |
| deviceToken | b64(WEB#seg1#cipher#GatherCost#md5)，盐 `daye,raolewoba!` | ✅ byte-exact |
| payload | 127 字段，模板 + 6 动态字段（f21/f43/f71/f72/f73/f74/f77/f87） | ✅ |
| Log2/Log3 | 外层 key a549a55c60a39aa0，内层全 session_key；Log3 再嵌 `511#entry-504#entry` | ✅ byte-exact 回归 |
| 滑块 data | b64(zlib(R2前缀+TrackList)) → sg JSVMP 重放（key 恒定 `3e627e1b4c63f913`） | ✅ byte-exact |
| arg | 同 VM：D(0,[],R1,F1,{r:1},[certifyId, 16hex随机]) | ✅ byte-exact |
| UploadLog | 明文 JSON log（sId/pfx/mInit/hst/cId/ip/js/rt） | ✅ 服务器接受 |

## 2. 消融实验矩阵（根因判定）

| # | Init | deviceToken | data | verify 传输 | 结果 |
|---|---|---|---|---|---|
| 1 | 浏览器 | 浏览器 | 浏览器 | curl_cffi（drop 重放） | **T001** |
| 2 | 浏览器 | 浏览器 | 我方 | curl_cffi（swapdata） | **T001** |
| 3 | 浏览器 | 我方（**随机 token**） | 我方 | curl_cffi（swapfull r12） | **T001** |
| 4 | 浏览器 | 我方 | 我方 | curl_cffi（swapfull，Init 后 4min+，混合 IP） | **T001** |
| 5 | curl_cffi | 我方 | 我方 | curl_cffi | F001 |
| 6 | curl_cffi | 我方 | 我方 | 浏览器 | F001 |
| 7 | requests-go | 我方 | 我方 | requests-go 全链 | F001 |
| 8 | requests-go | 我方 | 我方 | +Idempotency-Key 头 | F001 |

### 结论

1. **内容层 100% 还原**：#2/#3/#4 证明我方 deviceToken、data（轨迹/VM 加密）、UploadLog、
   Log2/Log3 全部被服务器当作合法输入。
2. **token 随机生成即可**（#3）：服务端不校验 f71/f73 推导；浏览器内恒定只是 feilin
   "生成一次复用"的实现细节。客户端每会话随机生成两个 40 字符 [0-9a-zA-Z] 串。
3. **历史判断：F001 的主要嫌疑是 Init 请求的 TLS/HTTP2 二进制指纹**：
   - 请求明文层（参数/头/头序/Idempotency-Key）完全对齐仍 F001；
   - curl_cffi（BoringSSL）与 requests-go（bogdanfinn Go）两个异源指纹库均被识别；
   - Init 响应无任何降级（字段与浏览器一致）——标记是隐式的；
   - **与 IP 无关**：同 IP 浏览器 Init 过、脚本 Init 不过（#1/#3 vs #5/#7/#8）；
   - **与 IP 一致性无关**：#4 的 Init 与 verify 出口 IP 不同仍 T001。
4. **服务端不绑定** Init 与 verify 的传输/IP/会话时效（#4：4 分钟 + span 256s 仍 T001）。
5. F008 = 同 body 重放检测；F001 后 WAF 自动重载页面产生新会话。

## 3. 落地形态

### 3.0 纯本地运行边界

最终验收命令为 `dynamic_client/verify_run.py`。该命令不读取 `examples/aliv2/traces`
及其中的 JSONL/values 制品，也不依赖 Firefox、bridge 或 trace 进程。算法计算使用
源码模板、实时 Init 返回的 `DeviceConfig/StaticPath`、本地 AES/HMAC/轨迹代码，以及
按 `StaticPath` 下载并缓存的 `sg_vm_*.js` JSVMP 算法制品。Trace 目录只属于逆向取证、
固定向量回归和问题定位阶段，不属于正式运行时输入。

**混合模式（已验证，当前主力）**：
真浏览器/CDP 只完成「挑战页 GET + InitCaptchaV2」→ 取 certifyId/DeviceConfig/StaticPath →
客户端完成其余全部（UploadLog/Log2/Log3/deviceToken/data/Verify）→ T001。
实现：`dynamic_client/swapfull_replay.py`（steal 捕获体 + trace Init → 重放）。

**纯客户端**：协议和加密链路已还原，但 FeiLin004 当前仍未闭环。NSS/HTTP2 本地实现可完成
挑战页、Init、UploadLog、Log2、Log3 和 Verify 请求，当前验收结果仍为 `F001`。Firefox
仅作为成功 T001 的 oracle 和回归工具保留。

## 4. 每日约 06:00/18:00 轮换

这里的“18:00 变化”指服务端周期轮换窗口，实际切换时间可能有分钟级偏差，不能写死为
本地定时器。客户端必须以当次 `InitCaptchaV2` 返回的 `DeviceConfig.chunk[3]`
（FeiLin 路径）和 `chunk[0]`（session key）为准；发现版本变化时重新提取/缓存当前
`StaticPath` 对应的 sg 制品。稳定算法常量不因 18:00 轮换而改变，变化的是脚本版本、
会话材料及部分字段模板/运行时参数。

| 轮换项 | 说明 | 客户端对策 |
|---|---|---|
| FeiLin 脚本版本 | 约 18:00（以及约 06:00）可能切换，路径由 DeviceConfig chunk[3] 动态下发 | 不写死版本/hash；每次按 chunk[3] 识别 |
| token 对 | 每周期换（已证实随机生成可行） | 随机生成，无需跟进 |
| session_key 周期 | chunk[0] 动态下发 | 本来就动态 |
| payload 模板/字段 | 轮换窗口可能新增字段、改变位图或标记；8/30 观察到 111→127 | 先按字段数和固定骨架校验；未知形态不得套旧模板 |
| si 第 8 位 | 每会话动态（rAF 指标） | 用当期浏览器实测值 |

跨轮换稳定（实测）：全部 AES 密钥、固定 IV、HMAC-SHA1、KEY_ID/SECRET、盐、R1 key 常量、
JSVMP 算法（sg 版本每会话随机但算法 byte-exact 稳定，`extract_sg_vm.py` 自动提取）、
TrackList/payload 结构。

## 5. 验证方法学（供复现）

1. Firefox Trace 采集（`agent-next.json`：full-chain + boundary + `script_contains=captcha-frontend`
   + object_depth 2-4 + XHR/fetch body 全量 + 值存储；DOM all/depth4 会卡死，轻量优先）。
2. 值制品（values/）直接命中密文明文对；`xhr_req_body_*` 即完整请求体。
3. 字节级回归：捕获明文重加密 == 捕获密文（openssl AES-128-CBC 手动复现）。
4. 消融实验：console.js（drop/swapdata/swapfull/steal）+ bridge_server.py + swapfull_replay.py。
5. 每轮独立目录，finalize 后 trace-health 检查 degraded/value_capture。

## 6. 制品与工具

见 `README.md` 第二节 D 表；关键模板在 `dynamic_client/device_upload/`；
VM 重放 `dynamic_client/sg_vm_*.js` + `sg_vm_replay/`；feilin 沙箱 `ast_feilin/`。
