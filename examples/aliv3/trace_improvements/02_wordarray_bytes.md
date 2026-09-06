# 改进 2：crypto 调用点强制捕获 WordArray/TypedArray 字节

## 问题
CryptoJS 中间对象（WordArray）在 boundary 模式下只有 "Object" 预览，words 数组无值。
CBC 的 IV 对象（jsobj_2698）因此丢失，只能靠已知明文反推。

## 建议
调用点命中 crypto 特征（_createHmacHelper/encryptBlock/finalize/parse）时，
对其参数与返回对象强制捕获 `words`(数字数组) + `sigBytes`，
等价于对该对象临时 object_depth=2，与 TRACE_DOM_OBJECT_VALUES 同机制。

## 验收
round2 重放：AES encrypt/finalize 调用的 words 数组可还原出完整密文字节，
与 request_body 里的字段值一致。
