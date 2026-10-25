# Collector v2 本地回归交付

本目录交付通用采集器改进及纯 Python 离线证据校验器；没有实现公开站点的 Cloudflare 验证链。
旧用户输入 `examples/cell/traces/round1`、`round2-values`、`profiles/round2-values` 和旧运行时均保留。

## 已执行结果

- 50 个 Trace 回归测试、1 个文档同步测试通过。
- 修改后的 C++/IPDL 已编译链接，独立运行时已签名；有头本地测试完成后再次验证签名通过。
- 同一份 `value-stress.html`：48 次有限循环均完成，三组 ASCII / NUL / 中文 emoji 原值逐字节相等。
- 检查全部 15 个 JS 引用制品的存在、长度、SHA-256；错误数 0。
- cookie 目标之后、没有后续网络 sink 的尾调用保留 2 个引用；匹配版本/hash 的全部已推送子进程 ACK 已到达。
- JS 原始日志：3,770,800 → 250,447 bytes（缩小 93.358%）。
- 本地页面用时：1707 → 1724 ms；最大心跳间隔：412 → 429 ms。
  **没有证明延迟加速**；当前证明的是日志体积改善和指定证据完整性，最后一次心跳验收阈值为 1000 ms。

## 改动

1. 完整字符串保存在内容寻址 artifact；成功提交后，重复 JSON 预览正文默认最多 512 字节，另有 `...` 标记。
2. 有界精确发送缓存，碰撞只重传，不误判命中；仅在提交成功后记忆，切换目录/segment 重置。
3. 字符串使用显式 UTF-8 长度，不再用 `strlen` 丢失 NUL 后的字节；预览不切断 UTF-8 码点。
4. 主线程尾批次经专用父进程排空消息写盘，后续 ACK 走同一通道；排空复用既有批量 IPC 的保留前缀，不改变 PContent 协议、消息数字 ID 或虚表。
5. 看门狗不再接受无关子进程的单个 ACK 替代全部已推送进程；缺 ACK 仍整理日志，但目标命中退出码为 6。
6. 安装器优先取真实链接产物 `dist/bin/XUL`，避免“编译成功却装入旧 app 内 XUL”。

## 重现与文件

通用 UI 配置：`/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/collector-v2/agent-next.json`。初始页面为 `about:blank`，不会自动访问既有公开目标；使用前填入本地页面及目标字段。
配置已通过真实桌面加载器的 Tcl 回归，见 `config-verification.json`。

仅用 Python 标准库验证保留样本，不启动浏览器、不依赖 Node、不发网络请求：

```sh
python3 -B '/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/collector-v2/verify_local.py' --verify-trace '/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/collector-v2/runs/validated/portable'
```

退出码 0 表示这个合成样本的完整值、原始 JS 行、源文件清单及尾部引用均满足验收。
旧版缺失样本和篡改样本均返回 1，真实 stdout/stderr 见 `offline-verification.json`。

再次有头验证（LABEL 必须是未使用的新名称，自带 120 秒/2 GiB 看门狗）：

```sh
python3 -B '/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/collector-v2/verify_local.py' --runtime '/Users/empycity/Desktop/JS-tools/firefoxTrace/examples/cell/collector-v2/runtime/Nightly.app/Contents/MacOS/firefox' --label LABEL --expect-new
```

## 修改、差异、回滚

- `modified/`：17 个最终源码文件快照；`source-manifest.json` 记录前后哈希。
- `DIFF.patch`：从本轮开始前的工作树重建本轮修改，不覆盖此前已有改动。
- `ROLLBACK.sh`：校验当前文件仍等于交付哈希后恢复源码；后续人工修改会导致预检中止。
- `rollback-verification.json`：在独立副本上恢复源码、检查原哈希、重打差异、检查交付哈希，17 个文件全部一致。
- 回滚仅作用源码；构建目录与独立运行时不随之还原。旧 `examples/cell/runtime/Nightly.app` 未被覆盖，可用于运行时回退。

## 证据范围与未完成项

这不是任意网页永不卡顿、全部执行指令可见或所有 Worker 零丢失的保证。JIT 可见范围保持原行为；
Worker 尾批次、在途 artifact、磁盘失败和更长时间高负载仍需独立验证。
只在成功提交完整制品后缩短预览；提交成功也不等于磁盘已持久化，必须最终逐个核对文件。

保留的 `runs/*/portable/` 含每个原始 JS 行、全部 JS value 引用、源 dump 及启动清单，
独立校验与源 trace 结果一致后才清理自建 full trace/profile。DOM/network 流不在便携样本内；
`source-trace-health.json` 仅是原完整 trace 的审计记录，不能冒充便携样本包含那些流。
已失败的旧安装/直接写盘实验保留日志和负对照，未冒充通过。清理记录见 `artifact-cleanup.json`、`process-cleanup.json`。

本轮创建并清理的七组运行以 `portable-receipts.json` 为准；并行生成的 `runs/treatment` 不是本轮创建的输出，保持原状。
