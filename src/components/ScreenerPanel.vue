<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { startScreener, screenerStatus, fetchScreenerResults } from '../api/monitor'
import { store } from '../store'

const RULES = [
  { id: 'r1', name: 'RSI(6) 一周内 ≥ 80', desc: '近 7 根日K中任意一根 RSI(6) ≥ 80' },
  { id: 'r2', name: '3日内创新高 + RSI 顶背离', desc: '近 3 天价格创 60 天新高，RSI(6) 低于前高时取值' },
  { id: 'r3', name: '价格 ≥ 布林带上轨', desc: '收盘价站上布林带 (20, 2) 上轨' },
  { id: 'r4', name: 'OI 持续增加', desc: '永续未平仓合约量近 5 天逐日上升' },
  { id: 'r5', name: '单日量 > 近7日总和', desc: '最近一根日K成交量大于之前 7 天之和' },
]

const checked = ref({ r1: true, r2: true, r3: true, r4: true, r5: true })
const mode = ref('any')
const month = ref('')
const loading = ref(false)
const error = ref('')
const rows = ref([])
const meta = ref(null)
const state = ref(null)
let timer = null

const enabledCount = computed(() => RULES.filter((r) => checked.value[r.id]).length)

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
    const res = await startScreener({ ...checked.value }, mode.value, month.value)
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
    if (res.results && res.results.length) applyRows(res.results)
    if (res.generatedAt) meta.value = res
  } catch {}
})

onBeforeUnmount(stopPoll)
</script>

<template>
  <div class="screen">
    <div class="head">
      <h2>指标选股（全量 USDT 永续合约）</h2>
      <button class="btn" :disabled="loading || enabledCount === 0" @click="run">
        {{ loading ? '扫描中…' : '开始扫描' }}
      </button>
    </div>

    <div class="rules">
      <div v-for="r in RULES" :key="r.id" class="rule">
        <label class="check">
          <input v-model="checked[r.id]" type="checkbox" :disabled="loading" />
          <b>{{ r.name }}</b>
        </label>
        <span class="desc">{{ r.desc }}</span>
      </div>
    </div>

    <div class="ctrl-row">
      <span class="mode-label">匹配逻辑：</span>
      <div class="seg">
        <button :class="{ active: mode === 'any' }" :disabled="loading" @click="mode = 'any'">任一满足</button>
        <button :class="{ active: mode === 'all' }" :disabled="loading" @click="mode = 'all'">全部满足</button>
      </div>
      <span class="mode-label">上架月份：</span>
      <input v-model="month" type="month" class="month-input" :disabled="loading" title="仅筛选在指定月份于币安上架的合约，留空则不限制" />
      <button v-if="month" class="clear-btn" :disabled="loading" @click="month = ''">清空</button>
      <span class="note">已勾选 {{ enabledCount }} 个规则 · 全量约 400+ 合约，为防 IP 限流已强制降速，首次约需 2-4 分钟；选择上架月份后只扫描该月上架的合约</span>
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
          <tr>
            <th>币种</th>
            <th>上架</th>
            <th v-for="r in RULES" :key="r.id" :class="{ off: !checked[r.id] }" :title="r.desc">{{ r.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.symbol" @click="openChart(r.symbol)">
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
        </tbody>
      </table>
      <div class="tips">点击行跳转行情图表。绿色列=命中规则；OI 列显示最近 5 天的末值并带涨跌箭头（绿色=命中「持续增加」）；「—」表示该规则未勾选或无数据。已内置币安限流保护：低并发+请求间隔+429/418 自动退避；K线/OI 缓存 1 小时并落盘（重启不丢），重复扫描直接复用、几乎零 API 消耗。</div>
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
