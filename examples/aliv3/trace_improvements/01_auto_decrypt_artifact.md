# 改进 1：AES 解密链自动产出明文制品 ⭐ 价值最高

## 问题
请求字段的 producer 链是 "Utf8.parse(key) + Utf8.parse(iv) + b64密文 → AES-CBC → b64 输出"时，
trace 已捕获全部输入（unescape 出口捕获 key/iv、b64 串、输出值制品），
但明文需要人工串联三段证据手工解密。本次项目 Log2 env 板 / deviceToken 结构
各花了 ~30 分钟手工解密。

## 建议
在 finalize/index 阶段扫描 producer 链：同一 origin_call 子树内出现
`parse(16位串) + parse(16位串) + b64 串 → encrypt/decrypt 调用 → 字符串返回`，
自动用捕获的 key/iv 解密密文，产出 `values/decrypted/<req_id>_<field>.txt`
并在 request-timelines.json 里登记 `decrypted_artifact` 字段。

## 验收
round2 trace 重放后：deviceToken part2 板、Log2 env 板、DeviceConfig 明文
三个制品自动出现且与手工解密结果逐字节一致。
