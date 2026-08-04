# 币安监控面板

个人自用的币安监控工具：K 线行情图表 + 指标选股 + 月度上新统计 + 新币/套利自动邮件提醒。

## 功能

- **行情图表**：15分/1小时/4小时/日 K 线，成交量、RSI、MACD、EMA 指标，历史数据滚动懒加载
- **指标参数自定义**：RSI 周期、MACD 快/慢/信号线、EMA 周期均可在工具栏直接改
- **指标选股**：一键全量扫描 USDT 永续合约（约 400+），按 5 条技术规则筛选，支持「任一 / 全部」匹配切换，命中结果矩阵表展示、点击跳行情；内置限速与缓存防币安封 IP
- **套利监控**：永续/现货价差 + 当前资金费率 + 年化资金费率，一键刷新、点击跳行情；超过阈值自动邮件提醒（每 5 分钟扫描，每币每天一次）
- **月度上新统计**：统计卡片（总/今年/本月/近30天）、每月上币量柱状图、上新高峰 Top5、年度对比，点击可直接跳转图表
- **新币监控**：后端每 60 秒对比合约交易对清单，发现新上币自动通过 SMTP 发邮件；同时每天拉取币安官方公告补全数据
- **登录保护**：所有接口需 token，设置页可修改密码

## 技术栈

- 前端：Vue 3 + Vite + lightweight-charts
- 后端：Node.js（Express）+ node:sqlite（无需原生依赖）
- 缓存：K 线 / OI / 合约列表 SQLite 持久化缓存（重启不丢、防重复拉取）
- 限流：内置币安全局请求限速器 + 429/418 自动退避，防止触发 IP 封禁
- 邮件：nodemailer（QQ/163 SMTP）
- 部署：Docker + Docker Compose

## 项目结构

```
binance/
├── server/                       # Node 后端
│   ├── index.js                  # Express 入口、全部 /api 路由、静态托管 dist
│   ├── db.js                     # node:sqlite：listings / settings / kline_cache / oi_cache 表
│   ├── cache.js                  # 行情缓存读写：K线/OI，TTL 失效 + 30 天过期清理
│   ├── auth.js                   # 登录：密码加盐哈希、token 签发与校验、改密码
│   ├── binance.js                # 服务端直连币安 + 全局限速器(429退避)（现货/合约 K 线、OI、交易对清单、公告）
│   ├── screener.js               # 指标选股：全量扫描、5 规则计算、进度状态
│   ├── spread.js                 # 套利数据：永续资金费率 + 现货/永续价差计算
│   ├── monitor.js                # 新币监控 + 套利提醒：轮询、公告补全、发信状态
│   └── mailer.js                 # SMTP 发信，配置从 settings 表读取
├── src/                          # Vue 3 前端
│   ├── main.js                   # 入口
│   ├── App.vue                   # 布局、Tab 导航、登录门禁
│   ├── store.js                  # 共享状态（token、当前 Tab、symbol）
│   ├── api/
│   │   ├── http.js               # fetch 封装：自动带 token、401 处理
│   │   ├── monitor.js            # 后端 API（登录/设置/状态/统计/选股）
│   │   └── binance.js            # K 线与搜索 API
│   └── components/
│       ├── Login.vue             # 登录页
│       ├── KlineChart.vue        # 行情图表（OHLC 头、成交量、可自定义指标、十字线）
│       ├── ScreenerPanel.vue     # 指标选股面板（规则勾选、匹配切换、结果矩阵、进度）
│       ├── SpreadPanel.vue       # 套利监控面板
│       ├── ListingsStats.vue     # 月度上新统计 + 可视化
│       └── SettingsPanel.vue     # SMTP 设置、套利提醒、监控状态、修改密码
├── Dockerfile                    # 多阶段构建（node:24-alpine）
├── docker-compose.yml            # 1Panel / Docker Compose 部署配置
├── deploy.sh                     # 服务器部署脚本（pull + 重建容器）
├── vite.config.js                # Vite 配置（/api 代理到 3000）
└── package.json
```

## 指标选股（全量 USDT 永续合约）

「指标选股」标签下点「开始扫描」，后端会对币安全部 USDT 永续合约（约 400+）拉取日线，按勾选的规则筛选，命中结果以矩阵表展示（绿色=命中，OI 列始终显示数值与涨跌箭头），点击行可跳转行情图表。

支持 **「任一满足 / 全部满足」** 两种匹配逻辑切换。

| 规则 | 判定条件 |
|------|----------|
| RSI(6) 一周内 ≥ 80 | 近 7 根日K中任意一根 RSI(6) ≥ 80 |
| 3日内创新高 + RSI 顶背离 | 近 3 天价格创 60 天新高，且新高处 RSI(6) 低于前高处取值 |
| 价格 ≥ 布林带上轨 | 收盘价站上布林带 (20, 2) 上轨 |
| OI 持续增加 | 永续未平仓合约量近 5 天净增，且至少 3 天上升 |
| 单日量 > 近7日总和 | 最近一根日K成交量大于之前 7 天之和 |

### 防封号 / 限流保护

一次性全量拉 400+ 合约容易被币安限频（HTTP 429）甚至封 IP（HTTP 418），项目内置三重保护：

- **全局限速器**：同一时刻最多 4 个在途请求，相邻请求间隔 180ms，宁可扫描慢也不打爆
- **429/418 自动退避**：按 `retry-after` 冷却后重试，重试耗尽返回明确报错
- **SQLite 行情缓存**：K 线缓存 1 小时、OI 缓存 10 分钟、合约列表 30 分钟，全部落盘 `data/app.db`；重复扫描与重启后直接复用、几乎零 API 消耗，30 天前的旧数据自动清理

首次全量扫描约需 **2-4 分钟**（受限速保护）；之后一小时内再扫基本走缓存，几秒完成。扫描中前端实时显示进度与命中数。

## 开始使用

### 本地开发

```bash
npm install
npm run server   # 后端 :3000（另开一个终端）
npm run dev      # 前端 :5173，/api 自动代理到 3000
```

### 服务器部署（Docker）

```bash
# 1. 克隆到服务器（需已安装 Docker，1Panel 自带）
cd /opt && git clone https://github.com/chuheridangwu/binance.git && cd binance

# 2. 首次部署
bash deploy.sh

# 3. 开放 3000 端口
#    云控制台安全组放行 TCP 3000，再在 1Panel「防火墙」放行
```

浏览器访问 `http://服务器IP:3000`。

### 登录密码

- **首次启动**：`ADMIN_PASS` 作为初始密码，写在 `/opt/binance/.env`（推荐）或环境变量；留空则自动生成并写入 `data/INITIAL_PASSWORD.txt`
- **之后修改**：一律用页面「监控设置 → 修改登录密码」，保存即生效、重启不会被覆盖
- 忘记密码时：停容器后在数据库删除该键再启动，会重新生成：
  ```bash
  docker compose stop
  sqlite3 /opt/binance/data/app.db "DELETE FROM settings WHERE key='admin_pass';"
  docker compose up -d
  ```

> **重要**：不要把 `ADMIN_PASS` 直接写进 `docker-compose.yml`。该文件被 git 跟踪，服务器上手动改它会导致 `git pull` 永久失败、自动部署每分钟重复重建（详见下方自动更新章节）。密码请写到 gitignore 的 `.env` 文件里：`echo 'ADMIN_PASS=你的密码' > /opt/binance/.env`

### 配置 SMTP 邮件

打开页面 →「监控设置」标签：

| 字段 | 说明 | 示例 |
|------|------|------|
| SMTP 服务器 | 邮箱 SMTP 主机 | `smtp.qq.com` / `smtp.163.com` |
| 端口 | QQ/163 用 465 | `465` |
| 发件邮箱 | 你的邮箱 | `xxx@qq.com` |
| SMTP 授权码 | 邮箱设置中生成的授权码（非登录密码） | 16 位字符串 |
| 收件人 | 多个用逗号分隔 | `a@qq.com, b@163.com` |

QQ 邮箱需先在网页版「设置 → 账户 → 开启 POP3/SMTP 服务」获取授权码。保存后可点「发送测试邮件」验证。

## 自动更新（git push 后服务器自动部署）

不开放 22 端口，采用 1Panel 计划任务每 1 分钟轮询，检测到远程有新提交才重建。

**1Panel 操作**：计划任务 → 新建 → 类型 **Shell 脚本** → 周期 **每 1 分钟**，内容：

```bash
cd /opt/binance || exit 1
git fetch origin main >/dev/null 2>&1
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  # 丢弃被 git 跟踪文件的本地改动（本地配置都在 .env 和 data/，均被 gitignore，不会受影响）
  git checkout -- . 2>/dev/null || true
  if ! git pull --ff-only; then
    echo "[deploy] $(date '+%F %T') git pull 失败，跳过本次部署"
    exit 1
  fi
  export PATH="$PATH:/usr/local/bin:/usr/bin"
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d --build
  else
    docker-compose up -d --build
  fi
  docker image prune -f >/dev/null 2>&1 || true
  echo "[deploy] $(date '+%F %T') 部署完成"
else
  echo "[poll] 无更新，跳过"
fi
```

之后本地 `git push`，1 分钟内服务器自动 `git pull` + 重建容器，执行日志可在 1Panel 计划任务中查看。

> **排查提示**：如果日志里出现 `Your local changes ... would be overwritten by merge` 并伴随「无更新却反复构建」，说明服务器上有被跟踪文件的本地改动（通常是手动改了 `docker-compose.yml`）。先手动清理：`cd /opt/binance && git checkout -- .`，再把 `ADMIN_PASS` 移到 `.env`，下次 push 即可恢复正常。

## 备份与恢复

所有运行数据都在 `data/` 目录（宿主机 `/opt/binance/data/`），包含：

- `app.db`：SQLite 数据库（上新记录、SMTP 设置、密码哈希、监控状态、行情缓存、扫描结果）
- `INITIAL_PASSWORD.txt`：初始登录密码

### 手动备份

```bash
# 一键打包（建议配合 1Panel 计划任务定时执行）
cd /opt && tar -czf binance-backup-$(date +%Y%m%d).tar.gz binance/data
```

### 定期自动备份

1Panel → 计划任务 → 新建 → 类型 **Shell 脚本**，周期 **每 7 天**：

```bash
cd /opt
tar -czf /opt/backup/binance-data-$(date +%Y%m%d).tar.gz binance/data
find /opt/backup -name "binance-data-*.tar.gz" -mtime +30 -delete   # 只保留 30 天
```

注意先建目录：`mkdir -p /opt/backup`。

### 迁移 / 恢复

```bash
# 新服务器
cd /opt && git clone https://github.com/chuheridangwu/binance.git && cd binance
docker compose up -d --build

# 解压数据到容器挂载目录
tar -xzf /opt/binance-backup-XXXX.tar.gz -C /opt
# 若 tar 的顶层是 binance/data，则解压后路径即 /opt/binance/data，重启生效
docker compose restart
```

SMTP 配置、密码、上新记录都在 `app.db` 里，拷完数据即全部恢复。

## 查看数据库

```bash
apt install -y sqlite3        # 宿主机安装 sqlite3
sqlite3 /opt/binance/data/app.db ".tables"                       # 查看所有表
sqlite3 /opt/binance/data/app.db "SELECT * FROM settings;"        # 查看配置
sqlite3 /opt/binance/data/app.db "SELECT * FROM listings ORDER BY date DESC LIMIT 20;"            # 查看上新记录
sqlite3 /opt/binance/data/app.db "SELECT symbol, COUNT(*) FROM kline_cache GROUP BY symbol LIMIT 5;"  # 查看已缓存 K 线
sqlite3 /opt/binance/data/app.db "SELECT symbol, oi, oi_value FROM oi_cache ORDER BY time DESC LIMIT 5;" # 查看 OI 缓存
```

> 手动修改数据前请先 `docker compose stop`，改完再启动。
