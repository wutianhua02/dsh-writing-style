// 「预设页签一片空白」的回归测试（2026-11-01 真机现象）。
//
// 现场：打开设置页 → 写作风格 → 预设页签**一个卡都没有**；页签上方先有一条提示文字，
// 点一下「刷新」之后 10 张卡又都回来了。根因不是数据（服务端 200、10 条预设），
// 而是**首次 /state 失败后客户端不再自己重试**：
//   4s 超时（页面首屏要跑 8MB 插件包）→ abort → health 进入退避 →
//   45s 轮询一次次撞在退避窗口上 → 面板一直空着。
//
// 这里钉四件事：
//   ① 首次请求失败后**自动**重试（不需要用户点刷新）；
//   ② 失败时若缓存里有上一次成功的数据，第一帧就有预设，绝不白屏；
//   ③ 真的什么都没有时给出「正在连接 / 自动重试」提示，而不是像空库；
//   ④ 手动刷新能绕过退避窗口（`force`），否则用户点了也没反应。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = new URL('../client.js', import.meta.url)

const PAYLOAD = {
  ok: true,
  doc: { enabled: true, preset: 'balanced', presetName: '均衡', dims: { sentence: 45 }, directives: '', sample: '', avoid: [], prefer: [], rules: [] },
  dimsMeta: [{ key: 'sentence', label: '句式长度', kind: 'scale', def: 45 }],
  presets: Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, name: '预设' + i, desc: '', custom: i === 9 })),
  directive: '', summary: '', hasSession: true,
  storage: { file: 'C:/x/presets.json', home: 'C:/x', homeFrom: 'host-package', error: '' },
}

/** 可控定时器（bundle 里的 setTimeout/clearTimeout/setInterval 都走它）。 */
function makeTimers() {
  let next = 1
  const pending = new Map()
  return {
    setTimeout(fn, delay) { const id = next++; pending.set(id, { fn, delay, interval: false }); return id },
    clearTimeout(id) { pending.delete(id) },
    setInterval(fn, delay) { const id = next++; pending.set(id, { fn, delay, interval: true }); return id },
    clearInterval(id) { pending.delete(id) },
    /** 跑掉所有 delay <= max 的一次性定时器（按 delay 升序）。 */
    flush(max = Infinity) {
      const due = [...pending.entries()].filter(([, t]) => !t.interval && t.delay <= max).sort((a, b) => a[1].delay - b[1].delay)
      for (const [id, t] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        try { t.fn() } catch { /* ignore */ }
      }
    },
    delays() { return [...pending.values()].filter((t) => !t.interval).map((t) => t.delay).sort((a, b) => a - b) },
  }
}

const settle = async () => {
  // 让 async/fetch/rpc 的整条 promise 链落地（微任务 + 一轮宏任务更稳）
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

/** 依赖感知的迷你 React：state 改了要手动再 render 一次（这里由 settleAndRender 代劳）。 */
function makeReact() {
  let idx = 0
  const slots = {}
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  const React = {
    useState(init) {
      const i = idx++
      if (!(i in slots)) slots[i] = { v: typeof init === 'function' ? init() : init }
      const cell = slots[i]
      return [cell.v, (nv) => { cell.v = typeof nv === 'function' ? nv(cell.v) : nv }]
    },
    useRef(v) { const i = idx++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
    useCallback(f, deps) { const i = idx++; if (!(i in slots)) slots[i] = { f, deps }; return slots[i].f },
    useEffect(fn, deps) {
      const i = idx++
      const prev = slots[i]
      if (prev && same(prev.deps, deps)) return
      if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup() } catch { /* ignore */ } }
      const cleanup = fn()
      slots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    },
    createElement(type, props, ...kids) {
      if (typeof type === 'function') return type(Object.assign({}, props, { children: kids }))
      return { type, props: props || {}, kids }
    },
    Fragment: 'Fragment',
  }
  return { React, reset() { idx = 0 }, slots }
}

function loadClient({ timers, fetchImpl, sessionStorage: ss }) {
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
    ss, fetchImpl,
    { clipboard: { writeText: async () => {} } },
    class {}, timers.setTimeout, timers.clearTimeout, timers.setInterval, timers.clearInterval, console,
  )
  return loaded[0]
}

function mount({ timers, fetchImpl, sessionStorage: ss = { getItem: () => null, setItem: () => {} } }) {
  const R = makeReact()
  const def = loadClient({ timers, fetchImpl, sessionStorage: ss })
  const mod = def.factory((id) => { if (id === 'react') return R.React; throw new Error('unexpected require: ' + id) })
  const registered = []
  mod.apply({
    effect: (f) => { try { f() } catch { /* ignore */ } return () => {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, f) => f(), register: (m, c) => { registered.push({ meta: m, comp: c }); return () => {} }, useSession: () => null },
    connection: {},
  })
  const panel = registered.find((x) => x.meta.name === 'settings.section')
  if (!panel) throw new Error('没有注册 settings.section')
  const props = Object.assign({}, panel.meta.inject('s1'), { React: R.React, useProjection: () => ({ doc: null }) })
  /** 渲染一次 + 让 promise 落地 + 再渲染，模拟 React 重渲染。 */
  const render = async (times = 3) => {
    let out = null
    for (let i = 0; i < times; i++) {
      R.reset()
      out = panel.comp(props)
      await settle()
    }
    return out
  }
  return { render, R, panel, props }
}

function countPresetCards(node, acc = { cards: 0, texts: [] }) {
  if (!node) return acc
  if (Array.isArray(node)) { for (const c of node) countPresetCards(c, acc); return acc }
  if (typeof node !== 'object') return acc
  const cls = node.props && node.props.className
  // 只数卡片本体（button.wst-preset / wst-preset active），别把里面的 span 也算一张
  if (typeof cls === 'string' && /^wst-preset(\s|$)/.test(cls)) acc.cards += 1
  for (const k of node.kids || []) {
    if (typeof k === 'string') acc.texts.push(k)
    countPresetCards(k, acc)
  }
  return acc
}

/** 找到某个按钮并点它（按标签文字）。 */
function clickButton(node, label) {
  if (!node) return false
  if (Array.isArray(node)) return node.some((c) => clickButton(c, label))
  if (typeof node !== 'object') return false
  const kids = node.kids || []
  if (node.type === 'button' && kids.includes(label) && typeof node.props.onClick === 'function') {
    node.props.onClick()
    return true
  }
  return kids.some((c) => clickButton(c, label))
}

// ---------------------------------------------------------------- ① 失败后自动重试

test('首次 /state 失败后会自动重试，预设卡自己出现（不用手点刷新）', async () => {
  const timers = makeTimers()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) throw new Error('network down')
    return { ok: true, json: async () => PAYLOAD }
  }
  const { render } = mount({ timers, fetchImpl })
  const first = await render(2)
  assert.equal(countPresetCards(first).cards, 0, '前提：首次失败时还没有卡')
  assert.ok(calls >= 1, '应该真的发过请求')

  // 失败后必须挂上一个短间隔重试定时器（不是等 45s 轮询）
  const delays = timers.delays()
  assert.ok(delays.some((d) => d > 0 && d <= 5000), '应安排一次短间隔自动重试，实际定时器：' + JSON.stringify(delays))

  timers.flush(5000)
  await settle()
  const later = await render(3)
  assert.equal(countPresetCards(later).cards, 10, '自动重试后应渲染出 10 张预设卡')
  assert.ok(calls >= 2, '应该重试过（fetch 调用次数 ' + calls + '）')
})

// ---------------------------------------------------------------- ② 有缓存不白屏

test('请求失败但有上次成功的数据时，第一帧就显示预设（不白屏）', async () => {
  const timers = makeTimers()
  const store = new Map([['dsh-writing-style/state', JSON.stringify(PAYLOAD)]])
  const ss = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  let calls = 0
  const fetchImpl = async () => { calls += 1; throw new Error('still down') }
  const { render } = mount({ timers, fetchImpl, sessionStorage: ss })
  const out = await render(1)
  assert.equal(countPresetCards(out).cards, 10, '缓存里有数据时首帧就该有 10 张卡')
  assert.ok(calls >= 0)
})

// ---------------------------------------------------------------- ③ 没有数据时要有话说

test('真的没数据时给出「正在连接」提示，而不是像空库', async () => {
  const timers = makeTimers()
  const fetchImpl = async () => { throw new Error('down') }
  const { render } = mount({ timers, fetchImpl })
  const out = await render(2)
  const acc = countPresetCards(out)
  assert.equal(acc.cards, 0)
  const text = acc.texts.join('|')
  assert.ok(/正在连接|自动重试|连接失败/.test(text), '应给出连接中的提示，实际文案：' + text.slice(0, 120))
})

// ---------------------------------------------------------------- ④ 手动刷新绕过退避

test('失败进入退避后，点「刷新」仍然会真的发请求（force 绕过退避）', async () => {
  const timers = makeTimers()
  let calls = 0
  let mode = 'fail'
  const fetchImpl = async () => {
    calls += 1
    if (mode === 'fail') throw new Error('down')
    return { ok: true, json: async () => PAYLOAD }
  }
  const { render } = mount({ timers, fetchImpl })
  await render(2)                      // 第一次失败 → 进入退避窗口
  const before = calls
  mode = 'ok'
  const out = await render(1)
  const clicked = clickButton(out, '刷新')
  assert.equal(clicked, true, '面板上应有「刷新」按钮')
  await settle()
  assert.ok(calls > before, `点了刷新应该真的发请求（之前 ${before} 次，现在 ${calls} 次）——被退避挡掉就是这里挂`)
  const after = await render(2)
  assert.equal(countPresetCards(after).cards, 10, '刷新成功后应显示预设卡')
})
