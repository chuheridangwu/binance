import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { getPerpetualSymbols, getFuturesKlines, getOpenInterestHistory, getFundingRates } from './binance.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_FILE = path.join(__dirname, '..', 'data', 'scan-results.json')

export const RULES = [
  { id: 'r1', name: 'RSI(6) 近N日 ≥ 80', desc: '近 N 根日K中任意一根 RSI(6) ≥ 80', param: { name: 'N', min: 3, max: 10, def: 7 } },
  { id: 'r2', name: 'N日内创新高 + RSI 顶背离', desc: '近 N 天价格创 60 天新高，且 RSI(6) 低于前高时的取值', param: { name: 'N', min: 3, max: 10, def: 3 } },
  { id: 'r3', name: '价格 ≥ 布林带上轨', desc: '收盘价站上布林带 (20, 2) 上轨' },
  { id: 'r4', name: '当日 OI > 前N日总和', desc: '当日未平仓合约量大于之前 N 天 OI 之和', param: { name: 'N', min: 3, max: 7, def: 5 } },
  { id: 'r5', name: '单日量 > 前N日总和', desc: '最近一根日K成交量大于之前 N 天成交量之和', param: { name: 'N', min: 3, max: 7, def: 3 } },
]

export const RULE_DEFAULTS = {
  r1: RULES.find((r) => r.id === 'r1').param.def,
  r2: RULES.find((r) => r.id === 'r2').param.def,
  r4: RULES.find((r) => r.id === 'r4').param.def,
  r5: RULES.find((r) => r.id === 'r5').param.def,
}

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

// 不追踪标记：一周内有效
export const MUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function getMuteMap() {
  const cutoff = Date.now() - MUTE_TTL_MS
  const rows = db.prepare('SELECT symbol, created_at FROM muted_symbols WHERE created_at >= ?').all(cutoff)
  const m = new Map()
  for (const r of rows) m.set(r.symbol, r.created_at)
  return m
}

export function listMutes() {
  return [...getMuteMap().entries()].map(([symbol, created_at]) => ({ symbol, created_at }))
}

export function addMute(symbol) {
  const s = String(symbol || '').trim().toUpperCase()
  if (!s) throw new Error('symbol 必填')
  db.prepare(
    'INSERT INTO muted_symbols (symbol, created_at) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET created_at = excluded.created_at'
  ).run(s, Date.now())
  return { symbol: s }
}

export function removeMute(symbol) {
  db.prepare('DELETE FROM muted_symbols WHERE symbol = ?').run(String(symbol || '').trim().toUpperCase())
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
  return {
    mid,
    upper: closes.map((_, i) => (Number.isFinite(mid[i]) ? mid[i] + mult * sd[i] : NaN)),
    lower: closes.map((_, i) => (Number.isFinite(mid[i]) ? mid[i] - mult * sd[i] : NaN)),
  }
}

export function checkR1(rsi6, days = 7) {
  const n = rsi6.length
  const start = Math.max(0, n - days)
  let weekMax = -1
  for (let i = start; i < n; i++) {
    if (Number.isFinite(rsi6[i]) && rsi6[i] > weekMax) weekMax = rsi6[i]
  }
  const cur = rsi6[n - 1]
  return {
    hit: weekMax >= 80,
    weekMaxRsi: weekMax >= 0 ? weekMax : cur,
    curRsi: Number.isFinite(cur) ? cur : null,
    days,
  }
}

export function checkR2(klines, rsi6, days = 3) {
  const n = klines.length
  if (n < 63) return { hit: false }
  let curIdx = n - days
  for (let i = n - days; i < n; i++) if (klines[i].high > klines[curIdx].high) curIdx = i
  const curHigh = klines[curIdx].high
  const from = Math.max(0, n - days - 60)
  let prevIdx = from
  for (let i = from; i < n - days; i++) if (klines[i].high > klines[prevIdx].high) prevIdx = i
  const prevHigh = klines[prevIdx].high
  const curRsi = rsi6[curIdx]
  const prevRsi = rsi6[prevIdx]
  if (!(curHigh > prevHigh) || !Number.isFinite(curRsi) || !Number.isFinite(prevRsi)) {
    return { hit: false, curHigh, prevHigh, curRsi, prevRsi, days }
  }
  return { hit: curRsi < prevRsi, curHigh, prevHigh, curRsi, prevRsi, days }
}

export function checkR3(closes) {
  const { upper } = bollinger(closes)
  const last = closes.length - 1
  const u = upper[last]
  const price = closes[last]
  return { hit: Number.isFinite(u) && price >= u, price, upper: u }
}

export function checkR4(oiList, days = 5) {
  if (!oiList || oiList.length < days + 1) return { hit: false, oiList: oiList || [], today: null, prevSum: null }
  const today = oiList[oiList.length - 1]
  const prevSum = oiList.slice(-days - 1, -1).reduce((a, b) => a + b, 0)
  return { hit: prevSum > 0 && today > prevSum, oiList: oiList.slice(-(days + 1)), today, prevSum, days }
}

export function checkR5(klines, days = 3) {
  const n = klines.length
  if (n < days + 1) return { hit: false }
  const last = klines[n - 1].volume
  const prevSum = klines.slice(n - days - 1, n - 1).reduce((a, k) => a + k.volume, 0)
  return { hit: prevSum > 0 && last > prevSum, volume: last, prevSum, ratio: prevSum > 0 ? last / prevSum : 0, days }
}

/* ================= 四类策略 ================= */

export const STRATEGIES = [
  {
    id: 'up',
    name: '上涨趋势',
    desc: '多头排列 + 趋势强度 + 量能 + 布林上轨',
    score: ['MA20>MA50>MA200(+25)', '价>MA20(+15)', 'ADX>25(+15)', 'RSI 50-70(+15)', '量比>1(+10)', '贴近/破上轨(+20)'],
  },
  {
    id: 'down',
    name: '下跌趋势',
    desc: '空头排列 + 趋势强度 + 量能 + 布林下轨',
    score: ['MA20<MA50<MA200(+25)', '价<MA20(+15)', 'ADX>25(+15)', 'RSI<40(+15)', '量比>1(+10)', '贴近/破下轨(+20)'],
  },
  {
    id: 'top',
    name: '山顶转折',
    desc: '超买 + 资金费率 + 布林上轨',
    score: ['RSI(6)≥80(+25)', '乖离>10%(+20)', '资金费率>0.05%(+15)', '贴近/破上轨(+40)'],
  },
  {
    id: 'bottom',
    name: '山底待涨',
    desc: '超卖 + 资金费率 + 布林下轨',
    score: ['RSI(6)≤20(+25)', '乖离<-10%(+20)', '资金费率<-0.05%(+15)', '贴近/破下轨(+40)'],
  },
]

// ADX(14)：Wilder 平滑趋势强度
export function adx(klines, period = 14) {
  const n = klines.length
  if (n < period * 2) return null
  let trSum = 0, pdmSum = 0, ndmSum = 0
  const tr = [], pdm = [], ndm = []
  for (let i = 1; i < n; i++) {
    const hl = klines[i].high - klines[i].low
    const hpc = Math.abs(klines[i].high - klines[i - 1].close)
    const lpc = Math.abs(klines[i].low - klines[i - 1].close)
    tr.push(Math.max(hl, hpc, lpc))
    const up = klines[i].high - klines[i - 1].high
    const dn = klines[i - 1].low - klines[i].low
    pdm.push(up > dn && up > 0 ? up : 0)
    ndm.push(dn > up && dn > 0 ? dn : 0)
  }
  let prevTr = 0, prevPdm = 0, prevNdm = 0
  for (let i = 0; i < period; i++) {
    trSum += tr[i]; pdmSum += pdm[i]; ndmSum += ndm[i]
  }
  prevTr = trSum / period; prevPdm = pdmSum / period; prevNdm = ndmSum / period
  let dxSum = 0
  for (let i = period; i < tr.length; i++) {
    prevTr = (prevTr * (period - 1) + tr[i]) / period
    prevPdm = (prevPdm * (period - 1) + pdm[i]) / period
    prevNdm = (prevNdm * (period - 1) + ndm[i]) / period
    const pDI = (prevPdm / prevTr) * 100
    const nDI = (prevNdm / prevTr) * 100
    const dx = pDI + nDI === 0 ? 0 : (Math.abs(pDI - nDI) / (pDI + nDI)) * 100
    if (i - period < period) dxSum += dx
  }
  return dxSum / period
}

function ma(closes, period) {
  if (closes.length < period) return null
  let s = 0
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i]
  return s / period
}

export function buildKlineFeatures(klines) {
  const closes = klines.map((k) => k.close)
  const n = closes.length
  const last = klines[n - 1]
  const ma20 = ma(closes, 20)
  const ma50 = ma(closes, 50)
  const ma200 = ma(closes, 200)
  const rsi14 = rsiSeries(closes, 14)
  const rsi6 = rsiSeries(closes, 6)
  const avgVol = closes.slice(-20).reduce((a, _, i) => a + klines[n - 20 + i].volume, 0) / 20
  const dev20 = ma20 ? ((last.close - ma20) / ma20) * 100 : null
  const ret20 = n > 21 ? ((last.close - closes[n - 21]) / closes[n - 21]) * 100 : null
  const bb = bollinger(closes)
  const lastBb = n - 1
  const u = bb.upper[lastBb]
  const l = bb.lower[lastBb]
  let nearUpper = false
  let nearLower = false
  if (Number.isFinite(u) && Number.isFinite(l) && u > l) {
    const pos = (last.close - l) / (u - l)
    nearUpper = pos >= 0.9
    nearLower = pos <= 0.1
  }
  let brokeUpper = false
  let brokeLower = false
  for (let i = Math.max(0, n - 7); i < n; i++) {
    if (Number.isFinite(bb.upper[i]) && closes[i] > bb.upper[i]) brokeUpper = true
    if (Number.isFinite(bb.lower[i]) && closes[i] < bb.lower[i]) brokeLower = true
  }
  return {
    price: last.close,
    ma20, ma50, ma200,
    rsi14: rsi14[n - 1],
    rsi6: rsi6[n - 1],
    adx: adx(klines),
    dev20,
    ret20,
    volRatio: avgVol ? last.volume / avgVol : null,
    hi20: Math.max(...closes.slice(-20)),
    lo20: Math.min(...closes.slice(-20)),
    bollNearUpper: nearUpper,
    bollNearLower: nearLower,
    bollBrokeUpper: brokeUpper,
    bollBrokeLower: brokeLower,
  }
}

// 顶部信号：RSI 超买 + 乖离 + 资金费率 + 布林上轨
export function scoreTop(f) {
  let s = 0
  const sig = []
  if (f.rsi6 >= 80) { s += 25; sig.push('RSI6≥80') }
  else if (f.rsi6 >= 70) { s += 15; sig.push('RSI6≥70') }
  if (f.dev20 !== null && f.dev20 >= 10) { s += 20; sig.push(`乖离+${f.dev20.toFixed(1)}%`) }
  else if (f.dev20 !== null && f.dev20 >= 6) { s += 12; sig.push(`乖离+${f.dev20.toFixed(1)}%`) }
  if (f.fundingRate !== null && f.fundingRate >= 0.05) { s += 15; sig.push('费率拥挤') }
  else if (f.fundingRate !== null && f.fundingRate >= 0.01) { s += 8; sig.push('费率偏高') }
  if (f.bollNearUpper || f.bollBrokeUpper) { s += 40; sig.push('贴/破上轨') }
  return { score: s, sig }
}

export function scoreBottom(f) {
  let s = 0
  const sig = []
  if (f.rsi6 <= 20) { s += 25; sig.push('RSI6≤20') }
  else if (f.rsi6 <= 30) { s += 15; sig.push('RSI6≤30') }
  if (f.dev20 !== null && f.dev20 <= -10) { s += 20; sig.push(`乖离${f.dev20.toFixed(1)}%`) }
  else if (f.dev20 !== null && f.dev20 <= -6) { s += 12; sig.push(`乖离${f.dev20.toFixed(1)}%`) }
  if (f.fundingRate !== null && f.fundingRate <= -0.05) { s += 15; sig.push('费率极负') }
  else if (f.fundingRate !== null && f.fundingRate <= -0.01) { s += 8; sig.push('费率为负') }
  if (f.bollNearLower || f.bollBrokeLower) { s += 40; sig.push('贴/破下轨') }
  return { score: s, sig }
}

export function scoreUp(f) {
  let s = 0
  const sig = []
  if (f.ma20 > f.ma50 && f.ma50 > f.ma200) { s += 25; sig.push('多头排列') }
  else if (f.ma20 > f.ma50) { s += 12; sig.push('MA20>MA50') }
  if (f.price > f.ma20) { s += 15; sig.push('价>MA20') }
  if (f.adx !== null && f.adx > 25) { s += 15; sig.push(`ADX ${f.adx.toFixed(1)}`) }
  if (f.rsi14 !== null && f.rsi14 >= 50 && f.rsi14 <= 70) { s += 15; sig.push(`RSI ${f.rsi14.toFixed(1)}`) }
  else if (f.rsi14 !== null && f.rsi14 > 70) { s += 6; sig.push('RSI偏热') }
  if (f.volRatio !== null && f.volRatio > 1) { s += 10; sig.push(`量比${f.volRatio.toFixed(2)}`) }
  if (f.bollNearUpper || f.bollBrokeUpper) { s += 20; sig.push('贴/破上轨') }
  return { score: s, sig }
}

export function scoreDown(f) {
  let s = 0
  const sig = []
  if (f.ma20 < f.ma50 && f.ma50 < f.ma200) { s += 25; sig.push('空头排列') }
  else if (f.ma20 < f.ma50) { s += 12; sig.push('MA20<MA50') }
  if (f.price < f.ma20) { s += 15; sig.push('价<MA20') }
  if (f.adx !== null && f.adx > 25) { s += 15; sig.push(`ADX ${f.adx.toFixed(1)}`) }
  if (f.rsi14 !== null && f.rsi14 < 40) { s += 15; sig.push(`RSI ${f.rsi14.toFixed(1)}`) }
  if (f.volRatio !== null && f.volRatio > 1) { s += 10; sig.push(`量比${f.volRatio.toFixed(2)}`) }
  if (f.bollNearLower || f.bollBrokeLower) { s += 20; sig.push('贴/破下轨') }
  return { score: s, sig }
}

export function bollLabel(f, dir) {
  if (dir === 'up') {
    if (f.bollBrokeUpper) return '破上轨(近7日)'
    if (f.bollNearUpper) return '贴近上轨'
    return '—'
  }
  if (f.bollBrokeLower) return '破下轨(近7日)'
  if (f.bollNearLower) return '贴近下轨'
  return '—'
}

export async function scanStrategies(strategies, opts = {}) {
  if (state.running) throw new Error('已有扫描进行中，请稍候')
  const ids = Array.isArray(strategies) ? strategies : [strategies]
  const want = new Set(ids.filter((id) => STRATEGIES.some((s) => s.id === id)))
  if (!want.size) throw new Error('至少选择一个策略')

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
    const minScore = opts.minScore ?? 60
    const results = []

    await mapLimit(candidates, 4, async (sym) => {
      try {
        const kl = await getFuturesKlines(sym, '1d', 120)
        if (kl.length < 40) return
        const f = buildKlineFeatures(kl)
        const listed = listingDate(sym)
        const row = {
          symbol: sym,
          listed: listed ? monthKey(listed) : '',
          price: f.price,
          rsi6: Number.isFinite(f.rsi6) ? f.rsi6 : null,
          metrics: {},
          signals: [],
          strategy: [],
        }
        let any = false

        for (const sid of want) {
          let res = null
          if (sid === 'up') {
            res = scoreUp(f)
            row.metrics = { ...row.metrics, ma20: f.ma20, ma50: f.ma50, ma200: f.ma200, adx: f.adx, rsi14: f.rsi14, volRatio: f.volRatio, dev20: f.dev20, boll: bollLabel(f, 'up') }
          } else if (sid === 'down') {
            res = scoreDown(f)
            row.metrics = { ...row.metrics, ma20: f.ma20, ma50: f.ma50, ma200: f.ma200, adx: f.adx, rsi14: f.rsi14, volRatio: f.volRatio, dev20: f.dev20, boll: bollLabel(f, 'down') }
          } else if (sid === 'top' || sid === 'bottom') {
            const overbought = (f.rsi6 !== null && f.rsi6 >= 70) || (f.dev20 !== null && f.dev20 >= 6)
            const oversold = (f.rsi6 !== null && f.rsi6 <= 30) || (f.dev20 !== null && f.dev20 <= -6)
            const isCandidate = sid === 'top' ? overbought : oversold
            if (!isCandidate) continue
            let fr = null
            try {
              const funding = await getFundingRates()
              fr = funding.get(sym) ?? null
            } catch { /* 费率不可用则忽略 */ }
            const full = { ...f, fundingRate: fr }
            res = sid === 'top' ? scoreTop(full) : scoreBottom(full)
            row.metrics = { ...row.metrics, rsi6: f.rsi6, dev20: f.dev20, fundingRate: fr, boll: bollLabel(f, sid === 'top' ? 'up' : 'down') }
          }
          if (res && res.score >= minScore) {
            row.strategy.push(sid)
            row.score = Math.max(row.score || 0, res.score)
            row.signals.push(...res.sig)
            any = true
          }
        }

        if (any) {
          results.push(row)
          state.found = results.length
        }
      } catch {
        state.errors++
      }
      state.done++
    })

    results.sort((a, b) => (b.score || 0) - (a.score || 0))
    const muted = getMuteMap()
    results.forEach((r) => {
      r.muted = muted.has(r.symbol)
      r.mutedAt = muted.get(r.symbol) ?? null
    })
    results.sort((a, b) => {
      if (!!a.muted !== !!b.muted) return a.muted ? 1 : -1
      return (b.score || 0) - (a.score || 0)
    })
    lastResults = {
      mode: 'strategies',
      strategies: [...want],
      minScore,
      month: (opts.month || '').trim(),
      results,
      generatedAt: Date.now(),
    }
    persistResults()
    return lastResults
  } finally {
    state.running = false
    state.lastScanAt = Date.now()
  }
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

  const params = {}
  for (const rid of ['r1', 'r2', 'r4', 'r5']) {
    const meta = RULES.find((r) => r.id === rid)?.param
    const raw = Number(opts.params?.[rid])
    params[rid] = Number.isFinite(raw) ? Math.min(meta.max, Math.max(meta.min, Math.round(raw))) : meta.def
  }

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
          const r = checkR1(rsi6, params.r1)
          if (r.hit) {
            hit.push('r1')
            detail.r1 = r
          }
        }
        if (rules.r2) {
          const r = checkR2(kl, rsi6, params.r2)
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
          const oi = await getOpenInterestHistory(sym, '1d', params.r4 + 1)
          const r = checkR4(oi.map((o) => o.oi), params.r4)
          detail.r4 = r
          if (r.hit) hit.push('r4')
        }
        if (rules.r5) {
          const r = checkR5(kl, params.r5)
          if (r.hit) {
            hit.push('r5')
            detail.r5 = r
          }
        }

        if (hit.length && (mode === 'any' || hit.length === enabled.length)) {
          const curRsi6 = rsi6[rsi6.length - 1]
          results.push({
            symbol: sym,
            listed: listed ? monthKey(listed) : '',
            price: closes[closes.length - 1],
            matched: hit,
            detail,
            rsi6: Number.isFinite(curRsi6) ? curRsi6 : null,
          })
          state.found = results.length
        }
      } catch {
        state.errors++
      }
      state.done++
    })

    const muted = getMuteMap()
    results.forEach((r) => {
      r.muted = muted.has(r.symbol)
      r.mutedAt = muted.get(r.symbol) ?? null
    })
    results.sort((a, b) => {
      if (!!a.muted !== !!b.muted) return a.muted ? 1 : -1
      if (b.matched.length !== a.matched.length) return b.matched.length - a.matched.length
      return (b.rsi6 ?? -1) - (a.rsi6 ?? -1)
    })
    lastResults = { mode, rules: enabled, params, month: (opts.month || '').trim(), results, generatedAt: Date.now() }
    persistResults()
    return lastResults
  } finally {
    state.running = false
    state.lastScanAt = Date.now()
  }
}
