import { db } from './db.js'

// RootData 抓取模块：从 cn.rootdata.com 抓取币的基础信息、团队、时间线，落库到 rd_cache 表。
// 用户明确不赶进度（可接受十几天），因此限速做得极保守：单并发 + 每次间隔数秒，
// 用 cookie 维持会话，尽力避免触发腾讯云 stgw WAF 或账号风控。
//
// 说明：cn.rootdata.com 网页接口是非公开 AJAX，协议可能随版本变动，因此这里把
// 「如何发起请求」「如何解析」拆成可微调函数，便于按实际抓包结果调整 URL/字段。

const BASE = 'https://cn.rootdata.com'
const TTL_MS = 30 * 24 * 3600 * 1000 // 30 天刷新一次缓存

// 极保守限速：单并发，请求之间间隔 1.5~4s（随机化，更像真人）
const RATE = { inflight: 0, nextSlot: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionCookie = ''

function setSessionCookie(cookie) {
  if (cookie) sessionCookie = String(cookie).trim()
}

// 从响应头采集 set-cookie，累积会话
function collectCookies(resp) {
  try {
    const sc = resp.headers.getSetCookie?.() || (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : [])
    if (!sc.length) return
    const keep = []
    for (const c of sc) {
      const part = c.split(';')[0]
      const eq = part.indexOf('=')
      if (eq > 0) keep.push(part)
    }
    if (keep.length) {
      const existing = new Set(sessionCookie.split(/;\s*/).filter(Boolean))
      for (const kv of keep) {
        const key = kv.split('=')[0]
        for (const old of existing) if (old.split('=')[0] === key) existing.delete(old)
        existing.add(kv)
      }
      sessionCookie = [...existing].join('; ')
    }
  } catch {
    /* 忽略采集失败 */
  }
}

async function acquire() {
  for (;;) {
    if (RATE.inflight === 0) {
      const now = Date.now()
      if (now >= RATE.nextSlot) {
        RATE.nextSlot = now + (1500 + Math.random() * 2500)
        RATE.inflight = 1
        return
      }
      await sleep(Math.min(80, RATE.nextSlot - now))
    } else {
      await sleep(50 + Math.random() * 200)
    }
  }
}

async function fetchJSON(url, { method = 'GET', body, headers = {}, timeoutMs = 25000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await acquire()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const init = {
        method,
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: `${BASE}/`,
          Origin: BASE,
          ...(sessionCookie ? { Cookie: sessionCookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      }
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
      const resp = await fetch(`${BASE}${url}`, init)
      collectCookies(resp)
      if (resp.status === 403 || resp.status === 429) {
        if (attempt >= retries) throw new Error(`RootData 风控(HTTP ${resp.status})`)
        await sleep((attempt + 1) * 30000)
        continue
      }
      if (!resp.ok) throw new Error(`RootData HTTP ${resp.status}`)
      const text = await resp.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('RootData 响应非 JSON')
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`RootData 请求超时: ${url}`)
      throw e
    } finally {
      clearTimeout(timer)
      RATE.inflight = 0
    }
  }
}

export function baseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().trim()
  return s.replace(/USDT$/, '').replace(/USD$/, '')
}

// 慢速预取：从 listings 里取最近 months 个月的新币，逐条抓取入库（限速很慢，用户接受长周期）。
// 已抓过(缓存未过期)的跳过；每条单独 try/catch，单个失败不影响整体。
export async function enrichListings({ limit = 30, months = 6 } = {}) {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  const rows = db.prepare('SELECT DISTINCT symbol FROM listings WHERE date >= ?').all(cutoff.getTime())
  const bases = [...new Set(rows.map((r) => baseSymbol(r.symbol)))]
  let done = 0
  for (const base of bases) {
    if (done >= limit) break
    if (getCachedCoinInfo(base)) continue
    try {
      const info = await getCoinInfo(base)
      if (info?.found) done++
    } catch {
      // 单个失败忽略，不阻塞整体
    }
  }
  return done
}

// 读取缓存的基础信息（用于 /api/listings 拼接，与 coingecko 保持一致接口）
export function getCachedCoinInfo(symbol) {
  const base = baseSymbol(symbol)
  const cached = db.prepare('SELECT data, fetched_at FROM rd_cache WHERE symbol = ?').get(base)
  if (cached?.data && Date.now() - (cached.fetched_at || 0) < TTL_MS) {
    try { return JSON.parse(cached.data) } catch { return null }
  }
  return null
}

// 按币符号抓取并入库。返回 Promise<info|null>。
export async function getCoinInfo(symbol) {
  const base = baseSymbol(symbol)
  const cached = db.prepare('SELECT data, fetched_at FROM rd_cache WHERE symbol = ?').get(base)
  if (cached?.data && Date.now() - (cached.fetched_at || 0) < TTL_MS) {
    return JSON.parse(cached.data)
  }

  const projectId = await searchProjectId(base)
  if (!projectId) {
    const miss = { symbol: base, found: false }
    db.prepare('INSERT OR REPLACE INTO rd_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(miss), Date.now())
    return miss
  }

  const detail = await getProjectDetail(projectId)
  if (!detail || detail.found === false) {
    const miss = { symbol: base, found: false }
    db.prepare('INSERT OR REPLACE INTO rd_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(miss), Date.now())
    return miss
  }

  const info = { symbol: base, found: true, ...detail }
  db.prepare('INSERT OR REPLACE INTO rd_cache (symbol, data, fetched_at) VALUES (?, ?, ?)').run(base, JSON.stringify(info), Date.now())
  return info
}

/* ========== 协议层：按实际抓包结果微调 ========== */

// 搜索接口：根据符号找到 project_id。先探测多种候选接口。
async function searchProjectId(base) {
  const candidates = [
    { url: '/api/Home/SearchProject', method: 'POST', body: { keyword: base } },
    { url: `/Project/Search?keyword=${encodeURIComponent(base)}`, method: 'GET' },
    { url: `/api/project/search?k=${encodeURIComponent(base)}`, method: 'GET' },
    { url: `/Projects/Search?k=${encodeURIComponent(base)}`, method: 'GET' },
  ]
  for (const c of candidates) {
    try {
      const data = await fetchJSON(c.url, { method: c.method, ...(c.body ? { body: c.body } : {}) })
      const list = pickList(data)
      if (list && list.length) {
        const hit = list.find((it) => matchSymbol(it, base))
        const picked = hit || list[0]
        return pickId(picked) || parseIdFromUrl(pickUrl(picked))
      }
      const maybeId = pickProjectId(data)
      if (maybeId) return maybeId
    } catch {
      // 尝试下一个
    }
  }
  return null
}

// 详情接口：按 project_id 抓基础信息 + 团队 + 时间线。
async function getProjectDetail(projectId) {
  const candidates = [
    { url: `/api/Projects/GetProjectDetail?projectId=${projectId}`, method: 'GET' },
    { url: `/api/Projects/Detail?projectId=${projectId}`, method: 'GET' },
    { url: '/api/Projects/GetDetail', method: 'POST', body: { projectId } },
  ]
  for (const c of candidates) {
    try {
      const data = await fetchJSON(c.url, { method: c.method, ...(c.body ? { body: c.body } : {}) })
      const parsed = normalizeDetail(data)
      if (parsed && parsed.found) return parsed
    } catch {
      // 尝试下一个
    }
  }
  return { found: false }
}

// 兼容多种包裹结构
function unwrap(data) {
  if (!data || typeof data !== 'object') return null
  if (data.data && typeof data.data === 'object') return data.data
  if (data.result && typeof data.result === 'object') return data.result
  if (data.content && typeof data.content === 'object') return data.content
  return data
}

function pickList(data) {
  const u = unwrap(data)
  if (!u) return null
  if (Array.isArray(u)) return u
  for (const k of ['list', 'items', 'results', 'data', 'projects', 'coins']) {
    if (Array.isArray(u[k]) && u[k].length) return u[k]
  }
  return null
}

function pickProjectId(data) {
  const u = unwrap(data)
  if (!u) return null
  for (const k of ['projectId', 'project_id', 'id']) {
    if (u[k] != null && String(u[k]).trim() !== '') return u[k]
  }
  return null
}

function pickUrl(item) {
  if (!item || typeof item !== 'object') return null
  for (const k of ['url', 'link', 'rootdataurl', 'pageUrl', 'href']) {
    if (item[k]) return String(item[k])
  }
  if (item.projectId != null && item.projectId !== '') return `/Projects/detail/${item.projectId}`
  return null
}

function pickId(item) {
  if (!item || typeof item !== 'object') return null
  for (const k of ['projectId', 'project_id', 'id', 'rootdataId']) {
    if (item[k] != null && String(item[k]).trim() !== '') return String(item[k])
  }
  return null
}

function parseIdFromUrl(str) {
  if (!str) return null
  const s = String(str)
  const m = s.match(/(\d+)(?:\?k=.*)?$/)
  if (m) return m[1]
  const seg = s.split('?')[0].split('/').pop()
  return seg || null
}

function matchSymbol(item, base) {
  if (!item || typeof item !== 'object') return false
  for (const k of ['symbol', 'tokenSymbol', 'token_symbol', 'name', 'title', 'symbolName']) {
    const v = String(item[k] || '').toUpperCase().trim()
    if (v === base || v === `${base}USDT` || v === `${base}USD`) return true
  }
  return false
}

// 归一化详情为 { name, logo, 简介, 官网, 标签, 团队[], 时间线[] }
function normalizeDetail(raw) {
  const u = unwrap(raw)
  if (!u || typeof u !== 'object') return { found: false }

  const team = Array.isArray(u.team)
    ? u.team.map((m) => ({
        name: m?.name || m?.nameZh || m?.realName || '',
        role: m?.role || m?.position || m?.title || m?.titleZh || '',
        avatar: m?.avatar || m?.avatarUrl || m?.logo || null,
        bio: m?.bio || m?.introduction || m?.desc || '',
        social: m?.socialMedia || m?.links || null,
      })).filter((m) => m.name)
    : []

  const events = Array.isArray(u.timeline) ? u.timeline : []
  const calendar = Array.isArray(u.events) ? u.events : (Array.isArray(u.calendar) ? u.calendar : [])
  const timeline = (events.length ? events : calendar)
    .map((e) => ({
      date: e?.date || e?.time || e?.publishDate || '',
      type: e?.type || e?.category || '',
      title: e?.title || e?.content || e?.name || '',
      desc: e?.description || e?.content || '',
    }))
    .filter((e) => e.title || e.date)

  const obj = Array.isArray(u) ? (u[0] || {}) : u

  return {
    found: true,
    name: obj.name || obj.cnName || obj.projectName || '',
    token: obj.tokenSymbol || obj.symbol || '',
    logo: obj.logo || obj.logoUrl || null,
    oneLine: obj.oneLiner || obj.one_line || obj.tagline || obj.brief || null,
    description: obj.description || obj.introduction || obj.about || '',
    website: obj.website || obj.officialWebsite || null,
    tags: Array.isArray(obj.tags) ? obj.tags.filter(Boolean) : [],
    ecology: obj.ecology || obj.ecosystem || null,
    location: obj.location || obj.country || obj.region || null,
    foundedAt: obj.establishmentDate || obj.foundedYear || null,
    status: obj.status || obj.projectStatus || null,
    tradingStatus: obj.tradingStatus || null,
    team,
    timeline,
    source: 'rootdata',
  }
}
