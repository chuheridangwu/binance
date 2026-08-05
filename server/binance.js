import { readKlines, writeKlines, readOi, writeOi, readKlinesWindow } from './cache.js'
import { db } from './db.js'

const SPOT = 'https://api.binance.com/api/v3'
const FUTURES = 'https://fapi.binance.com/fapi/v1'
const ANNOUNCE = 'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 全局币安请求限速器：所有经此模块发出的请求共享，从根上防止触发 IP 限流/封禁。
// 我把并发压得很低、两次请求之间强制间隔，宁可扫描变慢也别打爆币安。
const RATE = {
  maxConcurrent: 4,   // 同一时刻最多 4 个在途请求
  minIntervalMs: 180, // 相邻两次请求起始时间至少相隔 180ms
  inflight: 0,
  nextSlot: 0,
}

async function acquire() {
  for (;;) {
    if (RATE.inflight < RATE.maxConcurrent) {
      const now = Date.now()
      if (now >= RATE.nextSlot) {
        RATE.nextSlot = now + RATE.minIntervalMs
        RATE.inflight++
        let released = false
        return () => {
          if (!released) {
            released = true
            RATE.inflight = Math.max(0, RATE.inflight - 1)
          }
        }
      }
      await sleep(Math.min(50, RATE.nextSlot - now))
    } else {
      await sleep(30)
    }
  }
}

export async function getJson(url, timeoutMs = 15000) {
  const retries = 2
  for (let attempt = 0; ; attempt++) {
    const release = await acquire()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let resp = null
    try {
      resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!resp.ok && resp.status !== 429 && resp.status !== 418) throw new Error(`HTTP ${resp.status}`)
      if (resp.ok) return await resp.json()
    } catch (e) {
      throw e
    } finally {
      clearTimeout(timer)
      release()
    }
    // 只有 429/418 走到这里：按 retry-after 退避后重试，最多 retries 次
    const retryAfter = Math.max(1, Number(resp.headers.get('retry-after') || 10))
    if (attempt >= retries) {
      throw new Error(`币安限流(HTTP ${resp.status})，IP 触发冷却，请等待 ${retryAfter}s 后再试`)
    }
    await sleep(retryAfter * 1000)
  }
}

const SYMBOLS_TTL = 30 * 60 * 1000
const SYMBOLS_MAX_STALE = 12 * 3600 * 1000

let symbolsCache = null
let symbolsExp = 0
let allSymbolsCache = null
let allSymbolsExp = 0
let exchangeCache = { spot: null, futures: null }
let exchangeExp = { spot: 0, futures: 0 }

// 币种列表持久化到 DB：监控每分钟读一次合约列表、搜索/扫描也反复读。
// 落库后重启不重拉，也天然成为币安 API 故障时的兜底数据。
async function fetchAndStoreSymbols() {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO symbols (symbol, market, active, type, underlying, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, market) DO UPDATE SET
       active = excluded.active, type = excluded.type, underlying = excluded.underlying, fetched_at = excluded.fetched_at`
  )
  db.exec('BEGIN')
  try {
    for (const base of [SPOT, FUTURES]) {
      const market = base === FUTURES ? 'futures' : 'spot'
      try {
        const data = await getJson(`${base}/exchangeInfo`)
        for (const s of data.symbols) {
          if (s.quoteAsset !== 'USDT') continue
          // futures 才有 underlyingType（STOCK/COMMODITY 等代表股票/商品永续，如 AAPLUSDT、XAGUSDT）
          stmt.run(s.symbol, market, s.status === 'TRADING' ? 1 : 0, s.contractType || '', s.underlyingType || '', now)
        }
      } catch {
        /* 单个市场拉取失败不致命，保留旧数据 */
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

async function ensureSymbolsFresh() {
  const m = db.prepare('SELECT MAX(fetched_at) AS t FROM symbols').get()
  if (!m.t || Date.now() - m.t > SYMBOLS_MAX_STALE) {
    try {
      await fetchAndStoreSymbols()
    } catch {
      /* 拉取失败用旧数据兜底 */
    }
  }
}

export async function getExchangeInfo(market) {
  const key = market === 'futures' ? 'futures' : 'spot'
  if (exchangeCache[key] && exchangeExp[key] > Date.now()) return exchangeCache[key]
  await ensureSymbolsFresh()
  const rows = db.prepare('SELECT symbol FROM symbols WHERE market = ? AND active = 1').all(key)
  exchangeCache[key] = rows.map((r) => r.symbol)
  exchangeExp[key] = Date.now() + SYMBOLS_TTL
  return exchangeCache[key]
}

export async function getPerpetualSymbols() {
  if (symbolsCache && symbolsExp > Date.now()) return symbolsCache
  await ensureSymbolsFresh()
  const rows = db
    .prepare("SELECT symbol FROM symbols WHERE market = 'futures' AND active = 1 AND type = 'PERPETUAL'")
    .all()
  symbolsCache = rows.map((r) => r.symbol)
  symbolsExp = Date.now() + SYMBOLS_TTL
  return symbolsCache
}

export async function getAllSymbols() {
  if (allSymbolsCache && allSymbolsExp > Date.now()) return allSymbolsCache
  await ensureSymbolsFresh()
  const rows = db.prepare('SELECT symbol, active FROM symbols').all()
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.symbol) || r.active === 1) out.set(r.symbol, r.active === 1)
  }
  allSymbolsCache = [...out.entries()].map(([symbol, active]) => ({ symbol, active }))
  allSymbolsExp = Date.now() + SYMBOLS_TTL
  return allSymbolsCache
}

setInterval(() => {
  fetchAndStoreSymbols().catch(() => {})
}, SYMBOLS_TTL).unref?.()

export async function getFuturesKlines(symbol, interval, limit = 120) {
  const cached = readKlines(symbol, interval)
  if (cached) return cached
  try {
    const rows = await getJson(`${FUTURES}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
    const klines = rows.map((r) => ({
      time: r[0] / 1000,
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    if (klines.length) writeKlines(symbol, interval, klines)
    return klines
  } catch {
    return []
  }
}

export async function getOpenInterestHistory(symbol, period = '1d', limit = 7) {
  const cached = readOi(symbol)
  if (cached) return cached
  try {
    const data = await getJson(
      `${FUTURES}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`
    )
    const rows = data.map((d) => ({
      time: d.timestamp,
      oi: +d.sumOpenInterest,
      oiValue: +d.sumOpenInterestValue,
    }))
    if (rows.length) writeOi(symbol, rows)
    return rows
  } catch {
    return []
  }
}

export async function getFirstKlineTime(symbol, market) {
  const base = market === 'futures' ? FUTURES : SPOT
  try {
    const data = await getJson(`${base}/klines?symbol=${symbol}&interval=1d&startTime=0&limit=1`)
    return data.length ? data[0][0] : null
  } catch {
    return null
  }
}

export async function getKlines(symbol, interval, limit = 500, beforeSec) {
  const cached = readKlinesWindow(symbol, interval, limit, beforeSec)
  if (cached) return cached
  const url =
    `${SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}` +
    (beforeSec ? `&endTime=${beforeSec * 1000 - 1}` : '')
  try {
    const rows = await getJson(url)
    const klines = rows.map((r) => ({
      time: r[0] / 1000,
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    if (klines.length) writeKlines(symbol, interval, klines)
    return klines
  } catch {
    const rows = await getJson(url.replace(SPOT, FUTURES))
    const klines = rows.map((r) => ({
      time: r[0] / 1000,
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    if (klines.length) writeKlines(symbol, interval, klines)
    return klines
  }
}

export async function searchSymbols(keyword) {
  const kw = (keyword || '').toUpperCase()
  const all = await getAllSymbols()
  const underlying = buildUnderlyingMap()
  const matches = all
    .filter((s) => s.symbol.includes(kw))
    .map((m) => ({ ...m, kind: classifyKind(m.symbol, '', underlying.get(m.symbol.toUpperCase())) }))
  matches.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.symbol.localeCompare(b.symbol)
  })
  return matches.slice(0, 30)
}

// 股票/商品代币与「股票/商品永续合约」（如 AAPLUSDT、XAGUSDT）识别
const STOCK_RE = /tokenized stock|stock token|股票代币|股票/i
const COMMODITY_RE = /tokenized commodity|commodity token|商品代币|原油|黄金|大宗商品/i

// 兜底集合：underlyingType 未命中或已下架不在 exchangeInfo 的已知股票/商品代币
const STOCK_SYMBOLS = new Set([
  'AAPL', 'TSLA', 'COIN', 'MSTR', 'MSFT', 'BABA', 'SQ', 'AMZN', 'GOOG', 'NIO',
  'GME', 'AMC', 'PFE', 'BAC', 'BILI', 'QQQ', 'SPY', 'TSM', 'AB', 'ARLP', 'GLP', 'ET',
])
const COMMODITY_SYMBOLS = new Set(['OIL', 'BRENT', 'GOLD', 'XAG', 'XAU', 'SLV', 'GLD', 'USO', 'COPPER'])

export function classifyKind(symbol, title, underlying = '') {
  const t = String(title || '')
  if (STOCK_RE.test(t)) return 'stock'
  if (COMMODITY_RE.test(t)) return 'commodity'
  const u = String(underlying || '').toUpperCase()
  if (u === 'STOCK') return 'stock'
  if (u === 'COMMODITY') return 'commodity'
  const base = String(symbol || '').toUpperCase().replace(/USDT$/, '')
  if (STOCK_SYMBOLS.has(base)) return 'stock'
  if (COMMODITY_SYMBOLS.has(base)) return 'commodity'
  return 'crypto'
}

export function buildUnderlyingMap() {
  const map = new Map()
  const rows = db.prepare("SELECT symbol, underlying FROM symbols WHERE underlying != ''").all()
  for (const r of rows) {
    map.set(r.symbol.toUpperCase(), r.underlying)
    const base = r.symbol.replace(/USDT$/, '')
    if (!map.has(base)) map.set(base, r.underlying)
  }
  return map
}

function parseListedSymbol(title) {
  const m = title.match(/\(([A-Z0-9]{1,12})\)\s*$/)
  if (m) return m[1]
  const m2 = title.match(/Will List ([A-Z0-9]+)/)
  return m2 ? m2[1] : null
}

export async function fetchListingAnnouncements(maxPages = 40, known = new Set()) {
  const seen = new Map()
  let page = 1
  let consecutiveFailures = 0
  let completed = false

  while (page <= maxPages) {
    const params = new URLSearchParams({ catalogId: '48', type: '1', pageNo: String(page), pageSize: '20' })
    try {
      const res = await getJson(`${ANNOUNCE}?${params}`)
      const articles = res.data?.catalog?.articles || res.data?.articles || []
      if (!articles.length) {
        completed = true
        break
      }
      for (const a of articles) {
        if (!seen.has(a.code)) seen.set(a.code, a)
      }
      // 整页公告都已在库里：后面的页都是旧的，不必再翻，避免每 30 分钟重复拉全量页
      if (known.size && articles.every((a) => known.has(a.code))) break
      consecutiveFailures = 0
      page++
      // 翻页之间主动让一步，公告目录是公开内容接口，别把单次补全做得像爬虫
      await sleep(250)
    } catch {
      consecutiveFailures++
      if (consecutiveFailures >= 5) break
      page++
    }
  }
  if (!completed && page > maxPages) completed = true

  const list = Array.from(seen.values())
    .map((a) => {
      const title = String(a.title || '').replace(/<[^>]+>/g, '')
      return {
        code: a.code,
        title,
        symbol: parseListedSymbol(title),
        date: new Date(a.releaseDate).getTime(),
        isNewListing: /List|上线|上架/i.test(title),
      }
    })
    .filter((a) => a.isNewListing && a.symbol)

  return { list, completed }
}
