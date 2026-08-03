import nodemailer from 'nodemailer'
import { getSettings } from './db.js'

function smtpConfig(settings) {
  return {
    host: settings.smtp_host,
    port: Number(settings.smtp_port || 465),
    secure: Number(settings.smtp_port || 465) === 465,
    auth: {
      user: settings.smtp_user,
      pass: settings.smtp_pass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  }
}

function getRecipients(settings) {
  return (settings.recipients || '')
    .split(/[,;，；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`))
}

export function isConfigured() {
  const s = getSettings()
  return !!(s.smtp_host && s.smtp_user && s.smtp_pass)
}

export async function sendMail(subject, html) {
  const s = getSettings()
  if (!isConfigured()) throw new Error('SMTP 未配置')
  const to = getRecipients(s)
  if (!to.length) throw new Error('未配置收件人')
  const transporter = nodemailer.createTransport(smtpConfig(s))
  await transporter.sendMail({
    from: `"币安上新监控" <${s.smtp_user}>`,
    to,
    subject,
    html,
  })
  return to
}

const DEFAULT_SUBJECT = '【币安上新】{symbol} 今日上线'
const DEFAULT_BODY =
  '<p><b>{title}</b></p><p>上线日期：{date}</p><p>监控时间：{time}</p>'

/**
 * 按用户配置的邮件模板（settings: mail_subject_template / mail_body_template）发送上币邮件。
 * 占位符：{symbol} {title} {date} {time}
 */
export async function sendListingMail(listing) {
  const s = getSettings()
  const subject = renderTemplate(s.mail_subject_template, {
    symbol: listing.symbol,
    title: listing.title || `币安新上线：${listing.symbol}`,
    date: new Date(listing.date).toISOString().slice(0, 10),
    time: new Date().toLocaleString('zh-CN'),
  })
  const html = renderTemplate(s.mail_body_template || DEFAULT_BODY, {
    symbol: listing.symbol,
    title: listing.title || `币安新上线：${listing.symbol}`,
    date: new Date(listing.date).toISOString().slice(0, 10),
    time: new Date().toLocaleString('zh-CN'),
  })
  const subj = subject || renderTemplate(DEFAULT_SUBJECT, { symbol: listing.symbol })
  return sendMail(subj, html)
}
