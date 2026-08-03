import { reactive } from 'vue'

const savedToken = localStorage.getItem('binance_token') || ''

export const store = reactive({
  activeTab: 'chart',
  chartSymbol: 'BTCUSDT',
  token: savedToken,
  authed: false,
})

export function setToken(token) {
  store.token = token
  if (token) localStorage.setItem('binance_token', token)
  else localStorage.removeItem('binance_token')
}

export function setAuthed(v) {
  store.authed = v
  if (!v) setToken('')
}
