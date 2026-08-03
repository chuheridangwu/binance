import { db, getSetting, setSetting } from './db.js'
import { getExchangeInfo, getFirstKlineTime, fetchListingAnnouncements } from './binance.js'
import { sendMail, sendListingMail } from './mailer.js'
import { getSpreadData, DEFAULT_WATCH } from './spread.js'

const state = {
  lastCheck: 0,
  lastAnnouncementScan: 0,
  lastSpreadScan: 0,
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
  try {
    const to = await sendListingMail(listing)
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

async function scanSpreads() {
  if (getSetting('spread_alert_enabled') !== '1') return
  const threshold = Number(getSetting('spread_alert_threshold') || 30)
  const watch = (getSetting('spread_watchlist') || '').split(/[,，\s]+/).filter(Boolean)
  const syms = watch.length ? watch : DEFAULT_WATCH

  let data
  try {
    data = await getSpreadData(syms)
  } catch (e) {
    state.scanErrors.push(`价差监控失败: ${e.message}`)
    state.scanErrors = state.scanErrors.slice(-20)
    return
  }
  state.lastSpreadScan = Date.now()

  const today = new Date().toISOString().slice(0, 10)
  for (const r of data.rows) {
    if (Math.abs(r.annualized) < threshold) continue
    const key = `spread_notify_${r.symbol}`
    if (getSetting(key) === today) continue
    try {
      await sendMail(
        `【套利提醒】${r.symbol} 年化资金费率 ${r.annualized}%`,
        `<p><b>${r.symbol}</b> 出现高资金费率机会</p>` +
          `<p>永续价格：${r.futuresPrice ?? '—'}</p>` +
          `<p>现货价格：${r.spotPrice ?? '—'}</p>` +
          `<p>永续溢价：${r.premiumPct ?? '—'}%</p>` +
          `<p>当前资金费率：${r.fundingRate}%</p>` +
          `<p>年化资金费率：<b>${r.annualized}%</b>（阈值 ${threshold}%）</p>` +
          `<p>下次结算：${new Date(r.nextFundingTime).toLocaleString('zh-CN')}</p>` +
          `<p>提醒时间：${new Date().toLocaleString('zh-CN')}</p>`
      )
      setSetting(key, today)
      state.lastEmailAt = Date.now()
      state.lastEmailTo = (getSetting('recipients') || '').split(/[,;，；\s]+/).filter(Boolean)
    } catch (e) {
      console.error(`[mail] 套利提醒发送失败(${r.symbol}):`, e.message)
    }
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
    if (Date.now() - state.lastSpreadScan > 5 * 60 * 1000) {
      await scanSpreads()
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
