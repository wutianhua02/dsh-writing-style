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
//      给面板读写（预设库 / 11 个维度滑块 / 禁用词 / 范文 / 规则）。
//
// 数据权威源 = 会话日志里的 `plugin:writing-style/state` 记录。
// 为什么不是配置文件：用户要求「每个会话可以不一样」，而配置文件是全局的。
// 用日志 = 撤销有历史、导出会话即导出风格、换窗口/重开客户端都还在。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  DOC_EVENT, DOC_KEY, STATE_VERSION, ENVELOPE_VERSION,
  DIMENSIONS, PRESETS, DEFAULT_AVOID, VIEW_VERSION, RETIRED_DIMS, retiredName,
  defaultDoc, normalizeDoc, cloneDoc, checkDoc, renderDirective, renderRules, renderSummary,
  applyPresetFull, presetDims, coerceDim, resolveDim, toPreset, allPresets, dimsMeta,
} from './style.js'
import { stateSchema, viewSchema, checkEnvelope } from './schema.js'

const name = 'writing-style'
const inject = []

const ROUTE_PREFIX = '/dsh-writing-style'
/** 注入段序号：紧跟 RPG 状态（3200 / 3210）之后，早于工具说明。 */
const SECTION_ORDER = 3300
const RULE_CONTEXT_ORDER = 3310
/** 触发条目扫描的最近消息条数（太多会读到很旧的上下文）。 */
const SCAN_MESSAGES = 8

// ---------------------------------------------------------------- DSH_HOME 解析
//
// ⚠️ 这里**不能**只读 process.env.DSH_HOME。
// 桌面端从 rc.3 升到 rc.5 之后，Launcher 把 DSH_* 前缀的变量从宿主环境里过滤掉了
// （app.asar/lib/main.js 的 LAUNCHER_OWNED_PREFIXES = ["DSH_","ELECTRON_"]），
// Host 进程因此拿不到 DSH_HOME。后果很隐蔽：
//   · presetFile() 返回 ''  →  写预设直接跳过 → 面板点了「写入预设」像没反应
//   · probe() 第一行就 return → boot.log 停在最后一次还能拿到变量的那天，
//     看起来像「插件根本没加载」，而注入和工具其实都在正常工作
// 所以 home 必须有多条互相独立的推导路径，任何一条命中就能落盘。

function isDir(p) {
  if (typeof p !== 'string' || !p) return false
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function pushCandidate(list, p) {
  if (typeof p !== 'string') return
  const s = p.trim().replace(/^["']|["']$/g, '')
  if (!s) return
  let abs = s
  try { abs = path.resolve(s) } catch { return }
  if (!list.includes(abs)) list.push(abs)
}

/** 显式指定预设目录（最高优先级）：想让预设放到别处就用它，测试也靠它。 */
function homeFromOverride() {
  const out = []
  for (const key of ['WRITING_STYLE_HOME', 'DSH_WRITING_STYLE_HOME']) {
    const v = process.env[key]
    if (typeof v === 'string' && v.trim()) pushCandidate(out, v)
  }
  return out
}

/** 环境变量：还带着就用它（web / CLI 启动的场合）。 */
function homeFromEnv() {
  const out = []
  for (const key of ['DSH_HOME', 'DSH_ROOT', 'DSH_DATA_HOME']) {
    const v = process.env[key]
    if (typeof v === 'string' && v.trim()) pushCandidate(out, v)
  }
  return out
}

/**
 * 从宿主包的导出里要 home（升级后可能重新提供，所以排在环境之后）。
 * 和 schemastery 一样用 createRequire 试多个基准：拿不到就跳过，绝不因此让插件挂掉。
 */
function homeFromHostPackage() {
  const out = []
  const reqs = []
  try { reqs.push(createRequire(import.meta.url)) } catch { /* ignore */ }
  for (const b of ['E:/dsh/resources/app/dsh/package.json', 'E:/dsh/resources/app/package.json']) {
    try { reqs.push(createRequire(b)) } catch { /* ignore */ }
  }
  for (const req of reqs) {
    for (const spec of ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-paths', '@deepseek-ai/dsh-layout']) {
      let ns = null
      try { const m = req(spec); ns = (m && (m.default || m)) || null } catch { continue }
      if (!ns) continue
      for (const fn of ['resolveDshHome', 'defaultDshHome', 'dshHome']) {
        if (typeof ns[fn] === 'function') { try { pushCandidate(out, ns[fn]()) } catch { /* 试下一个 */ } }
      }
      for (const key of ['DSH_HOME_DEFAULT', 'DEFAULT_DSH_HOME']) {
        if (typeof ns[key] === 'string') pushCandidate(out, ns[key])
      }
    }
  }
  return out
}

/**
 * 从插件自己的安装位置反推。
 * 布局固定是 <HOME>/profiles/<profile>/node_modules|vendor/<pkg>/…，
 * realpath 之后往上找名为 profiles 的段，它的前一级就是 home。**不依赖任何环境变量**。
 */
function homeFromModulePath() {
  const out = []
  let cur = ''
  try {
    const rel = new URL(import.meta.url).pathname
    cur = fs.realpathSync(decodeURIComponent(/^\/(.:[\\/].*)$/i.test(rel) ? rel.slice(1) : rel))
  } catch { return out }
  for (let i = 0; i < 12 && cur; i++) {
    const parent = path.dirname(cur)
    if (!parent || parent === cur) break
    if (path.basename(parent) === 'profiles') pushCandidate(out, path.dirname(parent))
    cur = parent
  }
  return out
}

/**
 * 从启动命令行反推。实测宿主 argv：
 *   "…\DeepSeek Harness.exe" --expose-internals <asar>\dsh-desktop-host\lib\index.js
 *   <asar>\dsh  C:\Users\wtc12\.dsh\profiles\desktop  <asar>\runtime\… …
 * 目标就是那个 <HOME>/profiles/<name>，取它的上上级。
 */
function homeFromArgv() {
  const out = []
  const words = []
  for (const a of (Array.isArray(process.argv) ? process.argv : [])) {
    if (typeof a !== 'string' || !a) continue
    words.push(a)
    const eq = a.indexOf('=')
    if (eq > 0 && eq + 1 < a.length) words.push(a.slice(eq + 1))
  }
  for (const w of words) {
    const segs = w.replace(/\\/g, '/').replace(/\/\/+/g, '/').split('/')
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i] === 'profiles' && segs[i + 1]) {
        const home = segs.slice(0, i).join('/')
        if (home) pushCandidate(out, home)
      }
      if (segs[i] === '.dsh') {
        const home = segs.slice(0, i + 1).join('/')
        if (home) pushCandidate(out, home)
      }
    }
  }
  return out
}

/** 最后兜底：默认位置 ~/.dsh。 */
function homeFromDefault() {
  const out = []
  try { pushCandidate(out, path.join(os.homedir(), '.dsh')) } catch { /* ignore */ }
  return out
}

let HOME_RESOLVED
let HOME_WHY = ''
/** 候选与结论（面板/日志用来回答「这次到底从哪拿到的 home」）。 */
let HOME_DIAGNOSTICS = { tried: [], hit: '', why: '' }
function dshHome() {
  if (HOME_RESOLVED !== undefined) return HOME_RESOLVED
  const tried = []
  let hit = ''
  for (const [stage, fn] of [
    ['override', homeFromOverride],
    ['env', homeFromEnv],
    // ⚠️ 顺序即优先级：**实测证据排在猜测前面**。
    // `argv` 是「这个进程」的真实启动参数（宿主把 profiles/<name> 写在命令行里），
    // `host-package` 只是「拿宿主包的默认值猜一下」，在 DSH_HOME 被剥掉、而用户 home
    // 不是 ~/.dsh 的机器上它会指到错的目录 —— 目录「存在」，isDir 拦不住，
    // 预设就静默写进了另一个 home（存档与会话日志分叉，面板看着一切正常）。
    // 2026-11-01 实测：宿主升级成解包树后 @deepseek-ai/dsh-home-paths 变得可解析，
    // RPG 插件那边正是这么被顶掉的（那边已改，这里同步）。
    ['argv', homeFromArgv],
    ['module-path', homeFromModulePath],
    ['host-package', homeFromHostPackage],
    ['default', homeFromDefault],
  ]) {
    let list = []
    try { list = fn() } catch { list = [] }
    for (const c of list) {
      tried.push(stage + ' → ' + c)
      if (!hit && isDir(c)) { hit = c; HOME_WHY = stage }
    }
  }
  HOME_RESOLVED = hit
  HOME_DIAGNOSTICS = { tried, hit, why: HOME_WHY }
  return hit
}
function homeDiagnostics() {
  dshHome()
  return HOME_DIAGNOSTICS
}
/** 旧写法保留（只作环境变量的观测值，真正的路径一律走 dshHome()）。 */
const DSH_HOME = process.env.DSH_HOME || ''

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
  const home = dshHome()
  if (home) {
    bases.push(path.join(home, 'profiles', 'desktop', 'package.json'))
    bases.push(path.join(home, 'profiles', 'web', 'package.json'))
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
    const dir = path.join(dshHome() || path.join(os.tmpdir(), 'dsh-writing-style-probe'), 'writing-style')
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
  probe('apply', { dshHome: dshHome() || '(未解析)', homeFrom: homeDiagnostics().why, envHad: !!DSH_HOME, config: cfg })
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
      let def
      try { def = make(sctx, cfg) } catch (err) {
        probe('tool-failed', { step: 'build', error: String((err && err.message) || err) })
        continue
      }
      // ⚠️ parameters 的**上游契约**：直接注册的工具会被宿主原样发给上游，
      // 所以根部必须是 `{type:'object', properties:{…}}`。写成裸映射（没有 type）时
      // 上游会逐轮报 `schema must be a JSON Schema of 'type: "object"', got 'type: null'`，
      // 而 boot.log 里 count 仍然是 4、面板也正常 —— 排查起来像见了鬼（2026-11-01 真机）。
      // 这里当场拦下并留痕：宁可少一个工具，也不让整轮对话挂掉。
      const paramsErr = toolParametersProblem(def && def.parameters)
      if (paramsErr) {
        probe('tool-params-invalid', { tool: def && def.name, error: paramsErr })
        continue
      }
      try { toolReg.register(def); count++ } catch (err) {
        probe('tool-failed', { error: String((err && err.message) || err) })
      }
    }
    probe('tools-registered', { count })
    probe('ready')
  })

  // ---------- 面板路由（独立 inject 块）----------
  // ⚠️ 路由**不能**在上面那个 inject 块里注册：本块只声明了
  // tools/sessionProjections/systemPrompt，而 Cordis 的 `ctx.get(name)` 对**没声明**
  // 的服务在活跃 fiber 里拿到的是 undefined（`_getImpl` 只查 isolate store；
  // 那条 `prop in fiber.inject` 分支是给「已声明但还没就位」报错的）。于是
  // `sctx.get('webServer')` 在真机上永远为空 → installRoute 直接 return false
  // → boot.log 里一条 `route-skipped`，面板空白，而且**不抛任何错**。
  // 宿主自己的 web 路由插件用的是 `ctx.inject(["connection","webServer"], …)`；
  // 我们照它另开一块，把路由真正用到的服务声明上。
  //
  // `connection` **故意不声明**：没有它的宿主会让整块永远等下去，面板就彻底没了；
  // installRoute 里取不到它会退到自建的同源/回环校验。
  //
  // 分成两块还有第二个理由：纯 CLI 这类没有 webServer 的宿主里，只有这块不跑，
  // 工具与提示注入照常工作，而不是被路由一起拖死。
  root.inject(['webServer', 'agents'], (rctx) => {
    try {
      const ok = installRoute(rctx, cfg)
      probe(ok ? 'route-registered' : 'route-skipped', { route: ROUTE_PREFIX })
    } catch (err) {
      probe('route-failed', { error: String((err && err.message) || err) })
    }
  })
}

/**
 * 检查工具 `parameters` 的上游契约：必须是 `{type:'object', properties:{…}}`。
 *
 * 宿主 `tools.register()` 只校验 `output.schema`，**不编译 parameters**；直接注册时
 * 这个对象会被原样发给上游。写成裸映射就变成 `type: null`，上游逐轮报
 * `schema must be a JSON Schema of 'type: "object"'`，而本地一切看起来都正常 ——
 * 2026-11-01 就是这么把整轮对话弄挂的。
 *
 * @returns {string|null} 有问题时返回一句能读懂的原因（写进 boot.log），没问题返回 null
 */
function toolParametersProblem(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'parameters 缺失或不是对象'
  if (params.type !== 'object') {
    return `parameters.type 必须是 'object'（现在是 ${JSON.stringify(params.type)}）——裸映射会被上游当 type:null 拒掉`
  }
  if (!params.properties || typeof params.properties !== 'object' || Array.isArray(params.properties)) {
    return 'parameters.properties 必须是对象（零参数也要写 {}）'
  }
  return null
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

const DIM_SCALE_TEXT = DIMENSIONS
  .filter((d) => d.kind === 'scale')
  .map((d) => `${d.k}(${d.l})`)
  .join('、')

function toolGet(sctx) {
  return {
    name: 'style_get',
    description: [
      '读取当前会话的写作风格设定（预设名、11 个维度、禁用词、自由指令、范文、触发性条目）。',
      '每轮系统提示已附带渲染好的风格规范；本工具用于核对细节或查看可用预设列表。',
      '传 presets=true 会一并返回全部预设（内置 + 自定义）及其维度差异。',
    ].join(' '),
    // ⚠️ parameters 必须是**标准 JSON Schema**（type:'object' + properties）。
    // 直接注册的工具，宿主会把这里的对象**原样**发给上游；写成「属性名→schema」的裸映射
    // 就没有 type，上游（workbuddy/OpenAI 形状）直接拒：
    //   Invalid schema for function 'style_get': schema must be a JSON Schema of
    //   'type: "object"', got 'type: null'
    // 这一条 2026-11-01 真机会话就是这么失败的（4 个工具全中）。
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        presets: { type: 'boolean', description: '同时返回可用预设列表。' },
      },
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
        dimsMeta: dimsMeta(),
        directives: doc.directives,
        sampleLength: (doc.sample || '').length,
        avoid: doc.avoid,
        prefer: doc.prefer,
        rules: doc.rules.map((r) => ({ id: r.id, name: r.name, keys: r.keys, enabled: r.enabled })),
        hasSave: cur.hasSave,
        turn: cur.turn ?? -1,
        // 不带 presets 也要给出维度参照与退役名单：模型读到 style_get 就该知道
        // 「视角/时态已经没有了」，否则它会照旧习惯再传一次 pov。
        dimRef: { scales: DIM_SCALE_TEXT, retired: [...RETIRED_DIMS.keys()] },
      }
      if (args && args.presets === true) {
        out.presets = allPresets(readUserPresets()).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom }))
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
          dims: { type: 'object', additionalProperties: true },
          dimsMeta: { type: 'array', items: { type: 'object', additionalProperties: true } },
          directives: { type: 'string' },
          sampleLength: { type: 'integer' },
          avoid: { type: 'array', items: { type: 'string' } },
          prefer: { type: 'array', items: { type: 'string' } },
          rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
          hasSave: { type: 'boolean' },
          turn: { type: 'integer' },
          presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          dimRef: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scales: { type: 'string' },
              retired: { type: 'array', items: { type: 'string' } },
            },
          },
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
      'dims 是「维度:值」的字符串数组，每个维度 0-100。',
      `可用维度（0-100）：${DIM_SCALE_TEXT}。`,
      '例：dims=["sentence:20","dialogue:70","pace:80"]；avoid=["不禁","仿佛"] 整体替换禁用词表；',
      '⚠️ 叙事视角（pov）与叙述时态（tense）已经从本插件移除，不要再传；需要人称/时态请在正文或附加要求里说明。',
      'avoidAdd / avoidRemove 是增量增删；prefer 是「优先使用」的正向词表；',
      'directives 是自由指令（追加在规范末尾，优先级最高）；sample 是范文（few-shot，照语感不照抄）；',
      'sampleLimit 只是配置项，不要在这里传。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: '是否启用风格注入。' },
        dims: {
          type: 'array',
          description: '维度调整，每项「维度:值」（0-100）。例：["sentence:20","pace:80"]',
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
            if (!key) {
              const retired = retiredName(s.slice(0, i))
              warnings.push(retired
                ? `「${retired}」已从本插件移除（视角/时态由正文决定），忽略：${s}`
                : `未知维度：${s.slice(0, i)}`)
              continue
            }
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
          dims: { type: 'object', additionalProperties: true },
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
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['apply', 'list', 'save', 'delete'], description: '操作类型，默认 apply。' },
        id: { type: 'string', description: '预设 id。' },
        name: { type: 'string', description: '保存时的显示名。' },
      },
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
        const res = writeUserPresets(list)
        if (!res.ok) throw new Error('预设没存上：' + res.error)
        return { ok: true, action, id, file: res.file, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, custom: !!p.custom })) }
      }
      if (action === 'delete') {
        const id = String(a.id || '').trim()
        const list = readUserPresets().filter((p) => p.id !== id)
        const res = writeUserPresets(list)
        if (!res.ok) throw new Error('预设没删掉：' + res.error)
        return { ok: true, action, id, file: res.file, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, custom: !!p.custom })) }
      }
      const id = String(a.id || '').trim()
      const known = allPresets(readUserPresets())
      const hit = known.find((p) => p.id === id) || known.find((p) => p.name === id)
      if (!hit) throw new Error(`未知预设：${id || '(空)'}；可用：${known.map((p) => p.id).join(' / ')}`)
      const result = commit(sctx, exec, (doc) => {
        // 完整套用预设的 5 项（维度/禁用词/偏好词/附加要求/范文）——预设即这套。
        const next = applyPresetFull(doc, hit)
        next.enabled = true
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
          presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'delete', 'toggle'], description: '操作，默认 list。' },
        id: { type: 'string', description: '条目 id（add 时留空会自动生成）。' },
        name: { type: 'string', description: '条目名。' },
        keys: { type: 'array', description: '触发关键词。', items: { type: 'string' } },
        text: { type: 'string', description: '命中后追加注入的规则正文。' },
        enabled: { type: 'boolean', description: 'toggle/update 时用。' },
      },
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
          rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
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

/**
 * 预设文件路径。解析不出 home 时返回 ''，调用方**必须**把它当成错误报给面板，
 * 不能静默返回空列表 —— 静默失败就是用户看到的「点了写入预设没反应」。
 */
function presetFile() {
  const home = dshHome()
  if (!home) return ''
  return path.join(home, 'writing-style', 'presets.json')
}

/** 最近一次读/写预设文件的真实错误（面板用它解释「为什么没保存上」）。 */
let presetLastError = ''

/** 面板显示的存储状态：路径 + 是否可写 + 上次错误。 */
function storageInfo() {
  const file = presetFile()
  const diag = homeDiagnostics()
  return {
    file,
    home: diag.hit,
    homeFrom: diag.why,
    writable: !!file && fs.existsSync(path.dirname(file)),
    error: presetLastError || '',
    envHome: DSH_HOME || '',
    pid: process.pid,
  }
}

function readUserPresets() {
  const file = presetFile()
  if (!file) {
    presetLastError = '没解析出 DSH home（候选：' + (homeDiagnostics().tried.join(' | ') || '无') + '），预设无处可存'
    return []
  }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    presetLastError = ''
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    const code = err && err.code
    // 文件还没写过一次不算错误
    if (code === 'ENOENT') { presetLastError = ''; return [] }
    presetLastError = '读 ' + file + ' 失败：' + String((err && err.message) || err)
    return []
  }
}

/**
 * @returns {{ok: boolean, file: string, error: string}}
 * 以前只返回 true/false，出错时用户什么也看不到，只能瞎猜。
 */
function writeUserPresets(list) {
  const file = presetFile()
  if (!file) {
    const msg = '没解析出 DSH home（候选：' + (homeDiagnostics().tried.join(' | ') || '无') + '）'
    presetLastError = msg
    return { ok: false, file: '', error: msg }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    const body = JSON.stringify(list, null, 2)
    fs.writeFileSync(tmp, body, 'utf8')
    // 原子替换：中途崩溃不会留下半截 JSON（半截 = 整份预设库读不出来）
    try {
      fs.renameSync(tmp, file)
    } catch (err) {
      if (err && err.code === 'EPERM') { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp) }
      else throw err
    }
    presetLastError = ''
    return { ok: true, file, error: '' }
  } catch (err) {
    const msg = '写 ' + file + ' 失败：' + String((err && err.message) || err)
    presetLastError = msg
    probe('write-user-presets-failed', { file, error: String((err && (err.code || err.message)) || err) })
    return { ok: false, file, error: msg }
  }
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
              dimsMeta: dimsMeta(),
              presets: allPresets(readUserPresets()).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom, dims: p.dims, directives: p.directives, avoid: p.avoid, prefer: p.prefer, sample: p.sample })),
              directive: renderDirective(cur.doc),
              summary: renderSummary(cur.doc),
              hasSession: !!session,
              // 存储位置直接回给面板：一旦「存不上」，用户能立刻看到是没解析出目录，
              // 而不是对着一个没反应的按钮瞎猜。
              storage: storageInfo(),
            })
          }
          if (op === 'presets' && (req.method === 'GET' || req.method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, presets: allPresets(readUserPresets()), storage: storageInfo() })
          }
          if (op === 'rules' && (req.method === 'GET' || req.method === 'HEAD')) {
            const cur = session ? currentDoc(session) : { doc: defaultDoc() }
            return sendJson(res, 200, { ok: true, rules: cur.doc.rules, matched: renderRules(cur.doc, [recentText(session)]) })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

          const body = await readJson(req)
          const opName = op

          // 预设是**全局**的（存在 <DSH home>/writing-style/presets.json），与会话无关。
          // 所以这几个操作必须在「会话解析失败」之前处理 —— 否则用户在设置页里
          // 写预设会莫名其妙 404（面板传的 session id 与 agents 注册的 id 不一定一致）。
          if (opName === 'write-preset') {
            const id = String(body.id || '').trim()
            if (!/^[a-zA-Z0-9._-]{1,40}$/.test(id)) {
              return sendJson(res, 400, { ok: false, error: '预设 id 只能包含字母、数字、点、下划线、短横线（1-40 位）' })
            }
            const dims = {}
            const ignored = []
            const srcDims = body.dims && typeof body.dims === 'object' ? body.dims : {}
            for (const [rawKey, rawVal] of Object.entries(srcDims)) {
              const key = resolveDim(rawKey)
              // 已经不存在的维度（例如旧版留下的「视角/时态」）明确告知，别静默吞掉：
              // 吞掉的话用户会以为「存了但没生效」，又得回来问一遍。
              if (!key) { if (retiredName(rawKey)) ignored.push(String(rawKey)); continue }
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
              prefer: Array.isArray(body.prefer) ? body.prefer.map(String).filter(Boolean).slice(0, 200) : [],
              sample: typeof body.sample === 'string' ? body.sample.slice(0, 20000) : '',
              custom: true,
            }
            const list = readUserPresets().filter((p) => p && p.id !== id)
            list.push(preset)
            const wrote = writeUserPresets(list)
            probe('write-preset', {
              id, dims: Object.keys(diff).length, ok: wrote.ok, file: wrote.file,
              ignored: ignored.length ? ignored : undefined, error: wrote.error || undefined,
            })
            return sendJson(res, wrote.ok ? 200 : 500, {
              ok: wrote.ok,
              id,
              file: wrote.file,
              storedDims: Object.keys(diff),
              ignored: ignored.length ? ignored : undefined,
              note: ignored.length
                ? ('已忽略这些不再支持的维度：' + ignored.join('、') + '（视角与时态已取消）')
                : undefined,
              preset,
              presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })),
              error: wrote.ok ? undefined : ('预设没写进磁盘：' + wrote.error),
            })
          }

          if (opName === 'delete-preset') {
            const id = String(body.id || '')
            const list = readUserPresets().filter((p) => p.id !== id)
            const wrote = writeUserPresets(list)
            probe('delete-preset', { id, ok: wrote.ok, error: wrote.error || undefined })
            if (!wrote.ok) {
              return sendJson(res, 500, { ok: false, error: '预设没删掉：' + wrote.error })
            }
            return sendJson(res, 200, { ok: true, file: wrote.file, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })) })
          }

          // 其余操作都写会话日志，必须要有会话。
          // ⚠️ 带了 session 却解析不到时不能退到「最近一个会话」：
          // 那会把 A 会话的风格写进 B 会话（用户看到的和实际生效的不是一回事）。
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
                  // 同一路由里若同时带了 preset，就以 preset 为准完整替换五项。
                  Object.assign(next, applyPresetFull(next, p))
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
              dimsMeta: dimsMeta(),
            })
          }

          if (opName === 'preset') {
            const id = String(body.id || '')
            const p = allPresets(readUserPresets()).find((x) => x.id === id)
            if (!p) return sendJson(res, 400, { ok: false, error: '未知预设：' + id })
            const base = trustedBase(target)
            // 完整套用：维度/禁用词/偏好词/附加要求/范文都以这份预设为准，
            // 不再残留上一套的自定义内容（这才是「每个预设独立」）。
            const next = applyPresetFull(base.doc, p)
            next.enabled = body.enabled === false ? false : true
            recordAppend(target, envelopeOf(next, base.turn))
            return sendJson(res, 200, { ok: true, doc: next, summary: renderSummary(next), directive: renderDirective(next) })
          }

          // 自己写入预设：面板把整份内容发过来，这里逐字段校验后落盘。
          // 与 save-preset 的区别：那个是「把当前会话的风格存成预设」，
          // 这个是「直接写一份预设」，不需要先在本会话里调好。
          if (opName === 'save-preset') {
            const doc = currentDoc(target).doc
            const id = String(body.id || '').trim() || ('custom-' + Date.now().toString(36))
            const list = readUserPresets().filter((p) => p.id !== id)
            list.push(toPreset(doc, id, body.name || id))
            const wrote = writeUserPresets(list)
            probe('save-preset', { id, ok: wrote.ok, error: wrote.error || undefined })
            if (!wrote.ok) return sendJson(res, 500, { ok: false, error: '预设没写进磁盘：' + wrote.error })
            return sendJson(res, 200, { ok: true, id, file: wrote.file, presets: allPresets(list).map((p) => ({ id: p.id, name: p.name, desc: p.desc, custom: !!p.custom })) })
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
// 只给诊断脚本用（tools/dsh-home-probe.mjs）：宿主不读这些导出，但排查
// 「预设存不上」时必须能直接问到真实进程里的解析结果。
export { storageInfo, homeDiagnostics, dshHome }
// 只给测试用：parameters 的上游契约检查（注册时的守卫用的就是它）
export { toolParametersProblem }
export default { name, inject, Config, apply }
