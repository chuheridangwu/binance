import { db, getSetting, setSetting } from './db.js'
import { getPerpetualSymbols, getFirstKlineTime, fetchListingAnnouncements } from './binance.js'
import { sendMail } from './mailer.js'
import { getSpreadData, DEFAULT_WATCH } from './spread.js'
import { checkTrackers } from './trackers.js'
import { checkAlerts } from './indicator_alerts.js'
import * as screener from './screener.js'
import { enrichCoinInfos } from './coingecko.js'

const state = {
  lastCheck: 0,
  lastAnnouncementScan: 0,
  lastSpreadScan: 0,
  lastCoinEnrich: 0,
  lastEmailAt: 0,
  lastEmailTo: [],
  totalListings: 0,
  notifiedCount: 0,
  scanErrors: [],
  running: false,
}

const MAX_NOTIFY_ATTEMPTS = 10
const NOTIFY_ATTEMPT_INTERVAL_MS = 30 * 60 * 1000
const NOTIFY_RETRY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000

// 定时扫描：北京时间 00:01 / 04:01 / 08:01 / 12:01 / 16:01 / 20:01 各跑一次默认规则扫描
const SCHEDULED_SLOTS = ['00:01', '04:01', '08:01', '12:01', '16:01', '20:01']
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function beijingClock() {
  const d = new Date(Date.now() + BEIJING_OFFSET_MS)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return { hhmm: `${hh}:${mm}`, day }
}

// 全局扫描槽序号：每天 6 个时段，跨天递增，用于判断"连续命中"
function slotIndex(day, hhmm) {
  const pos = SCHEDULED_SLOTS.indexOf(hhmm)
  if (pos < 0) return -1
  const [y, m, d] = day.split('-').map(Number)
  const dayNo = Math.floor(Date.UTC(y, m - 1, d) / 86400000)
  return dayNo * 6 + pos
}

async function scanScheduledDefault() {
  const { hhmm, day } = beijingClock()
  if (!SCHEDULED_SLOTS.includes(hhmm)) return
  const key = `sched_scan_${day}_${hhmm}`
  if (getSetting(key) === '1') return
  setSetting(key, '1') // 占位防并发重复
  const defaultRules = { r1: true, r2: true, r3: true, r4: true, r5: true }
  const params = { ...screener.RULE_DEFAULTS }
  let result
  try {
    result = await screener.scan(defaultRules, 'any', { params })
  } catch (e) {
    setSetting(key, '') // 扫描失败允许下次重试
    state.scanErrors.push(`定时选股扫描失败: ${e.message}`)
    state.scanErrors = state.scanErrors.slice(-20)
    return
  }
  // 只保留命中 ≥3 条默认规则的合约
  const hits = (result.results || []).filter((r) => (r.matched || []).length >= 3)
  if (!hits.length) return

  // 连续 N 个扫描时段都被命中 → 重点关注标记（跨天累计）
  const curSlot = slotIndex(day, hhmm)
  const streakKey = 'sched_streak'
  let streaks = {}
  try {
    streaks = JSON.parse(getSetting(streakKey) || '{}')
  } catch {
    streaks = {}
  }
  const HOT_MIN_STREAK = 3
  const hot = new Set()
  for (const r of hits) {
    const prev = streaks[r.symbol]
    let count = 1
    if (prev && prev.slot === curSlot - 1) count = (prev.count || 0) + 1
    streaks[r.symbol] = { slot: curSlot, count }
    if (count >= HOT_MIN_STREAK) hot.add(r.symbol)
  }
  setSetting(streakKey, JSON.stringify(streaks))

  // 本次扫描使用的规则清单（放在邮件最上方）
  const rulesHtml = Object.keys(defaultRules)
    .filter((id) => defaultRules[id])
    .map((id) => {
      const meta = screener.RULES.find((x) => x.id === id)
      if (!meta) return `<li>${id}</li>`
      const p = params[id] ?? meta.param?.def
      const name = meta.param ? meta.name.replace(/近N日|前N日|N日内|前N日总和/g, (m) => m.replace(/N/g, p)) : meta.name
      return `<li>${name}</li>`
    })
    .join('')
  const rows = hits
    .map(
      (r) =>
        `<tr><td>${r.symbol}${hot.has(r.symbol) ? ' ⭐' : ''}${r.muted ? ' 🚫' : ''}</td><td>${r.listed || '—'}</td><td>${r.price}</td><td>${(r.matched || []).map((id) => id.toUpperCase()).join(', ')}</td></tr>`
    )
    .join('')
  try {
    await sendMail(
      `【选股提醒】定时扫描命中 ${hits.length} 个合约（${hhmm} 北京时间）`,
      `<p>定时默认规则扫描（北京时间 ${hhmm}，匹配方式：任一满足）判定规则：</p>` +
        `<ul>${rulesHtml}</ul>` +
        `<p>命中 ≥3 条规则的 ${hits.length} 个合约：</p>` +
        `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">` +
        `<tr><th>币种</th><th>上架</th><th>现价</th><th>命中规则</th></tr>${rows}</table>` +
        `<p>⭐ = 连续 3 个扫描时段都被命中的合约，重点关注。🚫 = 标记为「不追踪」的合约（排在最下方）。</p>` +
        `<p>排序：命中规则数多的靠前，相同的按 RSI6 从高到低。扫描时间：${new Date().toLocaleString('zh-CN')}</p>`
    )
    state.lastEmailAt = Date.now()
    state.lastEmailTo = (getSetting('recipients') || '').split(/[,;，；\s]+/).filter(Boolean)
  } catch (e) {
    console.error('[mail] 定时选股邮件发送失败:', e.message)
  }
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
  const row = db.prepare('SELECT notified, retry_count, last_notify_attempt FROM listings WHERE code = ?').get(listing.code)
  if (row?.notified) return
  const now = Date.now()
  const attempts = row?.retry_count ?? 0
  if (attempts >= MAX_NOTIFY_ATTEMPTS) {
    state.scanErrors.push(`通知${listing.symbol}重试已达上限(${MAX_NOTIFY_ATTEMPTS} 次)，放弃`)
    state.scanErrors = state.scanErrors.slice(-20)
    return
  }
  if (row?.last_notify_attempt && now - row.last_notify_attempt < NOTIFY_ATTEMPT_INTERVAL_MS) return
  db.prepare('UPDATE listings SET last_notify_attempt = ?, retry_count = retry_count + 1 WHERE code = ?').run(now, listing.code)
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

async function retryPendingNotifications() {
  const cutoff = Date.now() - NOTIFY_RETRY_WINDOW_MS
  const notifiedSyms = new Set(
    db.prepare('SELECT DISTINCT symbol FROM listings WHERE notified = 1').all().map((r) => r.symbol)
  )
  const rows = db
    .prepare('SELECT code, symbol, title, date FROM listings WHERE notified = 0 AND date >= ? AND retry_count < ?')
    .all(cutoff, MAX_NOTIFY_ATTEMPTS)
  for (const r of rows) {
    if (notifiedSyms.has(r.symbol)) continue
    await notify({ code: r.code, symbol: r.symbol, title: r.title, date: r.date })
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
    const known = new Set(db.prepare('SELECT code FROM listings').all().map((r) => r.code))
    // 增量扫描只翻前几页即可：补全完成后整页已入库会提前停止，正常情况下只拉 1~2 页
    const { list } = await fetchListingAnnouncements(5, known)
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
    // 只用永续合约，避免把季度/交割合约也当成"新上"
    futures = await getPerpetualSymbols()
  } catch (e) {
    state.scanErrors.push(`合约exchangeInfo失败: ${e.message}`)
    return
  }
  // 去重要兼容两种符号格式：公告行是 base（ARB），行情反推行是完整对（ARBUSDT）
  // 同一合约两条路径只记一次，避免重复计数
  const known = new Set(
    db
      .prepare('SELECT symbol FROM listings')
      .all()
      .flatMap((r) => [r.symbol.toUpperCase(), r.symbol.toUpperCase().replace(/USDT$/, '')])
  )
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
    await retryPendingNotifications()
    if (Date.now() - state.lastSpreadScan > 5 * 60 * 1000) {
      await scanSpreads()
    }
    await checkTrackers()
    try {
      const r = await checkAlerts()
      if (r.triggered) {
        state.lastEmailAt = Date.now()
        state.lastEmailTo = (getSetting('recipients') || '').split(/[,;，；\s]+/).filter(Boolean)
      }
    } catch (e) {
      state.scanErrors.push(`指标告警检查失败: ${e.message}`)
      state.scanErrors = state.scanErrors.slice(-20)
    }
    await scanScheduledDefault()
    if (Date.now() - state.lastCoinEnrich > 60 * 60 * 1000) {
      try {
        const n = await enrichCoinInfos({ limit: 40 })
        if (n) console.log(`[monitor] CoinGecko 预取 ${n} 个币信息`)
      } catch {
        // 免费接口限流/超时不影响主流程
      }
      state.lastCoinEnrich = Date.now()
    }
  } finally {
    state.lastCheck = Date.now()
    state.running = false
  }
}

export function startMonitor(intervalMs = 60_000) {
  const iv = Math.max(intervalMs, 10_000)
  setInterval(runOnce, iv)
  // 等首轮 runOnce 跑完再启动全量补全，避免启动瞬间两个公告抓取并发
  runOnce().then(() => bootstrapAnnouncements().catch(() => {}))
  return () => clearInterval(iv)
}

// 一次性全量补全公告历史（不受 known 提前截断影响），只跑一次。
// 之后监控的增量扫描走 known 提前停止，不会重复拉全量页。
async function bootstrapAnnouncements() {
  if (getSetting('announce_backfill_done') === '1') return
  const { list, completed } = await fetchListingAnnouncements(100)
  if (!completed || !list.length) return
  for (const a of list) {
    await upsertListing({ code: a.code, symbol: a.symbol, title: a.title, date: a.date, market: 'announce', source: 'announcement' })
  }
  setSetting('announce_backfill_done', '1')
  console.log(`[monitor] 公告历史补全完成，共 ${list.length} 条`)
}

export { getSetting, setSetting }
