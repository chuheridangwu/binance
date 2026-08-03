async function api(url, options) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `接口错误: ${res.status}`)
  return data
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
