# HANDOFF（交接文档）

> 本文件用于让一个**完全没有上下文的新对话**快速接手本项目。若你是新会话，请先读完本文件，再结合仓库代码继续工作。

## 0. 如何读懂本文件

- 本项目是一个个人自用的**币安监控面板**（Web 应用），位于 `/Users/sky/Desktop/binance`（本机为 mac，仓库远端为 GitHub）。
- 每次改完代码后 **必须自动推送** 到 GitHub：`git add . && git commit -m "..." && git push origin main`（已与用户约定，无需每次再问）。
- 服务器部署：服务器上 1Panel 每 1 分钟轮询 GitHub，检测到新提交才 `git pull` + `docker compose up -d --build`。提交后约 1 分钟自动生效。
- **多轮次项目**：目标是「指标选股」功能从零到上线+后续打磨。环境受限（见「卡点」），大量逻辑靠 stub fetch 验证，未做线上实测。

---

## 1. 我们在做什么任务

为币安监控面板新增并完善 **「指标选股」（Screener）** 功能。当前包含两套筛选：

**A. 四类策略筛选器（新，主功能）**：一键全量扫描币安 **USDT 永续合约（约 400+ 个）**，按四个策略评分选股（0-100 权重制，默认保留 ≥60 分），结果按评分降序：

| 策略 | 评分构成 |
|------|----------|
| 上涨趋势 | MA20>MA50>MA200(+25) + 价>MA20(+15) + ADX>25(+15) + RSI 50-70(+15) + 量比>1(+10) + 贴近/破上轨(+20) |
| 下跌趋势 | MA20<MA50<MA200(+25) + 价<MA20(+15) + ADX>25(+15) + RSI<40(+15) + 量比>1(+10) + 贴近/破下轨(+20) |
| 山顶转折 | RSI(6)≥80(+25) + 乖离>10%(+20) + 资金费率>0.05%(+15) + 贴近/破上轨(+40) |
| 山底待涨 | RSI(6)≤20(+25) + 乖离<-10%(+20) + 资金费率<-0.05%(+15) + 贴近/破下轨(+40) |

各策略满分均为 100。**布林条件定义**（`buildKlineFeatures` 的 `bollNearUpper/bollNearLower` 与 `bollBrokeUpper/bollBrokeLower`）：「贴近」= 现价处于布林带 (20,2) 区间顶/底 10% 内（`pos≥0.9` 或 `pos≤0.1`）；「破轨(近7日)」= 近 7 根日K收盘越出过上/下轨。反转策略已**去掉多空比与 OI 条件**（不再拉取 `getLongShortRatio`/OI），资金费率权重 15 分。

**B. 规则扫描（旧功能保留）**：按 5 条技术指标规则筛选，可勾选、可切「任一/全部」，见下。

5 条规则（定义见 `server/screener.js` 的 `RULES`）：

| 编号 | 规则 | 判定条件 |
|------|------|----------|
| R1 | RSI(6) 近N日 ≥ 80 | 近 N 根日K中任意一根 RSI(6) ≥ 80，**N 可调 3-10，默认 7** |
| R2 | N日内创新高 + RSI 顶背离 | 近 N 天价格创 60 天新高，且新高处 RSI(6) 低于前高处取值，**N 可调 3-10，默认 3** |
| R3 | 价格 ≥ 布林带上轨 | 收盘价站上布林带 (20, 2) 上轨 |
| R4 | 当日 OI > 前N日总和 | 当日未平仓合约量大于之前 N 天 OI 之和，**N 可调 3-7，默认 5** |
| R5 | 单日量 > 前N日总和 | 最近一根日K成交量大于之前 N 天之和，**N 可调 3-7，默认 3** |

配套要求：面板上可勾选哪些规则命中、可切换 **「任一满足 / 全部满足」** 匹配逻辑；**全量扫描（只扫 USDT 永续，不做自选池限制）**；头部限速防币安封 IP（用户明确首要目标是别被封号）。

---

## 2. 我们已经完成了什么（全部已提交并推送）

### 规则参数化 + 持续追踪 + 定时扫描（2026-08 新增）
- **规则参数化**：`server/screener.js` 的 `RULES` 增加 `param` 元数据（min/max/def），`checkR1/checkR2/checkR4/checkR5` 接受 `days` 参数；`scan(rules, mode, { month, params })` 按范围钳制参数（R1/R2: 3-10 默认 7/3，R4/R5: 3-7 默认 5/3）。**R4 语义变更**：从「近 5 天逐日上升」改为「当日 OI > 前 N 日总和」。前端规则行旁新增 N 天数输入框，`params` 随 `startScreener` 提交。导出 `RULE_DEFAULTS` 供定时扫描用。**结果排序**：先按命中规则数降序，命中数相同按最新 RSI6 降序；结果行带 `rsi6` 字段，前端标题/行内展示。**规则标题随参数实时显示**（如选 3 天则显示「近3日」而非「近N日」，前端 `ruleTitle()`）。
- **持续追踪（价格提醒）**：
  - `server/db.js` 新增 `trackers` 表（id/symbol/direction/target_price/expire_at/created_at/notified/notified_at；notified 0=追踪中 1=已触发 2=已过期）。
  - `server/trackers.js` 新建：`listTrackers` / `createTracker`（校验目标价>0、截止时间晚于当前）/ `deleteTracker` / `checkTrackers`（用 `getFuturesPrices()` 批量价格一次校验全部活跃追踪，命中发邮件并标记，过期标记 notified=2）。
  - `server/binance.js` 新增 `getFuturesPrices()`：`/fapi/ticker/price` 无参一次取全市场，30 秒内存缓存。
  - `server/index.js` 新增 `GET/POST /api/trackers`、`DELETE /api/trackers/:id`。
  - 前端：命中行加「追踪」按钮 → 弹窗（方向向上/向下 + 目标价 + 截止时间）；底部「持续追踪」列表可删除；`src/api/monitor.js` 新增 `fetchTrackers/createTracker/deleteTracker`。
  - `checkTrackers()` 挂在 `monitor.runOnce()` 里（每分钟随监控跑一次）。
- **定时默认扫描**：`monitor.js` 的 `scanScheduledDefault()` 按**北京时间（UTC+8）**在 `00:01/04:01/12:01/16:01/20:01` 各跑一次「全部规则+默认参数+any」扫描，有命中则发一封汇总邮件；用 settings key `sched_scan_日期_时:分` 防重复，扫描失败清空 key 允许重试。挂在 `runOnce()` 末尾。

功能完整可用，已合入 main 并推送。新增：新币/套利**邮件通知失败自动重试**（见下）。

### 四类策略筛选器（2026-08 新增）
- `server/binance.js`：新增 `getFundingRates()`（`/premiumIndex` 无参一次取全市场，5min 内存缓存，Map symbol→lastFundingRate）与 `getLongShortRatio(symbol)`（`topLongShortAccountRatio?period=1d&limit=1`，10min Map 缓存，返回 `{ratio,long,short}` 或 null）。注意 `getFundingRates` 返回 **Map**，取值要用 `.get(sym)` 不是 `[sym]`。**`getLongShortRatio` 当前已无调用方**（多空比条件已从反转策略移除），保留备用。
- `server/screener.js`：
  - 新增 `STRATEGIES` 元数据、`buildKlineFeatures()`（MA20/50/200、RSI6/RSI14、ADX、乖离 dev20、量比、20日高低、布林贴近/破轨标志）、`adx()`（Wilder 平滑）、`scoreUp/scoreDown/scoreTop/scoreBottom`、`bollLabel()`（布林列显示文案）。
  - 新增 `scanStrategies(strategies, { month, minScore })` 入口：趋势策略只用已落库日K（零新增请求）；反转策略先按 RSI/乖离初筛候选池 → 只对候选拉资金费率（多空比/OI 已去掉，不再拉取）。输出统一 `{symbol, listed, price, score, signals[], strategy[], metrics{}}`，持久化到同一 `data/scan-results.json`（meta.mode='strategies'）。
- `server/index.js`：`GET /api/screener` 附带 `strategies` 元数据；新增 `POST /api/screener/strategies`（body: `{strategies:[], month, minScore}`）。
- `src/api/monitor.js`：新增 `startScreenerStrategies(strategies, month, minScore)`。
- `src/components/ScreenerPanel.vue`：四个策略 Tab + 规则扫描 Tab；每个策略显示评分构成；最低评分可调；表格列评分/信号标签/指标列，点击行跳行情图。加载历史结果时若为 strategies 模式自动切到对应 Tab。
- **未实测**：本机连不上币安 API，资金费率/多空比字段与币安实际返回是否一致需线上验证（HANDOFF 第 3 节）。

功能完整可用，已合入 main 并推送。新增：新币/套利**邮件通知失败自动重试**（见下）。

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

### 月度上新：股票/商品代币与已下架区分
- `/api/listings` 每项附加 `kind`（`stock`/`commodity`/`crypto`）与 `delisted`（`true`/`false`/`null`=symbols 表为空时未知）：
  - `classifyKind`（`server/binance.js`，供 `/api/listings` 与 `/api/search` 共用）优先级：**公告标题关键词**（`Tokenized Stock`/`股票代币`/`股票` → stock；`Tokenized Commodity`/`商品代币`/`原油`/`黄金` → commodity）→ **已知符号集合兜底**（`STOCK_SYMBOLS`/`COMMODITY_SYMBOLS`，覆盖不在 exchangeInfo 的代币与标题不含"股票"的股票永续）→ **symbols 表 `underlying` 字段**（futures exchangeInfo 的 `underlyingType`）。注意：Binance 官方枚举是 `COIN|INDEX`，股票永续多为 `INDEX`（公告原文 "Underlying Index/Equity"），所以 `STOCK`/`INDEX` 都算 stock、`COMMODITY` 算 commodity；已知集合放在 underlying 前，避免 `INDEX` 歧义把商品（如 XAGUSDT）误判成股票。
  - `symbols` 表新增 `underlying` 列（含 ALTER 迁移）：拉 exchangeInfo 时存 `s.underlyingType`（futures 才有，spot 为 ''）。**这是 2026 股票永续（AAPLUSDT/QQQUSDT/SPYUSDT/TSMUSDT/GIGADEVUSDT/XAGUSDT 等）识别的关键**——它们由行情反推插入、标题是通用的「Binance Futures 新上合约：XXX」，靠标题识别不到。GIGADEVUSDT（兆易创新 HK3986，2026-08-03 上市）已加入 `STOCK_SYMBOLS`。
  - `isDelisted(symbol, activeSyms, kind)`：用 `symbols` 表 active 集合判定，兼容 base 符号（ARB→查 ARBUSDT）与完整对（BTCUSDT→直接查）。**base 形态的股票/商品代币恒判已下架**——它们是 2021 BUSD 计价产品，与同名 2026 USDT 永续（AAPLUSDT）是不同产品，不能因后者活跃而误判。
  - `parseListedSymbol` 修复：去掉 `\s*$` 锚点，`Binance Will List Apple (AAPL) Tokenized Stock...` 现正确解析为 `AAPL`（此前误解析成 `A`）。
  - `STOCK_SYMBOLS` 补充活跃股票永续：`TQQQ`（3x QQQ）、`XLE`（能源板块 ETF）。已知局限：`underlyingType='INDEX'` 有歧义（股票指数 vs 商品），靠已知集合优先兜底；新上股票永续若不在集合且 exchangeInfo 未及时刷新，会短暂显示 crypto 直到 30 分钟刷新。
- 前端：`ListingsStats.vue` tag 加 `股票`/`商品`/`已下架` 徽标 + 图例；`KlineChart.vue` 搜索下拉同样显示这三类徽标。数据来自本地 DB，不新增对外请求。

### 限流/防制裁与持久化原则
- **重复计数修复（2026-08）**：`scanMarketDiff` 原来用 `getExchangeInfo`（不过滤合约类型，季度/交割合约也会当成新上）且去重 `known` 是公告行的 base 符号（ARB）对比行情反推的完整对（ARBUSDT），导致同一合约被两条路径各记一次。现已改为：① 用 `getPerpetualSymbols()`（只取永续）；② `known` 同时存 base 和完整对两种形态去重。`/api/listings` 读取时再按「月+base」二次去重（公告行优先于行情反推行），历史遗留的重复行也会被折叠。
- **6 月暴增是真实的**：币安 2026-06 集中上线约 40 个 TradFi 股票/ETF 永续（6/8 八个、6/9 五个、6/10 六个、6/11 六个、6/22/6/29 各一批，含 TQQQ/SQQQ/MVLL），加上 SpaceX IPO 带动的 pre-IPO 合约。
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

1. **由用户实测新功能**：确认服务器已跑最新代码，在页面上验证：
   - 规则扫描参数输入框（R1/R2: 3-10，R4/R5: 3-7）生效，R4 新语义（当日 OI > 前N日总和）
   - 「追踪」弹窗创建追踪 → 底部列表出现 → 服务器 `getFuturesPrices()` 命中后收到邮件（可把目标价设为接近现价来快速验证）
   - 定时扫描：等北京时间 00:01/04:01/12:01/16:01/20:01 触发，有命中应收到汇总邮件
   - 四类策略扫描回归、资金费率字段与币安实际返回一致
2. **若追踪/定时扫描邮件收不到**：查 `docker logs`，重点看 `tracker`/`定时选股` 日志与 SMTP 配置（`server/trackers.js` 的 `checkTrackers`、`monitor.js` 的 `scanScheduledDefault`）。
3. **可选增强**：底背离规则；评分制再调权重/阈值；追踪到期未命中时补发一条「过期」邮件。

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