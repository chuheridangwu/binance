<script setup>
import { onMounted } from 'vue'
import KlineChart from './components/KlineChart.vue'
import ListingsStats from './components/ListingsStats.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SpreadPanel from './components/SpreadPanel.vue'
import ScreenerPanel from './components/ScreenerPanel.vue'
import Login from './components/Login.vue'
import { store, setAuthed } from './store'
import { authStatus, logout } from './api/monitor'

async function onLogout() {
  try {
    await logout()
  } catch {}
  setAuthed(false)
}

onMounted(async () => {
  if (store.token) {
    try {
      const r = await authStatus()
      setAuthed(r.authed)
    } catch {
      setAuthed(false)
    }
  }
})
</script>

<template>
  <div class="app">
    <Login v-if="!store.authed" />
    <template v-else>
      <header class="header">
        <div class="logo">
          <span class="logo-mark">B</span>
          <span class="logo-text">币安监控面板</span>
        </div>
        <nav class="tabs">
          <button :class="{ active: store.activeTab === 'chart' }" @click="store.activeTab = 'chart'">行情图表</button>
          <button :class="{ active: store.activeTab === 'spread' }" @click="store.activeTab = 'spread'">套利监控</button>
          <button :class="{ active: store.activeTab === 'screener' }" @click="store.activeTab = 'screener'">指标选股</button>
          <button :class="{ active: store.activeTab === 'stats' }" @click="store.activeTab = 'stats'">月度上新统计</button>
          <button :class="{ active: store.activeTab === 'settings' }" @click="store.activeTab = 'settings'">监控设置</button>
        </nav>
        <button class="logout" @click="onLogout">退出登录</button>
      </header>
      <main class="main">
        <KlineChart v-show="store.activeTab === 'chart'" />
        <SpreadPanel v-show="store.activeTab === 'spread'" />
        <ScreenerPanel v-show="store.activeTab === 'screener'" />
        <ListingsStats v-show="store.activeTab === 'stats'" />
        <SettingsPanel v-show="store.activeTab === 'settings'" />
      </main>
    </template>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #0b0e11;
}
.header {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 0 24px;
  height: 56px;
  background: #161a1e;
  border-bottom: 1px solid #2b3139;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-mark {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 800;
  border-radius: 6px;
}
.logo-text {
  font-weight: 600;
  color: #eaecef;
}
.tabs {
  display: flex;
  gap: 8px;
}
.tabs button {
  border: none;
  background: transparent;
  color: #848e9c;
  font-size: 14px;
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.tabs button:hover {
  color: #eaecef;
  background: #1e2329;
}
.tabs button.active {
  color: #f0b90b;
  background: #1e2329;
}
.logout {
  margin-left: auto;
  background: transparent;
  border: 1px solid #2b3139;
  color: #848e9c;
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
}
.logout:hover {
  color: #eaecef;
  border-color: #3e4550;
}
.main {
  padding: 16px 24px 24px;
  max-width: 1400px;
  margin: 0 auto;
}
</style>
