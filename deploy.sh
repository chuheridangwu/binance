#!/usr/bin/env bash
# 服务器部署脚本：拉取最新代码并重建容器（首次需手动执行一次）
set -e
cd /opt/binance
git pull --ff-only
docker compose up -d --build
docker image prune -f
