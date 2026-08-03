import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSetting, setSetting } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const TOKEN_TTL = 7 * 24 * 3600 * 1000

const tokens = new Map()

function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const h = crypto.createHash('sha256').update(salt + pw).digest('hex')
  return `${salt}:${h}`
}

function verifyPass(pw, stored) {
  if (!stored) return false
  const [salt, h] = String(stored).split(':')
  if (!salt || !h) return false
  const cand = crypto.createHash('sha256').update(salt + pw).digest('hex')
  const a = Buffer.from(cand, 'hex')
  const b = Buffer.from(h, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function initAdminPass() {
  if (getSetting('admin_pass')) return
  let pw = process.env.ADMIN_PASS
  let source = 'ADMIN_PASS 环境变量'
  if (!pw) {
    pw = crypto.randomBytes(6).toString('base64url')
    source = '自动生成'
    try {
      fs.writeFileSync(path.join(dataDir, 'INITIAL_PASSWORD.txt'), `初始登录密码: ${pw}\n登录后请在「监控设置 → 修改登录密码」中更换\n`)
    } catch {}
  }
  setSetting('admin_pass', hashPass(pw))
  console.log(`[auth] 初始登录密码已设置（${source}），可在 data/INITIAL_PASSWORD.txt 查看`)
}

export function login(password) {
  const stored = getSetting('admin_pass')
  if (!stored || !verifyPass(password, stored)) return null
  const token = crypto.randomBytes(32).toString('hex')
  tokens.set(token, Date.now() + TOKEN_TTL)
  return token
}

export function checkToken(token) {
  if (!token) return false
  const exp = tokens.get(token)
  if (!exp) return false
  if (exp < Date.now()) {
    tokens.delete(token)
    return false
  }
  return true
}

export function logout(token) {
  tokens.delete(token)
}

export function changePassword(oldPw, newPw) {
  const stored = getSetting('admin_pass')
  if (!stored || !verifyPass(oldPw, stored)) return { ok: false, error: '旧密码不正确' }
  if (!newPw || String(newPw).length < 6) return { ok: false, error: '新密码至少 6 位' }
  setSetting('admin_pass', hashPass(String(newPw)))
  return { ok: true }
}
