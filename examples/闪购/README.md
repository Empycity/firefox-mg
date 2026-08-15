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

第二轮已完成字段 SHA-256 与 JS 返回值的精确对齐，详见 `round2-analysis.md`。当前证据已足够进入脚本拆分和本地运行时实现。

## 参数实现进度

### 1. `params.username` / `params.password`

`login_crypto.js` 复刻登录 chunk 的 RSA PKCS#1 v1.5 加密边界。公钥使用当前 `getLoginConfig` 响应中的 `result.publicKey`，不将响应密文固定到代码。

```bash
node examples/闪购/login_crypto_cli.js \
  '{"publicKey":"PUBLIC_KEY_BASE64","username":"USERNAME","password":"PASSWORD"}'
```

运行回归：

```bash
node examples/闪购/test_login_crypto.js
```

### 2. `metas.AsuraId`

`asura_id.js` 在 Node 内运行 Trace 对齐的 AWSC/UAB vendor 脚本和 Firefox 环境合同。运行时不启动或连接浏览器，每次都使用新的时间、轨迹时序和轻微坐标偏移生成 `140#...` 值。

```bash
node examples/闪购/asura_id_cli.js
```

运行连续生成回归：

```bash
node examples/闪购/test_asura_id.js
```

实现使用 Node 内置模块，无 npm 依赖，支持 Node 22.14 的 macOS 和 Windows 环境。

### 3. `metas.fire_ua`

Trace 中 `AsuraId` 和 `fire_ua` 由同一个 collina 1.140.0 模块实例按顺序生成。请求组装时应调用 `createUabFields()` 一次取得同一环境和行为轨迹下的两个值：

```js
const { createUabFields } = require("./asura_id");

const { asuraId, fireUa } = await createUabFields();
```

单字段 CLI 和成对回归：

```bash
node examples/闪购/fire_ua_cli.js
node examples/闪购/test_uab_fields.js
```

### 4. `metas.fire_umid`

`fire_umid` 是 `AWSC.configFY` 加载 WebUMID 1.93.0 后向 UM 服务交换得到的 `tn`，不是本地随机拼接值。完整请求使用 `createLoginSecurityFields()`，确保风控字段来自同一次 AWSC 会话：

```js
const { createLoginSecurityFields } = require("./asura_id");

const { asuraId, fireUa, fireUmid, bxUmidToken } =
  await createLoginSecurityFields();
```

Node 运行时会直接请求 `https://ynuf.aliapp.org/service/um.json`，不启动浏览器。

```bash
node examples/闪购/fire_umid_cli.js
node examples/闪购/test_login_security_fields.js
```

### 5. Header `bx-umidtoken`

Trace 中该头字段走 `securityHeader -> FireEye.getUidToken() -> localStorage.lswucn`。
WebUMID 通过 `GET https://ynuf.aliapp.org/w/wu.json` 写入 `TOKEN@@timestamp`，
FireEye 1.231.13 的原始 `getUidToken()` 去掉时间后缀并返回 68 字节 token。
它和 body 的 `fire_umid` 是同一会话中的两个不同值，不得互相复用。

```bash
node examples/闪购/bx_umidtoken_cli.js
node examples/闪购/test_bx_umidtoken.js
```

Node 会直接加载 `/w/wu.json` 的原始回调脚本，与 WebUMID/FireEye 共享当前内存
`localStorage`，运行时不启动或连接浏览器。
