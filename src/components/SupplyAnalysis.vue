<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchCoinSupply } from '../api/monitor'
import { store } from '../store'

const loading = ref(false)
const error = ref('')
const coins = ref([])
const summary = ref(null)
const generatedAt = ref(null)
const maxSupplyTarget = ref('1000000000')
const tolerance = ref(0.1)
const useRange = ref(false)
const supplyMin = ref('')
const supplyMax = ref('')
const sortKey = ref('price')
const sortDir = ref(-1)
const search = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const params = useRange.value ? { supplyMin: supplyMin.value, supplyMax: supplyMax.value } : { maxSupply: maxSupplyTarget.value, tolerance: tolerance.value }
    const res = await fetchCoinSupply(params)
    coins.value = res.coins || []
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
  let list = coins.value
  if (kw) list = list.filter((c) => c.symbol.includes(kw) || (c.name || '').toUpperCase().includes(kw))
  const key = sortKey.value
  return [...list].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    if (typeof av === 'string') return sortDir.value * av.localeCompare(bv)
    return sortDir.value * (av - bv)
  })
})

function fmtUsd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T'
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K'
  return '$' + Number(v).toFixed(2)
}

function fmtSupply(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T'
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  return Number(v).toFixed(0)
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
  <div class="supply">
    <div class="head">
      <h2>供应量分析</h2>
      <span class="note">基于 CoinGecko 已缓存数据（市值 ÷ 流通量 = 当前价），无需额外请求</span>
    </div>

    <div class="filters">
      <label class="check">
        <input v-model="useRange" type="checkbox" :disabled="loading" />
        <b>用区间过滤</b>
      </label>
      <template v-if="useRange">
        <span class="mode-label">最大供应量区间：</span>
        <input v-model.number="supplyMin" type="number" class="param-input" placeholder="下限" :disabled="loading" />
        <span class="mode-label">—</span>
        <input v-model.number="supplyMax" type="number" class="param-input" placeholder="上限" :disabled="loading" />
      </template>
      <template v-else>
        <span class="mode-label">目标最大供应量：</span>
        <input v-model.number="maxSupplyTarget" type="number" class="param-input" :disabled="loading" />
        <span class="mode-label">容差：</span>
        <input v-model.number="tolerance" type="number" step="0.01" min="0" max="1" class="param-input" :disabled="loading" />
      </template>
      <button class="btn" :disabled="loading" @click="load">查询</button>
      <span class="note">例：目标 <b>10 亿</b>（1000000000）看最大供应量≈10亿的币</span>
    </div>

    <div v-if="summary && !loading" class="cards">
      <div class="card"><div class="num">{{ summary.count }}</div><div class="label">币种数</div></div>
      <div class="card"><div class="num">{{ fmtPrice(summary.minPrice) }}</div><div class="label">最低单价</div></div>
      <div class="card"><div class="num">{{ fmtPrice(summary.maxPrice) }}</div><div class="label">最高单价</div></div>
      <div class="card"><div class="num">{{ fmtPrice(summary.medianPrice) }}</div><div class="label">中位单价</div></div>
      <div class="card"><div class="num">{{ fmtUsd(summary.totalMcap) }}</div><div class="label">总市值</div></div>
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
            <th @click="sortClick('name')">全名</th>
            <th @click="sortClick('maxSupply')">最大供应量</th>
            <th @click="sortClick('circulatingSupply')">流通量</th>
            <th @click="sortClick('marketCapUsd')">市值</th>
            <th @click="sortClick('price')">当前价</th>
            <th @click="sortClick('athUsd')">ATH</th>
            <th @click="sortClick('atlUsd')">ATL</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.symbol" @click="openChart(c.symbol)">
            <td class="sym">{{ c.symbol }}</td>
            <td class="name">{{ c.name || '—' }}</td>
            <td class="sup">{{ fmtSupply(c.maxSupply) }}</td>
            <td class="sup">{{ fmtSupply(c.circulatingSupply) }}</td>
            <td>{{ fmtUsd(c.marketCapUsd) }}</td>
            <td><b class="price">{{ fmtPrice(c.price) }}</b></td>
            <td class="dim">{{ fmtUsd(c.athUsd) }}</td>
            <td class="dim">{{ fmtUsd(c.atlUsd) }}</td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="8" class="empty">没有符合条件的币</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.supply {
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
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #eaecef;
  font-size: 13px;
}
.check input {
  accent-color: #f0b90b;
}
.mode-label {
  color: #848e9c;
  font-size: 13px;
}
.param-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 4px 8px;
  font-size: 13px;
  width: 130px;
  color-scheme: dark;
}
.param-input:focus {
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
.name {
  color: #848e9c;
}
.sup {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
.price {
  color: #0ecb81;
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