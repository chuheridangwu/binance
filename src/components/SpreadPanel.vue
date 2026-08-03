<script setup>
import { ref, computed, onMounted } from 'vue'
import { fetchSpread } from '../api/monitor'
import { store } from '../store'

const DEFAULT_WATCH = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT', 'DOTUSDT', 'TRXUSDT',
]

const watchlist = ref(DEFAULT_WATCH.join(', '))
const rows = ref([])
const loading = ref(false)
const error = ref('')
const time = ref(null)

const maxAnnualized = computed(() => Math.max(...rows.value.map((r) => Math.abs(r.annualized)), 0))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const syms = watchlist.value.split(/[,，\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    const data = await fetchSpread(syms.length ? syms : DEFAULT_WATCH)
    rows.value = data.rows
    time.value = data.time
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openChart(symbol) {
  store.chartSymbol = symbol
  store.activeTab = 'chart'
}

function fmtPrice(v) {
  if (v === null || v === undefined) return '—'
  if (v >= 1000) return v.toFixed(2)
  if (v >= 1) return v.toFixed(4)
  return v.toFixed(6)
}

function fmtTime(ts) {
  if (!ts) return '—'
  const t = new Date(ts)
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}

function heat(pct) {
  if (pct === null || pct === undefined) return ''
  const a = Math.abs(pct) / Math.max(maxAnnualized.value, 1)
  if (a > 0.66) return 'hot'
  if (a > 0.33) return 'warm'
  return ''
}

onMounted(load)
</script>

<template>
  <div class="spread">
    <div class="head">
      <h2>套利监控（永续/现货价差 + 资金费率）</h2>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
    </div>

    <div class="ctrl-row">
      <label>监控交易对（逗号分隔，最多 40 个）
        <input v-model="watchlist" class="watch-input" placeholder="如 BTCUSDT, ETHUSDT, SOLUSDT" @keyup.enter="load" />
      </label>
      <span class="note">按年化资金费率绝对值排序</span>
      <span v-if="time" class="note right">更新于 {{ new Date(time).toLocaleTimeString('zh-CN') }}</span>
    </div>

    <div v-if="loading" class="hint">加载中…</div>
    <div v-else-if="error" class="hint err">{{ error }}</div>
    <div v-else-if="!rows.length" class="hint">没有数据</div>
    <div v-else class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>币种</th>
            <th>现货价</th>
            <th>永续价</th>
            <th>永续溢价%</th>
            <th>资金费率%</th>
            <th>年化资金费率%</th>
            <th>下次结算</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.symbol" @click="openChart(r.symbol)">
            <td class="sym">{{ r.symbol }}</td>
            <td>{{ fmtPrice(r.spotPrice) }}</td>
            <td>{{ fmtPrice(r.futuresPrice) }}</td>
            <td :class="r.premiumPct === null ? '' : r.premiumPct >= 0 ? 'up' : 'down'">
              {{ r.premiumPct === null ? '—' : (r.premiumPct >= 0 ? '+' : '') + r.premiumPct }}
            </td>
            <td :class="r.fundingRate >= 0 ? 'up' : 'down'">{{ r.fundingRate }}</td>
            <td class="annual" :class="[r.annualized >= 0 ? 'up' : 'down', heat(r.annualized)]">
              {{ r.annualized >= 0 ? '+' : '' }}{{ r.annualized }}
            </td>
            <td class="time">{{ fmtTime(r.nextFundingTime) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="tips">正数=多头付空头费用（资金费率为正）；年化 = 资金费率 × 3 × 365。点击行跳转行情图表。</div>
    </div>
  </div>
</template>

<style scoped>
.spread {
  background: #0b0e11;
}
.head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
}
.head h2 {
  font-size: 18px;
  margin: 0;
  color: #eaecef;
}
.btn {
  background: #f0b90b;
  color: #0b0e11;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  padding: 7px 16px;
  font-size: 14px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ctrl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.ctrl-row label {
  color: #848e9c;
  font-size: 13px;
}
.watch-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 7px 10px;
  font-size: 13px;
  width: 380px;
  margin-left: 8px;
  outline: none;
}
.watch-input:focus {
  border-color: #f0b90b;
}
.note {
  color: #848e9c;
  font-size: 12px;
}
.note.right {
  margin-left: auto;
}
.hint {
  text-align: center;
  color: #848e9c;
  padding: 40px;
  font-size: 14px;
}
.hint.err {
  color: #f6465d;
}
.table-wrap {
  border: 1px solid #2b3139;
  border-radius: 8px;
  overflow: hidden;
  background: #101417;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th {
  text-align: right;
  padding: 10px 12px;
  color: #848e9c;
  font-weight: 500;
  font-size: 12px;
  background: #161a1e;
  border-bottom: 1px solid #2b3139;
}
.tbl th:first-child {
  text-align: left;
}
.tbl td {
  padding: 9px 12px;
  text-align: right;
  color: #eaecef;
  border-bottom: 1px solid #1e2329;
  font-family: 'SF Mono', Menlo, monospace;
  white-space: nowrap;
}
.tbl tbody tr {
  cursor: pointer;
}
.tbl tbody tr:hover {
  background: #1e2329;
}
.tbl td:first-child {
  text-align: left;
}
.sym {
  color: #f0b90b;
  font-weight: 600;
}
.up {
  color: #0ecb81;
}
.down {
  color: #f6465d;
}
.annual {
  font-weight: 700;
}
.annual.hot {
  background: rgba(246, 70, 93, 0.15);
}
.annual.warm {
  background: rgba(246, 70, 93, 0.08);
}
.time {
  color: #848e9c;
  font-size: 12px;
}
.tips {
  padding: 8px 12px;
  color: #5e6673;
  font-size: 12px;
}
</style>
