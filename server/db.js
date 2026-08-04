import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })

export const db = new DatabaseSync(path.join(dataDir, 'app.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  code     TEXT PRIMARY KEY,
  symbol   TEXT NOT NULL,
  title    TEXT,
  date     INTEGER NOT NULL,
  market   TEXT DEFAULT '',
  notified INTEGER DEFAULT 0,
  source   TEXT DEFAULT '',
  retry_count       INTEGER DEFAULT 0,
  last_notify_attempt INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS kline_cache (
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  time       INTEGER NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  volume     REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval, time)
);
CREATE TABLE IF NOT EXISTS oi_cache (
  symbol     TEXT NOT NULL,
  time       INTEGER NOT NULL,
  oi         REAL,
  oi_value   REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, time)
);
CREATE TABLE IF NOT EXISTS symbols (
  symbol     TEXT NOT NULL,
  market     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  type       TEXT DEFAULT '',
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, market)
);
CREATE INDEX IF NOT EXISTS idx_listings_date ON listings(date);
CREATE INDEX IF NOT EXISTS idx_kline_cache_lookup ON kline_cache(symbol, interval, fetched_at);
CREATE INDEX IF NOT EXISTS idx_oi_cache_lookup ON oi_cache(symbol, fetched_at);
CREATE INDEX IF NOT EXISTS idx_symbols_market_active ON symbols(market, active);
`)

const listingCols = new Set(db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name))
if (!listingCols.has('retry_count')) {
  db.exec('ALTER TABLE listings ADD COLUMN retry_count INTEGER DEFAULT 0')
}
if (!listingCols.has('last_notify_attempt')) {
  db.exec('ALTER TABLE listings ADD COLUMN last_notify_attempt INTEGER')
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const out = {}
  for (const r of rows) out[r.key] = r.value
  return out
}
