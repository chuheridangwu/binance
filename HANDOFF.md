# HANDOFF（交接文档）

> 本文件用于让一个**完全没有上下文的新对话**快速接手本项目。若你是新会话，请先读完本文件，再结合仓库代码继续工作。

## 0. 如何读懂本文件

- 本项目是一个个人自用的**币安监控面板**（Web 应用），位于 `/Users/sky/Desktop/binance`（本机为 mac，仓库远端为 GitHub）。
- 每次改完代码后 **必须自动推送** 到 GitHub：`git add . && git commit -m "..." && git push origin main`（已与用户约定，无需每次再问）。
- 服务器部署：服务器上 1Panel 每 1 分钟轮询 GitHub，检测到新提交才 `git pull` + `docker compose up -d --build`。提交后约 1 分钟自动生效。
- **多轮次项目**：目标是「指标选股」功能从零到上线+后续打磨。环境受限（见「卡点」），大量逻辑靠 stub fetch 验证，未做线上实测。

---

## 1. 我们在做什么任务

为币安监控面板新增并完善 **「指标选股」（Screener）** 功能：一键全量扫描币安 **USDT 永续合约（约 400+ 个）**，按 5 条技术指标规则筛选出候选币种，结果以矩阵表展示并支持点击跳转行情图。

5 条规则（定义见 `server/screener.js` 的 `RULES`）：

| 编号 | 规则 | 判定条件 |
|------|------|----------|
| R1 | RSI(6) 一周内 ≥ 80 | 近 7 根日K中任意一根 RSI(6) ≥ 80 |
| R2 | 3日内创新高 + RSI 顶背离 | 近 3 天价格创 60 天新高，且新高处 RSI(6) 低于前高处取值 |
| R3 | 价格 ≥ 布林带上轨 | 收盘价站上布林带 (20, 2) 上轨 |
| R4 | OI 持续增加 | 未平仓合约量近 5 天净增，且至少 3 天上升（已放宽，见「完成」） |
| R5 | 单日量 > 近7日总和 | 最近一根日K成交量大于之前 7 天之和 |

配套要求：面板上可勾选哪些规则命中、可切换 **「任一满足 / 全部满足」** 匹配逻辑；**全量扫描（只扫 USDT 永续，不做自选池限制）**；头部限速防币安封 IP（用户明确首要目标是别被封号）。

---

## 2. 我们已经完成了什么（全部已提交并推送）

功能完整可用，已合入 main 并推送（当前 HEAD 为 `a1e18f0`，README 完善版）：

### 后端
- `server/binance.js`
  - 新增 `getPerpetualSymbols()`（合约列表）、`getFuturesKlinesInterval()`（期货 K 线）、`getOpenInterestHistory()`（日级 OI）。已接入 **SQLite 持久化缓存**（读缓存优先，冷启动实测 0 次 fetch）。
  - **全局限速器**：`maxConcurrent=4`、`minIntervalMs=180`。`acquire()` 已修复原子抢占 bug（原先 8 个并发调用者会同时读到 `nextSlot=0`，导致并发突破上限），实测并发=1、间隔=180ms。
  - **429/418 自动退避**：按 `retry-after` 冷却重试，重试耗尽抛出明确错误。实测通过。
- `server/screener.js`：全量扫描逻辑、5 条规则 `checkR1~checkR5`、进度状态对象、`scan-results.json` 落盘。
- `server/cache.js`：缓存读写模块。TTL：K 线 1 小时、OI 10 分钟、合约列表 30 分钟；30 天前旧数据自动清理；UPSERT 事务写入。
- `server/db.js`：新增 `kline_cache` / `oi_cache` 两张表（含 BLOB 存 K 线、字段 + 索引）。
- `server/index.js`：新增路由 `GET /api/screener`（返回结果）、`POST /api/screener`（触发扫描）、`GET /api/screener/status`（进度/命中数）。

### 前端
- `src/api/monitor.js`：新增 `startScreener()` / `screenerStatus()` / `fetchScreenerResults()`。
- `src/components/ScreenerPanel.vue`：新建面板（规则勾选、任一/全部切换、进度条、命中矩阵表、点击行跳行情、重跑按钮）。
- `src/App.vue`：新增 Tab「指标选股」。

### 部署与文档
- `docker-compose.yml`：`ADMIN_PASS` 改为 `${ADMIN_PASS:-}`，从 gitignore 的 `.env` 读取。
- `README.md`：完善新增功能、限流/缓存说明、项目结构、规则表、数据表查询示例。
- `HANDOFF.md`：本文件。

### 踩过的坑的修复记录（对应第 5 节）
- `checkR5` 曾因 `n<9` 越界空数组崩，改为 `n<8` 提前返回 false。
- `fmtPrice` / `fmtOi` 函数曾在面板重构中被误删 → 界面报「fmtPrice is not defined」，已补回。
- R4 原判定「5 天连续严格递增」几乎永不命中、OI 列总是全空 → 放宽为「netUp（末日>首日）&& upCount>=3」，且 **OI 列未命中也显示数值 + 涨跌箭头（↑/↓/→）**，命中才绿色。

---

## 3. 当前卡在哪（关键！）

1. **服务器仍跑旧代码，未完成一次性清理。**
   用户服务器 `/opt/binance` 曾被手动改过被 git 跟踪的 `docker-compose.yml`（塞了明文 ADMIN_PASS）。这导致 `git pull` 永远报 "local changes would be overwritten"，自动部署脚本却 `|| true` 继续重建 → **每 1 分钟重复空重建**，且 HEAD 永远不退，最新功能全部不生效。
   **服务器侧尚未执行清理**，后续所有提交（含 OI 修复、fmtPrice、README）在服务器上都不会生效，改密码问题（旧 initAdminPass 每次启动用 ADMIN_PASS 覆盖库内密码）也不会解决。

2. **本机无法访问币安 API 做线上实测。**
   `curl https://api.binance.com` / `https://fapi.binance.com` 都返回 **HTTP 000**（网络/地域限制）。因此全量扫描、OI 真实数据、限流在真实环境的表现**从未实测**，只用 stub fetch + 合成数据在单元级验证过。

3. **推送/网络不稳定。**
   本机 GitHub 网络偶发超时（HTTP2 framing layer、连接 443 超时）。push 卡住时可重试，或 `git -c http.version=HTTP/1.1 push` 强制 HTTP/1.1。

4. **测试期间删除过 `data/app.db`**（gitignore）。下次本地启动会重新建库并生成新初始密码（`data/INITIAL_PASSWORD.txt`），旧 SMTP 配置、密码、上新记录丢失。服务器上的库不受影响。

---

## 4. 下一步计划是什么（按优先级）

1. **让用户完成服务器一次性清理**（这是解除一切服务器卡点的前提）：

   ```bash
   cd /opt/binance
   # 若之前把 ADMIN_PASS 写进了 docker-compose.yml，先迁到 .env
   grep -n ADMIN_PASS docker-compose.yml
   echo 'ADMIN_PASS=你的真密码' > /opt/binance/.env
   git checkout -- .          # 丢弃被跟踪文件的本地改动（本地配置都在 .env 和 data/，均 gitignore，不受影响）
   ```
   然后确认 1Panel 计划任务的 shell 脚本是 README「自动更新」章节的新版（含 `git checkout -- .` 与 `if ! git pull --ff-only; then exit 1`）。等下一次 cron 拉到最新提交并重建。

2. **部署后由用户实测线上扫描**：确认 OI 列有值、扫描不报 429/418、结果合理。

3. **若 OI 仍全空或扫描报错**：查 `docker logs` 容器日志，重点看 `openInterestHistory` 是否被区域/限流拦截（本机无法复现，需服务器侧证据）。

4. **可选增强**（用户曾提过，未实现）：
   - 增加一条 **底背离** 规则（当前 5 条偏「强势/做空回转」方向）。
   - 将某条规则做成「只高亮不自动提醒」，或加自动邮件告警。

---

## 5. 踩过的坑，绝对不要踩

1. **不要手动改 git 跟踪的文件来存配置**（尤其 `docker-compose.yml`）。
   服务器上手动改 => `git pull` 永久冲突 => 自动部署每 1 分钟重复空重建且功能不生效。**所有敏感/本地配置一律放 `.env`（已 gitignore）或 `data/`**。

2. **不要用 `|| true` 吞掉 `git pull` 失败**。
   一旦 pull 失败必须 `exit 1`，否则 HEAD 永远停留在旧提交，看起来 "无更新"，实际是坏循环。

3. **不要在改 Admin 密码逻辑时让服务启动即覆盖库内密码**。
   旧 `initAdminPass()` 每次启动都用 `ADMIN_PASS` 无条件覆盖 `settings` 里的 `admin_pass`，导致页面「修改密码」永远无效。正确做法：先 `getSetting('admin_pass')`，已有则不动，无则才用 `ADMIN_PASS`/自动生成。**（仓库已在 `server/auth.js` 修复，但因第 3 节卡点，服务器未必已生效）**。

4. **做全量并发抓取前必须先加重限速**，否则 429 甚至封 IP（418）。
   永远用「全局信号量 + 最小请求间隔 + retry-after 退避」；新增抓取函数要复用同一限速器，别各自直连。

5. **对币安接口做缓存**（K 线本地持久化 + TTL），否则全量扫描 + 重启会反复拉数据、容易被封。

6. **漏网编码坑**：切片/越界要判空（`checkR5` 曾越界）、面板里被误删的工具函数（`fmtPrice`/`fmtOi`）改完记得回归，否则线上报 undefined 而 build 又可能查不出。

7. **苛刻规则会命中为 0**：先放宽判定 + 「未命中也要显示该列数值/箭头」，否则用户看着全空以为是 bug。

8. **GitHub 网络不稳**：push 卡住先 `git status -sb` 看是否 `ahead`；重试或强制 HTTP/1.1。**不要因此丢提交**——commit 成功但 push 失败时，推送可稍后重试，本地已安全。

9. **本机（开发者 Mac）访问不到币安 Api**:不要用「本机 curl 正常」来判断线上行为；线上验证需靠服务器日志 / 用户实测。改动合入前用 stub fetch + 合成数据做逻辑自测，并在注释里写明「线上未实测」。

10. 删除 `data/app.db` 会一起丢掉 SMTP 配置、密码、上新记录，务必谨慎；演示/测试用尽量只清缓存表而非整个库。