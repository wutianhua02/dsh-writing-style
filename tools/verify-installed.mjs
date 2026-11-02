#!/usr/bin/env node
// 验证**安装副本**（宿主真正加载的那份），而不是工作区源码。
//
// 为什么单开一个：`node test/run.mjs` 跑的是 `../lib/index.js`（工作区）。
// 桌面端 import 的是 <home>/profiles/desktop/node_modules/dsh-writing-style ——
// 两个地方**可能不是同一份**（同步没跑、或硬链接被 rm+cp 切断）。历史上就是
// 「我以为改好了」和「宿主读到的还是旧的」之间的差值。
//
// 这里用**严格 Cordis 假宿主**（sctx 只给 get(name)、且只回答本块声明过的服务；
// 缺任何一个声明服务 → 整块不跑），检查三件事：
//   ① 4 个工具都注册上（output.schema 先过真宿主校验器，若能取到）
//   ② 面板路由真的挂在 /dsh-writing-style（等价于真机 boot.log 的 route-registered）
//   ③ 注入段与触发性条目都注册了
//
// 用法：node tools/verify-installed.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRealHostValidator, asarCandidates } from '../test/support/real-host-schema.mjs'

// ⚠️ 在 import 插件**之前**把 home 指到临时目录：apply() 每次都写启动探针
// （<home>/writing-style/boot.log）。不隔离的话，跑一次本工具就往你真实目录里追加
// `apply/tools-registered count:4/route-registered` —— 而 boot.log 正是判断
// 「重启后真机到底成没成」的唯一证据，工具自己写进去等于伪造验收。
const PROBE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-verify-installed-'))
process.env.WRITING_STYLE_HOME = PROBE_HOME

const here = path.dirname(fileURLToPath(import.meta.url))
const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const profile = path.join(home, '.dsh', 'profiles', 'desktop')

const candidates = [
  path.join(profile, 'node_modules', 'dsh-writing-style'),
  path.join(profile, 'vendor', 'dsh-writing-style'),
].filter((d) => { try { return fs.statSync(path.join(d, 'lib/index.js')).isFile() } catch { return false } })

if (!candidates.length) {
  console.error(`安装位置找不到 dsh-writing-style（${profile}）—— 先跑 node tools/sync-to-profile.mjs`)
  process.exit(1)
}

/** 严格 Cordis：只回答声明过的服务；缺服务则整块不跑。 */
function strictHost(tools, routes, sections, contexts, omit = new Set()) {
  const noop = () => () => {}
  const services = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    sessionProjections: { register: noop },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, context: (c) => { contexts.push(c); return () => {} } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    agents: { list: () => [] },
  }
  for (const k of omit) delete services[k]
  return {
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    on: noop,
    get: (n) => services[n],
    inject: (names, fn) => {
      if (names.some((n) => !services[n])) return undefined
      const declared = new Set(names)
      return fn({ get: (n) => (declared.has(n) ? services[n] : undefined), agent: null })
    },
  }
}

async function main() {
  const real = await loadRealHostValidator()
  let failed = 0
  for (const dir of candidates) {
    console.log(`\n### ${dir.replace(home + path.sep, '')}`)
    const tools = [], routes = [], sections = [], contexts = []
    // 每次用唯一的 query 绕开 ESM 缓存，保证测的是磁盘上的当前内容
    const mod = await import(pathToFileURL(path.join(dir, 'lib/index.js')).href + '?v=' + Date.now())

    mod.apply(strictHost(tools, routes, sections, contexts), {})

    const names = tools.map((t) => t.name).sort()
    const want = ['style_get', 'style_preset', 'style_rules', 'style_set']
    const toolsOk = JSON.stringify(names) === JSON.stringify(want)
    console.log(`  ${toolsOk ? '✔' : '✖'} 工具：${names.join(', ') || '(一个都没有)'}${toolsOk ? '' : `　期望 ${want.join(', ')}`}`)
    if (!toolsOk) failed++

    if (real) {
      for (const t of tools) {
        try { real.assertSupportedJsonSchema(t.output.schema); console.log(`  ✔ 真宿主接受 ${t.name} 的 output.schema`) }
        catch (err) { failed++; console.log(`  ✖ ${t.name} 会被真宿主拒绝：${err.message}`) }
      }
    } else {
      console.log('  · 跳过 output.schema 真宿主复核（找不到 app.asar；候选：' + asarCandidates().slice(0, 2).join(' | ') + '）')
    }

    // ⚠️ parameters 的上游契约（2026-11-01 那次「整轮报错」就是这里没满足）：
    // 直接注册的工具，宿主把 parameters **原样**发给上游；裸映射 → type:null →
    // 「Invalid schema for function 'style_get': schema must be a JSON Schema of 'type: "object"'」。
    for (const t of tools) {
      const p = t.parameters || {}
      const ok = p.type === 'object' && !!p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties)
      console.log(`  ${ok ? '✔' : '✖'} ${t.name} 的 parameters 是 object 根（type=${JSON.stringify(p.type)}，参数 ${Object.keys(p.properties || {}).length} 个）`)
      if (!ok) failed++
    }

    const routeOk = routes.length === 1 && routes[0].path === '/dsh-writing-style'
    console.log(`  ${routeOk ? '✔' : '✖'} 面板路由：${routeOk ? routes[0].path : `注册数 ${routes.length}（真机会是 route-skipped）`}`)
    if (!routeOk) failed++

    const injectOk = sections.some((s) => s.name === 'writing-style:directive') && typeof (sections.find((s) => s.name === 'writing-style:directive') || {}).text === 'function'
    console.log(`  ${injectOk ? '✔' : '✖'} 注入段：writing-style:directive${injectOk ? '（正文走 text）' : ' 缺失或没有 text'}`)
    if (!injectOk) failed++
    const ctxOk = contexts.some((c) => c.name === 'writing-style:rules')
    console.log(`  ${ctxOk ? '✔' : '✖'} 触发性条目上下文：writing-style:rules`)
    if (!ctxOk) failed++

    // 没有 webServer 的宿主形态：工具照常、只是没有面板路由
    const t2 = [], r2 = [], s2 = [], c2 = []
    const mod2 = await import(pathToFileURL(path.join(dir, 'lib/index.js')).href + '?v2=' + Date.now())
    mod2.apply(strictHost(t2, r2, s2, c2, new Set(['webServer'])), {})
    const degradeOk = t2.length === 4 && r2.length === 0
    console.log(`  ${degradeOk ? '✔' : '✖'} 无 webServer 的宿主：工具 ${t2.length} 个、路由 ${r2.length} 个（应 4 / 0）`)
    if (!degradeOk) failed++
  }
  if (real) { try { fs.rmSync(real.dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  try { fs.rmSync(PROBE_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(failed
    ? `\n✖ 有 ${failed} 项不达标 —— 安装副本不可用（先 sync，再检查是否被 rm+cp 切断了硬链接）`
    : '\n安装副本检查通过。真机生效仍需**重启桌面端**，然后看 <home>/writing-style/boot.log：\n'
      + '  期望：tools-registered {"count":4} + route-registered {"route":"/dsh-writing-style"}\n'
      + '  （本工具的探针写在临时目录，不会污染那份日志。）')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
