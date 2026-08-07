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
  const activeSyms = new Set(db.prepare('SELECT symbol FROM symbols WHERE active = 1').all().map((r) => r.symbol))
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
    const item = {
      symbol: r.symbol,
      date: d.toISOString(),
      title: r.title,
      source: r.source,
      kind,
      delisted: isDelisted(r.symbol, activeSyms, kind),
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

function round1(v) {
  return Math.round(v * 10) / 10
}

// 相似趋势：给定一个币，用日收益率序列的 Pearson 相关系数找趋势最相似的币
app.get('/api/similar', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase()
    const days = Math.min(120, Math.max(7, Number(req.query.days) || 30))
    const top = Math.min(30, Number(req.query.top) || 12)
    if (!symbol) return res.status(400).json({ error: 'symbol 必填' })
    const full = symbol.endsWith('USDT') ? symbol : symbol + 'USDT'
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const targetKl = mkt.prepare('SELECT time, close FROM klines WHERE symbol = ? AND interval = ? AND time >= ? ORDER BY time ASC').all(full, '1d', cutoff)
    if (targetKl.length < 10) return res.status(400).json({ error: '目标币历史数据不足（需 ≥10 根日K，可能在回补中）' })
    const targetRet = dailyReturns(targetKl)
    const targetMap = new Map(targetRet.map((r) => [r.time, r.ret]))
    const prices = await binance.getFuturesPrices()
    const symbols = await binance.getPerpetualSymbols()
    const sims = []
    for (const sym of symbols) {
      if (sym === full) continue
      const kl = mkt.prepare('SELECT time, close FROM klines WHERE symbol = ? AND interval = ? AND time >= ? ORDER BY time ASC').all(sym, '1d', cutoff)
      if (kl.length < 8) continue
      const symMap = new Map(dailyReturns(kl).map((r) => [r.time, r.ret]))
      const x = []
      const y = []
      for (const [t, rv] of targetMap) {
        if (symMap.has(t)) { x.push(rv); y.push(symMap.get(t)) }
      }
      if (x.length < 8) continue
      const corr = pearson(x, y)
      if (!Number.isFinite(corr)) continue
      const last = kl[kl.length - 1]
      const first = kl[0]
      sims.push({
        symbol: sym,
        similarity: Math.round(corr * 1000) / 1000,
        currentPrice: prices.get(sym) ?? null,
        retWindow: first.close > 0 ? round1((last.close / first.close - 1) * 100) : null,
      })
    }
    sims.sort((a, b) => b.similarity - a.similarity)
    res.json({ symbol, full, days, results: sims.slice(0, top), count: sims.length, generatedAt: Date.now() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
function isDelisted(symbol, activeSyms, kind) {
  if (!activeSyms.size) return null
  const s = String(symbol).toUpperCase()
  const full = s.endsWith('USDT') ? s : s + 'USDT'
  const active = activeSyms.has(s) || activeSyms.has(full)
  // base 形态的股票/商品代币是 2021 年 BUSD 计价产品（早已下架），
  // 与同名 2026 USDT 永续（AAPLUSDT 等）是不同产品，不能因后者活跃而判为未下架
  if (!s.endsWith('USDT') && (kind === 'stock' || kind === 'commodity')) return true
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
