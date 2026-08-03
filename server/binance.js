const SPOT = 'https://api.binance.com/api/v3'
const FUTURES = 'https://fapi.binance.com/fapi/v1'
const ANNOUNCE = 'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query'

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function getExchangeInfo(market) {
  const base = market === 'futures' ? FUTURES : SPOT
  const data = await getJson(`${base}/exchangeInfo`)
  return data.symbols
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => s.symbol)
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
  const twoYearsAgo = Date.now() - 730 * 24 * 3600 * 1000
  const seen = new Map()
  let page = 1
  let consecutiveFailures = 0

  while (page <= maxPages) {
    const params = new URLSearchParams({ catalogId: '48', type: '1', pageNo: String(page), pageSize: '20' })
    try {
      const res = await getJson(`${ANNOUNCE}?${params}`)
      const articles = res.data?.catalog?.articles || res.data?.articles || []
      if (!articles.length) break
      if (new Date(articles[0].releaseDate).getTime() < twoYearsAgo) break
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
