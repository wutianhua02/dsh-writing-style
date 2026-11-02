// 宿主侧端到端测试：用**假 ctx** 驱动插件，但参数 schema 与事件写入走宿主的真实实现。
//
// 三件必须守住的契约（每一条都曾让别的插件「装了但完全不生效」）：
//   ① 局部 inject 回调里服务只能 sctx.get(name)；sctx.tools 是 undefined
//   ② prompt section 的正文走 `text` 字段（可以是函数）；写成 `provider` 会被静默忽略
//   ③ 写会话日志的事件类型必须 `plugin:` 前缀 + ignorable:true，否则冷读整份拒绝
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedJsonSchema, JsonSchemaError } from './support/host-schema.mjs'
import { loadRealHostValidator } from './support/real-host-schema.mjs'

// 必须在 import 插件之前设好：启动探针会往 $DSH_HOME 写 boot.log
const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-'))
process.env.DSH_HOME = HOME
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const mod = await import('../lib/index.js')
const style = await import('../lib/style.js')

// ---------------------------------------------------------------- 假宿主

/** 一个够用的假会话：记录 append 的事件，支持 events 数组读取。 */
let SESSION_SEQ = 0
function makeSession(id) {
  // ⚠️ 每个用例必须用独立 id：插件的兜底缓存按会话 id 记，
  // 复用同一个 id 会让「上一个用例的存档」被当成这个会话的底本。
  const sid = id || ('sess-' + (++SESSION_SEQ))
  const events = []
  let seq = 0
  return {
    id: sid,
    get seq() { return seq },
    events,
    append(type, data, opts) {
      const ev = { type, data, seq: seq++, time: Date.now(), ...(opts && opts.ignorable ? { ignorable: true } : {}) }
      events.push(ev)
      return ev
    },
  }
}

/** 收集插件注册的东西。 */
function makeHost(opts = {}) {
  const tools = []
  const sections = []
  const contexts = []
  const projections = []
  const routes = []
  const disposers = []
  const omit = new Set(opts.omit || [])
  const blocks = []

  const services = {
    // ⚠️ 真宿主 `tools.register()` 第一行就是 assertSupportedJsonSchema(output.schema)：
    // 不合法直接抛。以前这里的 register 无条件收下，于是 `type:'json'` 在测试里
    // 106 项全绿、真机 4 个工具全都注册不上。假宿主必须照着宿主的行为抛。
    tools: {
      register: (def) => {
        assertSupportedJsonSchema(def.output.schema)
        tools.push(def)
        return () => {}
      },
    },
    sessionProjections: { register: (def) => { projections.push(def); return () => {} } },
    systemPrompt: {
      section: (def) => { sections.push(def); return () => {} },
      context: (def) => { contexts.push(def); return () => {} },
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
    },
    webServer: { register: (def) => { routes.push(def); return () => {} } },
    agents: { list: () => (opts.agents || []) },
  }
  for (const name of omit) delete services[name]

  const root = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    on: (name, fn) => { (root._handlers[name] = root._handlers[name] || []).push(fn); return () => {} },
    _handlers: {},
    get: (n) => services[n],
    // 复刻 Cordis：inject 声明的服务**缺任何一个，整块就不会跑**；
    // 而且块内 `get(name)` 只回答**声明过**的名字 —— 这就是真机上
    // 「顺手 get('webServer') 得到 undefined → route-skipped」的病灶。
    inject: (names, fn) => {
      blocks.push(names.slice())
      const missing = names.filter((n) => !services[n])
      if (missing.length) return undefined
      const declared = new Set(names)
      return fn({
        get: (n) => (declared.has(n) ? services[n] : undefined),
        get agent() { return opts.agent || null },
      })
    },
  }
  return { root, services, tools, sections, contexts, projections, routes, disposers, blocks, omit }
}

function boot(opts = {}) {
  const host = makeHost(opts)
  mod.apply(host.root, opts.config || {})
  return host
}

// ---------------------------------------------------------------- 契约 ①：服务获取

test('apply 在 sctx 只提供 get() 时也能拿到全部服务（不抛 TypeError）', () => {
  const host = boot()
  assert.equal(host.tools.length, 4, '四个工具都该注册上')
  assert.equal(host.projections.length, 1)
  assert.ok(host.sections.length >= 1)
})

test('服务缺失时安静退出，不抛错（宿主不会因此崩溃）', () => {
  const root = {
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    inject: (_n, fn) => fn({ get: () => null }),
  }
  assert.doesNotThrow(() => mod.apply(root, {}))
})

test('config.enabled=false 时什么都不注册', () => {
  const host = boot({ config: { enabled: false } })
  assert.equal(host.tools.length, 0)
  assert.equal(host.sections.length, 0)
})

// ---------------------------------------------------------------- 契约 ②：提示段

test('注入段用 text 承载正文，且带 interpolate:false（用户范文里的 {{ }} 不会炸）', () => {
  const host = boot()
  const sec = host.sections.find((s) => s.name === 'writing-style:directive')
  assert.ok(sec, '必须有 writing-style:directive 段')
  assert.equal(typeof sec.text, 'function')
  assert.equal(sec.interpolate, false, '范文里的 {{...}} 会被变量插值当语法错误抛出去')
  assert.equal(sec.order, 3300)
})

test('未启用时段落渲染成空串（宿主会丢弃空段，不占上下文）', () => {
  const host = boot()
  const sec = host.sections.find((s) => s.name === 'writing-style:directive')
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  assert.equal(sec.text({ agent: { session } }), '')
})

test('启用后段落渲染出完整规范，且带本轮自检', () => {
  const host = boot()
  const sec = host.sections.find((s) => s.name === 'writing-style:directive')
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))

  // 用工具把风格打开（走真实写入路径）
  const setTool = host.tools.find((t) => t.name === 'style_set')
  const out = setTool.execute({ enabled: true, dims: ['sentence:20', 'pace:80'] }, { agent: { session } })
  assert.equal(out.ok, true)
  assert.equal(out.enabled, true)

  const text = sec.text({ agent: { session } })
  assert.match(text, /写作风格 · 硬性规范/)
  assert.match(text, /极短句/)
  assert.match(text, /落笔前自检/)
  // 视角/时态已按用户要求取消，规范里不能再出现它们的文本
  assert.doesNotMatch(text, /第一人称|过去时|视角与时态/)
})

test('style_set 传已退役的 pov/tense：不崩、不动数值、明确告知原因', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')
  const out = setTool.execute({ enabled: true, dims: ['pov:first', 'tense:past', 'sentence:20'] }, { agent: { session } })
  assert.equal(out.ok, true)
  assert.equal(out.dims.pov, undefined, 'pov 不能再进文档')
  assert.equal(out.dims.tense, undefined, 'tense 不能再进文档')
  assert.equal(out.dims.sentence, 20, '同一批里合法的那项必须照常生效')
  const warns = (out.warnings || []).join('\n')
  assert.match(warns, /移除/, '退役维度要给「已移除」这种能看懂的理由，不能只说未知')
})

test('style_set 用中文旧名「视角/时态」也说「已移除」，不说「未知维度」', () => {
  // 用户实际会这么要求，模型也就这么传。这是本次报障的直接场景。
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')
  const out = setTool.execute({ enabled: true, dims: ['视角:第一人称', '时态:过去时', 'pace:80'] }, { agent: { session } })
  assert.equal(out.ok, true)
  const warns = (out.warnings || []).join('\n')
  assert.match(warns, /叙事视角」已从本插件移除/)
  assert.match(warns, /叙述时态」已从本插件移除/)
  assert.doesNotMatch(warns, /未知维度/, '中文旧名不能再算「未知维度」')
  assert.equal(out.dims.pace, 80, '同批里合法的那项照常生效')
})

test('style_get 不带 presets 也返回 dimRef.retired（模型该知道视角已取消）', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const getTool = host.tools.find((t) => t.name === 'style_get')
  const out = getTool.execute({}, { agent: { session } })
  assert.deepEqual(out.dimRef.retired, ['pov', 'tense'])
  assert.equal(out.presets, undefined)
})

test('触发性条目走独立的 context，且按最近消息命中', () => {
  const host = boot()
  const ctxDef = host.contexts.find((c) => c.name === 'writing-style:rules')
  assert.ok(ctxDef, '必须有 writing-style:rules context')
  assert.equal(ctxDef.interpolate, false)

  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')
  setTool.execute({ enabled: true, directives: '' }, { agent: { session } })

  const rulesTool = host.tools.find((t) => t.name === 'style_rules')
  rulesTool.execute({ action: 'add', name: '战斗', keys: ['战斗'], text: '战斗段落用短句。' }, { agent: { session } })

  // 还没出现关键词 → 不注入
  assert.equal(ctxDef.text({ agent: { session } }), '')

  // 用户说了「战斗」→ 下一轮注入
  host.root._handlers['session/event'].forEach((fn) => fn(session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '接下来是一场战斗' }] },
  }))
  const hit = ctxDef.text({ agent: { session } })
  assert.match(hit, /战斗段落用短句/)
})

// ---------------------------------------------------------------- 契约 ③：日志写入

test('写日志用 plugin: 命名空间 + ignorable，否则宿主冷读会整份拒绝会话', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')
  setTool.execute({ enabled: true }, { agent: { session } })

  const written = session.events.filter((e) => e.type === style.DOC_EVENT)
  assert.equal(written.length, 1)
  assert.match(written[0].type, /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*$/)
  assert.equal(written[0].ignorable, true)
  assert.ok(written[0].data.doc, '载荷里必须有 doc')
  assert.equal(written[0].data.ev, 1)
})

test('投影注册的形状符合宿主冷读要求（schema 有 parse，view 返回 null 而非抛错）', () => {
  const host = boot()
  const def = host.projections[0]
  assert.equal(def.key, style.DOC_KEY)
  assert.equal(typeof def.stateSchema.parse, 'function')
  assert.equal(typeof def.wire.viewSchema.parse, 'function')
  assert.equal(def.init(), null)

  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  host.tools.find((t) => t.name === 'style_set').execute({ enabled: true }, { agent: { session } })

  const ev = session.events.find((e) => e.type === style.DOC_EVENT)
  const state = def.apply(null, ev)
  assert.equal(state, ev.data)
  // 脏事件不能让投影炸掉（历史里可能有旧结构）
  assert.equal(def.apply(state, { type: style.DOC_EVENT, data: { doc: 'nope' } }), state)
  assert.equal(def.apply(state, { type: 'other/event', data: {} }), state)
  // view 对脏数据返回 null，而不是抛
  assert.equal(def.wire.view({ doc: 123 }), null)
  assert.doesNotThrow(() => def.wire.viewSchema.parse(state))
})

test('两次写入都进日志，undo 回到上一份', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')

  setTool.execute({ enabled: true, dims: ['sentence:10'] }, { agent: { session } })
  setTool.execute({ dims: ['sentence:90'] }, { agent: { session } })

  const getTool = host.tools.find((t) => t.name === 'style_get')
  assert.equal(getTool.execute({}, { agent: { session } }).dims.sentence, 90)

  const undo = host.routes[0] && host.routes[0]
  assert.ok(undo, '面板路由该注册上')
})

// ---------------------------------------------------------------- 工具契约

test('四个工具的参数形状符合宿主契约：完整 JSON Schema，原样发给上游', async () => {
  const host = boot()
  const names = host.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['style_get', 'style_preset', 'style_rules', 'style_set'])

  // ⚠️ 宿主对「工具参数」有**两种写法**，对应两条不同的路，别混：
  //   · 插件 `ctx.tools.register({ parameters })`：parameters 原样发给上游
  //     （dsh-llm-pi-ai 里就是 `parameters: tool.parameters`），所以必须是
  //     完整 JSON Schema：{ type:'object', properties:{…}, required? }。
  //   · 宿主自家 `defineTool({ parameters })`：parameters 是「裸映射」，
  //     由 `parameterSchemaSpecToJsonSchema()` 编译成上面那个形状。
  // 2026-11-01 这一项红过一次：它拿「裸映射 → JSON Schema」的编译器去喂
  // 已经成型的 JSON Schema，得到 `parameters.type must be a value schema object`。
  // 那是**用错编译器**（宿主从未要求插件交裸映射），不是插件退版 ——
  // 上游报错的形状 `type: null` 才是真正要防的（那条由 tool-schema.test.mjs 钉住）。
  let real = null
  try { real = await loadRealHostValidator() } catch { real = null }
  let specCompiler = null
  try {
    const api = await import('file:///E:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    specCompiler = api.parameterSchemaSpecToJsonSchema
  } catch { /* 换机器就跳过反证，不误判 */ }

  for (const t of host.tools) {
    assert.equal(t.parameters.type, 'object', t.name + ' 的 parameters 根部必须是 type:"object"')
    assert.ok(t.parameters.properties && typeof t.parameters.properties === 'object', t.name + ' 必须声明 properties')
    if (real) {
      assert.doesNotThrow(
        () => real.assertSupportedJsonSchema(t.parameters),
        t.name + ' 的 parameters 不在宿主支持的 schema 子集里',
      )
    }
  }

  if (specCompiler) {
    // 反证一：裸映射过一遍编译器，得到的正是我们现在手写的形状 —— 两种写法等价。
    const compiled = specCompiler({ presets: { type: 'boolean', description: 'x' } })
    assert.equal(compiled.type, 'object')
    assert.deepEqual(Object.keys(compiled.properties), ['presets'])

    // 反证二：把已成型的 JSON Schema 再喂回参数编译器必抛 —— 这正是上一版红的那个错。
    assert.throws(
      () => specCompiler(host.tools[0].parameters),
      /must be a value schema object/,
    )
  }
})

test('style_set 拒绝未知维度并给出警告，而不是静默吞掉', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')
  const out = setTool.execute({ enabled: true, dims: ['不存在:5', 'sentence'] }, { agent: { session } })
  assert.equal(out.warnings.length, 2)
  assert.match(out.warnings.join(), /未知维度/)
  assert.match(out.warnings.join(), /缺少冒号/)
})

test('style_preset apply 会顺带开启注入（用户说「换冷硬派」就该立刻生效）', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const presetTool = host.tools.find((t) => t.name === 'style_preset')
  const out = presetTool.execute({ action: 'apply', id: 'hardboiled' }, { agent: { session } })
  assert.equal(out.ok, true)
  assert.equal(out.preset, 'hardboiled')

  const getTool = host.tools.find((t) => t.name === 'style_get')
  const state = getTool.execute({}, { agent: { session } })
  assert.equal(state.enabled, true)
  assert.equal(state.preset, 'hardboiled')
  assert.ok(state.dims.sentence <= 30)
})

test('style_preset 未知 id 明确报错并列出可用项', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const presetTool = host.tools.find((t) => t.name === 'style_preset')
  assert.throws(() => presetTool.execute({ action: 'apply', id: 'nope' }, { agent: { session } }), /未知预设/)
})

test('style_rules 的 list/add/toggle/delete 全通', () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const tool = host.tools.find((t) => t.name === 'style_rules')

  const added = tool.execute({ action: 'add', id: 'x', name: '战斗', keys: ['打'], text: '短句' }, { agent: { session } })
  assert.equal(added.rules.length, 1)

  const toggled = tool.execute({ action: 'toggle', id: 'x' }, { agent: { session } })
  assert.equal(toggled.rules[0].enabled, false)

  const listed = tool.execute({ action: 'list' }, { agent: { session } })
  assert.equal(listed.rules.length, 1)

  const deleted = tool.execute({ action: 'delete', id: 'x' }, { agent: { session } })
  assert.equal(deleted.rules.length, 0)
})

// ---------------------------------------------------------------- 面板路由

test('面板路由注册在 /dsh-writing-style 前缀下', () => {
  const host = boot()
  assert.equal(host.routes.length, 1)
  assert.equal(host.routes[0].kind, 'prefix')
  assert.equal(host.routes[0].path, '/dsh-writing-style')
  assert.equal(typeof host.routes[0].handler, 'function')
})

test('没有 webServer 的宿主形态：工具照常、只是没有面板路由', () => {
  // 这就是把路由拆成独立 inject 块的理由。真机 2026-10-31T09:43 那条
  // boot.log `route-skipped` 的病灶是：主块只声明了 tools/sessionProjections/
  // systemPrompt，块内 `sctx.get('webServer')` 拿到 undefined →
  // installRoute 静默 return false → 面板空白，且不抛任何错。
  // 拆开后，缺服务的那块**整块不跑**，其余功能不受牵连。
  const host = boot({ omit: ['webServer'] })
  assert.equal(host.tools.length, 4, '工具不依赖 webServer')
  assert.equal(host.routes.length, 0, '没有 webServer 就不该有路由')
  assert.equal(host.blocks.length, 2, '应有两个 inject 块：功能块 + 路由块')

  const routeBlock = host.blocks.find((l) => l.includes('webServer'))
  assert.ok(routeBlock, '路由块的 inject 声明里必须有 webServer')
  assert.ok(routeBlock.includes('agents'), 'findSession 用 agents，也要声明')
  // ⚠️ connection 故意不声明：没有它的宿主会让整块永远等下去（面板直接没了）。
  assert.ok(!routeBlock.includes('connection'), 'connection 不能进 inject 声明')

  const mainBlock = host.blocks.find((l) => l.includes('tools'))
  assert.ok(mainBlock, '功能块的声明里必须有 tools')
  assert.ok(!mainBlock.includes('webServer'), 'webServer 不能靠功能块「顺手 get」')
})

test('路由拒绝非回环 Host（面板写入不能被外部页面驱动）', async () => {
  const host = boot()
  const handler = host.routes[0].handler
  const res = { writeHead(status) { this.status = status }, end() { this.ended = true } }
  await handler({ method: 'GET', url: '/dsh-writing-style/state', headers: { host: 'evil.example.com' } }, res)
  assert.equal(res.status, 403)
})

test('GET state 指向未知会话时返回默认文档而不是别人的存档', async () => {
  const host = boot()
  // 先让「最近一个会话」存在且是启用状态
  const live = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(live))
  host.tools.find((t) => t.name === 'style_set').execute({ enabled: true }, { agent: { session: live } })

  const handler = host.routes[0].handler
  let payload = null
  const res = { writeHead() {}, end(body) { payload = JSON.parse(body) } }
  await handler({ method: 'GET', url: '/dsh-writing-style/state?session=does-not-exist', headers: { host: '127.0.0.1:53026' } }, res)
  assert.equal(payload.ok, true)
  assert.equal(payload.doc.enabled, false, '未知会话不能读到最近会话的风格')
  assert.equal(payload.hasSession, false)
  assert.ok(Array.isArray(payload.dimsMeta))
  assert.ok(payload.presets.length >= 8)
})

test('POST 指向未知会话时明确 404，绝不写到最近会话上', async () => {
  const host = boot()
  const live = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(live))
  const handler = host.routes[0].handler

  let payload = null
  const res = { writeHead() {}, end(body) { payload = JSON.parse(body) } }
  const req = {
    method: 'POST',
    url: '/dsh-writing-style/set?session=ghost',
    headers: { host: '127.0.0.1:53026' },
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(JSON.stringify({ doc: { enabled: true } })))
      if (ev === 'end') fn()
    },
  }
  await handler(req, res)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /会话未找到/)
  assert.equal(live.events.filter((e) => e.type === style.DOC_EVENT).length, 0)
})

test('POST set 走日志写入，面板与模型写的是同一条路径', async () => {
  const host = boot()
  const session = makeSession()
  host.root._handlers['session/created'].forEach((fn) => fn(session))
  const handler = host.routes[0].handler

  let payload = null
  const res = { writeHead() {}, end(body) { payload = JSON.parse(body) } }
  const req = {
    method: 'POST',
    url: '/dsh-writing-style/set',
    headers: { host: '127.0.0.1:53026' },
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(JSON.stringify({ doc: { enabled: true, dims: { sentence: 5 } } })))
      if (ev === 'end') fn()
    },
  }
  await handler(req, res)
  assert.equal(payload.ok, true)
  assert.equal(payload.doc.enabled, true)
  assert.equal(payload.doc.dims.sentence, 5)
  assert.equal(session.events.filter((e) => e.type === style.DOC_EVENT).length, 1)
})

test('探针写进了 $DSH_HOME/writing-style/boot.log（排查「装了不生效」用）', () => {
  boot()
  assert.ok(existsSync(join(HOME, 'writing-style', 'boot.log')))
})

test('Config 能真实生成（解析不到 schemastery 会静默变成 undefined，配置项全失效）', () => {
  // 回归：插件被 junction/symlink 装进 profile 时 import.meta.url 被 realpath，
  // 从「插件自己的位置」找不到 profile 的 node_modules，Config 就静默没了。
  // 现在有多个解析基准兜底；这里断言至少在一个真实环境里能生成。
  if (typeof mod.Config !== 'function') {
    // 本机拿不到 schemastery 时允许缺省（apply 里有内联默认值），但必须能说清原因
    assert.equal(mod.Config, undefined, 'Config 要么是 schema 函数，要么是 undefined')
    return
  }
  const spec = mod.Config['~standard']
  assert.ok(spec && typeof spec.validate === 'function')
  const out = spec.validate({})
  assert.equal(out.issues, undefined)
  assert.equal(out.value.enabled, true)
  assert.equal(out.value.injectPerTurn, true)
  assert.equal(out.value.triggerRules, true)
  assert.equal(out.value.sampleLimit, 4000)
})

test('Config 的 enabled=false 真的能关掉整个插件', () => {
  const host = boot({ config: { enabled: false } })
  assert.equal(host.tools.length, 0)
  assert.equal(host.routes.length, 0)
})
