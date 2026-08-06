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
