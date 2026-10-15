# 异机编译与中控台部署

本文从一台干净的 macOS 设备开始，使用仓库中的 Gecko patch 构建 Firefox Trace，安装可运行的浏览器 bundle，并启动桌面中控台。仓库不包含完整 `gecko-dev` 源码、Firefox 二进制、编译缓存或机器专属 `.mozconfig`；这些内容在每台设备本地生成。

## 交付清单

- `patches/gecko-base-commit.txt`：patch 对应的 Gecko 基线 commit。
- `patches/gecko-firefox-trace.patch`：Firefox Trace Gecko 源码改动。
- `tools/bootstrap-trace.sh`：checkout、应用 patch、编译和安装入口。
- `tools/install-trace-runtime.sh`：生成可搬移、ad-hoc 签名的 Nightly app bundle。
- `Firefox Trace Console.app`、`tools/trace-desktop.py`：桌面中控台。
- `tools/run-trace-firefox.sh`、`tools/trace-control.sh`：浏览器启动与采集热控制入口。

## 支持范围

当前一键安装及桌面中控交付流程面向 macOS。Apple Silicon 和 Intel 应分别在目标设备本机编译；不要跨架构复制 `obj-*` 构建目录。Linux/Windows 的 Gecko patch 可另行评估，但本手册的 app bundle 安装和签名步骤不适用。

## 1. 获取仓库

先将已推送的仓库克隆到本机：

```bash
git clone <REPOSITORY_URL> firefoxTrace
cd firefoxTrace
git status --short --branch
```

工作树应干净。构建目录默认位于仓库的 `gecko-dev/`，Mozilla 编译状态默认位于 `.mozbuild/`；两者均在 `.gitignore` 中，不会推入仓库。

## 2. 安装构建前置依赖

按 Mozilla 官方 macOS build prerequisites 安装 Xcode Command Line Tools、系统 SDK 和编译工具，并接受 Xcode license。还需准备可用的 Rust toolchain、Python 3、Node.js、`cbindgen` 和 `lld`。实际版本要求会随 Gecko 基线变化，应以该基线的 Mozilla 构建文档和 `./mach bootstrap` 检查结果为准。

常见的本机检查：

```bash
xcode-select -p
xcrun --show-sdk-path
rustc --version
cargo --version
python3 --version
node --version
cbindgen --version
ld.lld --version
```

缺少 Rust 时可用 rustup 安装 stable toolchain。若 `cbindgen` 或 `lld` 不在 `PATH`，将其安装目录加入 `PATH`；不要沿用其他机器 `.mozconfig` 里的绝对路径。

Mozilla 官方说明：<https://firefox-source-docs.mozilla.org/setup/macos_build.html>。

## 3. Checkout Gecko 并应用 patch

仓库提供的快捷入口：

```bash
tools/bootstrap-trace.sh --prepare
```

默认会克隆 `https://github.com/mozilla/gecko-dev.git` 到 `./gecko-dev`，checkout `patches/gecko-base-commit.txt` 指定的 commit，再以 `git apply --index` 应用 patch。首次 clone 和 Gecko 构建需要较多磁盘空间与网络流量。

需要更改目录或 Gecko fork 时：

```bash
GECKO_DIR="$HOME/src/gecko-dev" \
GECKO_REPO="https://github.com/mozilla/gecko-dev.git" \
tools/bootstrap-trace.sh --prepare
```

已有 checkout 必须没有其他本地改动。脚本发现 dirty 工作树会停止，以免覆盖已有工作；若 patch 已应用，会识别并保留当前 index。手动核验 patch：

```bash
git -C "$GECKO_DIR" rev-parse HEAD
git -C "$GECKO_DIR" diff --cached --stat
git -C "$GECKO_DIR" apply --reverse --check patches/gecko-firefox-trace.patch
```

基线必须等于 `patches/gecko-base-commit.txt`。反向 `apply --check` 成功表示 patch 当前已应用。

## 4. 配置本机 `.mozconfig`

`.mozconfig` 是 Gecko 源码目录中的本机配置，不放入仓库。使用下面的浏览器构建选项，并让 `CBINDGEN` 指向本机可执行文件：

```bash
cd "$GECKO_DIR"
cat > .mozconfig <<EOF
ac_add_options --enable-application=browser
ac_add_options --enable-linker=lld
ac_add_options --disable-bootstrap
ac_add_options --without-wasm-sandboxed-libraries
ac_add_options --disable-gecko-profiler
export CBINDGEN="$(command -v cbindgen)"
EOF
```

确认 `cbindgen` 路径存在且可执行：

```bash
test -x "$(command -v cbindgen)"
cat .mozconfig
```

如果基线要求不同选项，先运行 `./mach bootstrap` 并按其提示安装缺少的系统依赖；不要复制开发机中的 `obj-*`、`.mozbuild` 或绝对路径配置。

## 5. 编译

可以使用 bootstrap 一步执行：

```bash
cd /path/to/firefoxTrace
tools/bootstrap-trace.sh --build
```

或在 Gecko 目录手动编译：

```bash
cd "$GECKO_DIR"
source "$HOME/.cargo/env" 2>/dev/null || true
export MOZBUILD_STATE_PATH="/path/to/firefoxTrace/.mozbuild"
export MACH_TELEMETRY_DISABLED=1
export PATH="/opt/homebrew/opt/lld/bin:$PATH"  # 修改为本机 lld 目录
python3 ./mach build
```

Apple Silicon 和 Intel 的输出目录名由 Gecko 自动生成，可用以下命令定位：

```bash
find "$GECKO_DIR"/obj-*/dist/Nightly.app/Contents/MacOS -maxdepth 1 -name firefox -print
```

## 6. 安装可运行 app bundle

完整自动流程：

```bash
cd /path/to/firefoxTrace
tools/bootstrap-trace.sh --install
```

`--install` 会先确保 patch 准备完成、执行编译，再把构建 app 安装到默认位置 `firefoxTrace/firefox-trace-runtime/Nightly.app`，物化指向构建目录的 bundle symlink，生成隔离的 FirefoxTrace app manifest，并 ad-hoc 签名和校验 bundle。

自定义路径：

```bash
GECKO_DIR="$HOME/src/gecko-dev" \
MOZBUILD_STATE_PATH="$HOME/.cache/firefox-trace/mozbuild" \
FIREFOX_TRACE_RUNTIME_APP="$HOME/Applications/FirefoxTrace/Nightly.app" \
tools/bootstrap-trace.sh --install
```

安装完成后验证版本和签名：

```bash
"$FIREFOX_TRACE_RUNTIME_APP/Contents/MacOS/firefox" --version
codesign --verify --deep --strict "$FIREFOX_TRACE_RUNTIME_APP"
```

首次启动若 macOS 对未公证的本机 ad-hoc app 显示确认提示，在系统设置中允许该本地构建；本构建不是 Mozilla 发布签名版本。

## 7. 启动中控台

仓库根目录的 `Firefox Trace Console.app` 是启动器，不携带 Firefox 二进制。它会查找同仓库 `firefox-trace-runtime/Nightly.app`，也可显式指定位置：

```bash
FIREFOX_TRACE_ROOT="$PWD" \
FIREFOX_TRACE_RUNTIME_ROOT="$FIREFOX_TRACE_RUNTIME_APP/.." \
open "Firefox Trace Console.app"
```

也可以直接从终端运行：

```bash
FIREFOX_TRACE_ROOT="$PWD" \
FIREFOX_TRACE_RUNTIME_ROOT="$FIREFOX_TRACE_RUNTIME_APP/.." \
tools/trace-desktop.sh
```

中控打开后填写目标 URL 和输出目录，选择采集模块，使用“打开网站（暂停记录）”准备页面，然后开始记录并执行操作，最后停止并整理。命令行入口可用于无 GUI 或排障：

```bash
FIREFOX_BIN="$FIREFOX_TRACE_RUNTIME_APP/Contents/MacOS/firefox" \
TRACE_DIR="$HOME/Desktop/firefox-trace-output" \
tools/run-trace-firefox.sh --trace-plan full-chain --trace-start paused \
  'https://example.invalid/'
```

对运行中的 trace 可热控：

```bash
tools/trace-control.sh "$TRACE_DIR" status
tools/trace-control.sh "$TRACE_DIR" start target-action
tools/trace-control.sh "$TRACE_DIR" stop after-target
```

## 8. 验收

至少完成以下检查：

```bash
git status --short --branch
git -C "$GECKO_DIR" rev-parse HEAD
git -C "$GECKO_DIR" apply --reverse --check patches/gecko-firefox-trace.patch
"$FIREFOX_TRACE_RUNTIME_APP/Contents/MacOS/firefox" --version
codesign --verify --deep --strict "$FIREFOX_TRACE_RUNTIME_APP"
tools/run-trace-firefox.sh --help
tools/trace-control.sh
```

然后从中控执行一轮本地 smoke 页面，例如 `tests/trace-env-contract-frame.html`，停止并整理，确认 `manifest.json`、`index/summary.json` 和至少一个预期 JSONL trace 文件生成。每种 macOS/CPU 架构第一次部署都应实际完成这轮验收；仅成功应用 patch 不等同于编译和运行已验证。

## 常见问题

- `Patch does not apply cleanly`：确认 checkout 是 `patches/gecko-base-commit.txt` 中的基线，且 Gecko 工作树没有其他改动。
- 找不到 `CBINDGEN`：检查 `command -v cbindgen`，将其安装并重建 `.mozconfig`。
- 找不到 `ld.lld`：安装 LLVM/lld 并将实际目录加入 `PATH`。
- `mach build` 报 SDK 或编译器缺失：按对应 macOS 版本的 Mozilla 官方 prerequisites 安装 Xcode、SDK 和命令行工具，再运行 `./mach bootstrap`。
- 中控提示找不到 Firefox：设置 `FIREFOX_TRACE_RUNTIME_ROOT` 为包含 `Nightly.app` 的目录，或在 UI 中填写 Firefox 可执行文件路径。
- 中控没有窗口：查看 `/private/tmp/firefox-trace-desktop.log`，确认所选 Python 带 Tkinter；系统 Python 缺少 Tk 时安装带 Tk 的 Python 并设置 `FIREFOX_TRACE_PYTHON`。
- 更新 patch 后重建：先确保 Gecko checkout 干净，再运行 `tools/bootstrap-trace.sh --prepare`、`--install`。不要在带本机改动的 Gecko 目录强制切换基线。
