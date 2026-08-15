# 闪购登录 Trace

面板只加载 `agent-next.json`，`request-field-plan.json` 是分析说明，不是面板配置。加载后执行一次登录提交。目标请求为：

`POST https://app-api.shop.ele.me/xtop/xtop.napos.keeper.login.loginByUsername/2.0`

请求出现后立即停止采集并整理 Trace。第二轮关注：

- Body：`AsuraId`、`fire_ua`、`fire_umid`、`username`、`password`、`extraInfo`
- Headers：`bx-ua`、`bx-umidtoken`、`x-eleme-requestid`
- 账号加密：`767/</e.prototype.encrypt`
- Body 风控值：`getAsuraId`、`getFireUa`、`getFireUmid`
- Header 风控值：`fireyejs.js` 和 `securityHeader.min.js` 的返回/注入链
- 请求组装：`app.014aa854.js` 到最终 XHR `send/setRequestHeader`

`__raw__` 仅用于保留原始请求体，便于登录 body 结构与示例不一致时复核。

Cookie 采集保持关闭。时间、随机值、UMID 和 UA 风控串由本轮页面实时生成，不复用首轮的字段值。
