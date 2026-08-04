import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { getPerpetualSymbols, getFuturesKlines, getOpenInterestHistory } from './binance.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_FILE = path.join(__dirname, '..', 'data', 'scan-results.json')

export const RULES = [
  { id: 'r1', name: 'RSI(6) 一周内 ≥ 80', desc: '近 7 根日K中任意一根 RSI(6) ≥ 80' },
  { id: 'r2', name: '3日内创新高 + RSI 顶背离', desc: '近 3 天价格创 60 天新高，且 RSI(6) 低于前高时的取值' },
  { id: 'r3', name: '价格 ≥ 布林带上轨', desc: '收盘价站上布林带 (20, 2) 上轨' },
  { id: 'r4', name: 'OI 持续增加', desc: '永续未平仓合约量近 5 天逐日上升' },
  { id: 'r5', name: '单日量 > 近7日总和', desc: '最近一根日K成交量大于之前 7 天成交量之和' },
]

const state = { running: false, total: 0, done: 0, found: 0, errors: 0, startAt: 0, lastScanAt: 0 }
let lastResults = null

function loadResults() {
  try {
    if (!fs.existsSync(RESULTS_FILE)) return
    const r = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))
    if (r && Array.isArray(r.results)) lastResults = r
  } catch {
    /* 忽略损坏文件 */
  }
}

function persistResults() {
  try {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true })
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(lastResults))
  } catch (e) {
    console.error('[screener] 保存扫描结果失败:', e.message)
  }
}

loadResults()

export function getScanState() {
  return { ...state, elapsed: state.running ? Date.now() - state.startAt : 0 }
}

export function getLastResults() {
  return lastResults
}

export function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    }
  }
  return out
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function stdDevSeries(values, period) {
  const out = new Array(values.length).fill(NaN)
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    const mean = sum / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2
    out[i] = Math.sqrt(sq / period)
  }
  return out
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = smaSeries(closes, period)
  const sd = stdDevSeries(closes, period)
  return { mid, upper: closes.map((_, i) => (Number.isFinite(mid[i]) ? mid[i] + mult * sd[i] : NaN)) }
}

export function checkR1(rsi6) {
  const n = rsi6.length
  const start = Math.max(0, n - 7)
  let weekMax = -1
  for (let i = start; i < n; i++) {
    if (Number.isFinite(rsi6[i]) && rsi6[i] > weekMax) weekMax = rsi6[i]
  }
  const cur = rsi6[n - 1]
  return {
    hit: weekMax >= 80,
    weekMaxRsi: weekMax >= 0 ? weekMax : cur,
    curRsi: Number.isFinite(cur) ? cur : null,
  }
}

export function checkR2(klines, rsi6) {
  const n = klines.length
  if (n < 63) return { hit: false }
  let curIdx = n - 3
  for (let i = n - 3; i < n; i++) if (klines[i].high > klines[curIdx].high) curIdx = i
  const curHigh = klines[curIdx].high
  const from = Math.max(0, n - 3 - 60)
  let prevIdx = from
  for (let i = from; i < n - 3; i++) if (klines[i].high > klines[prevIdx].high) prevIdx = i
  const prevHigh = klines[prevIdx].high
  const curRsi = rsi6[curIdx]
  const prevRsi = rsi6[prevIdx]
  if (!(curHigh > prevHigh) || !Number.isFinite(curRsi) || !Number.isFinite(prevRsi)) {
    return { hit: false, curHigh, prevHigh, curRsi, prevRsi }
  }
  return { hit: curRsi < prevRsi, curHigh, prevHigh, curRsi, prevRsi }
}

export function checkR3(closes) {
  const { upper } = bollinger(closes)
  const last = closes.length - 1
  const u = upper[last]
  const price = closes[last]
  return { hit: Number.isFinite(u) && price >= u, price, upper: u }
}

export function checkR4(oiList) {
  if (!oiList || oiList.length < 5) return { hit: false, oiList: oiList || [], upCount: 0, netUp: false }
  const last5 = oiList.slice(-5)
  const ups = []
  for (let i = 1; i < last5.length; i++) ups.push(last5[i] > last5[i - 1])
  const upCount = ups.filter(Boolean).length
  const netUp = last5[last5.length - 1] > last5[0]
  return { hit: netUp && upCount >= 3, oiList: last5, upCount, netUp }
}

export function checkR5(klines) {
  const n = klines.length
  if (n < 8) return { hit: false }
  const last = klines[n - 1].volume
  const prevSum = klines.slice(n - 8, n - 1).reduce((a, k) => a + k.volume, 0)
  return { hit: prevSum > 0 && last > prevSum, volume: last, prevSum, ratio: prevSum > 0 ? last / prevSum : 0 }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker))
  return out
}

function monthKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function buildListingDates() {
  const futures = {}
  const announce = {}
  for (const r of db.prepare('SELECT symbol, date, market FROM listings').all()) {
    const target = r.market === 'futures' ? futures : announce
    if (!(r.symbol in target) || r.date < target[r.symbol]) target[r.symbol] = r.date
  }
  return function listingDate(sym) {
    if (sym in futures) return futures[sym]
    return sym in announce ? announce[sym] : null
  }
}

export async function scan(rules, mode = 'any', opts = {}) {
  if (state.running) throw new Error('已有扫描进行中，请稍候')
  const enabled = Object.entries(rules)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (!enabled.length) throw new Error('至少勾选一个规则')

  state.running = true
  state.total = 0
  state.done = 0
  state.found = 0
  state.errors = 0
  state.startAt = Date.now()
  try {
    const symbols = await getPerpetualSymbols()
    const listingDate = buildListingDates()
    const month = (opts.month || '').trim()
    let candidates = symbols
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM')
      candidates = symbols.filter((s) => {
        const d = listingDate(s)
        return d !== null && d !== undefined && monthKey(d) === month
      })
    }
    state.total = candidates.length
    const results = []

    await mapLimit(candidates, 4, async (sym) => {
      try {
        const kl = await getFuturesKlines(sym, '1d', 100)
        if (kl.length < 40) return
        const closes = kl.map((k) => k.close)
        const rsi6 = rsiSeries(closes, 6)
        const listed = listingDate(sym)
        const detail = {}
        const hit = []

        if (rules.r1) {
          const r = checkR1(rsi6)
          if (r.hit) {
            hit.push('r1')
            detail.r1 = r
          }
        }
        if (rules.r2) {
          const r = checkR2(kl, rsi6)
          if (r.hit) {
            hit.push('r2')
            detail.r2 = r
          }
        }
        if (rules.r3) {
          const r = checkR3(closes)
          if (r.hit) {
            hit.push('r3')
            detail.r3 = r
          }
        }
        if (rules.r4) {
          const oi = await getOpenInterestHistory(sym, '1d', 5)
          const r = checkR4(oi.map((o) => o.oi))
          detail.r4 = r
          if (r.hit) hit.push('r4')
        }
        if (rules.r5) {
          const r = checkR5(kl)
          if (r.hit) {
            hit.push('r5')
            detail.r5 = r
          }
        }

        if (hit.length && (mode === 'any' || hit.length === enabled.length)) {
          results.push({ symbol: sym, listed: listed ? monthKey(listed) : '', price: closes[closes.length - 1], matched: hit, detail })
          state.found = results.length
        }
      } catch {
        state.errors++
      }
      state.done++
    })

    results.sort((a, b) => b.matched.length - a.matched.length)
    lastResults = { mode, rules: enabled, month: (opts.month || '').trim(), results, generatedAt: Date.now() }
    persistResults()
    return lastResults
  } finally {
    state.running = false
    state.lastScanAt = Date.now()
  }
}
