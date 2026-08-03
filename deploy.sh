#!/usr/bin/env bash
# 部署脚本：拉取最新代码并重建容器（手动执行一次 + 1Panel 计划任务调用）
set -e
cd /opt/binance
export PATH="$PATH:/usr/local/bin:/usr/bin"

git pull --ff-only

# 兼容 docker compose 与 docker-compose 两种写法
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
else
  docker-compose up -d --build
fi

docker image prune -f >/dev/null 2>&1 || true
echo "[deploy] $(date '+%F %T') 部署完成"
