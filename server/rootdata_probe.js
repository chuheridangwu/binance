// RootData 接口探测脚本：在能直连 cn.rootdata.com 的机器上运行，
// 自动探测常见 AJAX 路径，打印真实 HTTP 状态 + 响应 JSON 的字段结构，用于确认抓取协议。
// 用法：node server/rootdata_probe.js  把输出贴给开发（可先脱敏）
const BASE = 'https://cn.rootdata.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function shape(v, depth = 0) {
  if (depth > 3) return '…'
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[${shape(v[0], depth + 1)}${v.length > 1 ? ` ×${v.length}` : ''}]`
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).slice(0, 30)
    return `{${keys.map((k) => `${k}:${shape(v[k], depth + 1)}`).join(',')}}`
  }
  return typeof v
}

async function tryUrl(method, path, { body, page } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  const url = `${BASE}${path}`
  try {
    const resp = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: page ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: `${BASE}/`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const ctype = resp.headers.get('content-type') || ''
    const text = await resp.text()
    let summary = ''
    if (ctype.includes('json')) {
      try {
        const j = JSON.parse(text)
        summary = 'JSON ' + shape(j)
      } catch {
        summary = `RAW[${text.slice(0, 80)}]`
      }
    } else if (page) {
      summary = `PAGE(${text.length}ch) projectId=${/projectId/i.test(text)} __NEXT_DATA__=${text.includes('__NEXT_DATA__')}`
      const m = text.match(/projectId["':=]+\s*"?(\d+)/i)
      if (m) summary += ` id=${m[1]}`
    } else {
      summary = `非JSON(\`${text.slice(0, 60).replace(/\n/g, ' ')}\`)`
    }
    console.log(`${method} ${path}\n  -> HTTP ${resp.status} [${ctype.split(';')[0]}] ${summary}`)
  } catch (e) {
    console.log(`${method} ${path}\n  -> ERR ${e.message}`)
  } finally {
    clearTimeout(timer)
  }
}

const candidates = [
  { m: 'GET', p: '/', page: true },
  { m: 'GET', p: '/Projects/Index', page: true },
  { m: 'GET', p: '/Projects/Search?k=PEPE', page: true },
  { m: 'GET', p: '/Projects/detail/Bitcoin', page: true },
  { m: 'POST', p: '/api/Home/SearchProject', b: { keyword: 'PEPE' } },
  { m: 'POST', p: '/api/Project/SearchProject', b: { keyword: 'PEPE' } },
  { m: 'GET', p: '/api/Home/SearchProject?keyword=PEPE' },
  { m: 'POST', p: '/api/Project/GetProjectList', b: { keyword: 'PEPE' } },
  { m: 'GET', p: '/api/Home/GetTopCoin' },
  { m: 'POST', p: '/api/Projects/GetProjectDetail', b: { projectId: 1 } },
  { m: 'GET', p: '/api/Projects/GetProjectDetail?projectId=1' },
  { m: 'POST', p: '/api/Project/Detail', b: { id: 1 } },
  { m: 'GET', p: '/api/Project/Detail?id=1' },
  { m: 'GET', p: '/api/Project/GetDetail?id=1' },
  { m: 'GET', p: '/api/Project/Info?id=1' },
  { m: 'GET', p: '/api/Project/GetCoin?symbol=PEPE' },
  { m: 'GET', p: '/api/Project/Search?symbol=PEPE' },
  { m: 'GET', p: '/api/Projects/GetProject?symbol=PEPE' },
  { m: 'POST', p: '/api/Projects/GetProjectBySymbol', b: { symbol: 'PEPE' } },
]

async function main() {
  for (const c of candidates) {
    await tryUrl(c.m, c.p, { body: c.b, page: c.page })
    await sleep(1200 + Math.random() * 800)
  }
  console.log('\n疑似字段(供核对): projectId, projectName, tokenSymbol, oneLiner, description, team[], timeline/events[], tags, ecosystem, logo, socialMedia, establishmentDate, status')
}

main().catch((e) => { console.error(e); process.exit(1) })