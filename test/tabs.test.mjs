// 页签结构 / 预设中心改版 的回归测试。
//
// 事故复盘（历史，守卫都保留）：
//   ① renderTab() 曾写成链式三元：第一个 `: null,` 截断后面所有分支 → 除第一个
//      页签外全部空白。守卫：源码必须用独立 if 分支。
//   ② `docVal()` 曾对 doc=null 兜底失效（=== undefined 漏掉 null）→ reading join。
//      改版后「用词」页签整个没了（字段编辑全部收进预设），null 兜底移到
//      normalizeDocClient；本文件锁「doc=null 时每个视图都不崩」。
//
// 2026-11-01 改版（用户要求）：维度/禁用词/偏好词/附加要求/范文**只存在于预设里**。
//   · 页签栏只剩 预设/条目/预览；旧的 dims/words 页签必须渲染不出内容。
//   · 每张预设卡 = 左块点=套用 + 右条「更改」= 进入该预设的完整编辑器。
//   · 编辑器是隐藏视图：只能从「更改」或「新建预设」进入；改现有预设时 id 锁死。
//   · 删除按钮只对「磁盘上真实存在的自定义预设/覆盖」出现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/** 加载客户端 bundle。 */
function loadClient() {
  const src = readFileSync(CLIENT, 'utf8')
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
    // 迟绑定：bundle 里所有 fetch 都转给 globalThis.fetch（mountPanel 换上的那一份）。
    async (url, init) => (globalThis.fetch || (async () => ({ ok: true, json: async () => ({}) })))(url, init),
    { clipboard: { writeText: async () => {} } },
    class {}, setTimeout, clearTimeout, () => 0, () => {}, console,
  )
  return loaded[0]
}

/**
 * 最小 React：按调用顺序分配 hook 槽位。
 * 槽位能事后改写（模拟 setState 后的下一次渲染），这是能测出「切页签/点更改」的关键。
 */
function makeReact() {
  let idx = 0
  const slots = {}
  return {
    React: {
      useState(init) {
        const i = idx++
        if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
        return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
      },
      useEffect(fn) { idx++; try { fn() } catch { /* 依赖的 DOM 未必齐全 */ } },
      useRef(v) { const i = idx++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
      useCallback(f) { idx++; return f },
      createElement(type, props, ...kids) {
        if (typeof type === 'function') return type(Object.assign({}, props, { children: kids }))
        return { type, props, kids }
      },
    },
    reset() { idx = 0 },
    slots,
  }
}

/** 数一棵（假）元素树里的节点数与 class。 */
function countNodes(node, acc = { n: 0, classes: [] }) {
  if (!node) return acc
  if (Array.isArray(node)) { for (const c of node) countNodes(c, acc); return acc }
  if (typeof node !== 'object') return acc
  if (node.type) {
    acc.n += 1
    const cls = node.props && node.props.className
    if (typeof cls === 'string') acc.classes.push(cls)
  }
  if (node.kids) for (const c of node.kids) countNodes(c, acc)
  return acc
}

/** 收集 className 匹配的元素节点。 */
function findClass(node, re, acc = []) {
  if (!node) return acc
  if (Array.isArray(node)) { for (const c of node) findClass(c, re, acc); return acc }
  if (typeof node !== 'object') return acc
  const cls = node.props && node.props.className
  if (typeof cls === 'string' && re.test(cls)) acc.push(node)
  if (node.kids) for (const c of node.kids) findClass(c, re, acc)
  return acc
}

/** 按直接文本子节点找按钮。 */
function findButton(node, label, acc = []) {
  if (!node) return acc
  if (Array.isArray(node)) { for (const c of node) findButton(c, label, acc); return acc }
  if (typeof node !== 'object') return acc
  if (node.type === 'button' && (node.kids || []).includes(label)) acc.push(node)
  if (node.kids) for (const c of node.kids) findButton(c, label, acc)
  return acc
}

/** 挂载设置页：完成「state 已就绪」的第一帧，并暴露重渲染能力。 */
function mountPanel(payload, proj = { doc: null }) {
  const R = makeReact()
  const def = loadClient()
  const mod = def.factory((id) => {
    if (id === 'react') return R.React
    throw new Error('unexpected require: ' + id)
  })
  const registered = []
  mod.apply({
    effect: (f) => { f(); return () => {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (n, f) => f(),
      register: (m, c) => { registered.push({ meta: m, comp: c }); return () => {} },
      useSession: () => null,
    },
    connection: {},
  })
  const panel = registered.find((s) => s.meta.name === 'settings.section')
  const props = Object.assign({}, panel.meta.inject('s1'), {
    React: R.React,
    useProjection: () => proj,
  })

  // ⚠️ 必须模拟「state 已经加载完成」：组件里 state 是 fetch 回来的，
  // 首帧必然还是 null。只测首帧等于只测空状态，测不出页签内容。
  globalThis.fetch = async () => ({ ok: true, json: async () => payload })
  R.reset()
  panel.comp(props)
  const stateIdx = Object.keys(R.slots).find((k) => R.slots[k] === null)
  if (stateIdx !== undefined) R.slots[stateIdx] = payload

  return {
    R,
    panel,
    props,
    slots: R.slots,
    rerender: () => { R.reset(); return panel.comp(props) },
  }
}

/** 挂载并切到指定视图（'presets' 是默认值，其余改写 tab 槽位）。 */
function renderView(view, payload, proj = { doc: null }) {
  const m = mountPanel(payload, proj)
  if (view !== 'presets') {
    const tabIdx = Object.keys(m.slots).find((k) => m.slots[k] === 'presets')
    assert.ok(tabIdx !== undefined, '找不到 tab 状态槽位')
    m.slots[tabIdx] = view
  }
  return { out: m.rerender(), m }
}

// 页签栏（3 个）与可渲染视图（页签 3 + 隐藏编辑器）。
const TABBAR = ['presets', 'rules', 'preview']
const VIEWS = ['presets', 'editor', 'rules', 'preview']

const FULL = {
  ok: true,
  doc: {
    enabled: true, preset: 'balanced', presetName: '均衡',
    dims: { sentence: 45 },
    directives: '', sample: '', avoid: ['不禁'], prefer: [],
    rules: [{ id: 'r1', name: '战斗', keys: ['战斗'], text: '短句', enabled: true }],
  },
  dimsMeta: [
    { key: 'sentence', label: '句式长度', kind: 'scale', def: 45, lo: '短促', hi: '绵长' },
    { key: 'density', label: '描写密度', kind: 'scale', def: 50, lo: '白描', hi: '稠密' },
  ],
  presets: [
    { id: 'balanced', name: '均衡', desc: '', custom: false },
    { id: 'noir', name: '我的冷硬', desc: '', custom: true, dims: { sentence: 20 },
      directives: '短句。', avoid: ['不禁', '仿佛'], prefer: ['雨'], sample: '雨夜。' },
  ],
  directive: 'x', summary: 'y', hasSession: true,
}

const EMPTY = { ok: true, doc: null, dimsMeta: undefined, presets: [], directive: '', summary: '', hasSession: false }

// ---------------------------------------------------------------- ① 页签栏与改版

test('页签栏只剩 预设/条目/预览（维度、用词、写预设都不在外面）', () => {
  const { out } = renderView('presets', FULL)
  assert.ok(findClass(out, /^wst-tabs$/).length === 1, '没有页签栏')
  // 页签按钮的 class 是 'wst-tab' / 'wst-tab active'（别把容器 wst-tabs 数进去）
  const btns = findClass(out, /^wst-tab( |$)/)
  assert.equal(btns.length, TABBAR.length, '页签数量变了：' + btns.length)
})

test('旧会话级页签渲染不出任何内容（dims/words 已收进预设）', () => {
  for (const dead of ['dims', 'words']) {
    const { out } = renderView(dead, FULL)
    const { classes } = countNodes(out)
    assert.ok(!classes.some((c) => c.includes('wst-range')), dead + ' 页签还能画出滑块 —— 会话级编辑没收干净')
    assert.ok(!classes.some((c) => c.includes('wst-textarea')), dead + ' 页签还能画出文本域 —— 会话级编辑没收干净')
  }
})

test('四个视图（含隐藏编辑器）都能渲染出实际内容', () => {
  for (const view of VIEWS) {
    const { out } = renderView(view, FULL)
    const { n } = countNodes(out)
    assert.ok(n > 15, `视图 ${view} 只渲染出 ${n} 个节点 —— 基本是空白`)
  }
})

test('视图之间内容不同（不是所有视图都渲染成同一个空壳）', () => {
  const counts = {}
  for (const view of VIEWS) counts[view] = countNodes(renderView(view, FULL).out).n
  const uniq = new Set(Object.values(counts))
  assert.ok(uniq.size >= 3, '各视图节点数几乎一样，说明切视图没生效：' + JSON.stringify(counts))
})

// ---------------------------------------------------------------- ② 卡片 = 套用 + 更改

test('每张预设卡有「更改」按钮；卡片外层是 div（button 不能套 button）', () => {
  const { out } = renderView('presets', FULL)
  const cards = findClass(out, /^wst-preset( |$)/)
  assert.equal(cards.length, FULL.presets.length, '卡片数量对不上')
  for (const c of cards) assert.equal(c.type, 'div', '外层必须是 div，否则 button 套 button 非法')
  const edits = findClass(out, /^wst-preset-edit$/)
  assert.equal(edits.length, FULL.presets.length, '每张卡都要配一个「更改」')
  assert.equal(findClass(out, /^wst-preset-main$/).length, FULL.presets.length, '每张卡要有套用区')
})

test('点「更改」进入该预设的完整编辑视图，五项内容全部载入且 id 锁死', () => {
  const m = mountPanel(FULL)
  const out = m.rerender()
  const edits = findClass(out, /^wst-preset-edit$/)
  const noir = edits[1] // 第二张是 noir（自定义那份）
  assert.ok(noir, '找不到 noir 卡的更改按钮')
  noir.props.onClick()
  const out2 = m.rerender()
  const { classes } = countNodes(out2)
  assert.ok(classes.some((c) => c.includes('wst-range')), '编辑视图要有维度滑块')
  const areas = findClass(out2, /^wst-textarea$/)
  const vals = areas.map((a) => a.props.value)
  assert.ok(vals.includes('短句。'), '附加要求没载入：' + JSON.stringify(vals))
  assert.ok(vals.includes('不禁、仿佛'), '禁用词没载入：' + JSON.stringify(vals))
  assert.ok(vals.includes('雨'), '偏好词没载入：' + JSON.stringify(vals))
  assert.ok(vals.includes('雨夜。'), '范文没载入：' + JSON.stringify(vals))
  const idInput = findClass(out2, /^wst-input$/).find((n) => n.props.value === 'noir')
  assert.ok(idInput, 'id 没载入')
  assert.equal(idInput.props.disabled, true, '改现有预设时 id 必须锁死（它就是「改哪一份」）')
})

test('「新建预设」进入空白草稿：id 可填；内置预设的编辑视图没有删除按钮', () => {
  const m = mountPanel(FULL)
  const out = m.rerender()
  const btn = findButton(out, '新建预设')[0]
  assert.ok(btn, '预设页签必须有「新建预设」入口')
  btn.props.onClick()
  const out2 = m.rerender()
  const idInput = findClass(out2, /^wst-input$/)[0]
  assert.equal(idInput.props.value, '', '新建草稿的 id 应为空')
  assert.notEqual(idInput.props.disabled, true, '新建时 id 必须能填')
  assert.equal(findButton(out2, '删除').length, 0, '新建草稿不该出现删除')

  // 内置预设（custom=false）的编辑视图同样没有删除按钮
  const m2 = mountPanel(FULL)
  findClass(m2.rerender(), /^wst-preset-edit$/)[0].props.onClick()
  assert.equal(findButton(m2.rerender(), '删除').length, 0, '纯内置预设没有可删的东西')

  // 自定义预设（custom=true）才有删除
  const m3 = mountPanel(FULL)
  findClass(m3.rerender(), /^wst-preset-edit$/)[1].props.onClick()
  assert.equal(findButton(m3.rerender(), '删除').length, 1, '自定义预设必须能删')
})

test('编辑视图有「保存这套预设」和「保存并应用到当前对话」两个出口', () => {
  const { out } = renderView('editor', FULL)
  assert.equal(findButton(out, '保存这套预设').length, 1)
  assert.equal(findButton(out, '保存并应用到当前对话').length, 1)
  assert.equal(findButton(out, '← 返回预设列表').length, 1)
})

// ---------------------------------------------------------------- ②.5 保存生效可见化
// 2026-11-02 用户报：「在预览更改完预设后预览处不会改变，不知道保存是否生效」。
// 语义本身没错（会话文档是套用那一刻的快照），但界面必须把这件事说出来，
// 并且给一个「这份草稿套用时会长什么样」的直接预览。

const settle = () => new Promise((r) => setTimeout(r, 0))

/** 把渲染树里的所有文本收出来（断言「页面上出现了某句话」用）。 */
function textAll(node, acc = []) {
  if (node == null || typeof node === 'boolean') return acc
  if (typeof node === 'string') { acc.push(node); return acc }
  if (Array.isArray(node)) { for (const c of node) textAll(c, acc); return acc }
  if (typeof node === 'object') for (const k of node.kids || []) textAll(k, acc)
  return acc
}

test('编辑器里有「预览注入效果」：把草稿五项发给服务端渲染，并显示返回正文', async () => {
  const m = mountPanel(FULL)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body })
    return { ok: true, json: async () => ({ ok: true, directive: '【写作风格】预览正文', summary: 'y' }) }
  }
  const out = m.rerender()
  findClass(out, /^wst-preset-edit$/)[1].props.onClick() // noir：五项有内容
  const out2 = m.rerender()
  const btn = findButton(out2, '预览注入效果')[0]
  assert.ok(btn, '编辑视图必须有「预览注入效果」按钮')
  btn.props.onClick()
  await settle(); await settle()
  const out3 = m.rerender()
  const box = findClass(out3, /^wst-preview$/)
  assert.ok(box.length >= 1 && textAll(box[0]).some((s) => s.includes('预览正文')), '预览正文要显示在编辑视图里')
  const post = calls.find((c) => c.url.includes('preview'))
  assert.ok(post, '必须真的调用 preview op')
  const sent = JSON.parse(post.body)
  assert.equal(sent.doc.preset, 'noir', '预览要带草稿的 id')
  assert.deepEqual(sent.doc.prefer, ['雨'], '预览要带草稿的偏好词（五项都要发）')
  assert.deepEqual(sent.doc.avoid, ['不禁', '仿佛'])
  assert.equal(sent.doc.sample, '雨夜。')
})

test('保存「正在使用的」预设（没套用）→ 出现持久提示：当前会话还是旧快照', async () => {
  const m = mountPanel(FULL) // FULL.doc.preset === 'balanced'
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
  const out = m.rerender()
  findClass(out, /^wst-preset-edit$/)[0].props.onClick() // balanced 的「更改」
  findButton(m.rerender(), '保存这套预设')[0].props.onClick()
  await settle(); await settle(); await settle()
  assert.ok(textAll(m.rerender()).some((s) => s.includes('快照')), '保存了正在用的预设，必须提示会话不会跟着变')
})

test('保存「没在用的」预设 → 不弹这条提示（别把无关操作说成有问题）', async () => {
  const m = mountPanel(FULL)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
  const out = m.rerender()
  findClass(out, /^wst-preset-edit$/)[1].props.onClick() // noir：不是当前预设
  findButton(m.rerender(), '保存这套预设')[0].props.onClick()
  await settle(); await settle(); await settle()
  assert.ok(!textAll(m.rerender()).some((s) => s.includes('快照')), '没在用的预设不该出现该提示')
})

test('点「预览」页签会立刻强拉一次 state（预览不该等 45s 轮询）', async () => {
  const m = mountPanel(FULL)
  let stateGets = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('state')) stateGets += 1
    return { ok: true, json: async () => FULL }
  }
  const out = m.rerender()
  const before = stateGets
  const pv = findButton(out, '预览')[0]
  assert.ok(pv, '页签栏要有「预览」')
  pv.props.onClick()
  await settle(); await settle()
  assert.ok(stateGets > before, '切到预览页签应当马上刷新一次状态')
})

// ---------------------------------------------------------------- ③ 其余页签 + null 数据

test('「条目」页签在有条目时渲染条目卡片', () => {
  const { out } = renderView('rules', FULL)
  const { classes } = countNodes(out)
  assert.ok(classes.some((c) => c.includes('wst-rule')), '条目页签没有渲染条目')
})

test('「条目」页签在没条目时给出表单，而不是纯空白', () => {
  const payload = { ...FULL, doc: { ...FULL.doc, rules: [] } }
  const { out } = renderView('rules', payload)
  const { n } = countNodes(out)
  assert.ok(n > 15, '没条目时也该有「新增条目」表单，实际只有 ' + n + ' 个节点')
})

test('doc 为 null 时四个视图全部不崩、且都有内容（改版后靠 normalizeDocClient 兜底）', () => {
  for (const view of VIEWS) {
    const { out } = renderView(view, EMPTY)
    const { n } = countNodes(out)
    assert.ok(n > 10, `doc=null 时视图 ${view} 只有 ${n} 个节点`)
  }
})

test('doc 里字段类型全错时也不崩（avoid 不是数组等）', () => {
  const bad = {
    ...FULL,
    doc: { enabled: 'yes', dims: 'nope', avoid: null, prefer: 5, rules: 'x', directives: {}, sample: [] },
  }
  for (const view of VIEWS) {
    assert.doesNotThrow(() => renderView(view, bad), '视图 ' + view + ' 在脏数据下崩了')
  }
})

test('投影返回 {doc:null} 且 state 未就绪时，页面仍有内容', () => {
  const { out } = renderView('presets', { ok: true, doc: undefined, dimsMeta: undefined, presets: [] }, { doc: null })
  const { n } = countNodes(out)
  assert.ok(n > 10, '实际 ' + n + ' 个节点')
})

// ---------------------------------------------------------------- ④ 结构守卫（历史事故）

test('renderTab 不能写成链式三元（这是上一轮空白的根因）', () => {
  const src = readFileSync(CLIENT, 'utf8')
  const m = /function renderTab\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)
  assert.ok(m, '找不到 renderTab 函数')
  const body = m[1]
  assert.ok(!/return\s+tab\s*===\s*'presets'\s*\?/.test(body), 'renderTab 又写成了链式三元 —— 第一个 : null, 会截断后面所有分支')
  assert.match(body, /if \(tab === 'presets'\) return/, '应当用独立 if 分支')
  assert.match(body, /if \(tab === 'preview'\) return/, 'preview 分支也要用 if')
})

test('客户端 bundle 语法合法（构建坏掉时立刻发现）', () => {
  assert.doesNotThrow(() => new vm.Script(readFileSync(CLIENT, 'utf8')))
})
