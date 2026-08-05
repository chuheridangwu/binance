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

功能完整可用，已合入 main 并推送（当前 HEAD 为 `20db6fb`）。新增：新币/套利**邮件通知失败自动重试**（见下）。

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

### 邮件通知可靠性（修复）
- `listings` 表新增 `retry_count` / `last_notify_attempt`（含 `ALTER TABLE` 迁移，已在本机验证列存在）。
- `notify()` 改为：已发不重复；失败保留 `notified=0`；**每 30 分钟限速重试、最多 10 次后放弃**（放弃会写进 `scanErrors`）。
- 新增 `retryPendingNotifications()`，随 `runOnce()` 每次扫描执行：重发「近 2 天内、未通知、未超限」的记录，并按「已通知 symbol 集合」去重，避免同一币种走 市场diff/公告 两条路径重复发信。这同时兜住了「23:59 上线过零点被 `isSameDay` 漏掉」的边缘情况。

### 指标选股「上架月份」过滤
- `scan(rules, mode, { month })` 新增第三参；`month` 为 `YYYY-MM`，仅扫描该月上架合约（`buildListingDates()` 从 `listings` 表建 symbol→日期 映射，优先 `market='futures'` 行即合约首次K线时间，缺失回退公告日期）；结果行带 `listed`（上架月份），meta 带 `month`。
- 前端：`ScreenerPanel.vue` 增加月份选择器（`<input type="month">`）+ 清空按钮 + 「上架」列；`startScreener(rules, mode, month)` 传参。月份校验正则 `^\d{4}-\d{2}$`。
- 月份边界按服务器时区（Docker=UTC）计算，月底最后 1 小时上架可能 ±1 月。

### 月度上新全量历史
- **修复历史 bug**：20db6fb 把公告抓取从 2 年改成 4 年时，把 while 里的 `twoYearsAgo` 改成了 `fourYearsAgo`，但最后 `.filter(a => a.date >= twoYearsAgo)` 里的 `twoYearsAgo` 忘了改——一直是未定义变量，导致每次 `fetchListingAnnouncements` 都抛 ReferenceError、公告扫描持续失败。已删除该日期过滤。
- `fetchListingAnnouncements` 现在**返回 `{ list, completed }`**（不再返回数组），所有调用方都要取 `.list`：
  - 去掉 `fourYearsAgo` 提前 break，翻到目录自然尽头（`articles` 空=完成）。
  - `known` 提前停止仍保留：整页公告都已入库即停，增量扫描不会重复拉全量页。
- **一次性全量补全**：`monitor.bootstrapAnnouncements()` 启动时跑一次（不带 known，全量翻 ~62 页），完成后写 `announce_backfill_done=1`；**只有 `completed && list.length>0` 才写标记**，抓取失败不标记、下次启动重试。之后增量扫描走 known 提前停止。
- `/api/listings` 不再有 47 个月截断：从库中最早月份一直生成到当前月（当前约 110 个月，2017-07 起）。前端标题/汇总从「近 4 年/四年总上币」改为「全量/累计上币」。
- 注意：目录 total 约 1200+ 篇（约 62 页，20/页），含现货/合约/杠杆等公告；`parseListedSymbol` 只认标题末尾 `(XXX)`，非上新标题（margin 增容等）被 `isNewListing` 过滤。

### 限流/防制裁与持久化原则
- **本应用是统计工具，不做爬虫**：所有对外请求都必须走 `binance.js` 的全局限速器（`getJson`：并发≤4、相邻请求≥180ms、429/418 按 retry-after 退避，最多重试 2 次）。**spread.js 已改用共享的 `getJson`**（原先自带裸 fetch、8 并发、无退避，是最薄弱路径）。
- 公告抓取翻页间隔额外 `sleep(250)`；增量扫描 `maxPages=5`（补全后整页已知会提前停在 1~2 页）；一次性补全 `maxPages=100` 且只在启动时、首轮 runOnce 之后执行，不会与增量并发。
- 值得持久化的数据一律落库，避免重复拉：`symbols`（币种列表）、`kline_cache`（K线）、`oi_cache`（OI）、`listings`（公告/上新）、`settings`。资金费率/价差属瞬态行情，不落库（5 分钟一次、已限速）。

### 全量币种搜索（含下架）
- `getAllSymbols()`（新增）：扫描 现货+合约 exchangeInfo 全部状态（含 `BREAK`/下架）的 USDT 交易对，返回 `[{symbol, active}]`，内存缓存 30 分钟；现货/合约同名优先取 `active=true`。
- `searchSymbols(keyword)`：改为返回对象数组，**active 在前、已下架排后**，组内按符号排序，截 30 条。
- 前端 `KlineChart.vue` 下拉：`pick(s)` 兼容字符串/对象（取 `s.symbol`）；已下架项灰显 + 「已下架」徽标。
- **指标选股不受影响**：扫描沿用 `getPerpetualSymbols()`（仅 `status==='TRADING'` 的 USDT 永续），下架合约天然被排除。

### DB 持久化（避免重复拉币安）
- `symbols` 表（symbol+market 主键）：落库现货/合约全部 USDT 交易对（含下架，active 标记 + futures 的 contractType）。`getExchangeInfo` / `getPerpetualSymbols` / `getAllSymbols` 全部改为 DB 兜底 + 内存 30 分钟 TTL + 后台 30 分钟定时刷新；重启不再冷拉，币安 API 挂了也能用旧数据兜底。
- 监控原每分钟拉一次合约 exchangeInfo（约 1440 次/天）→ 现在走缓存（约 96 次/天）。
- 行情页 K 线（`getKlines`）接入 `kline_cache`：历史页(带 before)永久命中，最新页 5 分钟 TTL；翻页/重开图表不再重复拉。
- 公告扫描增量翻页：`fetchListingAnnouncements(20, known)` 整页公告都已入库即停止，每 30 分钟从 20 页降到通常 1~2 页。

**部署状态**：服务器 `/opt/binance` 已完成清理并运行**最新代码**，每次 `git push` 后约 1 分钟内自动生效。若后续出现「服务器无更新」，优先怀疑 `.env` 被误改或 docker-compose 相关文件被抓改（见第 5 节坑 1/2）。

### 踩过的坑的修复记录（对应第 5 节）
- `checkR5` 曾因 `n<9` 越界空数组崩，改为 `n<8` 提前返回 false。
- `fmtPrice` / `fmtOi` 函数曾在面板重构中被误删 → 界面报「fmtPrice is not defined」，已补回。
- R4 原判定「5 天连续严格递增」几乎永不命中、OI 列总是全空 → 放宽为「netUp（末日>首日）&& upCount>=3」，且 **OI 列未命中也显示数值 + 涨跌箭头（↑/↓/→）**，命中才绿色。

---

## 3. 当前卡在哪（关键！）

1. **本机无法访问币安 API 做线上实测。**
   `curl https://api.binance.com` / `https://fapi.binance.com` 都返回 **HTTP 000**（网络/地域限制）。因此全量扫描、OI 真实数据、限流在真实环境的表现**从未实测**，只用 stub fetch + 合成数据在单元级验证过。

2. **推送/网络不稳定。**
   本机 GitHub 网络偶发超时（HTTP2 framing layer、连接 443 超时）。push 卡住时可重试，或 `git -c http.version=HTTP/1.1 push` 强制 HTTP/1.1。

3. **测试期间删除过 `data/app.db`**（gitignore）。下次本地启动会重新建库并生成新初始密码（`data/INITIAL_PASSWORD.txt`），旧 SMTP 配置、密码、上新记录丢失。服务器上的库不受影响。

> **已解除的旧卡点**：服务器部署问题已于用户确认清理完成——`/opt/binance` 现跑**最新代码**，后续每次 `git push` 服务器 1 分钟内自动 `git pull` + 重建，无需再处理服务器清理。改密码问题（旧 initAdminPass 覆盖库内密码）也已随新代码一起解决。

---

## 4. 下一步计划是什么（按优先级）

1. **由用户实测线上扫描**：确认服务器已跑最新代码（即将发生），在页面上点「指标选股 → 开始扫描」，确认：
   - OI 列有值（不再全空，即便未命中规则也显示数值+箭头）
   - 扫描过程不报 429/418、不封 IP、能正常跑完
   - 命中结果合理性
   - 修改密码生效（验证旧 bug 已随新代码修复）

2. **若 OI 仍全空或扫描报错**：查 `docker logs` 容器日志，重点看 `openInterestHistory` 是否被区域/限流拦截（本机无法复现，需服务器侧证据）。

3. **可选增强**（用户曾提过，未实现）：
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

8. **lightweight-charts 不会自动 fit 内容，默认把 bar 挤在右侧**。`setData()` 后必须调用 `chart.timeScale().fitContent()`，否则柱状图只有最右侧几十像素有柱、其余空白，`subscribeClick`/`subscribeCrosshairMove` 拿到的 `param.time` 会是 `undefined`（点击空白区返回 null），点击柱图看似"没反应"。已用无头 Chrome + CDP 真实点击复现并修复（月度上新柱状图）。调试此类问题可用：无头 Chrome 加 `Input.dispatchMouseEvent` 派发受信点击，或直接读 `chart.timeScale().coordinateToTime(x)`。

9. **GitHub 网络不稳**：push 卡住先 `git status -sb` 看是否 `ahead`；重试或强制 HTTP/1.1。**不要因此丢提交**——commit 成功但 push 失败时，推送可稍后重试，本地已安全。

10. **本机（开发者 Mac）访问不到币安 Api**:不要用「本机 curl 正常」来判断线上行为；线上验证需靠服务器日志 / 用户实测。改动合入前用 stub fetch + 合成数据做逻辑自测，并在注释里写明「线上未实测」。

11. 删除 `data/app.db` 会一起丢掉 SMTP 配置、密码、上新记录，务必谨慎；演示/测试用尽量只清缓存表而非整个库。