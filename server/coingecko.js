import { db } from './db.js'

const CG = 'https://api.coingecko.com/api/v3'
const CACHE_TTL_MS = 24 * 3600 * 1000
const SEARCH_TTL_MS = 7 * 24 * 3600 * 1000
const WEB_SEARCH_TTL = 24 * 3600 * 1000

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

export function baseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().trim()
  return s.replace(/USDT$/, '').replace(/USD$/, '')
}

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

export function getCachedCoinInfo(symbol) {
  const base = baseSymbol(symbol)
  const cached = db.prepare('SELECT data, fetched_at FROM cg_cache WHERE symbol = ?').get(base)
  if (cached?.data && Date.now() - (cached.fetched_at || 0) < CACHE_TTL_MS) {
    return JSON.parse(cached.data)
  }
  return null
}

export async function enrichCoinInfos({ limit = 30, months = 6 } = {}) {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  const rows = db.prepare('SELECT DISTINCT symbol FROM listings WHERE date >= ?').all(cutoff.getTime())
  const bases = [...new Set(rows.map((r) => baseSymbol(r.symbol)))]
  let done = 0
  for (const base of bases) {
    if (done >= limit) break
    if (getCachedCoinInfo(base)) continue
    try {
      await getCoinInfo(base)
      done++
    } catch {
    }
  }
  return done
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
    `${CG}/coins/${id}?localization=false&tickers=true&market_data=true&community_data=true&developer_data=true&sparkline=false`
  )
  const md = d.market_data || {}
  const exchangeSet = new Set()
  for (const t of Array.isArray(d.tickers) ? d.tickers : []) {
    if (t?.market?.name) exchangeSet.add(t.market.name)
  }

  const platforms = d.platforms || {}
  const platformEntries = Object.entries(platforms).filter(([_, addr]) => addr && String(addr).trim())
  const links = d.links || {}
  const dev = d.developer_data || {}
  const comm = d.community_data || {}
  const desc = d.description?.en || ''

  const info = {
    symbol: base,
    name: d.name || '',
    found: true,
    description: desc.slice(0, 3000),
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
    categories: Array.isArray(d.categories) ? d.categories.filter(Boolean) : [],
    platforms: platformEntries.length ? Object.fromEntries(platformEntries) : null,
    links: {
      homepage: links.homepage?.filter(Boolean) || [],
      twitter: links.twitter_screen_name || null,
      telegram: links.telegram_channel_identifier || null,
      reddit: links.subreddit_url || null,
      github: Array.isArray(links.repos_url?.github) ? links.repos_url.github : [],
      blockchainExplorer: links.blockchain_site?.filter(Boolean) || [],
      whitepaper: links.whitepaper || null,
    },
    github: {
      stars: dev.stars ?? null,
      forks: dev.forks ?? null,
      subscribers: dev.subscribers ?? null,
      totalIssues: dev.total_issues ?? null,
      closedIssues: dev.closed_issues ?? null,
      mergedPRs: dev.pull_requests_merged ?? null,
      contributors: dev.pull_request_contributors ?? null,
      commits4Weeks: dev.commit_count_4_weeks ?? null,
    },
    social: {
      twitterFollowers: comm.twitter_followers ?? null,
      redditSubscribers: comm.reddit_subscribers ?? null,
      telegramUsers: comm.telegram_channel_user_count ?? null,
    },
  }
  db.prepare('INSERT OR REPLACE INTO cg_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(info), Date.now())
  return info
}

async function webFetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BinanceMonitor/1.0)', Accept: 'application/json' } })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

async function wikiSearch(name) {
  const q = encodeURIComponent(name)
  let data
  try {
    data = await webFetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}+cryptocurrency&format=json&srlimit=5`)
  } catch { return null }
  const pages = data?.query?.search || []
  if (!pages.length) return null
  const title = pages[0].title
  try {
    const summary = await webFetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
    if (!summary || summary.type === 'disambiguation') return null
    return {
      title: summary.title,
      extract: summary.extract?.slice(0, 3000) || null,
      url: summary.content_urls?.desktop?.page || null,
    }
  } catch { return null }
}

export async function searchCoinInfo(symbol) {
  const base = baseSymbol(symbol)
  const cache = db.prepare('SELECT data, fetched_at FROM cg_cache WHERE symbol = ?').get(`web_${base}`)
  if (cache?.data && Date.now() - (cache.fetched_at || 0) < WEB_SEARCH_TTL) {
    return { symbol: base, ...JSON.parse(cache.data), cached: true }
  }

  const coinInfo = getCachedCoinInfo(base)
  const name = coinInfo?.name || base
  const result = { team: null, history: null, wiki: null }

  const wiki = await wikiSearch(name)
  if (wiki) result.wiki = wiki

  const teamTerms = [`${name} founder team`, `${name} cryptocurrency founder`]
  const historyTerms = [`${name} history timeline`, `${name} cryptocurrency history`]

  for (const q of teamTerms) {
    try {
      const d = await webFetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`)
      if (d?.AbstractText) {
        result.team = d.AbstractText.slice(0, 2000)
        if (!result.team) {
          const texts = (d.RelatedTopics || []).filter(t => t.Text).map(t => t.Text)
          if (texts.length) result.team = texts.slice(0, 3).join('\n')
        }
        if (result.team) break
      }
    } catch { continue }
  }

  for (const q of historyTerms) {
    try {
      const d = await webFetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`)
      if (d?.AbstractText) {
        result.history = d.AbstractText.slice(0, 2000)
        break
      }
    } catch { continue }
  }

  db.prepare('INSERT OR REPLACE INTO cg_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(`web_${base}`, JSON.stringify(result), Date.now())
  return { symbol: base, ...result }
}