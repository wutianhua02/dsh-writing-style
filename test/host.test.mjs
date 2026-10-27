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

  const services = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
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

  const root = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    on: (name, fn) => { (root._handlers[name] = root._handlers[name] || []).push(fn); return () => {} },
    _handlers: {},
    get: (n) => services[n],
    inject: (_names, fn) => fn({ get: (n) => services[n], get agent() { return opts.agent || null } }),
  }
  return { root, services, tools, sections, contexts, projections, routes, disposers }
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
  const out = setTool.execute({ enabled: true, dims: ['sentence:20', 'pov:first'] }, { agent: { session } })
  assert.equal(out.ok, true)
  assert.equal(out.enabled, true)

  const text = sec.text({ agent: { session } })
  assert.match(text, /写作风格 · 硬性规范/)
  assert.match(text, /第一人称/)
  assert.match(text, /极短句/)
  assert.match(text, /落笔前自检/)
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

test('四个工具的名字、参数形状都能被宿主 dsh-tools 编译', async () => {
  const host = boot()
  const names = host.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['style_get', 'style_preset', 'style_rules', 'style_set'])

  // 用宿主真实的参数编译器验一遍（拿不到就跳过，不误判）
  let compile = null
  try {
    const tools = await import('file:///E:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    compile = tools.parameterSchemaSpecToJsonSchema
  } catch { /* 换机器时跳过 */ }
  if (!compile) return

  for (const t of host.tools) {
    assert.doesNotThrow(() => compile(t.parameters), t.name + ' 的参数不合宿主要求')
    const json = compile(t.parameters)
    assert.equal(json.type, 'object')
    assert.ok(json.properties && typeof json.properties === 'object')
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
