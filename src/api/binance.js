import { api } from './http'

export async function getKlines(symbol, interval, limit = 500) {
  const data = await api(`/api/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
  return data.klines
}

export async function getKlinesBefore(symbol, interval, openTimeSec, limit = 500) {
  const data = await api(`/api/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&before=${openTimeSec}`)
  return data.klines
}

export async function searchSymbols(keyword) {
  const data = await api(`/api/search?q=${encodeURIComponent(keyword)}`)
  return data.symbols || []
}
