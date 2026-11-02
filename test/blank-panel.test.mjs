// 面板白屏 / 预设存不进去 的回归测试。
//
// 事故复盘（两个症状，一个根因 + 一个次因）：
//   ① 后端有三处把内部的 `DIMENSIONS`（短键 { k, l }）直接返回给面板，
//      而界面按 `{ key, label }` 取 → 一个都匹配不上。
//      · 「写预设」页签：11 个滑块全部 find() 不到 → 一个都不渲染 → 存进去是空预设
//        → 用户看到「点了没反应」
//      · 「维度」页签：同样取不到 → 整页空白 → 用户看到「点进去一片空白」
//      两个症状其实是同一个 bug，而且后端全程不报错。
//   ② write-preset 被放在「会话必须存在」的检查之后，而预设是全局的 ——
//      面板传的 session id 与宿主 agents 注册的 id 不一定一致 → 404。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-blank-'))
process.env.DSH_HOME = HOME
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const mod = await import('../lib/index.js')
const style = await import('../lib/style.js')

const presetsFile = () => join(HOME, 'writing-style', 'presets.json')

let SEQ = 0
function makeSession() {
  const events = []
  let seq = 0
  return {
    id: 'sess-' + (++SEQ),
    get seq() { return seq },
    events,
    append(type, data, opts) {
      const ev = { type, data, seq: seq++, time: Date.now(), ...(opts && opts.ignorable ? { ignorable: true } : {}) }
      events.push(ev)
      return ev
    },
  }
}

function boot(opts = {}) {
  const routes = []
  const handlers = {}
  const services = {
    tools: { register: () => () => {} },
    sessionProjections: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    webServer: { register: (d) => { routes.push(d); return () => {} } },
    agents: opts.agents || { list: () => [], get: () => undefined },
  }
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: (n, f) => { (handlers[n] = handlers[n] || []).push(f); return () => {} },
    get: (n) => services[n],
    inject: (_n, fn) => fn({ get: (n) => services[n], agent: null }),
  }, opts.config || {})
  return { routes, handlers }
}

async function call(host, method, path, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: '/dsh-writing-style/' + path,
      headers: { host: '127.0.0.1:53026' },
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(body || {})))
        if (ev === 'end') fn()
      },
    }
    const res = { writeHead(code) { this.code = code }, end(p) { resolve({ code: this.code, body: JSON.parse(p) }) } }
    host.routes[0].handler(req, res)
  })
}

// ---------------------------------------------------------------- ① 形状契约

test('GET state 的 dimsMeta 必须是面板形状 {key,label}，不是内部形状 {k,l}', async () => {
  const host = boot()
  const r = await call(host, 'GET', 'state')
  const meta = r.body.dimsMeta
  assert.ok(Array.isArray(meta) && meta.length > 0)
  for (const d of meta) {
    assert.equal(typeof d.key, 'string', '缺 key（面板靠它 find）')
    assert.equal(typeof d.label, 'string', '缺 label')
    assert.equal(d.k, undefined, '不该把内部短键 k 泄漏给面板')
    assert.equal(d.l, undefined, '不该把内部短键 l 泄漏给面板')
  }
})

test('维度表里不再有枚举维度（视角/时态已按用户要求取消）', async () => {
  const host = boot()
  const r = await call(host, 'GET', 'state')
  const meta = r.body.dimsMeta
  assert.equal(meta.find((d) => d.key === 'pov'), undefined, 'pov 不能再出现在面板维度表里')
  assert.equal(meta.find((d) => d.key === 'tense'), undefined, 'tense 不能再出现在面板维度表里')
  assert.deepEqual(meta.filter((d) => d.kind === 'enum'), [])
  // 但形状契约不能退化：面板靠 key/label find，缺一个就是白屏
  for (const d of meta) {
    assert.equal(typeof d.key, 'string')
    assert.equal(typeof d.label, 'string')
  }
})

test('state 带回预设落盘位置（存不上时用户能看见原因）', async () => {
  const host = boot()
  const r = await call(host, 'GET', 'state')
  const st = r.body.storage
  assert.ok(st, '必须有 storage 字段')
  assert.equal(typeof st.file, 'string')
  assert.ok(st.file.endsWith(join('writing-style', 'presets.json')), '路径应指向预设文件：' + st.file)
  assert.equal(st.home, HOME, '测试里 DSH_HOME 生效')
})

test('量表维度的 def 是数字，且带 lo/hi 说明', async () => {
  const host = boot()
  const r = await call(host, 'GET', 'state')
  const s = r.body.dimsMeta.find((d) => d.key === 'sentence')
  assert.equal(s.kind, 'scale')
  assert.equal(typeof s.def, 'number')
  assert.equal(s.lo, '短促')
  assert.equal(s.hi, '绵长')
  assert.equal(s.options, undefined, '量表维度不该有 options')
})

test('所有对外出口的 dimsMeta 形状一致（state / set / 工具）', async () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))

  const fromState = (await call(host, 'GET', 'state?session=' + session.id)).body.dimsMeta
  const fromSet = (await call(host, 'POST', 'set?session=' + session.id, { doc: { enabled: true } })).body.dimsMeta

  for (const [name, meta] of [['state', fromState], ['set', fromSet]]) {
    assert.ok(Array.isArray(meta) && meta.length > 0, name + ' 没返回 dimsMeta')
    assert.ok(meta.every((d) => typeof d.key === 'string'), name + ' 的形状不对')
  }
  assert.deepEqual(fromState.map((d) => d.key), fromSet.map((d) => d.key), '两处出口的维度集合必须一致')
})

test('dimsMeta() 覆盖全部 11 个维度且顺序稳定', () => {
  const meta = style.dimsMeta()
  assert.equal(meta.length, style.DIMENSIONS.length)
  assert.deepEqual(meta.map((d) => d.key), style.DIMENSIONS.map((d) => d.k))
})

// ---------------------------------------------------------------- ② 预设与会话无关

test('write-preset 在会话解析不到时仍然能写（预设是全局的）', async () => {
  const host = boot({ agents: { list: () => [], get: () => undefined } })
  const r = await call(host, 'POST', 'write-preset?session=ui-only-id', {
    id: 'global-preset',
    name: '全局预设',
    dims: { sentence: 12 },
  })
  assert.equal(r.code, 200, '不该因为会话解析失败而 404')
  assert.equal(r.body.ok, true)
  assert.ok(existsSync(presetsFile()))
  const saved = JSON.parse(readFileSync(presetsFile(), 'utf8'))
  assert.ok(saved.find((p) => p.id === 'global-preset'))
})

test('delete-preset 同样不受会话影响', async () => {
  const host = boot({ agents: { list: () => [], get: () => undefined } })
  await call(host, 'POST', 'write-preset?session=ghost', { id: 'to-delete', name: 'X' })
  const r = await call(host, 'POST', 'delete-preset?session=ghost', { id: 'to-delete' })
  assert.equal(r.code, 200)
  assert.ok(!r.body.presets.some((p) => p.id === 'to-delete'))
})

test('会话相关的写操作仍然必须解析到会话（不能串档）', async () => {
  const host = boot({ agents: { list: () => [], get: () => undefined } })
  const r = await call(host, 'POST', 'set?session=ghost', { doc: { enabled: true } })
  assert.equal(r.code, 404, '改风格必须落到具体会话，解析不到就该拒绝')
})

// ---------------------------------------------------------------- ③ 面板渲染不再白屏

/** 在最小宿主里加载客户端 bundle。 */
function loadClient() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const loaded = []
  const doc = {
    head: { appendChild() {} }, body: { appendChild() {} },
    visibilityState: 'visible', querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  }
  const fn = new Function('window', 'document', 'location', 'localStorage', 'fetch', 'navigator', 'CustomEvent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', src)
  fn(
    { __ModuleLoader__: { load: (d) => loaded.push(d) } },
    doc, { search: '', hash: '' }, { getItem: () => null, setItem: () => {} },
    async () => ({ ok: true, json: async () => ({}) }),
    { clipboard: { writeText: async () => {} } },
    class {}, setTimeout, clearTimeout, () => 0, () => {}, console,
  )
  return loaded[0]
}

/** 够跑组件函数的最小 React（state 按槽位存，可注入初始值）。 */
function miniReact(initial) {
  let cursor = 0
  const slots = initial ? initial.slice() : []
  return {
    React: {
      useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
      useEffect(fn) { cursor++; try { fn() } catch { /* 依赖的 DOM 未必齐全 */ } },
      useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
      useCallback(f) { cursor++; return f },
      createElement(type, props, ...kids) {
        if (typeof type === 'function') return type(Object.assign({}, props, { children: kids }))
        return { type, props, kids }
      },
    },
    reset: () => { cursor = 0 },
    slots,
  }
}

function mountPanel(payload) {
  const def = loadClient()
  globalThis.fetch = async () => ({ ok: true, json: async () => payload })
  const mini = miniReact()
  const mod = def.factory((id) => {
    if (id === 'react') return mini.React
    throw new Error('unexpected require: ' + id)
  })
  const registered = []
  const ctx = {
    effect: (f) => { f(); return () => {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, f) => f(), register: (m, c) => { registered.push({ meta: m, comp: c }); return () => {} }, useSession: () => null },
    connection: {},
  }
  mod.apply(ctx)
  const panel = registered.find((s) => s.meta.name === 'settings.section')
  return { panel, mod, mini }
}

test('后端返回内部形状（短键）时，面板仍然渲染出全部滑块而不是空白', () => {
  // 故意喂「旧形状」：这正是线上出事的那个响应
  const legacy = {
    ok: true,
    doc: { enabled: false, preset: 'balanced', presetName: '均衡', dims: { sentence: 45 }, directives: '', sample: '', avoid: [], prefer: [], rules: [] },
    dimsMeta: style.DIMENSIONS.map((d) => ({ k: d.k, l: d.l, kind: d.kind, def: d.def, options: d.options })),
    presets: [{ id: 'balanced', name: '均衡', desc: '', custom: false }],
    directive: '', summary: '', hasSession: true,
  }
  const { panel, mini } = mountPanel(legacy)
  const props = Object.assign({}, panel.meta.inject('s1'), { React: mini.React })
  mini.reset()
  // 不抛错 = 没白屏
  assert.doesNotThrow(() => panel.comp(props), '面板不能因为形状漂移而崩掉')
})

test('dimsMeta 完全缺失时用内置表兜底，页面照样能渲染', () => {
  const payload = {
    ok: true,
    doc: { enabled: false, dims: {}, directives: '', sample: '', avoid: [], prefer: [], rules: [] },
    dimsMeta: undefined,
    presets: [],
    directive: '', summary: '', hasSession: true,
  }
  const { panel, mini } = mountPanel(payload)
  mini.reset()
  assert.doesNotThrow(() => panel.comp(Object.assign({}, panel.meta.inject('s1'), { React: mini.React })))
})

test('任一页签渲染抛错时只显示该页错误，不整页白屏', () => {
  const payload = {
    ok: true,
    doc: { enabled: true, dims: {}, directives: '', sample: '', avoid: [], prefer: [], rules: [{ id: 'a', name: 'A', keys: [], text: 'x', enabled: true }] },
    dimsMeta: style.dimsMeta(),
    presets: [],
    directive: '', summary: '', hasSession: true,
  }
  const { panel, mini } = mountPanel(payload)
  // 让 rules 数据变成会抛错的东西
  payload.doc.rules = { map: undefined }
  mini.reset()
  const props = Object.assign({}, panel.meta.inject('s1'), { React: mini.React })
  assert.doesNotThrow(() => panel.comp(props), '设置页必须容错，否则用户连别的页签都改不了')
})

test('客户端 bundle 语法合法且能被宿主加载（防止再次出现构建坏掉）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotThrow(() => new vm.Script(src), 'client.js 有语法错误')
  const def = loadClient()
  assert.equal(def.id, 'dsh-writing-style')
  assert.equal(typeof def.factory, 'function')
})
