<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchListingPerformance } from '../api/monitor'
import { store } from '../store'

const loading = ref(false)
const error = ref('')
const results = ref([])
const summary = ref(null)
const generatedAt = ref(null)
const months = ref(6)
const sortKey = ref('ret30')
const sortDir = ref(-1)
const search = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetchListingPerformance(months.value)
    results.value = res.results || []
    summary.value = res.summary || null
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
  const s = v > 0 ? '+' : ''
  return s + v.toFixed(1) + '%'
}

function pctClass(v) {
  if (v === null || v === undefined) return ''
  return v > 0 ? 'up' : v < 0 ? 'down' : ''
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
  <div class="perf">
    <div class="head">
      <h2>上新表现追踪</h2>
      <span class="note">以上架日收盘价为基准，看上线后 7/30/90 天涨跌幅（数据来自 market.db 历史K线）</span>
    </div>

    <div class="filters">
      <span class="mode-label">时间范围：</span>
      <select v-model.number="months" class="select" :disabled="loading">
        <option :value="3">近 3 个月</option>
        <option :value="6">近 6 个月</option>
        <option :value="12">近 1 年</option>
        <option :value="24">近 2 年</option>
      </select>
      <button class="btn" :disabled="loading" @click="load">查询</button>
      <span class="note">已匹配 {{ results.length }} 个（有历史K线的）</span>
      <span v-if="generatedAt" class="note right">更新：{{ new Date(generatedAt).toLocaleString('zh-CN') }}</span>
    </div>

    <div v-if="summary && !loading" class="cards">
      <div class="card"><div class="num">{{ summary.count }}</div><div class="label">上新币数</div></div>
      <div class="card" v-if="summary.ret7"><div class="num" :class="pctClass(summary.ret7.avg)">{{ fmtPct(summary.ret7.avg) }}</div><div class="label">7天平均涨跌</div></div>
      <div class="card" v-if="summary.ret30"><div class="num" :class="pctClass(summary.ret30.avg)">{{ fmtPct(summary.ret30.avg) }}</div><div class="label">30天平均涨跌</div></div>
      <div class="card" v-if="summary.current"><div class="num" :class="pctClass(summary.current.avg)">{{ fmtPct(summary.current.avg) }}</div><div class="label">当前平均涨跌</div></div>
      <div class="card" v-if="summary.ret30"><div class="num">{{ summary.ret30.gainRate.toFixed(0) }}%</div><div class="label">30天上涨占比</div></div>
    </div>

    <div class="search-row">
      <input v-model="search" class="search-input" placeholder="搜索币种" />
      <span v-if="loading" class="note">加载中…</span>
      <span v-else class="note">共 {{ filtered.length }} 个</span>
    </div>

    <div v-if="error" class="hint err">{{ error }}</div>
    <div v-else class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th @click="sortClick('symbol')">币种</th>
            <th @click="sortClick('listed')">上架月份</th>
            <th @click="sortClick('basePrice')">上架价</th>
            <th @click="sortClick('ret7')">7D</th>
            <th @click="sortClick('ret30')">30D</th>
            <th @click="sortClick('ret90')">90D</th>
            <th @click="sortClick('currentRet')">当前</th>
            <th @click="sortClick('currentPrice')">现价</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.symbol" @click="openChart(c.symbol)">
            <td class="sym">{{ c.symbol }}</td>
            <td class="listed">{{ c.listed }}</td>
            <td class="dim">{{ fmtPrice(c.basePrice) }}</td>
            <td><b :class="pctClass(c.ret7)">{{ fmtPct(c.ret7) }}</b></td>
            <td><b :class="pctClass(c.ret30)">{{ fmtPct(c.ret30) }}</b></td>
            <td><b :class="pctClass(c.ret90)">{{ fmtPct(c.ret90) }}</b></td>
            <td><b :class="pctClass(c.currentRet)">{{ fmtPct(c.currentRet) }}</b></td>
            <td class="dim">{{ fmtPrice(c.currentPrice) }}</td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="8" class="empty">暂无数据（历史K线回补中，稍后刷新）</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.perf {
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
.cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}
@media (max-width: 900px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
.card {
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 14px 10px;
  text-align: center;
}
.card .num {
  font-size: 18px;
  font-weight: 700;
  color: #f0b90b;
}
.card .num.up {
  color: #0ecb81;
}
.card .num.down {
  color: #f6465d;
}
.card .label {
  margin-top: 4px;
  color: #848e9c;
  font-size: 11px;
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
.listed {
  color: #848e9c;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
.dim {
  color: #5e6673;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
.up {
  color: #0ecb81;
}
.down {
  color: #f6465d;
}
.empty {
  text-align: center;
  color: #5e6673;
  padding: 30px;
  cursor: default !important;
}
</style>