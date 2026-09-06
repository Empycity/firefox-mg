# feilin 通用补环境运行时（aliv3 / 51xf）

每天轮换的 feilin 脚本不改这里：`run_feilin.js` 按设备会话（DeviceConfig 解出的
version = "x.y.z/feilinXXX.<sha256>"）自动下载并以 sha256 缓存到 cache/。

## 用法
    node run_feilin.js init_input.json     # 输入含 DeviceConfig（InitCaptcha 响应原文）
    # 或管道: cat init.json | node run_feilin.js -

## 结构
- env.js          通用浏览器沙箱（来自 aliv2 v2_env，已本地化 51xf 站点参数）
- run_feilin.js   解密 DeviceConfig（87f879f135f27da7 / IV 0123456789ABCDEF）→ 选脚本 → 跑 env.js
- extract_sg_keys.py  sg/SDK 密钥动态提取 + sha256 缓存（hook unescape/atob + AES 自验证）
- cache/sg_keys/  提取结果缓存（index.json 按脚本 sha256 索引）

## 输出
`__FEILIN_RESULT__` JSON 行：zhiw（设备板明文）+ gatherCost + rawResult/rawJoined。
zhiw 142 段下标即 captcha_51xf.py ENV_TEMPLATE/FP2 的下标体系。
