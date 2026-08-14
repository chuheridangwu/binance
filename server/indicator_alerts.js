import { db } from './db.js'
import { getFuturesKlines } from './binance.js'
import { rsiSeries } from './screener.js'
import { sendMail } from './mailer.js'

// 指标告警：为指定交易对配置指标阈值（如 RSI(6) ≤ 20），monitor 定时检查，
// 命中且超过冷却期后发邮件提醒。冷却期内即使指标仍超阈值也不重复发，
// 冷却到期后再命中会再次提醒，避免反复轰炸。
//
// 触发条件：direction='lt' 时 value ≤ threshold；'gt' 时 value ≥ threshold。
// 状态机：idle → 命中且 now ≥ cooldown_until → 发信并设置 cooldown_until = now + COOLDOWN_MS。

const COOLDOWN_MS = 6 * 3600 * 1000 // 冷却 6 小时（防反复轰炸）

export function listAlerts() {
  return db.prepare('SELECT * FROM ind_alerts ORDER BY created_at DESC').all()
}

export function createAlert({ symbol, indicator = 'rsi', period = 6, threshold, direction = 'lt', active = 1 }) {
  const sym = String(symbol || '').trim().toUpperCase()
  if (!sym) throw new Error('symbol 必填')
  if (!sym.endsWith('USDT')) throw new Error('交易对需以 USDT 结尾，如 BTCUSDT')
  const ind = String(indicator || 'rsi').toLowerCase()
  if (ind !== 'rsi') throw new Error('暂仅支持 RSI 指标')
  const per = Number(period)
  if (!Number.isFinite(per) || per < 2 || per > 100) throw new Error('周期需在 2~100 之间')
  const th = Number(threshold)
  if (!Number.isFinite(th)) throw new Error('阈值必须是数字')
  const dir = direction === 'gt' ? 'gt' : 'lt'
  const info = db
    .prepare('INSERT INTO ind_alerts (symbol, indicator, period, threshold, direction, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sym, ind, per, th, dir, active ? 1 : 0, Date.now())
  return getAlert(Number(info.lastInsertRowid))
}

export function getAlert(id) {
  return db.prepare('SELECT * FROM ind_alerts WHERE id = ?').get(Number(id))
}

export function deleteAlert(id) {
  db.prepare('DELETE FROM ind_alerts WHERE id = ?').run(Number(id))
}

export function updateAlert(id, patch) {
  const cur = getAlert(id)
  if (!cur) throw new Error('告警不存在')
  const symbol = patch.symbol !== undefined ? String(patch.symbol).trim().toUpperCase() : cur.symbol
  const indicator = patch.indicator !== undefined ? String(patch.indicator).toLowerCase() : cur.indicator
  const period = patch.period !== undefined ? Number(patch.period) : cur.period
  const threshold = patch.threshold !== undefined ? Number(patch.threshold) : cur.threshold
  const direction = patch.direction !== undefined ? (patch.direction === 'gt' ? 'gt' : 'lt') : cur.direction
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : cur.active
  db.prepare(
    `UPDATE ind_alerts SET symbol = ?, indicator = ?, period = ?, threshold = ?, direction = ?, active = ? WHERE id = ?`
  ).run(symbol, indicator, period, threshold, direction, active, id)
  return getAlert(id)
}

export function resetAlertState(id) {
  db.prepare('UPDATE ind_alerts SET last_value = NULL, notified_at = NULL, cooldown_until = 0 WHERE id = ?').run(Number(id))
}

// 计算某币的 RSI 当前值：取 period+1 根日K收盘，返回最后一个 RSI
async function currentRsi(symbol, period) {
  const klines = await getFuturesKlines(symbol, '1d', period + 1)
  if (klines.length < period + 1) return null
  const closes = klines.map((k) => k.close)
  const rsi = rsiSeries(closes, period)
  const last = rsi[rsi.length - 1]
  return Number.isFinite(last) ? last : null
}

// 检查所有告警：逐条拉取指标、判断触发、发送邮件
export async function checkAlerts() {
  const alerts = db.prepare('SELECT * FROM ind_alerts WHERE active = 1').all()
  if (!alerts.length) return { checked: 0, triggered: 0 }
  let triggered = 0
  const now = Date.now()
  for (const a of alerts) {
    let value = null
    try {
      value = await currentRsi(a.symbol, a.period)
    } catch {
      continue // 单条失败不影响其他
    }
    if (value === null) continue

    const hit = a.direction === 'lt' ? value <= a.threshold : value >= a.threshold

    db.prepare('UPDATE ind_alerts SET last_value = ?, last_at = ? WHERE id = ?').run(value, now, a.id)

    if (hit && now >= a.cooldown_until) {
      try {
        await sendMail(
          `【${a.indicator.toUpperCase()}告警】${a.symbol} ${a.indicator.toUpperCase()}(${a.period}) ${value.toFixed(1)}`,
          `<p><b>${a.symbol}</b> 指标触发阈值</p>` +
            `<p>指标：${a.indicator.toUpperCase()}(${a.period})</p>` +
            `<p>条件：${a.direction === 'lt' ? '≤' : '≥'} ${a.threshold}</p>` +
            `<p>当前值：<b style="color:#f6465d">${value.toFixed(2)}</b></p>` +
            `<p>提醒时间：${new Date().toLocaleString('zh-CN')}</p>` +
            `<p>冷却 ${COOLDOWN_MS / 3600000} 小时后若仍超阈值会再次提醒。</p>`
        )
        db.prepare('UPDATE ind_alerts SET notified_at = ?, cooldown_until = ? WHERE id = ?').run(now, now + COOLDOWN_MS, a.id)
        triggered++
      } catch (e) {
        console.error(`[alert] 邮件发送失败(${a.symbol}):`, e.message)
      }
    }
  }
  return { checked: alerts.length, triggered }
}

// 立即计算某告警的当前指标值（用于状态面板展示）
export async function previewAlert(symbol, period) {
  const sym = String(symbol || '').trim().toUpperCase()
  const per = Number(period) || 6
  try {
    const value = await currentRsi(sym, per)
    return { symbol: sym, indicator: 'rsi', period: per, value }
  } catch (e) {
    return { symbol: sym, indicator: 'rsi', period: per, value: null, error: e.message }
  }
}