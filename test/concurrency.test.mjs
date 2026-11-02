// 并发契约回归（2026-11-01 真机两个症状的共同根因）。
//
// 上一版 RPC 层只有一个全局在途槽 `inflight.current`：
//   · 点「套用」发 POST /preset，成功后 notify() 触发 GET /state；
//     那次 GET 撞上仍在途的 POST，`if (isGet) return inflight.current`
//     让它**直接采纳了 POST 的响应**（{ok,doc,summary} 里没有 presets/dimsMeta）
//     → 预设页签的卡全没了，点刷新（那时没有 POST 在途）才回来。
//   · 切到会话 B 时 GET /state?session=B 撞上会话 A 仍在途的 GET，
//     复用 A 的响应 → 所有徽标看起来一起翻转（写其实是逐会话隔离的）。
// 修法是按「操作 + 会话」分键：GET 只够用同键在途请求，POST 按会话串行。
//
// 这里钉四件事（全部从 RPC 层本身验，不看组件结果）：
//   ① GET 绝不采纳在途 POST 的响应（哪怕它还没回来）；
//   ② GET 绝不跨会话复用（A 的在途请求不能喂给 B）；
//   ③ 同键 GET 仍然去重（不要因为修 bug 把「别打两次」也丢了）；
//   ④ 同一会话的 POST 串行、且一个都不丢（点两下不能只发一次）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = new URL('../client.js', import.meta.url)
const ROUTE = '/dsh-writing-style'

const STATE_BODY = (sid) => ({
  ok: true,
  doc: { enabled: true, preset: 'balanced', presetName: '均衡', dims: { sentence: 45 }, directives: '', sample: '', avoid: [], prefer: [], rules: [] },
  dimsMeta: [{ key: 'sentence', label: '句式长度', kind: 'scale', def: 45 }],
  presets: Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, name: '预设' + i })),
  directive: '', summary: '', hasSession: true, session: sid || '',
})

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function defer() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 把 bundle 装进一个新的执行环境，返回模块（含测试缝 __rpcForTest）。 */
function loadModule(fetchImpl) {
  const src = readFileSync(CLIENT, 'utf8')
  const loaded = []
  const doc = {
    head: { appendChild() {} }, body: { appendChild() {} },
    visibilityState: 'visible', querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  }
  const fn = new Function(
    'window', 'document', 'location', 'localStorage', 'sessionStorage', 'fetch', 'navigator', 'CustomEvent',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', src,
  )
  fn(
    { __ModuleLoader__: { load: (d) => loaded.push(d) } },
    doc, { search: '', hash: '' },
    { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetchImpl,
    { clipboard: { writeText: async () => {} } },
    class { constructor(t) { this.type = t } },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  )
  const def = loaded[0]
  const mod = def.factory(() => { throw new Error('no require in this test') })
  return mod
}

/** 一个会记账的 fetch：日志里能看到「到底发没发、发给哪个会话」。 */
function makeFetch(handler) {
  const log = []
  const fetchImpl = (url, init) => {
    const u = new URL(url, 'http://host.test')
    const op = u.pathname.startsWith(ROUTE + '/') ? u.pathname.slice(ROUTE.length + 1) : u.pathname
    const entry = { op, session: u.searchParams.get('session') || '', method: (init && init.method) || 'GET' }
    log.push(entry)
    const body = handler(op, entry)
    return Promise.resolve(body).then((b) => ({ ok: true, status: 200, json: async () => b }))
  }
  return { fetchImpl, log }
}

// ---------------------------------------------------------------- ① 不借用 POST
test('GET 在 POST 在途时照发自己的请求，绝不采纳 POST 的响应', async () => {
  const gate = defer()
  const { fetchImpl, log } = makeFetch((op) => {
    if (op === 'preset') {
      // POST 的响应形状就是真宿主回的那种：只有 ok/doc/summary，没有 presets
      return gate.promise.then(() => ({ ok: true, doc: { preset: 'hardboiled' }, summary: '冷硬派', directive: 'x' }))
    }
    return STATE_BODY()
  })
  const { __rpcForTest: rpc } = loadModule(fetchImpl)

  const post = rpc('preset', { id: 'hardboiled' })
  await settle()
  assert.equal(log.length, 1, 'POST 应该先发出去')

  const get = rpc('state')
  await settle()
  // 上一版只有 1 条：GET 复用 POST 的在途 promise，请求根本没发。
  assert.equal(log.length, 2, 'GET 必须自己发一次，不能借用在途 POST')
  assert.deepEqual(log.map((e) => e.op), ['preset', 'state'])

  const st = await get
  assert.equal(st.presets.length, 10, 'GET 的结果必须是完整 /state（带 presets），不是 POST 的响应')
  assert.ok(!('preset' in st && !Array.isArray(st.presets)))

  gate.resolve()
  const done = await post
  assert.equal(done.ok, true)
})

// ---------------------------------------------------------------- ② 不跨会话
test('会话 A 的在途 GET 不会被会话 B 复用（徽标不该一起翻转）', async () => {
  const gateA = defer()
  const { fetchImpl, log } = makeFetch((op, entry) => {
    if (entry.session === 'A') return gateA.promise.then(() => STATE_BODY('A'))
    return STATE_BODY('B')
  })
  const { __rpcForTest: rpc } = loadModule(fetchImpl)

  const a = rpc('state', undefined, 'A')
  await settle()
  const b = rpc('state', undefined, 'B')
  await settle()

  assert.equal(log.length, 2, '两个会话必须各发一次')
  assert.deepEqual(log.map((e) => e.session), ['A', 'B'])

  const bres = await b
  assert.equal(bres.session, 'B', 'B 必须拿到 B 的响应')

  gateA.resolve()
  const ares = await a
  assert.equal(ares.session, 'A')
})

// ---------------------------------------------------------------- ③ 同键仍去重
test('同一会话同一操作的在途 GET 仍然只发一次（去重不能一起丢掉）', async () => {
  const gate = defer()
  const { fetchImpl, log } = makeFetch(() => gate.promise.then(() => STATE_BODY()))
  const { __rpcForTest: rpc } = loadModule(fetchImpl)

  const p1 = rpc('state')
  const p2 = rpc('state')
  await settle()
  assert.equal(log.length, 1)

  gate.resolve()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1, r2, '两个调用应当拿到同一个结果')
})

// ---------------------------------------------------------------- ④ 写不并发
test('同一会话的 POST 串行：前一个没回来，后一个先排队', async () => {
  const gate = defer()
  let n = 0
  const { fetchImpl, log } = makeFetch(() => {
    n += 1
    if (n === 1) return gate.promise.then(() => ({ ok: true, doc: {}, summary: '', directive: '' }))
    return { ok: true, doc: {}, summary: '', directive: '' }
  })
  const { __rpcForTest: rpc } = loadModule(fetchImpl)

  const p1 = rpc('set', { enabled: true })
  await settle()
  const p2 = rpc('set', { dims: { sentence: 90 } })
  await settle()
  assert.equal(log.length, 1, '第二个写必须排队，不能和第一个并发')

  gate.resolve()
  await p1
  await settle()
  assert.equal(log.length, 2, '前一个写完了，后一个必须真的发出去（点两下不能只发一次）')
  const r2 = await p2
  assert.equal(r2.ok, true)
})
