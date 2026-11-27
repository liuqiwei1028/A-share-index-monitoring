#!/usr/bin/env bash
# 一键部署脚本：在服务器上解压后执行 bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

WEB_PORT="${WEB_PORT:-8080}"
export WEB_PORT

echo "==> 1/4 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    echo "    未安装 Docker，正在用官方脚本安装…"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker || true
  else
    echo "    未安装 Docker。请用 root 执行本脚本，或先手动安装："
    echo "    curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
fi
docker compose version >/dev/null 2>&1 || { echo "    需要 docker compose v2 插件（docker-compose-plugin）"; exit 1; }
echo "    OK $(docker --version)"

echo "==> 2/4 构建并启动容器"
docker compose up -d --build

echo "==> 3/4 等待服务就绪"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
    echo "    站点已响应"
    break
  fi
  sleep 2
  if [ "$i" = "15" ]; then
    echo "    站点暂未响应，查看日志： docker compose logs --tail=50 web"
  fi
done

echo "==> 4/4 当前状态"
docker compose ps

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "==============================================="
echo " 访问地址： http://${IP:-<服务器IP>}:${WEB_PORT}"
echo " 手动更新： docker compose exec updater node scripts/fetch.mjs --daily"
echo " 更新日志： tail -f data/update.log"
echo " 定时任务： docker compose logs -f updater"
echo "==============================================="
echo "提示：如果打不开，请在云厂商安全组里放行 ${WEB_PORT} 端口。"
