import { readKlines, writeKlines, readOi, writeOi } from './cache.js'

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

async function getJson(url, timeoutMs = 15000) {
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

export async function getExchangeInfo(market) {
  const base = market === 'futures' ? FUTURES : SPOT
  const data = await getJson(`${base}/exchangeInfo`)
  return data.symbols
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => s.symbol)
}

let symbolsCache = null
let symbolsExp = 0
export async function getPerpetualSymbols() {
  if (symbolsCache && symbolsExp > Date.now()) return symbolsCache
  const data = await getJson(`${FUTURES}/exchangeInfo`)
  const syms = data.symbols
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
    .map((s) => s.symbol)
  symbolsCache = syms
  symbolsExp = Date.now() + 30 * 60 * 1000
  return syms
}

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
  const url =
    `${SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}` +
    (beforeSec ? `&endTime=${beforeSec * 1000 - 1}` : '')
  try {
    const rows = await getJson(url)
    return rows.map((r) => ({
      time: r[0] / 1000,
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
  } catch {
    const rows = await getJson(url.replace(SPOT, FUTURES))
    return rows.map((r) => ({
      time: r[0] / 1000,
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
  }
}

export async function searchSymbols(keyword) {
  const kw = (keyword || '').toUpperCase()
  const all = []
  for (const base of [SPOT, FUTURES]) {
    try {
      const data = await getJson(`${base}/exchangeInfo`)
      data.symbols
        .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.symbol.includes(kw))
        .forEach((s) => all.push(s.symbol))
    } catch {
      /* 忽略 */
    }
  }
  return [...new Set(all)].slice(0, 30)
}

function parseListedSymbol(title) {
  const m = title.match(/\(([A-Z0-9]{1,12})\)\s*$/)
  if (m) return m[1]
  const m2 = title.match(/Will List ([A-Z0-9]+)/)
  return m2 ? m2[1] : null
}

export async function fetchListingAnnouncements(maxPages = 40) {
  const fourYearsAgo = Date.now() - 4 * 366 * 24 * 3600 * 1000
  const seen = new Map()
  let page = 1
  let consecutiveFailures = 0

  while (page <= maxPages) {
    const params = new URLSearchParams({ catalogId: '48', type: '1', pageNo: String(page), pageSize: '20' })
    try {
      const res = await getJson(`${ANNOUNCE}?${params}`)
      const articles = res.data?.catalog?.articles || res.data?.articles || []
      if (!articles.length) break
      if (new Date(articles[0].releaseDate).getTime() < fourYearsAgo) break
      for (const a of articles) {
        if (!seen.has(a.code)) seen.set(a.code, a)
      }
      consecutiveFailures = 0
      page++
    } catch {
      consecutiveFailures++
      if (consecutiveFailures >= 5) break
      page++
    }
  }

  return Array.from(seen.values())
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
    .filter((a) => a.isNewListing && a.symbol && a.date >= twoYearsAgo)
}
