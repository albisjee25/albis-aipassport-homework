#!/bin/bash
# 把设备固件的最新提交复制到 firmware/（公开仓库里给别人用的那份）。
# 用法：bash scripts/sync-firmware.sh [固件仓库路径] [分支]
# 只复制已提交的文件：hw_secrets.h（含设备令牌）不进 git，所以不会被带出来。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HERE/../ai-passport-homework}"
BRANCH="${2:-feature/homework-helper}"
[ -d "$SRC" ] || { echo "找不到固件仓库：$SRC"; exit 1; }
if [ -n "$(git -C "$SRC" status --porcelain -- . ':!.claude')" ]; then
  echo "固件仓库还有没保存的改动，先提交再同步。"; exit 1
fi
TMP="$(mktemp -d)"
git -C "$SRC" archive "$BRANCH" | tar -x -C "$TMP"
rsync -a --delete "$TMP/" "$HERE/firmware/"
rm -rf "$TMP"
echo "已同步固件：$(git -C "$SRC" log -1 --format='%h %s' "$BRANCH")"
