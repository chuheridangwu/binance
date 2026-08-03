<script setup>
import { ref, computed, onMounted } from 'vue'
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

function openChart(it) {
  store.chartSymbol = it.symbol
  store.activeTab = 'chart'
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
})
</script>

<template>
  <div class="stats">
    <div class="head">
      <h2>币安近 2 年每月上新统计（合约）</h2>
      <span class="note">共 {{ total }} 个（U本位永续，服务器已预计算）</span>
    </div>

    <div v-if="loading" class="hint">
      <div class="spinner"></div>
      加载中…
    </div>
    <div v-else-if="error" class="hint err">{{ error }}</div>
    <div v-else class="chart-wrap">
      <div class="search-row">
        <input v-model="search" class="search-input" placeholder="搜索币种，如 NEIRO / BTC / USDC" />
        <span v-if="search.trim()" class="search-note">匹配 {{ matchedTotal }} 个</span>
        <span v-if="generatedAt" class="search-note right">数据更新：{{ new Date(generatedAt).toLocaleString('zh-CN') }}</span>
      </div>
      <div class="bars">
        <div
          v-for="m in filteredMonths"
          :key="m.key"
          class="bar-col"
          @click="expanded = expanded === m.key ? null : m.key"
        >
          <div class="bar-label">{{ m.items.length }}</div>
          <div class="bar" :class="{ empty: m.items.length === 0 }" :style="{ height: Math.max(3, (m.items.length / 40) * 100) + '%' }"></div>
          <div class="bar-key">{{ m.label }}</div>
        </div>
      </div>
      <div v-if="!filteredMonths.length" class="no-result">没有匹配的币种</div>
      <div class="axis">上月 ←→ 24 个月前（点击柱状图查看明细，点击币种跳转行情）</div>

      <div v-for="m in filteredMonths" :key="m.key" class="month-detail">
        <template v-if="expanded === m.key">
          <h4>{{ m.label }}（{{ m.items.length }} 个）</h4>
          <div class="tags">
            <span v-for="it in m.items" :key="it.symbol" class="tag" @click="openChart(it)">
              {{ it.symbol }} <small>{{ String(it.date).slice(0, 10) }}</small>
            </span>
          </div>
        </template>
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
.chart-wrap {
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 20px;
  background: #101417;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
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
.search-note.right {
  margin-left: auto;
}
.no-result {
  text-align: center;
  color: #5e6673;
  font-size: 13px;
  padding: 20px 0;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 220px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  cursor: pointer;
  position: relative;
}
.bar {
  width: 70%;
  background: linear-gradient(180deg, #f0b90b, #d49a0a);
  border-radius: 3px 3px 0 0;
  min-height: 3px;
  transition: filter 0.15s;
}
.bar.empty {
  background: #2b3139;
}
.bar-col:hover .bar {
  filter: brightness(1.2);
}
.bar-label {
  font-size: 12px;
  color: #eaecef;
  margin-bottom: 4px;
}
.bar-key {
  font-size: 11px;
  color: #848e9c;
  margin-top: 6px;
  white-space: nowrap;
}
.axis {
  text-align: center;
  color: #5e6673;
  font-size: 11px;
  margin-top: 8px;
}
.month-detail h4 {
  color: #eaecef;
  margin: 20px 0 8px;
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
