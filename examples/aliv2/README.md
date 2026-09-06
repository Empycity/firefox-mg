# 51job 阿里云验证码 V2 全链路还原 — 状态总览（2026-09-02）

> 目标：`https://we.51job.com/api/job/search-pc?api_key=51job`（阿里云 WAF + 阿里云验证码 V2 滑块）。
> 本文自上而下：最终状态 → token 问题 → 每日轮换 → 实验矩阵 → 时间线明细（证据归档）。

## 当前正式主路径

纯 Node：`dynamic_client/verify_run.py` 在 Init 后调用真实 FeiLin 补环境，动态生成
127 段设备 payload，再生成 DeviceToken、Log2、Log3 和 sg data，最后直接请求
VerifyCaptchaV2。当前已连续实测返回 `T001/true`，不启动 Firefox、不依赖浏览器桥接；
FeiLin/sg 版本和运行态参数均按当轮响应取得。旧模板和浏览器实验代码已清理。

FeiLin 自动更新链：`InitCaptchaV2.DeviceConfig` 解出 `chunk[3]` 版本路径，运行时从末尾
64 位 hash 校验本地 `feilin.js`；不匹配时优先检查 `feilin_runtime/cache/<sha256>.js`，
仍没有则从当期 CDN 下载、校验并缓存，然后通过同一套 Node 补环境执行。版本轮换不会
回退到旧 FeiLin 算法，也不会把固定 payload 带入生产请求。

## 最新进度：FeiLin005 已上线（2026-09-02 下午）

2026-09-02 约 12:35 起，线上从 `feilin004.6fbec6bb…` 轮换到
`feilin005.628a9a09a0011d1300ab611a16deb95f6a4d2ae7a56efa821e489627474b41bf`
（DeviceConfig chunk[3]，`feilin_version.py` 已登记）。004 修正尚未在真实 004 会话上
验证就被轮换打断；**005 会话强制复用 004 模板/子字段算法（`FEILIN004_LEGACY_*`）仍为
F001**，说明 005 的明文结构相对 004 有变化（不是 004 修正无效的证据）。

当日上午完成的 004 逐字段对齐（对照 `traces/firefox-trace-51job-feilin004-diff-20260902`
浏览器 T001 样本解密）已落地并保留：

- **Log2 `f126` 尾部换行已修**：本地模板文件末尾 `\n` 曾被当作第 127 个字段写入明文；
  浏览器原生 `f126` 为空串。`build_log2_payload` 现已 rstrip。
- **Log2/DeviceToken `f43` 值域已对齐 004 原生样本**：
  `20-936|23-3104|30-1|40-130|41-9187|70-9241`（Log2 六段），DT 追加
  `71-9903|80-9903|81-10060|93-12802|94-13116`。修正前本地生成
  `30-0`、`40≈53`、`41≈6300`、`71-70 间隔 3300-4100`，与原生
  （`30-1`、`40=130`、`41=9187`、`71-70 +662`、`80=71`、`81-80 +157`、
  `93-81 +2742`、`94-93 +314`）不符。修正后离线重放与浏览器 T001 明文的
  127 字段 diff 只剩设计内随机项（f43 随机值、f52 末 5 位、f21、token 对）。
- **GatherCost 值域放宽**：原生 004 实测 7581，旧 003 代理值 3500–4800 偏低，
  现为 6500–8500。
- 结构确认（无需再查）：`f21` 为 8 字节环境计数标记（原生样本
  `68 00 07 03 05 6a 03 08` / `00 0d 0a 01 05 64 03 0d`），不与会话绑定，
  随机生成已被 00:00 swapfull T001 支持；浏览器 Log2/Verify 签名公式与本地
  完全一致（sorted params + 对应组 secret）；请求参数顺序、头序与浏览器 final
  channel 一致；跨站 XHR 无 Cookie 头，本地同样不带。

关键时间线（004 原生 T001，基准=seg1 ts）：Init -293ms（前）→ UploadLog +988ms →
Log2 +11699ms → Log3 +15393ms → Verify +17102ms。

### 下一轮采集（feilin005）

已写好 `agent-next.json`（script_contains=FeiLin/1.5.1/feilin005，
不写死 script_sha256，目标字段/头/cookie 与 004 轮一致）。请在
②首轮采集/目标字段面板点"加载当前目录 agent-next.json"→ 打开 Firefox →
开始记录 → 保留首次失败以及自动二次 Init/滑动 → 第二次 VerifyCaptchaV2
出现后立刻停止并整理。
拿到 005 浏览器 T001 明文后，按 004 同样的流程解密逐字段 diff（Log2/Log3/
DeviceToken 三件套 + UploadLog），再落地 005 模板。

### 004 修正的历史证据链（保留）

- 09-01 11:42–12:49（feilin003 期）：纯本地 NSS 链路 T001 通过率 81–92%——
  NSS Init 传输已被证明可用，F001 排除"传输指纹"单因解释。
- 09-01 18:00 轮换 feilin004 后全量 F001。
- 09-02 00:00 swapfull（浏览器 Init + 原生 UploadLog/Log2/Log3 + 我方
  deviceToken/data，feilin004 会话）：**T001** —— 我方 dt/data 内容在 004 被接受。
- 09-02 上午：004 原生样本逐字段对齐并落地修正（见上）。
- 09-02 ~12:35：轮换 feilin005；004 修正未能在线上 004 会话完成最终验证。

## 上一轮进度：FeiLin004（2026-09-02 上午，已被 005 轮换覆盖）

最新自动化浏览器 trace 已真实返回 `T001/true`，目录为
`traces/firefox-trace-51job-feilin004-diff-20260902`，健康检查完整且无 degraded 记录。
这轮样本说明浏览器链路正常，当前纯本地 `verify_run.py` 的 `F001` 应优先按**请求字段和
设备采集状态的固定/动态边界不一致**排查；暂不把 IP、TLS/HTTP2 或时间等待当作主因。

004 对照结论：payload 127 字段；`f68=0`、`f77=certifyId`、`f88` 为当前位图；`f21` 为
8 字节 Base64 且与 Log2 共用；token 字节共用但 `f72/f74` 时间戳分开；`f43` 为 11 段完整链；
DeviceToken/Log2 的 `GatherCost` 共用（本轮 7581）；Log2 `f52` 只随机末 5 位，前 45 位固定。
本地代码已修正 `f52`，纯本地 004 的最终 `T001` 仍待完成，后续以这轮浏览器 T001 请求体做逐字段
对齐，不再沿用旧版“纯本地已闭环”的结论。

### 004 当前固定/动态边界（排查基线）

| 字段/环节 | 当前处理 | 证据与要求 |
|---|---|---|
| `DeviceConfig.chunk[0]`、`[2]`、`[3]`、`[8]` | 动态读取 | 分别是 session key、seg1、FeiLin 路径、服务端记录 IP；不得写死 |
| FeiLin 版本 | 动态发现并缓存 | 从 `[3]` 提取 `feilin000..004`；新版本只提示并进入适配流程，不静默套旧模板 |
| `f21` | 每轮生成并在 DeviceToken/Log2 共用 | 004 样本为 8-byte Base64；先验证来源和序列化，不当作固定设备值 |
| `f71/f73` | 每轮生成一对并跨本轮请求共用 | 40 字符 token；随机生成已被旧周期 T001 实验支持 |
| `f72/f74` | 动态，且两处独立 | DeviceToken 与 Log2 的 `f74` 不能复用同一时间戳；按浏览器相对时序比较 |
| `f43` | 按当期模板生成 | 004 是 11 段完整链；旧 8 段模板不能复用 |
| `f52`（Log2） | 固定前 45 位，仅末 5 位随机 | 已落地修正；必须用 004 浏览器请求体验证骨架是否完全一致 |
| 位图/`si`/行为 JSON | 按当期 FeiLin/轨迹状态生成 | `f88` 与 `si` 存在版本/会话差异，不能使用旧周期常量 |
| AES/HMAC/盐/R1 key | 固定算法常量 | 已有字节级回归，不作为本轮优先变量 |
| IP、时间等待、VM 开关 | 不作为默认主因 | 仅在单变量实验中显式覆盖；trace 每轮 watchdog 命中后立即 stop/finalize |

### 下一轮验证顺序

1. 保存浏览器 T001 的 Init、UploadLog、Log2、Log3、Verify 明文/密文，和本地同轮输出，按接口逐字段 diff。
2. 先锁定前置状态：Init 返回值、UploadLog `js/rt`、Log2/Log3 的 `seq/cost`、字段顺序和时间链。
3. 对 `f21`、`f43`、双 `f74`、`f52`、位图/`si` 做单变量 A/B；每次只改一个字段并记录响应码。
4. 再检查 `GatherCost` 是否跨 DeviceToken、Log2、Log3 共享，以及是否由 UploadLog 的 `rt` 派生。
5. 只有当本地请求与浏览器请求字段完全对齐后，才重新评估传输层；当前验收仍以真实 `T001/true` 为准。

当前工程结论：Trace 已拿到完整 004 证据，浏览器链路通过；纯本地算法尚未通过。问题定位在
“前置接口/设备采集字段的固定与动态边界”这一层，仍没有足够证据把责任归给指纹、IP 或等待时间。

## 一、历史状态（2026-09-01，已被 004 结果覆盖）

该节记录 001/002 周期的阶段性结论。它不能作为当前 FeiLin004 的验收依据：004
同周期的 `verify_run.py` 仍返回 `F001`。保留这些内容用于追溯实验，不要据此判断当前
根因已经是 Init 传输指纹或 Log2 单字段。

一键运行：

```bash
examples/aliv2/dynamic_client/verify_run.py
```

批量并发统计：

```bash
cd examples/aliv2/dynamic_client
/opt/miniconda3/envs/pythonProject/bin/python batch_verify.py --runs 100 --workers 10
```

`--runs` 是总轮数，`--workers` 是并发进程数；每轮独立启动 Python，结果写入
`runtime/reports/batch-*.json`。全部返回 `T001` 时退出码为 `0`，否则为 `1`。
批量默认每轮生成新的 `token1`，避免把所有请求归并为同一个逻辑设备；只有需要复现实验时才使用
`--reuse-state`。

历史 Firefox oracle 仍由 `run_auto_browser_verify.sh` 保留作回归工具；最终运行路径不启动浏览器。

### 1.0 运行依赖边界

`dynamic_client/verify_run.py` 是纯本地算法/传输链路：不读取 `traces/`、不读取
Firefox Trace JSONL，也不需要启动 Firefox。每次运行只从实时接口取得挑战页的
`renderData`、`InitCaptchaV2` 的 `DeviceConfig/StaticPath`，再用本地 AES/HMAC、
`f21`/`f52` 生成器、轨迹生成器和本地 sg JSVMP 重放完成后续请求。

其中按 `StaticPath` 命名的 `runtime/cache/sg/*.vm.js` 是从动态脚本 URL 下载并缓存的运行时算法制品，
不是 trace 日志；`device_upload/*` 是源码模板，`runtime/state/device.json` 是并发安全的本地状态。
每轮还会登记 `DeviceConfig.chunk[3]` 的 FeiLin 版本到 `runtime/cache/feilin/index.json`；首次出现时输出
`[feilin] NEW VERSION`。这里只做版本发现和提示，不自动替换已验证的纯算算法。
Trace 仅用于历史逆向和回归取证，不是正式运行时输入；运行目录不要求保留 trace 文件。

早期假设曾认为根因是本地 Log2 的 `f[52]` 生成错误：原生值为
`836a8eccbcb664e?????c075af9cf688b83a9fa1160a39eb45`（50 字符，仅中间五位随机 hex），
旧实现误把整串随机化。该字段现已修正，但在 FeiLin004 上仍不足以使 Verify 翻转为
`T001`，因此只能视为已确认的局部差异，不能写成最终根因。

### 1.1 请求链与各环节状态

| # | 请求 | 关键内容 | 状态 |
|---|---|---|---|
| 1 | GET search-pc | 挑战页 HTML → renderData（token/traceid/userId/userUserId/sceneId） | ✅ |
| 2 | POST InitCaptchaV2 | Signature、DeviceData | ✅ reproduced |
| 3 | POST UploadLog | `log` 明文 JSON（sId/pfx/mInit/hst/cId/ip/js/rt） | ✅ 已实现并接受 |
| 4 | POST Log2/Log3 → device.captcha-open | Data = AES-CBC(a549a55c60a39aa0, 三层嵌套指纹包) | ✅ 全配方 reproduced |
| 5 | POST VerifyCaptchaV2 | CaptchaVerifyParam = {sceneId, certifyId, deviceToken, data} | ✅ 内容全对（见实验矩阵）|

### 1.2 各参数算法（全部 AES-128-CBC，IV=0123456789ABCDEF 固定）

| 参数 | 配方 | 状态 |
|---|---|---|
| Signature | Base64(HMAC-SHA1("POST&%2F&"+urlencode(排序query), KEY_SECRET+"&"))；captcha-pro 组 KEY_SECRET=`222aiJodos2938JDdosko2djd82sf0`，device 组=`DuanemHmyeE6LXCC46sJEDUw5DTlSZ` | ✅ |
| DeviceData | AES(45f8ac1e1de14397, `appKey#W#`+b64(AES(c175a358550d02e2, "W.10001.c#saf-captcha-waf#<sceneId>#captcha-normal#undefined#cn"))+`#W20220202#CLOUD#`) | ✅ |
| DeviceConfig | 解密 key `87f879f135f27da7`；chunk[0]=session_key(b64)、chunk[2]=seg1、**chunk[3]=feilin 版本路径**、**chunk[8]=服务端记录的 IP（payload f42 的来源）**、chunk[9]='0' | ✅ 全字段语义 |
| deviceToken | b64(`WEB#<seg1>#<cipher>#<GatherCost>#<md5>`)，md5 = md5(`WEB#<seg1>#<cipher>#<gather>#daye,raolewoba!`)，cipher = AES(session_key, 127字段payload)。f21 由 UUID 末 8 位经 XOR + printable-ASCII 环移生成 | ✅ 纯本地 T001 |
| payload（127/136 运行态字段） | 浏览器当次明文作为结构/环境基线；刷新 f21、f71/f73 随机 token、时间、certifyId，保留 f43/f78/f88/f109 与扩展尾部 | ✅ Round17/21 T001 |
| Log2/Log3 Data | AES(a549a55c60a39aa0, `appKey#W#b64(AES(sk,scene))#W20220202#CLOUD#<gather>#501#`+b64(seg1#payload#sub#sub##sub_ts))；Log3 外层多一层 `511#entry1-504#entry2` 嵌套（entry1=特征位图、entry2=行为JSON） | ✅ |
| 滑块 data | blob = b64(zlib(R2前缀+TrackListJSON)) → sg JSVMP 本地重放 `D(0,[],R1,F1,{r:1},[blob,"3e627e1b4c63f913"])`；TrackList 含 mc/mp/mm/tmv/ks/fi/startTime/si + 外层 TrackStartTime/VerifyTime/**arg** | ✅ byte-exact |
| arg | 同一台 VM：`D(0,[],R1,F1,{r:1},[certifyId, 16hex随机])` | ✅ |

### 1.3 实验矩阵（根因判定，全部真实请求）

| Init 谁发 | deviceToken | data | verify 传输 | 结果 |
|---|---|---|---|---|
| 浏览器 | 浏览器 | 浏览器 | curl_cffi（drop 重放） | **T001** |
| 浏览器 | 浏览器 | **我方** | curl_cffi（swapdata） | **T001** |
| 浏览器 | **我方** | **我方** | curl_cffi（swapfull） | **T001** ← 终局 |
| **NSS 本地客户端** | 我方 | 我方 | NSS | **T001** |

**已确认的局部差异：Log2 f52 的固定骨架曾被错误随机化。** 早期传输消融结论记录了当时现象，但被
2026-09-01 的 NSS 全链与 f52 单变量修复结果覆盖。附带：同 body 重放检测 = F008。

### 1.4 可用方案

- **混合模式（已验证 T001）**：项目 Firefox 通过 WebDriver BiDi 自动完成挑战页 GET、Init、
  v6 预注入和真实鼠标滑动；bridge 重建运行态 deviceToken/data 并执行 Verify。
  一键脚本：`run_auto_browser_verify.sh`。
- **纯客户端**：`dynamic_client/verify_run.py` 为最终主路径；NSS 直连默认启用，系统代理仅在
  显式设置 `CLIENT_PROXY` 时使用。

## 二、token（f71/f73）是什么、为什么不再需要提取

- **定义**：两个 40 字符随机串（大小写字母+数字），位于 deviceToken payload 的 f[71]/f[73]
  （Log2 payload 共用同一对），配套时间戳 f[72]/f[74]。feilin 启动时由运行时函数
  **rV/eT**（obfuscated）生成，生成后**整个周期内恒定**：跨会话、跨页面刷新不变（实测）。
- **周期性**：token 与 feilin 版本/session_key 周期绑定，**每天约 06:00/18:00 轮换时换一对**
  （实测：023cdfcd 期 `DHlUFXHL…/XP0vAhii…` → 40e822 期 `l8uJW3C8…/vzsFIXE8…` → 28e9fc4c 期
  `eSDeKqXi…/PFDF7ikr…`）。**过期 token = F001**。
- **本地获取：已解决（2026-08-31 随机 token 实验通过）**：
  **随机生成 token 对 → T001**（round12 实测：浏览器 Init 会话 + 随机 token 的 deviceToken +
  我方 data + curl_cffi 传输 = T001）。服务端不校验 token 推导/一致性——浏览器"周期内恒定"
  只是 feilin"生成一次复用"的实现细节。**客户端每次会话随机生成即可**（`swapfull_replay.py`
  支持 TOKEN_MODE=random）。
  （备查：周期内从浏览器提取的实现也在 swapfull_replay.py 默认路径里；feilin rV/eT 推导
  破解已无必要。）

## 二点五、已验证清单（全部真实请求，2026-08-31 收口）

### A. 消融实验矩阵（谁发 Init / 谁生成内容 / 谁传输）

| # | Init | deviceToken | data | verify 传输 | IP 一致性 | 结果 |
|---|---|---|---|---|---|---|
| 1 | 浏览器 | 浏览器 | 浏览器 | curl_cffi（drop 重放） | 同 IP | **T001** |
| 2 | 浏览器 | 浏览器 | **我方** | curl_cffi（swapdata） | 同 IP | **T001** |
| 3 | 浏览器 | **我方(随机token)** | **我方** | curl_cffi（swapfull/round12） | 同 IP | **T001** |
| 4 | 浏览器 | **我方** | **我方** | curl_cffi（swapfull，Init 后 4min+） | 混合 IP | **T001** |
| 5 | curl_cffi | 我方 | 我方 | curl_cffi | 同 IP | F001 |
| 6 | curl_cffi | 我方 | 我方 | 浏览器（实验A） | 混合 IP | F001 |
| 7 | requests-go | 我方 | 我方 | requests-go（全链） | 同 IP | F001 |
| 8 | requests-go | 我方 | 我方 | requests-go（补 Idempotency-Key） | 同 IP | F001 |

### B. 逐项结论（每条都有上表实验编号支撑）

1. **data/轨迹**：我方生成 = T001（#2/#3/#4）——TrackList 结构、track.py 轨迹、R2 前缀、
   R1 加密（key `3e627e1b4c63f913` 恒定）、arg、时间线（span 17s~256s 均接受）全部正确。
2. **deviceToken**：我方生成 = T001（#3/#4）——127 字段 payload、随机 token（见 D）、
   sub1=b64(8B随机)、f87=seg1ts+2/3ms、md5 盐 `daye,raolewoba!`。GatherCost 在浏览器中是
   FeiLin 采集阶段的计时差；swapfull 复用浏览器当次值，固定向量可通过 `GATHER_COST_MS` 指定。
3. **token（f71/f73）随机生成即可**（#3/#4 T001）——服务端不校验其推导/一致性；
   浏览器"周期内恒定"只是 feilin"生成一次复用"的实现细节，不是服务端约束。
4. **verify 传输层**：curl_cffi firefox 指纹合法（#1 T001），且 **IP 可以不一致**
   （#4 混合 IP T001）——服务端不绑定 Init 与 verify 的 IP/传输一致性。
5. **UploadLog/Log2/Log3**：全新生成 Data 全部被接受（ResultObject:true / Code:200，
   每轮 E2E 均实测）；Log2 的 127 字段 payload、Log3 的 `511#entry1-504#entry2` 嵌套、
   f52 随机位分布、外层 key a549a55c60a39aa0 均已验证。
6. **Init 响应无降级标记**：脚本库发 Init 的响应与浏览器逐字段一致（Success/CertifyId/
   DeviceConfig/StaticPath 全正常）——风控标记是隐式的，只在服务端风控表里。
7. **历史判断：F001 的主要嫌疑是 Init 请求的 TLS/HTTP2 二进制指纹**：
   - 请求明文层已 100% 对齐（URL/参数/头/头序/Idempotency-Key）仍 F001；
   - curl_cffi 与 requests-go 两个不同内核的 Go/BoringSSL 指纹库均被识别；
   - **与 IP 无关**：同一 IP 上浏览器 Init→T001 vs 脚本 Init→F001（#1/#3 vs #5/#7/#8）；
   - **与 IP 一致性无关**：#4 Init 与 verify 出口不同仍 T001。
8. **F008 = 同 body 重放检测**（drop 实验中同一请求体第二次起必 F008）。
9. **失败页行为**：F001 后 WAF 触发页面自动重载（新 certifyId 新会话），原会话作废。

### C. 设备上报链路（device.captcha-open，已实现且每轮实测通过）

- 请求参数（无 Timestamp）：`AaduaneId=DuaneAprqkYsF3nt1yjK29Bf, Version=2020-10-15,
  SignatureMethod=HMAC-SHA1, SignatureVersion=1.0, Format=JSON, Action, Data, SignatureNonce, Signature`
- 签名 KEY_SECRET = `DuanemHmyeE6LXCC46sJEDUw5DTlSZ`
- Data = b64(AES(a549a55c60a39aa0, 明文))；**内层全部用 session_key**（DeviceConfig chunk[0]）
- Log2 明文 = `appKey#W#b64(AES(sk,scene))#W20220202#CLOUD#<GatherCost>#501#b64(seg1#payload#sub_a#sub_b##sub_ts)`
- Log3 明文 = `appKey#W#<scene>#W20220202#CLOUD#<seq>#b64("511#<entry1>-504#<entry2>")`
- 实现：`dynamic_client/device_upload.py`（含字节级回归自检）；模板 `device_upload/`

### D. 工具清单（本目录）

| 工具 | 用途 | 状态 |
|---|---|---|
| `dynamic_client/verify_run.py` | 纯客户端全链 E2E（Init→…→Verify），TRANSPORT=rg/cffi 可切 | 可用（Init 被标，F001） |
| `dynamic_client/swapfull_replay.py` | 浏览器 Init 会话 + 全我方内容重放（**已验证 T001**） | ✅ 主力 |
| `dynamic_client/device_upload.py` | Log2/Log3 全新生成 + 签名上报 + 自检 | ✅ |
| `dynamic_client/payload_util.py` | deviceToken payload 127 字段构建（随机 token） | ✅ |
| `dynamic_client/track.py` | 真人轨迹生成器（r9 校准密度/时序） | ✅ |
| `dynamic_client/extract_sg_vm.py` | sg JSVMP 字节码自动提取（按版本缓存） | ✅ |
| `inject/bridge_server.py` | 本地桥接（/session /prepare /fresh /capture /steal） | ✅ |
| `inject/console.js` | 页面预注入（v6：状态机、drop/swapdata/swapfull/steal/off） | ✅ |
| `inject/auto_browser_verify.js` | BiDi 自动预注入、等待 Init、定位滑块、真实鼠标动作和 T001 验收 | ✅ |
| `run_auto_browser_verify.sh` | bridge + Nightly + watchdog + BiDi 的一键入口 | ✅ |
| `ast_feilin/` | feilin000 沙箱（Node vm + 浏览器桩，getter 全映射） | ✅ |

## 三、每天 06:00/18:00 轮换——实测到底变什么

**变的：**
| 项 | 证据 |
|---|---|
| feilin 脚本版本 | feilin000.d030213a → feilin001.874f974c → feilin002.3ef8801a；路径由 DeviceConfig chunk[3] 动态下发，**配置/过滤永远不要写 feilin 的 sha256** |
| token 对（f71/f73） | 每个周期换一对（三次实测三对） |
| session_key 周期 | chunk[0] 动态下发（客户端本来就动态取，不受影响） |
| payload 模板形态 | 8/30 6点：111 字段(r2 形态) → **127 字段**；f88 位图变位；新增 f52(49字符)；之后 6pm 轮换形态未再变 |
| si 第 8 位 | 104.166… → 125（rAF/帧率指标，feilin 版本定义变化，取当期浏览器实测值） |

**不变的（跨轮换实测稳定）：**
- 全部 AES 密钥（45f8/c175/87f8/a549/87f8…）、固定 IV、HMAC-SHA1 签名、KEY_ID/KEY_SECRET、
  盐 `daye,raolewoba!`
- R1 加密 key 常量 `3e627e1b4c63f913`；R2/R1 JSVMP 字节码算法（版本随 StaticPath 每会话随机
  下发 sg.051~099，算法跨版本 byte-exact 稳定，提取流程已脚本化 extract_sg_vm.py）
- TrackList 结构、payload 字段布局（6pm 轮换后至截稿稳定）、上传链路与参数集
- **注意**：**任何配置不要对 feilin/sg 填 script_sha256**（多版本动态下发），过滤用子串
  `captcha-frontend`；每轮分析前先从 categorized/script.jsonl 确认当期版本

## 三点五、requests-go 测试结论（2026-08-31，历史证据）

`requests-go`（bogdanfinn 系 Go TLS 库，自定义 JA3 + headers_order + pseudo_header_order）已接入
客户端（`TRANSPORT=rg`，Firefox 142 JA3 + 浏览器头序）：挑战页 GET ✅、Init ✅、UploadLog ✅、
Log2/Log3 ✅、Verify 全链跑通——**VerifyCode = F001**。curl_cffi Init 对照同样 F001。

→ **两个主流 Go TLS 指纹库发 Init 都曾被识别**。这是 001/002 周期的传输消融证据，
不能单独推出 004 的当前根因；004 要先完成浏览器 T001 请求与本地请求的字段级差分。

## 三点八、与 aliv3 方案对比（2026-08-31，另一个成功实现的复盘）

`examples/aliv3/demo.py`（另一站点/阿里 V3 标准版，已跑通 T001）的做法与本案例的差异复盘：

### aliv3 的核心做法
1. **完整补环境跑真 feilin.js**：v2_env.js（2159 行 Node 环境——伪造 window/document/navigator/
   screen/localStorage + Proxy watcher + V8 `%GetUndetectable()` 反检测），下载当期 feilin.js
   整体 eval，调 `FEILIN.initFeiLin(config, cb)` 让 **feilin 自己产出 payload 明文（zhiw）
   和 gatherCost**——不逆向模板。
2. **Log1 前置**：Init 之前先发 `Action=Log1`（cloudauth-device-dualstack 端点，固定 Data，
   第三组密钥 `fpOKzILEajkqgSpr9VvU98FwAgIRcX`）——设备先"注册"。
3. **token 随机生成**：v2_env 里 `gfdc6456=randomText(40)` 直接随机——与本项目 round12
   "随机 token T001" 实验互相印证。
4. **不同接口族**：InitCaptchaV3/VerifyCaptchaV3（captcha-open 标准版）+ 缺口图片 CV 识别
   （captcha_recognizer）+ V3 拼图滑块。

### 与本项目结论的对齐与差异
- **互相印证**：token 随机可行（两边独立得出）；payload 结构/加密配方一致。
- **关键差异 ≠ 方法优劣，而是目标风控等级**：aliv3 打的是 V3 标准版（captcha-open），
  本项目是 WAF 专业版（captcha-pro-open，51job）。它的 curl_cffi Init 不被标记，
  不代表专业版不标——本项目的实验矩阵（8 行消融）证明专业版会标。
- **它没有推翻本项目根因结论**：它没在 captcha-pro 端点上验证过 curl_cffi Init。
- **可迁移的增强**（对本项目）：
  1. **feilin.js 完整补环境运行**（比模板替换更鲁棒）：gatherCost 真实、payload 由 SDK
     内部一致性逻辑产出、feilin 版本轮换天然适配（每轮下载当期脚本）。
     本项目已有半成品：`ast_feilin/`（feilin000 沙箱，getter 已映射）+ aliv3 的 v2_env.js
     可直接改造为 51job 版（换 endpoints/SceneId/prefix 即可）。
  2. **Log1 前置**：51job WAF 场景的 trace 中 Init 是首个请求（浏览器无 Log1），故 Log1
     非必需；但若纯客户端仍 F001，可测 "UploadLog 前置到 Init 之前" 的变体。

### 本项目路线的复盘（历史实验，不覆盖 004 当前结论）
- **对**：消融实验矩阵的判定方法（drop/swapdata/swapfull）——它把"内容对不对"与
  "Init 指纹"彻底解耦，这是任何模板方案都给不出的确定性。
- **对**：token 随机可行性的单变量实验——一步消掉了整条 feilin 逆向支线。
- **绕了**：feilin 补环境（ast_feilin）做到一半转去模板路线——模板路线在 swapfull 中
  已够用，所以不算错，但若早点确认"跑真 feilin"是 aliv3 式方案的基石，两条路可并行。
- **当时判断**：纯客户端在 51job pro 版上卡 Init 指纹；这只属于 001/002 周期的传输
  消融证据，不能解释 004 当前仍为 `F001` 的现象。004 现阶段按请求字段和设备采集状态
  的固定/动态边界继续排查。

## 四、开放问题（按优先级）

1. ~~token 获取~~ **已解决：随机生成即可（round12 T001 实测）**
2. ~~Init 浏览器化落地~~ **已解决：项目 Nightly + WebDriver BiDi 全自动完成。**
3. 轨迹通过率调参：真人滑动也偶发首滑 F001（r4/r6），当前 track.py 按 r9 真样本校准
   （密集接近段 55-80 点 + 拖动 22-30 点），通过率需批量统计
4. f93/f94 精确语义（当前按"距 Init 毫秒数"生成，观测域 17~49s）

---



- TRACE_DIR：`traces/firefox-trace-51job-search-pc-20260828`
- URL：`https://we.51job.com/api/job/search-pc?api_key=51job`
- 计划：full-chain + JS boundary，active 启动，人工过滑块
- 采集健康：`degraded_count=0`，`environment-contract` 两项均为 complete；246014 事件（js 232k / dom 12k / network 48 / script 70）

## 结论：整条链是阿里云 WAF + 阿里云验证码 V2（滑块）

请求时序（GET search-pc 均为 document 导航）：

1. `GET /api/job/search-pc?api_key=51job` → 命中 WAF，返回滑块挑战页
2. 加载 `o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
3. XHR POST（form，含 HMAC-SHA1 签名）：
   - `93bc86fc...captcha-pro-open.aliyuncs.com` → `Action=InitCaptchaV2`（参数含 `SceneId=19x5u7lo`、`UserUserId`/`UserId`（密文）、`UserCertifyId=ac11000117879325974192537e00c8`、`DeviceData=...`、`SignatureNonce`、`Signature`）
   - `upload.captcha-pro-open` → `UploadLog` / `Log2` / `Log3`（行为日志）
   - `device.captcha-open.aliyuncs.com`（设备指纹上报）
   - `...-verify.captcha-pro-open` → `VerifyCaptchaV2` → 响应 `{"ResultObject":true,...,"Code":"200"}`
4. 验证成功后重定向链（3 跳，全部 GET 同一 URL）：
   - `?api_key=51job&u_atoken=bed9d6c7...&u_asig=ac11000117879325974192537e00c8`
   - `GET /u21pn7x6/r8lw5pzu/psk8uqfi`（WAF JS 挑战脚本，混淆形态 mGbnfg/obfuscator.io）
   - `?api_key=51job&decode__1048=2287582d28-nlvlcky...`（最终放行）

## 关键生成字段与 producer 链

### u_asig
= `ac11000117879325974192537e00c8`，即 `InitCaptchaV2` 的 `UserCertifyId`，同时是 cookie `acw_tc=ac11000117879325974192537e00c80827b5...` 的前缀。验证成功回调链：

```
sg.088 (dynamicJS 3.29.0) rv/e.onBizSuccess(sig)
 └─ 内联 success(sig)   call_284320
     └─ reGet()         call_284321
         └─ reGenUrl()  call_284323 → 返回 "?api_key=51job&u_atoken=...&u_asig=..."
```

### u_atoken
`bed9d6c7b34f83ccd6c1fb39460f6cbd`，来源是挑战页内联 `getRenderData()` 的返回（页面加载时已带出，`js.call.return` call_1199，SHA256 有制品）。

### decode__1048
由 WAF 拦截页 HTML 中的内联混淆脚本计算（`web-assets/html/we.51job.com__api__job__search-pc__q_9450836fa6.html`，meta 含 `aliyun_waf_aa/bb`，两段 inline script）。运行时链（script_url 均为 search-pc 页的内联脚本）：

- 重计算/拼接：`V`（call_289588/289590）、`D`（call_289941）先出现最终值片段
- 组装 query：`vHWtv`/`sZUlc`/`aHeNp`（父 anonymous call_299414）→ `Nfdhk` → `v` → `PNPGr`/`tQrBa` 得到完整 URL 后导航
- 依赖 `Math.random`（js.random 1828 条）与时间（js.time 580 条）

### 阿里验证码 API 自身参数
`Signature`（HMAC-SHA1，`SignatureMethod=HMAC-SHA1&SignatureVersion=1.0&SignatureNonce=<uuid>`）、`UserUserId`/`UserId`（密文）、`DeviceData`（sg.088 / feilin000 采集）。候选脚本（target-candidates static-fallback，correlated）：
- `g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin000.d030213aa800ceb269ffd5211ae00a0f4f18970912e2a40d8802ef3488bdba89.js`
- `o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（sha256 c39b3b40...，artifact 已存）
- `g.alicdn.com/captcha-frontend/dynamicJS/3.29.0/sg.088.f7ff24928783a8a4.js`

### Cookies
`acw_tc`（服务端下发）、`_c_WBKFRo`、`_nb_ioWEgULi`。

## 2026-08-29 追加：签名算法已 confirmed（首轮 trace 直接命中）

AliyunCaptcha.js（sha256 `c39b3b40...`）内所有密钥常量是 AES 密文，运行时经 `gr()` 解密。首轮 boundary 值制品直接抓到全部明文：

| 值 | 来源 |
|---|---|
| `FqJB6iRNVYdEGpwb` | ACCESS_SEC，AES 主解密 key |
| `111jdk439dJJIjd023823201` | captcha-pro 域名组 KEY_ID（= 请求里 AaduaneId） |
| `222aiJodos2938JDdosko2djd82sf0` | captcha-pro 域名组 KEY_SECRET（call_11699 Cr 第 2 参） |
| `DuaneAprqkYsF3nt1yjK29Bf` | device 域名组 KEY_ID |
| `DuanemHmyeE6LXCC46sJEDUw5DTlSZ` | device 域名组 KEY_SECRET |
| `45f8ac1e1de14397` | 16 字节 AES key（WEB_AES_SECRET_KEY） |
| `87f879f135f27da7` | DeviceConfig 解密 key（gr(87f8..., DeviceConfig) → deviceToken 明文块 `ZjJhNmE1...#MQ==#sh87bd...`） |
| `c175a358550d02e2` | WEB_AES_FLAG_SECRET_KEY |

**签名算法（已本地重算 byte-exact 匹配 InitCaptchaV2 的 `HxfcWaflvJQV7JHTIztsOoepsis=`）：**

```
StringToSign = "POST&%2F&" + urlencode(按 key 排序拼接的 query)
Signature    = Base64(HMAC-SHA1(StringToSign, KEY_SECRET + "&"))
```

- 生成函数：AliyunCaptcha.js 的 `Cr(params, KEY_SECRET)`（混淆，call_11699）→ `_r(key+"&", stringToSign)`（call_12362，crypto-js HmacSHA1 → Base64 stringify）
- 6 个请求里：Init/UploadLog 用 captcha-pro 的 `222ai...sf0`；device 的 Log2/Log3 和 VerifyCaptchaV2 由 **FeiLin**（feilin000.<hash>.js）自己的签名路径发，用 device 的 `Duane...TlSZ`（`stringify` = crypto-js Base64 serializer，call_189142 等）
- `Timestamp=he()`（ISO8601 `2026-08-28T15:56:36Z`）、`SignatureNonce=de()`（uuid4）
- feilin 脚本 URL 是动态 hash 多套（`feilin000.d030213a...js` 本轮 sha256 `d030213a...`），key 常量在 AliyunCaptcha.js 侧、按域名组分两套

证据等级：Signature = `reproduced`（本地重算相等）；KEY 明文 = `matched`（value store SHA-256 制品）。

## 2026-08-29 Round2 定向 trace：DeviceData 已 reproduced，deviceToken/滑块密文链路已定位

TRACE_DIR：`traces/firefox-trace-51job-target-round2-20260829`（object_depth=2，body 字段精确抽取命中 66 条，degraded=0）

### DeviceData（InitCaptchaV2 body）— 本地复现 byte-exact

生成链（均在 AliyunCaptcha.js）：`Rr(call_11238) → br → eidAL → yr`（yr = AES 加密 + Base64）：

```
inner      = AES-128-CBC(key=c175a358550d02e2, IV=0123456789ABCDEF,
             "W.10001.c#saf-captcha-waf#19x5u7lo#captcha-normal#undefined#cn")
           = "V0z3lM83c/TjjZu6HWeg92kI+mv4If/Gnz2J/...=="        # 场景配置串加密
DeviceData = AES-128-CBC(key=45f8ac1e1de14397, IV=0123456789ABCDEF,
             "sh87bd1512hsb03cb405803a307dbe32#W#" + inner + "#W20220202#CLOUD#")
```

- IV 是恢复出来的固定值 `0123456789ABCDEF`；PKCS7 padding
- 两层 re-encrypt 均与请求值逐字节相等（`openssl enc -aes-128-cbc` 验证）
- 明文里的 `sh87bd1512hsb03cb405803a307dbe32` = sg SDK 稳定设备指纹 ID（两轮 session 相同），其生成在 sg.088 内部；`W.10001.c`、`saf-captcha-waf`、`19x5u7lo`、`captcha-normal`、`cn` 都是场景配置常量

### deviceToken（CaptchaVerifyParam 内）— 组装链已定位

```
DeviceConfig（InitCaptchaV2 响应，服务端下发，密文）
 → gr(87f879f135f27da7, DeviceConfig) = "ZWMyZmY4YjZkYWJjMzFjMw==#MQ==#sh87bd1512hsb03..."   # Base64 分段
 → 组装 "WEB#sh87bd1512hsb03cb405803a307dbe32-h-<ts>-<uuid>#<G6x9...cipher>#0#<hash>"
 → 尾段 hash 由 crypto-js createHelper/finalize/_append 计算（call 4535751127 附近）
```

- 同轮 deviceToken Base64 解开：`WEB#sh87bd...-h-1787934346055-33b2bae4ffdc...#G6x9fdngLsy/...#0#...`
- `#W#` 中段的 `G6x9...` cipher 与尾部 hash 的输入还没有完整对应，是 Round3 候选

### CaptchaVerifyParam.data（滑块行为密文）— producer 链已锁定

```
FeiLin（feilin000.<动态hash>.js）采集滑块行为
 → sg.088 (dynamicJS/3.29.0/sg.088.<hash>.js): tc/ew.z → nh → nh/u.J → np → tc(47, Object)
 → t(0, Array, Array, Array, Object, Array)   # 入参 3 个 Array = 轨迹/行为数据
 → 返回密文 "JRMlgggw..."（648 字符 Base64）
```

- `t` 的 Array 入参本轮 object overlay 未展开（数组元素未被 depth=2 覆盖），是下一轮最深缺口；sg.088 是混淆 VM 风格，还原成本最高

### Round2 阶段性结论

| 字段 | 状态 |
|---|---|
| Signature（6 个请求） | reproduced（Round1，HMAC-SHA1 + 两把 KEY_SECRET） |
| DeviceData | reproduced（AES-128-CBC 双层，key/IV/明文全掌握） |
| u_asig / u_atoken / CertifyId | 服务端下发/acw_tc 前缀，无需计算 |
| deviceToken | correlated（组装格式明确，中段 cipher 与尾 hash 待补） |
| CaptchaVerifyParam.data | correlated（producer 锁定 sg.088，明文轨迹数组待展开） |
| decode__1048（WAF） | 内联脚本源码已存（round1 web-assets），待 AST 还原，不依赖新 trace |



1. `u_asig`：取 `acw_tc` 前 30 字符（待单变量确认），无需计算。
2. `u_atoken`：来自 WAF 挑战页 HTML 的 render data，需先请求一次 `?api_key=51job` 拿挑战页。
3. `decode__1048`：算法在已捕获的内联脚本里（HTML 已存 web-assets），可用 AST 还原；输入含随机数/时间，需要逐段比对。配合 `js.random`/`js.time` 的调用时序可冻结固定向量做 diff。
4. 若要走完整自动流程，还需要过滑块的 `VerifyCaptchaV2` 请求（DeviceData/Signature 属于阿里验证码 SDK 侧，属另一条独立还原目标）。

## 2026-08-29 追加：设备 ID 来源排查

`sh87bd1512hsb03cb405803a307dbe32`（32 字符，DeviceData 明文与 deviceToken 共用）：

已排除的可能：
- **非服务端下发**：首次出现（round1 call_11261，round2 call_10805）早于 InitCaptchaV2 请求发出；InitCaptchaV2 响应的 DeviceConfig 里是"回显"同一个 ID
- **非本地缓存**：两轮均为全新 profile，cookie/storage 事件中无该值
- **不在挑战页 HTML**：curl 拉取 WAF 挑战页确认，`renderData` textarea 只有 `token(=u_atoken)/traceid/userId/userUserId/sceneId/region`；`aliyun_waf_aa/bb` meta 虽跨会话稳定但 JS 读 meta 的时间在 ID 出现之后
- **无函数 return 产生它**：它诞生于 AliyunCaptcha.js webpack 模块**顶层执行**（`js.script.enter` 窗口内），顶层表达式没有调用边界，boundary 层抓不到计算过程；出现前仅有 UA/language 等少量读取，无 canvas/webgl 重指纹
- 同为跨会话稳定值的还有 `userId`/`userUserId`（AES 密文，两轮相同），三者同源

结论：该 ID 是 AliyunCaptcha.js 顶层用固定常量+少量稳定环境值算出的准常量（per 租户/设备稳定），纯算需还原对应模块 chunk（AliyunCaptcha.js sha256 `c39b3b40...`，源码已存 scripts/）。实用替代：从真实会话提取一次作会话常量，DeviceData 其余部分已可算；服务端若校验 ID 与指纹一致性，则需连同 sg.088 指纹一起还原。

结论（2026-08-29 最终版）：**设备 ID 不是算出来的，是 SDK 内嵌的 appKey 常量**。
- 反混淆进展：AliyunCaptcha.js 用 obfuscator 字符串表（`Gt` 数组 + `rt` 访问器，base64+XOR，索引基 314）内嵌长常量，运行时按 `G(a)+G(b)+...` 8 字符片段拼接。解码池里找到了 ID 的全部 4 个片段：`sh87bd15`(495) / `12hsb03c`(470) / `b405803a`(387) / `307dbe32`(433)；dev 环境 appKey `sh3c47a8ddhs03057ef9e8a295bc895c` 的 4 个片段同样在表中，且该值在 `h=Ft.appKey[o][p]`（按 API 版本+地区查 appKey 表）同一函数里被硬编码为 dev 分支值
- 即 `sh87bd1512hsb03cb405803a307dbe32` = 生产 cn 区 appKey 常量，语义上就是 AliyunCaptcha 配置里的 `appKey`（round1 call_11261 `(obj,"appKey","sh87bd...")` 与之吻合）
- 这同时解释了"trace 无计算记录"：模块初始化在顶层执行窗口内完成字符串解码拼接（无函数调用边界、无指纹采集输入），boundary 层只看到"作为参数传入"
- 模拟方式：直接使用常量，零计算。稳定性以 SDK 版本 + 租户（SceneId）为边界，SDK 升级可能更换
- 解码器提取脚本产物：`/tmp/rt_gt.js`（Gt+rt）、`/tmp/rt_dump.json`（解码池）；表完整映射因访问器多实例/旋转偏移未 100% 对齐，但不影响本结论

round-3 VM window 配置因此不再需要执行（保留 `agent-next.json` 未加载）。

## 2026-08-29 Round3（已跑）/ Round4（待跑）：VM window 实测与下一步

Round3（`traces/firefox-trace-51job-vmwindow-round3-20260829`）：窗口本身健康（`ftvmw1-le`、262144 条全、`sequence_complete=true`，`pretrigger_overwritten=7226251`），但**冻结点在 `xhr.body.AaduaneId`（InitCaptchaV2 发送）**——缓冲覆盖的是签名路径（Cr，已复现），且该轮 VM 过滤只锁 AliyunCaptcha.js，对 sg.088/FeiLin 无记录。device ID 之谜随后由离线反混淆解决（appKey 常量），该窗口未再派上用场。

deviceToken 离线试解（失败，需运行时）：`WEB#<id>-h-<ts>-<uuid>#<cipher 768B>#0#<md5>`；cipher 用 45f8ac1e/c175a358/87f879f1/FqJB6iRN + IV 0123456789ABCDEF（CBC/ECB）均解不开；MD5 尾段对 seg1/cipher/拼接组合均不匹配。→ cipher 段大概率出自 sg SDK 自有算法。

Round4 配置（`agent-next.json`，待加载）：**唯一 body 字段 `CaptchaVerifyParam`**，首次命中 = VerifyCaptchaV2 发送，环形缓冲尾部正好覆盖 sg.088 滑块密文链 `tc/ew.z→nh→np→tc→t` 与 FeiLin 打包；VM 过滤 `script_contains=captcha-frontend`（三脚本全覆盖）。

## 2026-08-29 Round3.5：deviceToken 算法破解（离线，零 trace 成本）

从 round-2 boundary 值制品直接命中（FeiLin `o(20, key, plaintext)`，call_333187）：

```
session_key = base64decode(DeviceConfig 解密的第 1 段)  # ZWMyZmY4YjZkYWJjMzFjMw== → "ec2ff8b6dabc31c3"
cipher      = AES-128-CBC(key=session_key, IV="0123456789ABCDEF", 指纹明文)
deviceToken = Base64("WEB#" + id + "-h-" + ts + "-" + uuid + "#" + cipher_b64 + "#0#" + md5尾段)
```

- IV 反推确认为同一个固定值 `0123456789ABCDEF`；明文 762 字节为 `W.10054#...#平台/UA/屏幕/时序统计/certifyId/token对#...` 的 `#` 分段指纹串
- trace 捕获的明文参数比实际加密串少 14 字节（`|93-NaN|94-NaN`，捕获时字符串未拼完）——加密对象以解密结果为准
- 待补：MD5 尾段输入；明文里 2 个子密文段（`40rJ+o8KjWbfmB495UfDjw==` 等）的构造
- sg.087 artifact 实际存在于 round-2 scripts（`sg.087.c1287cb38e27b97d.js`，443442B——该轮 StaticPath 下发的是 087 不是 088）
- 滑块密文 `CaptchaVerifyParam.data` 用同一组 key/IV 试解均失败 → sg.087 自有算法，走离线分析

Round4 配置改版（应用户提醒：VM window 会强制全局 opcode 解释器模式，sg.087 滑块期高频执行会拖死浏览器且污染行为时序）：**去掉 VM**，普通 JIT + `object_depth=4/array_items=32` 展开 `t()` 轨迹明文数组，JIT 保持流畅。VM window 留作最后手段（若离线分析确需字节码级证据，再用 pc_range 定点短窗口）。

## 2026-08-29 注意：feilin / dynamicJS 是服务端动态下发的多版本脚本

三轮实测：

| 轮次 | dynamicJS (sg) | FeiLin |
|---|---|---|
| Round-1 | `dynamicJS/3.29.0/sg.088.f7ff24928783a8a4.js` | `FeiLin/1.5.1/feilin000.d030213aa…js` |
| Round-2 | `dynamicJS/3.29.0/sg.087.c1287cb38e27b97d.js` | 同左（hash 未变） |
| Round-3 | `dynamicJS/3.29.0/sg.084.1de89ba8c12b956c.js` | 同左（hash 未变） |

规则与影响：
- **sg (dynamicJS) 每轮都可能换版本**：由 InitCaptchaV2 响应的 `StaticPath` 字段指定（round-2 响应里 `StaticPath: "3.29.0/sg.088.f7ff24928783a8a4"`）。版本号 + hash 双动态，后台存在多套
- **feilin 后台同样多版本**（用户确认），当前观测稳定在 1.5.1/d030213a，但不可假设跨会话不变
- 因此：**任何配置永远不要对这两个脚本填 `script_sha256`**，过滤一律用子串（`captcha-frontend` 或 `feilin`/`dynamicJS`）；算法结论必须带版本号（如"sg.087 的算法"），跨版本需重新验证
- round-2 的 deviceToken 破解结论基于 feilin 1.5.1/d030213a + sg.087；若后续会话版本变化且行为异常，先核对版本再下结论
- 每轮分析前先从 `categorized/script.jsonl` 确认本轮实际加载的 sg/feilin 版本，并确认对应 artifact 已存入 `scripts/`

## 2026-08-29 Round4（轻量 overlay）：轨迹明文完全到手，两次滑动已区分

TRACE_DIR：`traces/firefox-trace-51job-round4-overlay-20260829`。本轮 sg 版本 = **sg.065.141518780c4f4c58**（第 4 个版本），FeiLin 仍 1.5.1/d030213a。degraded=0。**object_depth=4 有效**：`t()` 的入参对象以 `items`/`props` 内联展开。

用户滑了两次：第 1 次失败（VerifyCode **F001**，xhr_7），第 2 次通过（**T001**，xhr_10），相隔 10s。两次**共用同一个 deviceToken**（`-h-1787938908034-b93cff68…`，设备初始化时生成一次复用），只有滑块 `data` 不同。

### 滑块 data 的输入结构（sg.065 `t(0, Array×3, Object, Array)`，均已展开）

- arg1：空数组；arg2：1498 元素全 0 数组（两次同引用，静态）；arg3：135 个单字符字符串（字母表）；arg4：`{r:1}`；**arg5：2 个字符串**
- arg5[0]（每次滑动独立）= **32 字符 md5 前缀 + zlib 压缩的 TrackList JSON**；arg5[1] = 16 hex `3e627e1b4c63f913`（两次相同）
- TrackList 明文格式：`{"TrackList":{"mc":"x,y,t, ,1","mp":"x,y,t,1|x,y,t,1|…","tc":"","mu":"","te":"","tmv":…,"mm":…,"ks":…,"fi":…,"startTime":…,"si":…},"TrackStartTime":…,"VerifyTime":…,"arg":"fKgTmEcn…"}`
- **失败 vs 成功轨迹对比**：

| | 次数(F001) | 通过(T001) |
|---|---|---|
| mp 采样点 | 12 | 85 |
| 拖动时长 | 3663ms | 1780ms |
| 位移 | 364px | 331px |
| 压缩后 payload | 614B | 1941B |
| data 密文 | 448B | 968B |
| arg 字段 | fKgTmEcn…Mcx4 | 同前缀+`xBwuXBI6` 后缀（每次变） |

失败那次采样点过少（12 个）且拖动偏慢——典型的"分段过快/无微抖动"特征。

### data 密文算法现状

- 密文与 arg5[0] **长度严格相等**（448→448、968→968）→ 输入就是该 base64 文本、变换保长度
- 已排除：固定 keystream XOR（两组 keystream 仅前 4 字节相同、约 20% 位置偶合）、单字节代换（密文熵高，185/228 个不同字节）、16/8 字节 md5/sha/CFB/autokey 等简单反馈链
- 结论：sg.065 的加密是真正的分组/流密码，需要离线分析 `scripts/` 里的 sg.065 artifact（443KB 级混淆）配合这**两组已知明文-密文对**做定位；VM window 留作最后手段

## 2026-08-29 重大突破：sg 是 JSVMP，滑块 data 密文本地 byte-exact 重放成功

### 识别过程

- `t()`（sg.065 col 203418）= **JSVMP 解释器** `D=function t(n,e,r,i,a,o)`：`r`=字节码数组、`e`=栈、`i`=常量表、约 50 个操作码（19=VM 子调用、55=方法调用、27=函数定义、35/25/54=跳转…）
- trace 里 `t(0, [], Array(1498), Array(135), {r:1}, [blob, hex])` 即解释器被直接调用：pc=0、空栈、字节码、常量表、参数=`[轨迹包, 16hex]`
- sg 源码里只找到一个 1498 元素数字字面量数组（`R=[0,0,0,1,0,2,...]`，offset 207388）= 加密例程字节码；紧随其后的 `F=["o","n","r","t","e","_","Boolean",...]` = 135 项常量表（与 trace arg3 完全对应）；另有第二段字节码 `L`

### 本地重放（byte-exact）

`sg_vm_replay/` 目录（解释器 + F/R/L + 已知向量 + `replay.js`）：

```js
D(0, [], R, F, {r:1}, [item0, item1])   // → CaptchaVerifyParam.data 字符串
// item0 = base64( zlib( md5hex32 + TrackList JSON ) )
// item1 = "3e627e1b4c63f913"（16 hex，会话内两次滑动相同）
```

- a1（F001 失败，448B 输入）→ 600 字符输出，**byte-exact 匹配** ✓
- a2（T001 通过，968B 输入）→ 1292 字符输出，**byte-exact 匹配** ✓
- 修改输入尾部 → 输出仅尾部变化（592 字符处分叉）→ 确认是真实的流式/反馈函数，不是缓存
- 加密内部是反馈结构（keystream 随密文/明文链演化），无需再逐 opcode 理解即可使用；版本变化时按本流程重新提取 R/F 即可

### 至此的完整复现清单

| 参数 | 状态 |
|---|---|
| Signature（6 请求） | ✅ reproduced |
| DeviceData | ✅ reproduced |
| 设备 ID (appKey) | ✅ 常量 |
| deviceToken | ✅ 算法确认（AES-CBC + session key），待补 md5 尾段输入 + 2 个子密文段 |
| **滑块 data（sg）** | ✅ **reproduced（VM 本地重放）** |
| TrackList 明文格式 | ✅ 完整记录 |
| 待解：md5 前缀（非 md5(JSON)）、item1 16hex 来源、deviceToken md5 尾段 | 未定 |

### 追加：`arg` 字段同样 VM 重放成功

TrackList 里的 `arg`（"fKgTmEcn…"）= 同一台 VM 的输出：`D(0,[],R,F,{r:1},[CertifyId, 16hex])` → byte-exact ✓。即同一套字节码是通用的 `encrypt(payload, key)` 例程：滑块 data 用 `[轨迹包, item1]`，arg 用 `[CertifyId, 16hex]`。

16hex 值（round-4：arg 输入 `4ixr1xi1ha2icl8v`、slide 输入 `3e627e1b4c63f913`）不在 InitCaptchaV2 响应里、非 TrackList 的 si（那是屏幕信息）→ 疑为 sg 启动时生成的会话随机值，需最终联调确认服务端是否校验其关联性。

### 全链路本地实现差距清单（按执行顺序）

1. GET search-pc → 挑战页 HTML：无门槛；renderData 提取 token/traceid/userId/userUserId/sceneId ✓
2. InitCaptchaV2：Signature ✅ / DeviceData ✅ / UserUserId/UserId（renderData）✅ / UserCertifyId=acw_tc 前缀 ✅
3. 响应处理：DeviceConfig 解密 ✅（AES key 87f879f135f27da7）；StaticPath 决定 sg 版本 ⚠️ 每版需重提字节码（提取流程已脚本化）
4. deviceToken：主体 ✅（AES-CBC(session_key, IV 0123456789ABCDEF, 指纹明文762B)）；❌ **MD5 尾段输入**（feilin `O()` 内）+ ⚠️ 明文中 3 个子密文段（`40rJ+…`/`jwqaM…`/`g82QNBfC…`）；解决路径：feilin 的 `o`/`O` 是控制流拍平（非 VM），同样可扣出来本地跑（feilin000 col 215118 起）
5. 滑块 data：✅ VM 重放；TrackList 合成 = 工程项（格式完整已知，有已通过的轨迹模板，时间戳需实时生成）；`arg` ✅；item1/16hex 来源 ⚠️
6. VerifyCaptchaV2 通过 → u_atoken（renderData）+ u_asig（acw_tc 前 30 位）拼 URL ✅
7. **decode__1048** ❌ 最大缺口：WAF 内联脚本（源码已存 web-assets），路径 A=整段脚本放 Node 跑 + hook location 赋值直接拿 URL（最快）；路径 B=AST 还原
8. 最终 GET search-pc?api_key=51job&decode__1048=… → 业务 JSON ✅
9. Cookie：acw_tc/_c_WBKFRo 服务端 ✓；ssxmod_itna 等由 JS 写入 ⚠️ 待确认服务端是否校验

结论：算法侧已 90% 落地（Signature/DeviceData/设备ID/滑块data/arg 全部 reproduced）。剩余 = decode__1048（1 项中等工作量）+ feilin 侧 deviceToken 尾段与子密文段（1 项中等工作量）+ 若干待联调确认项（16hex、JS cookie、轨迹风控通过率）。

## 2026-08-29 deviceToken 完全破解（T001 链路算法侧收口）

追踪 feilin 加密函数 `o(mode, key, data)`（col 215118）发现：**它就是通用 AES-128-CBC(key, IV="0123456789ABCDEF")**——mode 20=加密、19=解密，与 sg VM 无关、无需提取 feilin 代码，openssl/python 直接复现：

- `sub1 = AES(session_key, PKCS7("0fd29822"))` → `40rJ+o8KjWbfmB495UfDjw==` byte-exact ✓（`0fd29822` = feilin 随机 8hex）
- deviceToken cipher 重加密 byte-exact ✓
- **MD5 尾段破解**：`md5("WEB#<seg1>#<cipher_b64>#0#" + "daye,raolewoba!")` —— 固定盐 `daye,raolewoba!`（阿里工程师彩蛋），对 round-2 向量计算完全一致 ✓
- `O()` 只是 btoa 包装；`g(t)` = Math.random 字母表随机串生成器 → sub2/sub3（42~43 字符）、16hex、8hex、uuid 全是**客户端随机值**，本地生成即可
- 佐证：feilin 的 mini-bundle 提取（368 模块重放）走到一半即被上述结论替代，不再需要

**deviceToken 生成配方**（`devicetoken_replay/devicetoken.py`，含自检，两项均 True）：

```
seg1   = "WEB#" + appKey(常量) + "-h-" + ts + "-" + uuid4
cipher = AES-128-CBC(session_key, IV="0123456789ABCDEF", PKCS7(指纹明文))
md5    = md5("WEB#" + seg1 + "#" + cipher_b64 + "#0#" + "daye,raolewoba!")
token  = base64("WEB#" + seg1 + "#" + cipher_b64 + "#0#" + md5)
```

**T001 闭环最终状态**：Signature ✅ / DeviceData ✅ / 设备ID ✅ / DeviceConfig 解密 ✅ / deviceToken ✅（全配方）/ arg ✅（VM）/ 滑块 data ✅（VM）。
剩余工程项：轨迹合成与通过率调参、track blob 的 32hex 前缀（同为 VM 产物 call_334789，重放机制同 data）、16hex 等随机值的服务端验证、静态指纹字段的更新策略。

## 2026-08-29 Round6（两次滑动 F001+T001 同会话向量）+ feilin 沙箱还原：payload 字段语义全部定死

TRACE_DIR：`traces/firefox-trace-51job-round6-t001-diff-20260829`（同 round5 配置 + http_raw + DeviceData 字段；degraded=3 均为 http.raw_chunk 截断，value_capture_complete=true）。

### 跨轮 Verify 向量总表（浏览器真实样本）

| 轮次 | 尝试 | 结果 | GatherCost | data 长度 | dt cipher | dt payload |
|---|---|---|---|---|---|---|
| r1 (8/28) | 首次 | T001 | 0 | 416 | 876b64 | 649B |
| r2 | 首次 | **T001** | 0 | 648 | 1024b64 | **762B 首次形态** |
| r3 | — | 无响应 | — | 428 | 896b64 | — |
| r4 | 首次 | F001 | 0 | 600 | 1024b64 | 762B 首次形态 |
| r4 | 第二次 | T001 | 0 | 1292 | 856b64 | 630B 精简形态 |
| r5 | 第二次 | T001 | 4003 | 1548 | 876b64 | 649B 重试形态 |
| r6 | 首次 | F001 | 0 | 572 | 1024b64 | 764B 首次形态 |
| r6 | 第二次 | T001 | 0 | 1616 | 856b64 | 630B 精简形态 |

### 关键结论（浏览器侧 F001/T001 对比，r4/r6 两轮同会话成对向量）

1. **首次尝试形态（111 字段）跨会话完全相同**：r2 首过与 r6-F001 的 payload 仅 8 个动态字段
   不同（21/43/71/72/73/74/77/87），103 个静态字段逐字节一致 → 已存
   `device_upload/dt_plain_r2_first.txt` 作模板。
2. **f[43] 时序标记语义破解**（AliyunCaptcha `logs` 数组 push，`20/21/22/23`=feilin 加载、
   `30`=init、`40/41/70`=采集）：**首次尝试 90-94 全 NaN，重试后填充**（r2 首过 = 11 段 NaN，
   r5/r6 T001 重试 = 93/94 filled）。旧记录"9 段/11 段协议演进"实为截断显示误导。
3. **f[68]**：首次='1'，重试='0'。**f[45]/f[53](URL)/f[64](UA)/f[80](appVersion)/f[110]='[]'**
   仅首次尝试填充。f[77] 后缀（r6 T001 的 `-e9ce1`）= 客户端随机 uuid 前 5 位（attempt id，非关键）。
4. **r6 浏览器 F001 = 行为不通过**：失败滑动 TrackList 9 个采样点/10.3s，通过 106 点/3.0s
   （与 r4 结论一致：12 点/3.7s 失败，85 点/1.8s 通过）。dt payload 形态不决定 F001/T001。
5. GatherCost 浏览器多数为 0（r1/r2/r4/r6），r5 为 4003 —— 两者都被接受。

### feilin 沙箱还原（Node vm + 浏览器桩，`ast_feilin/`）

feilin webpack bundle（357 模块）在 Node vm 中跑通（桩：window Proxy + document/navigator/webgl +
`__ALIYUN_CRYPT=crypto-js` + 自动补桩循环）。模块 9020 = 指纹 API，getter 全部命中并映射：

- `getSdkVersion()='W.10054'`(f0)、`getOsCpu`(f5)、`getBrowser/getBrowserVersion`(f6/f7)、
  `getOS/getOSVersion`(f36/f37)、`getScreenResolution()='1117*1728'`(f47)、`getColorDepth`(f24/25)、
  `getClientType()='desktop'`(f75)、`getWebglReportHash`(f78)、`getIP`(f42)、
  `getLocalStorageUid/getCookieUid`、`getTouchSupport`、`getCombatData`(payload 本体，
  需 initFeiLin(config,cb) 后填充；config 即 AliyunCaptcha 的 Br 配置对象)
- feilin 依赖页面预置 `window.__ALIYUN_CRYPT`（外部注入的 crypto-js：HmacSHA1/MD5/enc）
- Log2/Log3 明文结构本轮完全解开（见 device_upload/README.md），服务器接受全新生成 Data

### 客户端对齐（本轮落地）

1. **dt payload 模板切换**：r5 重试形态（127 字段）→ r2 首过形态（111 字段，
   `device_upload/dt_plain_r2_first.txt`）。byte-exact 回归：给定 r2 动态值重建 = 捕获明文逐字节一致 PASS。
2. f[43] 生成改回首次尝试形态（11 段、90-94 NaN），f[87]=seg1 ts+1~3ms，f[77]=certifyId。
3. **传输层真正接入 curl_cffi firefox**（此前 captcha_post 实际仍走 urllib）：`ali_client._http_post`
   统一出口，HTTP/2 + TLS 指纹 + 浏览器头序（r6 http_raw 对照）；device 上报同走该出口。

### 当前 F001 状态

内容层全部对齐（Init/Log2/Log3 全部被服务器接受，payload 与真实首次尝试 byte-exact 同构，
传输层 firefox 指纹）后 Verify 仍 F001 → **剩余嫌疑集中在行为轨迹评分本身**（合成轨迹 vs 真人
轨迹的统计特征）或未观测到的会话级信号。下一个决定性实验（需人工）：Firefox 里人工过滑块 + console
注入客户端生成的 CaptchaVerifyParam 发 VerifyCaptchaV2 —— T001 则确认传输/会话指纹，F001 则确认轨迹评分。

## 2026-08-30 Round9（6pm feilin002）采集 + 动态化整改完成

- 6pm 版本 **feilin002.3ef8801a**（DeviceConfig chunk[3] 动态下发）；payload 127 字段形态与 6am 一致；
  静态差异仅 IP（**IPv6**，来自 chunk[8]）+ token 对再轮换。
- 客户端动态化：device_ip=chunk[8]（服务端实测 IP，含 IPv6）；token=本地生成持久化（等价浏览器
  "一次生成跨会话复用"；feilin 重载 2 次 token 不变、不在 localStorage → 运行时确定性推导，
  推导函数 rV/eT 待沙箱破解）；f52 随机位 [0:5]/[25:30] 按实测分布生成。
- 独立客户端用 r9 token + r9 形态重跑仍 F001 → 唯一未隔离变量 = **data（轨迹内容）**。
- **dataonly 实验新流程**（绕开"成功后必须刷新"）：第 1 次滑动**故意失败** → SDK 原地重新 Init
  （hook 捕获 → /session 生成新 certifyId 的 CVP+data）→ 等 "[inj] page-session cvp ready" →
  第 2 次滑动即被 dataonly 替换（同一 certifyId，hook 存活）。console.js 已更新。

## 2026-08-31 终局：swapfull T001 —— 根因 = Init 请求的传输指纹

**决定性实验链（全部真实请求）**：

| Init 谁发 | deviceToken | data | verify 传输 | 结果 |
|---|---|---|---|---|
| 浏览器 | 浏览器 | 浏览器 | curl_cffi（drop 重放） | **T001** |
| 浏览器 | 浏览器 | 我方 | curl_cffi（swapdata） | **T001** |
| 浏览器 | **我方** | **我方** | curl_cffi（swapfull） | **T001** ← 终局 |
| curl_cffi | 我方 | 我方 | 任意 | F001 |

**结论**：
1. **我方内容 100% 正确**：deviceToken（payload 127 字段 + 当前周期 token + sub1/timing）、
   data（track.py 轨迹 + R2 前缀 + R1 加密）、arg、UploadLog、Log2/Log3、签名——全部被服务器接受。
2. **唯一缺陷 = Init 请求的传输指纹**：curl_cffi 发出的 Init（或其前面的挑战页 GET）被风控在
   会话诞生时刻标记 → 该 certifyId 之后所有 verify 必 F001。verify 用什么传输、内容多正确都无关。
3. **token 对（f71/f73）随周期轮换**（与 session_key 同步，约数小时/6点），周期内恒定：
   已验证 swapfull 用当期 token 通过。独立客户端需要动态 token 来源（feilin 沙箱破解推导，
   或周期性从浏览器会话提取）。
4. 附带发现：会话无短时效（Init 后 4 分钟+span 256s 仍 T001）；span 17~28s 之外也接受；
   F008 = 同 body 重放检测。

**可用方案**：混合模式——真浏览器（或 CDP 驱动的 Firefox）完成挑战页 GET + InitCaptchaV2，
取得 certifyId/DeviceConfig 后，deviceToken/data/UploadLog/Log2/Log3/Verify 全部走客户端
（swapfull 已验证此路径 T001）。纯客户端路线需先破 feilin 的 token 推导（rV/eT）。

**产物**：`swapfull_replay.py`（steal 捕获体 + trace Init 会话 → 全我方内容 → 重放，一键脚本）。

## 2026-08-31 swapdata T001 + 根因假设收敛到 Init 时刻

swapdata（浏览器 deviceToken + 我方 data + 我方传输）= **T001** → **我方 data 完全正确**
（track.py + 时间线 + R2/R1/arg 全链）。四个实验拼出的规律：

| Init 谁发 | 内容 | verify 传输 | 结果 |
|---|---|---|---|
| 浏览器 | 浏览器 | curl_cffi | T001 |
| 浏览器 | data=我方 | curl_cffi | T001 |
| curl_cffi | 全我方 | 浏览器 | F001 |
| curl_cffi | 全我方 | curl_cffi | F001 |

→ **凡是 curl_cffi 发 Init 的会话必 F001**（内容/verify 传输无关）→ 服务端在 Init 请求时刻
就按传输指纹定会话风险级。验证实验 **swapfull**（浏览器 Init + 全我方内容）已实现：
DevTools → Sources → XHR 断点加 `InitCaptchaV2` → 刷新页面（停在 Init）→ 粘贴 console.js →
F8 放行（hook 捕获 Init 响应）→ 滑动（bridge 现场生成全我方 CVP：deviceToken+data，重签重放）。

## 2026-08-31 传输门实验 **T001** —— 传输层与 Init/verify 绑定全部排除

drop 实验（console 截获浏览器原生 verify，bridge 用 curl_cffi 原样重放）：
- 第 1 次重放 = **T001**（浏览器 Init 会话 + 浏览器 deviceToken + 浏览器 data + 我方传输）
- 第 2-4 次重放同 body = F008（重放检测，符合预期）

→ curl_cffi TLS/HTTP2 指纹合法、服务端不绑定 Init/verify 传输一致性。
独立客户端 F001 的根因收敛到**我方生成内容的两个部件**：deviceToken 或 data。

**swapdata 隔离实验就绪**（console.js 支持 drop/swapdata 模式；bridge 重放时对
被替换的 CaptchaVerifyParam 重新 HMAC 签名——KEY_SECRET 已知，重签合法）：
- 浏览器 deviceToken + 我方 data → **T001**：data 没问题 → 攻 deviceToken（sub1 推导、token 周期）
- → **F001**：data 打包/内容问题（时间线、位图、压缩层）

## 2026-08-30 真迹重放 F001 → 传输门实验（drop 模式，待执行）

**关键实验结果：r9 真迹重放仍 F001**——把浏览器刚通过 T001 的原始 TrackList（时间平移 + 新 arg
+ 新签名会话）用独立客户端发送，依然被拒。轨迹内容彻底排除。

剩余唯一未测变量 = **传输层**。新实验（console.js 新增 drop 模式，现为默认）：
滑动时 hook 截获浏览器原生 verify 请求体（**不发送**，certifyId 保持未消费）→ 交 bridge 用
curl_cffi 原样重放同一字节内容 → 同 certifyId 同内容仅传输层不同：
- 重放 **T001** → 客户端全部内容正确，独立客户端 F001 = curl_cffi TLS/HTTP2 指纹被识别
- 重放 **F001** → 同内容同会话换传输即挂 → 服务端绑定 Init 传输指纹，curl_cffi 指纹不足

## 2026-08-30 Round9 分析 + 客户端补齐（仍 F001，转入真 dataonly 实验）

Round9 两次原生 T001 证据消化：
- **R1 data 加密离线 byte-exact 复现**（r9 真输入 blob + '3e627e1b4c63f913' → 浏览器密文逐字节一致）
  —— data 加密层确认无误；R2 前缀含 16 次 Math.random（服务端不可重算，无需对齐）。
- **UploadLog 缺失补上**：浏览器流程 Init→UploadLog→Log2→Log3→Verify，客户端此前漏了
  UploadLog（明文 JSON log：sId/pfx/mInit{t,s,msg,rt}/hst/cId/ip/js/rt），已实现并接入（Success）。
- 轨迹时间线对齐：TrackStartTime≈页面加载（init 前 0-1.5s）、VerifyTime≈提交时刻、
  startTime 数字、si=125、span 17-28s；轨迹密度按 r9 真样本校准（mp≈108/mm≈30）。
- si 第 8 位每会话变化（125/0.680272）→ 动态环境值；token 推导（rV/eT）仍待沙箱破解。

独立客户端（全部上述对齐后）**仍 F001** → 剩余嫌疑 = 轨迹行为评分细节或 deviceToken 内
不可见绑定。**转入 dataonly 实验**：console.js 新增 fail 模式（程序化垃圾 CVP 必失败），
触发 SDK 原地重新 Init（同 certifyId 周期），hook 捕获后 /session 生成配套 CVP →
第 2 次滑动 dataonly（SDK deviceToken + 我方 data）或 full（全我方）。

## 2026-08-30 18:00 再轮换 → Round9 轻量采集（待执行）

- DeviceConfig 全字段解密：chunk[0]=session_key、chunk[2]=seg1、**chunk[3]=feilin 版本路径**
  （6am 已从 feilin000→feilin001.874f974c…）、**chunk[8]=服务端实测 IP（f[42] 来源）**、chunk[9]='0'。
- token(f71/f73)：feilin 运行时确定性推导（feilin 重载 2 次 token 不变、不在 localStorage），
  推导函数 rV/eT/o.h —— Round9 补抓推导链参数。
- **客户端动态化整改**（用户要求"不该固定的不固定"）：IP→DeviceConfig chunk[8]；
  token→本地首次生成持久化（浏览器等价行为，待推导链破解后改为真推导）；
  Log2 f52→随机位分布生成（[0:5]/[25:30] 随机，其余固定）；session_key/seg1 本来就动态。
- **Round9 配置轻量化**（round8 DOM=all+depth4 卡死）：DOM 关、depth=2、无 http_raw/script-events，
  保留 XHR/fetch body 全量 + 值存储 + boundary(captcha-frontend)。

## 2026-08-30 Round8 采集完成：6 点轮换确认 + F001 根因定位到 deviceToken 形态过期

round8 trace（两次滑动均 SDK 原生 **T001**）给出 6 点后最新真样本：

1. **feilin 6 点轮换实锤**：payload 模板从 111 字段（r2 形态）变为 **127 字段精简+标记混合形态**
   （f68='0'、f44='true'、f49='0'、f76='false'、f89/f90='0'、f91='true'；f88 位图变位；
   新增 f52=49 字符 id）。6 点前的 111 字段形态现在被 F001 拒绝 —— 实验 A 两次 F001 的根因。
2. **新形态动态字段仅 6 处**：f21 = b64(8B 随机)（不再是 AES，dt/Log2 共用）、f43（41<70<71<80<81
   链式 + 93/94=距 Init 36~49s）、f72/f74、f77、f87=seg1ts+2/3ms。
3. **token 对（f71/f73）跨会话恒定**（同 session_key 周期），dt/Log2 共用 → 已按 r8 常量内置，
   **随 session_key 周期轮换**（约 6 点/不定期，与 session_key 同步换）——这是下一嫌疑：
   session_key 已轮换（f2cf477a…）而 token 常量还是上期的。
4. **Log2 模板同步更新**（log2_plain_r8.txt）：与 r5 模板差异仅 f42 IP + 新增 f52；md5 公式、
   AES/IV、GatherCost 机制全部不变。
5. **track.py 已接入** bridge/verify_run（此前一直在重放 r5 静态模板）；si 按 r6 实测本机指纹对齐。

已落地：payload_util/device_upload/verify_run/bridge 全部切到 r8 形态（byte-exact 回归 PASS），
独立客户端 E2E 仍 F001 → **下一嫌疑：token 周期绑定**。console.js 已改为
"第1次滑动捕获 certifyId 后台预生成 data → 第2次滑动 dataonly 替换"（不再依赖 cookie）。

## 2026-08-30 实验 A 结果 ×2（F001）+ Round8 实验 B 就绪

实验 A（浏览器传输 + 客户端内容，两次：静态模板轨迹 / track.py 轨迹）均 **F001**。
结合独立客户端（客户端传输+客户端内容）也 F001 → 传输/会话指纹嫌疑大幅下降，
剩两个待切变量，由 Round8 实验 B（dataonly）切开：

- **dataonly**：SDK 自己的 deviceToken（浏览器原生会话）+ 我方 data —— 
  **T001** → F001 原因在我方 deviceToken/payload（6 点后 feilin 换版导致模板过期？）；
  **F001**（同会话基线 T001）→ 我方 data/轨迹内容问题。
- 工具已就绪：console.js 启动时自动从 cookie 读 certifyId 调 bridge `/prepare` 预生成 data
  （不依赖页面 Init 时序），滑动时同步替换。bridge 三端点 /session /prepare /fresh 均实测通过。

轨迹修正：verify_run/bridge 此前一直重放 r5 静态模板（同形状重放 + 131ms 平均间隔 vs 真人 22ms），
已切换到 track.py 生成器（真人校准），si 按 r6 实测本机指纹对齐。

## 2026-08-29 Round7 实验就绪：传输/内容 A/B 注入实验（待执行）

工具（`inject/`，HTTP 自测已通过：/fresh 全链路 challenge→Init→VM 生成→签名请求体 ok）：
- `inject/bridge_server.py`：127.0.0.1:8799。`POST /session`（页面会话生成 CVP）、
  `GET /fresh`（**全新客户端会话**：fetch_challenge→Init→deviceToken→data→arg→签好名的
  VerifyCaptchaV2 请求体，浏览器只当传输层）
- `inject/console.js`：`await window.__INJ_RUN()`（实验 A 主判据）+ XHR hook（实验 B：
  替换滑块 verify 的 CaptchaVerifyParam，full/dataonly 两模式）
- `inject/README.md`：完整操作步骤

判定：实验 A **T001** → 独立客户端 F001 = 传输/会话指纹问题；**F001** → 轨迹内容/行为评分问题
（同内容浏览器传输也不过）。

## 制品索引

- XHR 请求体：`values/xhr_req_body_29969_1..6.txt`（InitCaptchaV2/UploadLog/Log2/Log3/VerifyCaptchaV2/Log2，含 SHA-256）
- 验证码响应体：`values/d1270606...txt`（init）、`values/484490a0...txt`（verify）、其余 upload/device 响应
- WAF 挑战页 HTML：`web-assets/html/we.51job.com__api__job__search-pc__q_9450836fa6.html`
- psk8uqfi 混淆脚本：`scripts/7fd1333139ee29b0d56ea6a9e9f9cc02c5977af8fae0ca061a9297aed74d407a.js`
- 值制品：`values/`（30MB，含 decode__ 串、u_atoken/u_asig URL 的完整 SHA-256 记录）

## 2026-08-29 动态全链路客户端建成（真实服务器联调）

`dynamic_client/`：ali_client.py（签名/DeviceData/请求）、extract_sg_vm.py（JSVMP 自动提取）、
payload_util.py（111 字段指纹明文）、verify_run.py（端到端编排）、sg_vm_current.js（当次版本 VM）。

实测（全部真实请求）：
- [1] GET search-pc → acw_tc + renderData ✓
- [2] InitCaptchaV2 → **Success:true**（动态 Signature + DeviceData 被服务器接受）✓
- [3] DeviceConfig 解密 → session_key + seg1（服务端代发 deviceToken 前段）✓
- [4] StaticPath 下发 **sg.078**（第 6 个版本）→ 自动提取 R1=1498/F1=135、R2=16838/F2=291 一次成功 ✓
- [5] deviceToken 动态生成（1528 字符）✓
- [6] arg/prefix/data 全部经本地 VM 生成 ✓
- [7] VerifyCaptchaV2 → **Code:"Success"**（请求结构完全合法）+ VerifyCode **F017**（验证未过）

结论：密码学层全部被服务器接受，无签名/设备/参数错误。剩余 = F017 语义校验。
已查明：16hex(item1) 不在 CaptchaVerifyParam/deviceToken 中传输、改动 item1 会改变全部输出
→ 加密 VM 输出头部携带其传输形式（服务端可解），随机生成即符合浏览器行为。
F017 候选原因（下一步实验矩阵）：轨迹时间一致性（TrackStartTime/VerifyTime/mp 区间）、
track blob 打包细节（zlib 级别/字段顺序）、指纹 payload 陈旧字段、arg 输入 16hex 长度/字母表。
实验方法：固定其他项单变量替换，观察 F 码变化（F001=行为不通过=结构已对；F017→其他 F 码=定位到具体项）。

## 2026-08-29 动态客户端 F017→F001 突破 + 当前状态

**F017 已修复**（参数计算不合法 → 参数全部合法）。关键修复项：
1. `data` 加密的 item1 = **常量 `3e627e1b4c63f913`**（r4/r5 跨版本一致，非随机值）——F017 主因
2. VM 提取器修复：按内容分类配对（数字数组=字节码/字符串数组=常量），按版本 hash 缓存
3. `TrackList.startTime` 必须与 `TrackStartTime` 一致（服务端校验时间一致性）

**当前卡点 F001**（疑似攻击请求，风险策略不通过）。已排除/已对齐：
- 轨迹：r5-T001 原样重放、track.py 校准生成器（10 条人工 T001 校准）、拖距收窄 326-342px — 均 F001
- 传输：curl_cffi firefox 指纹（pythonProject 环境 0.13.0）、逐字节对齐浏览器头、Idempotency-Key — 均 F001
- payload：时间戳/certifyId/时序统计(43)/IP(183.192.134.245 实测一致)/子密文字段 — 均按浏览器配方
- 时序：Init→Verify 20s 延迟 — F001
- **关键实验**：round-5 浏览器 T001 轨迹 20 分钟后原样重放 → 仍 F001（当时它刚通过）
  → F001 不是轨迹内容本身，而是会话级/传输级画像被风险引擎标记

已验证的三段 VM byte-exact（同版本+同输入）：
- R1 arg：sg.079 重放 round-4 arg ✓（算法跨版本稳定，环境无关）
- R1 data：sg.065 重放 round-4 data ✓
- R2 md5：**不匹配** — R2 执行只触达标准全局（String.fromCharCode 等），无额外 window 读取，
  但输出随 window 对象形状变化（globalThis vs proxy → 不同 md5）。
  服务端无法重算环境相关的 md5 → 该前缀大概率不参与服务端校验，非 F001 主因。

F001 下一步候选（按性价比）：
1. 大批量轨迹变体扫描（同一会话多次 Init+Verify，扫行为特征空间）
2. 对照实验：Firefox 里用 console 手动注入我们生成的 CaptchaVerifyParam 发 VerifyCaptchaV2
   （隔离传输层因素——若 T001 则确认传输指纹问题，若 F001 则确认 data 内容问题）
3. 检查 InitCaptchaV2 请求本身的风险信号（我们 header 顺序/HTTP2 细节与 Firefox 的差异）

## 2026-08-29 F001 深挖：协议演进 + GatherCost + 设备上报缺口

round-5 trace 对比发现两个协议演进点：
1. **payload 结构演进**：111 字段(8/28) → 127 字段(8/29)。UA/URL 字段变空、新增 17 个尾部字段、
   [49]='0'、[68]='0'、[76]='false'、[91]='true'。已切换到 r5 127 字段模板（payload_util.py）。
2. **deviceToken 第 4 段 = GatherCost**（feilin 采集耗时）：r2 为 `#0`，r5 T001 为 `#4003`。
   md5 输入 = `WEB#seg1#cipher#<GatherCost>#daye,raolewoba!`（盐不变，段值进哈希）。
   已改客户端：随机 3500-4800。→ 仍 F001

**R2 md5 澄清**：插桩证实 R2 执行内嵌 16 次 Math.random（trace js.random 可精确回放但输出仍不同），
md5 为客户端自检随机值，服务端无法复算 → 不参与校验，非 F001 主因。
三段 VM byte-exact 状态：R1 arg ✓ / R1 data ✓ / R2 md5 ✗（环境随机，无需对齐）。

**下一个已定位缺口：设备上报链路缺失**。浏览器流程 Init→feilin 采集→device.captcha-open 上传
（Log2/Log3，Data=br([appKey,WEB,f,APP_VERSION,"CLOUD"])，AADUANE_ID=DuaneAprqkYsF3nt1yjK29Bf，
签名 KEY_SECRET=DuanemHmyeE6LXCC46sJEDUw5DTlSZ）→Verify。客户端目前直接 Init→Verify，无设备上报。
F001=风险策略不通过，可能正因服务端检查"该 certifyId 会话是否有设备上报记录"。
下一步：解密 r2 的 Log2 Data 学格式（values/xhr_req_body_29969_3.txt），实现 device upload。

环境工具：pythonProject conda 环境（curl_cffi 0.13.0，firefox 指纹）；
运行方式 `cd dynamic_client && /opt/miniconda3/envs/pythonProject/bin/python verify_run.py`。

## 2026-08-29 设备上报（Log2/Log3）配方已捕获（待接入）

Log2 的 Data 也是 feilin `o(20, key, plaintext)` = AES-128-CBC(固定 IV)：
- key = `a549a55c60a39aa0`（round-2 实测；16hex，疑为 DeviceConfig 某 chunk 的 b64 明文——待定位）
- 明文 1649B：`sh87bd...#W#<inner>#...`（DeviceData 同族结构，内含需刷新的时间戳）
- 请求：POST device.captcha-open.aliyuncs.com，AADUANE_ID=DuaneAprqkYsF3nt1yjK29Bf，
  Version=2020-10-15，Action=Log2/Log3，签名 KEY_SECRET=DuanemHmyeE6LXCC46sJEDUw5DTlSZ
- 制品：dynamic_client/device_upload/{log2_key.txt, log2_plain.txt, README.md}
- Log3 与 Log2 同 key 同结构（Data 2576B，内容更多）

## 2026-08-29 设备上报配方完全破解 + 已接入（Log2/Log3 ResultObject:true）

**结构全部解开**（r2 body_4/5/6 + r5 body_3/4 交叉验证）：

- `LOG2_KEY = a549a55c60a39aa0` **跨会话稳定**（r2/r5 两轮实测都能解开），只是外层
  Data 包装 key；**所有内层密文都用 session_key**（DeviceConfig 解出）。
- 请求参数（无 Timestamp）：`AaduaneId, Version=2020-10-15, SignatureMethod,
  SignatureVersion, Format, Action, Data, SignatureNonce, Signature`。
- **Log2 明文** = `appKey#W#b64(AES(sk,"W.10054#saf-captcha-waf#<sceneId>"))#W20220202#CLOUD#<GatherCost>#501#b64(seg1#大密文#sub_a#sub_b##sub_ts)`
  - seg1 = DeviceConfig chunks[2]（服务端代发，与 deviceToken 共用，不带 WEB# 前缀）
  - 大密文 = AES(sk, **127 字段指纹遥测**，732B，与 deviceToken payload 同模板不同变体：
    带平台/屏幕/IP/时序统计，不带 URL/UA/certifyId）
  - sub_a = AES(sk,"saf-captcha-waf")，sub_b = AES(sk,"W.10054")（会话内常量），
    sub_ts = AES(sk, 13位时间戳)
  - r5 实测 Log2 seg5 = 4003 = deviceToken 第 4 段 GatherCost（同一值）
- **Log3 明文** = `appKey#W#<同scene>#W20220202#CLOUD#<seq>#b64("511#<entry1>-504#<entry2>")`
  - entry = `b64(seg1#b64(AES(sk,内容))#sub_a#sub_b##sub_ts)`
  - entry1 内容 = 70B 特征位图 `0#0#...#1#1#0#01111100...`；entry2 内容 = 行为 JSON
    （mousemove 50 点 + pointerEvent + clientType + startTime/timestamp）
- **跨请求共享的动态值**（浏览器实测）：sub1 = AES(sk, uuid32 最后 8 hex)（uuid 来自服务端
  seg1）；40 字符 token 对在 deviceToken payload 与 Log2 payload 间完全相同；payload f[87]
  = seg1 ts + 1ms。

**实现与自检**（`dynamic_client/device_upload.py`）：

- 字节级回归：r2 捕获明文重加密 = 捕获 Data **PASS**；
- r5 payload 重建（真实动态值代入）与捕获明文逐字段一致，仅 f43 时序按设计随机化 **PASS**；
- 全新生成 → 解密回读结构断言 **PASS**。模板制品：`device_upload/{log2_plain_r5.txt,
  log3_bitmap.txt, log3_behavior.json}`（行为 JSON 时间整体平移）。

**端到端联调（真实服务器）**：sg 版本已滚动到 **sg.096**（VM 提取一次成功）；
Init → Log2（`ResultObject:true`）→ Log3（`ResultObject:true`）→ Verify：
**服务器接受全新 Data**（加密/签名/结构全部合法），VerifyCode 仍 **F001**。
→ "会话缺设备上报"假设已排除，F001 定位收窄到行为/环境画像本身。

F001 剩余候选（按性价比）：
1. 浏览器对照实验（需人工配合）：Firefox 里人工过滑块，console 注入我们生成的
   CaptchaVerifyParam 发 VerifyCaptchaV2 —— T001 则确认传输层指纹问题，F001 则确认
   data/deviceToken 内容问题。
2. 同会话内用浏览器真实轨迹的 TrackList 明文走本地 VM 生成 data 后回放（隔离 VM 生成层）。
3. deviceToken 长度差异待查：浏览器 r5 = 1528 字符，客户端 = 1308（dt 模板 649B 疑为
   采集截断版，浏览器实采 payload 约 1100B）——服务端可能校验 payload 完整性。
