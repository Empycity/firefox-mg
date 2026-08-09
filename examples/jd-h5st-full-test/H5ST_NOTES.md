# JD H5ST Implementation Notes

本文档记录当前项目里 JD `h5st` 的两套实现：补环境版和 Python 纯算版。

当前结论：

- 首页 `pc_home_feed` 已经打通，`python3 examples/jd-h5st-full-test/index.py` 返回 `HTTP 200`、`code: 0`，有商品数据。
- 搜索页纯 Python 版已由用户验证可用，`search.py` 是搜索接口的一键运行入口。
- 之前出现过的 `HTTP 403` 空 body 属于当时 cookie/账号搜索风控现象，不再作为当前搜索纯算状态记录。
- 补环境版已保留，纯 Python 版不依赖浏览器或 Node 运行签名。

## 文件分工

### 纯 Python 版

| 文件 | 作用 |
|---|---|
| `h5st_pure.py` | 纯 Python 实现 `fp`、`tk06/localTk`、`request_algo`、`tk03/algo`、`h5st` 拼接、JD 自定义编码和请求工具。 |
| `index.py` | 首页接口 `pc_home_feed` 的一键运行入口。PyCharm 里直接运行该文件即可。 |
| `search.py` | 搜索接口的一键运行入口。PyCharm 里直接运行该文件即可，纯算链路已验证可用。 |

### 补环境版

| 文件 | 作用 |
|---|---|
| `signer.js` | Node VM 加载 `analysis/js_security_v3_0.1.4.beautified.js`，补浏览器环境并调用原始 SDK 签名。 |
| `risk.js` | Node VM 加载 `analysis/pc-tk.js`，生成 `jsToken/eid`。 |
| `index.js` | 首页补环境签名和请求构造。 |
| `search.js` | 搜索补环境签名和请求构造。 |
| `index_env.py` | Python 包装 `index.js`，保留补环境版首页一键运行。 |
| `search_env.py` | Python 包装 `search.js`，保留补环境版搜索一键运行。 |

### 分析辅助文件

| 文件 | 作用 |
|---|---|
| `analysis/js_security_v3_0.1.4.beautified.js` | JD h5st SDK 本地分析源码。 |
| `analysis/pc-tk.js` | JD PC risk token 脚本。 |

## 运行方式

首页纯 Python：

```bash
python3 examples/jd-h5st-full-test/index.py
```

首页补环境版：

```bash
python3 examples/jd-h5st-full-test/index_env.py
```

搜索纯 Python：

```bash
python3 examples/jd-h5st-full-test/search.py
```

搜索补环境版：

```bash
python3 examples/jd-h5st-full-test/search_env.py
```

`index.py` 顶部直接改 `PAGE`。`search.py` 顶部直接改 `KEYWORD`、`PAGE`、`S`、`PVID`。

## 依赖

纯 Python 版业务运行依赖：

```bash
python3 -c "import curl_cffi"
```

`curl_cffi` 用于 Chrome TLS 指纹模拟。JD 这类接口存在 TLS/HTTP 指纹校验，普通 `curl` 或原生 `fetch` 可能在签名正确时仍返回 `403`。

补环境版额外依赖 Node.js：

```bash
node -v
```

## 首页链路

首页接口：

```text
GET https://api.m.jd.com/
appid=www-jd-com
functionId=pc_home_feed
client=pc
clientVersion=1.0.0
```

签名 SDK appId：

```text
b5216
```

请求流程：

1. 生成本地 `fp`。
2. 生成 `tk06/localTk`。
3. 请求 `https://cactus.jd.com/request_algo` 获取 `tk03` 和 `algo`。
4. 从 `algo` 中提取 `rd`。
5. 计算动态 key。
6. 对业务参数生成 `h5st`。
7. 使用 `curl_cffi(impersonate="chrome120")` 请求业务接口。

已验证：

```text
python3 examples/jd-h5st-full-test/index.py
HTTP 200
code: 0
msg: Success
data.data: 有商品列表
```

注意：首页返回里可能出现 `isLogin:false`。这不影响匿名首页推荐数据返回，也不代表搜索登录态可用。

## 搜索链路

当前项目里的搜索页纯算链路：

```text
GET https://api.m.jd.com/api
appid=search-pc-java
functionId=pc_search_searchWare
```

用户后续提供过的同类搜索链路：

```text
GET https://api.m.jd.com/api
appid=search-pc-java
functionId=pctradesoa_mixer
```

签名 SDK appId：

```text
f06cc
```

搜索链路需要登录 cookie 和 `x-api-eid-token`。如果 cookie 或账号触发搜索风控，表现可能是：

```text
HTTP 403
content-length: 0
server: jfe
x-rp-sdtoken: set;1800;<new-token>
```

这不是普通业务 JSON 认证失败。它是历史排查时遇到的 cookie/账号风控现象，不代表 `search.py` 纯算链路未接入。

搜索请求必须运行时重新生成 fresh `h5st`，不能复放旧 curl 里的 `h5st`。旧 `h5st` 带时间戳、`tk03`、环境段和随机段，过期后直接复放会失败。

## h5st 格式

当前版本生成 10 段：

```text
date17;fp;sdkAppId;tk03;seg4;5.3;timestampMs;envEncoded;seg8;stkEncoded
```

典型段长度：

```text
[17, 16, 5, 92, 64, 3, 13, 756, 64, 68]
```

搜索旧链路 `_stk` 可能较短，例如：

```text
appid,body,client,clientVersion,functionId,t
```

首页 `_stk`：

```text
appid,body,client,clientVersion,functionId,t,uuid
```

## 纯算关键点

### JD 自定义 Base64

JD 的 `Yz.encode` 不是标准 Base64。实现位于 `h5st_pure.py`：

- `jd_b64_stringify`
- `jd_b64_encode_bytes`
- `jd_b64_encode_text`

已对齐样本：

```text
"" -> of7r
"a" -> pjbT
"ab" -> qjVT
"abc" -> of7rIiVT
```

### JD 字符串哈希

字符串 SHA256 不是直接 `sha256(text)`，而是：

```text
sha256((se_data1(text) + "RvI<7|").utf8)
```

实现：

```text
jd_sha256_string()
se_data1()
```

`tk06` 的 checksum 使用同类字符串 MD5：

```text
md5((se_data1(text) + "RvI<7|").utf8)
```

实现：

```text
jd_md5_string()
```

### tk06/localTk

`tk06/localTk` 已通过动态插桩对齐 SDK 固定样本。关键逻辑：

1. `Y8(32)` 生成随机串。
2. 生成短随机表达式，例如 `2x2x3`，不足 9 字节时用 `Y8(32)` 前缀补齐。
3. 对该 9 字节字符串执行 `Yz.stringify(Yp.parse(...)).slice(1)`，作为 payload 前缀。
4. `Y8(12)` 生成 `rand12`。
5. 第一段 MD5 的输入使用旋转后的 `rand12[5:] + rand12[:5]`。
6. payload 编码使用未旋转的 `rand12`。
7. checksum 使用 `jd_md5_string("tk06w0641lf" + payload)[:8]`。

固定 trace 对齐样本：

```text
fp = abcdefghijklmnop
Date.now = 1700000000123
Math.random = 0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9...

tk06w22b31b3441lfEL5Nof2TUm1pjrP8yVQ-_FRCK1SFWlSIiVTrrbrgtPyD_0WZ63apS0f6mVe7PmdGK4f0nIf4Xle
```

## 补环境版保留原因

补环境版保留不是最终业务依赖，而是作为：

- SDK 行为对照基准。
- 新接口或站点升级时的快速验证工具。
- 纯算结果异常时的差异定位工具。

补环境版运行时加载原始 SDK：

```text
analysis/js_security_v3_0.1.4.beautified.js
```

并在 Node VM 里补：

- `window`
- `navigator`
- `screen`
- `document`
- `localStorage/sessionStorage`
- `XMLHttpRequest`
- Canvas/WebGL stub
- `Function.prototype.toString` 相关表现

业务最终交付仍以纯协议脚本为目标，不能依赖浏览器自动化。

## 当前状态清单

| 项目 | 纯 Python | 补环境版 | 状态 |
|---|---:|---:|---|
| 首页 `pc_home_feed` | `index.py` | `index_env.py` | 已验证 200，有数据 |
| 搜索页接口 | `search.py` | `search_env.py` | 纯 Python 版已由用户验证可用 |

## 搜索请求注意事项

搜索请求不要复放旧 curl 的 `h5st`。应按运行时 fresh 生成：

1. 用可用搜索 cookie 读取 `uuid`、`3AB9D23F7A4B3CSS`、`sdtoken` 等字段。
2. 构造搜索 body。
3. 用 SDK appId `f06cc` 调 `request_algo` 获取 fresh `tk03`。
4. 用 `_stk` 对应字段重新签 `h5st`。
5. 使用 `curl_cffi` Chrome 指纹发送。
6. 如果仍是 `HTTP 403 + x-rp-sdtoken:set`，先判断账号/搜索风控，不要先改签名算法。
