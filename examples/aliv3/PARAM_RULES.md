# aliv3 参数生成规则（51xf.cn 阿里云验证码 · FeiLin 1.5.1 / dynamicJS pe.05x）

> 依据 round1（pe.054）/ round2（pe.059）两轮 Firefox Trace 固定向量逐字节验证。
> 所有 AES 均为 AES-128-CBC + PKCS7，**固定 IV = `0123456789ABCDEF`**。
> 复现脚本：`../restore_params.py`（pythonProject 环境）。

## 0. 接口链路

| # | URL | Action | 说明 |
|---|-----|--------|------|
| 1 | `POST https://<prefix>.captcha-open.aliyuncs.com/` | InitCaptcha | 前缀=1oa2ns，响应给 CertifyId/DeviceConfig/StaticPath |
| 2 | `POST https://upload.captcha-open.aliyuncs.com/` | UploadLog | 埋点，明文 log JSON + 签名 |
| 3 | `POST https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/` | Log2 / Log3 | FeiLin 设备风控；**实测 Log3 可不发** |
| — | （无网络请求）`captchaVerifyCallback(captchaVerifyParam)` | — | 最终交付物：`{sceneId, certifyId, deviceToken, data}` |

## 1. 公共签名参数（所有 Action 请求共用）

| 参数 | 生成规则 | 验证 |
|------|---------|------|
| `AaduaneId` | captcha-open 侧=`111jdk439dJJIjd023823201`；cloudauth 侧=`DuaneAprqkYsF3nt1yjK29Bf`。均为 gr() 派生常量 | ✅ |
| `SignatureMethod/Version, Format, Version` | `HMAC-SHA1` / `1.0` / `JSON` / `2023-03-05`(open)·`2020-10-15`(cloudauth) | ✅ |
| `Timestamp` | UTC ISO8601 秒级 `YYYY-MM-DDTHH:MM:SSZ` | ✅ |
| `SignatureNonce` | **32 次 `Math.random`**，每位 `floor(r*16)` 十六进制；第 16 位(0起)补丁 `n&3\|8`；拼 `8-4-4-4-12` | ✅ 用 trace 里 32 个随机数精确重建 |
| `Signature` | `Base64(HMAC-SHA1(StringToSign, SECRET + "&"))`；`StringToSign = "POST&%2F&" + pct(排序后 k=v&... 全量 pct)`；pct 同阿里 RPC（`-_.~` 不转义） | ✅ 4/4 向量 |

HMAC secret（gr 派生）：
- captcha-open：`222aiJodos2938JDdosko2djd82sf0`
- cloudauth：`DuanemHmyeE6LXCC46sJEDUw5DTlSZ`

请求头 `Idempotency-Key`：`"<纯数字19位>"`（带引号）。

## 2. gr()：母密钥派生（所有常量的来源）

```python
AES_CBC_decrypt(key='FqJB6iRNVYdEGpwb', iv='0123456789ABCDEF', data=b64decode(内嵌密文))
```

SDK/sg 运行时以 `gr(母密钥, 内嵌b64密文)` 解出全部常量（round1/round2 实测一致）：

| 派生值 | 用途 |
|--------|------|
| `45f8ac1e1de14397` | DeviceData 外层 AES key |
| `c175a358550d02e2` | DeviceData 内层场景串 AES key |
| `87f879f135f27da7` | DeviceConfig（服务端下发）解密 key |
| `c752c71963b42578` | deviceToken part2 AES key（=b64 解 `DeviceConfig` 解密结果第 1 段） |
| `a549a55c60a39aa0` | Log2 `Data` AES key |
| `111jdk439dJJIjd023823201` | AaduaneId (open) |
| `DuaneAprqkYsF3nt1yjK29Bf` | AaduaneId (cloudauth) |
| `222aiJodos2938JDdosko2djd82sf0` | HMAC secret (open) |
| `DuanemHmyeE6LXCC46sJEDUw5DTlSZ` | HMAC secret (cloudauth) |

⚠️ 这些密文的解码入口 `iy/_.M(iD,...)` 位于 **sg（pe.05x）VMP 内**，sg 每天换版本 → 常量需动态提取（见 `dynamic_client/extract_sg_keys.py`）。

## 3. DeviceData（InitCaptcha）

```
明文  = "<appKey>#W#" + b64(AES(c175a358550d02e2, 配置串)) + "#W20220202#CLOUD#"
DeviceData = b64(AES(45f8ac1e1de14397, 明文))
```

- **appKey = `ab034ec0643f91399eb33e062dc7fae1`**：即所谓"固定设备指纹 ID"。trace 证实它是宿主页面初始化时传入的 `appKey` 配置常量（`7412/t.exports ['appKey', ...]`），**不是运行时计算的指纹**，跨会话不变。
- round2 实测配置串：`W.10001.c#saf-captcha#1bn1l0rb#captcha-normal#1oa2ns#cn`
  （版本号#appName#sceneId#场景类型#prefix#语言）
- ✅ 192 字符逐字节复现。

## 4. deviceToken（captchaVerifyCallback 最终参数之一）

```
原始 = "WEB#" + "<appKey>-h-<Init时刻毫秒>-<每会话随机32hex>"
     + "#" + part2
     + "#3156"
校验 = MD5(原始 + "#daye,raolewoba!")        ← 固定盐（写死于 SDK）
deviceToken = b64(原始 + "#" + 校验)
```

**part2** = `b64(AES(c752c71963b42578, 设备信息板))`，设备信息板（round2 实测，593B）：

```
W.10054#####MacIntel#Firefox#142.0#############24#AQ9lBGlnCW0=###########
<32hex校验>##12##Mac OS#10.15#####<出口IP>#20-1601|23-2936|30-0|40-57|41-3251|70-3278|
71-3668|80-3670|81-3748|93-6714|94-6882#true###1117*1728##0###...###saf-captcha#0###
<随机16B b64>#<时间戳>#<随机16B b64>#<时间戳>#desktop#false##<32hex>#...#<Init毫秒>#
MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMxIzEjMCMwMTExMTEwMDExMTExMTExMTExMTExMTExMQ==#0#0#true###...###-1###...###
```

- `c752c71963b42578` 来自 DeviceConfig：`AES_CBC_decrypt(87f879f135f27da7, b64(DeviceConfig))` → `b64(key)#MQ==#WEB#...` 第 1 段 b64 即 key。
- `|20-1601|...` 为 FeiLin 采集阶段实时耗时（ GatherCost，须与 Log2 第 5 段一致——v2 结论，待 v3 实测确认）。
- `#3156#` 为 GatherCost 槽位（v2 同位置为 `#0#`），值动态。
- 尾部 32hex 校验 = MD5(前串+盐)，盐 `daye,raolewoba!`。

## 5. Log2 `Data`（cloudauth 设备上报）

```
明文 = "<appKey>#W#<32B b64内块>#W20220202#CLOUD#3156#501#"
     + b64(deviceToken 原始串(去 WEB# 前缀前的明文形式, 见 dom btoa 事件))
Data = b64(AES(a549a55c60a39aa0, 明文))
```

- ✅ round2 4268 字节全量匹配。
- Log3 同管线的更大变体（实测可不发）。

## 6. captchaVerifyCallback `data` 字段（滑块行为加密）

- producer：pe.059 VMP `tf/s</w< → nv → tf → t`（col 210430 返回 1072 字符 b64）。
- 加密为 pe.059 **自实现/VMP 内联**（无标准 CryptoJS encrypt 调用）→ 静态还原困难。
- **方案**：通用补环境跑真实 sg/feilin（见 `feilin_runtime/`，跨版本），参考 aliv2 的
  `extract_sg_vm.py`（R1=加密 / R2=轨迹打包两段字节码）+ `sg_cache.py`（按 StaticPath 下载、提取、缓存）。

## 7. UploadLog `log`（明文 JSON，无加密）

```json
{"sId":"1bn1l0rb","pfx":"1oa2ns","mInit":{"t":<ms>,"s":true,"msg":"INIT_SUCCESS","rt":<ms>},
 "hst":"captcha-open.aliyuncs.com","cId":"<CertifyId>","ip":"<出口IP>",
 "js":{"t":...,"s":true,"msg":"DYNAMICJS_LOADED","rt":...},
 "pImg":{"t":...,"s":true,"msg":"IMAGE_LOADED","rt":...},"rt":3500}
```

## 8. 版本差异记录（对照 aliv2/51job）

| 项 | aliv2 (feilin005/51job) | aliv3 (feilin008/51xf) | 结论 |
|----|------------------------|------------------------|------|
| IV / 盐 / HMAC secret / AES_MAIN / AES_SCENE / AES_DEVCONF | 相同 | 相同 | SDK 级常量稳定 |
| appKey | `sh87bd1512...` | `ab034ec0...` | 宿主配置，逐站不同 |
| deviceToken 第4段 | `#0#` | `#3156#` | GatherCost 槽位，动态 |
| HMAC 侧 | 单一 open | open + cloudauth 双 key | 51xf 走 FeiLin 设备链路 |
| sg 版本 | pe.05x | pe.05x | data 由 sg VMP 生成，需动态跑 |

## 9. 一键运行与压测

```bash
python xf_captcha.py                 # 1 轮
python xf_captcha.py 10 4            # 10 轮，间隔 4s
python xf_captcha.py 50 1 5          # 50 轮，5 线程并发压测
```

- 模型进程内只加载一次（`_YOLO_LOCK` 保证多线程共用安全），单次识别 ~150-200ms
- 时间线锚定：`generate_trajectory(start_anchor=init_ts-1500)` 全部时间戳加减法
  平移，拖拽终点 ≈ 当前时刻，`VerifyTime = now + 0~120ms`，**verify 前无 sleep**
- 默认不落盘任何文件；`XF_DEBUG=1` 落识别原图与 `_debug_single.json`，
  `XF_WIRE=1` 落 verify 完整 payload（`_wire_single.json`）

## 10. 排障指南（参数变了先看这里）

### 返回码语义
| 码 | 含义 | 处置 |
|----|------|------|
| T001/True | 成功 | — |
| F015 | 验证失败（缺口位置/轨迹/时间线不一致） | 自动换图重试；连续失败看下文排查 |
| LimitFlow:true | 限流 | 降低线程数/加 pace |

### 每日/每版本会变的点（按变化频率排序）
1. **sg 版本**（InitCaptcha 响应 `StaticPath`，如 `pe.091.xxx`）——`data` 打包算法
   已验证跨版本恒定（`SG_Z1` RC4 族），无需处理；若 F015 连发且轨迹/识别正常，
   用 `feilin_runtime/extract_sg_keys.py` 重新提取 sg 常量对比 `SG_Z1`
2. **feilin 版本**（DeviceConfig 第 4 段 path + 自动 HEAD 的脚本体积）——影响
   【每日层 A：v78d98s】（env 段 21）与【每日层 B：dfghfgdh6】（env 段 52）两个
   纯算公式。校准方法：
   ```bash
   node feilin_runtime/run_feilin.js init_input.json   # 跑真脚本产 142 段真值
   # 对照 xf_captcha.py ENV_TEMPLATE / build_fp2 的同下标字段
   ```
   `init_input.json` 用当前 InitCaptcha 响应的 DeviceConfig+CertifyId 重生成
3. **CertifyId/DeviceConfig/IP/时间戳** —— 每会话服务端下发，天然动态，无需处理

### 固定不变的点（历史验证）
- AES 密钥表/IV/MD5 盐/HMAC secret（gr 母密钥派生，aliv2 与 aliv3 跨站一致）
- DeviceData 两层构造、deviceToken 结构、Log2 Data 明文格式 → `restore_params.py`
- 详细推导：本文件 1-8 节；trace 证据：traces/round1、round2

### F015 排查顺序
1. `XF_DEBUG=1` 看识别图与 xPos 是否明显偏（YOLO conf<0.5 会走 cv2 兜底，
   精度差 → 多半是图难识别，重 init 换图即可）
2. `_wire_single.json` 检查 deviceToken/data 是否非空、session_key 是否解出
3. 时间线：TrackStartTime 应 ≥ init-1.5s 且 ≤ VerifyTime；若最近改过
   `generate_trajectory` 的窗口参数，先回滚对照
4. 全部正常仍 F015 → 考虑 feilin 换版改了每日层算法 → 走上面第 2 条校准

## 11. 双版本架构（已统一）

字段拼接唯一来源 = trace round2 真值板（内嵌 `xf_captcha.py`）：
- `_LOG2_BOARD`：Log2 Data 解密的真实 Log2 env 板（140 段）
- `_FP2_BOARD`：deviceToken part2 解密的真实 fp2 板（593 字节）
- UA 全链路 Firefox 142（与 trace 自洽）；会话动态段（21/42/43/52/71-74/87/117/118）每轮现算覆盖
- `dfghfgdh6` 公式已用 trace 输入反算与真值逐字符 MATCH

| 版本 | 文件 | 差异 | 用途 |
|------|------|------|------|
| 纯算版 | `xf_captcha.py` | print 日志，零 Node 依赖 | 兜底/压测基准 |
| 补环境版 | `xf_captcha_env.py` | loguru 关键日志 + feilin 沙箱校准钩子 | 生产（main_flow 指向它） |

hyxf_replay 的 `main_flow.py` 当前指向 `xf_captcha_env.Yuekeyun`；
切回纯算版 = import 行改回 `xf_captcha`，调用接口完全一致。

feilin 换版排查路径不变（见第 10 节）：两版板子主体都是 trace 真值，
只有每日层 A/B 公式（v78d98s/dfghfgdh6）与 feilin 版本挂钩，
连发 F001/F015 时用 `feilin_runtime/run_feilin.js` 跑真脚本校准。

## 12. 压测记录（2026-09-06，5 线程 × 25 轮）

| 版本 | 结果 | 耗时 |
|------|------|------|
| 纯算版 xf_captcha.py | T001 25/25 = 100% | 9.8s |
| 补环境版 xf_captcha_env.py | T001 25/25 = 100% | 7.0s |

结论：两版字段拼接统一为 trace 真值板后均满分，F001 已消除。

### 补环境变量名的版本稳定性（已确认）
`_ORDVD_huanj/v78d98s/dfghfgdh6/bgnb89435` 等 feilin 内部字段名在源码中为 VMP
混淆态（静态 grep 两代均 0 命中，属预期），运行时证据链确认跨版本稳定：
feilin002→005→008（→019 注释）同一套 env.js 变量名全程有效。
换版自检：拿新 DeviceConfig 跑一次 `node run_feilin.js init_input.json`，
有 `__FEILIN_RESULT__` 输出 = 名字仍有效；失败则用 trace 重新抓运行时字段名。
生产纯算版不依赖沙箱，此处失效不影响业务。

### 每日层自动跟随（补环境版，2026-09-06）
v78d98s/dfghfgdh6 现优先取自真实 feilin 运行值：env.js 冻结循环刻意不冻结这两个
键（feilin 拿 sessionId 自算写回），沙箱 rawResult/rawJoined 即为真值——已验证与
round2 trace 逐字符一致。feilin 换版 → 沙箱自动出新算法结果，纯算公式降级为
沙箱失败时的回退。每日运维动作 = 零。

## 13. 踩坑记录（重要，改代码前先读）

1. **两块板不能混用**：Log2 env 板（140 段，Log2 Data `501#` 段解密）和 fp2 板
   （deviceToken part2，593 字节）是两套下标布局。dfghfgdh6 的算法点
   （env[85]/[95]/[105]/[86]...）只在 Log2 板里非空——拿 fp2 板喂算法点会产出废值 → F001。
2. **指纹自洽**：客户端 UA/头/轨迹 si/板子必须同一设备族。Firefox 板 + Chrome 轨迹头
   （或反之）→ 服务端判矛盾 → F001。当前统一 Firefox 142 Mac（与 trace 一致）。
3. **canvas/color md5 必须每轮随机**（os.urandom(16).hex()）：固定值复用会被频控，
   批量跑时前几个成功后面越跑越失败就是这个。
4. **沙箱结果禁止跨会话缓存**：feilin 自算的每日层绑定当前 sessionId，
   全局缓存会让后续会话全 F001（实测 20% → 修复后恢复）。
5. **沙箱结果要校验**：v78d98s 非空 + dfghfgdh6 为 40+ 位 hex 才采用；
   不完整重跑一次，仍败回退纯算公式（并发下偶发不完整板）。
6. **代理必须贯通**：验证码链路（Log1/Log2/init/图片/verify）与业务请求走同一隧道，
   IP 断裂会被风控关联。适配层改参数时要用生产同款入口（Yuekeyun 类）做集成验证，
   不要只改函数签名——曾因 replace 静默未命中导致代理参数丢失。
7. **补环境变量名**（_ORDVD_huanj/v78d98s 等）跨 002→005→008 版本稳定（VMP 混淆，
   静态 grep 恒为 0 属预期），失效表现为沙箱显式报错，不影响生产纯算。

### feilin009 轮换应对（2026-09-07，最终方案）
009 板子 0-126 段布局不变、尾部 127+ 少一段、dfghfgdh6 点数随环境自适应
（Firefox 8 点 / Node 10 点）。教训：**不要用模板+覆盖拼接板子**——
每日层与其输入必须同源。最终方案：补环境版整板采用沙箱自算的 rawJoined
（feilin 自己算的每日层与输入天然自洽），换版零人工。纯算版为离线兜底
（换版后需重提公式，或直接切补环境版）。
