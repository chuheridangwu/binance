import { api } from './http'

export function login(password) {
  return api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

export function authStatus() {
  return api('/api/auth/status')
}

export function logout() {
  return api('/api/logout', { method: 'POST' })
}

export function changePassword(old_password, new_password) {
  return api('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_password, new_password }),
  })
}

export function fetchListings() {
  return api('/api/listings')
}

export function fetchCoinInfo(symbol) {
  return api('/api/coininfo?symbol=' + encodeURIComponent(symbol))
}

export function fetchCoinInfoSearch(symbol) {
  return api('/api/coininfo/search?symbol=' + encodeURIComponent(symbol))
}

export function fetchCoinSupply(params) {
  const q = new URLSearchParams()
  if (params && params.maxSupply) q.set('maxSupply', String(params.maxSupply))
  if (params && params.tolerance) q.set('tolerance', String(params.tolerance))
  if (params && params.supplyMin) q.set('supplyMin', String(params.supplyMin))
  if (params && params.supplyMax) q.set('supplyMax', String(params.supplyMax))
  const qs = q.toString()
  return api('/api/coin-supply' + (qs ? '?' + qs : ''))
}

export function fetchListingPerformance(months) {
  return api('/api/listing-performance?months=' + (months || 6))
}

export function fetchMeme(params) {
  const q = new URLSearchParams()
  if (params && params.windowHours) q.set('windowHours', String(params.windowHours))
  if (params && params.threshold) q.set('threshold', String(params.threshold))
  const qs = q.toString()
  return api('/api/meme' + (qs ? '?' + qs : ''))
}

export function fetchSimilar(symbol, days) {
  const q = new URLSearchParams()
  if (symbol) q.set('symbol', symbol)
  if (days) q.set('days', String(days))
  return api('/api/similar?' + q.toString())
}

export function fetchPotential(params) {
  const q = new URLSearchParams()
  const defaults = { months: 12, maxRise: 100, minAmpl: 40, volDays: 7, volRatio: 2, fundingAbs: 0.02 }
  const p = { ...defaults, ...(params || {}) }
  q.set('months', String(p.months))
  q.set('maxRise', String(p.maxRise))
  q.set('minAmpl', String(p.minAmpl))
  q.set('volDays', String(p.volDays))
  q.set('volRatio', String(p.volRatio))
  q.set('fundingAbs', String(p.fundingAbs))
  if (p.use) {
    q.set('lowPrice', p.use.lowPrice ? '1' : '0')
    q.set('highVol', p.use.highVol ? '1' : '0')
    q.set('volume', p.use.volume ? '1' : '0')
    q.set('funding', p.use.funding ? '1' : '0')
  }
  return api('/api/potential?' + q.toString())
}

export function fetchStatus() {
  return api('/api/status')
}

export function fetchSettings() {
  return api('/api/settings')
}

export function saveSettings(payload) {
  return api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function testEmail() {
  return api('/api/test-email', { method: 'POST' })
}

export function triggerMonitor() {
  return api('/api/monitor/run', { method: 'POST' })
}

export function fetchSpread(symbols) {
  const q = symbols.join(',')
  return api(`/api/spread?symbols=${encodeURIComponent(q)}`)
}

export function startScreener(rules, mode, month, params) {
  return api('/api/screener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rules, mode, month: month || '', params: params || {} }),
  })
}

export function fetchTrackers() {
  return api('/api/trackers')
}

export function createTracker(payload) {
  return api('/api/trackers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function deleteTracker(id) {
  return api(`/api/trackers/${id}`, { method: 'DELETE' })
}

export function fetchMutes() {
  return api('/api/mute')
}

export function addMute(symbol) {
  return api('/api/mute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol }),
  })
}

export function removeMute(symbol) {
  return api(`/api/mute/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
}

export function screenerStatus() {
  return api('/api/screener/status')
}

export function fetchScreenerResults() {
  return api('/api/screener')
}

export function startScreenerStrategies(strategies, month, minScore, config) {
  return api('/api/screener/strategies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategies, month: month || '', minScore, config: config || {} }),
  })
}
