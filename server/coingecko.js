import { db } from './db.js'

// CoinGecko 免费(Demo)计划：100 次/分钟，需带 x-cg-demo-api-key；无 key 走 keyless(共享 IP 限流)。
// 币安没有提供币的基础信息(全名/市值/供应量/ATH/ATL/上线交易所)，统一从这里补。
// 每个币只查两次(搜索+详情)，结果落库缓存 24h，避免浪费免费额度。
const CG = 'https://api.coingecko.com/api/v3'
const CACHE_TTL_MS = 24 * 3600 * 1000
const SEARCH_TTL_MS = 7 * 24 * 3600 * 1000

const RATE = { maxConcurrent: 2, minIntervalMs: 600, inflight: 0, nextSlot: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getApiKey() {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get('coingecko_api_key')?.value || '').trim()
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
      const key = getApiKey()
      const sep = url.includes('?') ? '&' : '?'
      const u = key ? `${url}${sep}x_cg_demo_api_key=${encodeURIComponent(key)}` : url
      resp = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
      if (!resp.ok && resp.status !== 429) throw new Error(`CoinGecko HTTP ${resp.status}`)
      if (resp.ok) return await resp.json()
    } catch (e) {
      throw e
    } finally {
      clearTimeout(timer)
      release()
    }
    const retryAfter = Math.max(2, Number(resp.headers.get('retry-after') || 10))
    if (attempt >= retries) throw new Error(`CoinGecko 限流(HTTP ${resp.status})，请稍后再试`)
    await sleep(retryAfter * 1000)
  }
}

// 归一化币安交易对符号 → 基础币符号：ARBUSDT → ARB、BTCUSDT → BTC
export function baseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().trim()
  return s.replace(/USDT$/, '').replace(/USD$/, '')
}

// 用符号搜索 CoinGecko，返回最佳匹配的 coin id（优先精确符号 + 有市值排名的）
async function searchCoinId(sym) {
  const cache = db.prepare('SELECT coin_id FROM cg_search WHERE symbol = ?').get(sym)
  if (cache && cache.coin_id && Date.now() - (cache.fetched_at || 0) < SEARCH_TTL_MS) return cache.coin_id
  const data = await getJson(`${CG}/search?query=${encodeURIComponent(sym)}`)
  const coins = Array.isArray(data.coins) ? data.coins : []
  const exact = coins.filter((c) => String(c.symbol || '').toUpperCase() === sym)
  const ranked = exact.filter((c) => typeof c.market_cap_rank === 'number')
  const pick = ranked.length
    ? ranked.sort((a, b) => a.market_cap_rank - b.market_cap_rank)[0]
    : exact[0]
  if (!pick?.id) {
    db.prepare('INSERT OR REPLACE INTO cg_search (symbol, coin_id, fetched_at) VALUES (?, ?, ?)').run(sym, '', Date.now())
    return null
  }
  db.prepare('INSERT OR REPLACE INTO cg_search (symbol, coin_id, fetched_at) VALUES (?, ?, ?)').run(sym, pick.id, Date.now())
  return pick.id
}

export async function getCoinInfo(symbol) {
  const base = baseSymbol(symbol)
  const cached = db.prepare('SELECT data, fetched_at FROM cg_cache WHERE symbol = ?').get(base)
  if (cached?.data && Date.now() - (cached.fetched_at || 0) < CACHE_TTL_MS) {
    return { symbol: base, ...JSON.parse(cached.data), cached: true }
  }

  const id = await searchCoinId(base)
  if (!id) {
    const miss = { symbol: base, name: '', found: false }
    db.prepare('INSERT OR REPLACE INTO cg_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(miss), Date.now())
    return miss
  }

  const d = await getJson(
    `${CG}/coins/${id}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=false&sparkline=false`
  )
  const md = d.market_data || {}
  const exchangeSet = new Set()
  for (const t of Array.isArray(d.tickers) ? d.tickers : []) {
    if (t?.market?.name) exchangeSet.add(t.market.name)
  }
  const info = {
    symbol: base,
    name: d.name || '',
    found: true,
    marketCapUsd: md.market_cap?.usd ?? null,
    fdvUsd: md.fully_diluted_valuation?.usd ?? null,
    circulatingSupply: md.circulating_supply ?? null,
    totalSupply: md.total_supply ?? null,
    maxSupply: md.max_supply ?? null,
    athUsd: md.ath?.usd ?? null,
    athDate: md.ath_date?.usd ?? null,
    atlUsd: md.atl?.usd ?? null,
    atlDate: md.atl_date?.usd ?? null,
    exchanges: [...exchangeSet].sort(),
    coingeckoId: id,
  }
  db.prepare('INSERT OR REPLACE INTO cg_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(info), Date.now())
  return info
}
