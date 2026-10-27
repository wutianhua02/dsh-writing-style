// 新功能与「不生效」防护的回归测试。
//
// 三组：
//   ① 自己写入文风预设（write-preset / 存预设时范文不丢 / 套预设时范文跟着来）
//   ② 读失败不能覆盖真实存档（rpg-status 用一次数据丢失换来的教训）
//   ③ 工具回执只回一句确认（不往对话里贴整段规范）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-writing-style-feat-'))
// ⚠️ 必须在 import 插件**之前**设好：插件在模块顶层就捕获了 DSH_HOME
// （预设文件、探针都按它定位）。设晚了会静默写到真实 $DSH_HOME 去。
process.env.DSH_HOME = HOME
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const mod = await import('../lib/index.js')
const style = await import('../lib/style.js')

let SEQ = 0
function makeSession(id) {
  const sid = id || ('feat-' + (++SEQ))
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

function boot(opts = {}) {
  const tools = []
  const sections = []
  const contexts = []
  const routes = []
  const handlers = {}
  const services = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    sessionProjections: { register: () => () => {} },
    systemPrompt: {
      section: (d) => { sections.push(d); return () => {} },
      context: (d) => { contexts.push(d); return () => {} },
    },
    webServer: { register: (d) => { routes.push(d); return () => {} } },
    agents: { list: () => [] },
  }
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    get: (n) => services[n],
    inject: (_n, fn) => fn({ get: (n) => services[n], agent: null }),
  }, opts.config || {})
  return { tools, sections, contexts, routes, handlers }
}

function post(route, body, sessionId) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/dsh-writing-style/' + route + (sessionId ? '?session=' + sessionId : ''),
      headers: { host: '127.0.0.1:53026' },
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(body || {})))
        if (ev === 'end') fn()
      },
    }
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } }
    route_handlers.get(route).call(null, req, res)
  })
}
const route_handlers = new Map()

function attachRoutes(host) {
  route_handlers.clear()
  // 用一个通用 handler：路径决定 op，所以这里只挂一次
  route_handlers.set('set', host.routes[0].handler)
  route_handlers.set('preset', host.routes[0].handler)
  route_handlers.set('write-preset', host.routes[0].handler)
  route_handlers.set('save-preset', host.routes[0].handler)
  route_handlers.set('delete-preset', host.routes[0].handler)
  route_handlers.set('undo', host.routes[0].handler)
  route_handlers.set('preview', host.routes[0].handler)
}

/**
 * 起一个「有会话」的宿主。
 * 预设类操作（write-preset / delete-preset）不碰会话日志，但路由要求先有会话上下文，
 * 所以统一先建一个 —— 这也更接近真实情况（用户在对话里才会开面板）。
 */
function bootWithSession(opts = {}) {
  const host = boot(opts)
  attachRoutes(host)
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))
  return { host, session }
}

const presetsFile = () => join(HOME, 'writing-style', 'presets.json')

// ---------------------------------------------------------------- ① 自己写预设

test('write-preset：面板能直接写入一份全新预设，不需要先在本会话里调好', async () => {
  const { session } = bootWithSession()
  const out = await post('write-preset', {
    id: 'my-noir',
    name: '我的冷硬派',
    desc: '自用',
    dims: { sentence: 15, pov: 'first', dialogue: 75 },
    directives: '只写动作，不写心情。',
    avoid: ['仿佛', '不禁'],
    sample: '雨停了三分钟。我把烟摁在墙上。',
  }, session.id)

  assert.equal(out.ok, true, '写入失败：' + (out.error || ''))
  assert.equal(out.id, 'my-noir')

  // 落盘了，而且是「与均衡不同的维度」
  assert.ok(existsSync(presetsFile()))
  const saved = JSON.parse(readFileSync(presetsFile(), 'utf8'))
  const p = saved.find((x) => x.id === 'my-noir')
  assert.ok(p, '预设必须写进 presets.json')
  assert.equal(p.name, '我的冷硬派')
  assert.equal(p.dims.sentence, 15)
  assert.equal(p.dims.pov, 'first')
  assert.equal(p.directives, '只写动作，不写心情。')
  assert.deepEqual(p.avoid, ['仿佛', '不禁'])
  assert.equal(p.sample, '雨停了三分钟。我把烟摁在墙上。')

  // 出现在可用预设列表里（内置 + 自定义）
  const listed = out.presets.find((x) => x.id === 'my-noir')
  assert.ok(listed, '写完之后必须能立刻被列出来')
  assert.equal(listed.custom, true)
})

test('write-preset：与「均衡」相同的维度不落盘（日后加旋钮不会让老预设失效）', async () => {
  const { session } = bootWithSession()
  const base = style.presetDims('balanced')
  const out = await post('write-preset', {
    id: 'only-one',
    name: '只改一项',
    dims: { sentence: 10, density: base.density },
  }, session.id)
  assert.equal(out.ok, true, '写入失败：' + (out.error || ''))
  const saved = JSON.parse(readFileSync(presetsFile(), 'utf8'))
  const p = saved.find((x) => x.id === 'only-one')
  assert.equal(p.dims.sentence, 10)
  assert.equal(Object.hasOwn(p.dims, 'density'), false, '和默认值相同的维度不该存')
})

test('write-preset：非法 id 被拒（不能让预设文件变成垃圾桶）', async () => {
  const { session } = bootWithSession()
  for (const bad of ['', '有中文', 'a b', 'x'.repeat(60), '../evil']) {
    const out = await post('write-preset', { id: bad, name: 'x' }, session.id)
    assert.equal(out.ok, false, 'id=' + JSON.stringify(bad) + ' 应当被拒')
  }
})

test('write-preset 写入的预设能被一键套用，且范文与禁用词一起生效', async () => {
  const { session } = bootWithSession()
  const w = await post('write-preset', {
    id: 'with-sample',
    name: '带范文的',
    dims: { sentence: 12 },
    directives: '短。',
    avoid: ['仿佛'],
    sample: '灯灭了。他没动。',
  }, session.id)
  assert.equal(w.ok, true, '写入失败：' + (w.error || ''))

  const applied = await post('preset', { id: 'with-sample' }, session.id)
  assert.equal(applied.ok, true)
  assert.equal(applied.doc.preset, 'with-sample')
  assert.equal(applied.doc.sample, '灯灭了。他没动。', '范文必须跟着预设一起套用')
  assert.deepEqual(applied.doc.avoid, ['仿佛'])
  assert.match(applied.directive, /灯灭了/)
})

test('存预设（save-preset）不能丢掉范文 —— 漏掉它预设效果会明显不同', () => {
  const doc = style.normalizeDoc({ enabled: true, sample: '一段范文', directives: 'x' })
  const p = style.toPreset(doc, 's1', '存下来的')
  assert.equal(p.sample, '一段范文')
  // 合并进预设表之后也还在
  const merged = style.allPresets([p]).find((x) => x.id === 's1')
  assert.equal(merged.sample, '一段范文')
})

test('删除预设只删自定义，内置预设删不掉', async () => {
  const { session } = bootWithSession()
  const w = await post('write-preset', { id: 'temp', name: '临时' }, session.id)
  assert.equal(w.ok, true, '写入失败：' + (w.error || ''))
  const afterDel = await post('delete-preset', { id: 'temp' }, session.id)
  assert.ok(!afterDel.presets.some((p) => p.id === 'temp'))
  // 内置的还在
  assert.ok(afterDel.presets.some((p) => p.id === 'hardboiled'))
})

// ---------------------------------------------------------------- ② 读失败不覆盖

test('读失败（日志读空）时写入不会用默认值覆盖真实风格', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))

  const setTool = host.tools.find((t) => t.name === 'style_set')
  setTool.execute({ enabled: true, dims: ['sentence:7'], directives: '我的要求' }, { agent: { session } })

  // 模拟「日志接口突然读不出东西」：events 被清空，但内存兜底还在
  const backup = session.events.splice(0, session.events.length)
  const getTool = host.tools.find((t) => t.name === 'style_get')
  const before = getTool.execute({}, { agent: { session } })
  assert.equal(before.dims.sentence, 7, '读不到日志时也不能丢掉刚写的值')

  // 再写一次（只改一个字段），底本必须是 7 而不是默认 45
  setTool.execute({ dims: ['dialogue:80'] }, { agent: { session } })
  const after = getTool.execute({}, { agent: { session } })
  assert.equal(after.dims.sentence, 7, '底本被默认值覆盖了 —— 这就是 rpg-status 当年丢数据的坑')
  assert.equal(after.dims.dialogue, 80)
  assert.equal(after.directives, '我的要求')

  session.events.push(...backup)
})

test('空壳存档（没有预设也没有维度）不算可信存档', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))

  // 手动塞一条残骸：有 doc 但内容全空
  session.append(style.DOC_EVENT, { doc: {}, turn: 1, updatedAt: 'x', ev: 1 }, { ignorable: true })

  const getTool = host.tools.find((t) => t.name === 'style_get')
  const out = getTool.execute({}, { agent: { session } })
  assert.equal(out.hasSave, false, '空壳不该被当成一份存档')
})

test('面板改一个滑块不会重置其他字段', async () => {
  const { session } = bootWithSession()

  await post('set', { doc: { enabled: true, dims: { sentence: 9 }, directives: '保留我', avoid: ['仿佛'] } }, session.id)
  const out = await post('set', { dims: { dialogue: 88 } }, session.id)
  assert.equal(out.doc.dims.sentence, 9, '只改对话占比，句式长度必须留着')
  assert.equal(out.doc.dims.dialogue, 88)
  assert.equal(out.doc.directives, '保留我')
  assert.deepEqual(out.doc.avoid, ['仿佛'])
})

// ---------------------------------------------------------------- ③ 回执只回一句

test('style_set 的回执是一句话，不把整段规范贴进对话', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))
  const setTool = host.tools.find((t) => t.name === 'style_set')

  const value = setTool.execute({ enabled: true, dims: ['sentence:20'] }, { agent: { session } })
  const rendered = setTool.output.render({}, value)
  const text = rendered.map((r) => r.text).join('\n')

  assert.match(text, /^已启用写作风格/)
  assert.ok(!text.includes('落笔前自检'), '回执里不该有规范正文（那是系统提示段的活）')
  assert.ok(text.length < 120, '回执应当是一句话，实际 ' + text.length + ' 字')
})

test('style_preset 切换成功的回执也是一句话', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))
  const tool = host.tools.find((t) => t.name === 'style_preset')

  const value = tool.execute({ action: 'apply', id: 'gothic' }, { agent: { session } })
  const text = tool.output.render({}, value).map((r) => r.text).join('\n')
  assert.match(text, /^已启用写作风格：/)
  assert.ok(!text.includes('落笔前自检'))
  assert.ok(text.length < 120, '实际 ' + text.length + ' 字：' + text)
})

test('style_preset list 仍然给完整清单（那是查询，不是确认）', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))
  const tool = host.tools.find((t) => t.name === 'style_preset')
  const value = tool.execute({ action: 'list' }, { agent: { session } })
  const text = tool.output.render({}, value).map((r) => r.text).join('\n')
  assert.match(text, /可用预设/)
  assert.match(text, /hardboiled/)
})

test('关闭风格的回执同样简短', () => {
  const host = boot()
  const session = makeSession()
  host.handlers['session/created'].forEach((fn) => fn(session))
  const tool = host.tools.find((t) => t.name === 'style_set')
  tool.execute({ enabled: true }, { agent: { session } })
  const value = tool.execute({ enabled: false }, { agent: { session } })
  const text = tool.output.render({}, value).map((r) => r.text).join('\n')
  assert.equal(text, '已关闭写作风格')
})
