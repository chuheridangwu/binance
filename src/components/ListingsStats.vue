<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'
import { fetchListings } from '../api/monitor'
import { store } from '../store'

const loading = ref(true)
const error = ref('')
const total = ref(0)
const months = ref([])
const generatedAt = ref(null)
const expanded = ref(null)
const search = ref('')

const filteredMonths = computed(() => {
  const kw = search.value.trim().toUpperCase()
  if (!kw) return months.value
  return months.value
    .map((m) => ({ ...m, items: m.items.filter((it) => it.symbol.includes(kw)) }))
    .filter((m) => m.items.length > 0)
})

const matchedTotal = computed(() => filteredMonths.value.reduce((sum, m) => sum + m.items.length, 0))

const now = new Date()
const thisYearKey = String(now.getFullYear())
const summary = computed(() => {
  const thisYear = months.value.filter((m) => m.key.startsWith(thisYearKey)).reduce((s, m) => s + m.items.length, 0)
  const thisMonth = months.value[0]?.items.length || 0
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  const last30 = months.value.reduce((s, m) => s + m.items.filter((it) => new Date(it.date).getTime() >= cutoff).length, 0)
  return { total: total.value, thisYear, thisMonth, last30 }
})

const yearly = computed(() => {
  const map = {}
  for (const m of months.value) {
    const y = m.key.slice(0, 4)
    map[y] = (map[y] || 0) + m.items.length
  }
  return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]))
})

const topMonths = computed(() =>
  [...months.value]
    .map((m) => ({ label: m.label, count: m.items.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
)

const activeMonth = computed(() => filteredMonths.value.find((m) => m.key === expanded.value) || null)

let chart = null
let histSeries = null
let barByTime = new Map()
let tooltip = null

function monthStartTime(key) {
  return Math.floor(new Date(`${key}-01T00:00:00`).getTime() / 1000)
}

function initChart() {
  const el = document.querySelector('#month-chart')
  if (!el || chart) return
  chart = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: '#101417' }, textColor: '#848e9c', fontSize: 12 },
    grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
    rightPriceScale: { borderColor: 'rgba(42,46,57,0.8)' },
    timeScale: { borderColor: 'rgba(42,46,57,0.8)', timeVisible: false },
    crosshair: { mode: 0, vertLine: { color: '#758696', labelBackgroundColor: '#363a45' }, horzLine: { color: '#758696', labelBackgroundColor: '#363a45' } },
  })
  histSeries = chart.addHistogramSeries({
    color: '#f0b90b',
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: 'price', precision: 0, minMove: 1 },
  })
  chart.timeScale().applyOptions({ rightOffset: 3 })

  chart.subscribeCrosshairMove((p) => {
    if (!p.time || !p.point) {
      if (tooltip) tooltip.style.display = 'none'
      return
    }
    const info = barByTime.get(p.time)
    if (!info) {
      if (tooltip) tooltip.style.display = 'none'
      return
    }
    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.className = 'chart-tooltip'
      document.querySelector('#month-chart').appendChild(tooltip)
    }
    tooltip.style.display = 'block'
    tooltip.style.left = p.point.x + 14 + 'px'
    tooltip.style.top = p.point.y - 14 + 'px'
    tooltip.textContent = `${info.label} · ${info.count} 个`
  })

  chart.subscribeClick((p) => {
    const info = p.time && barByTime.get(p.time)
    if (!info) return
    expanded.value = expanded.value === info.key ? null : info.key
  })
}

function renderChart() {
  if (!chart) initChart()
  if (!chart) return
  const data = filteredMonths.value.map((m) => ({
    time: monthStartTime(m.key),
    value: m.items.length,
    color: m.items.length ? '#f0b90b' : '#2b3139',
  }))
  barByTime = new Map(filteredMonths.value.map((m) => [monthStartTime(m.key), { key: m.key, label: m.label, count: m.items.length }]))
  histSeries.setData(data)
  const el = document.querySelector('#month-chart')
  const width = (el?.clientWidth || 720) - 8
  const n = Math.max(data.length, 1)
  const spacing = Math.max(18, Math.floor(width / (n + 3)))
  chart.timeScale().applyOptions({ barSpacing: spacing, rightOffset: 3 })
}

function openChart(it) {
  store.chartSymbol = it.symbol
  store.activeTab = 'chart'
}

function topKeyOf(label) {
  const [y, m] = label.split('/')
  return `${y}-${m}`
}

onMounted(async () => {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchListings()
    months.value = data.months
    total.value = data.total
    generatedAt.value = data.generatedAt
  } catch (e) {
    error.value = '数据获取失败：' + e.message
  } finally {
    loading.value = false
  }
  await nextTick()
  initChart()
  renderChart()
})

onBeforeUnmount(() => {
  if (chart) {
    chart.remove()
    chart = null
  }
})

watch(filteredMonths, () => nextTick(renderChart), { deep: true })

watch(
  () => store.activeTab,
  (tab) => {
    if (tab === 'stats' && chart) chart.applyOptions({})
  }
)
</script>

<template>
  <div class="stats">
    <div class="head">
      <h2>币安近 4 年每月上新统计（合约）</h2>
      <span class="note">共 {{ total }} 个（U本位永续，服务器已预计算）</span>
      <span v-if="generatedAt" class="note right">数据更新：{{ new Date(generatedAt).toLocaleString('zh-CN') }}</span>
    </div>

    <div v-if="loading" class="hint">
      <div class="spinner"></div>
      加载中…
    </div>
    <div v-else-if="error" class="hint err">{{ error }}</div>
    <div v-else class="content">
      <div class="cards">
        <div class="card"><div class="num">{{ summary.total }}</div><div class="label">四年总上币</div></div>
        <div class="card"><div class="num">{{ summary.thisYear }}</div><div class="label">{{ thisYearKey }} 年上币</div></div>
        <div class="card"><div class="num">{{ summary.thisMonth }}</div><div class="label">本月上币</div></div>
        <div class="card"><div class="num">{{ summary.last30 }}</div><div class="label">近 30 天上币</div></div>
      </div>

      <div class="search-row">
        <input v-model="search" class="search-input" placeholder="搜索币种，如 NEIRO / BTC / USDC" />
        <span v-if="search.trim()" class="search-note">匹配 {{ matchedTotal }} 个</span>
      </div>
      <div v-if="!filteredMonths.length" class="no-result">没有匹配的币种</div>

      <div class="grid">
        <div class="card wide">
          <h3>每月上币量</h3>
          <div id="month-chart" class="month-chart"></div>
          <div class="axis">点击柱状图查看当月明细，搜索可过滤</div>
          <div v-if="activeMonth" class="month-detail">
            <h4>{{ activeMonth.label }}（{{ activeMonth.items.length }} 个）</h4>
            <div class="tags">
              <span v-for="it in activeMonth.items" :key="it.symbol" class="tag" @click="openChart(it)">
                {{ it.symbol }} <small>{{ String(it.date).slice(0, 10) }}</small>
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>上新高峰 Top 5</h3>
          <ol class="rank">
            <li v-for="(t, i) in topMonths" :key="t.label" :class="{ active: expanded === topKeyOf(t.label) }">
              <span class="idx">{{ i + 1 }}</span>
              <span class="month" @click="expanded = expanded === topKeyOf(t.label) ? null : topKeyOf(t.label)">{{ t.label }}</span>
              <span class="cnt">{{ t.count }} 个</span>
            </li>
          </ol>
        </div>

        <div class="card">
          <h3>年度对比</h3>
          <table class="year-tbl">
            <tbody>
              <tr v-for="[y, c] in yearly" :key="y">
                <td>{{ y }}</td>
                <td class="bar-cell"><div class="year-bar" :style="{ width: Math.max(2, (c / Math.max(...yearly.map((x) => x[1]), 1)) * 100) + '%' }"></div></td>
                <td class="cnt">{{ c }} 个</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
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
  font-size: 13px;
}
.note.right {
  margin-left: auto;
}
.hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #848e9c;
  padding: 40px;
  font-size: 14px;
}
.hint.err {
  color: #f6465d;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #2b3139;
  border-top-color: #f0b90b;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
@media (max-width: 900px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
.cards .card {
  text-align: center;
  padding: 18px 10px;
}
.cards .num {
  font-size: 28px;
  font-weight: 700;
  color: #f0b90b;
}
.cards .label {
  margin-top: 6px;
  color: #848e9c;
  font-size: 12px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1000px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.card.wide {
  grid-column: 1 / -1;
}
.card {
  background: #101417;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 16px;
}
.card.wide {
  min-height: 280px;
}
.card h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #eaecef;
}
.month-chart {
  width: 100%;
  height: 220px;
}
.chart-tooltip {
  position: absolute;
  z-index: 20;
  background: #363a45;
  color: #eaecef;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
}
.axis {
  text-align: center;
  color: #5e6673;
  font-size: 11px;
  margin-top: 6px;
}
.rank {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}
.rank li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-bottom: 1px solid #1e2329;
  font-size: 13px;
}
.rank li.active {
  background: #1e2329;
  border-radius: 4px;
}
.rank .idx {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: #2b3139;
  color: #f0b90b;
  font-size: 11px;
  border-radius: 4px;
}
.rank .month {
  color: #eaecef;
  cursor: pointer;
  flex: 1;
}
.rank .month:hover {
  color: #f0b90b;
}
.rank .cnt {
  color: #848e9c;
  font-size: 12px;
}
.year-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.year-tbl td {
  padding: 4px 0;
  color: #848e9c;
}
.year-tbl .bar-cell {
  width: 60%;
}
.year-bar {
  height: 10px;
  background: linear-gradient(90deg, #f0b90b, #d49a0a);
  border-radius: 3px;
}
.year-tbl .cnt {
  color: #eaecef;
  text-align: right;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.search-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 8px 12px;
  font-size: 14px;
  width: 240px;
  outline: none;
}
.search-input:focus {
  border-color: #f0b90b;
}
.search-note {
  color: #848e9c;
  font-size: 13px;
}
.no-result {
  text-align: center;
  color: #5e6673;
  font-size: 13px;
  padding: 20px 0;
}
.month-detail {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #2b3139;
}
.month-detail h4 {
  color: #eaecef;
  margin: 0 0 8px;
  font-size: 14px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  background: #1e2329;
  border: 1px solid #2b3139;
  color: #eaecef;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: 'SF Mono', Menlo, monospace;
  cursor: pointer;
  transition: all 0.15s;
}
.tag:hover {
  border-color: #f0b90b;
  color: #f0b90b;
}
.tag small {
  color: #848e9c;
  margin-left: 4px;
  font-family: inherit;
}
</style>
