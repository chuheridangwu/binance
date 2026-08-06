import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { getJson, getPerpetualSymbols, getFirstKlineTime } from './binance.js'

// 量化数据地基：把币安 USDT 永续的 K 线 + 资金费率历史落库到独立的 market.db（只追加，永久保存）。
// 复用 binance.js 的全局限速器，避免打爆币安。K 线分两个周期收集：
//   5m 每 15 分钟追增；30m/1h/4h/1d/1w/1M + 资金费率每 60 分钟追增。
// 回补可断点续跑（进度存 meta 表），重启后从不完整处继续。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })

export const mkt = new DatabaseSync(path.join(dataDir, 'market.db'))
mkt.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS klines (
  symbol       TEXT NOT NULL,
  interval     TEXT NOT NULL,
  time         INTEGER NOT NULL,
  open         REAL,
  high         REAL,
  low          REAL,
  close        REAL,
  volume       REAL,
  quote_volume REAL,
  trades       INTEGER,
  PRIMARY KEY (symbol, interval, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_klines_symbol ON klines(symbol, interval);
CREATE TABLE IF NOT EXISTS funding (
  symbol     TEXT NOT NULL,
  time       INTEGER NOT NULL,
  rate       REAL,
  mark_price REAL,
  PRIMARY KEY (symbol, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_funding_symbol ON funding(symbol);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`)

const FUT = 'https://fapi.binance.com/fapi/v1'
const KLINE_LIMIT = 1500
const FUND_LIMIT = 1000

// 回补顺序：先粗周期再细周期，保证热门粗数据先落地
const INTERVALS = ['1M', '1w', '1d', '4h', '1h', '30m', '5m']

const metaGet = (k) => mkt.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null
const metaSet = (k, v) =>
  mkt.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v))

const insKline = mkt.prepare(
  `INSERT OR REPLACE INTO klines (symbol, interval, time, open, high, low, close, volume, quote_volume, trades)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
function insertKlines(symbol, interval, bars) {
  if (!bars.length) return
  mkt.exec('BEGIN')
  try {
    for (const b of bars) insKline.run(symbol, interval, b.time, b.open, b.high, b.low, b.close, b.volume, b.quote_volume, b.trades)
    mkt.exec('COMMIT')
  } catch (e) {
    mkt.exec('ROLLBACK')
    throw e
  }
}

async function fetchKlinePage(symbol, interval, startTime) {
  const rows = await getJson(`${FUT}/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${KLINE_LIMIT}`)
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    quote_volume: +r[7], trades: r[8],
  }))
}

// 从进度（或币种首根 K 线）一路追到当前，补 K 线
async function backfillKlines(symbol, interval) {
  let cursor = Number(metaGet(`bf_${symbol}_${interval}`) || 0)
  if (!cursor) {
    const first = await getFirstKlineTime(symbol, 'futures')
    cursor = first || 0
  }
  if (!cursor) return
  let guard = 0
  while (cursor < Date.now() && guard++ < 5000) {
    const bars = await fetchKlinePage(symbol, interval, cursor)
    if (!bars.length) break
    insertKlines(symbol, interval, bars)
    cursor = bars[bars.length - 1].time + 1
    metaSet(`bf_${symbol}_${interval}`, cursor)
    if (bars.length < KLINE_LIMIT) break
  }
}

const mk = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : v)
const insFund = mkt.prepare(
  'INSERT OR REPLACE INTO funding (symbol, time, rate, mark_price) VALUES (?, ?, ?, ?)'
)
function insertFunding(symbol, rows) {
  if (!rows.length) return
  mkt.exec('BEGIN')
  try {
    for (const r of rows) insFund.run(symbol, r.time, r.rate, mk(r.mark))
    mkt.exec('COMMIT')
  } catch (e) {
    mkt.exec('ROLLBACK')
    throw e
  }
}

async function fetchFundingPage(symbol, startTime) {
  const rows = await getJson(`${FUT}/data/fundingRate?symbol=${symbol}&startTime=${startTime}&limit=${FUND_LIMIT}`)
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    time: r.fundingTime, rate: +r.fundingRate, mark: r.markPrice,
  }))
}

async function backfillFunding(symbol) {
  let cursor = Number(metaGet(`bfF_${symbol}`) || 0)
  if (!cursor) cursor = Date.now() - 30 * 24 * 3600 * 1000 // fundingRate 只能用 startTime，初始给近 30 天
  let guard = 0
  while (guard++ < 5000) {
    const rows = await fetchFundingPage(symbol, cursor)
    if (!rows.length) break
    insertFunding(symbol, rows)
    cursor = rows[rows.length - 1].time + 1
    metaSet(`bfF_${symbol}`, cursor)
    if (rows.length < FUND_LIMIT) break
  }
}

export const historyStatus = {
  running: false,
  phase: 'idle',
  symbols: 0,
  queueTotal: 0,
  queueDone: 0,
  current: '',
  startedAt: null,
  lastRun: null,
}

let backfillRunning = false
async function backfillAll() {
  if (backfillRunning) return
  backfillRunning = true
  historyStatus.running = true
  historyStatus.phase = 'klines'
  historyStatus.startedAt = Date.now()
  try {
    let symbols = []
    try { symbols = await getPerpetualSymbols() } catch { symbols = [] }
    historyStatus.symbols = symbols.length
    historyStatus.queueTotal = symbols.length * INTERVALS.length
    historyStatus.queueDone = 0
    for (const interval of INTERVALS) {
      for (const sym of symbols) {
        historyStatus.current = `${sym} ${interval}`
        try { await backfillKlines(sym, interval) } catch { /* 单个失败，续跑继续 */ }
        historyStatus.queueDone++
      }
    }
    historyStatus.phase = 'funding'
    for (const sym of symbols) {
      historyStatus.current = `funding ${sym}`
      try { await backfillFunding(sym) } catch { /* 单个失败，续跑继续 */ }
    }
    historyStatus.phase = 'done'
  } finally {
    backfillRunning = false
    historyStatus.running = false
    historyStatus.lastRun = Date.now()
  }
}

let collecting = false
async function withCollect(fn) {
  if (collecting) return
  collecting = true
  try { await fn() } finally { collecting = false }
}

async function incrementalKlines(symbol, interval) {
  const start = Number(metaGet(`bf_${symbol}_${interval}`) || 0)
  if (!start) return
  let cursor = start
  let guard = 0
  while (guard++ < 12) {
    const bars = await fetchKlinePage(symbol, interval, cursor)
    if (!bars.length) break
    insertKlines(symbol, interval, bars)
    cursor = bars[bars.length - 1].time + 1
    metaSet(`bf_${symbol}_${interval}`, cursor)
    if (bars.length < KLINE_LIMIT) break
  }
}

async function runIncrementalFast() {
  if (collecting) return
  await withCollect(async () => {
    let syms = []
    try { syms = await getPerpetualSymbols() } catch { return }
    for (const s of syms) {
      try { await incrementalKlines(s, '5m') } catch { /* 单币失败忽略 */ }
    }
  })
}

async function runIncrementalHourly() {
  await withCollect(async () => {
    let syms = []
    try { syms = await getPerpetualSymbols() } catch { return }
    for (const s of syms) {
      for (const iv of ['30m', '1h', '4h', '1d', '1w', '1M']) {
        try { await incrementalKlines(s, iv) } catch { /* 忽略 */ }
      }
      try { await backfillFunding(s) } catch { /* 忽略 */ }
    }
  })
}

export function startHistory() {
  backfillAll().catch(() => {})
  setInterval(() => runIncrementalFast().catch(() => {}), 15 * 60 * 1000).unref?.()
  setInterval(() => runIncrementalHourly().catch(() => {}), 60 * 60 * 1000).unref?.()
  setTimeout(() => runIncrementalFast().catch(() => {}), 5000)
}

export function getHistoryStatus() {
  const count = (t) => mkt.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const maxT = (t, col) => mkt.prepare(`SELECT MAX(${col}) m FROM ${t}`).get().m || null
  const perInterval = () =>
    mkt.prepare('SELECT interval, COUNT(*) c, MAX(time) m FROM klines GROUP BY interval').all()
  return {
    ...historyStatus,
    klines: { rows: count('klines'), lastTime: maxT('klines', 'time'), byInterval: perInterval() },
    funding: { rows: count('funding'), lastTime: maxT('funding', 'time') },
  }
}