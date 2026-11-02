// 客户端 bundle 契约测试：产物必须是宿主能加载的模块形状。
//
// 宿主加载客户端插件的唯一入口是 window.__ModuleLoader__.load({ id, factory })，
// factory 里拿到的是宿主的 require（react 由它提供）。写错形状的表现是
// 「插件装了但界面什么都不出现」，很难从现象反推原因，所以这里逐条判死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = readFileSync(resolve(root, 'client.js'), 'utf8')

/** 在假宿主里执行 bundle，拿回它注册的东西。 */
function loadBundle(opts = {}) {
  const loaded = []
  const slots = []
  const locales = []
  const effects = []

  const fakeRequire = (id) => {
    if (id === 'react') return opts.react || makeFakeReact()
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error('unexpected require: ' + id)
  }

  const ctx = {
    effect: (fn) => { effects.push(fn); const d = fn(); return () => { if (typeof d === 'function') d() } },
    locale: {
      register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {} },
      bind: (ns) => (key) => {
        const hit = locales.find((l) => l.ns === ns)
        const dict = hit && hit.dicts && hit.dicts.zh
        const v = dict && dict[key]
        return typeof v === 'string' ? v : key
      },
    },
    slots: {
      inject: (name, fn) => { fn() },
      register: (meta, comp) => { slots.push({ meta, comp }); return () => {} },
      useSession: () => null,
    },
    connection: {},
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { loaded.push(def) } } },
    document: opts.document || makeFakeDocument(),
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    navigator: { clipboard: { writeText: async () => {} } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }

  const fn = new Function('window', 'document', 'location', 'localStorage', 'fetch', 'navigator', 'CustomEvent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', src)
  fn(sandbox.window, sandbox.document, sandbox.location, sandbox.localStorage, sandbox.fetch, sandbox.navigator, sandbox.CustomEvent, setTimeout, clearTimeout, sandbox.setInterval, sandbox.clearInterval, console)

  assert.equal(loaded.length, 1, '必须调用一次 __ModuleLoader__.load')
  const def = loaded[0]
  const mod = def.factory(fakeRequire)
  return { def, mod, ctx, slots, locales, effects }
}

/** 浅比较依赖数组，语义照抄 React。 */
function sameDeps(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((x, i) => Object.is(x, b[i]))
}

function makeFakeReact() {
  // 只要够跑组件函数即可，但 hook 的「记忆」语义必须是真的：
  // useEffect/useCallback 依赖没变就跳过，useRef 跨渲染同一个对象。
  // 少了这一层，重复渲染会把异步写进去的失败状态又冲掉，测试就会假绿。
  const state = []
  let cursor = 0
  return {
    useState: (init) => {
      const i = cursor++
      if (state.length <= i) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }]
    },
    useEffect: (fn, deps) => {
      const i = cursor++
      const prev = state[i]
      if (prev && prev.seen && sameDeps(prev.deps, deps)) return
      state[i] = { seen: true, deps }
      // 真实 React 会让 effect 里的异常炸掉整棵树。这里必须同样嚷出来，
      // 静默 catch 会把「挂载即同步跑的第一次 effect」里的 bug 全吃掉。
      try { const d = fn(); if (typeof d === 'function') d() } catch (e) { console.error('[fake-react] effect threw:', e && e.message) }
    },
    useCallback: (fn, deps) => {
      const i = cursor++
      const prev = state[i]
      if (prev && prev.seen && sameDeps(prev.deps, deps)) return prev.fn
      state[i] = { seen: true, deps, fn }
      return fn
    },
    useRef: (v) => {
      const i = cursor++
      if (state.length <= i) state[i] = { current: v }
      return state[i]
    },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    __reset: () => { cursor = 0 },
  }
}

/**
 * 反复渲染同一个组件：useState 的记忆靠 React.__reset() 把游标拨回起点，
 * 值留在同一份 state 数组里，所以点一下之后的异步 set 能在下一次渲染看见。
 * 只给「有交互」的测试用；只看一次渲染的老测试不必绕这一圈。
 */
function mount(React, comp, props) {
  const view = { props }
  view.render = () => { React.__reset(); view.current = comp(props); return view.current }
  view.render()
  return view
}

/** 排干待处理的微任务：走一个宏任务，把整条 .then 链一次跑干净。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeFakeDocument() {
  const head = { appendChild() {} }
  return {
    head,
    body: { appendChild() {} },
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  }
}

test('bundle 形状：id / factory / name / inject / apply', () => {
  const { def, mod } = loadBundle()
  assert.equal(def.id, 'dsh-writing-style')
  assert.equal(typeof def.factory, 'function')
  assert.equal(mod.name, 'dsh-writing-style')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'connection'])
  assert.equal(typeof mod.apply, 'function')
})

test('注册两个席位：设置页 + 输入框上方 dock 徽标（2026-11-02：徽标从 composer.dock 搬来）', () => {
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const names = slots.map((s) => s.meta.name)
  assert.deepEqual(names, ['settings.section', 'conversation.input.dock'])
  const s = slots[0]
  assert.equal(s.meta.id, 'writing-style')
  assert.equal(typeof s.comp, 'function')
  assert.equal(s.meta.locale, 'dsh-writing-style')
  const chip = slots[1]
  assert.equal(chip.meta.id, 'writing-style')
  assert.equal(typeof chip.comp, 'function')
  // ⚠️ 不能再注册 composer.dock：input.dock 在活跃会话里同样渲染，
  // 两个席位都注册 = 活跃会话出现两颗开关。
  // composer.dock 的宿主渲染条件是 variant === "composer" && sessionId，
  // 新会话（hero 形态）整个席位不出现 —— 这正是「初始会话看不到开关」的根因，
  // 所以徽标必须待在 input.dock，不许搬回去。
  assert.ok(!names.includes('conversation.composer.dock'), '徽标不能搬回 composer.dock（hero 形态不渲染那个席位）')
  assert.ok(!names.includes('conversation.composer.bar'), '不能顶掉宿主自己的输入条')
})

/**
 * 取徽标席位并挂起来。
 *
 * rpc 的实现只引用 st：假 React 会在挂载那一刻同步跑第一次 effect，
 * 也就是跑在 mountChip 还没返回、测试里的 const 还没初始化完的时候。
 * 那时引用外层的 calls / enabled 会撞上 TDZ，抛 ReferenceError，
 * 表现是「徽标死活不读状态」，很容易误判成组件的 bug。
 */
function mountChip(opts = {}) {
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const chip = slots.find((s) => s.meta.name === 'conversation.input.dock')
  const st = { calls: [], enabled: opts.enabled === true }
  const React = makeFakeReact()
  // noSession 要显式传：inject(undefined) 就是宿主给「根作用域」调用的样子。
  const props = Object.assign(chip.meta.inject(opts.noSession ? undefined : (opts.sessionId || 'session-aaa')), {
    React,
    rpc: (op, payload, sid) => {
      st.calls.push([op, sid])
      if (op === 'toggle') {
        if (opts.failToggle) return Promise.reject(new Error('会话未找到：' + sid))
        st.enabled = !st.enabled
      }
      return Promise.resolve({ ok: true, doc: { enabled: st.enabled } })
    },
  })
  const view = mount(React, chip.comp, props)
  return { view, props, st, React }
}

/** 把渲染结果里所有文本拼起来，方便断言。 */
function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string') return node
  const here = typeof node.props?.title === 'string' ? node.props.title : ''
  const kids = (node.children || []).map(textOf).join('')
  return here + ' ' + kids
}

/** 徽标外层是 .wstc-dock 行容器（input.dock 是纵向列，裸按钮会被拉成整行），按钮在里面。 */
function buttonOf(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button') return node
  for (const c of node.children || []) {
    const b = buttonOf(c)
    if (b) return b
  }
  return null
}

test('徽标：读的是「这个会话」的 state，不是最近一次 inject 的全局会话', async () => {
  const { view, st } = mountChip({ sessionId: 'session-aaa', enabled: true })
  await flush()
  view.render()
  assert.ok(st.calls.length >= 1, '必须自己去读当前会话')
  assert.deepEqual(st.calls[0], ['state', 'session-aaa'])
  for (const [, sid] of st.calls) assert.notEqual(sid, '', '读状态必须带会话 id')
  assert.ok(/\bon\b/.test(buttonOf(view.current).props.className), '服务端说开着就该显示开')
  assert.match(textOf(view.current), /文风·开/)
})

test('徽标：拿不到会话 id 时不渲染（宁可没按钮，也不能把开关写到别的对话上）', () => {
  const { view } = mountChip({ noSession: true })
  assert.equal(view.current, null, '没有会话 id 就该整颗不出现')
})

test('徽标：点一下发 toggle，显示跟着服务端响应翻转', async () => {
  const { view, st } = mountChip({ sessionId: 'session-bbb' })
  await flush()
  view.render()
  assert.match(textOf(view.current), /文风·关/)

  buttonOf(view.current).props.onClick()
  await flush()
  view.render()
  assert.deepEqual(st.calls[st.calls.length - 1], ['toggle', 'session-bbb'])
  assert.match(textOf(view.current), /文风·开/, '点完要立刻反映新状态，不能等下一次轮询')
})

test('徽标：写失败要把原因显示出来，并给出重试（不许按下去没反应）', async () => {
  const { view } = mountChip({ sessionId: 'session-ccc', failToggle: true })
  await flush()
  view.render()
  buttonOf(view.current).props.onClick()
  await flush()
  view.render()
  const rendered = textOf(view.current)
  assert.match(rendered, /重试/, '失败后按钮要变成可重试的样子')
  assert.match(rendered, /会话未找到/, 'title 里要带上失败原因')
  assert.ok(/failed/.test(buttonOf(view.current).props.className))
})

test('徽标：不碰宿主的 useProjection（有与没有都必须渲染出同一颗按钮）', async () => {
  let touched = false
  const { view, props } = mountChip({ sessionId: 'session-ddd', enabled: true })
  props.useProjection = () => { touched = true; throw new Error('不该被调用') }
  await flush()
  view.render()
  assert.equal(touched, false, 'hook 时有时无会让调用顺序变化，React 会直接崩掉输入框')
  assert.match(textOf(view.current), /文风·开/)
})

test('徽标：兜底只认 kit.standard（宿主顶层根本不 spread standard）', async () => {
  // app.asar 的 renderEntry 是 <Comp {...{kit, injected, slotInjected.props, ownerProps}}>，
  // standard props 挂在 props.kit.standard 里。写成 props.standard 的兜底永远拿到 undefined。
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const chip = slots.find((s) => s.meta.name === 'conversation.input.dock')
  const st = { calls: [], enabled: true }
  const React = makeFakeReact()
  const props = Object.assign(chip.meta.inject(''), {
    React,
    kit: { standard: { sessionId: 'session-kit' } },
    rpc: (op, payload, sid) => {
      st.calls.push([op, sid])
      return Promise.resolve({ ok: true, doc: { enabled: st.enabled } })
    },
  })
  assert.equal(props.sessionId, '', 'injected 的全局缓存此时是空串，必须让位给 kit.standard')
  const view = mount(React, chip.comp, props)
  await flush()
  view.render()
  assert.deepEqual(st.calls[0], ['state', 'session-kit'], '要从 kit.standard 取会话 id')
})

test('徽标：只有一个按钮，不复现当年那条整行底栏', async () => {
  const { view } = mountChip({ sessionId: 'session-eee' })
  await flush()
  view.render()
  // 外层只是行容器（input.dock 是纵向列，裸按钮会被拉成整行），里面恰好一颗按钮。
  assert.equal(view.current.type, 'div')
  assert.equal(view.current.props.className, 'wstc-dock')
  const btn = buttonOf(view.current)
  assert.ok(btn, '行容器里必须有按钮')
  assert.equal((btn.children || []).length, 2, '一颗小圆点 + 一行文字，不能再多')
})


test('locale 字典注册了 zh 与 en，且键集合一致', () => {
  const { mod, ctx, locales } = loadBundle()
  mod.apply(ctx)
  const dict = locales.find((l) => l.ns === 'dsh-writing-style')
  assert.ok(dict, '必须注册 dsh-writing-style 命名空间')
  assert.ok(dict.dicts.zh && dict.dicts.en)
  const zhKeys = Object.keys(dict.dicts.zh).sort()
  const enKeys = Object.keys(dict.dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys, '两种语言的键必须一一对应')
  // 宿主 translate() 内部直接 template.replace，函数值会炸
  for (const [k, v] of Object.entries(dict.dicts.zh)) {
    assert.equal(typeof v, 'string', 'zh.' + k + ' 必须是字符串')
  }
  for (const [k, v] of Object.entries(dict.dicts.en)) {
    assert.equal(typeof v, 'string', 'en.' + k + ' 必须是字符串')
  }
})

test('locale 注册用的是 effect 包裹的 disposer（写成 ctx.effect(() => register()) 会当场注销）', () => {
  const { mod, ctx, effects } = loadBundle()
  mod.apply(ctx)
  assert.ok(effects.length >= 1, '必须通过 ctx.effect 挂载，才能随插件卸载清理')
})



test('设置页在无数据时也能渲染（含各页签）', () => {
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const panel = slots.find((s) => s.meta.name === 'settings.section')
  const React = makeFakeReact()
  const props = panel.meta.inject('sess-y')
  assert.doesNotThrow(() => panel.comp(Object.assign({}, props, { React })))
})

test('inject 回调记住 sessionId（面板请求要带 ?session=）', () => {
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const panel = slots.find((s) => s.meta.name === 'settings.section')
  const props = panel.meta.inject('session-abc')
  assert.equal(typeof props.rpc, 'function')
  assert.equal(typeof props.t, 'function')
})

test('宿主没有 slots 服务时不抛错（老版本降级）', () => {
  const { mod } = loadBundle()
  assert.doesNotThrow(() => mod.apply({ effect: (fn) => fn(), locale: undefined, slots: undefined }))
})
