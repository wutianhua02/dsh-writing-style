// 反向验证：把代码改回「旧写法」，确认对应测试会**失败**。
// 作用：证明那些测试不是摆设 —— 如果测试对旧 bug 也放行，它就失去意义。
// 实现：整个插件复制到临时目录，只覆盖要变形的文件，工作区不动。
//
// 覆盖的 3 个变体（都是真机事故，不是假想的）：
//   ① output.schema 用 type:'json' —— 2026-10-31 真机 4 个工具全被退（count:0）
//   ② 路由块声明错服务 —— 真机 route-skipped，面板空白且不报错
//   ③ prompt section 用 provider 而不是 text —— 宿主静默忽略，注入永远是空
// 另加 2 个「什么都没改」的对照。
//
// 子进程必须真的跑出测试汇总行（`ℹ tests N`）才算数；只是「退出码非 0」
// 可能是模块加载失败，那种情况一律判 harness 失效（RPG 那份踩过这个坑）。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('..', import.meta.url))
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-negative-'))
  for (const rel of ['lib', 'client', 'test', 'package.json', 'client.js']) {
    try { cpSync(join(src, rel), join(dir, rel), { recursive: true }) } catch { /* 可选文件 */ }
  }
  return dir
}

function runSuite(label, { files, testFile }, hintRe) {
  const dir = freshCopy()
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf8')
    }
    const r = spawnSync(process.execPath, [join(dir, 'test', testFile)], { encoding: 'utf8', cwd: dir, timeout: 180000 })
    const text = out(r)
    const ran = /ℹ (tests|pass|fail) \d+/.test(text)
    const caught = ran && r.status !== 0
    if (!ran) {
      console.log(`✖ ${label}：harness 失效，测试根本没跑起来`)
      console.log('   ' + text.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 160))
    } else if (caught) {
      const hint = text.split('\n').filter((l) => hintRe.test(l)).slice(0, 1).join('')
      console.log(`✔ ${label}：测试正确捕获旧 bug`)
      if (hint) console.log('   ' + hint.trim().slice(0, 140))
    } else {
      console.log(`✖ ${label}：测试跑了但全绿 —— 断言没覆盖这个 bug`)
    }
    return caught
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 交给系统回收 */ }
  }
}

const results = []
const indexSrc = fs.readFileSync(join(src, 'lib', 'index.js'), 'utf8')

// ── ① output.schema 用 type:'json'
//    真机 boot.log：tool-failed "…dims.type must be one of object/array/…" ×4 → count:0
//    期望：host-schema.test.mjs 与 host.test.mjs 都必须失败（假宿主现在照宿主抛错）。
{
  const old = indexSrc.replace(
    "dims: { type: 'object', additionalProperties: true },",
    "dims: { type: 'json' },",
  )
  if (old === indexSrc) {
    console.log('✖ type:json 变体没打上（lib/index.js 里 style_get 的 dims schema 变了，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('output.schema 用 type:json（真机 4 个工具全被退）', {
      files: { 'lib/index.js': old },
      testFile: 'host-schema.test.mjs',
    }, /must be one of object\/array|会被宿主拒绝|AssertionError/))
    results.push(runSuite('output.schema 用 type:json（假宿主 register 必须抛）', {
      files: { 'lib/index.js': old },
      testFile: 'host.test.mjs',
    }, /must be one of object\/array|四个工具|JsonSchemaError|AssertionError/))
  }
}

// ── ② 路由块声明了错的服务（等价于「在没声明 webServer 的作用域里 get('webServer')」）
//    真机表现：installRoute 静默 return false → boot.log route-skipped → 面板空白
{
  const old = indexSrc.replace(
    "root.inject(['webServer', 'agents'], (rctx) => {",
    "root.inject(['tools', 'sessionProjections', 'systemPrompt'], (rctx) => {",
  )
  if (old === indexSrc) {
    console.log('✖ route 变体没打上（lib/index.js 的路由块声明变了，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('用了未声明的服务（webServer）→ route-skipped', {
      files: { 'lib/index.js': old },
      testFile: 'host.test.mjs',
    }, /应注册|面板路由|AssertionError/))
  }
}

// ── ③ prompt section 的正文写成 provider（宿主只认 text，静默忽略）
//    ⚠️ lib/index.js 是 CRLF 换行，写死 \n 匹配不上 —— 用正则兜住。
{
  const old = indexSrc.replace(/(\r?\n\s+)text: \(context\) => \{/, '$1provider: (context) => {')
  if (old === indexSrc) {
    console.log('✖ provider 变体没打上（lib/index.js 的 section 写法变了，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('prompt section 用 provider（宿主静默忽略）', {
      files: { 'lib/index.js': old },
      testFile: 'host.test.mjs',
    }, /text|AssertionError/))
  }
}

// ── ④ 工具 parameters 退回「裸映射」（没有 type:'object'）
//    真机表现（2026-11-01）：boot.log 一切正常、面板正常、测试全绿，
//    但每一轮对话都报
//      Invalid schema for function 'style_get': schema must be a JSON Schema of
//      'type: "object"', got 'type: null'
//    因为宿主把 parameters **原样**发给上游。
{
  const old = indexSrc.replace(
    /parameters: \{\r?\n\s+type: 'object',\r?\n\s+additionalProperties: false,\r?\n\s+properties: \{\r?\n(\s+)presets: \{[^\r\n]*\},\r?\n\s+\},\r?\n\s+\},/,
    (m, indent) => `parameters: {\n${indent}presets: { type: 'boolean', description: '同时返回可用预设列表。' },\n    },`,
  )
  if (old === indexSrc) {
    console.log('✖ parameters 裸映射变体没打上（lib/index.js 的 style_get 参数块变了，请先更新本脚本）')
    results.push(false)
  } else {
    // 先确认变体语法合法：否则子进程只会报 SyntaxError，本脚本会误判成「harness 失效」
    const probe = freshCopy()
    let syntaxOk = false
    try {
      fs.writeFileSync(join(probe, 'lib/index.js'), old, 'utf8')
      syntaxOk = spawnSync(process.execPath, ['--check', join(probe, 'lib/index.js')], { encoding: 'utf8' }).status === 0
    } finally {
      try { rmSync(probe, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (!syntaxOk) {
      console.log('✖ parameters 裸映射变体语法不合法（本脚本的替换要修）')
      results.push(false)
    } else {
      results.push(runSuite('tool parameters 写成裸映射（上游：type 不能是 null）', {
        files: { 'lib/index.js': old },
        testFile: 'tool-schema.test.mjs',
      }, /type: "object"|parameters\.type|裸映射|AssertionError/))
      // 守卫必须真的拦住，而不是悄悄把坏 schema 注册上去：
      //   → 只注册 3 个工具（style_get 被跳过），boot.log 留一条 tool-params-invalid
      results.push(runRegistrationGuard(old))
    }
  }
}

/** 把变体源码放进临时副本，用假宿主跑 apply()，看守卫有没有拦住坏 parameters。 */
function runRegistrationGuard(mutated) {
  const dir = freshCopy()
  try {
    fs.writeFileSync(join(dir, 'lib/index.js'), mutated, 'utf8')
    const body = `
      import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      const HOME = mkdtempSync(join(tmpdir(), 'ws-guard-'))
      process.env.WRITING_STYLE_HOME = HOME
      const mod = await import('./lib/index.js')
      const tools = []
      const noop = () => () => {}
      const services = {
        tools: { register: (d) => { tools.push(d); return () => {} } },
        sessionProjections: { register: noop },
        systemPrompt: { section: noop, context: noop, getSectionOrder: () => 0, getContextOrder: () => 0 },
        webServer: { register: noop },
        agents: { list: () => [] },
      }
      mod.apply({
        effect: (fn) => { try { fn() } catch {} return () => {} },
        on: noop,
        get: (n) => services[n],
        inject: (names, fn) => {
          if (names.some((n) => !services[n])) return undefined
          const declared = new Set(names)
          return fn({ get: (n) => (declared.has(n) ? services[n] : undefined), agent: null })
        },
      }, {})
      const log = existsSync(join(HOME, 'writing-style', 'boot.log')) ? readFileSync(join(HOME, 'writing-style', 'boot.log'), 'utf8') : ''
      process.stdout.write(JSON.stringify({ count: tools.length, names: tools.map((t) => t.name).sort(), guardFired: /tool-params-invalid/.test(log) }))
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf8', cwd: dir, timeout: 120000 })
    let out = null
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { /* 下面报 */ }
    const ok = !!out && out.count === 3 && !out.names.includes('style_get') && out.guardFired === true
    if (ok) {
      console.log('✔ 注册守卫：坏 parameters 被拦住（注册 3 个、boot.log 有 tool-params-invalid）')
    } else {
      console.log(`✖ 注册守卫没拦住：${out ? JSON.stringify(out) : (r.stderr || '').split('\n')[0]}`)
    }
    return ok
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── ⑤ 首次 /state 失败后不再自动重试（2026-11-01 真机：预设页签一直空白，
//    必须手点「刷新」才回来）
{
  const clientSrc = fs.readFileSync(join(src, 'client.js'), 'utf8')
  const old = clientSrc.replace(
    /if \(!tries \|\| tries > 8\) return undefined/,
    'return undefined',
  )
  if (old === clientSrc) {
    console.log('✖ 自动重试变体没打上（client.js 的重试 effect 变了，请先更新本脚本）')
    results.push(false)
  } else {
    const probe = freshCopy()
    let syntaxOk = false
    try {
      fs.writeFileSync(join(probe, 'client.js'), old, 'utf8')
      syntaxOk = spawnSync(process.execPath, ['--check', join(probe, 'client.js')], { encoding: 'utf8' }).status === 0
    } finally {
      try { rmSync(probe, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (!syntaxOk) {
      console.log('✖ 自动重试变体语法不合法（本脚本的替换要修）')
      results.push(false)
    } else {
      results.push(runSuite('首次失败后不自动重试（预设页签会一直空白）', {
        files: { 'client.js': old },
        testFile: 'retry.test.mjs',
      }, /自动重试|AssertionError/))
    }
  }
}

// ── ⑥ RPC 层退回「一个全局在途槽」（2026-11-01 真机两个症状的共同根因）
//    GET 会采纳在途 POST 的响应（预设卡全消失）、也会跨会话复用（徽标一起翻转）。
{
  const clientSrc = fs.readFileSync(join(src, 'client.js'), 'utf8')
  const old = clientSrc.replace(
    "const key = base + '|' + sid",
    "const key = 'global'",
  )
  if (old === clientSrc) {
    console.log('✖ 全局单槽变体没打上（client.js 的在途键变了，请先更新本脚本）')
    results.push(false)
  } else {
    const probe = freshCopy()
    let syntaxOk = false
    try {
      fs.writeFileSync(join(probe, 'client.js'), old, 'utf8')
      syntaxOk = spawnSync(process.execPath, ['--check', join(probe, 'client.js')], { encoding: 'utf8' }).status === 0
    } finally {
      try { rmSync(probe, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (!syntaxOk) {
      console.log('✖ 全局单槽变体语法不合法（本脚本的替换要修）')
      results.push(false)
    } else {
      results.push(runSuite('在途请求只按全局一个槽复用（GET 借用 POST / 跨会话串台）', {
        files: { 'client.js': old },
        testFile: 'concurrency.test.mjs',
      }, /不能借用|各发一次|AssertionError/))
    }
  }
}

// ── ⑦ home 阶段顺序退回「homedir 猜测在真实命令行之前」（2026-11-01 事故，RPG 同源）
//    宿主升级成解包树后 @deepseek-ai/dsh-home-paths 变可解析，返回 homedir/.dsh；
//    目录存在、骗过 isDir，于是预设写进另一个 home —— 面板照常显示「已保存」。
{
  const old = indexSrc.replace(
    /(\['argv', homeFromArgv\],)(\r?\n)(\s*)(\['module-path', homeFromModulePath\],)(\r?\n)(\s*)(\['host-package', homeFromHostPackage\],)/,
    '$7$2$3$4$6$3$1',
  )
  if (old === indexSrc) {
    console.log('✖ home 阶段顺序变体没打上（lib/index.js 的解析顺序变了，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('home 阶段顺序：homedir 猜测压过真实命令行', {
      files: { 'lib/index.js': old },
      testFile: 'home.test.mjs',
    }, /argv|AssertionError/))
  }
}

// ── ⑧ 徽标席位搬回 conversation.composer.dock（2026-11-02 真机：初始会话看不到开关）
//    宿主对 composer.dock 的渲染条件是 variant === "composer" && sessionId ——
//    新会话的 hero 形态整个席位不渲染，徽标跟着消失；input.dock 才是 hero 也渲染的席位。
{
  const clientSrc = fs.readFileSync(join(src, 'client.js'), 'utf8')
  const old = clientSrc.replace(/conversation\.input\.dock/g, 'conversation.composer.dock')
  if (old === clientSrc) {
    console.log('✖ 徽标席位变体没打上（client.js 里没有 conversation.input.dock，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('徽标搬回 composer.dock（hero 形态不渲染那个席位 → 初始会话看不到开关）', {
      files: { 'client.js': old },
      testFile: 'client.test.mjs',
    }, /composer\.dock|input\.dock|AssertionError/))
  }
}

// ── ⑨ 保存「正在使用的」预设后不提示会话仍是旧快照（2026-11-02 用户：
//    「在预览更改完预设后预览处不会改变，不知道保存是否生效」）
{
  const clientSrc = fs.readFileSync(join(src, 'client.js'), 'utf8')
  const old = clientSrc.replace(
    "if (doc && doc.preset === payload.id) setNote(t('savedNoApply'))",
    "if (false) setNote(t('savedNoApply'))",
  )
  if (old === clientSrc) {
    console.log('✖ 快照提示变体没打上（client.js 的 savedNoApply 分支变了，请先更新本脚本）')
    results.push(false)
  } else {
    results.push(runSuite('保存在用预设后不说「会话还是旧快照」（保存生效与否不可见）', {
      files: { 'client.js': old },
      testFile: 'tabs.test.mjs',
    }, /快照|AssertionError/))
  }
}

// ── 对照：什么都不改，必须全绿。没有这条，「退出码非 0」可能是测试压根没跑。
const controls = []
for (const testFile of ['host.test.mjs', 'host-schema.test.mjs', 'tool-schema.test.mjs', 'retry.test.mjs', 'concurrency.test.mjs', 'home.test.mjs']) {
  const dir = freshCopy()
  try {
    const r = spawnSync(process.execPath, [join(dir, 'test', testFile)], { encoding: 'utf8', cwd: dir, timeout: 180000 })
    const text = out(r)
    const ran = /ℹ (tests|pass|fail) \d+/.test(text)
    const ok = ran && r.status === 0
    console.log(`${ok ? '✔' : '✖'} 对照（未改动）：${testFile} ${ok ? '全绿，harness 可信' : ran ? '竟然失败，副本环境有问题' : '根本没跑起来'}`)
    if (!ok) console.log('   ' + text.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 200))
    controls.push(ok)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

if (results.some((ok) => !ok) || controls.some((ok) => !ok)) {
  console.log('NEGATIVE CHECK: FAIL（有变体没被捕获，或对照不成立 —— 结论不可信）')
  process.exit(1)
}
console.log(`NEGATIVE CHECK: PASS（${results.length} 个变体都能被测试捕获，${controls.length} 个对照全绿）`)
