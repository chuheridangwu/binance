import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, getSettings, getSetting, setSetting } from './db.js'
import * as binance from './binance.js'
import * as monitor from './monitor.js'
import { sendMail } from './mailer.js'
import * as auth from './auth.js'
import { getSpreadData, DEFAULT_WATCH } from './spread.js'
import * as screener from './screener.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

auth.initAdminPass()

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }))

app.post('/api/login', (req, res) => {
  const token = auth.login(String(req.body.password || ''))
  if (!token) return res.status(401).json({ error: '密码错误' })
  res.json({ token })
})

app.post('/api/logout', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  auth.logout(token)
  res.json({ ok: true })
})

app.get('/api/auth/status', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  res.json({ authed: auth.checkToken(token) })
})

app.post('/api/change-password', (req, res) => {
  const r = auth.changePassword(String(req.body.old_password || ''), String(req.body.new_password || ''))
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (!auth.checkToken(token)) return res.status(401).json({ error: '未登录或登录已过期' })
  next()
})

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol, interval, limit, before } = req.query
    if (!symbol || !interval) return res.status(400).json({ error: 'symbol 与 interval 必填' })
    const rows = await binance.getKlines(
      String(symbol).toUpperCase(),
      String(interval),
      Math.min(Number(limit) || 500, 1000),
      before ? Number(before) : undefined
    )
    res.json({ klines: rows })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/search', async (req, res) => {
  try {
    res.json({ symbols: await binance.searchSymbols(String(req.query.q || '')) })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/spread', async (req, res) => {
  try {
    const q = String(req.query.symbols || '')
    const symbols = q
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const data = symbols.length ? await getSpreadData(symbols) : await getSpreadData(DEFAULT_WATCH)
    res.json(data)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/screener', (_req, res) => {
  res.json(screener.getLastResults() || { results: [], mode: 'any', rules: [], generatedAt: 0 })
})

app.get('/api/screener/status', (_req, res) => {
  res.json(screener.getScanState())
})

app.post('/api/screener', async (req, res) => {
  try {
    const rules = {
      r1: !!req.body.r1,
      r2: !!req.body.r2,
      r3: !!req.body.r3,
      r4: !!req.body.r4,
      r5: !!req.body.r5,
    }
    const mode = req.body.mode === 'all' ? 'all' : 'any'
    const month = typeof req.body.month === 'string' ? req.body.month : ''
    const result = await screener.scan(rules, mode, { month })
    res.json({ ok: true, ...result, state: screener.getScanState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/listings', (_req, res) => {
  const now = new Date()
  const rows = db.prepare('SELECT symbol, date FROM listings ORDER BY date ASC').all()
  const map = new Map()
  for (const r of rows) {
    const d = new Date(r.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({ symbol: r.symbol, date: new Date(r.date).toISOString() })
  }
  const keys = [...map.keys()].sort()
  const months = []
  if (keys.length) {
    let [y, m] = keys[0].split('-').map(Number)
    const nowY = now.getFullYear()
    const nowM = now.getMonth() + 1
    while (y < nowY || (y === nowY && m <= nowM)) {
      const key = `${y}-${String(m).padStart(2, '0')}`
      months.push({ key, label: `${y}/${String(m).padStart(2, '0')}`, items: map.get(key) || [] })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
  }
  res.json({ total: rows.length, months, generatedAt: Date.now() })
})

app.get('/api/status', (_req, res) => {
  res.json({
    ...monitor.getStatus(),
    smtpConfigured: !!getSetting('smtp_host'),
    smtpMasked: getSetting('smtp_user') ? getSetting('smtp_user') : null,
    hasRecipients: !!(getSetting('recipients') || '').trim(),
  })
})

app.get('/api/settings', (_req, res) => {
  const s = getSettings()
  if (s.smtp_pass) s.smtp_pass = '***已设置***'
  if (s.admin_pass) delete s.admin_pass
  res.json(s)
})

app.post('/api/settings', (req, res) => {
  const fields = [
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'recipients',
    'spread_alert_enabled', 'spread_alert_threshold', 'spread_watchlist',
  ]
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'smtp_pass' && String(req.body[f]).trim() === '') continue
      setSetting(f, String(req.body[f]).trim())
    }
  }
  res.json({ ok: true })
})

app.post('/api/test-email', async (_req, res) => {
  try {
    const to = await sendMail('【测试】币安上新监控邮件配置', '<p>SMTP 配置正常，测试邮件发送成功。</p>')
    console.log(`[mail] 测试邮件发送成功 → ${to.join(', ')}`)
    res.json({ ok: true, to })
  } catch (e) {
    console.error('[mail] 测试邮件发送失败:', e.message)
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/monitor/run', async (_req, res) => {
  try {
    await monitor.runOnce()
    res.json({ ok: true, status: monitor.getStatus() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const dist = path.join(__dirname, '..', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`)
  monitor.startMonitor()
})
