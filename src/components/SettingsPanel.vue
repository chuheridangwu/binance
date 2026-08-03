<script setup>
import { ref, onMounted } from 'vue'
import { fetchStatus, fetchSettings, saveSettings, testEmail, triggerMonitor } from '../api/monitor'

const form = ref({ smtp_host: '', smtp_port: '465', smtp_user: '', smtp_pass: '', recipients: '' })
const status = ref(null)
const saving = ref(false)
const testing = ref(false)
const msg = ref({ type: '', text: '' })
const settingsLoaded = ref(false)

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
    await saveSettings(form.value)
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
    status.value = r.status
    show('ok', `扫描完成，共 ${r.status.totalListings} 条记录`)
  } catch (e) {
    show('err', '扫描失败：' + e.message)
  }
}

onMounted(load)
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
        <h3>监控状态</h3>
        <ul v-if="status" class="status-list">
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
