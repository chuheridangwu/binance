import { db, getSetting } from './db.js'
import { getFuturesPrices } from './binance.js'
import { sendMail } from './mailer.js'

export function listTrackers(activeOnly = false) {
  const sql = activeOnly
    ? 'SELECT * FROM trackers WHERE notified = 0 AND expire_at > ? ORDER BY created_at DESC'
    : 'SELECT * FROM trackers ORDER BY created_at DESC'
  const rows = activeOnly ? db.prepare(sql).all(Date.now()) : db.prepare(sql).all()
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    direction: r.direction,
    target_price: r.target_price,
    expire_at: r.expire_at,
    created_at: r.created_at,
    notified: r.notified,
    notified_at: r.notified_at,
  }))
}

export function createTracker({ symbol, direction, target_price, expire_at }) {
  const s = String(symbol || '').trim().toUpperCase()
  if (!s) throw new Error('symbol 必填')
  const dir = direction === 'down' ? 'down' : 'up'
  const price = Number(target_price)
  if (!Number.isFinite(price) || price <= 0) throw new Error('目标价必须是正数')
  const exp = Number(expire_at)
  if (!Number.isFinite(exp) || exp <= Date.now()) throw new Error('截止时间必须晚于当前时间')
  const info = db
    .prepare(
      'INSERT INTO trackers (symbol, direction, target_price, expire_at, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(s, dir, price, exp, Date.now())
  return { id: Number(info.lastInsertRowid), symbol: s, direction: dir, target_price: price, expire_at: exp }
}

export function deleteTracker(id) {
  db.prepare('DELETE FROM trackers WHERE id = ?').run(Number(id))
}

// 检查所有未触发的追踪：达到目标价→发邮件并标记；过期未触发→标记 expired（notified=2）
export async function checkTrackers() {
  const active = listTrackers(true)
  if (!active.length) return 0
  let prices
  try {
    prices = await getFuturesPrices()
  } catch {
    return 0
  }
  let triggered = 0
  for (const t of active) {
    const price = prices.get(t.symbol)
    if (price === undefined || price === null || price === 0) continue
    const hit = t.direction === 'up' ? price >= t.target_price : price <= t.target_price
    if (hit) {
      try {
        await sendMail(
          `【价格提醒】${t.symbol} 已达目标价 ${t.target_price}`,
          `<p><b>${t.symbol}</b> ${t.direction === 'up' ? '上涨' : '下跌'}至目标价</p>` +
            `<p>方向：${t.direction === 'up' ? '价 ≥' : '价 ≤'} ${t.target_price}</p>` +
            `<p>当前价格：<b>${price}</b></p>` +
            `<p>截止时间：${new Date(t.expire_at).toLocaleString('zh-CN')}</p>` +
            `<p>提醒时间：${new Date().toLocaleString('zh-CN')}</p>`
        )
        db.prepare('UPDATE trackers SET notified = 1, notified_at = ? WHERE id = ?').run(Date.now(), t.id)
        triggered++
      } catch (e) {
        console.error(`[tracker] 邮件发送失败(${t.symbol}):`, e.message)
      }
    } else if (t.expire_at < Date.now()) {
      db.prepare('UPDATE trackers SET notified = 2 WHERE id = ?').run(t.id)
    }
  }
  return triggered
}

export { getSetting }
