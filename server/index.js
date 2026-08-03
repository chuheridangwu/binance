import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, getSettings, getSetting, setSetting } from './db.js'
import * as binance from './binance.js'
import * as monitor from './monitor.js'
import { sendMail } from './mailer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }))

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

app.get('/api/listings', (_req, res) => {
  const twoYearsAgo = Date.now() - 730 * 24 * 3600 * 1000
  const rows = db
    .prepare('SELECT symbol, date FROM listings WHERE date >= ? ORDER BY date ASC')
    .all(twoYearsAgo)
  const map = new Map()
  for (const r of rows) {
    const d = new Date(r.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({ symbol: r.symbol, date: new Date(r.date).toISOString() })
  }
  const now = new Date()
  const months = []
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    months.push({ key, label: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`, items: map.get(key) || [] })
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
  res.json(s)
})

app.post('/api/settings', (req, res) => {
  const fields = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'recipients']
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
    res.json({ ok: true, to })
  } catch (e) {
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
