// dsh-writing-style —— 宿主侧插件（DSH / Cordis 标准形状：export { name, inject, Config, apply }）
//
// 解决的事：让「写作风格」成为会话里的一等公民，而不是每轮靠用户重新打一段提示词。
//
//   1) 每轮注入：把当前风格渲染成 systemPrompt 的一个 section（order 3300，紧跟在
//      RPG 状态段之后），模型每一轮都被重新告知该怎么写 —— 不依赖它「记得」。
//   2) 触发性条目：按最近消息里的关键词命中才追加（酒馆世界书的扫描/递归那套）。
//   3) 模型工具：style_get / style_set / style_preset / style_rules
//      —— 用户可以直接说「换成冷硬派」「句式再短一点」，模型自己落地。
//   4) 一个会话投影 `writingStyle` + 一个 loopback 路由 `/dsh-writing-style/*`，
//      给面板读写（预设库 / 13 个维度滑块 / 禁用词 / 范文 / 规则）。
//
// 数据权威源 = 会话日志里的 `plugin:writing-style/state` 记录。
// 为什么不是配置文件：用户要求「每个会话可以不一样」，而配置文件是全局的。
// 用日志 = 撤销有历史、导出会话即导出风格、换窗口/重开客户端都还在。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  DOC_EVENT, DOC_KEY, STATE_VERSION, ENVELOPE_VERSION,
  DIMENSIONS, PRESETS, DEFAULT_AVOID, VIEW_VERSION,
  defaultDoc, normalizeDoc, cloneDoc, checkDoc, renderDirective, renderRules, renderSummary,
  applyPreset, presetDims, coerceDim, resolveDim, toPreset, allPresets,
} from './style.js'
import { stateSchema, viewSchema, checkEnvelope } from './schema.js'

const name = 'writing-style'
const inject = []

const ROUTE_PREFIX = '/dsh-writing-style'
const DSH_HOME = process.env.DSH_HOME || ''
/** 注入段序号：紧跟 RPG 状态（3200 / 3210）之后，早于工具说明。 */
const SECTION_ORDER = 3300
const RULE_CONTEXT_ORDER = 3310
/** 触发条目扫描的最近消息条数（太多会读到很旧的上下文）。 */
const SCAN_MESSAGES = 8

// ---------------------------------------------------------------- 配置

/**
 * 配置：用 schemastery（宿主提供）。
 *
 * 刻意用 createRequire 而不是顶层 `import`：静态导入失败会让**整个插件**加载失败，
 * 而这个依赖只用来生成配置 schema —— 拿不到就走 apply() 里的内联默认值。
 *
 * ⚠️ 解析基准不能只有 `import.meta.url`：插件被 junction/symlink 装进 profile 时，
 * Node 会把模块路径 realpath 到真实目录，于是从「插件自己的位置」找不到 profile 的
 * node_modules（实测 Config 会静默变成 undefined，配置项全部失效）。
 * 所以额外试 profile 的 node_modules 与宿主安装目录。
 */
function schemasteryCandidates() {
  const out = []
  try { out.push(createRequire(import.meta.url)) } catch { /* ignore */ }
  const bases = []
  if (DSH_HOME) {
    bases.push(path.join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
    bases.push(path.join(DSH_HOME, 'profiles', 'web', 'package.json'))
  }
  // 宿主安装目录（app.asar.unpacked / app/dsh 两种布局都试）
  for (const p of [
    'E:/dsh/resources/app/dsh/package.json',
    'E:/dsh/resources/app/package.json',
  ]) bases.push(p)
  for (const b of bases) {
    try { out.push(createRequire(b)) } catch { /* ignore */ }
  }
  return out
}

function loadSchemastery() {
  for (const req of schemasteryCandidates()) {
    try {
      const m = req('@deepseek-ai/schemastery')
      const z = (m && (m.default || m)) || null
      if (z && typeof z.object === 'function') return z
    } catch { /* 试下一个基准 */ }
  }
  return null
}

function makeConfig(ns) {
  const z = (ns && typeof ns === 'function' && ns) || (ns && ns.default) || null
  if (!z || typeof z.object !== 'function') return undefined
  return z.object({
    /** 诊断总闸：关掉后不注册工具/投影/注入/路由，用来二分「是不是本插件引起的」。 */
    enabled: z.boolean().default(true),
    /** 每轮注入风格规范（关掉后只有工具和面板能用）。 */
    injectPerTurn: z.boolean().default(true),
    /** 触发性条目（关键词命中才注入）。 */
    triggerRules: z.boolean().default(true),
    /** 范文最多注入多少字（防止用户粘一整本小说把上下文吃光）。 */
    sampleLimit: z.number().default(4000),
  })
}

const Config = makeConfig(loadSchemastery())

const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------- 会话状态

let lastSession = null
/** 每个会话最后写入的信封（日志接口形态不一致时的兜底）。 */
const LAST_ENVELOPE = new Map()
const LAST_ENVELOPE_OBJ = new WeakMap()
/** 历史扫描记忆化：会话 id + 日志长度 → 行。 */
const HISTORY_MEMO = new Map()
/** 每个会话最近若干条消息的纯文本（触发性条目用）。 */
const RECENT_TEXT = new Map()

/** 宿主的 dsh-session（缓存）。 */
let HOST_SESSION = undefined
function loadHostSession() {
  if (HOST_SESSION !== undefined) return HOST_SESSION
  HOST_SESSION = null
  const req = createRequire(import.meta.url)
  for (const id of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session/lib/index.js']) {
    try {
      const m = req(id)
      if (m && typeof m.appendPluginRecord === 'function') { HOST_SESSION = m; break }
    } catch { /* 试下一个 */ }
  }
  return HOST_SESSION
}

function isStateEvent(event) {
  return !!event && event.type === DOC_EVENT
}

/** 会话日志规模指纹：只有它变化才重扫。拿不到就 -1（不缓存）。 */
function logSize(session) {
  try {
    const ev = session && session.events
    if (Array.isArray(ev)) return ev.length
    if (session && typeof session.seq === 'number') return session.seq + 1
    if (session && typeof session.eventCount === 'number') return session.eventCount
  } catch { /* ignore */ }
  return -1
}

/**
 * 写一条风格存档。
 *
 * ⚠️ 事件类型必须带 `plugin:` 前缀且标 `ignorable: true`：
 * 宿主冷读会话日志时逐条校验事件类型，不认识又没标 ignorable 就**整份拒绝**，
 * 表现为「历史加载失败」，一条记录能废掉整个会话。
 */
function recordAppend(session, envelope) {
  if (!session) throw new Error('session 不可写')
  const payload = { ...envelope, ev: ENVELOPE_VERSION }
  const host = loadHostSession()
  if (host && typeof host.appendPluginRecord === 'function') {
    try {
      host.appendPluginRecord(session, DOC_EVENT, payload)
      return remember(session, payload)
    } catch { /* 退到普通 append */ }
  }
  if (typeof session.append !== 'function') throw new Error('session 不可写')
  try {
    session.append(DOC_EVENT, payload, { ignorable: true })
  } catch {
    session.append(DOC_EVENT, payload)
  }
  return remember(session, payload)
}

function remember(session, payload) {
  if (session && session.id) LAST_ENVELOPE.set(session.id, payload)
  try { if (session) LAST_ENVELOPE_OBJ.set(session, payload) } catch { /* ignore */ }
  if (session && session.id) HISTORY_MEMO.delete(session.id)
  return payload
}

/** 会话历史里的全部风格存档（新 → 旧）。 */
function historyOf(session) {
  const key = session && session.id
  const size = logSize(session)
  if (key) {
    const memo = HISTORY_MEMO.get(key)
    if (memo && size >= 0 && memo.size === size) return memo.rows
  }
  const out = []
  const push = (ev) => {
    if (!isStateEvent(ev)) return
    if (!ev.data || !ev.data.doc) return
    out.push(ev.data)
  }
  const collect = (source) => {
    if (!source) return false
    try {
      if (Array.isArray(source)) { source.forEach(push); return true }
      if (typeof source.values === 'function') { for (const ev of source.values()) push(ev); return true }
      if (typeof source.entries === 'function') { for (const ev of source.entries()) push(Array.isArray(ev) ? ev[1] : ev); return true }
      if (typeof source[Symbol.iterator] === 'function') { for (const ev of source) push(ev); return true }
    } catch { /* 下一个来源 */ }
    return false
  }
  try {
    let scanned = collect(session && session.events) || collect(session && session.log)
    if (!scanned && session && typeof session.entries === 'function') {
      for (const ev of session.entries()) push(Array.isArray(ev) ? ev[1] : ev)
      scanned = true
    }
    if (!scanned && session && typeof session.eventAt === 'function' && Number.isFinite(Number(session.seq))) {
      for (let seq = Number(session.seq); seq >= 0 && out.length < 200; seq--) push(session.eventAt(seq))
      if (out.length) scanned = true
    }
    const cached = session && LAST_ENVELOPE.get(session.id)
    if (cached && !out.includes(cached)) out.push(cached)
  } catch { /* ignore */ }
  const rows = out.reverse().slice(0, 200)
  if (key && size >= 0 && rows.length > 0) HISTORY_MEMO.set(key, { size, rows })
  else if (key) HISTORY_MEMO.delete(key)
  return rows
}

/**
 * 最新一份可信存档。
 *
 * ⚠️ 「可信」不等于「解析得动」。读路径一旦把「读失败」当成「没有」，
 * 就会拿 defaultDoc() 当底本，下一次写入就用一份空壳覆盖掉用户真实设好的风格 ——
 * 表现是「昨天调好的风格今天打开全没了」，和 rpg-status 当年
 * 「数值被默认值整份覆盖」是同一个坑。
 *
 * 所以这里只认「有 doc 且 doc 是我们写出去的形状」的记录。
 */
function latestEnvelope(session) {
  try {
    for (const row of historyOf(session)) {
      if (checkEnvelope(row) !== null) continue
      if (!row || !row.doc || typeof row.doc !== 'object') continue
      // 空壳（既没预设也没维度）不算可信：那是某次读失败写出去的残骸
      const hasShape = row.doc.preset !== undefined
        || (row.doc.dims && typeof row.doc.dims === 'object' && Object.keys(row.doc.dims).length > 0)
      if (!hasShape) continue
      return row
    }
  } catch { /* ignore */ }
  try {
    const cached = (session && LAST_ENVELOPE_OBJ.get(session)) || (session && LAST_ENVELOPE.get(session.id))
    if (cached && checkEnvelope(cached) === null && cached.doc) return cached
  } catch { /* ignore */ }
  return null
}

/** 当前文档（给「读」用：永远返回合法对象，没有存档就是默认文档）。 */
function currentDoc(session) {
  const env = latestEnvelope(session)
  return { doc: env ? normalizeDoc(env.doc) : defaultDoc(), turn: env ? (env.turn ?? null) : null, hasSave: !!env }
}

/**
 * 写前底本（给「写」用）。
 *
 * 与 currentDoc 的区别是刻意的：currentDoc 没有存档时给默认值，方便渲染；
 * 但写路径绝不能因为一次读失败就把默认值写进日志。所以写入前必须再确认一次
 * 「日志里到底有没有可信存档」，一条都没有才算真的第一次用。
 */
function trustedBase(session) {
  const env = latestEnvelope(session)
  if (env) return { doc: normalizeDoc(env.doc), turn: env.turn ?? null, recovered: false }
  return { doc: defaultDoc(), turn: null, recovered: true }
}

function envelopeOf(doc, turn) {
  return { doc: normalizeDoc(doc), turn: Number.isFinite(Number(turn)) ? Number(turn) : null, updatedAt: nowIso() }
}

// ---------------------------------------------------------------- 会话文本（触发性条目用）

/** 从一条会话事件里抠出纯文本（各种消息形状都兜）。 */
function textOfEvent(event) {
  try {
    if (!event) return ''
    const t = event.type
    if (t !== 'user/message' && t !== 'assistant/message' && t !== 'developer/message') return ''
    const data = event.data
    const message = t === 'user/message' ? data : (data && data.message)
    if (!message) return ''
    const content = message.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const bits = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') bits.push(block.text)
    }
    return bits.join('\n')
  } catch { return '' }
}

/** 维护「最近若干条消息」的滑动窗口。 */
function noteMessage(session, event) {
  const text = textOfEvent(event)
  if (!text || !session) return
  const key = session.id || 'last'
  let arr = RECENT_TEXT.get(key)
  if (!arr) { arr = []; RECENT_TEXT.set(key, arr) }
  arr.push(text.slice(0, 4000))
  while (arr.length > SCAN_MESSAGES) arr.shift()
}

function recentText(session) {
  if (!session) return ''
  const arr = RECENT_TEXT.get(session.id || 'last')
  return Array.isArray(arr) ? arr.join('\n') : ''
}

// ---------------------------------------------------------------- 探针

function probe(stage, extra) {
  try {
    if (!DSH_HOME) return
    const dir = path.join(DSH_HOME, 'writing-style')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'boot.log')
    try { if (fs.statSync(file).size > 64 * 1024) fs.writeFileSync(file, '', 'utf8') } catch { /* 首次 */ }
    fs.appendFileSync(file, `${nowIso()} [pid ${process.pid}] ${stage}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}\n`, 'utf8')
  } catch { /* 探针失败不影响插件 */ }
}

// ---------------------------------------------------------------- 插件主体

function apply(root, config) {
  const cfg = Object.assign({ injectPerTurn: true, triggerRules: true, sampleLimit: 4000, enabled: true }, config || {})
  if (cfg && typeof cfg.resolve === 'function') {
    try { Object.assign(cfg, cfg.resolve({})) } catch { /* 用原值 */ }
  }
  probe('apply', { dshHome: !!DSH_HOME, config: cfg })
  if (cfg.enabled === false) { probe('disabled-by-config'); return }

  try {
    root.on('session/created', (session) => { lastSession = session })
    root.on('session/event', (session, event) => {
      if (!session) return
      lastSession = session
      if (session.id && isStateEvent(event)) HISTORY_MEMO.delete(session.id)
      noteMessage(session, event)
    })
  } catch (err) {
    probe('on-failed', { error: String((err && err.message) || err) })
  }

  root.inject(['tools', 'sessionProjections', 'systemPrompt'], (sctx) => {
    // ⚠️ 局部 inject 回调里服务只能走 sctx.get(name)；sctx.tools 是 undefined。
    const svc = (n) => {
      try { return (sctx && typeof sctx.get === 'function') ? sctx.get(n) : null } catch { return null }
    }
    const toolReg = svc('tools')
    const projections = svc('sessionProjections')
    const prompt = svc('systemPrompt')
    if (!toolReg || !projections || !prompt) {
      probe('services-missing', { tools: !!toolReg, sessionProjections: !!projections, systemPrompt: !!prompt })
      return
    }
    probe('services-ready')

    // ---------- 投影 ----------
    projections.register({
      key: DOC_KEY,
      stateVersion: STATE_VERSION,
      stateSchema,
      init: () => null,
      apply: (state, event) => {
        if (!isStateEvent(event)) return state
        const data = event.data
        if (!data || !data.doc) return state
        if (checkEnvelope(data) !== null) return state
        return data
      },
      wire: {
        viewSchema,
        view: (state) => (checkEnvelope(state) === null ? state : null),
      },
    })

    // ---------- 每轮注入 ----------
    if (cfg.injectPerTurn) {
      // ⚠️ section 的正文用 `text` 字段承载；宿主对 `typeof text === 'function'`
      // 的形态是支持的（每轮 assemble 时以 assembleContext 调一次）。
      // 写成 `provider:` 会被当成未知字段忽略 → 段落永远为空。
      prompt.section({
        name: 'writing-style:directive',
        order: SECTION_ORDER,
        // interpolate:false —— 用户写的自由指令/范文里可能有 {{ }}，
        // 默认的变量插值会把它当 prompt variable 解析并抛错，整轮 assemble 直接失败。
        interpolate: false,
        text: (context) => {
          try {
            const session = (context && context.agent && context.agent.session) || sessionOf(sctx)
            const { doc } = currentDoc(session)
            if (!doc.enabled) return ''
            return renderDirective(trimDoc(doc, cfg.sampleLimit))
          } catch (err) {
            try { console.warn('[writing-style] 风格渲染失败：' + String((err && err.message) || err)) } catch { /* ignore */ }
            return ''
          }
        },
      })
    }

    // 触发性条目：单独一个 context（不是 section）—— 它按「本轮消息」变化，
    // 放在动态上下文里才不会污染可缓存的前缀。
    if (cfg.triggerRules) {
      try {
        prompt.context({
          name: 'writing-style:rules',
          order: RULE_CONTEXT_ORDER,
          interpolate: false,
          text: (context) => {
            try {
              const session = (context && context.agent && context.agent.session) || sessionOf(sctx)
              const { doc } = currentDoc(session)
              if (!doc.enabled) return ''
              return renderRules(doc, [recentText(session)])
            } catch { return '' }
          },
        })
      } catch { /* 老宿主没有 context() */ }
    }

    // ---------- 工具 ----------
    let count = 0
    for (const make of [toolGet, toolSet, toolPreset, toolRules]) {
      try { toolReg.register(make(sctx, cfg)); count++ } catch (err) {
        probe('tool-failed', { error: String((err && err.message) || err) })
      }
    }
    probe('tools-registered', { count })

    // ---------- 面板路由 ----------
    try {
      const ok = installRoute(sctx, cfg)
      probe(ok ? 'route-registered' : 'route-skipped', { route: ROUTE_PREFIX })
    } catch (err) {
      probe('route-failed', { error: String((err && err.message) || err) })
    }
    probe('ready')
  })
}

/** 上下文 provider / 工具执行时的会话解析。 */
function sessionOf(sctx) {
  try {
    const live = sctx && sctx.agent
    if (live && live.session) return live.session
  } catch { /* ignore */ }
  return lastSession
}

/** 范文裁剪（防止一段范文吃光上下文）。 */
function trimDoc(doc, limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return doc
  if (!doc.sample || doc.sample.length <= n) return doc
  return { ...doc, sample: doc.sample.slice(0, n) + '\n…（范文过长，已截断）' }
}

// ---------------------------------------------------------------- 工具

function withSession(sctx, exec) {
  const session = (exec && exec.agent && exec.agent.session) || sessionOf(sctx)
  if (!session) throw new Error('写作风格需要会话上下文')
  lastSession = session
  return session
}

function turnOf(exec) {
  const t = Number(exec && exec.turn)
  return Number.isFinite(t) ? t : null
}

/** 把一次写入落盘并返回给模型的完整回执。 */
function commit(sctx, exec, mutate, reason) {
  const session = withSession(sctx, exec)
  // ⚠️ 底本必须走 trustedBase，不能走 currentDoc：
  // 后者在没有存档时给默认文档，一次读失败就会把默认值写进日志覆盖真实风格。
  const base = trustedBase(session)
  const before = base.doc
  const next = mutate(cloneDoc(before))
  next.updatedAt = nowIso()
  const env = envelopeOf(next, turnOf(exec) ?? base.turn)
  recordAppend(session, env)
  probe('commit', { session: session.id || null, reason: reason || null, enabled: next.enabled, recovered: base.recovered })
  return { before, after: next, envelope: env, recovered: base.recovered }
}

const DIM_ENUM_TEXT = DIMENSIONS
  .filter((d) => d.kind === 'enum')
  .map((d) => `${d.k}(${d.l})：${d.options.map(([v, l]) => `${v}=${l}`).join(' / ')}`)
  .join('；')

const DIM_SCALE_TEXT = DIMENSIONS
  .filter((d) => d.kind === 'scale')
  .map((d) => `${d.k}(${d.l})`)
  .join('、')

function toolGet(sctx) {
  return {
    name: 'style_get',
    description: [
      '读取当前会话的写作风格设定（预设名、13 个维度、禁用词、自由指令、范文、触发性条目）。',
      '每轮系统提示已附带渲染好的风格规范；本工具用于核对细节或查看可用预设列表。',
      '传 presets=true 会一并返回全部预设（内置 + 自定义）及其维度差异。',
    ].join(' '),
    parameters: {
      presets: { type: 'boolean', description: '同时返回可用预设列表。' },
    },
    execute(args, exec) {
      const session = withSession(sctx, exec)
      const cur = currentDoc(session)
      const doc = cur.doc
      const out = {
        ok: true,
        enabled: doc.enabled,
        preset: doc.preset,
        presetName: doc.presetName,
        summary: renderSummary(doc),
        dims: doc.dims,
        dimsMeta: DIMENSIONS.map((d) => ({ key: d.k, label: d.l, kind: d.kind, def: d.def, ...(d.options ? { options: d.options.map(([v, l]) => ({ value: v, label: l })) } : {}) })),
        directives: doc.directives,
        sampleLength: (doc.sample || '').length,
        avoid: doc.avoid,
        prefer: doc.prefer,
        rules: doc.rules.map((r) => ({ id: r.id, name: r.name, keys: r.keys, enabled: r.enabled })),
        hasSave: cur.hasSave,
        turn: cur.turn ?? -1,
      }
      if (args && args.presets === true) {
        out.presets = allPresets(readUserPresets()).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom }))
        out.dimRef = { enums: DIM_ENUM_TEXT, scales: DIM_SCALE_TEXT }
      }
      return out
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          preset: { type: 'string' },
          presetName: { type: 'string' },
          summary: { type: 'string' },
          dims: { type: 'json' },
          dimsMeta: { type: 'json' },
          directives: { type: 'string' },
          sampleLength: { type: 'integer' },
          avoid: { type: 'array', items: { type: 'string' } },
          prefer: { type: 'array', items: { type: 'string' } },
          rules: { type: 'json' },
          hasSave: { type: 'boolean' },
          turn: { type: 'integer' },
          presets: { type: 'json' },
          dimRef: { type: 'json' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: renderToolSummary(v) }],
    },
    presentCall: (args) => ({ card: 'generic', title: '读取写作风格', kind: 'other', rawInput: args }),
  }
}

function renderToolSummary(v) {
  const lines = [v.summary || '写作风格']
  const dims = v.dims || {}
  const parts = []
  for (const d of DIMENSIONS) {
    if (!Object.hasOwn(dims, d.k)) continue
    const val = dims[d.k]
    const label = d.kind === 'enum'
      ? (d.options.find(([x]) => x === val) || [null, val])[1]
      : String(val)
    parts.push(`${d.l}=${label}`)
  }
  lines.push(parts.join(' · '))
  if (v.avoid && v.avoid.length) lines.push('禁用词：' + v.avoid.join('、'))
  if (v.directives) lines.push('附加要求：' + v.directives)
  if (v.sampleLength) lines.push(`范文：${v.sampleLength} 字`)
  if (v.rules && v.rules.length) lines.push(`触发性条目：${v.rules.filter((r) => r.enabled).length} 条生效`)
  return lines.join('\n')
}

function toolSet(sctx, cfg) {
  return {
    name: 'style_set',
    description: [
      '修改当前会话的写作风格。所有字段可选，只改传了的。',
      'enabled=true 开启风格注入（默认是关闭的，避免影响日常编码对话）。',
      'dims 是「维度:值」的字符串数组，量表型 0-100，枚举型用英文值或中文名。',
      `枚举维度：${DIM_ENUM_TEXT}。量表维度（0-100）：${DIM_SCALE_TEXT}。`,
      '例：dims=["sentence:20","pov:first","dialogue:70"]；avoid=["不禁","仿佛"] 整体替换禁用词表；',
      'avoidAdd / avoidRemove 是增量增删；prefer 是「优先使用」的正向词表；',
      'directives 是自由指令（追加在规范末尾，优先级最高）；sample 是范文（few-shot，照语感不照抄）；',
      'sampleLimit 只是配置项，不要在这里传。',
    ].join(' '),
    parameters: {
      enabled: { type: 'boolean', description: '是否启用风格注入。' },
      dims: {
        type: 'array',
        description: '维度调整，每项「维度:值」。例：["sentence:20","pov:first"]',
        items: { type: 'string' },
      },
      directives: { type: 'string', description: '自由指令，整段替换。传空串表示清空。' },
      sample: { type: 'string', description: '语感范文，整段替换。传空串表示清空。' },
      avoid: { type: 'array', description: '整体替换禁用词表。', items: { type: 'string' } },
      avoidAdd: { type: 'array', description: '追加禁用词。', items: { type: 'string' } },
      avoidRemove: { type: 'array', description: '移除禁用词。', items: { type: 'string' } },
      prefer: { type: 'array', description: '整体替换「优先使用」词表。', items: { type: 'string' } },
      reason: { type: 'string', description: '一句话说明为什么改（写进日志）。' },
    },
    execute(args, exec) {
      const a = args || {}
      const warnings = []
      const result = commit(sctx, exec, (doc) => {
        if (a.enabled !== undefined) doc.enabled = a.enabled === true
        if (Array.isArray(a.dims)) {
          for (const item of a.dims) {
            const s = String(item)
            const i = s.indexOf(':')
            if (i < 0) { warnings.push(`维度项缺少冒号：${s}`); continue }
            const key = resolveDim(s.slice(0, i))
            if (!key) { warnings.push(`未知维度：${s.slice(0, i)}`); continue }
            const c = coerceDim(key, s.slice(i + 1))
            if (!c.ok) { warnings.push(`维度取值非法：${s}`); continue }
            doc.dims[key] = c.value
          }
          // 手改维度 = 离开预设（否则面板会显示「冷硬派」但数值早已不是它）
          doc.preset = 'custom'
          doc.presetName = '自定义'
        }
        if (typeof a.directives === 'string') doc.directives = a.directives
        if (typeof a.sample === 'string') doc.sample = a.sample
        if (Array.isArray(a.avoid)) doc.avoid = a.avoid.map(String).filter(Boolean)
        if (Array.isArray(a.avoidAdd)) {
          const set = new Set(doc.avoid)
          for (const w of a.avoidAdd) if (w) set.add(String(w))
          doc.avoid = [...set]
        }
        if (Array.isArray(a.avoidRemove)) {
          const drop = new Set(a.avoidRemove.map(String))
          doc.avoid = doc.avoid.filter((w) => !drop.has(w))
        }
        if (Array.isArray(a.prefer)) doc.prefer = a.prefer.map(String).filter(Boolean)
        // 开了开关却没给任何内容 → 至少用当前预设把维度铺满
        if (doc.enabled && !Object.keys(doc.dims || {}).length) doc.dims = presetDims(doc.preset)
        return doc
      }, a.reason)

      return {
        ok: true,
        enabled: result.after.enabled,
        summary: renderSummary(result.after),
        dims: result.after.dims,
        warnings,
        directive: renderDirective(trimDoc(result.after, cfg.sampleLimit)),
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          summary: { type: 'string' },
          dims: { type: 'json' },
          warnings: { type: 'array', items: { type: 'string' } },
          directive: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        // ⚠️ 这里只回一句确认：完整规范已经作为系统提示段注入，再往对话里贴一遍
        // 既是重复占用上下文，也会让用户以为「风格是一段贴在聊天里的文字」。
        text: (v.enabled ? '已启用写作风格' : '已关闭写作风格')
          + (v.enabled ? '：' + stripPrefix(v.summary) : '')
          + (v.warnings && v.warnings.length ? '（⚠ ' + v.warnings.join('；') + '）' : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: '设置写作风格', kind: 'other', rawInput: args }),
  }
}

/** 「写作风格：冷硬派 · …」→「冷硬派 · …」，工具回执里不重复标题。 */
function stripPrefix(summary) {
  return String(summary || '').replace(/^写作风格[:：]\s*/, '')
}

function toolPreset(sctx, cfg) {
  return {
    name: 'style_preset',
    description: [
      '按预设切换写作风格（一次把十几个维度换成成套的搭配），或把当前风格存成自定义预设。',
      'action=apply（默认）：应用预设并自动开启风格注入。',
      'action=list：列出全部预设（内置 + 自定义）。',
      'action=save：把当前风格存成自定义预设，需要 id 与 name。',
      'action=delete：删除自定义预设。',
      `内置预设：${PRESETS.map((p) => `${p.id}(${p.name})`).join(' / ')}。`,
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['apply', 'list', 'save', 'delete'], description: '操作类型，默认 apply。' },
      id: { type: 'string', description: '预设 id。' },
      name: { type: 'string', description: '保存时的显示名。' },
    },
    execute(args, exec) {
      const a = args || {}
      const action = a.action || 'apply'
      if (action === 'list') {
        return {
          ok: true,
          action,
          presets: allPresets(readUserPresets()).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })),
          current: currentDoc(withSession(sctx, exec)).doc.preset,
        }
      }
      if (action === 'save') {
        const id = String(a.id || '').trim()
        if (!id) throw new Error('save 需要 id')
        const session = withSession(sctx, exec)
        const doc = currentDoc(session).doc
        const list = readUserPresets().filter((p) => p.id !== id)
        list.push(toPreset(doc, id, a.name || id))
        writeUserPresets(list)
        return { ok: true, action, id, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, custom: !!p.custom })) }
      }
      if (action === 'delete') {
        const id = String(a.id || '').trim()
        const list = readUserPresets().filter((p) => p.id !== id)
        writeUserPresets(list)
        return { ok: true, action, id, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, custom: !!p.custom })) }
      }
      const id = String(a.id || '').trim()
      const known = allPresets(readUserPresets())
      const hit = known.find((p) => p.id === id) || known.find((p) => p.name === id)
      if (!hit) throw new Error(`未知预设：${id || '(空)'}；可用：${known.map((p) => p.id).join(' / ')}`)
      const result = commit(sctx, exec, (doc) => {
        const next = applyPreset(doc, hit.id)
        next.enabled = true
        // 自定义预设可能带来内置表里没有的维度差异
        for (const [k, v] of Object.entries(hit.dims || {})) {
          const c = coerceDim(k, v)
          if (c.ok) next.dims[k] = c.value
        }
        next.preset = hit.id
        next.presetName = hit.name
        if (hit.directives) next.directives = hit.directives
        if (Array.isArray(hit.avoid) && hit.avoid.length) next.avoid = hit.avoid.slice()
        // 范文是预设的一部分：套用预设却不带范文，等于只套了一半
        if (typeof hit.sample === 'string' && hit.sample) next.sample = hit.sample
        return next
      }, 'preset:' + hit.id)
      return {
        ok: true,
        action: 'apply',
        preset: hit.id,
        presetName: hit.name,
        summary: renderSummary(result.after),
        directive: renderDirective(trimDoc(result.after, cfg.sampleLimit)),
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          id: { type: 'string' },
          preset: { type: 'string' },
          presetName: { type: 'string' },
          summary: { type: 'string' },
          directive: { type: 'string' },
          current: { type: 'string' },
          presets: { type: 'json' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.presets
          ? '可用预设：\n' + v.presets.map((p) => `- ${p.id}（${p.name}）${p.custom ? ' [自定义]' : ''}`).join('\n')
            + (v.current ? `\n当前：${v.current}` : '')
          // 切换成功也只回一句确认，不贴规范正文（规范走系统提示段）
          : (v.action === 'apply' || v.preset
              ? '已启用写作风格：' + stripPrefix(v.summary || '')
              : (v.summary || '已完成')),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: '切换写作预设', kind: 'other', rawInput: args }),
  }
}

function toolRules(sctx) {
  return {
    name: 'style_rules',
    description: [
      '管理「触发性条目」：只有当最近几条消息里出现关键词时才追加注入的写作规则（酒馆世界书那种）。',
      'action=list（默认）/ add / update / delete / toggle。',
      'add 需要 name 与 text，keys 是触发关键词数组（空数组 = 每次都注入）。',
      '例：add {name:"战斗场面", keys:["战斗","开打","交手"], text:"战斗段落句子要更短，每个动作一个短句，禁止形容招式好看。"}',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'delete', 'toggle'], description: '操作，默认 list。' },
      id: { type: 'string', description: '条目 id（add 时留空会自动生成）。' },
      name: { type: 'string', description: '条目名。' },
      keys: { type: 'array', description: '触发关键词。', items: { type: 'string' } },
      text: { type: 'string', description: '命中后追加注入的规则正文。' },
      enabled: { type: 'boolean', description: 'toggle/update 时用。' },
    },
    execute(args, exec) {
      const a = args || {}
      const action = a.action || 'list'
      if (action === 'list') {
        const session = withSession(sctx, exec)
        const doc = currentDoc(session).doc
        return { ok: true, action, rules: doc.rules, matched: renderRules(doc, [recentText(session)]) }
      }
      const result = commit(sctx, exec, (doc) => {
        if (action === 'add') {
          const id = String(a.id || '').trim() || `r${Date.now().toString(36)}`
          doc.rules = doc.rules.filter((r) => r.id !== id)
          doc.rules.push({
            id,
            name: String(a.name || ''),
            keys: Array.isArray(a.keys) ? a.keys.map(String).filter(Boolean) : [],
            text: String(a.text || ''),
            enabled: a.enabled !== false,
          })
        } else if (action === 'delete') {
          doc.rules = doc.rules.filter((r) => r.id !== String(a.id || ''))
        } else if (action === 'update' || action === 'toggle') {
          const id = String(a.id || '')
          doc.rules = doc.rules.map((r) => {
            if (r.id !== id) return r
            return {
              ...r,
              ...(a.name !== undefined ? { name: String(a.name) } : {}),
              ...(Array.isArray(a.keys) ? { keys: a.keys.map(String).filter(Boolean) } : {}),
              ...(a.text !== undefined ? { text: String(a.text) } : {}),
              ...(a.enabled !== undefined ? { enabled: a.enabled === true } : (action === 'toggle' ? { enabled: !r.enabled } : {})),
            }
          })
        }
        return doc
      }, 'rules:' + action)
      return { ok: true, action, rules: result.after.rules }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          rules: { type: 'json' },
          matched: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: (v.rules && v.rules.length
          ? '触发性条目：\n' + v.rules.map((r) => `- [${r.enabled ? '✓' : '✗'}] ${r.id} ${r.name || ''}${r.keys.length ? ' ← ' + r.keys.join('/') : '（总是）'}`).join('\n')
          : '还没有触发性条目。')
          + (v.matched ? '\n\n本轮命中：\n' + v.matched : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: '管理风格条目', kind: 'other', rawInput: args }),
  }
}

// ---------------------------------------------------------------- 用户预设（全局，跨会话）

function presetFile() {
  if (!DSH_HOME) return ''
  return path.join(DSH_HOME, 'writing-style', 'presets.json')
}

function readUserPresets() {
  const file = presetFile()
  if (!file) return []
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writeUserPresets(list) {
  const file = presetFile()
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
    return true
  } catch { return false }
}

// ---------------------------------------------------------------- 面板路由

function installRoute(sctx, cfg) {
  let webServer = null
  try {
    if (typeof sctx.get === 'function') webServer = sctx.get('webServer') || null
    if (!webServer) webServer = sctx.webServer || null
  } catch { webServer = null }
  if (!webServer || typeof webServer.register !== 'function') return false

  const reject = (req) => {
    try {
      let conn = null
      if (typeof sctx.get === 'function') conn = sctx.get('connection')
      if (!conn) conn = sctx.connection || null
      if (conn && typeof conn.requestRejection === 'function') {
        const code = conn.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) return code
        return null
      }
    } catch { return 403 }
    const host = String(req.headers.host || '')
    const hn = host.split(':')[0].replace(/^\[|\]$/g, '')
    if (!(hn === '127.0.0.1' || hn === 'localhost' || hn === '::1')) return 403
    if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return 403
    const origin = req.headers.origin
    if (origin && origin !== 'null') {
      try { if (new URL(origin).host !== host) return 403 } catch { return 403 }
    }
    return null
  }

  let registered
  try {
    registered = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const code = reject(req)
        if (code) {
          res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(code === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        let url
        try { url = new URL(req.url, 'http://127.0.0.1') } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }) }
        const op = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '') || 'state'
        // ⚠️ 面板一定会带 ?session=<id>。带了却解析不到，就**不能**退到「最近一个会话」——
        // 那会把 A 会话的风格写进 B 会话（用户看到的和实际生效的不是一回事）。
        const wantId = url.searchParams.get('session') || ''
        const session = findSession(sctx, wantId)
        const missingExplicit = !!wantId && !session
        try {
          if (op === 'state' && (req.method === 'GET' || req.method === 'HEAD')) {
            const cur = session ? currentDoc(session) : { doc: defaultDoc(), turn: null, hasSave: false }
            return sendJson(res, 200, {
              ok: true,
              envelope: envelopeOf(cur.doc, cur.turn),
              doc: cur.doc,
              dimsMeta: DIMENSIONS,
              presets: allPresets(readUserPresets()).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom, dims: p.dims, directives: p.directives, avoid: p.avoid })),
              directive: renderDirective(cur.doc),
              summary: renderSummary(cur.doc),
              hasSession: !!session,
            })
          }
          if (op === 'presets' && (req.method === 'GET' || req.method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, presets: allPresets(readUserPresets()) })
          }
          if (op === 'rules' && (req.method === 'GET' || req.method === 'HEAD')) {
            const cur = session ? currentDoc(session) : { doc: defaultDoc() }
            return sendJson(res, 200, { ok: true, rules: cur.doc.rules, matched: renderRules(cur.doc, [recentText(session)]) })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

          const body = await readJson(req)
          const opName = op
          if (missingExplicit) return sendJson(res, 404, { ok: false, error: '会话未找到：' + wantId })
          const target = session || lastSession
          if (!target) return sendJson(res, 400, { ok: false, error: '还没有会话：先开一轮对话' })

          if (opName === 'set' || opName === 'toggle' || opName === 'delta' || opName === 'reset') {
            // ⚠️ 写路径的底本走 trustedBase（同 commit）：面板改一个滑块，
            // 绝不能因为此刻读不到存档就把整份风格重置成默认值。
            const base = trustedBase(target)
            const before = base.doc
            const next = cloneDoc(before)
            if (opName === 'reset') {
              const fresh = defaultDoc()
              fresh.enabled = before.enabled
              Object.assign(next, fresh)
            } else if (opName === 'toggle') {
              next.enabled = !before.enabled
            } else if (opName === 'delta') {
              const spec = body.spec && typeof body.spec === 'object' ? body.spec : {}
              for (const [rawKey, rawVal] of Object.entries(spec)) {
                const key = resolveDim(rawKey)
                if (!key) continue
                const dim = DIMENSIONS.find((d) => d.k === key)
                if (!dim) continue
                if (dim.kind === 'scale') {
                  const cur = Number(next.dims[key])
                  const delta = Number(rawVal)
                  if (!Number.isFinite(delta)) continue
                  const c = coerceDim(key, (Number.isFinite(cur) ? cur : 50) + delta)
                  if (c.ok) next.dims[key] = c.value
                } else {
                  const c = coerceDim(key, rawVal)
                  if (c.ok) next.dims[key] = c.value
                }
              }
              next.preset = 'custom'
              next.presetName = '自定义'
            } else {
              // set：面板发来的整块文档（部分字段）
              const patch = body.doc && typeof body.doc === 'object' ? body.doc : body
              if (patch.enabled !== undefined) next.enabled = patch.enabled === true
              if (patch.dims && typeof patch.dims === 'object') {
                for (const [rawKey, rawVal] of Object.entries(patch.dims)) {
                  const key = resolveDim(rawKey)
                  if (!key) continue
                  const c = coerceDim(key, rawVal)
                  if (c.ok) next.dims[key] = c.value
                }
                next.preset = 'custom'
                next.presetName = '自定义'
              }
              if (typeof patch.directives === 'string') next.directives = patch.directives
              if (typeof patch.sample === 'string') next.sample = patch.sample
              if (Array.isArray(patch.avoid)) next.avoid = patch.avoid.map(String).filter(Boolean)
              if (Array.isArray(patch.prefer)) next.prefer = patch.prefer.map(String).filter(Boolean)
              if (Array.isArray(patch.rules)) next.rules = normalizeDoc({ rules: patch.rules }).rules
              if (typeof patch.preset === 'string') {
                const p = allPresets(readUserPresets()).find((x) => x.id === patch.preset)
                if (p) {
                  Object.assign(next, applyPreset(next, p.id))
                  for (const [k, v] of Object.entries(p.dims || {})) {
                    const c = coerceDim(k, v)
                    if (c.ok) next.dims[k] = c.value
                  }
                  next.preset = p.id
                  next.presetName = p.name
                  if (p.directives) next.directives = p.directives
                  if (Array.isArray(p.avoid) && p.avoid.length) next.avoid = p.avoid.slice()
                  if (typeof p.sample === 'string' && p.sample) next.sample = p.sample
                }
              }
            }
            next.updatedAt = nowIso()
            recordAppend(target, envelopeOf(next, base.turn))
            return sendJson(res, 200, {
              ok: true,
              doc: next,
              summary: renderSummary(next),
              directive: renderDirective(next),
              dimsMeta: DIMENSIONS,
            })
          }

          if (opName === 'preset') {
            const id = String(body.id || '')
            const p = allPresets(readUserPresets()).find((x) => x.id === id)
            if (!p) return sendJson(res, 400, { ok: false, error: '未知预设：' + id })
            const base = trustedBase(target)
            const before = base.doc
            const next = applyPreset(before, p.id)
            for (const [k, v] of Object.entries(p.dims || {})) {
              const c = coerceDim(k, v)
              if (c.ok) next.dims[k] = c.value
            }
            next.enabled = body.enabled === false ? false : true
            next.preset = p.id
            next.presetName = p.name
            if (p.directives) next.directives = p.directives
            if (Array.isArray(p.avoid) && p.avoid.length) next.avoid = p.avoid.slice()
            if (typeof p.sample === 'string' && p.sample) next.sample = p.sample
            next.updatedAt = nowIso()
            recordAppend(target, envelopeOf(next, base.turn))
            return sendJson(res, 200, { ok: true, doc: next, summary: renderSummary(next), directive: renderDirective(next) })
          }

          // 自己写入预设：面板把整份内容发过来，这里逐字段校验后落盘。
          // 与 save-preset 的区别：那个是「把当前会话的风格存成预设」，
          // 这个是「直接写一份预设」，不需要先在本会话里调好。
          if (opName === 'write-preset') {
            const id = String(body.id || '').trim()
            if (!/^[a-zA-Z0-9._-]{1,40}$/.test(id)) {
              return sendJson(res, 400, { ok: false, error: '预设 id 只能包含字母、数字、点、下划线、短横线（1-40 位）' })
            }
            const dims = {}
            const srcDims = body.dims && typeof body.dims === 'object' ? body.dims : {}
            for (const [rawKey, rawVal] of Object.entries(srcDims)) {
              const key = resolveDim(rawKey)
              if (!key) continue
              const c = coerceDim(key, rawVal)
              if (c.ok) dims[key] = c.value
            }
            // 与「均衡」相同的维度不落盘：预设只记录差异，日后加旋钮不会让老预设失效
            const base = presetDims('balanced')
            const diff = {}
            for (const [k, v] of Object.entries(dims)) if (v !== base[k]) diff[k] = v
            const preset = {
              id,
              name: String(body.name || id).slice(0, 60),
              desc: String(body.desc || '').slice(0, 200),
              dims: diff,
              directives: typeof body.directives === 'string' ? body.directives.slice(0, 8000) : '',
              avoid: Array.isArray(body.avoid) ? body.avoid.map(String).filter(Boolean).slice(0, 200) : [],
              sample: typeof body.sample === 'string' ? body.sample.slice(0, 20000) : '',
              custom: true,
            }
            const list = readUserPresets().filter((p) => p && p.id !== id)
            list.push(preset)
            const okWrite = writeUserPresets(list)
            probe('write-preset', { id, dims: Object.keys(diff).length, ok: okWrite })
            return sendJson(res, 200, {
              ok: okWrite,
              id,
              preset,
              presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })),
              error: okWrite ? undefined : ('预设目录不可写：' + presetFile()),
            })
          }

          if (opName === 'save-preset') {
            const doc = currentDoc(target).doc
            const id = String(body.id || '').trim() || ('custom-' + Date.now().toString(36))
            const list = readUserPresets().filter((p) => p.id !== id)
            list.push(toPreset(doc, id, body.name || id))
            const okWrite = writeUserPresets(list)
            return sendJson(res, 200, { ok: okWrite, id, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })) })
          }

          if (opName === 'delete-preset') {
            const id = String(body.id || '')
            const list = readUserPresets().filter((p) => p.id !== id)
            writeUserPresets(list)
            return sendJson(res, 200, { ok: true, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })) })
          }

          if (opName === 'undo') {
            const rows = historyOf(target)
            // 去掉最后一条（当前），取上一条当底本
            if (rows.length < 2) return sendJson(res, 200, { ok: false, error: '没有更早的存档可回退' })
            const prev = rows[1]
            const doc = normalizeDoc(prev.doc)
            recordAppend(target, envelopeOf(doc, prev.turn ?? null))
            return sendJson(res, 200, { ok: true, doc, summary: renderSummary(doc), directive: renderDirective(doc) })
          }

          if (opName === 'preview') {
            const doc = normalizeDoc(body.doc || currentDoc(target).doc)
            return sendJson(res, 200, { ok: true, directive: renderDirective(trimDoc(doc, cfg.sampleLimit)), summary: renderSummary(doc) })
          }

          return sendJson(res, 400, { ok: false, error: 'unknown op: ' + opName })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
  } catch (err) {
    try { console.warn('[writing-style] 面板路由注册失败：' + String((err && err.message) || err)) } catch { /* ignore */ }
    throw err
  }

  const dispose = () => {
    try {
      if (typeof registered === 'function') registered()
      else if (registered && typeof registered.then === 'function') registered.then((x) => { if (typeof x === 'function') x() }).catch(() => {})
      else if (registered && typeof registered.dispose === 'function') registered.dispose()
    } catch { /* ignore */ }
  }
  try { sctx.effect(() => dispose) } catch { /* ignore */ }
  return true
}

function sendJson(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch { /* 连接已断 */ }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2_000_000) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const sessionCache = new Map()
function findSession(sctx, id) {
  if (id && sessionCache.has(id)) {
    const s = sessionCache.get(id)
    if (s && s.id === id) return s
    sessionCache.delete(id)
  }
  let agents = null
  try {
    if (typeof sctx.get === 'function') agents = sctx.get('agents')
    if (!agents) agents = sctx.agents || null
  } catch { agents = null }
  if (agents) {
    try {
      const list = typeof agents.list === 'function' ? agents.list() : (Array.isArray(agents.agents) ? agents.agents : null)
      if (Array.isArray(list)) {
        for (const a of list) {
          const s = a && (a.session || a)
          if (s && s.id === id) { if (id) sessionCache.set(id, s); return s }
        }
      }
    } catch { /* ignore */ }
    try {
      if (id && typeof agents.get === 'function') {
        const a = agents.get(id)
        const s = a && (a.session || a)
        if (s && s.id === id) { sessionCache.set(id, s); return s }
      }
    } catch { /* ignore */ }
  }
  if (!id) return lastSession
  if (lastSession && lastSession.id === id) return lastSession
  return null
}

export { name, inject, Config, apply }
export default { name, inject, Config, apply }
