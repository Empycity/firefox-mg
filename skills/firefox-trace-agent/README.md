# Firefox Trace Agent Skill

这是旧 `firefox-trace-reverse` skill 的通用交付版，保留原 skill name `firefox-trace-reverse`，但工作流已改为：

```text
用户提供 TRACE_DIR
  -> Agent 离线读完整证据
  -> request field（query/body/headers/cookies）/ 请求结构
  -> 固定 URL + headers + cookies + body 的 diff 级字节还原
  -> JS producer / script / DOM-BOM-state 依赖账本
  -> 补环境或纯算判断
  -> 动态值生成并用用户 URL 请求验证
  -> reproduction contract
```

`tools/` 是随 skill 携带的通用工具副本；浏览器二进制仍通过 `FIREFOX_BIN` 或 `FIREFOX_TRACE_RUNTIME_ROOT` 指定。

## 使用变量

```bash
export FIREFOX_TRACE_REPO=/absolute/path/to/firefoxTrace
export FIREFOX_TRACE_RUNTIME_ROOT=/absolute/path/to/firefox-trace-runtime
export FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_ROOT/Nightly.app/Contents/MacOS/firefox"
export FIREFOX_TRACE_PYTHON=/opt/miniconda3/envs/firefox-trace/bin/python
```

入口：

```bash
tools/trace-desktop.sh
tools/trace-console.sh --host 127.0.0.1 --port 8788
```
