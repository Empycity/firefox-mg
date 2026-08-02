# Dynamic request generator

对外使用的唯一入口是 `fetch_curl_cffi.py`。命令行只传 `page`，脚本会自动：

```text
生成动态请求 -> 刷新 SDK token / 风控 token -> 按 Firefox 请求头发送 -> 打印响应
```

## 运行

```bash
cd /Users/empycity/Desktop/JS-tools/firefoxTrace
conda run -n pythonProject python jd_h5st_dynamic/fetch_curl_cffi.py 3
```

也支持显式写法：

```bash
conda run -n pythonProject python \
  jd_h5st_dynamic/fetch_curl_cffi.py --page=3
```

输出 JSON 包含：

```text
page
request_url
status
headers
text
```

`status / headers / text` 就是本次动态参数请求的响应结果。

## 默认行为

每次运行默认刷新：

- h5st SDK token / tk03 相关状态；
- 风控 jsToken / eid / fp；
- 请求时间和本轮动态访问状态。

状态仍会写入：

```text
jd_h5st_dynamic/state_compat.json
```

## Node 生成器（调试用）

需要单独查看生成出的 URL、headers、params 时，再运行底层 Node 生成器：

```bash
node jd_h5st_dynamic/generate_h5st.js \
  --page=3 \
  --browser=firefox \
  --pretty
```

只打印 URL：

```bash
node jd_h5st_dynamic/generate_h5st.js \
  --page=3 \
  --browser=firefox \
  --print-url
```

Node 生成器默认也刷新 token。Python 入口会自动调用它，日常只需要使用 Python 命令。

## 默认请求 body

```json
{"page":3,"pagesize":25,"area":"","source":"pc-home","kuangjia":1,"notJsonp":true}
```

## 环境要求

- Node.js；
- conda 环境 `pythonProject`；
- `pythonProject` 中安装 `curl_cffi`。
