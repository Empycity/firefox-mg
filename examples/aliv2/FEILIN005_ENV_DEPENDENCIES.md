# FeiLin005 补环境依赖清单

来源：`firefox-trace-51job-feilin005-env-20260902-1800`，脚本
`FeiLin/1.5.1/feilin005.628a9a09...js`。

## 调用边界

| 模块 | 产物/接口 | 当前结论 |
|---|---|---|
| FeiLin | `deviceData`，约 127 个字段 | 已确认，进入 `DeviceToken` 加密明文 |
| FeiLin | `GatherCost` | 已确认，进入 `DeviceToken` 第四段；本轮为 `4043` |
| FeiLin | `Log2`、`Log3` | 已确认，发送到 `device.captcha-open.aliyuncs.com` |
| FeiLin | `DeviceToken` | 已确认，由 Init 的 `DeviceConfig` 驱动生成 |
| FeiLin | `f[43]`、`f[74]`、`f[77]` | 已确认是运行态字段；分别对应事件时序、采集时间、`CertifyId` |
| sg.050 | `CaptchaVerifyParam.data` | 属于滑块行为/事件密文，不归 FeiLin 设备指纹算法 |
| AliyunCaptcha/sg.050 | `Signature`、`SignatureNonce`、`Timestamp` | 请求封装与签名，不归 FeiLin |

## FeiLin 已观察到的浏览器依赖

这些 API 在 FeiLin005 脚本调用窗口内被真实读取，补环境时应优先提供稳定的 Firefox 语义：

- `navigator.userAgent`、`platform`、`vendor`、`productSub`、`language`、`languages`
- `navigator.plugins`、`navigator.mimeTypes` 及其 `length`
- `navigator.hardwareConcurrency`、`maxTouchPoints`
- `navigator.mediaDevices.enumerateDevices()`，读取设备 `kind`、`label`
- `navigator.permissions.query()`
- `screen.width/height`、`availWidth/availHeight`、`colorDepth`
- `window.innerWidth/innerHeight`、`outerWidth/outerHeight`
- `window.location`、`document.domain`、`document.readyState`
- `document.documentElement`、`outerHTML`、`dataset`、`document.all`
- iframe `contentWindow`
- Canvas `getContext`、WebGL `getParameter`
- `localStorage`、`sessionStorage`、IndexedDB/数据库能力探测
- `window.performance`、定时器、`btoa`
- `Notification.permission`

## Token 封装链

1. Init 返回 `DeviceConfig`，其中包含动态 session key、sessionId、FeiLin 版本、时间戳和服务端 IP。
2. FeiLin 采集 `deviceData` 与 `combatData`，计算 `GatherCost`。
3. 设备明文经 session key 加密，封装为 `WEB#...#cipher#GatherCost#md5` 后 Base64 得到 `DeviceToken`。
4. `deviceUploaded=true` 后发送 Verify；本轮第一次和第二次的 `GatherCost` 均为 `4043`。

## 两次尝试的差异

- 第一次 `xhr_6`：原 `CertifyId`，`F001/false`；`f[43]` 事件尾部为 `93-6494|94-6620`。
- 失败后自动重新 Init（`xhr_7`），产生 `CertifyId` 后缀 `-44e1d`。
- 第二次 `xhr_8`：新 `CertifyId`，`T001/true`；`f[43]` 事件尾部扩展为 `93-16891|94-16916`。
- 两次设备 payload 主体一致，明确变化集中在 `f[43]`、`f[74]`、`f[77]`；没有证据表明存在 1 秒通过阈值。

## 新增 diff trace（2026-09-02 06:00，实际为 FeiLin004）

目录名虽然是 `feilin005-diff`，但该 trace 的实际 FeiLin 调用者为
`FeiLin/1.5.1/feilin004.6fbec6bbc109e4f1481e456bec5660129c5b36333bdc0e4060982d4215f94059.js`。
因此它不是 FeiLin005 成功样本，不能用于证明 005 的设备字段兼容性。它只作为 sg 版本和请求顺序的对照样本：

- Init 返回 `StaticPath=3.29.0/sg.093.544562c1d80f9426`，说明动态 sg 版本会随服务端下发值自动切换，不能固定使用 `sg.050`。
- 请求顺序为 `Init -> UploadLog -> Log2 -> Log3 -> VerifyCaptchaV2`，无二次 Init。
- 首次 Verify 直接返回 `T001/true`，`CaptchaVerifyParam` 同时包含 `deviceToken` 与 `data`。
- 该样本 `deviceToken` 第四段 `GatherCost=6591`，而 18:00 trace 两次均为 `4043`；它是动态采集耗时字段，不能写死，也不能解释成 1 秒阈值。
- 该样本 `data` 长度为 `760`，18:00 第二次成功样本为 `2192`；长度随当次 sg 行为数据变化，不是固定模板长度。
- 该 trace 的 DOM/BOM 采集关闭，不能用来确认 `f[43]` 事件来源或 FeiLin 对象复用；它只补强版本跟随和请求顺序证据。

## 下一次需要 trace 的缺口

当前不再需要重复采集静态 API 列表。下一次只需确认：

1. 第二次 Init 后 FeiLin 是否完整重建 `deviceData`，还是复用部分对象状态。
2. `f[43]` 的事件追加具体来自哪些 DOM/事件回调，以及它何时被纳入 `DeviceToken`。
3. `deviceUploaded` 与 `Log2/Log3` 完成顺序是否影响 Verify 请求。
4. 同一页面连续两次滑动时，FeiLin 初始化回调和 sg `data` 生成回调的父调用链。

以上四项需要真实浏览器 trace 才能确认；补环境实现先按已确认边界隔离 FeiLin 与 sg。

## 补环境运行骨架

已新增 `feilin_runtime/`，其中加载的是本轮 trace 的真实 FeiLin005 脚本，
不是旧版纯算模板。入口：

```bash
node feilin_runtime/run_feilin005.js device-config.json
```

输入为同一轮 `InitCaptchaV2` 解出的 `deviceConfig`。当前骨架已在 Node 26
执行本轮 FeiLin005，并产出与原生样本一致的 127 字段 `zhiw`；142 字段
`rawJoined` 仅保留作诊断。token、行为位图、时间、证件号、Init 时间、IP
和采集时序均按当前运行动态生成，baseline 默认不加载。
