<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchSimilar } from '../api/monitor'
import { store } from '../store'

const loading = ref(false)
const error = ref('')
const results = ref([])
const targetSymbol = ref('')
const startDate = ref('')
const endDate = ref('')
const queriedSymbol = ref('')
const refWindow = ref(null)
const targetRet = ref(null)
const generatedAt = ref(null)
const sortKey = ref('similarity')
const sortDir = ref(-1)

function todayStr(offsetDays) {
  const d = new Date(Date.now() - (offsetDays || 0) * 24 * 3600 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function load() {
  const sym = targetSymbol.value.trim().toUpperCase()
  if (!sym) {
    error.value = '请输入币种符号'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await fetchSimilar(sym, startDate.value || null, endDate.value || null)
    results.value = res.results || []
    queriedSymbol.value = res.symbol || sym
    refWindow.value = res.refWindow || null
    targetRet.value = res.targetRet ?? null
    generatedAt.value = res.generatedAt
  } catch (e) {
    error.value = e.message
    results.value = []
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
  const key = sortKey.value
  return [...results.value].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    return sortDir.value * (av - bv)
  })
})

function fmtSimilarity(v) {
  if (v === null || v === undefined) return '—'
  return (v * 100).toFixed(1) + '%'
}

function fmtDate(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = v > 0 ? '+' : ''
  return s + v.toFixed(1) + '%'
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

onMounted(() => {
  endDate.value = todayStr(0)
  startDate.value = todayStr(30)
  if (store.chartSymbol) {
    targetSymbol.value = store.chartSymbol.replace('USDT', '')
    load()
  }
})
</script>

<template>
  <div class="similar">
    <div class="head">
      <h2>相似趋势</h2>
      <span class="note">选定一个币的时间区间（参考走势），查找当前走势与该区间最相似的币</span>
    </div>

    <div class="filters">
      <span class="mode-label">币种：</span>
      <input v-model="targetSymbol" class="search-input" placeholder="如 ARB / BTC / AAPL" @keyup.enter="load" />
      <span class="mode-label">开始时间：</span>
      <input v-model="startDate" type="date" class="select" :disabled="loading" />
      <span class="mode-label">结束时间：</span>
      <input v-model="endDate" type="date" class="select" :disabled="loading" />
      <span class="mode-label">（留空默认最近 30 天）</span>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '搜索中…' : '查找相似' }}</button>
      <span class="note" v-if="queriedSymbol">
        与 <b>{{ queriedSymbol }}</b>
        <template v-if="refWindow">{{ fmtDate(refWindow.start) }} ~ {{ fmtDate(refWindow.end) }}（{{ refWindow.bars }} 根日K）</template>
        <template v-else>最近 {{ 30 }} 天</template>
        最相似（共 {{ results.length }} 个有数据）
      </span>
    </div>

    <div v-if="error" class="hint err">{{ error }}</div>
    <div v-else-if="!queriedSymbol" class="hint">输入一个币种，查找相同趋势的币</div>
    <div v-else class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th @click="sortClick('symbol')">币种</th>
            <th @click="sortClick('similarity')">综合相似</th>
            <th @click="sortClick('shapeCorr')">形态相关</th>
            <th @click="sortClick('retCorr')">日收益相关</th>
            <th @click="sortClick('retWindow')">当前区间涨跌</th>
            <th @click="sortClick('currentPrice')">现价</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.symbol" @click="openChart(c.symbol)">
            <td class="sym">{{ c.symbol }}</td>
            <td><b class="sim">{{ fmtSimilarity(c.similarity) }}</b></td>
            <td class="mono dim">{{ fmtSimilarity(c.shapeCorr) }}</td>
            <td class="mono dim">{{ fmtSimilarity(c.retCorr) }}</td>
            <td><b :class="c.retWindow > 0 ? 'up' : c.retWindow < 0 ? 'down' : ''">{{ fmtPct(c.retWindow) }}</b></td>
            <td class="mono dim">{{ fmtPrice(c.currentPrice) }}</td>
          </tr>
          <tr v-if="!filtered.length && !loading">
            <td colspan="6" class="empty">没有找到相似币（历史K线回补中或数据不足）</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.similar {
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
.search-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 6px 12px;
  font-size: 13px;
  width: 160px;
  outline: none;
}
.search-input:focus {
  border-color: #f0b90b;
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
.sim {
  color: #f0b90b;
}
.up {
  color: #0ecb81;
}
.down {
  color: #f6465d;
}
.mono {
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