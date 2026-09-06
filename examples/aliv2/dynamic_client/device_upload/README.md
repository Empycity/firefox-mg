# device.captcha-open Log2/Log3 设备上报（已实现，见 ../device_upload.py）

- POST https://device.captcha-open.aliyuncs.com/
- 参数（无 Timestamp）: AaduaneId=DuaneAprqkYsF3nt1yjK29Bf, Version=2020-10-15, SignatureMethod=HMAC-SHA1,
  SignatureVersion=1.0, Format=JSON, Action=Log2/Log3, Data=<密文>, SignatureNonce, Signature
- 签名 KEY_SECRET = DuanemHmyeE6LXCC46sJEDUw5DTlSZ（device 组）
- Data = b64(AES-128-CBC(LOG2_KEY, IV 0123456789ABCDEF, 明文))，LOG2_KEY=a549a55c60a39aa0（跨会话稳定，非 DeviceConfig chunk）
- 所有内层密文用 session_key（DeviceConfig chunks[0] 解出的 16hex）
- 明文结构（r2 body_4/5/6 + r5 body_3/4 双轮验证）：
  - Log2: `appKey#W#b64(AES(sk,scene))#W20220202#CLOUD#<GatherCost>#501#b64(seg1#大密文#sub_a#sub_b##sub_ts)`
    - 大密文 = AES(sk, 127 字段指纹遥测 732B)（模板 log2_plain_r5.txt）
    - seg1 = DeviceConfig chunks[2]（服务端代发，与 deviceToken 共用，无 WEB# 前缀）
  - Log3: `appKey#W#<同scene>#W20220202#CLOUD#<seq>#b64("511#<entry1>-504#<entry2>")`
    - entry = b64(seg1#b64(AES(sk,内容))#sub_a#sub_b##sub_ts)
    - entry1 内容 = 特征位图（log3_bitmap.txt，70B）；entry2 内容 = 行为 JSON（log3_behavior.json）
  - scene = "W.10054#saf-captcha-waf#<sceneId>"；sub_a = AES(sk,"saf-captcha-waf")；sub_b = AES(sk,"W.10054")
  - sub_ts = AES(sk, 13位时间戳)；sub1（payload f[21]）= b64(末 8 位 UUID ASCII 与
    `846965bb` XOR 后，再用 `fef2ac4e` 做 printable-ASCII 95 字符环移)
  - Log2 payload f[52] 为 50 字符：固定骨架
    `836a8eccbcb664e?????c075af9cf688b83a9fa1160a39eb45`，仅 `?` 五位随机 hex
- 模板制品：log2_plain.txt（r2 原始明文，字节级回归用）、log2_plain_r5.txt（生成模板）、
  log3_bitmap.txt、log3_behavior.json
- 服务器接受全新生成 Data（2026-08-29 实测 ResultObject:true）
