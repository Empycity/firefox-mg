# 改进 4：board-align 校准工具（补环境 diff）

## 问题
换版校准时需要对比 shim 产出板 vs trace 真值板逐段差异，目前手工分段。
每天 feilin 轮换一次，校准是高频动作。

## 建议
扩展 tools/trace-align.js：新增 `--board TRACE_DIR --board-file LOCAL.txt` 模式，
逐段 diff 并输出不一致段号 + 双方值（相似度>90% 的段标"仅动态字段"）。

## 验收
用 round2 真值板 vs 沙箱板运行，能正确标出仅时间戳/随机 token 段为动态差异。
