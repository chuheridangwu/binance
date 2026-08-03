<script setup>
import { ref } from 'vue'
import { login } from '../api/monitor'
import { setToken, setAuthed } from '../store'

const password = ref('')
const loading = ref(false)
const error = ref('')

async function onSubmit() {
  if (!password.value) return
  loading.value = true
  error.value = ''
  try {
    const r = await login(password.value)
    setToken(r.token)
    setAuthed(true)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="onSubmit">
      <div class="mark">B</div>
      <h1>币安监控面板</h1>
      <p class="sub">请输入访问密码</p>
      <input v-model="password" type="password" placeholder="访问密码" autofocus />
      <p v-if="error" class="error">{{ error }}</p>
      <button class="btn" type="submit" :disabled="loading || !password">
        {{ loading ? '登录中…' : '登 录' }}
      </button>
      <p class="hint">密码在服务器「监控设置 → 修改登录密码」中可更换</p>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b0e11;
}
.login-card {
  width: 320px;
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 10px;
  padding: 32px 28px;
  text-align: center;
}
.mark {
  width: 44px;
  height: 44px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 800;
  font-size: 22px;
  border-radius: 8px;
}
h1 {
  margin: 0 0 4px;
  font-size: 18px;
  color: #eaecef;
}
.sub {
  margin: 0 0 20px;
  font-size: 13px;
  color: #848e9c;
}
input {
  width: 100%;
  box-sizing: border-box;
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 10px 12px;
  font-size: 14px;
  outline: none;
}
input:focus {
  border-color: #f0b90b;
}
.btn {
  width: 100%;
  margin-top: 16px;
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  padding: 10px;
  font-size: 14px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error {
  margin: 12px 0 0;
  color: #f6465d;
  font-size: 13px;
}
.hint {
  margin: 18px 0 0;
  color: #5e6673;
  font-size: 12px;
}
</style>
