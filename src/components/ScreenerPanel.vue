<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { startScreener, startScreenerStrategies, screenerStatus, fetchScreenerResults } from '../api/monitor'
import { store } from '../store'

const RULES = [
  { id: 'r1', name: 'RSI(6) 一周内 ≥ 80', desc: '近 7 根日K中任意一根 RSI(6) ≥ 80' },
  { id: 'r2', name: '3日内创新高 + RSI 顶背离', desc: '近 3 天价格创 60 天新高，RSI(6) 低于前高时取值' },
  { id: 'r3', name: '价格 ≥ 布林带上轨', desc: '收盘价站上布林带 (20, 2) 上轨' },
  { id: 'r4', name: 'OI 持续增加', desc: '永续未平仓合约量近 5 天逐日上升' },
  { id: 'r5', name: '单日量 > 近7日总和', desc: '最近一根日K成交量大于之前 7 天之和' },
]

const STRATEGIES = [
  { id: 'up', name: '上涨趋势', desc: '多头排列 + 趋势强度 + 量能 + 布林上轨', score: ['MA20>MA50>MA200 (+25)', '价>MA20 (+15)', 'ADX>25 (+15)', 'RSI 50-70 (+15)', '量比>1 (+10)', '贴近/破上轨 (+20)'] },
  { id: 'down', name: '下跌趋势', desc: '空头排列 + 趋势强度 + 量能 + 布林下轨', score: ['MA20<MA50<MA200 (+25)', '价<MA20 (+15)', 'ADX>25 (+15)', 'RSI<40 (+15)', '量比>1 (+10)', '贴近/破下轨 (+20)'] },
  { id: 'top', name: '山顶转折', desc: '超买 + 资金费率 + 布林上轨', score: ['RSI(6)≥80 (+25)', '乖离>10% (+20)', '资金费率>0.05% (+15)', '贴近/破上轨 (+40)'] },
  { id: 'bottom', name: '山底待涨', desc: '超卖 + 资金费率 + 布林下轨', score: ['RSI(6)≤20 (+25)', '乖离<-10% (+20)', '资金费率<-0.05% (+15)', '贴近/破下轨 (+40)'] },
]

const view = ref('up')
const checked = ref({ r1: true, r2: true, r3: true, r4: true, r5: true })
const mode = ref('any')
const month = ref('')
const minScore = ref(60)
const loading = ref(false)
const error = ref('')
const rows = ref([])
const meta = ref(null)
const state = ref(null)
let timer = null

const enabledCount = computed(() => RULES.filter((r) => checked.value[r.id]).length)
const currentStrategy = computed(() => STRATEGIES.find((s) => s.id === view.value))

const progress = computed(() => {
  const s = state.value
  if (!s || !s.total) return null
  const pct = s.total ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0
  return { ...s, pct }
})

async function poll() {
  try {
    state.value = await screenerStatus()
  } catch {}
}

function stopPoll() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function openChart(symbol) {
  store.chartSymbol = symbol
  store.activeTab = 'chart'
}

function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 1000) return v.toFixed(2)
  if (v >= 1) return v.toFixed(4)
  if (v >= 0.0001) return v.toFixed(6)
  return v.toFixed(8)
}

function fmtOi(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  return v.toFixed(0)
}

function fmtRate(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return (v * 100).toFixed(3) + '%'
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Number(v).toFixed(digits)
}

function buildCells(row) {
  const cells = {}
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    cells[id] = { text: '—', hit: false, avail: false }
  }
  for (const rid of row.matched || []) {
    const d = row.detail[rid]
    if (!d) continue
    if (rid === 'r1') {
      cells.r1 = { text: `RSI6 最高 ${Number(d.weekMaxRsi).toFixed(1)}`, hit: true, avail: true }
    } else if (rid === 'r2') {
      cells.r2 = { text: `新高RSI ${Number(d.curRsi).toFixed(1)} < ${Number(d.prevRsi).toFixed(1)}`, hit: true, avail: true }
    } else if (rid === 'r3') {
      cells.r3 = { text: `价 ${fmtPrice(d.price)} ≥ 上轨 ${fmtPrice(d.upper)}`, hit: true, avail: true }
    } else if (rid === 'r4') {
      const list = d.oiList || []
      const last = list.length ? list[list.length - 1] : null
      const trend = list.length >= 2 ? (last > list[0] ? '↑' : last < list[0] ? '↓' : '→') : ''
      cells.r4 = { text: `OI ${fmtOi(last)} ${trend}`, hit: d.hit === true, avail: list.length > 0 }
    } else if (rid === 'r5') {
      cells.r5 = { text: `量比 ${Number(d.ratio).toFixed(1)}x`, hit: true, avail: true }
    }
  }
  return cells
}

const strategyCols = {
  up: [
    { key: 'ma20', label: 'MA20', fmt: (v) => fmtPrice(v) },
    { key: 'ma50', label: 'MA50', fmt: (v) => fmtPrice(v) },
    { key: 'ma200', label: 'MA200', fmt: (v) => fmtPrice(v) },
    { key: 'adx', label: 'ADX', fmt: (v) => fmtNum(v, 1) },
    { key: 'rsi14', label: 'RSI14', fmt: (v) => fmtNum(v, 1) },
    { key: 'dev20', label: '乖离', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%') },
    { key: 'volRatio', label: '量比', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(2) + 'x') },
    { key: 'boll', label: '布林', fmt: (v) => (v === null || v === undefined ? '—' : v) },
  ],
  down: [
    { key: 'ma20', label: 'MA20', fmt: (v) => fmtPrice(v) },
    { key: 'ma50', label: 'MA50', fmt: (v) => fmtPrice(v) },
    { key: 'ma200', label: 'MA200', fmt: (v) => fmtPrice(v) },
    { key: 'adx', label: 'ADX', fmt: (v) => fmtNum(v, 1) },
    { key: 'rsi14', label: 'RSI14', fmt: (v) => fmtNum(v, 1) },
    { key: 'dev20', label: '乖离', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%') },
    { key: 'volRatio', label: '量比', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(2) + 'x') },
    { key: 'boll', label: '布林', fmt: (v) => (v === null || v === undefined ? '—' : v) },
  ],
  top: [
    { key: 'rsi6', label: 'RSI6', fmt: (v) => fmtNum(v, 1) },
    { key: 'dev20', label: '乖离', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%') },
    { key: 'fundingRate', label: '资金费率', fmt: (v) => fmtRate(v) },
    { key: 'boll', label: '布林', fmt: (v) => (v === null || v === undefined ? '—' : v) },
  ],
  bottom: [
    { key: 'rsi6', label: 'RSI6', fmt: (v) => fmtNum(v, 1) },
    { key: 'dev20', label: '乖离', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%') },
    { key: 'fundingRate', label: '资金费率', fmt: (v) => fmtRate(v) },
    { key: 'boll', label: '布林', fmt: (v) => (v === null || v === undefined ? '—' : v) },
  ],
}

function metricVal(r, key) {
  return r.metrics && r.metrics[key] !== undefined && r.metrics[key] !== null ? r.metrics[key] : null
}

function applyRows(list) {
  rows.value = (list || []).map((row) => ({ ...row, cells: buildCells(row) }))
}

async function run() {
  if (loading.value) return
  error.value = ''
  rows.value = []
  meta.value = null
  state.value = { running: true, total: 0, done: 0, found: 0, errors: 0 }
  loading.value = true
  stopPoll()
  timer = setInterval(poll, 1000)
  try {
    let res
    if (view.value === 'rules') {
      res = await startScreener({ ...checked.value }, mode.value, month.value)
    } else {
      res = await startScreenerStrategies([view.value], month.value, minScore.value)
    }
    applyRows(res.results)
    meta.value = res
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
    stopPoll()
    try {
      state.value = await screenerStatus()
    } catch {}
  }
}

onMounted(async () => {
  try {
    const res = await fetchScreenerResults()
    if (res.results && res.results.length) {
      if (res.mode === 'strategies' && res.strategies && res.strategies.length) {
        const first = res.strategies[0]
        view.value = typeof first === 'object' && first ? first.id || 'up' : first || 'up'
      } else if (res.mode === 'rules') view.value = 'rules'
      applyRows(res.results)
    }
    if (res.generatedAt) meta.value = res
  } catch {}
})

onBeforeUnmount(stopPoll)
</script>

<template>
  <div class="screen">
    <div class="head">
      <h2>指标选股（全量 USDT 永续合约）</h2>
      <button class="btn" :disabled="loading || (view === 'rules' && enabledCount === 0)" @click="run">
        {{ loading ? '扫描中…' : '开始扫描' }}
      </button>
    </div>

    <div class="strat-tabs">
      <button
        v-for="s in STRATEGIES"
        :key="s.id"
        :class="{ active: view === s.id }"
        :disabled="loading"
        @click="view = s.id"
      >
        {{ s.name }}
      </button>
      <button :class="{ active: view === 'rules' }" :disabled="loading" @click="view = 'rules'">规则扫描</button>
    </div>

    <div v-if="currentStrategy" class="strat-desc">
      <b>{{ currentStrategy.name }}</b>
      <span>{{ currentStrategy.desc }}</span>
      <div class="score-break">
        <span v-for="(pt, i) in currentStrategy.score" :key="i">{{ pt }}</span>
      </div>
    </div>

    <div v-if="view === 'rules'" class="rules">
      <div v-for="r in RULES" :key="r.id" class="rule">
        <label class="check">
          <input v-model="checked[r.id]" type="checkbox" :disabled="loading" />
          <b>{{ r.name }}</b>
        </label>
        <span class="desc">{{ r.desc }}</span>
      </div>
    </div>

    <div class="ctrl-row">
      <template v-if="view === 'rules'">
        <span class="mode-label">匹配逻辑：</span>
        <div class="seg">
          <button :class="{ active: mode === 'any' }" :disabled="loading" @click="mode = 'any'">任一满足</button>
          <button :class="{ active: mode === 'all' }" :disabled="loading" @click="mode = 'all'">全部满足</button>
        </div>
      </template>
      <template v-else>
        <span class="mode-label">最低评分：</span>
        <input v-model.number="minScore" type="number" min="0" max="100" class="score-input" :disabled="loading" />
      </template>
      <span class="mode-label">上架月份：</span>
      <input v-model="month" type="month" class="month-input" :disabled="loading" title="仅筛选在指定月份于币安上架的合约，留空则不限制" />
      <button v-if="month" class="clear-btn" :disabled="loading" @click="month = ''">清空</button>
      <span class="note">
        <template v-if="view === 'rules'">已勾选 {{ enabledCount }} 个规则 · 全量约 400+ 合约，为防 IP 限流已强制降速，首次约需 2-4 分钟；选择上架月份后只扫描该月上架的合约</template>
        <template v-else>{{ currentStrategy ? currentStrategy.name : '' }}：趋势策略仅用已缓存日K（零新增请求）；转折策略先按 RSI/乖离初筛候选池，再对候选拉取费率/布林，全量约需 1-2 分钟</template>
      </span>
      <span v-if="meta" class="note right">最近扫描 {{ new Date(meta.generatedAt).toLocaleString('zh-CN') }}，命中 {{ rows.length }} 个<span v-if="meta.month">（上架 {{ meta.month }}）</span></span>
    </div>

    <div v-if="progress && loading" class="progress">
      <div class="progress-bar"><div class="progress-fill" :style="{ width: progress.pct + '%' }"></div></div>
      <span class="note">
        扫描中 {{ progress.done }}/{{ progress.total }}（{{ progress.pct }}%）· 已命中 {{ progress.found }}
        <template v-if="progress.errors">· 失败 {{ progress.errors }}</template>
      </span>
    </div>

    <div v-if="error" class="hint err">{{ error }}</div>
    <div v-else-if="!loading && !rows.length && meta" class="hint">没有符合条件的币</div>
    <div v-else-if="!loading && !rows.length && !meta" class="hint">点「开始扫描」筛选全市场</div>

    <div v-else-if="rows.length" class="table-wrap">
      <table class="tbl">
        <thead>
          <tr v-if="view === 'rules'">
            <th>币种</th>
            <th>上架</th>
            <th v-for="r in RULES" :key="r.id" :class="{ off: !checked[r.id] }" :title="r.desc">{{ r.name }}</th>
          </tr>
          <tr v-else>
            <th>币种</th>
            <th>评分</th>
            <th>信号</th>
            <th v-for="c in strategyCols[view]" :key="c.key">{{ c.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="view === 'rules'" v-for="r in rows" :key="r.symbol" @click="openChart(r.symbol)">
            <td class="sym">
              {{ r.symbol }}
              <span class="price-sub">{{ fmtPrice(r.price) }}</span>
            </td>
            <td class="listed">{{ r.listed || '—' }}</td>
            <td v-for="rule in RULES" :key="rule.id">
              <template v-if="r.cells[rule.id].avail">
                <b :class="r.cells[rule.id].hit ? 'up' : 'norm'">{{ r.cells[rule.id].text }}</b>
              </template>
              <template v-else>—</template>
            </td>
          </tr>
          <tr v-for="r in rows" v-else :key="r.symbol" @click="openChart(r.symbol)">
            <td class="sym">
              {{ r.symbol }}
              <span class="price-sub">{{ fmtPrice(r.price) }}</span>
            </td>
            <td><b class="score">{{ r.score }}</b></td>
            <td>
              <span v-for="(s, i) in (r.signals || [])" :key="i" class="tag">{{ s }}</span>
            </td>
            <td v-for="c in strategyCols[view]" :key="c.key">{{ c.fmt(metricVal(r, c.key)) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="tips">
        <template v-if="view === 'rules'">点击行跳转行情图表。绿色列=命中规则；OI 列显示最近 5 天的末值并带涨跌箭头（绿色=命中「持续增加」）；「—」表示该规则未勾选或无数据。已内置币安限流保护：低并发+请求间隔+429/418 自动退避；K线/OI 缓存 1 小时并落盘（重启不丢），重复扫描直接复用、几乎零 API 消耗。</template>
        <template v-else>点击行跳转行情图表。评分为 0-100 权重制，仅保留达到最低评分的合约，按评分降序排列。信号标签说明命中的子条件。布林列：「贴近上/下轨」指现价处于布林带区间顶/底 10% 内，「破上/下轨(近7日)」指近一周内收盘价越出过上/下轨。反转策略的资金费率来自币安批量接口（缺失显示 —），若线上字段结构与预期不符请告知。</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screen {
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
.strat-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.strat-tabs button {
  background: #161a1e;
  border: 1px solid #2b3139;
  color: #848e9c;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.strat-tabs button.active {
  background: #f0b90b;
  border-color: #f0b90b;
  color: #0b0e11;
  font-weight: 600;
}
.strat-tabs button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.strat-desc {
  background: #161a1e;
  border: 1px solid #2b3139;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  color: #eaecef;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.strat-desc b {
  color: #f0b90b;
}
.score-break {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  color: #848e9c;
  font-size: 12px;
}
.rules {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 12px 14px;
  background: #161a1e;
  border: 1px solid #2b3139;
  border-radius: 8px;
  margin-bottom: 12px;
}
.rule {
  display: flex;
  align-items: center;
  gap: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #eaecef;
  cursor: pointer;
  white-space: nowrap;
}
.check input {
  accent-color: #f0b90b;
}
.desc {
  color: #848e9c;
  font-size: 12px;
}
.ctrl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.mode-label {
  color: #848e9c;
  font-size: 13px;
}
.seg {
  display: flex;
  background: #1e2329;
  border-radius: 6px;
  padding: 3px;
}
.seg button {
  border: none;
  background: transparent;
  color: #848e9c;
  font-size: 13px;
  padding: 5px 14px;
  border-radius: 4px;
  cursor: pointer;
}
.seg button.active {
  background: #2b3139;
  color: #f0b90b;
  font-weight: 600;
}
.seg button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.note {
  color: #848e9c;
  font-size: 12px;
}
.month-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 4px 8px;
  font-size: 13px;
  color-scheme: dark;
}
.month-input:focus {
  border-color: #f0b90b;
  outline: none;
}
.month-input:disabled {
  opacity: 0.6;
}
.score-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 4px 8px;
  font-size: 13px;
  width: 64px;
  color-scheme: dark;
}
.score-input:focus {
  border-color: #f0b90b;
  outline: none;
}
.score-input:disabled {
  opacity: 0.6;
}
.clear-btn {
  background: transparent;
  border: 1px solid #2b3139;
  color: #848e9c;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.clear-btn:hover {
  color: #f0b90b;
  border-color: #f0b90b;
}
.clear-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.note.right {
  margin-left: auto;
}
.progress {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.progress-bar {
  flex: 1;
  height: 8px;
  background: #1e2329;
  border-radius: 4px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: #f0b90b;
  transition: width 0.4s;
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
  text-align: left;
  padding: 10px 12px;
  color: #848e9c;
  font-weight: 500;
  font-size: 12px;
  background: #161a1e;
  border-bottom: 1px solid #2b3139;
}
.tbl th.off {
  color: #3e4550;
}
.tbl td {
  padding: 9px 12px;
  color: #eaecef;
  border-bottom: 1px solid #1e2329;
  white-space: nowrap;
}
.tbl tbody tr {
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
.price-sub {
  display: block;
  color: #848e9c;
  font-weight: 400;
  font-size: 12px;
  font-family: 'SF Mono', Menlo, monospace;
}
.score {
  color: #f0b90b;
  font-size: 15px;
}
.tag {
  display: inline-block;
  background: #1e2329;
  border: 1px solid #2b3139;
  color: #f0b90b;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  margin-right: 4px;
}
.up {
  color: #0ecb81;
}
.norm {
  color: #eaecef;
  font-weight: 400;
}
.tips {
  padding: 8px 12px;
  color: #5e6673;
  font-size: 12px;
}
</style>
