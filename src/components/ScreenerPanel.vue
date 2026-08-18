<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { startScreener, startScreenerStrategies, screenerStatus, fetchScreenerResults, fetchTrackers, createTracker, deleteTracker, fetchMutes, addMute, removeMute } from '../api/monitor'
import { store } from '../store'

const RULES = [
  { id: 'r1', name: 'RSI(6) 近N日 ≥ 80', desc: '近 N 根日K中任意一根 RSI(6) ≥ 80', param: { name: 'N', min: 3, max: 10, def: 7 } },
  { id: 'r2', name: 'N日内创新高 + RSI 顶背离', desc: '近 N 天价格创 60 天新高，RSI(6) 低于前高时取值', param: { name: 'N', min: 3, max: 10, def: 3 } },
  { id: 'r3', name: '价格 ≥ 布林带上轨', desc: '收盘价站上布林带 (20, 2) 上轨' },
  { id: 'r4', name: '当日 OI > 前N日总和', desc: '当日未平仓合约量大于之前 N 天 OI 之和', param: { name: 'N', min: 3, max: 7, def: 5 } },
  { id: 'r5', name: '单日量 > 前N日总和', desc: '最近一根日K成交量大于之前 N 天成交量之和', param: { name: 'N', min: 3, max: 7, def: 3 } },
  { id: 'r6', name: 'N日内新高 + RSI 顶背离(差≥10)', desc: '近 N 天创新高，且新高处 RSI(6) 比此前另一高点 RSI(6) 低至少 10', param: { name: 'N', min: 10, max: 90, def: 30 } },
]

const STRATEGIES = [
  { id: 'up', name: '上涨趋势', desc: '多头排列 + 趋势强度 + 量能 + 布林上轨', score: ['MA20>MA50>MA200 (+25)', '价>MA20 (+15)', 'ADX>25 (+15)', 'RSI 50-70 (+15)', '量比>1 (+10)', '贴近/破上轨 (+20)'] },
  { id: 'down', name: '下跌趋势', desc: '空头排列 + 趋势强度 + 量能 + 布林下轨', score: ['MA20<MA50<MA200 (+25)', '价<MA20 (+15)', 'ADX>25 (+15)', 'RSI<40 (+15)', '量比>1 (+10)', '贴近/破下轨 (+20)'] },
  { id: 'top', name: '山顶转折', desc: '超买 + 资金费率 + 布林上轨', score: ['RSI(6)≥80 (+25)', '乖离>10% (+20)', '资金费率>0.05% (+15)', '贴近/破上轨 (+40)'] },
  { id: 'bottom', name: '山底待涨', desc: '可勾选条件（超卖/乖离/费率/下轨/缩幅），支持任一/全部匹配', score: ['RSI(6)≤30', '乖离≤-8%', '资金费率≤-0.01%', '贴近/破下轨', 'N日高低差≤阈值（可选天数）'] },
]

// 山底待涨的可勾选条件（每个的开关 + 匹配任一/全部）
const BOTTOM_CONDITIONS = [
  { id: 'rsi', name: '超卖 RSI(6) ≤ 30' },
  { id: 'dev', name: '乖离 ≤ -8%' },
  { id: 'funding', name: '资金费率为负' },
  { id: 'boll', name: '贴近/破布林下轨' },
  { id: 'range', name: 'N日高低差 ≤ 30%', days: true },
]

const view = ref('up')
const checked = ref({ r1: true, r2: true, r3: true, r4: true, r5: true, r6: true })
const params = ref({ r1: 7, r2: 3, r4: 5, r5: 3, r6: 30 })
const mode = ref('any')
const month = ref('')
const minScore = ref(60)
const bottomConds = ref({ rsi: true, dev: true, funding: true, boll: true, range: false })
const bottomMode = ref('any')
const rangeDays = ref(15)
const rangePct = ref(30)
const loading = ref(false)
const error = ref('')
const rows = ref([])
const meta = ref(null)
const state = ref(null)
const trackers = ref([])
const mutes = ref([])
const trackTarget = ref(null)
const trackForm = ref({ direction: 'up', price: '', expire: '' })
const trackSaving = ref(false)
const trackError = ref('')
let timer = null

const enabledCount = computed(() => RULES.filter((r) => checked.value[r.id]).length)
const bottomEnabledCount = computed(() => Object.values(bottomConds.value).filter(Boolean).length)
const currentStrategy = computed(() => STRATEGIES.find((s) => s.id === view.value))

function ruleTitle(r) {
  if (!r.param) return r.name
  return r.name.replace(/N/g, String(params.value[r.id]))
}

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
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
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
      const prevSum = d.prevSum
      cells.r4 = {
        text: prevSum !== null ? `OI ${fmtOi(last)} > ${fmtOi(prevSum)}` : `OI ${fmtOi(last)}`,
        hit: d.hit === true,
        avail: list.length > 0,
      }
    } else if (rid === 'r5') {
      cells.r5 = { text: `量比 ${Number(d.ratio).toFixed(1)}x`, hit: true, avail: true }
    } else if (rid === 'r6') {
      cells.r6 = { text: `新高RSI ${Number(d.curRsi).toFixed(1)} < ${Number(d.prevRsi).toFixed(1)}（差${Number(d.diff).toFixed(1)}）`, hit: true, avail: true }
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
    { key: 'rangePct', label: '高低差', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%') },
  ],
}

function metricVal(r, key) {
  return r.metrics && r.metrics[key] !== undefined && r.metrics[key] !== null ? r.metrics[key] : null
}

function applyRows(list) {
  rows.value = (list || []).map((row) => ({ ...row, cells: buildCells(row), muted: !!muteSet.value.has(row.symbol) }))
  sortRows()
}

const muteSet = computed(() => new Set(mutes.value.map((m) => m.symbol)))

function sortRows() {
  rows.value.sort((a, b) => {
    if (!!a.muted !== !!b.muted) return a.muted ? 1 : -1
    if (view.value === 'rules') {
      const ac = (a.matched || []).length
      const bc = (b.matched || []).length
      if (bc !== ac) return bc - ac
      return (b.rsi6 ?? -1) - (a.rsi6 ?? -1)
    }
    return (b.score || 0) - (a.score || 0)
  })
}

async function toggleMute(row) {
  if (row.muted) {
    try {
      await removeMute(row.symbol)
      mutes.value = mutes.value.filter((m) => m.symbol !== row.symbol)
    } catch {}
  } else {
    try {
      await addMute(row.symbol)
      mutes.value.push({ symbol: row.symbol, created_at: Date.now() })
    } catch (e) {
      error.value = e.message
      return
    }
  }
  row.muted = !row.muted
  sortRows()
}

function muteStatus(sym) {
  const m = mutes.value.find((x) => x.symbol === sym)
  return m ? { muted: true, until: m.created_at + 7 * 24 * 60 * 60 * 1000 } : { muted: false }
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
      res = await startScreener({ ...checked.value }, mode.value, month.value, params.value)
    } else if (view.value === 'bottom') {
      res = await startScreenerStrategies(
        [view.value],
        month.value,
        minScore.value,
        { bottom: { conditions: { ...bottomConds.value }, mode: bottomMode.value, rangeDays: rangeDays.value, rangePct: rangePct.value } }
      )
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

async function loadTrackers() {
  try {
    const res = await fetchTrackers()
    trackers.value = res.trackers || []
  } catch {}
}

function openTrack(row) {
  trackError.value = ''
  trackForm.value = { direction: 'up', price: String(row.price), expire: '' }
  trackTarget.value = row
}

async function saveTracker() {
  if (trackSaving.value) return
  const t = trackTarget.value
  if (!t) return
  const price = Number(trackForm.value.price)
  const expire = trackForm.value.expire
  if (!Number.isFinite(price) || price <= 0) {
    trackError.value = '请输入有效的目标价'
    return
  }
  if (!expire) {
    trackError.value = '请选择截止时间'
    return
  }
  const expireTs = new Date(expire).getTime()
  if (!Number.isFinite(expireTs) || expireTs <= Date.now()) {
    trackError.value = '截止时间必须晚于当前时间'
    return
  }
  trackSaving.value = true
  try {
    await createTracker({
      symbol: t.symbol,
      direction: trackForm.value.direction,
      target_price: price,
      expire_at: expireTs,
    })
    trackTarget.value = null
    await loadTrackers()
  } catch (e) {
    trackError.value = e.message || '保存失败'
  } finally {
    trackSaving.value = false
  }
}

async function removeTracker(id) {
  try {
    await deleteTracker(id)
    trackers.value = trackers.value.filter((t) => t.id !== id)
  } catch {}
}

function trackerStatus(t) {
  if (t.notified === 1) return { text: '已触发', cls: 'hit' }
  if (t.notified === 2) return { text: '已过期', cls: 'expired' }
  return { text: '追踪中', cls: 'active' }
}

function fmtExpire(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

async function loadMutes() {
  try {
    const res = await fetchMutes()
    mutes.value = res.mutes || []
    applyRows(rows.value)
  } catch {}
}

onMounted(async () => {
  loadTrackers()
  await loadMutes()
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
      <button class="btn" :disabled="loading || (view === 'rules' && enabledCount === 0) || (view === 'bottom' && bottomEnabledCount === 0)" @click="run">
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
          <b>{{ ruleTitle(r) }}</b>
        </label>
        <template v-if="r.param">
          <input
            v-model.number="params[r.id]"
            type="number"
            class="param-input"
            :min="r.param.min"
            :max="r.param.max"
            :disabled="loading || !checked[r.id]"
            :title="`${r.param.name} 范围 ${r.param.min}-${r.param.max}，默认 ${r.param.def}`"
          />
        </template>
        <span class="desc">{{ r.desc }}</span>
      </div>
    </div>

    <div v-if="view === 'bottom'" class="rules">
      <span class="rule-title">山底待涨条件</span>
      <div v-for="c in BOTTOM_CONDITIONS" :key="c.id" class="rule">
        <label class="check">
          <input v-model="bottomConds[c.id]" type="checkbox" :disabled="loading" />
          <b>{{ c.name }}</b>
        </label>
        <template v-if="c.days && bottomConds[c.id]">
          <select v-model.number="rangeDays" class="param-input" :disabled="loading" title="缩幅统计天数">
            <option :value="15">15 日</option>
            <option :value="60">60 日</option>
            <option :value="120">120 日</option>
          </select>
          <select v-model.number="rangePct" class="param-input" :disabled="loading" title="最高与最低价差阈值">
            <option :value="20">≤20%</option>
            <option :value="30">≤30%</option>
            <option :value="40">≤40%</option>
          </select>
        </template>
      </div>
      <span class="desc">N日高低差 = 最近 N 天最高价与最低价之差 ÷ 最低价；缩幅条件可选天数（15/60/120）与阈值（20%/30%/40%）</span>
    </div>

    <div class="ctrl-row">
      <template v-if="view === 'rules'">
        <span class="mode-label">匹配逻辑：</span>
        <div class="seg">
          <button :class="{ active: mode === 'any' }" :disabled="loading" @click="mode = 'any'">任一满足</button>
          <button :class="{ active: mode === 'all' }" :disabled="loading" @click="mode = 'all'">全部满足</button>
        </div>
      </template>
      <template v-else-if="view === 'bottom'">
        <span class="mode-label">匹配逻辑：</span>
        <div class="seg">
          <button :class="{ active: bottomMode === 'any' }" :disabled="loading" @click="bottomMode = 'any'">任一满足</button>
          <button :class="{ active: bottomMode === 'all' }" :disabled="loading" @click="bottomMode = 'all'">全部满足</button>
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
        <template v-else-if="view === 'bottom'">{{ currentStrategy.name }}：已勾选 {{ bottomEnabledCount }} 个条件，按「{{ bottomMode === 'all' ? '全部满足' : '任一满足' }}」筛选；「高低差」列显示缩幅条件实际值，勾选缩幅项后可用天数/阈值下拉</template>
        <template v-else>{{ currentStrategy ? currentStrategy.name : '' }}：仅用已缓存日K（零新增请求）；按最低评分筛选，全量约需 1-2 分钟</template>
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
            <th v-for="r in RULES" :key="r.id" :class="{ off: !checked[r.id] }" :title="r.desc">{{ ruleTitle(r) }}</th>
            <th>操作</th>
          </tr>
          <tr v-else>
            <th>币种</th>
            <th>上架</th>
            <th>评分</th>
            <th>信号</th>
            <th v-for="c in strategyCols[view]" :key="c.key">{{ c.label }}</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="view === 'rules'" v-for="r in rows" :key="r.symbol" :class="{ 'row-muted': r.muted }" @click="openChart(r.symbol)">
            <td class="sym">
              {{ r.symbol }}
              <span class="price-sub">价 {{ fmtPrice(r.price) }} · RSI6 {{ r.rsi6 !== null && r.rsi6 !== undefined ? r.rsi6.toFixed(1) : '—' }}</span>
            </td>
            <td class="listed">{{ r.listed || '—' }}</td>
            <td v-for="rule in RULES" :key="rule.id">
              <template v-if="r.cells[rule.id].avail">
                <b :class="r.cells[rule.id].hit ? 'up' : 'norm'">{{ r.cells[rule.id].text }}</b>
              </template>
              <template v-else>—</template>
            </td>
            <td class="track-cell" @click.stop>
              <button v-if="r.muted" class="mute-badge" :title="'不追踪标记，一周内（至 ' + fmtExpire(muteStatus(r.symbol).until) + '）有效，点击取消'" @click="toggleMute(r)">🚫 不追踪</button>
              <template v-else>
                <button class="track-btn" @click="openTrack(r)">追踪</button>
                <button class="mute-btn" @click="toggleMute(r)">不追踪</button>
              </template>
            </td>
          </tr>
          <tr v-for="r in rows" v-else :key="r.symbol" :class="{ 'row-muted': r.muted }" @click="openChart(r.symbol)">
            <td class="sym">
              {{ r.symbol }}
              <span class="price-sub">价 {{ fmtPrice(r.price) }}<template v-if="r.rsi6 !== null && r.rsi6 !== undefined"> · RSI6 {{ r.rsi6.toFixed(1) }}</template></span>
            </td>
            <td class="listed">{{ r.listed || '—' }}</td>
            <td><b class="score">{{ r.score }}</b></td>
            <td>
              <span v-for="(s, i) in (r.signals || [])" :key="i" class="tag">{{ s }}</span>
            </td>
            <td v-for="c in strategyCols[view]" :key="c.key">{{ c.fmt(metricVal(r, c.key)) }}</td>
            <td class="track-cell" @click.stop>
              <button v-if="r.muted" class="mute-badge" :title="'不追踪标记，一周内（至 ' + fmtExpire(muteStatus(r.symbol).until) + '）有效，点击取消'" @click="toggleMute(r)">🚫 不追踪</button>
              <template v-else>
                <button class="track-btn" @click="openTrack(r)">追踪</button>
                <button class="mute-btn" @click="toggleMute(r)">不追踪</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="tips">
        <template v-if="view === 'rules'">点击行跳转行情图表。绿色列=命中规则；OI 列显示当日 OI > 前 N 日总和；「—」表示该规则未勾选或无数据。每条规则旁的 N 输入框可调整天数（R1/R2: 3-10，R4/R5: 3-7），列表标题随所选天数实时变化。「追踪」可对命中合约设置目标价+截止时间，达到后自动邮件提醒。「不追踪」给币打上标记：标记一周内有效，再次扫描时该币显示 🚫 并排在列表最下方（自动扫描邮件同样排最下），点击 🚫 可取消。排序规则：命中规则多的靠前，命中数相同的按 RSI6 从高到低。「RSI6」为当前最新 RSI(6) 值。已内置币安限流保护：低并发+请求间隔+429/418 自动退避；K线/OI 缓存 1 小时并落盘（重启不丢），重复扫描直接复用、几乎零 API 消耗。</template>
        <template v-else>点击行跳转行情图表。评分为 0-100 权重制，仅保留达到最低评分的合约，按评分降序排列。信号标签说明命中的子条件。布林列：「贴近上/下轨」指现价处于布林带区间顶/底 10% 内，「破上/下轨(近7日)」指近一周内收盘价越出过上/下轨。上架列为该币在币安永续的上架月份（未入库显示 —）。「追踪」可设置目标价+截止时间，达到后自动邮件提醒；「不追踪」标记一周内有效，标记后该币 🚫 排在最下方（自动扫描邮件同样排最下），点击 🚫 可取消。反转策略的资金费率来自币安批量接口（缺失显示 —），若线上字段结构与预期不符请告知。</template>
      </div>
    </div>

    <div v-if="trackers.length" class="tracker-list">
      <h3>持续追踪 <span class="note">（达到目标价后自动邮件提醒）</span></h3>
      <div v-for="t in trackers" :key="t.id" class="tracker-row">
        <span class="tsym">{{ t.symbol }}</span>
        <span class="tdir" :class="t.direction === 'up' ? 'up' : 'down'">{{ t.direction === 'up' ? '价≥' : '价≤' }}</span>
        <span class="tprice">{{ fmtPrice(t.target_price) }}</span>
        <span class="texp">截止 {{ fmtExpire(t.expire_at) }}</span>
        <span class="tstatus" :class="trackerStatus(t).cls">{{ trackerStatus(t).text }}</span>
        <button class="track-del" @click="removeTracker(t.id)">删除</button>
      </div>
    </div>

    <div v-if="trackTarget" class="modal-mask" @click.self="trackTarget = null">
      <div class="modal">
        <h3>持续追踪 {{ trackTarget.symbol }}</h3>
        <div class="modal-row">
          <span class="mode-label">方向：</span>
          <div class="seg">
            <button :class="{ active: trackForm.direction === 'up' }" @click="trackForm.direction = 'up'">向上（价 ≥ 目标）</button>
            <button :class="{ active: trackForm.direction === 'down' }" @click="trackForm.direction = 'down'">向下（价 ≤ 目标）</button>
          </div>
        </div>
        <div class="modal-row">
          <span class="mode-label">目标价：</span>
          <input v-model="trackForm.price" type="number" step="any" class="score-input wide" :placeholder="String(trackTarget.price)" />
          <span class="note">当前价 {{ fmtPrice(trackTarget.price) }}</span>
        </div>
        <div class="modal-row">
          <span class="mode-label">截止时间：</span>
          <input v-model="trackForm.expire" type="datetime-local" class="month-input" />
        </div>
        <div v-if="trackError" class="hint err small">{{ trackError }}</div>
        <div class="modal-actions">
          <button class="btn ghost" @click="trackTarget = null">取消</button>
          <button class="btn" :disabled="trackSaving" @click="saveTracker">{{ trackSaving ? '保存中…' : '保存并追踪' }}</button>
        </div>
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
.rule-title {
  color: #f0b90b;
  font-size: 13px;
  font-weight: 600;
  padding-right: 6px;
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
.param-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 3px 6px;
  font-size: 13px;
  width: 56px;
  color-scheme: dark;
}
.param-input:focus {
  border-color: #f0b90b;
  outline: none;
}
.param-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.track-btn {
  background: transparent;
  border: 1px solid #f0b90b;
  color: #f0b90b;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.track-btn:hover {
  background: #f0b90b;
  color: #0b0e11;
}
.mute-btn {
  background: transparent;
  border: 1px solid #2b3139;
  color: #848e9c;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-left: 4px;
}
.mute-btn:hover {
  color: #f6465d;
  border-color: #f6465d;
}
.mute-badge {
  background: transparent;
  border: 1px solid #5e6673;
  color: #848e9c;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mute-badge:hover {
  color: #f6465d;
  border-color: #f6465d;
}
.row-muted td {
  opacity: 0.55;
}
.tracker-list {
  margin-top: 14px;
  border: 1px solid #2b3139;
  border-radius: 8px;
  background: #101417;
  padding: 12px 14px;
}
.tracker-list h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #eaecef;
}
.tracker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #1e2329;
  font-size: 13px;
}
.tracker-row:last-child {
  border-bottom: none;
}
.tsym {
  color: #f0b90b;
  font-weight: 600;
  width: 90px;
}
.tdir.up {
  color: #0ecb81;
}
.tdir.down {
  color: #f6465d;
}
.tprice {
  color: #eaecef;
  font-family: 'SF Mono', Menlo, monospace;
  min-width: 90px;
}
.texp {
  color: #848e9c;
  font-size: 12px;
}
.tstatus {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 4px;
}
.tstatus.active {
  background: #1e2329;
  color: #f0b90b;
}
.tstatus.hit {
  background: #143a2a;
  color: #0ecb81;
}
.tstatus.expired {
  background: #2b2026;
  color: #848e9c;
}
.track-del {
  margin-left: auto;
  background: transparent;
  border: 1px solid #2b3139;
  color: #848e9c;
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.track-del:hover {
  color: #f6465d;
  border-color: #f6465d;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #161a1e;
  border: 1px solid #2b3139;
  border-radius: 10px;
  padding: 18px 20px;
  width: 420px;
  max-width: 92vw;
  color: #eaecef;
}
.modal h3 {
  margin: 0 0 14px;
  font-size: 15px;
}
.modal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.score-input.wide {
  width: 140px;
}
.hint.small {
  padding: 6px 0;
  font-size: 13px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}
.btn.ghost {
  background: transparent;
  border: 1px solid #2b3139;
  color: #848e9c;
}
.btn.ghost:hover {
  color: #eaecef;
  border-color: #eaecef;
}
</style>
