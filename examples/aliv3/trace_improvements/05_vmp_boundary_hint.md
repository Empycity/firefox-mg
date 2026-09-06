# 改进 5：VMP 字段显式标注

## 问题
pe.05x（sg）产生的字段（如滑块 data）由 VMP 解释器生成，boundary 模式没有
可读 producer 链。本次花了时间追 pe.059 内部才发现此路不通
（最终靠 sg 常量 z1 跨版本恒定的纯算方案解决）。

## 建议
target-candidates.json 已能检测 VMP 特征（iy/_.M 解释器、数字数组+字符串数组对）。
命中时给相关请求字段加 `producer_type: "vmp"` 标注，
并附提示："此字段 boundary 无链，走 VM/opcode 或纯算路径"。

## 验收
round2 重放：captchaVerifyCallback 的 data 字段带 vmp 标注。
