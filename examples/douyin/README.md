# 抖音创作者上传发布（纯本地）

本目录是独立的 Python 发布流程：上传视频、等待处理、上传封面并调用
`create_v2` 发布。运行时不读取 Firefox Trace 输出目录，也不依赖浏览器窗口；
只需要同目录里的运行态文件、Cookie 和待发布视频。

## 当前稳定基线

本轮已按浏览器三次成功请求修正并验证：

- `bd-ticket-guard-client-data`、CSRF、`x-tt-session-dtrait`、REE public key 在同一
  浏览器会话内固定复用；
- 三枚 `__security_mc_1_s_sdk_*` Cookie 按“发布任务”轮换：每个视频任务开始换
  一次，任务内部从 `upload-auth` 到最终 `create_v2` 保持同一组；
- `create_v2` 响应头 `x-ms-token` 只记录长度/哈希，不写回 Cookie；
- 当前验证发布 body：`visibility_type=1`、`download=1`、`timing=0`、
  `media_type=4`；
- 本地五视频验证已通过，日志见 `log/run-agent-verify-5videos.log`。

## 交付文件

运行所需文件：

```text
creator_publish.py             主程序
creator-runtime-contract.json  a_bogus 的本地运行时契约
bdms-runner.js                 本地 BDMS 执行器
assets/bdms_1.0.1.16.js        BDMS 资源
security-runtime.json          Ticket Guard / CSRF / dtrait 运行态
security-storage-full.json     当前账号完整 Storage（换号和审计输入）
requirements.txt               Python 依赖
cookie.txt                     本机 Cookie（0600，仅本地保存）
test-videos/                   随包测试视频
连续发布5次视频.command         macOS 双击运行入口
连续发布5次视频.sh              macOS/Linux 命令行入口
run-5-videos-windows.bat        Windows 双击运行入口（ASCII + CRLF）
连续发布5次视频.bat             Windows 兼容跳转入口
```

`cookie.txt`、`security-runtime.json`、`security-storage-full.json` 含会话材料，只在
本机保存。换账号或 Cookie 过期时，Cookie、Security Runtime、完整 Storage 和
Runtime Contract 必须来自同一浏览器会话，不要只替换 `cookie.txt`。

## 首次准备

```bash
conda activate pythonProject
python -m pip install -r requirements.txt
```

系统还需提供 Node.js 与 `ffmpeg`。

`cookie.txt` 保存浏览器请求头中的完整 Cookie 值，一行保存，不带 `Cookie:` 前缀，
并包含 `msToken=...`。如果 Cookie header 没有 `msToken`，可把 `msToken=TOKEN`
追加到同一行。

## 发布视频

单个视频：

```bash
/opt/miniconda3/envs/pythonProject/bin/python creator_publish.py \
  --video "/absolute/path/video.mp4" \
  --cookie-file cookie.txt \
  --text "文案" \
  --visibility-type 1 \
  --download 1 \
  --timing 0
```

连续发布多个视频（共用一个 HTTP Session）：

```bash
/opt/miniconda3/envs/pythonProject/bin/python creator_publish.py \
  --video-batch "/path/a.mp4" "/path/b.mp4" "/path/c.mp4" \
  --cookie-file cookie.txt \
  --text "文案" \
  --visibility-type 1 \
  --download 1 \
  --timing 0 \
  --impersonate chrome136 \
  --retries 2
```

双击演示入口：

```text
macOS:   连续发布5次视频.command
Windows: run-5-videos-windows.bat
```

## 运行时自动维护

程序自动维护以下内容：

- `user_id`：从上传授权响应中的账号绑定策略提取；
- `Vid`、`StoreUri`、`UploadID`、`SessionKey`：由上传 Apply/Commit 响应返回；
- 视频尺寸、时长、编码、CRC32、封面 URI：由文件和接口响应生成；
- `creation_id`：每个发布任务动态生成；
- `a_bogus`：每个创作者接口按当前 URL/body/Cookie 动态生成；
- 三枚 `__security_mc_*`：每个发布任务开始轮换一次；
- Ticket Guard headers：优先复用浏览器导出的固定 `bd-ticket-guard-client-data`，并
  携带同一运行态的 CSRF、dtrait、公钥。

响应 `Set-Cookie` 由 Session 正常合并；响应头 `x-ms-token` 只观测，不覆盖
Cookie。进程退出时会把 Session 中的 Cookie 原子写回 `cookie.txt`。

## 验收与故障定位

成功条件：每个任务 `HTTP 200`、JSON `status_code=0` 且返回 `item_id`。日志只
打印长度、哈希和阶段状态，不打印 Cookie、Token 或完整签名。

`create_v2` 不自动重试。换账号或出现 403 时，按
[换账号操作步骤.md](./换账号操作步骤.md) 手工从浏览器成功 `create_v2` 复制 cURL，
并导出同页面完整 Storage，再重建整套运行态。

更多说明：

- POST body 字段： [POST请求体参数说明.md](./POST请求体参数说明.md)
- 全链路参数来源： [链路参数来源.md](./链路参数来源.md)
- 变更排查方法： [变更排查手册.md](./变更排查手册.md)
- 换账号操作步骤： [换账号操作步骤.md](./换账号操作步骤.md)

本地自检：

```bash
/opt/miniconda3/envs/pythonProject/bin/python creator_publish.py --dry-run
```
