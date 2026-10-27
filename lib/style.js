// dsh-writing-style —— 纯逻辑层
//
// 这里不碰任何宿主 API：风格文档的规范化、预设解析、维度 → 提示词文本的渲染。
// 好处是这一层可以被 node 直接跑测试，也可以在客户端复用同一份定义（维度名/预设名）。
//
// 设计要点（为什么是「维度 + 预设 + 自由指令 + 范文」四件套）：
//   · 预设      —— 一键切换的成套风格，解决「我想要冷硬派但说不清」的问题
//   · 维度      —— 13 个可量化旋钮，解决「预设差一点点」的问题
//   · 自由指令  —— 兜住所有维度表达不了的东西
//   · 范文      —— few-shot，比任何形容词都准；风格模仿最有效的手段

// ---------------------------------------------------------------- 常量

/** 会话日志里的事件类型（必须带 plugin: 前缀，否则宿主冷读会整份拒绝日志）。 */
export const DOC_EVENT = 'plugin:writing-style/state'
/** 会话投影的 key（客户端按它渲染）。 */
export const DOC_KEY = 'writingStyle'
/** 信封结构版本。 */
export const STATE_VERSION = 1
export const ENVELOPE_VERSION = 1

/** 投影 / 面板展示用的版本号。 */
export const VIEW_VERSION = 1

// ---------------------------------------------------------------- 维度定义

/**
 * 枚举型维度的取值 → 提示词文本。
 * 写成「硬规则」而不是「倾向」：模型对祈使句的执行率远高于形容词。
 */
const ENUM_TEXT = {
  pov: {
    first: '第一人称「我」。所有叙述都是叙述者亲历、亲感、亲想；不得写叙述者无从知道的他人内心。',
    second: '第二人称「你」。把读者放在主角位置上，用「你」推进动作与感受。',
    'third-limited': '第三人称限知。镜头贴住一个视点人物，只写他能看到、听到、猜到的东西；他不在场的信息一律不写。',
    'third-omniscient': '第三人称全知。可以进入任何角色的内心，也可以交代他们不知道的背景与往事。',
    objective: '客观镜头（摄像机式）。只写摄影机能看到、麦克风能录到的：动作、表情、对白、环境。不进入任何人的内心，不解释动机。',
  },
  tense: {
    past: '过去时叙述。事件已经发生（「他推开门」），语气是回望。',
    present: '现在时叙述。事件正在发生（「他推开门」），读者与人物同时在场。',
  },
}

/**
 * 量表型维度：分档描述。每档 [下界, 上界, 文本)，最后一档包含 100。
 * 刻意用分档而不是插值 —— 提示词要的是明确指令，不是「大约 63.5%」。
 */
const BANDS = {
  sentence: [
    [0, 25, '极短句。以十字以内的句子为主，多用句号切断，几乎不用从句与修饰。节奏像敲钉子。'],
    [25, 45, '短句为主。句子多在十五字内，偶尔用一个长句收束一整段。'],
    [45, 65, '长短交替。短句推进动作，长句铺陈情绪与景物，读起来有呼吸感。'],
    [65, 85, '长句绵延。多用复句、从句、插入语，一句可以铺满三到五行。'],
    [85, 101, '极长句。意识流式绵延，逗号分号串联，允许一句成段，很少落句号。'],
  ],
  density: [
    [0, 25, '极简白描。只写推动情节的动作与对白，环境一笔带过。'],
    [25, 45, '克制。关键处才给一两笔景物，不铺排。'],
    [45, 65, '均衡。场景、动作、情绪各占一份，不偏废。'],
    [65, 85, '稠密。每个场景都铺开五感与细节，允许停顿。'],
    [85, 101, '极稠密。近乎静态的画面堆叠，情节让位于氛围。'],
  ],
  dialogue: [
    [0, 25, '几乎无对白。以叙述推进，人物话语用转述。'],
    [25, 45, '少量对白。只在关键冲突处让人物开口。'],
    [45, 65, '对白与叙述各半。对话推动情节，叙述补足动作与反应。'],
    [65, 85, '对白为主。大量直接引语，叙述只做必要的动作提示。'],
    [85, 101, '近乎纯对白。像剧本，只保留说话人与极简动作。'],
  ],
  interior: [
    [0, 25, '不写内心。只呈现外在行为，让读者自己判断。'],
    [25, 45, '极少。偶尔一句内心独白点破。'],
    [45, 65, '适度。关键节点进入人物思绪，其余靠动作带。'],
    [65, 85, '大量。频繁进入内心，情绪与念头构成主要篇幅。'],
    [85, 101, '内心为主。外在事件只是触发思绪的引子。'],
  ],
  sensory: [
    [0, 25, '几乎不写感官。只有必要的信息。'],
    [25, 45, '偶尔一笔。气味、温度、触感点到即止。'],
    [45, 65, '常规。每场戏给两三种感官锚点。'],
    [65, 85, '丰富。五感并用，气味与触觉尤其具体。'],
    [85, 101, '感官轰炸。以身体感受组织叙事，视觉退居其次。'],
  ],
  pace: [
    [0, 25, '极慢。一个动作可以写一整段，大量停顿与回望。'],
    [25, 45, '偏慢。重场景、重氛围，情节推进缓慢。'],
    [45, 65, '中速。场景与推进交替，张弛有度。'],
    [65, 85, '偏快。多事件并行，场景切换干脆。'],
    [85, 101, '极快。蒙太奇式跳切，一句话一个事件。'],
  ],
  vocabulary: [
    [0, 25, '极平实。口语词、常用字，不用成语与生僻词。'],
    [25, 45, '朴素。偶有书面词，整体接近日常语言。'],
    [45, 65, '中性。书面语与口语混用，用词准确为先。'],
    [65, 85, '讲究。多用四字词与意象词，句子有文气。'],
    [85, 101, '华丽。辞藻密集，古语、典故、通感随手取用。'],
  ],
  paragraph: [
    [0, 25, '一行一段。大量单句成段，留白多。'],
    [25, 45, '短段。每段两三句。'],
    [45, 65, '常规。每段三到六句。'],
    [65, 85, '长段。整场戏一段到底。'],
    [85, 101, '大段。成页的连续段落，靠标点分节。'],
  ],
  rhetoric: [
    [0, 25, '零修辞。不用比喻、排比、拟人。'],
    [25, 45, '少修辞。偶尔一个明喻。'],
    [45, 65, '适度。比喻与通感在关键处出现。'],
    [65, 85, '多修辞。比喻、排比、象征交织。'],
    [85, 101, '修辞为主。语言本身即目的，意象层层嵌套。'],
  ],
  explicitness: [
    [0, 25, '全隐。亲密场景淡出处理，只写前后。'],
    [25, 45, '克制。以暗示与省略代替直写。'],
    [45, 65, '直接但不铺陈。写清发生了什么，不刻意渲染。'],
    [65, 85, '明确描写。动作、感受、生理反应都写。'],
    [85, 101, '完全展开。不省略、不借代，按需写到最细。'],
  ],
  humor: [
    [0, 25, '无。严肃到底。'],
    [25, 45, '偶尔。冷幽默点缀。'],
    [45, 65, '适度。对白里有调侃。'],
    [65, 85, '明显。叙述者自带吐槽。'],
    [85, 101, '喜剧化。荒诞与反差是主要手法。'],
  ],
}

/** 维度表：顺序即面板里的展示顺序。 */
export const DIMENSIONS = [
  { k: 'pov', l: '叙事视角', kind: 'enum', def: 'third-limited', options: [['first', '第一人称'], ['second', '第二人称'], ['third-limited', '三人称限知'], ['third-omniscient', '三人称全知'], ['objective', '客观镜头']] },
  { k: 'tense', l: '叙述时态', kind: 'enum', def: 'past', options: [['past', '过去时'], ['present', '现在时']] },
  { k: 'sentence', l: '句式长度', kind: 'scale', def: 45, lo: '短促', hi: '绵长' },
  { k: 'density', l: '描写密度', kind: 'scale', def: 50, lo: '白描', hi: '稠密' },
  { k: 'dialogue', l: '对话占比', kind: 'scale', def: 40, lo: '叙述', hi: '对白' },
  { k: 'interior', l: '心理描写', kind: 'scale', def: 45, lo: '外在', hi: '内心' },
  { k: 'sensory', l: '感官细节', kind: 'scale', def: 50, lo: '信息', hi: '五感' },
  { k: 'pace', l: '叙事节奏', kind: 'scale', def: 50, lo: '舒缓', hi: '紧凑' },
  { k: 'vocabulary', l: '词汇色彩', kind: 'scale', def: 50, lo: '平实', hi: '华丽' },
  { k: 'paragraph', l: '段落长度', kind: 'scale', def: 50, lo: '短段', hi: '长段' },
  { k: 'rhetoric', l: '修辞密度', kind: 'scale', def: 40, lo: '直陈', hi: '繁复' },
  { k: 'explicitness', l: '露骨程度', kind: 'scale', def: 50, lo: '含蓄', hi: '直露' },
  { k: 'humor', l: '幽默感', kind: 'scale', def: 30, lo: '严肃', hi: '诙谐' },
]

export const DIM_KEYS = DIMENSIONS.map((d) => d.k)

const DIM_BY_KEY = new Map(DIMENSIONS.map((d) => [d.k, d]))

/** 中文名 → key，方便模型/用户用中文名操作。 */
const DIM_ALIAS = new Map()
for (const d of DIMENSIONS) {
  DIM_ALIAS.set(d.k, d.k)
  DIM_ALIAS.set(d.l, d.k)
  DIM_ALIAS.set(d.l.toLowerCase(), d.k)
}
DIM_ALIAS.set('视角', 'pov')
DIM_ALIAS.set('人称', 'pov')
DIM_ALIAS.set('时态', 'tense')
DIM_ALIAS.set('句式', 'sentence')
DIM_ALIAS.set('描写', 'density')
DIM_ALIAS.set('对话', 'dialogue')
DIM_ALIAS.set('心理', 'interior')
DIM_ALIAS.set('感官', 'sensory')
DIM_ALIAS.set('节奏', 'pace')
DIM_ALIAS.set('词汇', 'vocabulary')
DIM_ALIAS.set('段落', 'paragraph')
DIM_ALIAS.set('修辞', 'rhetoric')
DIM_ALIAS.set('露骨', 'explicitness')
DIM_ALIAS.set('尺度', 'explicitness')
DIM_ALIAS.set('幽默', 'humor')

// ---------------------------------------------------------------- 内置预设

/**
 * 预设只写「与默认值不同」的维度；解析时用维度默认值补全，
 * 这样以后给 DIMENSIONS 加旋钮不会让老预设失效。
 */
export const PRESETS = [
  {
    id: 'balanced',
    name: '均衡',
    desc: '不加修饰的中性笔调，什么都能写。',
    dims: {},
    directives: '',
    avoid: [],
  },
  {
    id: 'hardboiled',
    name: '冷硬派',
    desc: '短句、客观、少解释，像一份口供。',
    dims: { pov: 'first', sentence: 20, density: 30, dialogue: 55, interior: 25, sensory: 55, pace: 55, vocabulary: 25, paragraph: 30, rhetoric: 15, humor: 25 },
    directives: '像在录口供：只说做了什么、看到了什么，不解释为什么。酒、烟、雨、霓虹可以出现，但每次只点一笔，不抒情。',
    avoid: ['仿佛', '不禁', '一丝', '五味杂陈'],
  },
  {
    id: 'classical',
    name: '古典雅致',
    desc: '长句、对仗、留白，文气重。',
    dims: { pov: 'third-omniscient', sentence: 78, density: 72, dialogue: 35, interior: 60, sensory: 60, pace: 30, vocabulary: 82, paragraph: 65, rhetoric: 70, humor: 15 },
    directives: '在文言与白话之间取一个雅正的位置。不用网络语，不靠感叹号堆情绪，句子讲究对仗与留白。',
    avoid: ['超级', '真的', '巨', '贼'],
  },
  {
    id: 'webnovel',
    name: '网文爽感',
    desc: '短段、快节奏、每段都有推进，章末留钩子。',
    dims: { pov: 'third-limited', sentence: 30, density: 40, dialogue: 60, interior: 55, sensory: 35, pace: 82, vocabulary: 35, paragraph: 22, rhetoric: 25, humor: 45 },
    directives: '每一段都要有信息量或情绪推进，禁止原地打转。章末留钩子。金手指与爽点要落在具体动作上，不要空喊。',
    avoid: ['与此同时', '总而言之'],
  },
  {
    id: 'literary',
    name: '文学意识流',
    desc: '长句、内心、时间折叠，允许句子不完整。',
    dims: { pov: 'first', sentence: 88, density: 80, dialogue: 20, interior: 88, sensory: 78, pace: 22, vocabulary: 70, paragraph: 70, rhetoric: 75, humor: 20 },
    directives: '时间不按顺序走，记忆与当下互相渗透。允许句子不完整、允许自我打断。抽象情绪要落在具体物象上。',
    avoid: ['总而言之', '简单来说'],
  },
  {
    id: 'screenplay',
    name: '剧本体',
    desc: '场景标题 + 动作行 + 对白，零心理描写。',
    dims: { pov: 'objective', sentence: 35, density: 25, dialogue: 88, interior: 0, sensory: 30, pace: 60, vocabulary: 25, paragraph: 20, rhetoric: 0, humor: 30 },
    directives: '用剧本格式：先一行场景标题（内/外 · 地点 · 日/夜），再写动作行，再写「角色名：对白」。动作行只写可拍摄的东西。不写「他心想」「他感到」。',
    avoid: ['心想', '感到', '意识到'],
  },
  {
    id: 'lightnovel',
    name: '轻小说',
    desc: '第一人称、话多、会吐槽、括号补刀。',
    dims: { pov: 'first', sentence: 28, density: 40, dialogue: 70, interior: 75, sensory: 40, pace: 70, vocabulary: 35, paragraph: 25, rhetoric: 30, humor: 78 },
    directives: '叙述者是个话多的年轻人：会打断自己、会吐槽、会用括号补一句心里话。严肃场面也要留一丝自嘲。',
    avoid: ['不禁', '嘴角勾起'],
  },
  {
    id: 'clinical',
    name: '临床白描',
    desc: '像病例报告：只记录可观察的事实。',
    dims: { pov: 'objective', sentence: 40, density: 20, dialogue: 30, interior: 0, sensory: 40, pace: 45, vocabulary: 15, paragraph: 35, rhetoric: 0, humor: 5 },
    directives: '像病例报告：只记录可观察的行为、时间、地点、数量。不评价，不抒情，不比喻。冷到近乎无情。',
    avoid: ['仿佛', '似乎', '好像'],
  },
  {
    id: 'gothic',
    name: '哥特阴郁',
    desc: '潮湿、腐朽、阴影，美与恐怖同源。',
    dims: { pov: 'third-limited', sentence: 72, density: 78, dialogue: 30, interior: 70, sensory: 75, pace: 28, vocabulary: 78, paragraph: 60, rhetoric: 72, humor: 5 },
    directives: '潮湿、腐朽、阴影、钟声。美与恐怖同源。形容词要冷，光线要坏掉，建筑要有记忆。',
    avoid: ['阳光明媚', '心情很好'],
  },
]

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]))

/** 默认禁用词：中文小说里最泛滥的 AI 套话。用户可整组替换。 */
export const DEFAULT_AVOID = [
  '不禁', '仿佛', '一丝', '嘴角勾起', '眸色一暗',
  '空气仿佛凝固', '心中五味杂陈', '不禁莞尔', '眼底闪过一丝',
]

// ---------------------------------------------------------------- 工具函数

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)

function asNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 把维度名（key / 中文名 / 别名）解析成 key。 */
export function resolveDim(name) {
  if (name === undefined || name === null) return null
  const s = String(name).trim()
  if (!s) return null
  return DIM_ALIAS.get(s) || DIM_ALIAS.get(s.toLowerCase()) || null
}

/** 取某个维度的合法值：枚举型校验取值，量表型钳到 0-100。 */
export function coerceDim(key, value) {
  const dim = DIM_BY_KEY.get(key)
  if (!dim) return { ok: false, value: undefined }
  if (dim.kind === 'enum') {
    const allowed = dim.options.map(([v]) => v)
    const s = String(value).trim()
    const hit = allowed.find((v) => v === s)
      || allowed.find((v) => v.toLowerCase() === s.toLowerCase())
    if (hit) return { ok: true, value: hit }
    // 也接受中文名（「第一人称」→ first）
    const byLabel = dim.options.find(([, label]) => label === s)
    if (byLabel) return { ok: true, value: byLabel[0] }
    return { ok: false, value: undefined }
  }
  const n = Number(value)
  if (!Number.isFinite(n)) return { ok: false, value: undefined }
  return { ok: true, value: clamp(Math.round(n), 0, 100) }
}

/** 量表维度的分档文本。 */
export function bandText(key, value) {
  const bands = BANDS[key]
  if (!bands) return ''
  const n = clamp(asNum(value, 50), 0, 100)
  for (const [lo, hi, text] of bands) if (n >= lo && n < hi) return text
  return bands[bands.length - 1][2]
}

/** 预设 → 完整 dims（用维度默认值补全）。 */
export function presetDims(presetId) {
  const base = {}
  for (const d of DIMENSIONS) base[d.k] = d.def
  const p = PRESET_BY_ID.get(presetId)
  if (!p) return base
  for (const [k, v] of Object.entries(p.dims || {})) {
    if (DIM_BY_KEY.has(k)) base[k] = v
  }
  return base
}

// ---------------------------------------------------------------- 文档

/** 默认文档：不启用（避免污染日常编码对话），启用后是「均衡」。 */
export function defaultDoc() {
  return {
    v: VIEW_VERSION,
    enabled: false,
    preset: 'balanced',
    presetName: '均衡',
    dims: presetDims('balanced'),
    directives: '',
    sample: '',
    avoid: DEFAULT_AVOID.slice(),
    prefer: [],
    rules: [],
    updatedAt: null,
  }
}

/** 结构校验：返回 null 表示合法。 */
export function checkDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'doc must be an object'
  if (doc.dims !== undefined && (typeof doc.dims !== 'object' || doc.dims === null)) return 'doc.dims must be an object'
  if (doc.rules !== undefined && !Array.isArray(doc.rules)) return 'doc.rules must be an array'
  if (doc.avoid !== undefined && !Array.isArray(doc.avoid)) return 'doc.avoid must be an array'
  if (doc.prefer !== undefined && !Array.isArray(doc.prefer)) return 'doc.prefer must be an array'
  return null
}

/**
 * 规范化：任何缺失/脏字段都补成合法值。
 * 这一层必须「永不抛错」—— 它同时服务于读路径和写路径。
 */
export function normalizeDoc(raw) {
  const d = defaultDoc()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d
  d.enabled = raw.enabled === true
  const pid = typeof raw.preset === 'string' && raw.preset ? raw.preset : 'balanced'
  d.preset = pid
  d.presetName = typeof raw.presetName === 'string' && raw.presetName ? raw.presetName : (PRESET_BY_ID.get(pid)?.name || pid)
  const src = raw.dims && typeof raw.dims === 'object' && !Array.isArray(raw.dims) ? raw.dims : {}
  const dims = presetDims(pid)
  for (const dim of DIMENSIONS) {
    if (!Object.hasOwn(src, dim.k)) continue
    const c = coerceDim(dim.k, src[dim.k])
    if (c.ok) dims[dim.k] = c.value
  }
  d.dims = dims
  d.directives = typeof raw.directives === 'string' ? raw.directives : ''
  d.sample = typeof raw.sample === 'string' ? raw.sample : ''
  d.avoid = Array.isArray(raw.avoid) ? raw.avoid.map(String).filter(Boolean).slice(0, 200) : DEFAULT_AVOID.slice()
  d.prefer = Array.isArray(raw.prefer) ? raw.prefer.map(String).filter(Boolean).slice(0, 200) : []
  d.rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r) => r && typeof r === 'object').map((r, i) => ({
        id: typeof r.id === 'string' && r.id ? r.id : `r${i + 1}`,
        name: typeof r.name === 'string' ? r.name : '',
        keys: Array.isArray(r.keys) ? r.keys.map(String).filter(Boolean).slice(0, 40) : [],
        text: typeof r.text === 'string' ? r.text : '',
        enabled: r.enabled !== false,
      })).slice(0, 100)
    : []
  d.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  return d
}

export function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(normalizeDoc(doc)))
}

// ---------------------------------------------------------------- 渲染

/**
 * 把文档渲染成「写作风格硬规范」正文。
 *
 * 为什么这么长：模型对「祈使句 + 具体数字 + 正反例」的执行率最高，
 * 对「请写得优美一些」这类形容词几乎无感。宁可多两百字，也要把要求说死。
 *
 * @returns {string} 空字符串表示「本轮不注入」（未启用 / 没有内容）
 */
export function renderDirective(doc, opts = {}) {
  const d = normalizeDoc(doc)
  if (!d.enabled) return ''
  const parts = []

  parts.push('【写作风格 · 硬性规范】')
  parts.push('下面这份规范**优先于你的默认写作习惯**。除非用户在本轮明确要求换风格，否则整段回复都必须遵守它；')
  parts.push('它与「简洁/高效」之类的通用偏好冲突时，以本规范为准。')
  parts.push('')

  // 一、视角与时态
  const povText = ENUM_TEXT.pov[d.dims.pov] || ENUM_TEXT.pov['third-limited']
  const tenseText = ENUM_TEXT.tense[d.dims.tense] || ENUM_TEXT.tense.past
  parts.push('**一、视角与时态**')
  parts.push('- ' + povText)
  parts.push('- ' + tenseText)
  parts.push('')

  // 二、句式与段落
  parts.push('**二、句式与段落**')
  parts.push('- ' + bandText('sentence', d.dims.sentence))
  parts.push('- ' + bandText('paragraph', d.dims.paragraph))
  parts.push('')

  // 三、配比
  parts.push('**三、内容配比**')
  parts.push('- 对话：' + bandText('dialogue', d.dims.dialogue))
  parts.push('- 心理：' + bandText('interior', d.dims.interior))
  parts.push('- 描写：' + bandText('density', d.dims.density))
  parts.push('- 感官：' + bandText('sensory', d.dims.sensory))
  parts.push('')

  // 四、语言质感
  parts.push('**四、语言质感**')
  parts.push('- 词汇：' + bandText('vocabulary', d.dims.vocabulary))
  parts.push('- 修辞：' + bandText('rhetoric', d.dims.rhetoric))
  parts.push('- 幽默：' + bandText('humor', d.dims.humor))
  parts.push('- 尺度：' + bandText('explicitness', d.dims.explicitness))
  parts.push('')

  // 五、节奏
  parts.push('**五、节奏**')
  parts.push('- ' + bandText('pace', d.dims.pace))
  parts.push('')

  // 六、词汇禁区
  const avoid = (d.avoid || []).filter(Boolean)
  const prefer = (d.prefer || []).filter(Boolean)
  if (avoid.length || prefer.length) {
    parts.push('**六、用词纪律**')
    if (avoid.length) {
      parts.push('- **禁止出现**这些词与它们的近义套话：' + avoid.map((w) => `「${w}」`).join('、') + '。')
      parts.push('  （写到这里卡住时，换一个具体动作或具体物象，不要换一个同义套话。）')
    }
    if (prefer.length) parts.push('- 优先使用这类词与意象：' + prefer.map((w) => `「${w}」`).join('、') + '。')
    parts.push('')
  }

  // 七、自由指令
  const extra = String(d.directives || '').trim()
  if (extra) {
    parts.push('**七、附加要求**')
    parts.push(extra)
    parts.push('')
  }

  // 八、范文
  const sample = String(d.sample || '').trim()
  if (sample) {
    parts.push('**八、语感范例（照这个语感写，不要照抄内容）**')
    parts.push('```')
    parts.push(sample.slice(0, 4000))
    parts.push('```')
    parts.push('')
  }

  // 自检
  parts.push('**落笔前自检**：视角有没有漂？句子长度对不对？禁用词有没有漏进去？如果某一项做不到，宁可重写这一段。')
  return parts.join('\n')
}

/**
 * 触发性规则（酒馆的「世界书」那一套）：只有命中了才注入。
 * @param {object} doc
 * @param {string[]} haystack 最近若干条消息的纯文本
 */
export function renderRules(doc, haystack) {
  const d = normalizeDoc(doc)
  if (!d.enabled) return ''
  const rules = (d.rules || []).filter((r) => r.enabled && String(r.text || '').trim())
  if (!rules.length) return ''
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack || '')
  const hit = []
  for (const r of rules) {
    if (!r.keys.length) { hit.push(r); continue }
    if (r.keys.some((k) => k && text.includes(k))) hit.push(r)
  }
  if (!hit.length) return ''
  return ['【写作风格 · 本次生效的附加条目】']
    .concat(hit.map((r) => `- ${r.name ? r.name + '：' : ''}${r.text}`))
    .join('\n')
}

/** 一行摘要（面板与工具返回值共用）。 */
export function renderSummary(doc) {
  const d = normalizeDoc(doc)
  if (!d.enabled) return '写作风格：未启用'
  const dim = DIM_BY_KEY.get('pov')
  const povLabel = (dim.options.find(([v]) => v === d.dims.pov) || [null, d.dims.pov])[1]
  const bits = [
    `${d.presetName || d.preset}`,
    povLabel,
    `句式${d.dims.sentence}`,
    `描写${d.dims.density}`,
    `对话${d.dims.dialogue}`,
    `节奏${d.dims.pace}`,
  ]
  return '写作风格：' + bits.join(' · ')
}

/** 面板用的扁平值表。 */
export function flatDims(doc) {
  const d = normalizeDoc(doc)
  const out = {}
  for (const dim of DIMENSIONS) out[dim.k] = d.dims[dim.k]
  return out
}

/** 把预设套到文档上（保留开关、禁用词之外的自定义项）。 */
export function applyPreset(doc, presetId) {
  const d = normalizeDoc(doc)
  const p = PRESET_BY_ID.get(presetId)
  d.preset = p ? p.id : 'balanced'
  d.presetName = p ? p.name : '均衡'
  d.dims = presetDims(d.preset)
  d.directives = p ? (p.directives || '') : ''
  if (p && Array.isArray(p.avoid) && p.avoid.length) d.avoid = p.avoid.slice()
  d.updatedAt = new Date().toISOString()
  return d
}

/**
 * 从文档派生一个可保存的自定义预设。
 * @param {object} doc
 * @param {string} id
 * @param {string} name
 */
export function toPreset(doc, id, name) {
  const d = normalizeDoc(doc)
  const dims = {}
  const base = presetDims('balanced')
  for (const dim of DIMENSIONS) {
    if (d.dims[dim.k] !== base[dim.k]) dims[dim.k] = d.dims[dim.k]
  }
  return {
    id: String(id),
    name: String(name || id),
    desc: '自定义',
    dims,
    directives: d.directives || '',
    avoid: (d.avoid || []).slice(),
    // ⚠️ 范文必须一起存：它是整套风格里最有效的一项（few-shot），
    // 漏掉它会让「存下来的预设」和「存之前的效果」明显不一样。
    sample: d.sample || '',
    custom: true,
  }
}

/** 合并内置预设与用户预设（用户同名 id 覆盖内置）。 */
export function allPresets(userPresets) {
  const out = PRESETS.slice()
  const seen = new Set(out.map((p) => p.id))
  for (const p of Array.isArray(userPresets) ? userPresets : []) {
    if (!p || typeof p !== 'object' || !p.id) continue
    const norm = {
      id: String(p.id),
      name: String(p.name || p.id),
      desc: String(p.desc || '自定义'),
      dims: p.dims && typeof p.dims === 'object' ? p.dims : {},
      directives: typeof p.directives === 'string' ? p.directives : '',
      avoid: Array.isArray(p.avoid) ? p.avoid.map(String) : [],
      sample: typeof p.sample === 'string' ? p.sample : '',
      custom: true,
    }
    if (seen.has(norm.id)) {
      const i = out.findIndex((x) => x.id === norm.id)
      out[i] = norm
    } else {
      out.push(norm)
      seen.add(norm.id)
    }
  }
  return out
}
