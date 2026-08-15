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

### 2. `metas.AsuraId`

`asura_id.js` 在 Node 内运行 Trace 对齐的 AWSC/UAB vendor 脚本和 Firefox 环境合同。运行时不启动或连接浏览器，每次都使用新的时间、轨迹时序和轻微坐标偏移生成 `140#...` 值。

```bash
node examples/闪购/asura_id_cli.js
```

实现使用 Node 内置模块，无 npm 依赖，支持 Node 22.14 的 macOS 和 Windows 环境。

### 3. `metas.fire_ua`

Trace 中 `AsuraId` 和 `fire_ua` 由同一个 collina 1.140.0 模块实例按顺序生成。请求组装时应调用 `createUabFields()` 一次取得同一环境和行为轨迹下的两个值：

```js
const { createUabFields } = require("./asura_id");

const { asuraId, fireUa } = await createUabFields();
```

单字段 CLI：

```bash
node examples/闪购/fire_ua_cli.js
```

### 4. `metas.fire_umid`

`fire_umid` 是 `AWSC.configFY` 加载 WebUMID 1.93.0 后向 UM 服务交换得到的 `tn`，不是本地随机拼接值。完整请求使用 `createLoginSecurityFields()`，确保风控字段来自同一次 AWSC 会话：

```js
const { createLoginSecurityFields } = require("./asura_id");

const { asuraId, fireUa, fireUmid, bxUmidToken, bxUa } =
  await createLoginSecurityFields();
```

Node 运行时会直接请求 `https://ynuf.aliapp.org/service/um.json`，不启动浏览器。

```bash
node examples/闪购/fire_umid_cli.js
```

### 5. Header `bx-umidtoken`

Trace 中该头字段走 `securityHeader -> FireEye.getUidToken() -> localStorage.lswucn`。
WebUMID 通过 `GET https://ynuf.aliapp.org/w/wu.json` 写入 `TOKEN@@timestamp`，
FireEye 1.231.13 的原始 `getUidToken()` 去掉时间后缀并返回 68 字节 token。
它和 body 的 `fire_umid` 是同一会话中的两个不同值，不得互相复用。

```bash
node examples/闪购/bx_umidtoken_cli.js
```

Node 会直接加载 `/w/wu.json` 的原始回调脚本，与 WebUMID/FireEye 共享当前内存
`localStorage`，运行时不启动或连接浏览器。

### 6. Header `bx-ua`

Trace 中该字段走 `securityHeader -> FireEye.getFYToken()`，由 FireEye 1.231.13
在当前 AWSC 会话内生成 `231!...`。本地环境中的 Canvas PNG、WebGL 扩展、
typed vector、GPU 字符串和 shader precision 均来自 Firefox Trace 的实际返回，
不使用空数组或零向量占位。

```bash
node examples/闪购/bx_ua_cli.js
```

`bx-ua`、`bx-umidtoken` 与 body 字段应通过一次
`createLoginSecurityFields()` 调用取得，避免拆成多次会话。最终 Node 运行时不启动或
连接浏览器，且只使用 Node 内置模块，兼容 Node 22.14 的 macOS 和 Windows。

## 一条龙接口验收

`demo.py` 会在一次 Node 会话中生成全部五个风控字段，动态取登录公钥，
用 RSA PKCS#1 v1.5 加密每次随机的测试手机号和密码，然后立即发起登录请求。
最终以 HTTP 和业务响应为验收结果，不依赖浏览器。

Python 请求使用 `curl_cffi` 的 Firefox TLS/HTTP2 指纹，并让
`getLoginConfig` 与最终登录共用一个 Session。请求头的 `Accept-Language`
与 Node 环境中的 Firefox `navigator.language` 保持为 `en-US,en;q=0.5`。
普通 `requests` 的 TLS 指纹会在相同业务参数下触发 `FAIL_SYS_USER_VALIDATE`，
因此它不属于本案例的可替换传输实现。

```bash
/opt/miniconda3/envs/Andriod-MG/bin/python examples/闪购/demo.py
```

Windows 上将 Node 22.14.0 加入 `PATH` 后直接运行：

```powershell
python -m pip install curl_cffi loguru
python examples/闪购/demo.py
```

默认每次生成随机测试账号。也可通过 `SHANGOU_USERNAME` 和 `SHANGOU_PASSWORD`
传入指定值。`NODE_BINARY` 可用于指定 Node 22.14.0 可执行文件。
`SHANGOU_IMPERSONATE` 默认是当前 `curl_cffi 0.9.0` 支持的 `firefox133`。

账号密码也可直接通过命令行传入，命令行优先于环境变量：

```bash
python examples/闪购/demo.py -user=USERNAME -pwd=PASSWORD
```

运行时通过 `loguru` 输出完整的明文输入、风控字段、加密参数、请求头、请求体和
接口响应，长字段保持原值，不做 preview 截断。

本地生成值不要求和某一轮浏览器输出等长。已验收的本地运行中，`140#`
约为 1250-1330 字符、最终 `231!` 约为 1810-1860 字符，仍能得到正常业务响应；
浏览器值更长主要来自页面累计的资源和交互记录。有效性以接口进入
`code=200` 且返回业务 `result` 为准，不以固定长度判断。
