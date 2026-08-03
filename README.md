# 币安监控面板

个人自用的币安新币监控工具：K 线行情图表 + 月度上新统计 + 新币自动邮件提醒。

## 功能

- **行情图表**：日/周/月/时 K 线，成交量、RSI、MACD 指标，历史数据懒加载
- **月度上新统计**：按月份展示币安 U 本位合约新上线的交易对，可直接点击跳转图表
- **新币监控**：后端每 60 秒对比合约交易对清单，发现新上币自动通过 SMTP 发邮件；同时每天拉取币安官方公告补全数据
- **登录保护**：所有接口需 token，设置页可修改密码

## 技术栈

- 前端：Vue 3 + Vite + lightweight-charts
- 后端：Node.js（Express）+ node:sqlite（无需原生依赖）
- 邮件：nodemailer（QQ/163 SMTP）
- 部署：Docker + Docker Compose

## 项目结构

```
binance/
├── server/                       # Node 后端
│   ├── index.js                  # Express 入口、全部 /api 路由、静态托管 dist
│   ├── db.js                     # node:sqlite，listings / settings 表
│   ├── auth.js                   # 登录：密码加盐哈希、token 签发与校验、改密码
│   ├── binance.js                # 服务端直连币安（现货/合约 K 线、交易对清单、公告）
│   ├── monitor.js                # 新币监控：轮询 + 公告补全 + 发信状态
│   └── mailer.js                 # SMTP 发信，配置从 settings 表读取
├── src/                          # Vue 3 前端
│   ├── main.js                   # 入口
│   ├── App.vue                   # 布局、Tab 导航、登录门禁
│   ├── store.js                  # 共享状态（token、当前 Tab、symbol）
│   ├── api/
│   │   ├── http.js               # fetch 封装：自动带 token、401 处理
│   │   ├── monitor.js            # 后端 API（登录/设置/状态/统计）
│   │   └── binance.js            # K 线与搜索 API
│   └── components/
│       ├── Login.vue             # 登录页
│       ├── KlineChart.vue        # 行情图表（OHLC 头、成交量、指标、十字线）
│       ├── ListingsStats.vue     # 月度上新统计
│       └── SettingsPanel.vue     # SMTP 设置、监控状态、修改密码
├── Dockerfile                    # 多阶段构建（node:24-alpine）
├── docker-compose.yml            # 1Panel / Docker Compose 部署配置
├── deploy.sh                     # 服务器部署脚本（pull + 重建容器）
├── vite.config.js                # Vite 配置（/api 代理到 3000）
└── package.json
```

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

- **推荐方式**：在 `docker-compose.yml` 的 `environment.ADMIN_PASS` 中设置密码。`ADMIN_PASS` 每次容器启动都会生效（优先级最高），改它 + 重建容器即可换密码
- **兜底方式**：不设置 `ADMIN_PASS` 时，首次启动自动生成随机密码并写入 `data/INITIAL_PASSWORD.txt`
- 登录后也可在页面「监控设置 → 修改登录密码」中更换（注意：只要 compose 里还留着 `ADMIN_PASS`，下次重建容器会用它的值覆盖页面改的密码，二选一保持一致）
- 换密码后需**重建容器**才生效：`docker compose up -d`（`restart` 不会重新读取环境变量）

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
  git pull --ff-only
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

## 备份与恢复

所有运行数据都在 `data/` 目录（宿主机 `/opt/binance/data/`），包含：

- `app.db`：SQLite 数据库（上新记录、SMTP 设置、密码哈希、监控状态）
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
sqlite3 /opt/binance/data/app.db ".tables"                       # 查看表
sqlite3 /opt/binance/data/app.db "SELECT * FROM settings;"        # 查看配置
sqlite3 /opt/binance/data/app.db "SELECT * FROM listings ORDER BY date DESC LIMIT 20;"  # 查看上新记录
```

> 手动修改数据前请先 `docker compose stop`，改完再启动。
