# 闪购登录第二轮 Trace 结论

Trace：`/Users/empycity/Desktop/firefox-trace-outputs/firefox-trace-shangou-login-round2`

目标请求：`xhr_6`

`POST https://app-api.shop.ele.me/xtop/xtop.napos.keeper.login.loginByUsername/2.0`

## 验证结果

- 267268 条原始事件
- 39 个请求字段，37 个目标命中
- `trace_degraded=0`
- `trace_suppressed=0`
- `object_contract_complete=true`
- `value_capture_complete=true`
- Cookie 采集关闭
- HTTP 200，业务返回 `USERNAME_NOT_EXIST`，`showCaptcha=false`

请求已到达登录业务层。返回的账号结果与首轮一致，前置安全参数链没有在接口前被拦截。

## 精确生产者对齐

| 请求字段 | 精确 JS 返回链 | 定向命中 |
| --- | --- | --- |
| `params.password` | `call_185368` `767/</e.prototype.encrypt` | true |
| `params.username` | `call_185697` `767/</e.prototype.encrypt` | true |
| `metas.AsuraId` | `call_185816` `getAsuraId` -> `collina.js` | true |
| `metas.fire_ua` | `call_185921` `getFireUa` -> `awsc.js` -> `collina.js` | true |
| `metas.fire_umid` | `call_185990` `getFireUmid` | true |
| `bx-umidtoken` | `call_186147` `securityHeader:f` -> `call_186207` `fireyejs:L/uo[Vr]` -> `call_186209` `L` | true |
| `bx-ua` | `call_186406` `securityHeader:f` -> `call_186462` FireEye producer -> `call_186464` `L` | true |

上述每个请求字段的 SHA-256 都与对应 `js.call.return` 的 SHA-256 完全相同，且存在独立 `values/<sha256>.txt` 制品。

## 两轮对比

运行时脚本 SHA-256 均未变：

| 脚本 | SHA-256 |
| --- | --- |
| `app.014aa854.js` | `27f84a36d519a02a6f65b01f5e0c68d7b0c5f57cfcb2061870af2d5e05c3ab6e` |
| `login.139f6e14.chunk.js` | `314e28476808813076df5f8c2adfef33612519fa0c77747c917c504bac8e2eb7` |
| `securityHeader.min.js` | `d0a2a615a38872d5674efa63554ddde967816411707bb692fd870d451398f3d0` |
| `fireyejs.js` | `738f6ddb182cd67f0ee619eb169cc8e285d46f288396f2dcc9f073b045416b39` |
| `collina.js` | `04975704505b42dc124568d9d4be26aee2d4592826a0487920cb1d016d1a8e58` |
| `awsc.js` | `ad5eb90e8f14eb7cdf94c2782491ddb839ff78830d2f50985a1996dbd5cb5270` |

两轮保持稳定的字段：

- `Content-Type`
- `x-shard`
- `metas.shopId`
- `metas.ksid`
- `metas.appName`
- `params.loginedSessionIds`
- `params.extraInfo.*`

两轮发生变化的字段：

- `params.username`
- `params.password`
- `metas.AsuraId`
- `metas.fire_ua`
- `metas.fire_umid`
- `bx-ua`
- `bx-umidtoken`
- `X-Eleme-RequestID`

脚本和函数身份一致，字段值按每轮的随机数、时间、会话和浏览器环境变化。当前结论是生产算法链未换，不应将任一轮的长字段或密文固定到运行时。

## 健康标记说明

`evidence_complete=false` 包含大对象的 `props_truncated/items_truncated` 以及 4 个 header 字段的 complete-artifact 标记。目标长字符串本身均已通过字段 SHA、JS return SHA 和 `values/` 制品三方对齐，这些标记不影响本报告列出的标量/字符串生产链结论。

## 下一步

以第二轮制品为固定向量，依次拆分：

1. 登录 chunk 中的 RSA 公钥获取与 `username/password` 加密。
2. `app.js` 的 request/metas 组装与 XHR 路由。
3. AWSC/UAB/FireEye 原脚本运行所需的 Firefox 环境合同。
4. 用新鲜时间、随机和会话状态生成完整请求，再进行字段和业务响应验收。
