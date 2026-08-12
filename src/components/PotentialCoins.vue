<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchPotential } from '../api/monitor'
import { store } from '../store'

const loading = ref(false)
const error = ref('')
const results = ref([])
const generatedAt = ref(null)
const month = ref(12)
const maxRise = ref(100)
const minAmpl = ref(40)
const volDays = ref(7)
const volRatio = ref(2)
const fundingAbs = ref(0.02)
const use = ref({ lowPrice: true, highVol: true, volume: true, funding: true })
const minScore = ref(2)
const sortKey = ref('score')
const sortDir = ref(-1)
const search = ref('')

const totalChecks = computed(() => Object.values(use.value).filter(Boolean).length)

async function load() {
  if (minScore.value < 1 || minScore.value > totalChecks.value) minScore.value = totalChecks.value || 1
  loading.value = true
  error.value = ''
  try {
    const res = await fetchPotential({
      months: month.value,
      maxRise: maxRise.value,
      minAmpl: minAmpl.value,
      volDays: volDays.value,
      volRatio: volRatio.value,
      fundingAbs: fundingAbs.value,
      use: use.value,
    })
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
  let list = results.value.filter((c) => c.score >= minScore.value)
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

function fmtPct(v, sign = true) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = v.toFixed(1) + '%'
  return sign && v > 0 ? '+' + s : s
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
  <div class="potential">
    <div class="head">
      <h2>潜力新币</h2>
      <span class="note">上市 ≤{{ month }} 个月内、无爆拉历史的低位币，用初期特征（低价/高波动/放量/费率异常）评分</span>
    </div>

    <div class="filters">
      <span class="mode-label">上市窗口：</span>
      <select v-model.number="month" class="select" :disabled="loading">
        <option :value="3">3 个月</option>
        <option :value="6">6 个月</option>
        <option :value="12">12 个月</option>
      </select>
      <span class="mode-label">无爆拉阈值：</span>
      <select v-model.number="maxRise" class="select" :disabled="loading">
        <option :value="50">&lt; 50%</option>
        <option :value="100">&lt; 100%</option>
        <option :value="150">&lt; 150%</option>
        <option :value="200">&lt; 200%</option>
      </select>
      <span class="mode-label">最小命中特征数：</span>
      <select v-model.number="minScore" class="select" :disabled="loading">
        <option :value="totalChecks">全部 {{ totalChecks }} 项</option>
        <option :value="2">≥ 2 项</option>
        <option :value="1">≥ 1 项</option>
      </select>
      <button class="btn" :disabled="loading" @click="load">查询</button>
      <span class="note">命中 {{ filtered.length }} 个</span>
      <span v-if="generatedAt" class="note right">更新：{{ new Date(generatedAt).toLocaleString('zh-CN') }}</span>
    </div>

    <div class="checks">
      <span class="mode-label">特征开关：</span>
      <label v-for="c in [
        { k: 'lowPrice', n: '低单价 &lt;$1' },
        { k: 'highVol', n: '高波动(日振幅≥' + minAmpl + '%)' },
        { k: 'volume', n: '近' + volDays + '日放量≥' + volRatio + '×' },
        { k: 'funding', n: '费率异常(≥' + (fundingAbs * 100).toFixed(2) + '%)' },
      ]" :key="c.k" class="chk">
        <input v-model="use[c.k]" type="checkbox" :disabled="loading" />
        {{ c.n }}
      </label>
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
            <th @click="sortClick('score')">特征数</th>
            <th @click="sortClick('features')">命中特征</th>
            <th @click="sortClick('price')">现价</th>
            <th @click="sortClick('ageDays')">上市天数</th>
            <th @click="sortClick('riseSinceList')">上线以来</th>
            <th @click="sortClick('maxRise')">历史峰值</th>
            <th @click="sortClick('amplitude')">日振幅</th>
            <th @click="sortClick('funding')">当前费率</th>
            <th @click="sortClick('listed')">月份</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.symbol" @click="openChart(c.symbol)">
            <td class="sym">{{ c.symbol }}</td>
            <td class="score">{{ c.score }}</td>
            <td class="feats">{{ c.features.join('、') }}</td>
            <td class="mono">{{ fmtPrice(c.price) }}</td>
            <td>{{ c.ageDays }} 天</td>
            <td class="dim">{{ fmtPct(c.riseSinceList) }}</td>
            <td class="dim">{{ fmtPct(c.maxRise) }}</td>
            <td>{{ fmtPct(c.amplitude, false) }}</td>
            <td :class="c.funding > 0 ? 'up' : 'down'">{{ c.funding === null ? '—' : c.funding.toFixed(3) + '%' }}</td>
            <td class="listed">{{ c.listed || '—' }}</td>
          </tr>
          <tr v-if="!filtered.length && !loading">
            <td colspan="10" class="empty">没有符合条件的币，或 market.db 历史K线回补中（需先回补才有数据）</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.potential {
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
.filters,
.checks {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
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
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #eaecef;
  font-size: 13px;
  cursor: pointer;
}
.chk input {
  accent-color: #f0b90b;
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
.score {
  color: #f0b90b;
  font-weight: 700;
  text-align: center;
}
.up {
  color: #0ecb81;
  font-weight: 700;
}
.down {
  color: #f6465d;
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
.feats {
  color: #b1bac4;
  font-size: 12px;
}
.empty {
  text-align: center;
  color: #5e6673;
  padding: 30px;
  cursor: default !important;
}
</style>