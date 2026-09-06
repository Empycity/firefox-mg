# feilin009 每日层反推（2026-09-07 更新）

## 每日层 A：v78d98s —— ✅ 已解决并双端验证

结论：**009 的 v78d98s 与 008 同构，输入窗口仍是 `sid[-8:]`，此前"32 位 rand 格式
映射失效"的结论不成立**（是 b64 手工解码错误导致的误判，`KiouWS0xLyE=` 正确解码
即 [42,42,46,89,45,49,47,33]，与沙箱公式逐字节一致）。

公式（已写入 `xf_captcha.py v78d98s()`）：

```
s = sid[-8:]   # sessionId 尾 8 hex，前 24 位完全不参与
out[i] = ((ord(s[i]) + K2[i] - 128) mod 95) + 32     # js 风格 mod（abs%n 带符号）
K2 = [134,84,87,83,87,90,89,81]                       # 008 为 XOR"582abb1e" + 移位"c8228469"
v78d98s = b64(out latin-1)                            # 009 无 XOR 层（k1=0）
```

验证链（`feilin_runtime/probe_v78_009.py`，矩阵数据 `v78_009_real32_matrix.json`）：
1. DeviceConfig 重加密探针：481 次运行（扫 rand[24:32] 全映射 + 扫 rand[0:24]），
   公式对全部探针 481/481 复现；确认 rand[0:24] 任一位变化输出零影响。
2. round3 Firefox trace 真值：sid 尾 `c67f6760` → `KiouWS0xLyE=` ✓。
3. 008 公式（旧常量）在 Node 沙箱与 Firefox trace 双端一致 → 常量跨端稳定，
   轮换只换常量、不改结构。

换版校准方法：改 DeviceConfig sessionId 尾 8 重加密 → `node run_feilin.js` →
8 组 (输入字符, 输出字节) 解 K2（每位置 16 样本足够），或直接跑 probe_v78_009.py。

## 每日层 B：dfghfgdh6 —— md5 输入已全部捕获，7/10 源归因

md5 入口已 hook 成功：feilin 用 `__ALIYUN_CRYPT`（crypto-js）算 MD5，包装对象属性
可绕过其原型反钩子（`FEILIN_DFG_TRACE=1 node run_feilin.js`，env.js 已内置）。
feilin 对 String 原型有反 hook（跨 realm 取原生态），charCodeAt/charAt/fromCharCode
钩子数秒内失效，勿再走原形钩子路线。

round3（Firefox 009）dfghfgdh6 = `c81857084bb38eff149a44b3100000dcb9b4d916fa60bb6442`，
10 段 md5 输入串（变换输出）已从 trace values 全部取回：

| 段 | 值 | md5 输入（变换后） | 归因 |
|----|-----|--------------------|------|
| 0 | c8185 | `҄҄Ҵќ҄ҴҜӌ`（7 字符） | ❓ 源/变换未定 |
| 1 | 7084b | `ￍ`（1 字符） | ✅ = sub45('3')，即 asdfd6（008 家族常量精确反推） |
| 2 | b38ef | `ߔ\u0604ڌڌ٬لؔ…`（22 字符） | ❓ 源/变换未定 |
| 3 | f149a | 33 字符串 | ✅ = xk37(gdfhvcb6 机器指纹) |
| 4 | 44b31 | `ÓÐ` | ✅ = add116('30')（vbnmbn3/dfxvsdf4） |
| 5 | 00000 | 空位哨兵 | ✅ 空值点直接输出 "00000"（board[22]=''） |
| 6 | dcb9b | - | ✅ = xk37('0')（board[16]） |
| 7 | 4d916 | - | ✅ = sub117_234('-480')（asf65445 时区） |
| 8 | fa60b | - | ✅ = xk37('1.5')（asdfasdf） |
| 9 | b6442 | - | ✅ = add116('94433880daa9f55b02a5836769d31ee2')（vbnmbn4） |

Node 沙箱 10/10 全归因（algoOrder 与 008 接近：sub117_234/sub45/xk8/xk8/id/xor119/
xk37/xor119/sub45/add116；注意 009 出现 identity 直接 md5 的点）。

已确认的关键事实：
- 变换族（sub45/xk37/add116/sub117_234/xor119/xk8）常量跨 008→009 不变；
  变的是 **algoPoint 的选择/顺序**（环境自适应：Node 与 Firefox 选点不同）。
- 每段 = md5(transform(源值))[:5]；空源值 → 字面 "00000"。
- FF 的 algoPoint 配置在 `ra.algoPoints`（q 处理器按 algoOrder 消费），
  配置本身未在 trace 中成对象捕获。

## 剩余工作（可选，优先级低）

仅 seg0/seg2 两段的（源值, 变换常量）未定。它们只影响纯算版 FF 剖面的 2/10 段；
生产/前端一律走补环境版（沙箱自算，25/25），纯算版仍冻结兜底。
后续路线：解 tX 字符串表（`n=["w7x3",…]` @脚本 519013，e3 表偏移 13）拿 algoPoint
配置；或在真实页再加一轮 full-chain trace 取第二组 FF 向量联立。

## 生产状态
- 补环境版已免疫：整板采用沙箱自算输出（25/25），**生产无需纯算公式**。
- env.js 本轮新增（向后兼容）：`__FEILIN_RESULT__` 增加 `dfg6` 字段
  （join 钩子捕获的 dfghfgdh6 真值）；可选 `FEILIN_DFG_TRACE` md5 记录。
- `probe_v78_009.py`：v78 探针驱动（DeviceConfig 重加密 + 并发沙箱运行）。
