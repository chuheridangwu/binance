const SPOT = 'https://api.binance.com/api/v3'
const FUTURES = 'https://fapi.binance.com/fapi/v1'
import { getJson } from './binance.js'

export const DEFAULT_WATCH = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT', 'DOTUSDT', 'TRXUSDT',
]

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

/**
 * 拉取永续合约当前资金费率与永续/现货价差。
 * 返回按年化资金费率绝对值降序的列表。
 */
export async function getSpreadData(symbols) {
  const syms = [...new Set(symbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 40)
  if (!syms.length) return { rows: [], time: Date.now() }

  let spotPrices = new Map()
  try {
    const arr = await getJson(`${SPOT}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`)
    if (Array.isArray(arr)) spotPrices = new Map(arr.map((p) => [p.symbol, +p.price]))
  } catch {
    /* 部分符号无现货时忽略 */
  }

  const prem = await mapLimit(syms, 8, async (s) => {
    try {
      return await getJson(`${FUTURES}/premiumIndex?symbol=${s}`)
    } catch {
      return null
    }
  })

  const rows = []
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i]
    const p = prem[i]
    if (!p) continue
    const spot = spotPrices.get(s)
    const futures = +p.markPrice || +p.indexPrice || 0
    const premiumPct = spot ? ((futures - spot) / spot) * 100 : null
    const fundingRate = +p.lastFundingRate || 0
    rows.push({
      symbol: s,
      spotPrice: spot ?? null,
      futuresPrice: futures || null,
      premiumPct: premiumPct === null ? null : Number(premiumPct.toFixed(4)),
      fundingRate: Number((fundingRate * 100).toFixed(4)),
      annualized: Number((fundingRate * 3 * 365 * 100).toFixed(2)),
      nextFundingTime: p.nextFundingTime,
    })
  }
  rows.sort((a, b) => Math.abs(b.annualized) - Math.abs(a.annualized))
  return { rows, time: Date.now() }
}
