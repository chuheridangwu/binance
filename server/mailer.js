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

export function isConfigured() {
  const s = getSettings()
  return !!(s.smtp_host && s.smtp_user && s.smtp_pass)
}

export async function sendMail(subject, html) {
  const s = getSettings()
  if (!isConfigured()) throw new Error('SMTP 未配置')
  const to = (s.recipients || '')
    .split(/[,;，；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
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
