<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchMeme } from '../api/monitor'
import { store } from '../store'

const loading = ref(false)
const error = ref('')
const results = ref([])
const generatedAt = ref(null)
const windowHours = ref(24)
const threshold = ref(50)
const sortKey = ref('ret')
const sortDir = ref(-1)
const search = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetchMeme({ windowHours: windowHours.value, threshold: threshold.value })
    results.value = res.results || []
    generatedAt.value = res.generatedAt
  } catch (e) {
    error.value = '数据获取失败：' + e.message
  } finally {
    loading.value = false
  }
}

function sortClick(key) {
  if (sortKey.value === key) sortDir.value *= -1
  else {
    sortKey.value = key
    sortDir.value = -1
  }
}

const filtered = computed(() => {
  const kw = search.value.trim().toUpperCase()
  let list = results.value
  if (kw) list = list.filter((c) => c.symbol.includes(kw))
  const key = sortKey.value
  return [...list].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    return sortDir.value * (av - bv)
  })
})

function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return '+' + v.toFixed(1) + '%'
}

function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 1000) return v.toFixed(2)
  if (v >= 1) return v.toFixed(4)
  if (v >= 0.0001) return v.toFixed(6)
  return v.toFixed(8)
}

function openChart(sym) {
  store.chartSymbol = sym
  store.activeTab = 'chart'
}

onMounted(load)
</script>

<template>
  <div class="meme">
    <div class="head">
      <h2>妖币统计</h2>
      <span class="note">找出 N 小时内涨幅 ≥ 阈值 的币（现价 vs 基准价，基准价来自 market.db 历史K线）</span>
    </div>

    <div class="filters">
      <span class="mode-label">时间窗口：</span>
      <select v-model.number="windowHours" class="select" :disabled="loading">
        <option :value="24">24 小时</option>
        <option :value="48">48 小时</option>
        <option :value="72">72 小时</option>
        <option :value="120">5 天</option>
      </select>
      <span class="mode-label">涨幅阈值：</span>
      <select v-model.number="threshold" class="select" :disabled="loading">
        <option :value="50">≥ 50%</option>
        <option :value="75">≥ 75%</option>
        <option :value="100">≥ 100%</option>
        <option :value="125">≥ 125%</option>
        <option :value="150">≥ 150%</option>
      </select>
      <button class="btn" :disabled="loading" @click="load">查询</button>
      <span class="note">命中 {{ results.length }} 个</span>
      <span v-if="generatedAt" class="note right">更新：{{ new Date(generatedAt).toLocaleString('zh-CN') }}</span>
    </div>

    <div class="search-row">
      <input v-model="search" class="search-input" placeholder="搜索币种" />
      <span v-if="loading" class="note">加载中…</span>
    </div>

    <div v-if="error" class="hint err">{{ error }}</div>
    <div v-else class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th @click="sortClick('symbol')">币种</th>
            <th @click="sortClick('ret')">涨幅</th>
            <th @click="sortClick('price')">现价</th>
            <th @click="sortClick('basePrice')">基准价</th>
            <th @click="sortClick('listed')">上架时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.symbol" @click="openChart(c.symbol)">
            <td class="sym">{{ c.symbol }}</td>
            <td><b class="up">{{ fmtPct(c.ret) }}</b></td>
            <td class="mono">{{ fmtPrice(c.price) }}</td>
            <td class="dim">{{ fmtPrice(c.basePrice) }}</td>
            <td class="listed">{{ c.listed || '—' }}</td>
          </tr>
          <tr v-if="!filtered.length && !loading">
            <td colspan="5" class="empty">没有符合条件（涨幅 ≥ {{ threshold }}%）的币，或历史K线回补中</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.meme {
  background: #0b0e11;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.head h2 {
  font-size: 18px;
  margin: 0;
  color: #eaecef;
}
.note {
  color: #848e9c;
  font-size: 12px;
}
.note.right {
  margin-left: auto;
}
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.mode-label {
  color: #848e9c;
  font-size: 13px;
}
.select {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 5px 10px;
  font-size: 13px;
  color-scheme: dark;
}
.select:focus {
  border-color: #f0b90b;
  outline: none;
}
.btn {
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.search-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 6px 12px;
  font-size: 13px;
  width: 220px;
  outline: none;
}
.search-input:focus {
  border-color: #f0b90b;
}
.hint {
  text-align: center;
  color: #848e9c;
  padding: 40px;
}
.hint.err {
  color: #f6465d;
}
.table-wrap {
  border: 1px solid #2b3139;
  border-radius: 8px;
  overflow: auto;
  background: #101417;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th {
  text-align: left;
  padding: 10px 12px;
  color: #848e9c;
  font-weight: 500;
  font-size: 12px;
  background: #161a1e;
  border-bottom: 1px solid #2b3139;
  white-space: nowrap;
  cursor: pointer;
}
.tbl th:hover {
  color: #f0b90b;
}
.tbl td {
  padding: 8px 12px;
  color: #eaecef;
  border-bottom: 1px solid #1e2329;
  white-space: nowrap;
  cursor: pointer;
}
.tbl tbody tr:hover {
  background: #1e2329;
}
.sym {
  color: #f0b90b;
  font-weight: 600;
}
.up {
  color: #0ecb81;
  font-weight: 700;
}
.mono,
.listed {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
.dim {
  color: #5e6673;
}
.empty {
  text-align: center;
  color: #5e6673;
  padding: 30px;
  cursor: default !important;
}
</style>