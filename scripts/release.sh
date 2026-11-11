#!/bin/bash
# 发新版本：bash scripts/release.sh [patch|minor|major]
# 跑测试 → 改版本号（提交并打标签）→ 推送到 GitHub → 发布到 npm。插件市场据 npm 版本提示用户更新。
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP="${1:-patch}"
[ -z "$(git status --porcelain)" ] || { echo "还有没提交的改动，先提交再发版。"; git status --short; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "npm 没登录：先在终端运行 npm login"; exit 1; }
npm test
npm version "$BUMP" -m "发布 %s"
git push --follow-tags
npm publish
echo "已发布 $(node -p "require('./package.json').name")@$(node -p "require('./package.json').version")"
