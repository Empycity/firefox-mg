# 改进 3：设备板（board）聚合制品

## 问题
feilin/阿里系验证码的 142 段设备板散在三处：btoa 输入（deviceToken）、
AES 明文（part2）、Log2 payload 内嵌 b64。补环境校准时需手工解出再分段对比。

## 建议
finalize 时按请求聚合：凡是"多段 `#` 拼接且首段为 W.100xx"的字符串制品，
识别为 board，产出 `index/boards.json`：{字段值, 段号索引, 所属 request_id, 会话绑定}。

## 验收
round2 重放产出 2 块板（Log2 板 140 段 / fp2 板 142 段），
段号索引与人工分析一致。
