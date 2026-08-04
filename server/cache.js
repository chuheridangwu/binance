import { db } from './db.js'

const TTL_KLINE = 60 * 60 * 1000
const TTL_OI = 10 * 60 * 1000
const RETENTION_MS = 30 * 24 * 3600 * 1000

export function readKlines(symbol, interval) {
  const m = db
    .prepare('SELECT MAX(fetched_at) AS t FROM kline_cache WHERE symbol = ? AND interval = ?')
    .get(symbol, interval)
  if (!m || !m.t || Date.now() - m.t > TTL_KLINE) return null
  return db
    .prepare('SELECT time, open, high, low, close, volume FROM kline_cache WHERE symbol = ? AND interval = ? ORDER BY time ASC')
    .all(symbol, interval)
    .map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
}

export function writeKlines(symbol, interval, rows) {
  if (!rows.length) return
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO kline_cache (symbol, interval, time, open, high, low, close, volume, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, interval, time) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume, fetched_at = excluded.fetched_at`
  )
  db.exec('BEGIN')
  try {
    for (const r of rows) stmt.run(symbol, interval, r.time, r.open, r.high, r.low, r.close, r.volume, now)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function readOi(symbol) {
  const m = db
    .prepare('SELECT MAX(fetched_at) AS t FROM oi_cache WHERE symbol = ?')
    .get(symbol)
  if (!m || !m.t || Date.now() - m.t > TTL_OI) return null
  return db
    .prepare('SELECT time, oi, oi_value FROM oi_cache WHERE symbol = ? ORDER BY time ASC')
    .all(symbol)
    .map((r) => ({ time: r.time, oi: r.oi, oiValue: r.oi_value }))
}

export function writeOi(symbol, rows) {
  if (!rows.length) return
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO oi_cache (symbol, time, oi, oi_value, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(symbol, time) DO UPDATE SET
       oi = excluded.oi, oi_value = excluded.oi_value, fetched_at = excluded.fetched_at`
  )
  db.exec('BEGIN')
  try {
    for (const r of rows) stmt.run(symbol, r.time, r.oi, r.oiValue, now)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function cleanup() {
  try {
    const cutoff = Date.now() - RETENTION_MS
    db.prepare('DELETE FROM kline_cache WHERE fetched_at < ?').run(cutoff)
    db.prepare('DELETE FROM oi_cache WHERE fetched_at < ?').run(cutoff)
  } catch {
    /* 忽略清理错误 */
  }
}

cleanup()
setInterval(cleanup, 6 * 3600 * 1000).unref?.()
