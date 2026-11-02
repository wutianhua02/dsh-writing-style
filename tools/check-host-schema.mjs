#!/usr/bin/env node
// 用**真宿主的校验器**验一遍插件注册的每个工具（output.schema）。
//
// 为什么单开一个工具：`node test/run.mjs` 用的是假宿主（虽然现在它已按宿主规则
// 抛错），但假宿主毕竟是副本。这里直接从桌面端的 app.asar 里把
// @deepseek-ai/dsh-tools/lib/types/json-schema.js 原样切出来执行，跑的是宿主
// `tools.register()` 用的同一段代码 —— 2026-10-31 那次「4 个工具全被退」的
// 事故，只有这条路能提前发现。
//
// 用法：
//   node tools/check-host-schema.mjs                  # 只查本插件
//   node tools/check-host-schema.mjs --plugin=../dsh-rpg-status
//   DSH_ASAR=/path/to/app.asar node tools/check-host-schema.mjs
//
// 退出码：0 = 全部通过（或找不到 asar 而跳过）；1 = 有工具会被真宿主拒绝。
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRealHostValidator, asarCandidates } from '../test/support/real-host-schema.mjs'
import { hostSchemaViolations } from '../test/support/host-schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const pluginArg = args.find((a) => a.startsWith('--plugin='))
const pluginDir = resolve(here, '..', pluginArg ? pluginArg.slice('--plugin='.length) : '.')

// ⚠️ import 插件**之前**隔离 home：apply() 一跑就写启动探针
// （<home>/<plugin>/boot.log）。不隔离的话，跑一次本工具就往用户真实目录里追加
// `apply/tools-registered/route-registered` —— 而那份日志正是「重启后真机到底成没成」
// 的唯一证据（本轮已经踩过两次：verify-installed 与这里）。
// 两个插件的 home 覆盖键都设上，`--plugin=` 查别的插件时也不会漏。
const PROBE_HOME = mkdtempSync(join(tmpdir(), 'dsh-check-schema-'))
process.env.WRITING_STYLE_HOME = PROBE_HOME
process.env.RPG_STATUS_HOME = PROBE_HOME
process.env.DSH_HOME = PROBE_HOME

// ------------------------------------------------------------------ 假宿主
// 只需要能让 apply() 跑起来把工具注册进来；工具 schema 与宿主服务无关。
function collectTools(mod) {
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

// ------------------------------------------------------------------ 对账语料
// 副本（test/support/host-schema.mjs）与真宿主必须对同一批 schema 给出一模一样的
// 违规文案；否则「测试绿」就只是副本绿灯。
const CORPUS = [
  ['合法：宽松 object', { type: 'object', additionalProperties: true }],
  ['合法：精确 object', { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] }],
  ['非法：type json', { type: 'json' }],
  ['非法：嵌套 type json', { type: 'object', properties: { a: { type: 'json' } } }],
  ['非法：type 数组', { type: ['string', 'null'] }],
  ['非法：只有 properties 没有 type', { properties: { a: { type: 'string' } } }],
  ['非法：additionalProperties 写成 schema', { type: 'object', additionalProperties: { type: 'string' } }],
  ['非法：required 不在 properties 里', { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }],
  ['非法：未知关键字', { type: 'object', minimum: 3 }],
  ['非法：items 用在 object 上', { type: 'object', items: { type: 'string' } }],
  ['非法：oneOf 只有一个', { oneOf: [{ type: 'string' }] }],
  ['非法：oneOf 与 type 并存', { type: 'object', oneOf: [{ type: 'string' }, { type: 'number' }] }],
  ['非法：enum 类型不符', { type: 'string', enum: ['a', 1] }],
  ['非法：const 类型不符', { type: 'integer', const: 'x' }],
  ['非法：schema 不是对象', 'nope'],
]

function main() {
  return (async () => {
    const real = await loadRealHostValidator()
    const mod = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href)
    const tools = collectTools(mod)

    console.log(`插件：${pluginDir}`)
    console.log(`工具：${tools.map((t) => t.name).join(', ') || '(一个都没注册上)'}`)

    if (!real) {
      console.log('\n跳过：找不到桌面端的 app.asar，无法取真宿主校验器。')
      console.log('候选路径：\n  ' + asarCandidates().join('\n  '))
      console.log('（假宿主副本仍会在 node test/run.mjs 里跑，这里只是少了一层对账。）')
      return 0
    }
    console.log(`真宿主校验器：${real.asar} :: ${real.moduleFile}`)

    let failed = 0
    console.log('\n— 工具 output.schema —')
    for (const t of tools) {
      try {
        real.assertSupportedJsonSchema(t.output.schema)
        const replica = hostSchemaViolations(t.output.schema)
        if (replica.length) {
          failed++
          console.log(`  ✖ ${t.name}：真宿主放行，但测试副本报违规（副本漂了）：${replica.join('; ')}`)
        } else {
          console.log(`  ✔ ${t.name}`)
        }
      } catch (err) {
        failed++
        console.log(`  ✖ ${t.name}：${err.message}`)
      }
    }

    console.log('\n— 副本 vs 真宿主 对账（同一批 schema 必须给出一致的诊断）—')
    console.log('\n— 工具 parameters —')
    // parameters 宿主**不校验**：`tools.register()` 只验 output.schema，参数会原样
    // 发给上游（dsh-llm-pi-ai 里就是 `parameters: tool.parameters`）。所以这里主动补一道：
    // ① 根部必须是 type:'object'（少了它会报 `got 'type: null'`，2026-10-31 整轮拒答）；
    // ② 也必须落在宿主支持的 schema 子集里，免得哪天上游按同一个子集收紧。
    for (const t of tools) {
      const params = t.parameters
      if (!params || typeof params !== 'object' || params.type !== 'object') {
        failed++
        console.log(`  ✖ ${t.name}：parameters 根部不是 type:'object'（上游会报 got 'type: null'）`)
        continue
      }
      try {
        real.assertSupportedJsonSchema(params)
        const replica = hostSchemaViolations(params)
        if (replica.length) {
          failed++
          console.log(`  ✖ ${t.name}：真宿主放行，但测试副本报违规（副本漂了）：${replica.join('; ')}`)
        } else {
          console.log(`  ✔ ${t.name}（${Object.keys(params.properties || {}).length} 个参数）`)
        }
      } catch (err) {
        failed++
        console.log(`  ✖ ${t.name}：${err.message}`)
      }
    }

    console.log('\n— 副本 vs 真宿主 对账（同一批 schema 必须给出一致的诊断）—')
    for (const [label, schema] of CORPUS) {
      let realMsg = null
      try { real.assertSupportedJsonSchema(schema) } catch (err) { realMsg = err.violations || err.message }
      const replicaMsg = hostSchemaViolations(schema)
      const realList = Array.isArray(realMsg) ? realMsg : (realMsg ? [realMsg] : [])
      const same = JSON.stringify(realList) === JSON.stringify(replicaMsg)
      if (!same) {
        failed++
        console.log(`  ✖ ${label}`)
        console.log(`      真宿主：${JSON.stringify(realList)}`)
        console.log(`      副本  ：${JSON.stringify(replicaMsg)}`)
      } else {
        console.log(`  ✔ ${label}${realList.length ? '（' + realList.length + ' 条违规，一致）' : ''}`)
      }
    }

    try { rmSync(real.dir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(PROBE_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

    console.log(failed ? `\n失败：${failed} 处` : '\n全部通过：真宿主的校验器接受每一个工具的 output.schema')
    return failed ? 1 : 0
  })()
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
