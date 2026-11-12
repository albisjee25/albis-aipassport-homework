#!/bin/bash
# 发新版本：bash scripts/release.sh [patch|minor|major]
# 先在 package.json 的 homeworkHelper.releaseNotes 里写好新版本的更新日志（zh/en，数组最前面）——
# 插件页的更新横幅就是显示这段。然后：跑测试 → 改版本号并打标签 → 推送 GitHub。
# 最后一步 npm publish 要登录并两步验证（浏览器确认），只能你在终端里自己运行，脚本会提示命令。
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP="${1:-patch}"
[ -z "$(git status --porcelain)" ] || { echo "还有没提交的改动，先提交再发版。"; git status --short; exit 1; }
NEXT="$(node -e "
const [a,b,c]=require('./package.json').version.split('.').map(Number);
const t=process.argv[1];console.log(t==='major'?[a+1,0,0].join('.'):t==='minor'?[a,b+1,0].join('.'):[a,b,c+1].join('.'))" "$BUMP")"
node -e "
const n=(require('./package.json').homeworkHelper||{}).releaseNotes||[];
const e=n.find(x=>x.version===process.argv[1]);
if(!e||!e.zh||!e.en){console.error('package.json 的 homeworkHelper.releaseNotes 里还没有 '+process.argv[1]+' 的更新日志（要有 zh 和 en），先写好再发版。');process.exit(1)}" "$NEXT"
npm test
npm version "$BUMP" -m "发布 %s"
git push --follow-tags
echo
echo "GitHub 已更新到 v$NEXT。最后一步请你在终端运行（要在浏览器里确认）："
echo "  cd \"$(pwd)\" && npm publish --access public"
