#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="/opt/miniconda3/envs/pythonProject/bin/python"
PROGRAM="${SCRIPT_DIR}/creator_publish.py"
COOKIE_FILE="${SCRIPT_DIR}/cookie.txt"

VIDEOS=(
  "${SCRIPT_DIR}/test-videos/test-video-1.mp4"
  "${SCRIPT_DIR}/test-videos/test-video-2.mp4"
  "${SCRIPT_DIR}/test-videos/test-video-3.mp4"
)

echo "============================================================"
echo " 测试：稳定性验证 - 任务级 marker"
echo "============================================================"
echo "修改：client_data 固定复用，__security_mc_* 按发布任务轮换"
echo "目标：连续 3 次 create_v2 都返回 HTTP 200"
echo ""

for video in "${VIDEOS[@]}"; do
  if [ ! -f "$video" ]; then
    echo "[检查失败] 视频不存在：${video}"
    exit 1
  fi
done

echo "待发布队列："
index=1
for video in "${VIDEOS[@]}"; do
  echo "  ${index}. $(basename "${video}")"
  index=$((index + 1))
done
echo ""

cd "$SCRIPT_DIR" || exit 1
echo "-------------------- 开始时间：$(date '+%F %T') --------------------"
echo ""

PYTHONUNBUFFERED=1 "$PYTHON" "$PROGRAM" \
  --video-batch "${VIDEOS[@]}" \
  --cookie-file "$COOKIE_FILE" \
  --local-security-runtime "${SCRIPT_DIR}/security-runtime.json" \
  --text "稳定性验证：任务级marker" \
  --visibility-type 1 \
  --download 1 \
  --timing 0 \
  --impersonate chrome136 \
  --retries 2

STATUS=$?
echo ""
echo "-------------------- 结束时间：$(date '+%F %T') --------------------"
if [ "$STATUS" -eq 0 ]; then
  echo "[✅ 成功] 3 次任务全部完成"
else
  echo "[❌ 失败] 退出码：${STATUS}"
fi

exit "$STATUS"
