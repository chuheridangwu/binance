const API = 'https://fapi.binance.com/fapi/v1'

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 用合约行情数据反推上新日期：每对上币的第一根日K开盘时间即首次交易日期。
 * 数据源为 U 本位合约（fapi.binance.com），全程支持 CORS，无需代理。
 */
export async function fetchListingsByMarketData(onProgress) {
  const info = await getJson(`${API}/exchangeInfo`)
  const pairs = info.symbols
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
    .map((s) => s.symbol)

  const twoYearsAgo = Date.now() - 730 * 24 * 3600 * 1000
  const found = []
  let idx = 0
  const CONC = 16

  async function worker() {
    while (idx < pairs.length) {
      const sym = pairs[idx++]
      onProgress?.(Math.min(idx, pairs.length), pairs.length)
      try {
        const k = await getJson(`${API}/klines?symbol=${sym}&interval=1d&startTime=0&limit=1`)
        if (k.length && k[0][0] >= twoYearsAgo) {
          found.push({ symbol: sym, date: new Date(k[0][0]) })
        }
      } catch (e) {
        if (String(e.message).includes('429') || String(e.message).includes('418')) {
          await sleep(3000)
          idx-- // 重试当前交易对
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONC }, worker))
  return found.sort((a, b) => a.date - b.date)
}
