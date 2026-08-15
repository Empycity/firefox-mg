# 闪购登录首轮 Trace 结论

Trace：`/Users/empycity/Desktop/firefox-trace-outputs/firefox-trace-shangou-login-round1-20260815-164740`

目标请求：

`POST https://app-api.shop.ele.me/xtop/xtop.napos.keeper.login.loginByUsername/2.0`

命中 `request_id=xhr_6`，HTTP 200，业务返回为用户名密码错误，说明请求体、安全头和路由已到达登录业务层。

## 字段生产链

| 字段 | 首轮值长度 | 生产者 |
| --- | ---: | --- |
| `params.username` | 88 | `login.139f6e14.chunk.js` 的 `767/</e.prototype.encrypt` |
| `params.password` | 88 | `login.139f6e14.chunk.js` 的 `767/</e.prototype.encrypt` |
| `metas.AsuraId` | 1132 | `app.014aa854.js:getAsuraId` -> `window.uabModule.getUA()` -> `collina.js` |
| `metas.fire_ua` | 1128 | `app.014aa854.js:getFireUa` -> `window.fyOBJ.getUA()` -> AWSC/UAB |
| `metas.fire_umid` | 68 | `app.014aa854.js:getFireUmid` -> `window.fyOBJ.umidToken` |
| `bx-ua` | 1844 | `fireyejs.js` 生成，`securityHeader.min.js` 取值，`app.014aa854.js` 写入 XHR header |
| `bx-umidtoken` | 68 | FireEye/UMID 生成，`securityHeader.min.js` 取值，`app.014aa854.js` 写入 XHR header |

`app.014aa854.js` 中登录请求的静态组装逻辑为：

```text
param = 登录页生成的 username/password/extraInfo
metas = {
  AsuraId: getAsuraId(),
  fire_ua: getFireUa(),
  fire_umid: getFireUmid(),
  appName: "melody"
}
```

## 动态性

以下值都必须在同一次页面会话和登录动作中生成：

- `AsuraId`
- `fire_ua`
- `fire_umid`
- `bx-ua`
- `bx-umidtoken`
- `X-Eleme-RequestID` 的随机部分和时间戳
- RSA 加密后的 `username/password`

首轮值只用于 SHA-256 对齐和调用链证据，不进入最终运行时常量。

## 健康状态

- 原始事件：264172
- 请求字段：39
- 目标命中：37
- `trace_degraded=0`
- `trace_suppressed=0`
- `object_contract_complete=true`
- `value_capture_complete=true`
- `evidence_complete=false`

`evidence_complete=false` 的标记是 `request:target_value_without_complete_artifact`，影响部分 header 的完整制品闭环。Body 中的长值制品已经完整落盘。

## 第二轮

加载同目录的 `agent-next.json`。第二轮使用新输出目录，保持 `full-chain + boundary`，对上述已确认函数做定向值展开，不启用 VM/WASM，Cookie 采集继续关闭。
