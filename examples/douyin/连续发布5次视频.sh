#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROGRAM="${SCRIPT_DIR}/creator_publish.py"
COOKIE_FILE="${SCRIPT_DIR}/cookie.txt"
LOG_DIR="${SCRIPT_DIR}/log"

if [ -n "${DOUYIN_PYTHON:-}" ]; then
  PYTHON="${DOUYIN_PYTHON}"
elif [ -x "/opt/miniconda3/envs/pythonProject/bin/python" ]; then
  PYTHON="/opt/miniconda3/envs/pythonProject/bin/python"
elif [ -x "${HOME}/miniconda3/envs/pythonProject/bin/python" ]; then
  PYTHON="${HOME}/miniconda3/envs/pythonProject/bin/python"
else
  PYTHON="$(command -v python3 || true)"
fi

if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 5 ]; then
    echo "用法：$0 视频1 视频2 视频3 视频4 视频5"
    exit 2
  fi
  VIDEOS=("$@")
else
  # 双击演示时使用随目录交付的测试视频；也可从命令行传入任意 5 个路径。
  VIDEOS=(
    "${SCRIPT_DIR}/test-videos/test-video-1.mp4"
    "${SCRIPT_DIR}/test-videos/test-video-2.mp4"
    "${SCRIPT_DIR}/test-videos/test-video-3.mp4"
    "${SCRIPT_DIR}/test-videos/test-video-4.mp4"
    "${SCRIPT_DIR}/test-videos/test-video-1.mp4"
  )
fi

printf '\033[2J\033[H'
echo "============================================================"
echo " 抖音创作者纯本地连续发布 5 次演示"
echo "============================================================"
echo "运行模式：同一 HTTP Session 连续发布"
echo "发布范围：仅自己可见（visibility_type=1）"
echo "允许下载：是（download=1）"
echo "发布时间：立即（timing=0）"
echo "Python：${PYTHON}"
echo "Cookie：${COOKIE_FILE}（内容不会打印）"
echo "日志文件：log/run-5videos-时间.log"
echo

if [ ! -x "$PYTHON" ]; then
  echo "[检查失败] Python 环境不存在：${PYTHON}"
  read -r -p "按回车关闭..." _
  exit 1
fi

for command_name in node ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[检查失败] 未找到 ${command_name}，请安装并加入 PATH。"
    read -r -p "按回车关闭..." _
    exit 1
  fi
done

if ! "$PYTHON" -c 'import curl_cffi, PIL' >/dev/null 2>&1; then
  echo "[首次运行] 正在安装 Python 依赖..."
  if ! "$PYTHON" -m pip install -r "${SCRIPT_DIR}/requirements.txt"; then
    echo "[检查失败] Python 依赖安装失败。"
    read -r -p "按回车关闭..." _
    exit 1
  fi
fi

for required in "$PROGRAM" "$COOKIE_FILE" \
  "${SCRIPT_DIR}/creator-runtime-contract.json" \
  "${SCRIPT_DIR}/security-runtime.json" \
  "${SCRIPT_DIR}/bdms-runner.js" \
  "${SCRIPT_DIR}/assets/bdms_1.0.1.16.js"; do
  if [ ! -f "$required" ]; then
    echo "[检查失败] 缺少文件：${required}"
    read -r -p "按回车关闭..." _
    exit 1
  fi
done

for video in "${VIDEOS[@]}"; do
  if [ ! -f "$video" ]; then
    echo "[检查失败] 视频不存在：${video}"
    read -r -p "按回车关闭..." _
    exit 1
  fi
done

echo "待发布队列："
index=1
for video in "${VIDEOS[@]}"; do
  echo "  ${index}. $(basename "${video}")"
  index=$((index + 1))
done
echo
echo "验收标准：5 个任务全部返回 HTTP 200、status_code=0、item_id。"
echo "create_v2 不自动重试，避免同一作品重复发布。"
echo
read -r -p "确认开始连续发布 5 次？输入 YES：" CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "已取消。"
  read -r -p "按回车关闭..." _
  exit 0
fi

cd "$SCRIPT_DIR" || exit 1
mkdir -p "$LOG_DIR"
RUN_LOG="${LOG_DIR}/run-5videos-$(date '+%Y%m%d-%H%M%S').log"
echo
echo "-------------------- 开始时间：$(date '+%F %T') --------------------"
echo

PYTHONUNBUFFERED=1 "$PYTHON" "$PROGRAM" \
  --video-batch "${VIDEOS[@]}" \
  --cookie-file "$COOKIE_FILE" \
  --text "连续发布稳定性演示" \
  --visibility-type 1 \
  --download 1 \
  --timing 0 \
  --impersonate chrome136 \
  --retries 2 2>&1 | tee "$RUN_LOG"
STATUS=${PIPESTATUS[0]}

echo
echo "-------------------- 结束时间：$(date '+%F %T') --------------------"
if [ "$STATUS" -eq 0 ]; then
  echo "[演示完成] 连续 5 次任务全部执行结束，请核对上方 batch 汇总。"
else
  echo "[演示异常] 进程退出码：${STATUS}，请保留当前终端画面。"
fi
echo
read -r -p "录屏完成后按回车关闭窗口..." _
exit "$STATUS"
