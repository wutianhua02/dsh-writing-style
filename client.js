window.__ModuleLoader__.load({
  id: "dsh-writing-style",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// dsh-writing-style —— 客户端源码（构建产物：../client.js）
//
// 两个席位：
//   settings.section —— 完整面板。**2026-11-01 用户要求改版**：
//     维度 / 禁用词 / 偏好词 / 附加要求 / 范文全部收进预设里，外部不再出现
//     会话级的直接编辑入口。页签只剩「预设 / 条目 / 预览」；
//     每张预设卡 = 点卡片套用 + 「更改」按钮进入该预设的完整编辑器
//     （编辑器是隐藏视图，只能从卡片或「新建预设」进入，不在页签栏里）。
//   conversation.composer.dock —— 输入框下方那一行小徽标里的「文风」开关。
//      之前按用户要求整块底栏去掉了（当时要的是「别占垂直空间」）。留到输入框
//      附近的只剩这一颗按钮：风格文档是**按会话**存的，而默认值是「未启用」，
//      所以每个新对话都得先进设置页翻出来才能打开 —— 用户把这体验成「插件没用」。
//      徽标席位宿主本来就是 session 作用域，所以这颗按钮的作用范围天然就是
//      「当前这个对话」，不需要自己再去猜会话，也不会串到别的对话上去。
//      这里只放开关，不放滑块 —— 调风格以预设为单位，在设置页改预设。
//
// 数据：投影 `writingStyle`（宿主推送）；写操作走 /dsh-writing-style/*。

const NS = 'dsh-writing-style'
const ROUTE = '/dsh-writing-style'

const name = 'dsh-writing-style'
const inject = ['slots', 'locale', 'connection']

const ZH = {
  section: '写作风格',
  title: '写作风格',
  hint: '风格内容全部收在预设里：点预设卡就套用到当前对话（下一轮生效）；点卡片上的「更改」编辑这套预设本身（维度、禁用词、偏好词、附加要求、范文都在里面）。',
  off: '未启用',
  on: '已启用',
  enable: '启用风格',
  disable: '关闭风格',
  presets: '预设',
  editor: '编辑预设',
  editPreset: '更改',
  newPreset: '新建预设',
  backToList: '← 返回预设列表',
  edEditing: '正在编辑',
  edId: '预设 id（英文，如 my-noir）',
  edName: '显示名（如 我的冷硬派）',
  edDesc: '一句话描述（可选）',
  edDims: '这套预设的维度',
  edDimsHint: '只有和「均衡」不同的维度才会被存下来，其余留空即用默认。',
  storedAt: '预设文件',
  storedHomeMissing: '没解析出 DSH 目录，预设存不到磁盘（重启桌面端通常能恢复）。',
  writeFailed: '写入失败：',
  edSave: '保存这套预设',
  edSaveApply: '保存并应用到当前对话',
  edNote: '预设是全局的：改完对所有会话都能套用。内置预设不能直接改——保存会生成一份同 id 的自定义覆盖（带 ★）；删除覆盖即恢复原版。',
  tabError: '这个页签渲染出错（其他页签仍可用）',
  edDirectivesHint: '这套预设的自由指令（可选）：写得越具体，模型越听话。',
  rules: '条目',
  preview: '预览',
  apply: '套用到当前对话',
  del: '删除',
  confirmDeletePreset: '删除这套预设？自定义预设会被整个删掉；内置预设会恢复原版。',
  avoidLabel: '禁用词（逗号或换行分隔）',
  preferLabel: '偏好词（可选）',
  directivesLabel: '附加要求（自由指令，优先级最高）',
  sampleLabel: '语感范文（few-shot：照语感，不照抄内容）',
  previewLabel: '下面这段就是本轮会注入给模型的规范正文',
  rulesEmpty: '还没有触发性条目。条目只在最近几条消息命中关键词时才追加注入。',
  ruleAdd: '新增条目',
  ruleName: '条目名，如「战斗场面」',
  ruleKeys: '触发词，逗号分隔（留空 = 每轮都注入）',
  ruleText: '命中后追加的规则正文',
  undo: '撤销上一步',
  refresh: '刷新',
  reset: '恢复默认',
  noSession: '还没有会话：先开一轮对话。',
  loading: '正在连接宿主…（没反应就点上面的「刷新」）',
  retrying: '连接失败，正在自动重试…',
  copy: '复制全文',
  copied: '已复制',
  dirEmpty: '风格未启用，本轮不注入任何写作规范。',
  presetSaved: '已保存',
  edPreview: '预览注入效果',
  edPreviewHint: '这是这份草稿「套用时」会注入的正文 —— 只是预览，不会改当前会话。',
  savedNoApply: '预设已存盘，但当前对话用的还是上次套用那一刻的快照：点「保存并应用到当前对话」或直接点卡片，注入段和预览页签才会跟着变。',
  confirmReset: '把当前会话的风格恢复成默认（关闭）？',
  chipOn: '文风·开',
  chipOff: '文风·关',
  chipHintOn: '写作风格正在作用于当前对话，点这里关闭',
  chipHintOff: '写作风格未启用，点这里对当前对话开启',
  chipFailed: '文风开关没写成：',
  chipRetry: '文风·重试',
  chipPending: '文风···',
}

const EN = {
  section: 'Writing style',
  title: 'Writing style',
  hint: 'Everything lives inside presets: click a preset card to apply it to this conversation (next reply), or click Edit on the card to change that preset itself (dimensions, banned/preferred words, extra instructions, style sample).',
  off: 'Off',
  on: 'On',
  enable: 'Enable',
  disable: 'Disable',
  presets: 'Presets',
  editor: 'Edit preset',
  editPreset: 'Edit',
  newPreset: 'New preset',
  backToList: '← Back to presets',
  edEditing: 'Editing',
  edId: 'Preset id (ascii, e.g. my-noir)',
  edName: 'Display name',
  edDesc: 'One-line description (optional)',
  edDims: 'Dimensions for this preset',
  edDimsHint: 'Only dimensions that differ from Balanced are stored; the rest fall back to defaults.',
  storedAt: 'Preset file',
  storedHomeMissing: 'DSH home not resolved — presets cannot be written to disk (restarting the desktop app usually fixes it).',
  writeFailed: 'Write failed: ',
  edSave: 'Save this preset',
  edSaveApply: 'Save & apply here',
  edNote: 'Presets are global: changes become available to every conversation. Built-ins cannot be edited directly — saving creates an override with the same id (marked ★); delete the override to restore the original.',
  tabError: 'This tab failed to render (other tabs still work)',
  edDirectivesHint: 'Extra instructions for this preset (optional).',
  rules: 'Rules',
  preview: 'Preview',
  apply: 'Apply to this conversation',
  del: 'Delete',
  confirmDeletePreset: 'Delete this preset? Custom presets are removed entirely; built-ins revert to the original.',
  avoidLabel: 'Banned words (comma or newline separated)',
  preferLabel: 'Preferred words (optional)',
  directivesLabel: 'Extra instructions (highest priority)',
  sampleLabel: 'Style sample (few-shot: imitate the voice, not the content)',
  previewLabel: 'This is the directive injected for the next turn',
  rulesEmpty: 'No trigger rules yet. A rule is injected only when its keywords appear in recent messages.',
  ruleAdd: 'Add rule',
  ruleName: 'Rule name, e.g. "combat"',
  ruleKeys: 'Trigger words, comma separated (empty = always)',
  ruleText: 'Rule text injected on match',
  undo: 'Undo',
  refresh: 'Refresh',
  reset: 'Reset',
  noSession: 'No session yet: start a conversation first.',
  loading: 'Connecting to the host… (click Refresh above if it stays empty)',
  retrying: 'Request failed, retrying automatically…',
  copy: 'Copy',
  copied: 'Copied',
  dirEmpty: 'Style is off; nothing is injected this turn.',
  presetSaved: 'Saved',
  edPreview: 'Preview injected text',
  edPreviewHint: 'What this draft would inject when applied — preview only, this conversation is untouched.',
  savedNoApply: 'Preset saved, but this conversation still uses the snapshot taken when it was applied. Use "Save & apply here" (or click the card) to update the injected directive and the Preview tab.',
  confirmReset: 'Reset this session\'s style to default (off)?',
  chipOn: 'Style·On',
  chipOff: 'Style·Off',
  chipHintOn: 'Writing style is active for this conversation. Click to turn it off.',
  chipHintOff: 'Writing style is off. Click to turn it on for this conversation.',
  chipFailed: 'Style toggle failed: ',
  chipRetry: 'Style·Retry',
  chipPending: 'Style···',
}

const CSS = `
.wst-root{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
/* 输入框徽标位的那颗开关：跟宿主自己的 activity/usage 徽标同一行、同一量级，
   不画卡片背景（宿主那一行已经有容器），只留一个能点的圆角小条。 */
.wstc-dock{display:flex;justify-content:flex-end;width:100%}
.wstc{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:transparent;color:inherit;font-family:inherit;font-size:11px;line-height:1.4;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap;opacity:.75}
.wstc:hover{opacity:1;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.12))}
.wstc:disabled{opacity:.4;cursor:progress}
.wstc.on{opacity:1;border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.14)}
.wstc-dot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-fill-l3,rgba(128,128,128,.45))}
.wstc.on .wstc-dot{background:var(--dsw-alias-state-success-primary,#2ea36f);box-shadow:0 0 5px rgba(46,163,111,.6)}
.wstc.failed{opacity:1;border-color:var(--dsw-alias-state-error-primary,#d94b4b);background:rgba(217,75,75,.14);color:var(--dsw-alias-state-error-primary,#d94b4b)}
.wstc.failed .wstc-dot{background:var(--dsw-alias-state-error-primary,#d94b4b);box-shadow:0 0 5px rgba(217,75,75,.5)}
.wst-btn{border:0;background:transparent;color:inherit;cursor:pointer;border-radius:6px;padding:2px 6px;font-size:11px;font-family:inherit}
.wst-btn:hover{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.18))}
.wst-btn.on{background:var(--dsw-alias-fill-l3,rgba(128,128,128,.3))}
.wst-body{padding:2px 10px 10px;max-height:46vh;overflow:auto}
.wst-settings{display:flex;flex-direction:column;gap:12px;padding:4px 2px;max-width:820px}
.wst-sect{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px}
.wst-hint{opacity:.6;font-size:11.5px;line-height:1.55}
.wst-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wst-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px 18px}
.wst-field{display:flex;flex-direction:column;gap:3px}
.wst-field-head{display:flex;align-items:baseline;gap:6px;font-size:11.5px}
.wst-field-label{opacity:.78}
.wst-field-val{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;font-size:11px;opacity:.85}
.wst-range{width:100%;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);height:14px}
.wst-range-ends{display:flex;justify-content:space-between;font-size:10px;opacity:.45}
.wst-select{background:var(--dsw-alias-fill-l1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:6px;color:inherit;font-size:11.5px;padding:3px 6px;font-family:inherit}
.wst-input,.wst-textarea{background:var(--dsw-alias-fill-l1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:6px;color:inherit;font-size:11.5px;padding:4px 7px;font-family:inherit;box-sizing:border-box}
.wst-input:focus,.wst-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe)}
.wst-textarea{width:100%;min-height:64px;resize:vertical;line-height:1.55}
.wst-presets{display:flex;flex-wrap:wrap;gap:6px}
/* 卡片 2026-11-01 改版：外层是 div，左边整块「点=套用」（main 按钮），右边一小条「更改」（edit 按钮）。
   不能 button 套 button（非法 HTML，宿主渲染会拆结构），所以外层用 div。 */
.wst-preset{display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08));max-width:260px;overflow:hidden}
.wst-preset:hover{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.18))}
.wst-preset.active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.14)}
.wst-preset-main{flex:1;display:block;border:0;background:transparent;color:inherit;font-family:inherit;text-align:left;padding:5px 9px;cursor:pointer;font-size:11.5px;min-width:0}
.wst-preset-edit{border:0;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));background:transparent;color:inherit;font-family:inherit;font-size:11px;padding:0 9px;cursor:pointer;opacity:.65;white-space:nowrap}
.wst-preset-edit:hover{opacity:1;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.18))}
.wst-preset-name{font-weight:600;display:block}
.wst-preset-desc{opacity:.6;font-size:10.5px;display:block;margin-top:1px}
.wst-preview{white-space:pre-wrap;font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10.5px;line-height:1.6;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08));border-radius:8px;padding:9px 11px;max-height:280px;overflow:auto;opacity:.9}
.wst-rule{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08))}
.wst-rule-head{display:flex;align-items:center;gap:8px}
.wst-rule-name{font-weight:600;font-size:11.5px}
.wst-rule-keys{opacity:.55;font-size:10.5px}
.wst-rule-text{font-size:11px;opacity:.8;white-space:pre-wrap}
.wst-err{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:11.5px}
.wst-ok{color:var(--dsw-alias-state-success-primary,#2ea36f);font-size:11.5px}
.wst-empty{opacity:.6;padding:6px 0}
.wst-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));padding-bottom:6px}
.wst-tab{border:0;background:transparent;color:inherit;cursor:pointer;font-family:inherit;font-size:12px;padding:3px 9px;border-radius:6px;opacity:.6}
.wst-tab.active{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.2));opacity:1;font-weight:600}
`

function injectCss() {
  if (typeof document === 'undefined') return
  const id = 'dsh-writing-style/css'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-writing-style'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

let sessionId = ''

function currentSessionId() {
  if (sessionId) return sessionId
  try {
    const m = /[?&]session(?:Id)?=([^&]+)/.exec(location.search + location.hash)
    if (m) return decodeURIComponent(m[1])
  } catch { /* ignore */ }
  try {
    const v = localStorage.getItem('dsh-writing-style/session')
    if (v) return v
  } catch { /* ignore */ }
  return ''
}

// ---------------------------------------------------------------- 请求闸门
// 与 rpg-status 同一套教训：面板组件各自轮询会把宿主压死。
// 这里全进程同一时刻最多 1 个在途请求、超时、页面隐藏不轮询、失败指数退避。
//
// ⚠️ 2026-11-01 真机事故：超时原来是 **4s**，而页面刚加载时要同时跑 8MB 的插件包、
// 字体、React 首次渲染 —— 第一次 `/state` 很容易卡过 4s 被 abort。之后
// `health.nextAt` 进入退避，45s 轮询一次次撞在退避窗口上，「预设」页签就一直空白，
// 用户只能去点「刷新」（真机上就是这么恢复的）。所以：
//   ① 超时放宽到 8s；
//   ② 失败后**自己**短间隔重试，不等 45s；
//   ③ 显式刷新/重试可以绕过退避（`force`）；
//   ④ 上一次成功的数据缓存下来，失败时先显示旧的，绝不白屏。
const RPC_TIMEOUT_MS = 8000
const health = { failures: 0, nextAt: 0 }
// ⚠️ 2026-11-01 真机：徽标/设置页各自按「会话」读状态，而上一版只留了
// `inflight.current` 这**一个全局槽位**，于是两个 bug 同时发作：
//   · Bug1：点「套用」发 POST /preset，成功后同步 notify() 触发一次 GET /state，
//     那次 GET 撞上仍在途的 POST，`if (isGet) return inflight.current` 让它
//     **直接采纳了 POST 的响应**（{ok,doc,summary} 里根本没有 presets/dimsMeta），
//     于是预设页签的卡全没了；点刷新时没有 POST 在途，重新拉完整 /state 又都回来。
//   · Bug2：切到会话 B 时它的 GET /state?session=B 撞上会话 A 仍在途的那次 GET，
//     直接复用 A 的响应显示 —— 所有徽标看起来一起翻转（写其实是逐会话的）。
// 根因是同一个：在途复用既跨了 GET/POST，又跨了会话。所以按「操作+会话」分键，
// GET 只复用「同会话、同操作、且是 GET」的在途请求；POST 按会话串成链、绝不污染 GET。
const inflightGet = new Map() // key -> GET 的在途 promise（同键复用）
const writeTail = new Map()   // key -> 该会话上一个写操作，POST 串行其后（不并发写同一会话）

const backoffMs = () => Math.min(60000, 2000 * Math.pow(2, Math.max(0, health.failures - 1)))
const pageHidden = () => {
  try { return typeof document !== 'undefined' && document.visibilityState === 'hidden' } catch { return false }
}

// ---------------------------------------------------------------- 上一次成功的数据
// 存内存 + sessionStorage：内存那份管「同一次页面里重渲染」，sessionStorage 那份管
// 「刷新页面后第一帧」。两者都没有时才是真的空。
const STATE_CACHE_KEY = 'dsh-writing-style/state'
let lastGoodState = null

function readCachedState() {
  if (lastGoodState && typeof lastGoodState === 'object') return lastGoodState
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem(STATE_CACHE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null
  } catch { return null }
}

function writeCachedState(value) {
  if (!value || typeof value !== 'object') return
  lastGoodState = value
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STATE_CACHE_KEY, JSON.stringify(value))
  } catch { /* 隐私模式/配额满：内存那份还在，够用 */ }
}

const GET_OPS = new Set(['state', 'presets', 'rules'])

async function rpcRaw(op, payload, sidOverride) {
  const sid = sidOverride || currentSessionId()
  const url = `${ROUTE}/${op}${sid ? `?session=${encodeURIComponent(sid)}` : ''}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, RPC_TIMEOUT_MS)
  try {
    const base = op.split('?')[0]
    const init = GET_OPS.has(base)
      ? { method: 'GET', credentials: 'same-origin', signal: ctrl.signal }
      : {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
          signal: ctrl.signal,
        }
    const res = await fetch(url, init)
    let body = null
    try { body = await res.json() } catch { body = null }
    if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || `HTTP ${res.status}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

function rpc(op, payload, sidOverride, opts) {
  const force = !!(opts && opts.force)
  const base = op.split('?')[0]
  const isGet = GET_OPS.has(base)
  const sid = sidOverride || currentSessionId() || ''
  const key = base + '|' + sid

  if (isGet) {
    // 只复用「同操作 + 同会话」的在途 GET；绝不返回别的会话的、也绝不返回 POST 的响应。
    // force（手动刷新 / 徽标重读 / 失败重试）绕开缓存，也绕开退避窗口。
    const existing = inflightGet.get(key)
    if (existing && !force) return existing
    if (!force && Date.now() < health.nextAt) return Promise.reject(new Error('writing-style: 退避中'))
    const p = rpcRaw(op, payload, sidOverride)
      .then((body) => { health.failures = 0; health.nextAt = 0; return body })
      .catch((err) => { health.failures += 1; health.nextAt = Date.now() + backoffMs(); throw err })
    inflightGet.set(key, p)
    p.catch(() => {}).then(() => { if (inflightGet.get(key) === p) inflightGet.delete(key) })
    return p
  }

  // POST：排在「同一会话同一操作」上一次写之后串行执行，但绝不借用任何在途响应。
  // 用户点下去的那一下必须真的发出去（上一版不分青红皂白复用 GET，写操作被丢掉 = 按下没反应）。
  const prev = writeTail.get(key) || Promise.resolve()
  const run = prev.catch(() => {}).then(() => rpcRaw(op, payload, sidOverride))
    .then((body) => { health.failures = 0; health.nextAt = 0; notify(); return body })
    .catch((err) => { health.failures += 1; health.nextAt = Date.now() + backoffMs(); throw err })
  writeTail.set(key, run)
  run.catch(() => {}).then(() => { if (writeTail.get(key) === run) writeTail.delete(key) })
  return run
}

function notify() {
  try { document.dispatchEvent(new CustomEvent('dsh-writing-style:changed')) } catch { /* ignore */ }
}

// 测试缝：并发契约（同一会话不串响应、写不并发、GET 不借用 POST）只能从 RPC 层
// 本身验证 —— 组件只暴露结果，看不到「这次 GET 到底发了没有」。
// 宿主只取 apply，多一个导出对它无影响；长度就几个字节。
const __rpcForTest = rpc

function usePoll(React, fn, intervalMs) {
  const ref = React.useRef(fn)
  ref.current = fn
  React.useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive || pageHidden()) return
      try { ref.current() } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, intervalMs)
    const onVisible = () => { if (!pageHidden()) tick() }
    const onChanged = () => tick()
    document.addEventListener('visibilitychange', onVisible)
    document.addEventListener('dsh-writing-style:changed', onChanged)
    return () => {
      alive = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('dsh-writing-style:changed', onChanged)
    }
  }, [intervalMs])
}

// ---------------------------------------------------------------- 数据

const SCALE_KEYS = ['sentence', 'density', 'dialogue', 'interior', 'sensory', 'pace', 'vocabulary', 'paragraph', 'rhetoric', 'explicitness', 'humor']

const FALLBACK_DIMS = [
  { key: 'sentence', label: '句式长度', kind: 'scale', def: 45, lo: '短促', hi: '绵长' },
  { key: 'density', label: '描写密度', kind: 'scale', def: 50, lo: '白描', hi: '稠密' },
  { key: 'dialogue', label: '对话占比', kind: 'scale', def: 40, lo: '叙述', hi: '对白' },
  { key: 'interior', label: '心理描写', kind: 'scale', def: 45, lo: '外在', hi: '内心' },
  { key: 'sensory', label: '感官细节', kind: 'scale', def: 50, lo: '信息', hi: '五感' },
  { key: 'pace', label: '叙事节奏', kind: 'scale', def: 50, lo: '舒缓', hi: '紧凑' },
  { key: 'vocabulary', label: '词汇色彩', kind: 'scale', def: 50, lo: '平实', hi: '华丽' },
  { key: 'paragraph', label: '段落长度', kind: 'scale', def: 50, lo: '短段', hi: '长段' },
  { key: 'rhetoric', label: '修辞密度', kind: 'scale', def: 40, lo: '直陈', hi: '繁复' },
  { key: 'explicitness', label: '露骨程度', kind: 'scale', def: 50, lo: '含蓄', hi: '直露' },
  { key: 'humor', label: '幽默感', kind: 'scale', def: 30, lo: '严肃', hi: '诙谐' },
]


function useStyle(React, props) {
  // 初值取「上一次成功拿到的数据」（内存或 sessionStorage）：
  // 刷新页面 / 首次请求慢时，面板第一帧就有预设可画，而不是空白。
  const [state, setState] = React.useState(() => readCachedState())
  const [err, setErr] = React.useState('')
  // 失败计数：只用来驱动「自动重试」的 effect（成功即清零）。
  const [tries, setTries] = React.useState(0)
  let proj = null
  if (typeof props.useProjection === 'function') {
    try { proj = props.useProjection('writingStyle') } catch { proj = null }
  }
  const pull = React.useCallback((force) => {
    return rpc('state', undefined, undefined, { force: !!force })
      .then((r) => { setState(r); writeCachedState(r); setErr(''); setTries(0) })
      .catch((e) => { setErr(String(e.message || e)); setTries((n) => n + 1) })
  }, [])
  usePoll(React, pull, 45000)
  // ⚠️ 失败后必须自己再来一次：以前只有 45s 轮询，而退避窗口会把轮询一次次挡回去，
  // 「预设」页签就一直空着，用户只能手点「刷新」（2026-11-01 真机现象）。
  // 1.2s → 2.4s → 4.8s … 封顶 15s，最多 8 次；之后交给 45s 轮询，不无限骚扰宿主。
  React.useEffect(() => {
    if (!tries || tries > 8) return undefined
    const delay = Math.min(15000, 1200 * Math.pow(2, tries - 1))
    const id = setTimeout(() => { if (!pageHidden()) pull(true) }, delay)
    return () => { try { clearTimeout(id) } catch { /* ignore */ } }
  }, [tries])
  const updatedAt = proj && proj.updatedAt
  React.useEffect(() => { if (updatedAt) pull() }, [updatedAt])
  // ⚠️ doc 必须永远是一个合法对象，不能是 null：
  // 宿主的投影在「还没写过任何存档」时 view 就是 null，
  // 而 state 请求也可能还没回来 / 失败。之前这里会得到 null，
  // 下游 `doc.avoid.join()`、`doc.dims[...]` 全线抛错 —— 用户看到的就是
  // 「前三个页签空白 + 用词页签报 Cannot read properties of null」。
  const rawDoc = (state && state.doc) || (proj && proj.doc) || null
  const doc = normalizeDocClient(rawDoc)
  return {
    state,
    doc,
    err,
    setErr,
    pull,
    tries,
    dimsMeta: normalizeDimsMeta(state && state.dimsMeta),
    presets: (state && state.presets) || [],
  }
}

/** 客户端侧的文档兜底：任何缺失字段都补成合法值，永不返回 null。 */
function normalizeDocClient(raw) {
  const d = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const dims = (d.dims && typeof d.dims === 'object' && !Array.isArray(d.dims)) ? d.dims : {}
  const out = {
    enabled: d.enabled === true,
    preset: typeof d.preset === 'string' ? d.preset : 'balanced',
    presetName: typeof d.presetName === 'string' ? d.presetName : '均衡',
    dims,
    directives: typeof d.directives === 'string' ? d.directives : '',
    sample: typeof d.sample === 'string' ? d.sample : '',
    avoid: Array.isArray(d.avoid) ? d.avoid.filter((x) => typeof x === 'string') : [],
    prefer: Array.isArray(d.prefer) ? d.prefer.filter((x) => typeof x === 'string') : [],
    rules: Array.isArray(d.rules) ? d.rules.filter((r) => r && typeof r === 'object') : [],
  }
  // 维度缺值时用内置默认补齐：滑块、下拉都要有可显示的值
  for (const meta of FALLBACK_DIMS) {
    if (out.dims[meta.key] === undefined || out.dims[meta.key] === null) out.dims[meta.key] = meta.def
  }
  return out
}

/**
 * 维度元数据兜底归一化。
 *
 * ⚠️ 为什么前端也要做这一层：后端内部表用的是短键 `{ k, l }`，
 * 而界面用 `{ key, label }`。曾经后端三处直接把内部表返回出去，
 * 结果编辑器里滑块全空、维度页签一片空白 —— **整页看起来像挂了**。
 * 现在后端已统一走 dimsMeta()，这里再兜一层：形状不对就地转，
 * 转不了就用内置表，绝不让一次形状漂移变成白屏。
 */

function normalizeDimsMeta(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return FALLBACK_DIMS
  const out = []
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue
    const key = d.key || d.k
    const label = d.label || d.l
    if (!key) continue
    const opts = Array.isArray(d.options)
      ? d.options.map((o) => (Array.isArray(o)
          ? { value: o[0], label: o[1] }
          : (o && typeof o === 'object' ? { value: o.value, label: o.label || String(o.value) } : null))).filter(Boolean)
      : undefined
    out.push({
      key: String(key),
      label: String(label || key),
      kind: d.kind === 'enum' ? 'enum' : 'scale',
      def: d.def,
      ...(d.lo === undefined ? {} : { lo: d.lo }),
      ...(d.hi === undefined ? {} : { hi: d.hi }),
      ...(opts ? { options: opts } : {}),
    })
  }
  // 一个有效项都没有 → 用内置表，宁可显示默认也别空白
  return out.length ? out : FALLBACK_DIMS
}

// ---------------------------------------------------------------- 设置页

function SettingsPanel(props) {
  const React = props.React
  const { t } = props
  injectCss()
  const { state, doc, err, setErr, dimsMeta, presets, pull, tries } = useStyle(React, props)
  // 后端在 state 响应里带回预设落盘位置；老宿主没这个字段时用空对象，界面照常可用。
  const storage = (state && state.storage) || { file: '', home: '', homeFrom: '', error: '' }
  const [tab, setTab] = React.useState('presets')
  const [ruleDraft, setRuleDraft] = React.useState({ name: '', keys: '', text: '' })
  // 预设编辑器草稿：维度/禁用词/偏好词/附加要求/范文都在这一份表单里。
  // 2026-11-01 改版：外部不再有会话级的直接编辑入口，这份草稿**只从**
  // 预设卡片的「更改」或「新建预设」进入，存的就是预设本身。
  const [edit, setEdit] = React.useState({ id: '', name: '', desc: '', dims: {}, directives: '', avoid: '', prefer: '', sample: '' })
  // editing=false：新建（id 自己填）；editing=true：改一份现有预设（id 锁定，它就是目标）。
  // custom=true：磁盘上真有这份自定义预设/覆盖 —— 删除按钮只在这种情况下出现。
  const [edMode, setEdMode] = React.useState({ editing: false, custom: false })
  const [msg, setMsg] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [preview, setPreview] = React.useState('')
  // note：「保存了但没应用」的持久提示（flash 1.8s 就没了，这条必须留在页面上）。
  const [note, setNote] = React.useState('')
  // edPrev：编辑器里「预览注入效果」的结果 —— 这份草稿套用时会给模型注入什么。
  const [edPrev, setEdPrev] = React.useState('')

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 1800) }
  const send = (op, payload) => {
    setBusy(true)
    return rpc(op, payload)
      .then((r) => { setErr(''); return r })
      .catch((e) => { setErr(String(e.message || e)); return null })
      .then((r) => { setBusy(false); return r })
  }

  React.useEffect(() => { setPreview((state && state.directive) || '') }, [state && state.directive])

  // 页签栏只剩三个（2026-11-01 改版）：维度/用词等会话级编辑页签撤掉，
  // 那些字段全部收进「预设 → 更改」的编辑视图里。
  // 'editor' 仍然是合法 tab 值，但**不在页签栏出现**——只能从卡片按钮进入。
  const tabs = [
    ['presets', t('presets')],
    ['rules', t('rules')],
    ['preview', t('preview')],
  ]

  // 卡片 = 两块可点区域：左半「点=套用到当前对话」，右条「更改」= 编辑这份预设。
  // ⚠️ 外层必须是 div：button 套 button 是非法 HTML，浏览器/宿主渲染会拆结构。
  const openEditor = (p) => {
    setEdit({
      id: p.id || '',
      name: p.name || '',
      desc: p.desc || '',
      dims: Object.assign({}, p.dims || {}),
      directives: p.directives || '',
      avoid: (p.avoid || []).join('、'),
      prefer: (p.prefer || []).join('、'),
      sample: p.sample || '',
    })
    setEdMode({ editing: true, custom: !!p.custom })
    setTab('editor')
    setErr('')
    setNote('')
    setEdPrev('')
  }
  const openNewEditor = () => {
    setEdit({ id: '', name: '', desc: '', dims: {}, directives: '', avoid: '', prefer: '', sample: '' })
    setEdMode({ editing: false, custom: false })
    setTab('editor')
    setErr('')
    setNote('')
    setEdPrev('')
  }

  const presetCards = (presets || []).map((p) => React.createElement('div', {
    key: p.id,
    className: 'wst-preset' + (doc && doc.preset === p.id ? ' active' : ''),
  },
    React.createElement('button', {
      className: 'wst-preset-main',
      disabled: busy,
      title: t('apply'),
      onClick: () => { setNote(''); send('preset', { id: p.id }) },
    },
      React.createElement('span', { className: 'wst-preset-name' }, p.name + (p.custom ? ' ★' : '')),
      React.createElement('span', { className: 'wst-preset-desc' }, p.desc || '')),
    React.createElement('button', {
      className: 'wst-preset-edit',
      disabled: busy,
      title: t('editor') + '：' + (p.name || p.id),
      onClick: () => openEditor(p),
    }, t('editPreset'))))

  // ---- 预设编辑器（改版后唯一的内容编辑入口）----
  // 维度/禁用词/偏好词/附加要求/范文全在这一张表单里，保存的就是预设本身，
  // 不再是「当前会话的散改动」。只能从卡片「更改」或「新建预设」进入。
  // 刻意做成「一个 id + 一份完整内容」的表单，而不是让你去手改 JSON：
  // 手改 JSON 一次格式错误就整份读不出来，而这里每个字段都单独校验。
  const ed = edit
  // 表单一改动，上一次的注入预览就过期了 —— 宁可清空，也不要让人拿旧预览当现状。
  const setEd = (patch) => { setEdPrev(''); setEdit(Object.assign({}, edit, patch)) }

  const collectPreset = () => {
    const dims = {}
    for (const [k, v] of Object.entries(ed.dims || {})) dims[k] = v
    return {
      id: ed.id.trim(),
      name: ed.name.trim() || ed.id.trim(),
      desc: ed.desc.trim(),
      dims,
      directives: ed.directives,
      avoid: ed.avoid.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean),
      prefer: ed.prefer.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean),
      sample: ed.sample,
    }
  }
  // 「预览注入效果」：把草稿当成一份文档发给服务端 preview op（它接受 body.doc，
  // 渲染逻辑和每轮注入用的是同一个 renderDirective）。只读，不落盘、不动会话。
  const previewPreset = () => {
    const p = collectPreset()
    send('preview', {
      doc: {
        enabled: true,
        preset: p.id || 'draft',
        presetName: p.name || p.id || '草稿',
        dims: p.dims,
        directives: p.directives,
        avoid: p.avoid,
        prefer: p.prefer,
        sample: p.sample,
      },
    }).then((r) => { if (r && typeof r.directive === 'string') setEdPrev(r.directive) })
  }

  // applyAfter=true 就是「保存并应用到当前对话」：先落盘预设，再 POST preset 套用。
  // 成功回预设列表 + flash；失败留在编辑视图、错误显示在表单上方（不许静默）。
  const savePreset = (applyAfter) => {
    const payload = collectPreset()
    if (!payload.id) return
    send('write-preset', payload).then((r) => {
      if (!r) return
      flash(t('presetSaved') + (r.storedDims && r.storedDims.length
        ? '（' + r.storedDims.length + ' 个维度）' : '（未改动维度，全部等于默认）'))
      if (r.note) setErr(r.note)
      const back = () => { setTab('presets'); pull(true) }
      if (applyAfter) {
        setNote('')
        send('preset', { id: payload.id }).then((ap) => { if (ap) back() })
      } else {
        // 改的正是当前对话在用的那份预设时，必须说清楚：预设存盘 ≠ 会话生效。
        // 会话文档是「套用那一刻」的快照，不重新套用不会跟着变（预览页签同理）。
        if (doc && doc.preset === payload.id) setNote(t('savedNoApply'))
        else setNote('')
        back()
      }
    })
  }

  const editorForm = React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    React.createElement('div', { className: 'wst-row' },
      React.createElement('button', { className: 'wst-btn', onClick: () => setTab('presets') }, t('backToList')),
      edMode.editing
        ? React.createElement('span', { className: 'wst-hint' }, t('edEditing') + '：' + (ed.name || ed.id))
        : null),
    React.createElement('div', { className: 'wst-row' },
      React.createElement('input', {
        className: 'wst-input',
        style: { width: 150 },
        placeholder: t('edId'),
        // 改现有预设时 id 就是「改哪一份」，锁死；只有新建才允许填。
        disabled: edMode.editing || busy,
        value: ed.id,
        onChange: (e) => setEd({ id: e.target.value.replace(/[^a-zA-Z0-9._-]/g, '') }),
      }),
      React.createElement('input', {
        className: 'wst-input',
        style: { flex: 1, minWidth: 140 },
        placeholder: t('edName'),
        value: ed.name,
        onChange: (e) => setEd({ name: e.target.value }),
      })),
    React.createElement('input', {
      className: 'wst-input',
      placeholder: t('edDesc'),
      value: ed.desc,
      onChange: (e) => setEd({ desc: e.target.value }),
    }),
    React.createElement('div', { className: 'wst-field' },
      React.createElement('span', { className: 'wst-field-label' }, t('edDims')),
      React.createElement('div', { className: 'wst-hint' }, t('edDimsHint')),
      React.createElement('div', { className: 'wst-grid' },
        SCALE_KEYS.map((key) => {
          const meta = (dimsMeta || []).find((d) => d.key === key)
          if (!meta) return null
          const val = ed.dims[key] === undefined ? meta.def : ed.dims[key]
          return React.createElement('label', { className: 'wst-field', key },
            React.createElement('span', { className: 'wst-field-head' },
              React.createElement('span', { className: 'wst-field-label' }, meta.label),
              React.createElement('span', { className: 'wst-field-val' }, String(val))),
            React.createElement('input', {
              className: 'wst-range',
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: val,
              onChange: (e) => setEd({ dims: Object.assign({}, ed.dims, { [key]: Number(e.target.value) }) }),
            }))
        }),
        (dimsMeta || []).filter((d) => d.kind === 'enum').map((meta) => React.createElement('label', { className: 'wst-field', key: meta.key },
          React.createElement('span', { className: 'wst-field-head' },
            React.createElement('span', { className: 'wst-field-label' }, meta.label)),
          React.createElement('select', {
            className: 'wst-select',
            value: ed.dims[meta.key] === undefined ? meta.def : ed.dims[meta.key],
            onChange: (e) => setEd({ dims: Object.assign({}, ed.dims, { [meta.key]: e.target.value }) }),
          }, (meta.options || []).map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))))))),
    React.createElement('div', { className: 'wst-field' },
      React.createElement('span', { className: 'wst-field-label' }, t('directivesLabel')),
      React.createElement('textarea', {
        className: 'wst-textarea',
        value: ed.directives,
        placeholder: t('edDirectivesHint'),
        onChange: (e) => setEd({ directives: e.target.value }),
      })),
    React.createElement('div', { className: 'wst-field' },
      React.createElement('span', { className: 'wst-field-label' }, t('avoidLabel')),
      React.createElement('textarea', {
        className: 'wst-textarea',
        style: { minHeight: 44 },
        value: ed.avoid,
        onChange: (e) => setEd({ avoid: e.target.value }),
      })),
    React.createElement('div', { className: 'wst-field' },
      React.createElement('span', { className: 'wst-field-label' }, t('preferLabel')),
      React.createElement('textarea', {
        className: 'wst-textarea',
        style: { minHeight: 44 },
        value: ed.prefer,
        onChange: (e) => setEd({ prefer: e.target.value }),
      })),
    React.createElement('div', { className: 'wst-field' },
      React.createElement('span', { className: 'wst-field-label' }, t('sampleLabel')),
      React.createElement('textarea', {
        className: 'wst-textarea',
        style: { minHeight: 96 },
        value: ed.sample,
        onChange: (e) => setEd({ sample: e.target.value }),
      })),
    // 落盘位置写在按钮上方：万一「点了没反应」，这里立刻能看出是没解析出目录，
    // 而不是让人对着按钮猜（上一版就是这么静默失败了好几轮）。
    React.createElement('div', { className: 'wst-hint' },
      t('storedAt') + '：' + (storage.file || t('storedHomeMissing'))
      + (storage.homeFrom ? '（home 来源 ' + storage.homeFrom + '）' : '')
      + (storage.error ? ' · ' + t('writeFailed') + storage.error : '')),
    React.createElement('div', { className: 'wst-row' },
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy || !ed.id.trim(),
        onClick: () => savePreset(false),
      }, t('edSave')),
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy || !ed.id.trim(),
        onClick: () => savePreset(true),
      }, t('edSaveApply')),
      // 删除只对「磁盘上真存在的自定义预设 / 覆盖」出现：
      // 纯内置预设没有可删的东西，画出来只会让人误以为「删了内置就没了」。
      edMode.editing && edMode.custom
        ? React.createElement('button', {
            className: 'wst-btn',
            disabled: busy,
            onClick: () => {
              if (!window.confirm(t('confirmDeletePreset'))) return
              send('delete-preset', { id: ed.id.trim() }).then(() => { setTab('presets'); pull(true) })
            },
          }, t('del'))
        : null),
    // 预览紧跟在保存按钮下面：改完先看看这份草稿会注入什么，再决定保不保存。
    React.createElement('div', { className: 'wst-row' },
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy,
        onClick: previewPreset,
      }, t('edPreview'))),
    React.createElement('div', { className: 'wst-hint' }, t('edPreviewHint')),
    edPrev ? React.createElement('div', { className: 'wst-preview' }, edPrev) : null,
    React.createElement('div', { className: 'wst-hint' },
      t('edNote')))

  const rules = (doc && doc.rules) || []

  // 页签内容用 try 兜一层：某一页数据异常时只显示这一页的错误，
  // 不让整块设置页变成空白（白屏会让用户以为插件坏了、也改不了任何设置）。
  let body = null
  try {
    body = renderTab()
  } catch (e) {
    body = React.createElement('div', { className: 'wst-err' },
      t('tabError') + '：' + String((e && e.message) || e))
  }

  return React.createElement('div', { className: 'wst-root wst-settings' },
    React.createElement('div', { className: 'wst-sect' },
      t('title'),
      React.createElement('button', {
        className: 'wst-btn' + (doc && doc.enabled ? ' on' : ''),
        disabled: busy,
        onClick: () => send('toggle', {}),
      }, doc && doc.enabled ? t('disable') : t('enable')),
      // 手动刷新走 force：退避窗口不该挡用户主动点的那一下。
      React.createElement('button', { className: 'wst-btn', disabled: busy, onClick: () => { pull(true) } }, t('refresh')),
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy,
        onClick: () => { if (window.confirm(t('confirmReset'))) send('reset', {}) },
      }, t('reset'))),
    React.createElement('div', { className: 'wst-hint' }, t('hint')),
    err ? React.createElement('div', { className: 'wst-err' }, err) : null,
    // 还没拿到任何数据（且重试中）时给一句话，别让页签看起来像「空库」。
    !state
      ? React.createElement('div', { className: 'wst-hint' }, tries ? t('retrying') : t('loading'))
      : null,
    msg ? React.createElement('div', { className: 'wst-ok' }, msg) : null,
    note ? React.createElement('div', { className: 'wst-note' }, note) : null,
    state && state.hasSession === false
      ? React.createElement('div', { className: 'wst-empty' }, t('noSession'))
      : null,
    React.createElement('div', { className: 'wst-tabs' },
      tabs.map(([k, label]) => React.createElement('button', {
        key: k,
        className: 'wst-tab' + (tab === k ? ' active' : ''),
        // 预览页签展示的是 state 带回的注入正文：切过去就强拉一次，
        // 别让用户对着 45s 轮询前的旧正文猜「保存生效了吗」。
        onClick: () => { setTab(k); if (k === 'preview') pull(true) },
      }, label))),
    body)

  function renderTab() {
    if (tab === 'presets') return React.createElement('div', null,
      React.createElement('div', { className: 'wst-presets' }, presetCards),
      React.createElement('div', { className: 'wst-row', style: { marginTop: 10 } },
        React.createElement('button', {
          className: 'wst-btn',
          disabled: busy,
          onClick: openNewEditor,
        }, t('newPreset'))))

    // 编辑视图不在页签栏里：只能从「更改」/「新建预设」进入（改版核心）。
    if (tab === 'editor') return editorForm

    if (tab === 'rules') return React.createElement('div', null,
      rules.length === 0
        ? React.createElement('div', { className: 'wst-empty' }, t('rulesEmpty'))
        : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            rules.map((r) => React.createElement('div', { className: 'wst-rule', key: r.id },
              React.createElement('div', { className: 'wst-rule-head' },
                React.createElement('span', { className: 'wst-rule-name' }, r.name || r.id),
                React.createElement('span', { className: 'wst-rule-keys' }, r.keys.length ? '← ' + r.keys.join(' / ') : '（总是）'),
                React.createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: 2 } },
                  React.createElement('button', {
                    className: 'wst-btn' + (r.enabled ? ' on' : ''),
                    disabled: busy,
                    onClick: () => send('set', { rules: rules.map((x) => x.id === r.id ? Object.assign({}, x, { enabled: !x.enabled }) : x) }),
                  }, r.enabled ? '◉' : '○'),
                  React.createElement('button', {
                    className: 'wst-btn',
                    disabled: busy,
                    onClick: () => send('set', { rules: rules.filter((x) => x.id !== r.id) }),
                  }, '×'))),
              React.createElement('div', { className: 'wst-rule-text' }, r.text)))),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
        React.createElement('input', {
          className: 'wst-input',
          placeholder: t('ruleName'),
          value: ruleDraft.name,
          onChange: (e) => setRuleDraft(Object.assign({}, ruleDraft, { name: e.target.value })),
        }),
        React.createElement('input', {
          className: 'wst-input',
          placeholder: t('ruleKeys'),
          value: ruleDraft.keys,
          onChange: (e) => setRuleDraft(Object.assign({}, ruleDraft, { keys: e.target.value })),
        }),
        React.createElement('textarea', {
          className: 'wst-textarea',
          placeholder: t('ruleText'),
          value: ruleDraft.text,
          onChange: (e) => setRuleDraft(Object.assign({}, ruleDraft, { text: e.target.value })),
        }),
        React.createElement('div', { className: 'wst-row' },
          React.createElement('button', {
            className: 'wst-btn',
            disabled: busy || !ruleDraft.text.trim(),
            onClick: () => {
              const keys = ruleDraft.keys.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean)
              send('set', {
                rules: rules.concat([{
                  id: 'r' + Date.now().toString(36),
                  name: ruleDraft.name.trim() || '条目',
                  keys,
                  text: ruleDraft.text,
                  enabled: true,
                }]),
              }).then(() => setRuleDraft({ name: '', keys: '', text: '' }))
            },
          }, t('ruleAdd')))))

    if (tab === 'preview') return React.createElement('div', null,
      React.createElement('div', { className: 'wst-hint', style: { marginBottom: 6 } }, t('previewLabel')),
      React.createElement('div', { className: 'wst-preview' }, preview || t('dirEmpty')),
      React.createElement('div', { className: 'wst-row', style: { marginTop: 8 } },
        React.createElement('button', {
          className: 'wst-btn',
          onClick: () => {
            try {
              navigator.clipboard.writeText(preview || '').then(() => flash(t('copied'))).catch(() => {})
            } catch { /* ignore */ }
          },
        }, t('copy')),
        React.createElement('button', {
          className: 'wst-btn',
          disabled: busy,
          onClick: () => send('preview', {}).then((r) => { if (r && r.directive !== undefined) setPreview(r.directive) }),
        }, t('refresh'))))

    return null
  }
}

// ---------------------------------------------------------------- 输入框上方徽标
// 注册在 conversation.input.dock（新会话的 hero 形态也渲染；composer.dock 在
// hero 下整席位不出现 —— 2026-11-02 用户报「初始会话看不到开关」的根因）。
//
// 显示的状态来自服务端 `state`（和每轮注入读的是同一份会话文档），点完再用响应里
// 的 doc 立刻回显；同时复用 usePoll —— 它监听 `dsh-writing-style:changed`，
// 所以在设置页里改一下，这颗徽标会同步跟着变。
//
// 这里**不**碰宿主的 useProjection：这个席位能不能拿到那个 hook 取决于宿主怎么
// 装配 standard props，一旦某次渲染有、下次没有，hook 调用顺序就变了，React 直接
// 抛错 —— 崩掉的是整个输入框，不是一个按钮。宁可只靠请求 + 事件驱动。
//
// ⚠️ 组件里的 hook 必须在任何 return 之前全部调完（React 固定顺序要求），
// 所以「拿不到会话 id 就不出现」那句判断放在最后。

function StyleChip(props) {
  const React = props.React
  const t = props.t
  const rpc = props.rpc
  injectCss()

  const [enabled, setEnabled] = React.useState(null)   // null = 还没读到
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const triesRef = React.useRef(0)

  // 会话 id 只认「这个席位自己那份」，绝不回落到模块全局：
  // 全局记的是最后一次 inject 的会话，多对话来回切会把 A 的开关写到 B 上。
  // 兜底走 props.kit.standard —— 宿主 renderEntry 只 spread {kit, injected,
  // slotInjected.props, ownerProps}，standard props 挂在 kit 里面，顶层没有 props.standard 这个东西。
  const kit = (props.kit && typeof props.kit === 'object') ? props.kit : {}
  const std = (kit.standard && typeof kit.standard === 'object') ? kit.standard : {}
  let sid = typeof props.sessionId === 'string' ? props.sessionId : ''
  if (!sid && typeof std.sessionId === 'string') sid = std.sessionId

  const read = React.useCallback(() => {
    if (!sid) return
    // force：面板那边失败过一次留下的退避窗口，不该让徽标也一直读不到状态。
    rpc('state', {}, sid, { force: true })
      .then((r) => {
        triesRef.current = 0
        setEnabled(!!(r && r.doc && r.doc.enabled === true))
        setFailed(false)
        setMsg('')
      })
      .catch((e) => {
        setFailed(true)
        setMsg(String((e && e.message) || e))
        // 失败后自己再试三次（2s/4s/8s），60s 轮询太慢，徽标会长时间停在「重试」。
        if (triesRef.current < 3) {
          const delay = 2000 * Math.pow(2, triesRef.current)
          triesRef.current += 1
          try { setTimeout(() => { read() }, delay) } catch { /* ignore */ }
        }
      })
  }, [sid])

  usePoll(React, read, 60000)
  React.useEffect(() => { read() }, [read])

  // 换对话：上一个对话的状态不能跟过来，先回到「还没读到」。
  React.useEffect(() => { triesRef.current = 0; setEnabled(null); setBusy(false); setFailed(false); setMsg('') }, [sid])

  const click = () => {
    if (busy || !sid) return
    setBusy(true)
    setFailed(false)
    setMsg('')
    // 服务端写不进去会直接 throw（recordAppend 失败就抛），所以 200 就等于真落盘了。
    rpc('toggle', {}, sid)
      .then((r) => {
        setBusy(false)
        if (r && r.doc && typeof r.doc.enabled === 'boolean') setEnabled(r.doc.enabled === true)
        else read()
      })
      .catch((e) => {
        setBusy(false)
        setFailed(true)
        setMsg(String((e && e.message) || e))
      })
  }

  if (!sid) return null

  const on = enabled === true
  const label = failed
    ? t('chipRetry')
    : enabled === null ? t('chipPending') : on ? t('chipOn') : t('chipOff')
  const title = failed ? t('chipFailed') + msg : on ? t('chipHintOn') : t('chipHintOff')

  return React.createElement('div', { className: 'wstc-dock' },
  React.createElement('button', {
    type: 'button',
    className: 'wstc' + (on ? ' on' : '') + (failed ? ' failed' : ''),
    disabled: busy,
    title,
    'aria-label': title,
    onClick: click,
  },
  React.createElement('span', { className: 'wstc-dot' }),
  label))
}

// ---------------------------------------------------------------- 挂载

function apply(ctx) {
  const React = require('react')
  // ⚠️ locale.register 返回 disposer；ctx.effect(fn) 会立刻执行 fn，
  // 写成 `ctx.effect(() => ctx.locale.register(...))` 等于注册完马上注销。
  try {
    ctx.effect(() => {
      const off = ctx.locale.register(NS, { zh: ZH, en: EN })
      return () => { try { off() } catch { /* ignore */ } }
    }, 'dsh-writing-style: locale')
  } catch { /* 老宿主没有 locale：用内置中文 */ }

  const t = (key, vars) => {
    try {
      const bound = ctx.locale.bind(NS)
      const v = bound(key, vars)
      if (typeof v === 'string' && v !== key) return v
    } catch { /* 回退内置 */ }
    const v = ZH[key]
    return typeof v === 'function' ? v(vars) : (v == null ? key : v)
  }

  const injected = (session) => {
    // 宿主的徽标席位是 session 作用域：inject 每被一个对话调用一次，
    // 就把那个对话的 id 直接交给组件自己攥着（props.sessionId）。
    // 徽标和设置页共用这个回调，所以两边都能显式带上 ?session=，
    // 而不是依赖「最近一次 inject 的会话」那个全局变量 —— 后者在多个
    // 对话来回切换时是会串味的。
    const sid = session ? (typeof session === 'string' ? session : session.id) : ''
    if (sid) {
      sessionId = sid
      try { localStorage.setItem('dsh-writing-style/session', sid) } catch { /* ignore */ }
    }
    return {
      React,
      t,
      rpc,
      sessionId: sid,
      // 老宿主可能没这个函数：徽标自己会兜底去读 location / localStorage。
      useSession: ctx.slots && ctx.slots.useSession,
    }
  }

  // 设置页：完整编辑器。
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'writing-style',
      order: 5,
      label: () => t('section'),
      locale: NS,
      inject: injected,
    }, SettingsPanel))
  } catch (err) { /* ignore */ }

  // 输入框上方 dock：只放开关徽标。
  // ⚠️ 2026-11-02 从 conversation.composer.dock 搬过来：宿主对 composer.dock 的
  // 渲染条件是 `variant === "composer" && sessionId !== void 0`（ui-conversation
  // InputBar），新会话的 hero 形态 variant 是 "hero" —— 那颗徽标在初始界面上
  // 根本不会被渲染（用户报「初始会话看不到开关」）。input.dock 的条件是
  // `zone !== void 0`（zone = {session, input}，宿主源码 conversation.input.dock
  // 是 scope:"session"，inject 第一参数同样是会话 id —— 宿主自己的 queue dock 就是证据），
  // 新会话（有 session、还没消息）也渲染 ⇒ 开聊之前就能给这个对话拨文风。
  // 两个席位只注册这一个：都注册的话，活跃会话里会出现两颗。
  try {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'writing-style',
      order: 4,
      locale: NS,
      inject: injected,
    }, StyleChip))
  } catch (err) { /* ignore */ }
}

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 测试缝：并发契约只能从 RPC 层验（组件只看得到结果，看不到「这次请求到底发没发」）。
    exports.__rpcForTest = __rpcForTest;
    return module.exports;
  }
});
