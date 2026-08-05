<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import { getKlines, getKlinesBefore, searchSymbols } from '../api/binance'
import { ema, rsi, macd } from '../utils/indicators'
import { store } from '../store'

const INTERVALS = [
  { label: '15m', value: '15m' },
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
]
const EMA_COLORS = ['#f0b90b', '#f6465d', '#2d95ff', '#9747ff', '#0ecb81', '#e5a13a']

const UP = '#0ecb81'
const DOWN = '#f6465d'
const BG = '#131722'
const TEXTC = '#787b86'
const GRID = 'rgba(42,46,57,0.5)'
const BORDER = 'rgba(42,46,57,0.8)'

const symbol = ref(store.chartSymbol)
const query = ref(store.chartSymbol)
const interval = ref('1h')
const loading = ref(true)
const error = ref('')
const showEma = ref(true)
const showMacd = ref(true)
const showRsi = ref(true)
const emaText = ref('7,25,99')
const rsiPeriod = ref(14)
const macdFast = ref(12)
const macdSlow = ref(26)
const macdSignal = ref(9)
const suggestions = ref([])
const lastBar = ref(null)
const hovered = ref(null)

const emaPeriods = computed(() =>
  emaText.value
    .split(/[,，\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
)

const shown = computed(() => hovered.value || lastBar.value)
const shownUp = computed(() => (shown.value ? shown.value.close >= shown.value.open : true))
const changePct = computed(() => {
  const k = shown.value
  if (!k) return 0
  const prevIdx = k.idx - 1
  const prev = prevIdx >= 0 ? klinesCache[prevIdx].close : k.open
  return prev ? ((k.close - prev) / prev) * 100 : 0
})

let charts = []
let mainChart = null
let volumeChart = null
let macdChart = null
let rsiChart = null
let candleSeries = null
let volumeSeries = null
let ind = {}
let klinesCache = []
let timeIndex = new Map()
let macdByTime = new Map()
let rsiByTime = new Map()
let loadingMore = false
let reloadQueued = false
let noMoreHistory = false
let loadSeq = 0

function fmtPrice(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—'
  if (v >= 1000) return v.toFixed(2)
  if (v >= 1) return v.toFixed(4)
  if (v >= 0.0001) return v.toFixed(6)
  return v.toFixed(8)
}
function fmtVol(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K'
  return v.toFixed(2)
}

const baseOptions = {
  layout: {
    background: { type: ColorType.Solid, color: BG },
    textColor: TEXTC,
    fontSize: 12,
  },
  grid: {
    vertLines: { color: GRID },
    horzLines: { color: GRID },
  },
  rightPriceScale: { borderColor: BORDER, minimumWidth: 115 },
  timeScale: { borderColor: BORDER, timeVisible: true, secondsVisible: false },
  localization: { priceFormatter: fmtPrice },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: '#758696', labelBackgroundColor: '#363a45' },
    horzLine: { color: '#758696', labelBackgroundColor: '#363a45' },
  },
}

function makeChart(el) {
  const chart = createChart(el, { ...baseOptions, autoSize: true })
  chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 10 })
  charts.push(chart)
  return chart
}

function removeIndicatorSeries() {
  Object.values(ind).forEach((s) => s.owner.removeSeries(s.series))
  ind = {}
}

function initCharts() {
  removeIndicatorSeries()
  macdByTime = new Map()
  rsiByTime = new Map()
  charts.forEach((c) => c.remove())
  charts = []
  mainChart = null
  volumeChart = null
  macdChart = null
  rsiChart = null

  mainChart = makeChart(document.querySelector('#pane-main'))
  volumeChart = makeChart(document.querySelector('#pane-volume'))
  macdChart = showMacd.value ? makeChart(document.querySelector('#pane-macd')) : null
  rsiChart = showRsi.value ? makeChart(document.querySelector('#pane-rsi')) : null

  candleSeries = mainChart.addCandlestickSeries({
    upColor: UP,
    downColor: DOWN,
    borderUpColor: UP,
    borderDownColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
    borderVisible: true,
    priceLineVisible: true,
    priceLineStyle: LineStyle.Dashed,
    priceLineWidth: 1,
  })

  volumeSeries = volumeChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    lastValueVisible: false,
    priceLineVisible: false,
  })
  volumeChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0 } })

  if (macdChart) {
    macdChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } })
  }

  if (rsiChart) {
    rsiChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } })
  }

  const bottomChart = showRsi.value ? rsiChart : showMacd.value ? macdChart : volumeChart
  charts.forEach((c) => c.timeScale().applyOptions({ visible: c === bottomChart }))

  mainChart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange)
  mainChart.subscribeCrosshairMove((p) => onCrosshair('main', p))
  volumeChart.subscribeCrosshairMove((p) => onCrosshair('main', p))
  macdChart?.subscribeCrosshairMove((p) => onCrosshair('macd', p))
  rsiChart?.subscribeCrosshairMove((p) => onCrosshair('rsi', p))
}

function onCrosshair(kind, param) {
  const time = param.time
  if (typeof time !== 'number') {
    hovered.value = null
    macdChart?.clearCrosshairPosition()
    rsiChart?.clearCrosshairPosition()
    return
  }
  const idx = timeIndex.get(time)
  if (idx !== undefined) updateOhlc(idx)

  if (kind !== 'main') {
    const k = idx !== undefined ? klinesCache[idx] : null
    if (k) mainChart.setCrosshairPosition(k.close, time, candleSeries)
    else mainChart.clearCrosshairPosition()
  }
  if (kind !== 'macd' && macdChart && ind.macdHist && ind.macdHist.series) {
    const v = macdByTime.get(time)
    if (v !== undefined) macdChart.setCrosshairPosition(v, time, ind.macdHist.series)
    else macdChart.clearCrosshairPosition()
  }
  if (kind !== 'rsi' && rsiChart && ind.rsi && ind.rsi.series) {
    const v = rsiByTime.get(time)
    if (v !== undefined) rsiChart.setCrosshairPosition(v, time, ind.rsi.series)
    else rsiChart.clearCrosshairPosition()
  }
}

function updateOhlc(idx) {
  if (idx === undefined || idx < 0) {
    hovered.value = null
    return
  }
  const k = klinesCache[idx]
  hovered.value = { idx, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }
}

function renderIndicators(closes) {
  const base = klinesCache.map((k) => ({ time: k.time }))
  macdByTime = new Map()
  rsiByTime = new Map()

  if (macdChart) {
    if (!ind.dif) {
      ind.dif = { owner: macdChart, series: macdChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }) }
      ind.dea = { owner: macdChart, series: macdChart.addLineSeries({ color: '#f6465d', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }) }
      ind.macdHist = { owner: macdChart, series: macdChart.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false }) }
    }
    const { dif, dea, hist } = macd(closes, macdFast.value, macdSlow.value, macdSignal.value)
    ind.dif.series.setData(dif.map((v, i) => ({ time: base[i].time, value: v })))
    ind.dea.series.setData(dea.map((v, i) => ({ time: base[i].time, value: v })))
    ind.macdHist.series.setData(
      hist.map((v, i) => {
        macdByTime.set(base[i].time, v)
        return { time: base[i].time, value: v, color: v >= 0 ? 'rgba(14,203,129,0.6)' : 'rgba(246,70,93,0.6)' }
      })
    )
  }

  if (rsiChart) {
    if (!ind.rsi) {
      ind.rsi = { owner: rsiChart, series: rsiChart.addLineSeries({ color: '#9747ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }) }
      ind.rsi70 = { owner: rsiChart, series: rsiChart.addLineSeries({ color: 'rgba(246,70,93,0.5)', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }) }
      ind.rsi30 = { owner: rsiChart, series: rsiChart.addLineSeries({ color: 'rgba(14,203,129,0.5)', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }) }
    }
    const r = rsi(closes, rsiPeriod.value)
    const pts = r.map((v, i) => ({ time: base[i].time, value: v }))
    pts.forEach((p) => p.value && rsiByTime.set(p.time, p.value))
    ind.rsi.series.setData(pts.filter((p) => p.value))
    ind.rsi70.series.setData(pts.map((p) => ({ time: p.time, value: 70 })))
    ind.rsi30.series.setData(pts.map((p) => ({ time: p.time, value: 30 })))
  }

  if (showEma.value) {
    emaPeriods.value.forEach((p, i) => {
      const key = `ema${p}`
      if (!ind[key]) {
        ind[key] = { owner: mainChart, series: mainChart.addLineSeries({ color: EMA_COLORS[i % EMA_COLORS.length], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) }
      }
      ind[key].series.setData(ema(closes, p).map((v, i) => ({ time: base[i].time, value: v })).filter((pt) => pt.value))
    })
  }
}

function refreshIndicators() {
  if (!klinesCache.length) return
  removeIndicatorSeries()
  renderIndicators(klinesCache.map((k) => k.close))
}

function applyData(klines) {
  klinesCache = klines
  timeIndex = new Map(klines.map((k, i) => [k.time, i]))

  const last = klines[klines.length - 1]
  lastBar.value = { idx: klines.length - 1, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume }

  candleSeries.setData(klines.map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })))
  const lastUp = last.close >= (klines[klines.length - 2]?.close ?? last.open)
  candleSeries.applyOptions({ priceLineColor: lastUp ? UP : DOWN })

  volumeSeries.setData(
    klines.map((k) => ({
      time: k.time,
      value: k.volume,
      color: k.close >= k.open ? 'rgba(14,203,129,0.4)' : 'rgba(246,70,93,0.4)',
    }))
  )
  renderIndicators(klines.map((k) => k.close))
}

async function loadData() {
  loading.value = true
  error.value = ''
  loadSeq++
  noMoreHistory = false
  reloadQueued = false
  loadingMore = false
  try {
    const klines = await getKlines(symbol.value, interval.value, 500)
    if (!klines.length) throw new Error('没有K线数据')
    applyData(klines)
    mainChart.timeScale().applyOptions({ barSpacing: 10 })
    mainChart.timeScale().scrollToRealTime()
    syncCharts()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore || noMoreHistory || !klinesCache.length) return
  loadingMore = true
  const seq = loadSeq
  const sym = symbol.value
  const iv = interval.value
  try {
    const first = klinesCache[0]
    const before = mainChart.timeScale().getVisibleLogicalRange()
    const older = await getKlinesBefore(sym, iv, first.time, 500)
    if (seq !== loadSeq) return
    if (!older.length) {
      noMoreHistory = true
      return
    }
    const shift = older.length
    applyData([...older, ...klinesCache])
    if (before) {
      mainChart.timeScale().setVisibleLogicalRange({ from: before.from + shift, to: before.to + shift })
      syncCharts()
    }
  } catch {
    /* 加载失败忽略，继续滚动时会重试 */
  } finally {
    loadingMore = false
    if (reloadQueued) {
      reloadQueued = false
      setTimeout(loadMore, 60)
    }
  }
}

function syncCharts() {
  const targets = []
  if (volumeChart) targets.push(volumeChart)
  if (macdChart) targets.push(macdChart)
  if (rsiChart) targets.push(rsiChart)
  if (!targets.length) return
  const range = mainChart.timeScale().getVisibleLogicalRange()
  if (!range) return
  targets.forEach((c) => c.timeScale().setVisibleLogicalRange(range))
}

function handleRangeChange() {
  syncCharts()
  const range = mainChart.timeScale().getVisibleLogicalRange()
  if (range && range.from < -1) {
    if (loadingMore) reloadQueued = true
    else loadMore()
  }
}

function reload() {
  initCharts()
  loadData()
}

function switchInterval(iv) {
  interval.value = iv
  reload()
}

async function onSearchInput() {
  const q = query.value.trim()
  if (q.length < 2) {
    suggestions.value = []
    return
  }
  suggestions.value = await searchSymbols(q)
}

function pick(s) {
  const sym = typeof s === 'string' ? s : s.symbol
  symbol.value = sym
  query.value = sym
  store.chartSymbol = sym
  suggestions.value = []
  reload()
}

onMounted(() => {
  initCharts()
  loadData()
})

onBeforeUnmount(() => {
  charts.forEach((c) => c.remove())
  charts = []
})

watch([showEma, showMacd, showRsi], () => nextTick(reload))
watch([rsiPeriod, macdFast, macdSlow, macdSignal, emaText], refreshIndicators)
watch(
  () => store.chartSymbol,
  (s) => {
    if (s && s !== symbol.value) {
      symbol.value = s
      query.value = s
      reload()
    }
  }
)
</script>

<template>
  <div class="kline">
    <div class="toolbar">
      <div class="symbol-box">
        <input
          v-model="query"
          class="symbol-input"
          placeholder="输入交易对，如 BTCUSDT"
          @input="onSearchInput"
          @keyup.enter="pick(query.trim().toUpperCase())"
        />
        <ul v-if="suggestions.length" class="dropdown">
          <li
            v-for="s in suggestions"
            :key="s.symbol"
            :class="{ delisted: !s.active }"
            @mousedown.prevent="pick(s)"
          >
            {{ s.symbol }}
            <span v-if="s.kind === 'stock'" class="badge stock">股票</span>
            <span v-else-if="s.kind === 'commodity'" class="badge commodity">商品</span>
            <span v-if="!s.active" class="badge delisted">已下架</span>
          </li>
        </ul>
      </div>
      <div class="seg">
        <button
          v-for="it in INTERVALS"
          :key="it.value"
          :class="{ active: interval === it.value }"
          @click="switchInterval(it.value)"
        >
          {{ it.label }}
        </button>
      </div>

      <div class="ind-group">
        <label class="check"><input v-model="showEma" type="checkbox" /> EMA</label>
        <input v-model="emaText" class="num" title="EMA 周期，逗号分隔，如 7,25,99" @change="refreshIndicators" />
      </div>

      <div class="ind-group">
        <label class="check"><input v-model="showMacd" type="checkbox" /> MACD</label>
        <input v-model.number="macdFast" type="number" class="num" min="1" max="100" title="快线周期" @change="refreshIndicators" />
        <input v-model.number="macdSlow" type="number" class="num" min="1" max="200" title="慢线周期" @change="refreshIndicators" />
        <input v-model.number="macdSignal" type="number" class="num" min="1" max="50" title="信号周期" @change="refreshIndicators" />
      </div>

      <div class="ind-group">
        <label class="check"><input v-model="showRsi" type="checkbox" /> RSI</label>
        <input v-model.number="rsiPeriod" type="number" class="num" min="2" max="100" title="RSI 周期" @change="refreshIndicators" />
      </div>
    </div>

    <div class="ohlc-bar">
      <span class="sym">{{ symbol }}</span>
      <span class="price" :class="{ up: shownUp, down: !shownUp }">{{ fmtPrice(shown?.close) }}</span>
      <span class="chg" :class="{ up: changePct >= 0, down: changePct < 0 }">{{ changePct >= 0 ? '+' : '' }}{{ changePct.toFixed(2) }}%</span>
      <span class="sep"></span>
      <span class="item">O <b :class="{ up: shownUp, down: !shownUp }">{{ fmtPrice(shown?.open) }}</b></span>
      <span class="item">H <b class="up">{{ fmtPrice(shown?.high) }}</b></span>
      <span class="item">L <b class="down">{{ fmtPrice(shown?.low) }}</b></span>
      <span class="item">C <b :class="{ up: shownUp, down: !shownUp }">{{ fmtPrice(shown?.close) }}</b></span>
      <span class="item">V <b>{{ fmtVol(shown?.volume) }}</b></span>
    </div>

    <div class="chart-stack">
      <div class="pane pane-main">
        <span class="watermark">{{ symbol }} · {{ interval }}</span>
        <div id="pane-main" class="chart-el"></div>
      </div>
      <div class="pane pane-volume">
        <div id="pane-volume" class="chart-el"></div>
      </div>
      <div v-if="showMacd" class="pane pane-sub">
        <span class="pane-label">MACD ({{ macdFast }}, {{ macdSlow }}, {{ macdSignal }})</span>
        <div id="pane-macd" class="chart-el"></div>
      </div>
      <div v-if="showRsi" class="pane pane-sub">
        <span class="pane-label">RSI ({{ rsiPeriod }})</span>
        <div id="pane-rsi" class="chart-el"></div>
      </div>
    </div>

    <div v-if="loading" class="hint">加载中…</div>
    <div v-else-if="error" class="hint err">{{ symbol }} {{ error }}</div>
  </div>
</template>

<style scoped>
.kline {
  position: relative;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.symbol-box {
  position: relative;
}
.symbol-input {
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  color: #eaecef;
  padding: 8px 12px;
  font-size: 14px;
  width: 180px;
  outline: none;
}
.symbol-input:focus {
  border-color: #f0b90b;
}
.dropdown {
  position: absolute;
  top: 40px;
  left: 0;
  right: 0;
  z-index: 10;
  background: #1e2329;
  border: 1px solid #2b3139;
  border-radius: 6px;
  max-height: 260px;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.dropdown li {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.dropdown li.delisted {
  color: #5e6673;
}
.dropdown li.delisted .badge {
  margin-left: auto;
  font-size: 11px;
  color: #5e6673;
  border: 1px solid #2b3139;
  border-radius: 4px;
  padding: 1px 6px;
}
.dropdown li .badge {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  border: 1px solid #2b3139;
}
.dropdown li .badge.stock { color: #8ab4ff; background: #223458; border-color: #223458; }
.dropdown li .badge.commodity { color: #43e3b4; background: #12352c; border-color: #12352c; }
.dropdown li .badge.delisted { color: #ff7d8c; background: #3a1d24; border-color: #3a1d24; }
.dropdown li:hover {
  background: #2b3139;
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
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
}
.seg button.active {
  background: #2b3139;
  color: #f0b90b;
  font-weight: 600;
}
.ind-group {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #1e2329;
  border-radius: 6px;
  padding: 6px 10px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #848e9c;
  cursor: pointer;
  white-space: nowrap;
}
.check input {
  accent-color: #f0b90b;
}
.sel {
  background: #2b3139;
  border: 1px solid #2b3139;
  color: #eaecef;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  outline: none;
  cursor: pointer;
}
.num {
  width: 46px;
  background: #2b3139;
  border: 1px solid #2b3139;
  color: #eaecef;
  font-size: 12px;
  padding: 2px 5px;
  border-radius: 4px;
  outline: none;
  text-align: center;
}
.num:focus {
  border-color: #f0b90b;
}
input[type='number'].num::-webkit-outer-spin-button,
input[type='number'].num::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.ohlc-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  background: #1e2329;
  border: 1px solid #2b3139;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  font-size: 13px;
  color: #848e9c;
  flex-wrap: wrap;
}
.ohlc-bar .sym {
  color: #eaecef;
  font-weight: 600;
}
.ohlc-bar .price {
  font-size: 18px;
  font-weight: 700;
}
.ohlc-bar .chg {
  font-size: 13px;
}
.up {
  color: #0ecb81;
}
.down {
  color: #f6465d;
}
.ohlc-bar .sep {
  width: 1px;
  height: 18px;
  background: #2b3139;
}
.ohlc-bar .item b {
  color: #eaecef;
  font-weight: 600;
  margin-left: 2px;
}
.chart-stack {
  display: flex;
  flex-direction: column;
  height: 68vh;
  min-height: 460px;
  border: 1px solid #2b3139;
  border-radius: 0 0 6px 6px;
  overflow: hidden;
  background: #131722;
}
.pane {
  position: relative;
  width: 100%;
}
.pane-main {
  flex: 1 0 auto;
}
.pane-volume {
  flex: 0 0 12%;
  border-top: 1px solid #2b3139;
}
.pane-sub {
  flex: 0 0 16%;
  border-top: 1px solid #2b3139;
}
.chart-el {
  width: 100%;
  height: 100%;
}
.watermark {
  position: absolute;
  top: 8px;
  left: 10px;
  z-index: 5;
  color: rgba(132, 142, 156, 0.35);
  font-size: 12px;
  pointer-events: none;
}
.pane-label {
  position: absolute;
  top: 2px;
  left: 6px;
  z-index: 5;
  color: #787b86;
  font-size: 11px;
  pointer-events: none;
}
.hint {
  text-align: center;
  color: #848e9c;
  font-size: 13px;
  padding: 12px;
}
.hint.err {
  color: #f6465d;
}
</style>
