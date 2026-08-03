import { db, getSetting, setSetting } from './db.js'
import { getExchangeInfo, getFirstKlineTime, fetchListingAnnouncements } from './binance.js'
import { sendMail } from './mailer.js'

const state = {
  lastCheck: 0,
  lastAnnouncementScan: 0,
  lastEmailAt: 0,
  lastEmailTo: [],
  totalListings: 0,
  notifiedCount: 0,
  scanErrors: [],
  running: false,
}

export function getStatus() {
  state.totalListings = db.prepare('SELECT COUNT(*) AS n FROM listings').get().n
  state.notifiedCount = db.prepare('SELECT COUNT(*) AS n FROM listings WHERE notified = 1').get().n
  return { ...state }
}

function isSameDay(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

async function notify(listing) {
  const up = db.prepare('SELECT notified FROM listings WHERE code = ?').get(listing.code)
  if (up?.notified) return
  const display = listing.title ? listing.title : `币安新上线：${listing.symbol}`
  const dateStr = new Date(listing.date).toISOString().slice(0, 10)
  try {
    const to = await sendMail(
      `【币安上新】${listing.symbol} 今日上线`,
      `<p><b>${display}</b></p><p>上线日期：${dateStr}</p><p>监控时间：${new Date().toLocaleString('zh-CN')}</p>`
    )
    db.prepare('UPDATE listings SET notified = 1 WHERE code = ?').run(listing.code)
    state.lastEmailAt = Date.now()
    state.lastEmailTo = to
  } catch (e) {
    console.error(`[mail] 发送邮件失败(${listing.symbol}):`, e.message)
    state.scanErrors.push(`发送邮件失败(${listing.symbol}): ${e.message}`)
    state.scanErrors = state.scanErrors.slice(-20)
  }
}

async function upsertListing({ code, symbol, title, date, market, source }) {
  db.prepare(
    `INSERT INTO listings (code, symbol, title, date, market, notified, source)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(code) DO UPDATE SET title = excluded.title`
  ).run(code, symbol, title || '', date, market || '', source || '')
}

async function scanAnnouncements() {
  try {
    const list = await fetchListingAnnouncements(20)
    for (const a of list) {
      await upsertListing({ code: a.code, symbol: a.symbol, title: a.title, date: a.date, market: 'announce', source: 'announcement' })
      if (isSameDay(a.date, Date.now())) await notify({ code: a.code, symbol: a.symbol, title: a.title, date: a.date })
    }
    state.lastAnnouncementScan = Date.now()
  } catch (e) {
    state.scanErrors.push(`公告扫描失败: ${e.message}`)
    state.scanErrors = state.scanErrors.slice(-20)
  }
}

async function scanMarketDiff() {
  let futures = []
  try {
    futures = await getExchangeInfo('futures')
  } catch (e) {
    state.scanErrors.push(`合约exchangeInfo失败: ${e.message}`)
    return
  }
  const known = new Set(db.prepare('SELECT symbol FROM listings').all().map((r) => r.symbol))
  const fresh = futures.filter((s) => !known.has(s))
  for (const symbol of fresh) {
    const t = await getFirstKlineTime(symbol, 'futures')
    if (!t) continue
    const date = t
    const code = `futures-${symbol}`
    const title = `Binance Futures 新上合约：${symbol}`
    await upsertListing({ code, symbol, title, date, market: 'futures', source: 'market-diff' })
    if (isSameDay(date, Date.now())) await notify({ code, symbol, title, date })
  }
}

export async function runOnce() {
  if (state.running) return
  state.running = true
  try {
    await scanMarketDiff()
    if (Date.now() - state.lastAnnouncementScan > 30 * 60 * 1000) {
      await scanAnnouncements()
    }
  } finally {
    state.lastCheck = Date.now()
    state.running = false
  }
}

export function startMonitor(intervalMs = 60_000) {
  const iv = Math.max(intervalMs, 10_000)
  setInterval(runOnce, iv)
  runOnce()
  return () => clearInterval(iv)
}

export { getSetting, setSetting }
