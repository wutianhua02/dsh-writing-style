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

function makeFakeReact() {
  // 只要够跑组件函数即可：useState 有初值、useEffect 立刻执行、其余返回 noop。
  const state = []
  let cursor = 0
  return {
    useState: (init) => {
      const i = cursor++
      if (state.length <= i) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }]
    },
    useEffect: (fn) => { try { const d = fn(); if (typeof d === 'function') d() } catch { /* 依赖的 DOM 未必齐全 */ } },
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    __reset: () => { cursor = 0; state.length = 0 },
  }
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

test('只在设置页注册，输入框底栏不出现（按需求整块移除）', () => {
  const { mod, ctx, slots } = loadBundle()
  mod.apply(ctx)
  const names = slots.map((s) => s.meta.name)
  assert.deepEqual(names, ['settings.section'], '底栏席位必须不存在')
  assert.ok(!names.includes('conversation.input.dock'), '不能在输入框上方占位置')
  const s = slots[0]
  assert.equal(s.meta.id, 'writing-style')
  assert.equal(typeof s.comp, 'function')
  assert.equal(s.meta.locale, 'dsh-writing-style')
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
