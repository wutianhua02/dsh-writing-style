// 工具 parameters 的**上游契约**：必须是标准 JSON Schema（object 根）。
//
// 事故回放（2026-11-01）：写作风格的 4 个工具把 `parameters` 写成了「属性名 → schema」
// 的**裸映射**（`{ presets: { type:'boolean' } }`）。宿主 `tools.register()` 只校验
// `output.schema`，**不编译 parameters** —— 直接注册时这个对象会被**原样**发给上游，
// 上游（OpenAI 形状的 function schema）于是整轮失败：
//
//   Invalid schema for function 'style_get': schema must be a JSON Schema of
//   'type: "object"', got 'type: null'.
//
// 症状特别隐蔽：boot.log 是 `tools-registered {"count":4}`、面板正常、测试全绿，
// 但**每一轮对话都报错**（模型侧根本拿不到工具）。
//
// 所以这里钉死：每个工具的 parameters 必须是
//   { type:'object', additionalProperties:<boolean|省略>, properties:{ 名字 → 合法子 schema } }
// 并且 `required` 里的名字必须真的在 properties 里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostSchemaViolations } from './support/host-schema.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-tool-schema-'))
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

const tools = collectTools()

test('四个工具都注册上了（前置条件）', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), ['style_get', 'style_preset', 'style_rules', 'style_set'])
})

test('parameters 根部必须是 type:"object"（否则上游整轮报错）', () => {
  for (const t of tools) {
    const p = t.parameters
    assert.ok(p && typeof p === 'object' && !Array.isArray(p), `${t.name}: parameters 必须是个对象`)
    // 这条就是上游的原话：schema must be a JSON Schema of 'type: "object"'
    assert.equal(p.type, 'object', `${t.name}: parameters.type 必须是 "object"（现在是 ${JSON.stringify(p.type)}）`)
    assert.ok(p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties),
      `${t.name}: parameters.properties 必须是对象`)
  }
})

test('parameters 里不能再出现「裸映射」形状（键名就是参数名、没有 type/properties）', () => {
  const schemaKeywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'oneOf', 'description', 'title', 'default', 'examples'])
  for (const t of tools) {
    const p = t.parameters
    const keys = Object.keys(p)
    const looksLikeMap = keys.length > 0 && !keys.some((k) => schemaKeywords.has(k))
    assert.equal(looksLikeMap, false, `${t.name}: parameters 看起来还是裸映射（键：${keys.join(', ')}）`)
  }
})

test('每个参数的子 schema 都合法、required 的名字都在 properties 里', () => {
  for (const t of tools) {
    const p = t.parameters
    if (p.additionalProperties !== undefined) {
      assert.equal(typeof p.additionalProperties, 'boolean', `${t.name}: additionalProperties 必须是布尔`)
    }
    for (const [name, sub] of Object.entries(p.properties)) {
      assert.ok(sub && typeof sub === 'object', `${t.name}.${name}: 子 schema 必须是对象`)
      assert.equal(typeof sub.type, 'string', `${t.name}.${name}: 缺 type（上游会拒）`)
      assert.deepEqual(hostSchemaViolations(sub, `schema.properties.${name}`), [],
        `${t.name}.${name}: 子 schema 不合宿主要求`)
    }
    if (p.required !== undefined) {
      assert.ok(Array.isArray(p.required), `${t.name}: required 必须是数组`)
      for (const name of p.required) {
        assert.ok(Object.hasOwn(p.properties, name), `${t.name}: required 里的 "${name}" 不在 properties 里`)
      }
    }
  }
})

test('序列化后根部带 "type":"object"（这是发给上游的最终形态）', () => {
  for (const t of tools) {
    const wire = JSON.parse(JSON.stringify({ name: t.name, parameters: t.parameters }))
    assert.equal(wire.parameters.type, 'object', `${t.name}: 线上 schema 的 type 不能是 null`)
    assert.doesNotThrow(() => JSON.stringify(wire))
  }
})

test('注册守卫 toolParametersProblem：裸映射/缺 properties 都要说出原因', () => {
  const check = mod.toolParametersProblem
  assert.equal(typeof check, 'function', '守卫函数应导出（apply 里注册前调它）')

  // 裸映射 —— 2026-11-01 真机事故的精确形状
  assert.match(check({ presets: { type: 'boolean' } }), /type 必须是 'object'/)
  // 完全没写
  assert.match(check(undefined), /缺失/)
  // 有 type 但没有 properties
  assert.match(check({ type: 'object' }), /properties/)
  // 合法：零参数也必须显式写 properties
  assert.equal(check({ type: 'object', additionalProperties: false, properties: {} }), null)
  assert.equal(check({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }), null)
})
