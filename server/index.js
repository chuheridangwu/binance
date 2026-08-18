import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, getSettings, getSetting, setSetting } from './db.js'
import * as binance from './binance.js'
import * as monitor from './monitor.js'
import { sendMail } from './mailer.js'
import * as auth from './auth.js'
import { getSpreadData, DEFAULT_WATCH } from './spread.js'
import * as screener from './screener.js'
import { listTrackers, createTracker, deleteTracker } from './trackers.js'
import { listAlerts, createAlert, deleteAlert, updateAlert, resetAlertState, previewAlert, listAlertEvents } from './indicator_alerts.js'
import { getCoinInfo, getCachedCoinInfo, searchCoinInfo } from './coingecko.js'
import { getHistoryStatus, startHistory, mkt } from './history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

auth.initAdminPass()

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }))

app.post('/api/login', (req, res) => {
  const token = auth.login(String(req.body.password || ''))
  if (!token) return res.status(401).json({ error: '密码错误' })
  res.json({ token })
})

app.post('/api/logout', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  auth.logout(token)
  res.json({ ok: true })
})

app.get('/api/auth/status', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  res.json({ authed: auth.checkToken(token) })
})

app.post('/api/change-password', (req, res) => {
  const r = auth.changePassword(String(req.body.old_password || ''), String(req.body.new_password || ''))
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (!auth.checkToken(token)) return res.status(401).json({ error: '未登录或登录已过期' })
  next()
})

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol, interval, limit, before } = req.query
    if (!symbol || !interval) return res.status(400).json({ error: 'symbol 与 interval 必填' })
    const rows = await binance.getKlines(
      String(symbol).toUpperCase(),
      String(interval),
      Math.min(Number(limit) || 500, 1000),
      before ? Number(before) : undefined
    )
    res.json({ klines: rows })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/search', async (req, res) => {
  try {
    res.json({ symbols: await binance.searchSymbols(String(req.query.q || '')) })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/spread', async (req, res) => {
  try {
    const q = String(req.query.symbols || '')
    const symbols = q
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const data = symbols.length ? await getSpreadData(symbols) : await getSpreadData(DEFAULT_WATCH)
    res.json(data)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/screener', (_req, res) => {
  res.json({ ...(screener.getLastResults() || { results: [], mode: 'any', rules: [], generatedAt: 0 }), strategyDefs: screener.STRATEGIES })
})

app.get('/api/screener/status', (_req, res) => {
  res.json(screener.getScanState())
})

app.post('/api/screener', async (req, res) => {
  try {
    const rules = {
      r1: !!req.body.r1,
      r2: !!req.body.r2,
      r3: !!req.body.r3,
      r4: !!req.body.r4,
      r5: !!req.body.r5,
      r6: !!req.body.r6,
    }
    const mode = req.body.mode === 'all' ? 'all' : 'any'
    const month = typeof req.body.month === 'string' ? req.body.month : ''
    const params = req.body.params && typeof req.body.params === 'object' ? req.body.params : {}
    const result = await screener.scan(rules, mode, { month, params })
    res.json({ ok: true, ...result, state: screener.getScanState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/trackers', (_req, res) => {
  res.json({ trackers: listTrackers() })
})

app.post('/api/trackers', (req, res) => {
  try {
    const t = createTracker({
      symbol: req.body.symbol,
      direction: req.body.direction,
      target_price: req.body.target_price,
      expire_at: req.body.expire_at,
    })
    res.json({ ok: true, tracker: t })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/trackers/:id', (req, res) => {
  deleteTracker(req.params.id)
  res.json({ ok: true })
})

// 指标告警规则
app.get('/api/alerts', (_req, res) => {
  res.json({ alerts: listAlerts() })
})

app.post('/api/alerts', (req, res) => {
  try {
    const a = createAlert({
      symbol: req.body.symbol,
      indicator: req.body.indicator,
      period: req.body.period,
      threshold: req.body.threshold,
      direction: req.body.direction,
      active: req.body.active,
    })
    res.json({ ok: true, alert: a })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.patch('/api/alerts/:id', (req, res) => {
  try {
    const a = updateAlert(req.params.id, req.body)
    res.json({ ok: true, alert: a })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/alerts/:id', (req, res) => {
  deleteAlert(req.params.id)
  res.json({ ok: true })
})

app.post('/api/alerts/:id/reset', (req, res) => {
  resetAlertState(req.params.id)
  res.json({ ok: true })
})

app.get('/api/alerts/:id/events', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  res.json({ events: listAlertEvents(req.params.id, limit) })
})

// 指标告警：预览某币当前指标值（不建规则也能看）
app.get('/api/alerts/preview', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase()
    const period = Number(req.query.period) || 6
    if (!symbol) return res.status(400).json({ error: 'symbol 必填' })
    res.json(await previewAlert(symbol, period))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/mute', (_req, res) => {
  res.json({ mutes: screener.listMutes() })
})

app.post('/api/mute', (req, res) => {
  try {
    const m = screener.addMute(req.body.symbol)
    res.json({ ok: true, ...m })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/mute/:symbol', (req, res) => {
  screener.removeMute(req.params.symbol)
  res.json({ ok: true })
})

app.post('/api/screener/strategies', async (req, res) => {
  try {
    const strategies = Array.isArray(req.body.strategies) ? req.body.strategies : ['up']
    const month = typeof req.body.month === 'string' ? req.body.month : ''
    const minScore = Number(req.body.minScore) || 60
    const config = req.body.config || {}
    const result = await screener.scanStrategies(strategies, { month, minScore, config })
    res.json({ ok: true, ...result, state: screener.getScanState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/listings', (_req, res) => {
  const now = new Date()
  const rows = db.prepare('SELECT symbol, date, title, source FROM listings ORDER BY date ASC').all()
  const activeSets = {
    spot: new Set(db.prepare("SELECT symbol FROM symbols WHERE market = 'spot' AND active = 1").all().map((r) => r.symbol)),
    futures: new Set(db.prepare("SELECT symbol FROM symbols WHERE market = 'futures' AND active = 1").all().map((r) => r.symbol)),
  }
  const underlying = binance.buildUnderlyingMap()
  const coinInfoCache = new Map()
  const coinInfoFor = (base) => {
    if (!coinInfoCache.has(base)) coinInfoCache.set(base, getCachedCoinInfo(base))
    return coinInfoCache.get(base)
  }
  // 同月内同一标的去重：公告行（base 符号、真标题）优先于行情反推行（完整对、泛标题），
  // 避免同一个合约被两条入库路径重复计数（历史数据里已存在重复行）
  const seen = new Map()
  for (const r of rows) {
    const d = new Date(r.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const base = String(r.symbol).toUpperCase().replace(/USDT$/, '')
    const kind = binance.classifyKind(r.symbol, r.title, underlying.get(String(r.symbol).toUpperCase()))
    const market = listingMarket(r)
    const item = {
      symbol: r.symbol,
      date: d.toISOString(),
      title: r.title,
      source: r.source,
      kind,
      market,
      delisted: isDelisted(r.symbol, activeSets, kind, market),
      coinInfo: coinInfoFor(base),
    }
    const pk = `${key}|${base}`
    const existing = seen.get(pk)
    if (existing) {
      // 保留标题更具体的一条（公告行有真标题，行情反推是泛标题）
      if (r.source === 'announcement' && existing.source !== 'announcement') seen.set(pk, item)
      continue
    }
    seen.set(pk, item)
  }
  const map = new Map()
  for (const item of seen.values()) {
    const d = new Date(item.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  const keys = [...map.keys()].sort()
  const months = []
  if (keys.length) {
    let [y, m] = keys[0].split('-').map(Number)
    const nowY = now.getFullYear()
    const nowM = now.getMonth() + 1
    while (y < nowY || (y === nowY && m <= nowM)) {
      const key = `${y}-${String(m).padStart(2, '0')}`
      months.push({ key, label: `${y}/${String(m).padStart(2, '0')}`, items: map.get(key) || [] })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
  }
  res.json({ total: rows.length, months, generatedAt: Date.now() })
})

app.get('/api/coininfo', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'symbol 必填' })
  try {
    const info = await getCoinInfo(symbol)
    res.json(info)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/coininfo/search', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'symbol 必填' })
  try {
    const result = await searchCoinInfo(symbol)
    res.json(result)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// 供应量分析：查 cg_cache 里已缓存的币，计算当前价（市值÷流通量），可按最大供应量过滤
// query: maxSupply=1000000000 目标最大供应量；tolerance=0.1 容差(默认10%)；或 supplyMin/supplyMax 区间
// 返回 coin 列表 + 汇总(最高/最低单价、个数、中位市值)
app.get('/api/coin-supply', (req, res) => {
  const raw = db.prepare("SELECT data FROM cg_cache WHERE symbol NOT LIKE 'web_%'").all()
  const coins = []
  for (const r of raw) {
    let d
    try { d = JSON.parse(r.data) } catch { continue }
    if (!d || d.found !== true) continue
    const { maxSupply, circulatingSupply, marketCapUsd, fdvUsd } = d
    if (!(circulatingSupply > 0)) continue
    const price = marketCapUsd !== null ? marketCapUsd / circulatingSupply : null
    coins.push({
      symbol: d.symbol,
      name: d.name || '',
      maxSupply: maxSupply ?? null,
      circulatingSupply,
      totalSupply: d.totalSupply ?? null,
      marketCapUsd: marketCapUsd ?? null,
      fdvUsd: fdvUsd ?? null,
      price,
      athUsd: d.athUsd ?? null,
      atlUsd: d.atlUsd ?? null,
    })
  }

  let filtered = coins
  const qMax = Number(req.query.maxSupply)
  const qMin = Number(req.query.supplyMin)
  const qMax2 = Number(req.query.supplyMax)
  const tolerance = Number(req.query.tolerance) || 0.1
  if (Number.isFinite(qMax) && qMax > 0) {
    filtered = coins.filter((c) => c.maxSupply !== null && c.maxSupply > 0 && Math.abs(c.maxSupply - qMax) / qMax <= tolerance)
  } else if (Number.isFinite(qMin) || Number.isFinite(qMax2)) {
    filtered = coins.filter((c) => {
      if (c.maxSupply === null) return false
      if (Number.isFinite(qMin) && c.maxSupply < qMin) return false
      if (Number.isFinite(qMax2) && c.maxSupply > qMax2) return false
      return true
    })
  }

  const withPrice = filtered.filter((c) => c.price !== null)
  const prices = withPrice.map((c) => c.price)
  const mcaps = withPrice.map((c) => c.marketCapUsd).filter((v) => v !== null)
  const summary = {
    count: filtered.length,
    withPrice: withPrice.length,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    medianPrice: prices.length ? median(prices) : null,
    minMcap: mcaps.length ? Math.min(...mcaps) : null,
    maxMcap: mcaps.length ? Math.max(...mcaps) : null,
    totalMcap: mcaps.length ? mcaps.reduce((a, b) => a + b, 0) : null,
  }
  filtered.sort((a, b) => (b.price ?? -1) - (a.price ?? -1))
  res.json({ coins: filtered, summary, generatedAt: Date.now() })
})

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// 上新表现追踪：用上架日期 + market.db 的 1d K线，算上线后 7/30/90 天涨跌幅
// query: months=6 只看最近N个月上新；返回 coin 列表 + 汇总(平均/破发率)
app.get('/api/listing-performance', (req, res) => {
  const months = Number(req.query.months) || 6
  const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000
  const rows = db
    .prepare('SELECT symbol, MIN(date) AS date FROM listings WHERE date >= ? GROUP BY symbol')
    .all(cutoff)

  const DAY = 24 * 3600 * 1000
  const results = []
  for (const r of rows) {
    const s = String(r.symbol).toUpperCase()
    const full = s.endsWith('USDT') ? s : s + 'USDT'
    const kl = mkt
      .prepare('SELECT time, close FROM klines WHERE symbol = ? AND interval = ? ORDER BY time ASC')
      .all(full, '1d')
    if (!kl.length) continue
    const listingMs = Number(r.date)
    // 找到上架日当天/之后的第一个日K作为基准价
    let baseIdx = kl.findIndex((k) => k.time >= listingMs)
    if (baseIdx < 0) continue
    const basePrice = kl[baseIdx].close
    if (!(basePrice > 0)) continue
    const retDays = [7, 30, 90].map((d) => {
      const target = listingMs + d * DAY
      const k2 = kl.find((k) => k.time >= target)
      return k2 && basePrice > 0 ? (k2.close / basePrice - 1) * 100 : null
    })
    const last = kl[kl.length - 1]
    const current = last.close
    results.push({
      symbol: s,
      listed: monthKey2(listingMs),
      basePrice,
      ret7: retDays[0],
      ret30: retDays[1],
      ret90: retDays[2],
      currentPrice: last.close,
      currentRet: basePrice > 0 ? (current / basePrice - 1) * 100 : null,
    })
  }

  // 汇总：近30天表现的分布
  const scores = results.map((x) => x.ret30).filter((v) => v !== null)
  const all = results.map((x) => x.currentRet).filter((v) => v !== null)
  const summarize = (arr) => {
    if (!arr.length) return null
    const pos = arr.filter((v) => v > 0).length
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      count: arr.length,
      avg,
      median: median(arr),
      max: sorted[sorted.length - 1],
      min: sorted[0],
      gainRate: arr.length ? (pos / arr.length) * 100 : 0,
    }
  }
  const summary = {
    count: results.length,
    ret7: summarize(scores.length ? results.map((x) => x.ret7).filter((v) => v !== null) : []),
    ret30: summarize(scores),
    ret90: summarize(results.map((x) => x.ret90).filter((v) => v !== null)),
    current: summarize(all),
  }
  results.sort((a, b) => (b.ret30 ?? -Infinity) - (a.ret30 ?? -Infinity))
  res.json({ results, summary, months, generatedAt: Date.now() })
})

function monthKey2(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 妖币统计：找出 N 小时内涨幅 ≥ 阈值 的币（窗口 24h-5天，阈值 50%-150% 可调）
// 基准价 = market.db 1h K线里"现在-窗口"时刻的价格，现价 = 实时全市场价
app.get('/api/meme', async (req, res) => {
  try {
    const windowHours = Math.min(120, Math.max(1, Number(req.query.windowHours) || 24))
    const threshold = Math.min(150, Math.max(50, Number(req.query.threshold) || 50))
    const prices = await binance.getFuturesPrices()
    const symbols = await binance.getPerpetualSymbols()
    const listingDate = new Map(db.prepare('SELECT symbol, MIN(date) AS d FROM listings GROUP BY symbol').all().map((r) => [r.symbol.toUpperCase(), r.d]))
    const cutoff = Date.now() - windowHours * 3600 * 1000
    const results = []
    for (const sym of symbols) {
      const price = prices.get(sym)
      if (!price) continue
      const row = mkt.prepare('SELECT close FROM klines WHERE symbol = ? AND interval = ? AND time < ? ORDER BY time DESC LIMIT 1').get(sym, '1h', cutoff)
      if (!row || !(row.close > 0)) continue
      const ret = (price / row.close - 1) * 100
      if (ret >= threshold) {
        results.push({
          symbol: sym,
          ret: round1(ret),
          price,
          basePrice: row.close,
          listed: listingDate.get(sym.toUpperCase()) ? monthKey2(listingDate.get(sym.toUpperCase())) : '',
        })
      }
    }
    results.sort((a, b) => b.ret - a.ret)
    res.json({ results, windowHours, threshold, count: results.length, generatedAt: Date.now() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 潜力新币：找上市 ≤months 个月内、无爆拉历史、具备初期炒作特征的低位币。
// 特征可开关且阈值可调（低单价/高波动/近期放量/费率异常），每个满足给 1 分，
// 已爆拉(上市以来最大涨幅超 maxRise%)的直接排除。数据源复用 market.db，无需额外请求。
app.get('/api/potential', async (req, res) => {
  try {
    const months = Math.min(12, Math.max(1, Number(req.query.months) || 12))
    const maxRise = Math.min(300, Math.max(30, Number(req.query.maxRise) || 100))
    const minAmpl = Math.min(200, Math.max(10, Number(req.query.minAmpl) || 40))
    const volDays = Math.min(20, Math.max(3, Number(req.query.volDays) || 7))
    const volRatio = Math.min(10, Math.max(1.2, Number(req.query.volRatio) || 2))
    const fundingAbs = Math.min(0.5, Math.max(0.01, Number(req.query.fundingAbs) || 0.02))
    const use = {
      lowPrice: req.query.lowPrice !== '0',
      highVol: req.query.highVol !== '0',
      volume: req.query.volume !== '0',
      funding: req.query.funding !== '0',
    }
    const dlc = []
    if (use.lowPrice) dlc.push('lowPrice')
    if (use.highVol) dlc.push('highVol')
    if (use.volume) dlc.push('volume')
    if (use.funding) dlc.push('funding')

    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    cutoff.setHours(0, 0, 0, 0)
    const now = Date.now()
    const prices = await binance.getFuturesPrices()
    const fundingRates = await binance.getFundingRates()
    const listingDate = new Map(
      db.prepare('SELECT symbol, MIN(date) AS d FROM listings GROUP BY symbol')
        .all()
        .map((r) => [r.symbol.toUpperCase(), r.d])
    )
    // 1年内上架的、仍活跃的合约
    const candidates = db.prepare(
      "SELECT symbol FROM symbols WHERE market='futures' AND active=1 AND fetched_at = (SELECT MAX(fetched_at) FROM symbols)"
    ).all()

    const results = []
    for (const row of candidates) {
      const sym = row.symbol
      const listed = listingDate.get(sym.toUpperCase())
      if (!listed || listed < cutoff.getTime()) continue // 要求有上架记录且在窗口内

      // 无爆拉：上市以来任意时刻的最大涨幅 < maxRise%，基于 1h K线上市起点价
      const first1h = mkt.prepare('SELECT close, time FROM klines WHERE symbol = ? AND interval = ? AND time >= ? ORDER BY time ASC LIMIT 1').get(sym, '1h', listed)
      if (!first1h || !(first1h.close > 0)) continue
      const ageDays = Math.round((now - first1h.time) / 86400000)
      if (ageDays < 2) continue // 数据太新，特征无法计算
      if (listed > now) continue

      const price = prices.get(sym)
      if (!price || !(price > 0)) continue

      // 上市以来最大涨幅（用1h序列里最高的 close）
      const maxClose = mkt.prepare('SELECT MAX(close) m FROM klines WHERE symbol = ? AND interval = ? AND time >= ?').get(sym, '1h', listed)?.m || 0
      const maxRisePct = (maxClose / first1h.close - 1) * 100
      if (maxRisePct > 2000) continue // 极端异常数据跳过
      if (maxRisePct >= maxRise) continue // 硬性无爆拉

      // --- 特征打分 ---
      const checked = []
      // 低单价
      if (dlc.includes('lowPrice') && price < 1) checked.push({ id: 'lowPrice', label: '低单价', detail: `$${price.toPrecision(4)}` })
      // 高波动：上市以来日K振幅均值
      let ampl = 0
      if (dlc.includes('highVol')) {
        const days = mkt.prepare('SELECT high, low, close FROM klines WHERE symbol = ? AND interval = ? AND time >= ?').all(sym, '1d', listed)
        if (days.length >= 2) {
          let sum = 0, cnt = 0
          for (const d of days) {
            if (d.high > 0 && d.low > 0) { sum += (d.high / d.low - 1); cnt++ }
          }
          ampl = cnt ? (sum / cnt) * 100 : 0
        }
        if (ampl >= minAmpl) checked.push({ id: 'highVol', label: '高波动', detail: `日振幅${round1(ampl)}%` })
      }
      // 近期放量：近 volDays 天均量 vs 上市以来其余日均量
      if (dlc.includes('volume')) {
        const rows = mkt.prepare('SELECT time, quote_volume v FROM klines WHERE symbol = ? AND interval = ? AND time >= ?').all(sym, '1d', listed)
        const recentStart = now - volDays * 86400000
        let recentSum = 0, recentCnt = 0, prevSum = 0, prevCnt = 0
        for (const r of rows) {
          if (r.time >= recentStart) { recentSum += r.v || 0; recentCnt++ }
          else { prevSum += r.v || 0; prevCnt++ }
        }
        const recentAvg = recentCnt ? recentSum / recentCnt : 0
        const prevAvg = prevCnt ? prevSum / prevCnt : 0
        if (recentAvg > 0 && prevAvg > 0 && recentAvg / prevAvg >= volRatio) {
          checked.push({ id: 'volume', label: '近期放量', detail: `${round1(recentAvg / prevAvg)}×` })
        }
      }
      // 费率异常：当前费率绝对值超阈值 或 上市以来平均费率高正/高负
      let fr
      if (dlc.includes('funding')) {
        fr = fundingRates.get(sym)
        const isExtreme = fr !== undefined && Math.abs(fr) >= fundingAbs
        const avgRow = mkt.prepare('SELECT AVG(rate) a FROM funding WHERE symbol = ? AND time >= ?').get(sym, listed)
        const avgFr = avgRow?.a || 0
        const avgExtreme = Math.abs(avgFr) >= fundingAbs
        if (isExtreme || avgExtreme) checked.push({ id: 'funding', label: '费率异常', detail: fr !== undefined ? `${(fr * 100).toFixed(3)}%` : `均${(avgFr * 100).toFixed(3)}%` })
      }

      const score = checked.length
      if (score === 0) continue
      // 现价相对上市起点涨幅（用于展示，不应过高否则算已起飞）
      const risePct = (price / first1h.close - 1) * 100
      if (risePct >= maxRise) continue

      results.push({
        symbol: sym,
        score,
        features: checked.map((c) => c.label),
        price: price,
        ageDays,
        listed: monthKey2(listed),
        riseSinceList: round1(risePct),
        maxRise: round1(maxRisePct),
        amplitude: round1(ampl),
        funding: fr !== undefined ? Math.round(fr * 100000) / 1000 : null,
      })
    }
    results.sort((a, b) => b.score - a.score || b.riseSinceList - a.riseSinceList)
    res.json({ results, params: { months, maxRise, minAmpl, volDays, volRatio, fundingAbs }, count: results.length, generatedAt: Date.now() })
  } catch (e) {
    console.error('[potential] 扫描失败:', e)
    res.status(500).json({ error: e.message })
  }
})

function round1(v) {
  return Math.round(v * 10) / 10
}

// 相似趋势：给定一个币，用日收益率序列的 Pearson 相关系数找趋势最相似的币
app.get('/api/similar', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase()
    const top = Math.min(30, Number(req.query.top) || 12)
    if (!symbol) return res.status(400).json({ error: 'symbol 必填' })
    const full = symbol.endsWith('USDT') ? symbol : symbol + 'USDT'

    // 参考窗口：start/end（支持 YYYY-MM-DD 或毫秒时间戳）。缺省则用最近 N 天
    const days = Math.min(120, Math.max(7, Number(req.query.days) || 30))
    let start = parseDayTs(req.query.start)
    let end = parseDayTs(req.query.end)
    if (start === null || end === null) {
      end = Date.now()
      start = end - days * 24 * 3600 * 1000
    }
    if (end <= start) return res.status(400).json({ error: '结束时间必须晚于开始时间' })
    if (end - start > 365 * 24 * 3600 * 1000) return res.status(400).json({ error: '参考区间最长一年' })

    // 目标币：参考区间 [start, end] 的日收益率序列 → 参考走势形态
    const targetKl = mkt.prepare(
      'SELECT time, close FROM klines WHERE symbol = ? AND interval = ? AND time >= ? AND time <= ? ORDER BY time ASC'
    ).all(full, '1d', start, end)
    if (targetKl.length < 10) return res.status(400).json({ error: '目标币该区间历史数据不足（需 ≥10 根日K，可能在回补中）' })
    const refRet = dailyReturns(targetKl) // {time, ret}，长度 = 目标K数 - 1
    const refLen = refRet.length
    const refWindow = { start: targetKl[0].time, end: targetKl[targetKl.length - 1].time, bars: targetKl.length }
    // 归一化路径：从窗口起点开始累计涨跌幅（%）→ 形状对比基准
    const t0 = targetKl[0].close
    const targetPath = targetKl.map((k) => (t0 > 0 ? k.close / t0 - 1 : 0))
    const targetRets = refRet.map((r) => r.ret)

    // 每个候选币：取最近 refLen+1 根日K，归一化路径与目标路径逐根对比
    const prices = await binance.getFuturesPrices()
    const symbols = await binance.getPerpetualSymbols()
    const sims = []
    for (const sym of symbols) {
      if (sym === full) continue
      const kl = mkt.prepare(
        'SELECT time, close FROM klines WHERE symbol = ? AND interval = ? ORDER BY time DESC LIMIT ?'
      ).all(sym, '1d', refLen + 1)
      if (kl.length < refLen + 1) continue
      // 数据须回补到最近，避免用旧窗口对形态
      const newest = kl[0].time
      if (Date.now() - newest > 7 * 24 * 3600 * 1000) continue
      kl.reverse()
      const candRets = dailyReturns(kl).map((r) => r.ret)
      if (candRets.length !== refLen) continue
      // 归一化路径（百分比形态，可比性）
      const c0 = kl[0].close
      const candPath = kl.map((k) => (c0 > 0 ? k.close / c0 - 1 : 0))
      // 路径相关：整条曲线的形态相关（先涨后跌/横盘/V型等）
      const shapeCorr = pearson(targetPath, candPath)
      // 日收益相关：每天涨跌方向是否一致（抗单日主导）
      const retCorr = pearson(targetRets, candRets)
      if (!Number.isFinite(shapeCorr) || !Number.isFinite(retCorr)) continue
      const last = kl[kl.length - 1]
      const first = kl[kl.length - 1 - refLen]
      sims.push({
        symbol: sym,
        similarity: Math.round((0.65 * shapeCorr + 0.35 * retCorr) * 1000) / 1000,
        shapeCorr: Math.round(shapeCorr * 1000) / 1000,
        retCorr: Math.round(retCorr * 1000) / 1000,
        currentPrice: prices.get(sym) ?? null,
        retWindow: first.close > 0 ? round1((last.close / first.close - 1) * 100) : null,
      })
    }
    sims.sort((a, b) => b.similarity - a.similarity)
    const targetFirst = targetKl[0].close
    const targetLast = targetKl[targetKl.length - 1].close
    res.json({
      symbol,
      full,
      refWindow,
      targetRet: targetFirst > 0 ? round1((targetLast / targetFirst - 1) * 100) : null,
      results: sims.slice(0, top),
      count: sims.length,
      generatedAt: Date.now(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 解析 YYYY-MM-DD（按 UTC 当天 0 点，对齐日K开市）或毫秒时间戳
function parseDayTs(v) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
  const t = Number(s)
  return Number.isFinite(t) && t > 0 ? t : null
}

function dailyReturns(kl) {
  const out = []
  for (let i = 1; i < kl.length; i++) {
    if (kl[i - 1].close > 0) out.push({ time: kl[i].time, ret: kl[i].close / kl[i - 1].close - 1 })
  }
  return out
}

function pearson(x, y) {
  const n = x.length
  if (n < 2) return NaN
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const xd = x[i] - mx
    const yd = y[i] - my
    num += xd * yd
    dx += xd * xd
    dy += yd * yd
  }
  const den = Math.sqrt(dx) * Math.sqrt(dy)
  return den === 0 ? 0 : num / den
}

// 已下架判定：当前币安 USDT 现货/合约里都不在交易即为已下架
// 公告行符号多为 base（ARB），行情反推行符号为完整对（BTCUSDT），两种都兼容
// 判断某条 listing 属于现货还是合约
function listingMarket(r) {
  if (r.source === 'market-diff') return 'futures'
  if (r.market === 'futures') return 'futures'
  const t = String(r.title || '')
  // 公告标题区分：Will Launch ... Perpetual / Will Open Trading → 合约；Will List → 现货
  if (/Perpetual|Will Launch|Will Open Trading/i.test(t)) return 'futures'
  return 'spot'
}

// 已下架判定：按市场区分。activeSets = { spot: Set, futures: Set }
// 币的合约下了但现货还活着，则合约标记下架、现货不标
function isDelisted(symbol, activeSets, kind, market) {
  const spot = activeSets.spot
  const futures = activeSets.futures
  if (!spot.size && !futures.size) return null
  const s = String(symbol).toUpperCase()
  const full = s.endsWith('USDT') ? s : s + 'USDT'
  // base 形态的股票/商品代币是 2021 年 BUSD 计价产品（早已下架），
  // 与同名 2026 USDT 永续（AAPLUSDT 等）是不同产品，不能因后者活跃而判为未下架
  if (!s.endsWith('USDT') && (kind === 'stock' || kind === 'commodity')) return true
  // 按 listing 所属市场判断：只查对应市场的活跃集合
  const set = market === 'futures' ? futures : spot
  const active = set.has(s) || set.has(full)
  // 若该市场集合为空（还没拉到对应市场数据），退回综合判断
  if (!set.size) {
    const combined = new Set([...spot])
    for (const x of futures) combined.add(x)
    return !(combined.has(s) || combined.has(full))
  }
  return !active
}

app.get('/api/status', (_req, res) => {
  res.json({
    ...monitor.getStatus(),
    smtpConfigured: !!getSetting('smtp_host'),
    smtpMasked: getSetting('smtp_user') ? getSetting('smtp_user') : null,
    hasRecipients: !!(getSetting('recipients') || '').trim(),
  })
})

app.get('/api/settings', (_req, res) => {
  const s = getSettings()
  if (s.smtp_pass) s.smtp_pass = '***已设置***'
  if (s.admin_pass) delete s.admin_pass
  res.json(s)
})

app.post('/api/settings', (req, res) => {
  const fields = [
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'recipients',
    'spread_alert_enabled', 'spread_alert_threshold', 'spread_watchlist',
  ]
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'smtp_pass' && String(req.body[f]).trim() === '') continue
      setSetting(f, String(req.body[f]).trim())
    }
  }
  res.json({ ok: true })
})

app.post('/api/test-email', async (_req, res) => {
  try {
    const to = await sendMail('【测试】币安上新监控邮件配置', '<p>SMTP 配置正常，测试邮件发送成功。</p>')
    console.log(`[mail] 测试邮件发送成功 → ${to.join(', ')}`)
    res.json({ ok: true, to })
  } catch (e) {
    console.error('[mail] 测试邮件发送失败:', e.message)
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/monitor/run', async (_req, res) => {
  try {
    await monitor.runOnce()
    res.json({ ok: true, status: monitor.getStatus() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/history/status', (_req, res) => {
  res.json(getHistoryStatus())
})

const dist = path.join(__dirname, '..', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`)
  monitor.startMonitor()
  startHistory()
})
