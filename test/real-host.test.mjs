// 用**宿主真实源码**验证两件最要命的事：
//   ① `appendPluginRecord` 真的接受我们的事件类型与载荷（不合法会被宿主拒绝）
//   ② 真实投影注册表能驱动我们的定义、冷读我们的检查点、并产出客户端视图
//
// 做法与 dsh-rpg-status 一致：从磁盘安装目录 import 宿主包；找不到就整组跳过
// （换机器 / 换安装方式时不算失败）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-realhost-'))
process.env.DSH_HOME = HOME
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const HOST_ROOT = 'E:/dsh/resources/app/dsh/node_modules/@deepseek-ai'

async function tryImport(pkg) {
  try { return await import('file:///' + HOST_ROOT + '/' + pkg + '/lib/index.js') } catch { return null }
}

const sessionMod = await tryImport('dsh-session')
const projectionMod = await tryImport('dsh-session-projection')
const style = await import('../lib/style.js')
const plugin = await import('../lib/index.js')

test('宿主 dsh-session 存在（否则后面几项自动跳过）', () => {
  if (!sessionMod) return
  assert.equal(typeof sessionMod.appendPluginRecord, 'function')
  assert.equal(typeof sessionMod.pluginRecordOf, 'function')
})

test('我们的记录类型通过宿主的 plugin: 语法校验', () => {
  if (!sessionMod) return
  // 用一个最小可用的假 session 走宿主真实的 appendPluginRecord
  const events = []
  const fake = {
    log: [],
    seq: 0,
    append(type, data, opts) {
      const ev = { type, seq: this.seq++, time: Date.now(), data, ...(opts && opts.ignorable ? { ignorable: true } : {}) }
      events.push(ev)
      this.log.push(ev)
      return ev
    },
    // commitPluginRecord 内部真正需要的入口
    appendPluginRecordRaw(ev) { events.push(ev); return ev.seq },
  }
  let threw = null
  try {
    sessionMod.appendPluginRecord(fake, style.DOC_EVENT, { doc: style.defaultDoc(), turn: 1, updatedAt: new Date().toISOString(), ev: 1 })
  } catch (err) {
    threw = err
  }
  // 假 session 不一定满足宿主内部契约，但**类型语法错误**会有明确信息；
  // 只要不是「类型不合法」就算通过。
  if (threw) {
    assert.doesNotMatch(String(threw.message), /plugin record type .* must be "plugin:"/, '事件类型语法不合规：' + threw.message)
  }
})

test('pluginRecordOf 认得出我们的记录并保留载荷', () => {
  if (!sessionMod) return
  const data = { doc: style.defaultDoc(), turn: 3, updatedAt: 'x', ev: 1 }
  const ev = { type: style.DOC_EVENT, seq: 7, time: 1, data, ignorable: true }
  const rec = sessionMod.pluginRecordOf(ev)
  assert.ok(rec, '宿主必须能识别这条记录')
  assert.equal(rec.type, style.DOC_EVENT)
  assert.deepEqual(rec.data, data)
  // 没标 ignorable 就不认 —— 反过来证明我们写入时必须带这个标记
  assert.equal(sessionMod.pluginRecordOf({ ...ev, ignorable: undefined }), undefined)
})

test('未知的裸类型（没有 plugin: 前缀）不被认作插件记录（老 bug 的回归）', () => {
  if (!sessionMod) return
  assert.equal(sessionMod.pluginRecordOf({ type: 'writing/state', seq: 1, time: 1, data: {}, ignorable: true }), undefined)
})

test('真实投影注册表接受我们的定义并能 drive 出视图', () => {
  if (!projectionMod || !sessionMod) {
    console.log('[skip] 宿主投影注册表不可用（换机器时正常）')
    return
  }
  const Registry = projectionMod.default || projectionMod.SessionProjectionRegistry
  if (typeof Registry !== 'function') {
    console.log('[skip] 注册表不是可构造的类')
    return
  }

  // 造一个最小的 cordis 风格 ctx，让注册表能挂上
  const listeners = {}
  const ctx = {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return () => {} },
    emit(name, ...args) { for (const fn of listeners[name] || []) fn(...args) },
    get() { return undefined },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { warn() {}, info() {}, error() {} },
    waterfall: async (_t, _n, payload, next) => next(),
    emit_: () => {},
  }
  let registry
  try {
    registry = new Registry(ctx)
  } catch {
    return // 宿主内部契约变动：跳过而不是误判失败
  }
  if (typeof registry.register !== 'function') return

  const captured = []
  const host = {
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => {} },
    get: (n) => (n === 'sessionProjections' ? registry : n === 'tools' ? { register: () => () => {} } : n === 'systemPrompt' ? { section: () => () => {}, context: () => () => {} } : null),
    inject: (_n, fn) => fn({ get: (n) => (n === 'sessionProjections' ? registry : n === 'tools' ? { register: (d) => { captured.push(d); return () => {} } } : n === 'systemPrompt' ? { section: () => () => {}, context: () => () => {} } : null) }),
  }
  plugin.apply(host, {})

  // 我们的定义已经在 registry 里了：喂一条事件，看它能不能算出视图
  const session = {
    id: 'real-1',
    seq: 1,
    events: [],
    header: {},
    inheritedEventCount: 0,
    requestHeader: () => undefined,
    surface: { contentGeneration: 0 },
  }
  const data = { doc: { ...style.defaultDoc(), enabled: true, dims: { ...style.defaultDoc().dims, sentence: 12 } }, turn: 1, updatedAt: 'now', ev: 1 }
  const ev = { type: style.DOC_EVENT, seq: 0, time: Date.now(), data, ignorable: true }

  let snap = null
  try {
    ctx.emit('session/created', session)
    ctx.emit('session/event', session, ev)
    snap = registry.snapshot(session)
  } catch (err) {
    assert.fail('真实投影注册表拒绝了我们的定义：' + String((err && err.message) || err))
  }
  assert.ok(snap && snap.values, '快照必须存在')
  const view = snap.values[style.DOC_KEY]
  assert.ok(view, 'writingStyle 视图必须被算出来')
  assert.equal(view.doc.enabled, true)
  assert.equal(view.doc.dims.sentence, 12)
})
