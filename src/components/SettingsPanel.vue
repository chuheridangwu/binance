<script setup>
import { ref, onMounted } from 'vue'
import { fetchStatus, fetchSettings, saveSettings, testEmail, triggerMonitor, changePassword, fetchAlerts, createAlert, updateAlert, deleteAlert, resetAlert, previewAlert } from '../api/monitor'

const form = ref({ smtp_host: '', smtp_port: '465', smtp_user: '', smtp_pass: '', recipients: '', spread_alert_enabled: false, spread_alert_threshold: 30, spread_watchlist: '' })
const pwd = ref({ old_password: '', new_password: '', confirm: '' })
const status = ref(null)
const saving = ref(false)
const testing = ref(false)
const pwdSaving = ref(false)
const msg = ref({ type: '', text: '' })
const settingsLoaded = ref(false)
const alerts = ref([])
const alertForm = ref({ symbol: '', indicator: 'rsi', period: 6, threshold: 20, direction: 'lt', active: true })
const alertLoading = ref(false)
const preview = ref(null)
const previewLoading = ref(false)

function show(type, text) {
  msg.value = { type, text }
}

async function load() {
  try {
    const [st, se] = await Promise.all([fetchStatus(), fetchSettings()])
    status.value = st
    if (!settingsLoaded.value) {
      form.value.smtp_host = se.smtp_host || ''
      form.value.smtp_port = se.smtp_port || '465'
      form.value.smtp_user = se.smtp_user || ''
      form.value.smtp_pass = ''
      form.value.recipients = se.recipients || ''
      form.value.spread_alert_enabled = se.spread_alert_enabled === '1'
      form.value.spread_alert_threshold = Number(se.spread_alert_threshold) || 30
      form.value.spread_watchlist = se.spread_watchlist || ''
      settingsLoaded.value = true
    }
  } catch (e) {
    show('err', '加载状态失败：' + e.message)
  }
}

async function onSave() {
  saving.value = true
  show('', '')
  try {
    const payload = { ...form.value, spread_alert_enabled: form.value.spread_alert_enabled ? '1' : '0' }
    await saveSettings(payload)
    await load()
    show('ok', '设置已保存')
  } catch (e) {
    show('err', '保存失败：' + e.message)
  } finally {
    saving.value = false
  }
}

async function onTest() {
  testing.value = true
  show('', '')
  try {
    const r = await testEmail()
    show('ok', `测试邮件已发送 → ${r.to.join(', ')}`)
  } catch (e) {
    show('err', '发送失败：' + e.message)
  } finally {
    testing.value = false
  }
}

async function onRun() {
  show('', '')
  try {
    const r = await triggerMonitor()
    await load()
    show('ok', `扫描完成，共 ${r.status.totalListings} 条记录`)
  } catch (e) {
    show('err', '扫描失败：' + e.message)
  }
}

async function onChangePwd() {
  if (pwd.value.new_password !== pwd.value.confirm) {
    show('err', '两次输入的新密码不一致')
    return
  }
  pwdSaving.value = true
  show('', '')
  try {
    await changePassword(pwd.value.old_password, pwd.value.new_password)
    pwd.value = { old_password: '', new_password: '', confirm: '' }
    show('ok', '登录密码已修改，请牢记')
  } catch (e) {
    show('err', '修改失败：' + e.message)
  } finally {
    pwdSaving.value = false
  }
}

async function loadAlerts() {
  try {
    const r = await fetchAlerts()
    alerts.value = r.alerts || []
  } catch (e) {
    show('err', '加载指标告警失败：' + e.message)
  }
}

async function onAddAlert() {
  if (!alertForm.value.symbol.trim()) {
    show('err', '请输入交易对')
    return
  }
  alertLoading.value = true
  show('', '')
  try {
    const a = await createAlert({
      symbol: alertForm.value.symbol.trim().toUpperCase(),
      indicator: alertForm.value.indicator,
      period: alertForm.value.period,
      threshold: alertForm.value.threshold,
      direction: alertForm.value.direction,
      active: alertForm.value.active,
    })
    await loadAlerts()
    show('ok', `已添加 ${a.alert.symbol} 指标告警`)
  } catch (e) {
    show('err', '添加失败：' + e.message)
  } finally {
    alertLoading.value = false
  }
}

async function onToggleAlert(a) {
  try {
    await updateAlert(a.id, { active: a.active ? 0 : 1 })
    a.active = a.active ? 0 : 1
  } catch (e) {
    show('err', '切换失败：' + e.message)
  }
}

async function onDeleteAlert(id) {
  try {
    await deleteAlert(id)
    await loadAlerts()
  } catch (e) {
    show('err', '删除失败：' + e.message)
  }
}

async function onResetAlert(id) {
  try {
    await resetAlert(id)
    await loadAlerts()
    show('ok', '告警状态已重置')
  } catch (e) {
    show('err', '重置失败：' + e.message)
  }
}

async function onPreview() {
  if (!alertForm.value.symbol.trim()) return
  previewLoading.value = true
  preview.value = null
  try {
    preview.value = await previewAlert(alertForm.value.symbol.trim().toUpperCase(), alertForm.value.period)
  } catch (e) {
    show('err', '查询失败：' + e.message)
  } finally {
    previewLoading.value = false
  }
}

onMounted(() => {
  load()
  loadAlerts()
})
</script>

<template>
  <div class="settings">
    <div class="head">
      <h2>监控与邮件设置</h2>
    </div>

    <div class="cols">
      <div class="card">
        <h3>SMTP 邮件配置</h3>
        <label>SMTP 服务器
          <input v-model="form.smtp_host" placeholder="如 smtp.qq.com / smtp.163.com" />
        </label>
        <label>端口
          <input v-model="form.smtp_port" placeholder="465(SSL) 或 587(TLS)" />
        </label>
        <label>发件邮箱
          <input v-model="form.smtp_user" placeholder="你的邮箱地址" />
        </label>
        <label>SMTP 授权码
          <input v-model="form.smtp_pass" type="password" placeholder="留空则保持不变" />
        </label>
        <label>收件人（多个用逗号分隔）
          <input v-model="form.recipients" placeholder="a@example.com, b@example.com" />
        </label>
        <div class="actions">
          <button class="btn primary" :disabled="saving" @click="onSave">{{ saving ? '保存中…' : '保存设置' }}</button>
          <button class="btn" :disabled="testing" @click="onTest">{{ testing ? '发送中…' : '发送测试邮件' }}</button>
        </div>
      </div>

      <div class="card">
        <h3>套利提醒</h3>
        <label class="check"><input v-model="form.spread_alert_enabled" type="checkbox" /> 启用资金费率/价差邮件提醒</label>
        <label>年化资金费率阈值（%，超过才提醒）
          <input v-model.number="form.spread_alert_threshold" type="number" min="1" placeholder="如 30" />
        </label>
        <label>监控交易对（逗号分隔，留空用默认 Top12）
          <input v-model="form.spread_watchlist" placeholder="BTCUSDT, ETHUSDT, SOLUSDT" />
        </label>
        <p class="tpl-hint">每 5 分钟扫描一次，同一币种每天最多提醒一次。正费率=多头付空头，负费率=空头付多头。</p>
      </div>

      <div class="card">
        <h3>指标告警</h3>
        <p class="tpl-hint">为交易对设置指标阈值（如 RSI(6) ≤ 20），满足即发邮件。解除冷却：指标回到阈值另一侧后才允许再次提醒，避免持续触发轰炸。</p>
        <div class="alert-form">
          <input v-model="alertForm.symbol" class="text-input" placeholder="交易对，如 BTCUSDT" @keyup.enter="onAddAlert" />
          <select v-model="alertForm.period">
            <option :value="6">RSI(6)</option>
            <option :value="14">RSI(14)</option>
          </select>
          <select v-model="alertForm.direction">
            <option value="lt">≤</option>
            <option value="gt">≥</option>
          </select>
          <input v-model.number="alertForm.threshold" class="text-input" type="number" placeholder="阈值" />
          <button class="btn primary" :disabled="alertLoading" @click="onAddAlert">{{ alertLoading ? '添加中…' : '添加' }}</button>
        </div>
        <div class="alert-preview">
          <button class="btn" :disabled="previewLoading" @click="onPreview">{{ previewLoading ? '查询中…' : '查看当前值' }}</button>
          <span v-if="preview" class="preview-val">
            {{ preview.symbol }} RSI({{ preview.period }}) = <b>{{ preview.value !== null ? preview.value.toFixed(2) : 'N/A' }}</b>
            <span v-if="preview.error" class="err">（{{ preview.error }}）</span>
          </span>
        </div>
        <table class="alert-table" v-if="alerts.length">
          <thead>
            <tr><th>交易对</th><th>指标</th><th>条件</th><th>当前值</th><th>最近提醒</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="a in alerts" :key="a.id" :class="{ off: !a.active }">
              <td>{{ a.symbol }}</td>
              <td>{{ a.indicator.toUpperCase() }}({{ a.period }})</td>
              <td>{{ a.direction === 'lt' ? '≤' : '≥' }} {{ a.threshold }}</td>
              <td>{{ a.last_value !== null && a.last_value !== undefined ? a.last_value.toFixed(2) : '-' }}</td>
              <td>{{ a.notified_at ? new Date(a.notified_at).toLocaleString('zh-CN') : '-' }}</td>
              <td>
                <button class="btn mini" @click="onToggleAlert(a)">{{ a.active ? '停用' : '启用' }}</button>
                <button class="btn mini danger" @click="onResetAlert(a.id)">重置</button>
                <button class="btn mini danger" @click="onDeleteAlert(a.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="tpl-hint">暂无指标告警，先在上方添加。</p>
      </div>

      <div class="card">
        <h3>修改登录密码</h3>
        <label>当前密码
          <input v-model="pwd.old_password" type="password" placeholder="输入当前登录密码" />
        </label>
        <label>新密码（至少 6 位）
          <input v-model="pwd.new_password" type="password" placeholder="输入新密码" />
        </label>
        <label>确认新密码
          <input v-model="pwd.confirm" type="password" placeholder="再次输入新密码" />
        </label>
        <div class="actions">
          <button class="btn primary" :disabled="pwdSaving || !pwd.new_password" @click="onChangePwd">
            {{ pwdSaving ? '保存中…' : '修改密码' }}
          </button>
        </div>
      </div>

      <div class="card">
        <h3>监控状态</h3>        <ul v-if="status" class="status-list">
          <li>SMTP 已配置：<b :class="status.smtpConfigured ? 'ok' : 'bad'">{{ status.smtpConfigured ? '是' : '否' }}</b></li>
          <li>发件邮箱：<b>{{ status.smtpMasked || '—' }}</b></li>
          <li>收件人：<b :class="status.hasRecipients ? 'ok' : 'bad'">{{ status.hasRecipients ? '已配置' : '未配置' }}</b></li>
          <li>总记录：<b>{{ status.totalListings }}</b></li>
          <li>已发邮件：<b>{{ status.notifiedCount }}</b></li>
          <li>最近扫描：<b>{{ status.lastCheck ? new Date(status.lastCheck).toLocaleString('zh-CN') : '—' }}</b></li>
          <li>最近发信：<b>{{ status.lastEmailAt ? new Date(status.lastEmailAt).toLocaleString('zh-CN') : '—' }}</b></li>
          <li v-if="status.lastEmailTo.length">发往：<b>{{ status.lastEmailTo.join(', ') }}</b></li>
        </ul>
        <div class="actions">
          <button class="btn" @click="onRun">立即扫描一次</button>
        </div>
        <ul v-if="status && status.scanErrors.length" class="errors">
          <li v-for="(e, i) in status.scanErrors.slice(-5)" :key="i">{{ e }}</li>
        </ul>
      </div>
    </div>

    <div v-if="msg.text" class="msg" :class="msg.type">{{ msg.text }}</div>

    <p class="tips">
      说明：后端每 60 秒自动检查币安合约是否新增交易对，同时每天拉取官方公告补全数据；当天新上线的币会通过 SMTP 自动发邮件到收件人。QQ/163 邮箱需在设置中开启 SMTP 服务并获取授权码。
    </p>
  </div>
</template>

<style scoped>
.settings {
  background: #0b0e11;
}
.head {
  margin-bottom: 16px;
}
.head h2 {
  font-size: 18px;
  margin: 0;
  color: #eaecef;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 900px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
.card {
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 20px;
}
.card h3 {
  margin: 0 0 16px;
  font-size: 15px;
  color: #eaecef;
}
label {
  display: block;
  color: #848e9c;
  font-size: 13px;
  margin-bottom: 12px;
}
input {
  display: block;
  width: 100%;
  margin-top: 6px;
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 8px 10px;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
input:focus {
  border-color: #f0b90b;
}
textarea.tpl {
  display: block;
  width: 100%;
  margin-top: 6px;
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  resize: vertical;
  font-family: 'SF Mono', Menlo, monospace;
}
textarea.tpl:focus {
  border-color: #f0b90b;
}
.tpl-hint {
  margin: 8px 0 0;
  color: #5e6673;
  font-size: 12px;
  line-height: 1.6;
}
.alert-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.alert-form select,
.alert-form .text-input {
  background: #181a20;
  color: #eaecef;
  border: 1px solid #2b3139;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 14px;
}
.alert-form .text-input {
  width: 160px;
}
.alert-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.preview-val {
  color: #eaecef;
  font-size: 13px;
}
.preview-val b {
  color: #f0b90b;
}
.preview-val .err {
  color: #f6465d;
}
.alert-table {
  margin-top: 12px;
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.alert-table th,
.alert-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #2b3139;
}
.alert-table th {
  color: #5e6673;
  font-weight: 600;
}
.alert-table .off {
  opacity: 0.45;
}
.btn.mini {
  padding: 3px 8px;
  font-size: 12px;
  margin-right: 4px;
}
.btn.danger {
  background: #2a1d1d;
  color: #f6465d;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #eaecef;
  cursor: pointer;
}
.check input {
  accent-color: #f0b90b;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.btn {
  background: #2b3139;
  color: #eaecef;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 14px;
  cursor: pointer;
}
.btn.primary {
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.status-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  color: #848e9c;
  font-size: 13px;
}
.status-list li {
  padding: 5px 0;
  border-bottom: 1px solid #1e2329;
}
.status-list b {
  color: #eaecef;
  font-weight: 600;
}
.status-list .ok {
  color: #0ecb81;
}
.status-list .bad {
  color: #f6465d;
}
.errors {
  list-style: none;
  margin: 12px 0 0;
  padding: 10px;
  background: rgba(246, 70, 93, 0.08);
  border-radius: 6px;
  color: #f6465d;
  font-size: 12px;
}
.msg {
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 6px;
  font-size: 14px;
}
.msg.ok {
  background: rgba(14, 203, 129, 0.1);
  color: #0ecb81;
}
.msg.err {
  background: rgba(246, 70, 93, 0.1);
  color: #f6465d;
}
.tips {
  margin-top: 16px;
  color: #5e6673;
  font-size: 13px;
  line-height: 1.7;
}
</style>
