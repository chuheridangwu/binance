import { store, setAuthed } from '../store'

export async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (store.token) headers.Authorization = `Bearer ${store.token}`
  const res = await fetch(url, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    setAuthed(false)
    throw new Error(data.error || '未登录')
  }
  if (!res.ok) throw new Error(data.error || `接口错误: ${res.status}`)
  return data
}
