# Firefox Trace Agent Skill

这是旧 `firefox-trace-reverse` skill 的通用交付版，保留原 skill name `firefox-trace-reverse`，但工作流已改为：

```text
用户提供 TRACE_DIR
  -> Agent 离线读完整证据
  -> request field（query/body/headers/cookies）/ 请求结构
  -> JS producer / script / DOM-BOM-state 依赖账本
  -> 用同一 Firefox page/profile 补真实浏览器对象和值
  -> 补环境生成候选并验证实际请求/业务响应
  -> 请求失败后固定 URL + headers + cookies + body 做 diff 级字节还原
  -> 纯算仅在 diff 暴露确定性算法缺口或用户选择该交付物后进入
  -> 只对命名的浏览器/runtime 缺口做最小 patch
  -> 动态值生成并用用户 URL 请求验证
  -> reproduction contract
```

`tools/` 是随 skill 携带的通用工具副本；浏览器二进制仍通过 `FIREFOX_BIN` 或 `FIREFOX_TRACE_RUNTIME_ROOT` 指定。

当前 finalize 会在 `index/causal-index.json` 中输出通用
`producer_match/producer_chain`：请求字段 SHA-256 可反向定位同进程、同 segment、
请求前最深的 exact JS return 及父链。该逻辑不包含站点、字段或 SDK 专名。

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
```

面板参数与下一轮配置见 `references/ui-parameter-catalog.md`；缺少内置对象时
优先按 `references/environment-repair-playbook.md` 在当前 Firefox 控制台取值；
启动缓慢或崩溃先读 `references/firefox-startup.md`。

完整操作与验收手册：

- `references/product-manual.md`
- `references/trace-mode-operation-manual.md`
- `references/agent-trace-guide.md`
- `references/browser-runtime-review.md`

这些文件与主仓库 `docs/` 对应文档保持字节一致，并由测试强制校验。

当前面板契约：`full-chain` 默认使用 `boundary`、普通 JS 总事件 `0`、DOM/BOM
`all` + 值/对象合同、Fetch/XHR request/response/header 完整制品、JS value/script raw/TypedArray/WebSocket 可用帧/IPC 的 `0=不截断`，VM/WASM（含 raw operands）全部关闭；
`discover-light` 才使用显式 `50000` JS 事件预算。面板左、右两栏独立滚动，readonly
下拉框只在点击列表时改变值；`agent-next.json` 和 `.env` 可直接拖入对应区域，一份完整
JSON 会一次填充可见字段、模块、JS/value、VM/WASM 和环境变量。详细字段到行为映射见
`references/ui-parameter-catalog.md`。
