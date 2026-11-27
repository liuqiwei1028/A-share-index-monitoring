#!/usr/bin/env bash
# 服务器端一键更新：拉取最新代码
# 用法：bash /opt/etf-monitor/deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 当前版本：$(git log -1 --format='%h %s')"
git pull --ff-only
echo "==> 更新到：$(git log -1 --format='%h %s')"

# 站点是静态文件，nginx 直接读磁盘，不需要 reload；
# 只有 deploy/nginx-subpath.conf 变过才需要手动同步并 reload nginx。
echo
echo "提示：如果本次改动涉及 scripts/，下一次 cron 会自动用新脚本；"
echo "      如果涉及 index.html / vendor/，浏览器刷新即可（数据文件已禁缓存）。"
