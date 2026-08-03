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
