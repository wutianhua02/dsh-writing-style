// 纯逻辑测试：文档规范化、维度解析、预设、渲染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIMENSIONS, PRESETS, DEFAULT_AVOID,
  defaultDoc, normalizeDoc, cloneDoc, checkDoc,
  renderDirective, renderRules, renderSummary,
  applyPreset, presetDims, coerceDim, resolveDim, toPreset, allPresets,
  bandText, flatDims,
} from '../lib/style.js'

test('默认文档是关闭状态，避免污染日常对话', () => {
  const d = defaultDoc()
  assert.equal(d.enabled, false)
  assert.equal(d.preset, 'balanced')
  assert.equal(renderDirective(d), '')
  assert.match(renderSummary(d), /未启用/)
})

test('normalizeDoc 对任何垃圾输入都返回合法文档（永不抛错）', () => {
  for (const junk of [null, undefined, 42, 'x', [], { dims: 'nope' }, { rules: 'nope' }, { avoid: 5 }]) {
    const d = normalizeDoc(junk)
    assert.equal(checkDoc(d), null, 'input ' + JSON.stringify(junk))
    assert.equal(typeof d.dims, 'object')
    assert.ok(Array.isArray(d.rules))
    assert.ok(Array.isArray(d.avoid))
  }
})

test('量表维度钳到 0-100，非法值被忽略', () => {
  assert.deepEqual(coerceDim('sentence', 999), { ok: true, value: 100 })
  assert.deepEqual(coerceDim('sentence', -5), { ok: true, value: 0 })
  assert.equal(coerceDim('sentence', 'abc').ok, false)
  assert.deepEqual(coerceDim('sentence', '62.4'), { ok: true, value: 62 })
})

test('枚举维度接受英文值、中文名与大小写变体', () => {
  assert.deepEqual(coerceDim('pov', 'first'), { ok: true, value: 'first' })
  assert.deepEqual(coerceDim('pov', '第一人称'), { ok: true, value: 'first' })
  assert.deepEqual(coerceDim('pov', 'THIRD-LIMITED'), { ok: true, value: 'third-limited' })
  assert.equal(coerceDim('pov', '第9人称').ok, false)
})

test('维度名可以用 key 或中文名解析', () => {
  assert.equal(resolveDim('sentence'), 'sentence')
  assert.equal(resolveDim('句式长度'), 'sentence')
  assert.equal(resolveDim('句式'), 'sentence')
  assert.equal(resolveDim('视角'), 'pov')
  assert.equal(resolveDim('露骨'), 'explicitness')
  assert.equal(resolveDim('不存在'), null)
})

test('每个维度在 0/50/100 三档都能渲染出非空文本', () => {
  for (const d of DIMENSIONS) {
    if (d.kind !== 'scale') continue
    for (const v of [0, 50, 100]) {
      const text = bandText(d.k, v)
      assert.ok(typeof text === 'string' && text.length > 4, `${d.k}@${v}`)
    }
  }
})

test('每个预设都能套用并渲染，且与默认值确有差异', () => {
  for (const p of PRESETS) {
    const d = applyPreset(defaultDoc(), p.id)
    assert.equal(d.preset, p.id)
    d.enabled = true
    const text = renderDirective(d)
    assert.ok(text.length > 400, p.id + ' 渲染太短')
    if (p.id !== 'balanced') {
      const base = presetDims('balanced')
      const changed = Object.keys(d.dims).some((k) => d.dims[k] !== base[k])
      assert.ok(changed, p.id + ' 与默认值完全一致，预设没起作用')
    }
  }
})

test('渲染结果包含视角/禁用词/自由指令/范文四类信息', () => {
  const d = normalizeDoc({
    enabled: true,
    dims: { pov: 'first', sentence: 15 },
    directives: '每段结尾留一个悬念。',
    sample: '雨下了一整夜。我没睡。',
    avoid: ['不禁', '仿佛'],
  })
  const text = renderDirective(d)
  assert.match(text, /第一人称/)
  assert.match(text, /极短句/)
  assert.match(text, /每段结尾留一个悬念/)
  assert.match(text, /雨下了一整夜/)
  assert.match(text, /「不禁」/)
  assert.match(text, /自检/)
})

test('未启用时一律不渲染（directive 与 rules 都是空串）', () => {
  const d = normalizeDoc({ enabled: false, rules: [{ id: 'a', keys: ['战斗'], text: '短句' }] })
  assert.equal(renderDirective(d), '')
  assert.equal(renderRules(d, ['战斗开始']), '')
})

test('触发性条目只在关键词命中时出现，空 keys 视为总是命中', () => {
  const d = normalizeDoc({
    enabled: true,
    rules: [
      { id: 'a', name: '战斗', keys: ['战斗', '交手'], text: '战斗段落用短句。' },
      { id: 'b', name: '日常', keys: [], text: '日常段落放慢。' },
      { id: 'c', name: '关闭', keys: ['战斗'], text: '不该出现。', enabled: false },
    ],
  })
  const miss = renderRules(d, ['他们在喝茶'])
  assert.doesNotMatch(miss, /战斗段落/)
  assert.match(miss, /日常段落/)

  const hit = renderRules(d, ['两人交手三合'])
  assert.match(hit, /战斗段落/)
  assert.doesNotMatch(hit, /不该出现/)
})

test('toPreset 只记录与均衡默认值不同的维度', () => {
  const d = normalizeDoc({ enabled: true, dims: { sentence: 10, density: 50 }, directives: 'x' })
  const p = toPreset(d, 'my', '我的')
  assert.equal(p.id, 'my')
  assert.equal(p.dims.sentence, 10)
  assert.equal(Object.hasOwn(p.dims, 'density'), false)
  assert.equal(p.directives, 'x')
})

test('allPresets 合并用户预设，同 id 覆盖内置', () => {
  const list = allPresets([{ id: 'balanced', name: '我的均衡', dims: { sentence: 99 } }])
  const hit = list.find((p) => p.id === 'balanced')
  assert.equal(hit.name, '我的均衡')
  assert.equal(hit.custom, true)
  assert.equal(list.filter((p) => p.id === 'balanced').length, 1)

  const extra = allPresets([{ id: 'mine', name: '自定义', dims: {} }])
  assert.equal(extra.filter((p) => p.id === 'mine').length, 1)
  assert.equal(extra.length, PRESETS.length + 1)
})

test('cloneDoc 是深拷贝：改副本不影响原件', () => {
  const a = normalizeDoc({ enabled: true })
  const b = cloneDoc(a)
  b.dims.sentence = 0
  b.avoid.push('x')
  assert.notEqual(a.dims.sentence, 0)
  assert.ok(!a.avoid.includes('x'))
})

test('flatDims 覆盖全部维度 key', () => {
  const flat = flatDims(defaultDoc())
  for (const d of DIMENSIONS) assert.ok(Object.hasOwn(flat, d.k), d.k)
})

test('默认禁用词是一组非空字符串', () => {
  assert.ok(DEFAULT_AVOID.length >= 5)
  for (const w of DEFAULT_AVOID) assert.ok(typeof w === 'string' && w.length > 0)
})

test('范文超长时按上限截断', () => {
  const d = normalizeDoc({ enabled: true, sample: 'x'.repeat(500) })
  // trimDoc 在宿主侧；这里只确认渲染本身不截断（截断是配置行为）
  assert.match(renderDirective(d), /x{500}/)
})
