// output.schema 的**回归门**。
//
// 事故回放（2026-10-31）：`output.schema` 里 8 处写了 `type: 'json'`，
// 宿主 `tools.register()` 的 assertSupportedJsonSchema 直接抛，
// 于是 4 个工具一个都没注册上（boot.log: tools-registered {"count":0}），
// 而当时本套件 106 项**全绿** —— 因为假宿主根本没跑那道校验。
//
// 这里做两层：
//   ① 用可执行副本（support/host-schema.mjs）断言宿主会拒的形状确实被拒，
//      并让 host.test.mjs 的假宿主在 register 时抛错 → 普通 `node test/run.mjs`
//      就能拦住同类回归；
//   ② 如果本机找得到桌面端 app.asar，就用**真宿主的校验器**跑一遍真实工具的
//      output.schema，并跟副本逐条对账（副本漂没漂，一看便知）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedJsonSchema, hostSchemaViolations, JsonSchemaError } from './support/host-schema.mjs'
import { loadRealHostValidator } from './support/real-host-schema.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-schema-'))
process.env.DSH_HOME = HOME
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const mod = await import('../lib/index.js')

function collectTools() {
  const tools = []
  const noop = () => () => {}
  const services = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    sessionProjections: { register: noop },
    systemPrompt: { section: noop, context: noop, getSectionOrder: () => 0, getContextOrder: () => 0 },
    webServer: { register: noop },
    agents: { list: () => [] },
  }
  const root = {
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    on: noop,
    get: (n) => services[n],
    inject: (names, fn) => {
      if (names.some((n) => !services[n])) return undefined
      const declared = new Set(names)
      return fn({ get: (n) => (declared.has(n) ? services[n] : undefined), agent: null })
    },
  }
  mod.apply(root, {})
  return tools
}

test('副本会拒掉宿主要拒的形状：type:"json"（2026-10-31 事故的精确复现）', () => {
  // 这是当年 8 处里的典型写法
  const bad = { type: 'object', additionalProperties: false, properties: { dims: { type: 'json' } } }
  assert.throws(() => assertSupportedJsonSchema(bad), (err) => {
    assert.ok(err instanceof JsonSchemaError)
    assert.match(err.message, /unsupported JSON schema/)
    assert.match(err.message, /schema\.properties\.dims\.type must be one of object\/array\/string\/number\/integer\/boolean\/null/)
    return true
  })
})

test('副本的允许/拒绝面跟宿主 README 记录一致', () => {
  const ok = [
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { type: 'object', additionalProperties: true } },
    { type: 'string', enum: ['a', 'b'] },
    { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } }, required: ['a'] },
  ]
  for (const s of ok) assert.doesNotThrow(() => assertSupportedJsonSchema(s), JSON.stringify(s))

  const bad = [
    { type: 'json' },
    { type: 'object', properties: { a: { type: 'json' } } },
    { type: ['string', 'null'] },
    { properties: { a: { type: 'string' } } },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', required: ['nope'], properties: { a: { type: 'string' } } },
    { type: 'object', minLength: 2 },
  ]
  for (const s of bad) assert.ok(hostSchemaViolations(s).length > 0, '应拒绝：' + JSON.stringify(s))
})

test('四个工具真的能在「会校验 output.schema 的假宿主」里注册上', () => {
  const tools = collectTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ['style_get', 'style_preset', 'style_rules', 'style_set'])
  for (const t of tools) {
    assert.equal(t.output.schema.type, 'object', t.name + ' 的 output.schema 根部必须是 object')
    assert.doesNotThrow(() => assertSupportedJsonSchema(t.output.schema), t.name + ' 会被宿主拒绝')
  }
})

test('真宿主的校验器（app.asar）也接受这四个 schema，且与副本判断一致', async (t) => {
  const real = await loadRealHostValidator()
  if (!real) {
    t.skip('本机找不到桌面端 app.asar，无法取真宿主校验器（换机器时属正常）')
    return
  }
  try {
    const tools = collectTools()
    assert.ok(tools.length === 4)
    for (const tool of tools) {
      assert.doesNotThrow(() => real.assertSupportedJsonSchema(tool.output.schema),
        tool.name + ' 被真宿主拒绝：' + (hostSchemaViolations(tool.output.schema).join('; ') || ''))
      // 副本也认为没问题 —— 两边判断一致才说明「测试绿」有意义
      assert.deepEqual(hostSchemaViolations(tool.output.schema), [])
    }
    // 反面：真宿主拒掉的形状，副本也必须拒，且文案一致
    const bad = { type: 'object', properties: { a: { type: 'json' } } }
    let realViolations = null
    try { real.assertSupportedJsonSchema(bad) } catch (err) { realViolations = err.violations }
    assert.ok(Array.isArray(realViolations) && realViolations.length > 0, '真宿主应当拒绝 type:"json"')
    assert.deepEqual(hostSchemaViolations(bad), realViolations, '副本与真宿主的诊断必须逐字一致')
  } finally {
    try { rmSync(real.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
