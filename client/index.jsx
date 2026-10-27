// dsh-writing-style —— 客户端源码（构建产物：../client.js）
//
// 只有一个席位：
//   settings.section —— 完整面板：预设库、自己写预设的编辑器、13 个维度、
//                        禁用词、范文、触发性条目、预览
//
// 输入框上方的底栏按用户要求整块去掉了：风格不是每轮都要盯着调的东西，
// 需要时用一句话让 AI 改（style_set / style_preset）比在底栏点更顺手，
// 也不占对话区的垂直空间。改风格之后，对话里只会出现一句确认。
//
// 数据：投影 `writingStyle`（宿主推送）；写操作走 /dsh-writing-style/*。

const NS = 'dsh-writing-style'
const ROUTE = '/dsh-writing-style'

export const name = 'dsh-writing-style'
export const inject = ['slots', 'locale', 'connection']

const ZH = {
  section: '写作风格',
  title: '写作风格',
  hint: '这里的改动只影响当前会话，立刻生效（下一轮回复就用新风格）。数值改动会记进会话日志，可以撤销。',
  off: '未启用',
  on: '已启用',
  enable: '启用风格',
  disable: '关闭风格',
  presets: '预设',
  editor: '写预设',
  edId: '预设 id（英文，如 my-noir）',
  edName: '显示名（如 我的冷硬派）',
  edDesc: '一句话描述（可选）',
  edDims: '这套预设的维度',
  edDimsHint: '只有和「均衡」不同的维度才会被存下来，其余留空即用默认。',
  edSave: '写入预设',
  edLoad: '载入这个 id',
  edNotFound: '没有这个 id 的预设（内置预设不能改，先换个新 id 另存一份）',
  edNote: '写入后它就是一个真正的预设：出现在「预设」页签里，可以一键套用，也能被 AI 用 style_preset 调用。存的是模板，不会自动应用到当前会话。',
  edDirectivesHint: '这套预设的自由指令（可选）：写得越具体，模型越听话。',
  dims: '维度',
  words: '用词',
  rules: '条目',
  preview: '预览',
  apply: '套用',
  saveAs: '存为预设',
  del: '删除',
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
  copy: '复制全文',
  copied: '已复制',
  dirEmpty: '风格未启用，本轮不注入任何写作规范。',
  saveNamePrompt: '预设名（英文 id，如 my-noir）',
  presetSaved: '已保存',
  confirmReset: '把当前会话的风格恢复成默认（关闭）？',
  scaleHint: '拖动滑块即时生效；左侧是低档，右侧是高档。',
}

const EN = {
  section: 'Writing style',
  title: 'Writing style',
  hint: 'Changes apply to this session only and take effect on the next reply. Values are logged and can be undone.',
  off: 'Off',
  on: 'On',
  enable: 'Enable',
  disable: 'Disable',
  presets: 'Presets',
  editor: 'Write preset',
  edId: 'Preset id (ascii, e.g. my-noir)',
  edName: 'Display name',
  edDesc: 'One-line description (optional)',
  edDims: 'Dimensions for this preset',
  edDimsHint: 'Only dimensions that differ from Balanced are stored; the rest fall back to defaults.',
  edSave: 'Write preset',
  edLoad: 'Load by id',
  edNotFound: 'No preset with that id (built-ins cannot be edited; use a new id to save a copy)',
  edNote: 'Once written it is a real preset: it shows up under Presets, applies in one click, and the model can call it via style_preset. Saving does not apply it to this session.',
  edDirectivesHint: 'Extra instructions for this preset (optional).',
  dims: 'Dimensions',
  words: 'Words',
  rules: 'Rules',
  preview: 'Preview',
  apply: 'Apply',
  saveAs: 'Save preset',
  del: 'Delete',
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
  copy: 'Copy',
  copied: 'Copied',
  dirEmpty: 'Style is off; nothing is injected this turn.',
  saveNamePrompt: 'Preset id (e.g. my-noir)',
  presetSaved: 'Saved',
  confirmReset: 'Reset this session\'s style to default (off)?',
  scaleHint: 'Drag to change; left is low, right is high.',
}

const CSS = `
.wst-root{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
.wst-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,rgba(20,20,24,.86));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(8px));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));box-shadow:var(--dsw-elevation-panel,0 6px 24px rgba(0,0,0,.25));overflow:hidden}
.wst-head{display:flex;align-items:center;gap:8px;padding:5px 10px;user-select:none}
.wst-dot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-fill-l3,rgba(128,128,128,.4))}
.wst-dot.on{background:var(--dsw-alias-state-success-primary,#2ea36f);box-shadow:0 0 6px rgba(46,163,111,.7)}
.wst-title{font-weight:600;white-space:nowrap}
.wst-turn{opacity:.45;font-size:11px;white-space:nowrap}
.wst-chips{display:flex;gap:10px;flex:1;min-width:0;overflow:hidden;cursor:pointer}
.wst-chip{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}
.wst-chip-name{opacity:.6;font-size:11px}
.wst-chip-val{font-weight:600;font-variant-numeric:tabular-nums}
.wst-actions{display:flex;gap:2px;opacity:.6;flex:none}
.wst-actions:hover{opacity:1}
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
.wst-preset{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08));border-radius:8px;padding:5px 9px;cursor:pointer;font-size:11.5px;color:inherit;font-family:inherit;text-align:left;max-width:230px}
.wst-preset:hover{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.18))}
.wst-preset.active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.14)}
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
// 这里全进程同一时刻最多 1 个在途请求、4s 超时、页面隐藏不轮询、失败指数退避。

const RPC_TIMEOUT_MS = 4000
const inflight = { current: null }
const health = { failures: 0, nextAt: 0 }

const backoffMs = () => Math.min(60000, 2000 * Math.pow(2, Math.max(0, health.failures - 1)))
const pageHidden = () => {
  try { return typeof document !== 'undefined' && document.visibilityState === 'hidden' } catch { return false }
}

const GET_OPS = new Set(['state', 'presets', 'rules'])

async function rpcRaw(op, payload) {
  const sid = currentSessionId()
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

function rpc(op, payload) {
  if (inflight.current) return inflight.current
  if (Date.now() < health.nextAt) return Promise.reject(new Error('writing-style: 退避中'))
  const task = rpcRaw(op, payload)
    .then((body) => {
      health.failures = 0
      health.nextAt = 0
      if (!GET_OPS.has(op.split('?')[0])) notify()
      return body
    })
    .catch((err) => {
      health.failures += 1
      health.nextAt = Date.now() + backoffMs()
      throw err
    })
    .finally(() => { inflight.current = null })
  inflight.current = task
  return task
}

function notify() {
  try { document.dispatchEvent(new CustomEvent('dsh-writing-style:changed')) } catch { /* ignore */ }
}

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

function useStyle(React, props) {
  const [state, setState] = React.useState(null)
  const [err, setErr] = React.useState('')
  let proj = null
  if (typeof props.useProjection === 'function') {
    try { proj = props.useProjection('writingStyle') } catch { proj = null }
  }
  const pull = React.useCallback(() => {
    rpc('state')
      .then((r) => { setState(r); setErr('') })
      .catch((e) => setErr(String(e.message || e)))
  }, [])
  usePoll(React, pull, 45000)
  const updatedAt = proj && proj.updatedAt
  React.useEffect(() => { if (updatedAt) pull() }, [updatedAt])
  const doc = (state && state.doc) || (proj && proj.doc) || null
  return { state, doc, err, setErr, pull, dimsMeta: (state && state.dimsMeta) || [], presets: (state && state.presets) || [] }
}

// ---------------------------------------------------------------- 设置页

function SettingsPanel(props) {
  const React = props.React
  const { t } = props
  injectCss()
  const { state, doc, err, setErr, dimsMeta, presets, pull } = useStyle(React, props)
  const [tab, setTab] = React.useState('presets')
  const [draft, setDraft] = React.useState({ directives: null, sample: null, avoid: null, prefer: null })
  const [ruleDraft, setRuleDraft] = React.useState({ name: '', keys: '', text: '' })
  // 预设编辑器草稿（自己写文风预设的地方）
  const [edit, setEdit] = React.useState({ id: '', name: '', desc: '', dims: {}, directives: '', avoid: '', sample: '' })
  const [msg, setMsg] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [preview, setPreview] = React.useState('')

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 1800) }
  const send = (op, payload) => {
    setBusy(true)
    return rpc(op, payload)
      .then((r) => { setErr(''); return r })
      .catch((e) => { setErr(String(e.message || e)); return null })
      .then((r) => { setBusy(false); return r })
  }

  React.useEffect(() => { setPreview((state && state.directive) || '') }, [state && state.directive])

  const docVal = (key, fallback) => {
    if (draft[key] !== null && draft[key] !== undefined) return draft[key]
    const v = doc && doc[key]
    return v === undefined ? fallback : v
  }

  const commitText = (key) => {
    const v = draft[key]
    if (v === null || v === undefined) return
    send('set', { [key]: v }).then((r) => {
      if (r) { setDraft(Object.assign({}, draft, { [key]: null })); flash(t('presetSaved')) }
    })
  }

  const tabs = [
    ['presets', t('presets')],
    ['editor', t('editor')],
    ['dims', t('dims')],
    ['words', t('words')],
    ['rules', t('rules')],
    ['preview', t('preview')],
  ]

  const presetCards = (presets || []).map((p) => React.createElement('button', {
    key: p.id,
    className: 'wst-preset' + (doc && doc.preset === p.id ? ' active' : ''),
    disabled: busy,
    onClick: () => send('preset', { id: p.id }),
  },
    React.createElement('span', { className: 'wst-preset-name' }, p.name + (p.custom ? ' ★' : '')),
    React.createElement('span', { className: 'wst-preset-desc' }, p.desc || '')))

  // ---- 预设编辑器：这就是「自己写入文风预设」的入口 ----
  // 刻意做成「一个 id + 一份完整内容」的表单，而不是让你去手改 JSON：
  // 手改 JSON 一次格式错误就整份读不出来，而这里每个字段都单独校验。
  const ed = edit
  const setEd = (patch) => setEdit(Object.assign({}, edit, patch))

  const editorForm = React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    React.createElement('div', { className: 'wst-row' },
      React.createElement('input', {
        className: 'wst-input',
        style: { width: 150 },
        placeholder: t('edId'),
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
      React.createElement('span', { className: 'wst-field-label' }, t('sampleLabel')),
      React.createElement('textarea', {
        className: 'wst-textarea',
        style: { minHeight: 96 },
        value: ed.sample,
        onChange: (e) => setEd({ sample: e.target.value }),
      })),
    React.createElement('div', { className: 'wst-row' },
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy || !ed.id.trim(),
        onClick: () => {
          const dims = {}
          for (const [k, v] of Object.entries(ed.dims || {})) dims[k] = v
          send('write-preset', {
            id: ed.id.trim(),
            name: ed.name.trim() || ed.id.trim(),
            desc: ed.desc.trim(),
            dims,
            directives: ed.directives,
            avoid: ed.avoid.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean),
            sample: ed.sample,
          }).then((r) => { if (r) { flash(t('presetSaved')); pull() } })
        },
      }, t('edSave')),
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy,
        onClick: () => {
          const hit = (presets || []).find((p) => p.id === ed.id.trim())
          if (!hit) { setErr(t('edNotFound')); return }
          setEdit({
            id: hit.id,
            name: hit.name || '',
            desc: hit.desc || '',
            dims: Object.assign({}, hit.dims || {}),
            directives: hit.directives || '',
            avoid: (hit.avoid || []).join('、'),
            sample: hit.sample || '',
          })
          setErr('')
        },
      }, t('edLoad')),
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy || !ed.id.trim(),
        onClick: () => send('delete-preset', { id: ed.id.trim() }).then(() => pull()),
      }, t('del'))),
    React.createElement('div', { className: 'wst-hint' },
      t('edNote')))

  const dimFields = (dimsMeta || []).map((meta) => {
    const val = (doc && doc.dims && doc.dims[meta.key] !== undefined) ? doc.dims[meta.key] : meta.def
    if (meta.kind === 'enum') {
      return React.createElement('label', { className: 'wst-field', key: meta.key },
        React.createElement('span', { className: 'wst-field-head' },
          React.createElement('span', { className: 'wst-field-label' }, meta.label)),
        React.createElement('select', {
          className: 'wst-select',
          value: val,
          disabled: busy,
          onChange: (e) => send('set', { dims: { [meta.key]: e.target.value } }),
        }, (meta.options || []).map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))))
    }
    return React.createElement('label', { className: 'wst-field', key: meta.key },
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
        disabled: busy,
        onChange: (e) => send('set', { dims: { [meta.key]: Number(e.target.value) } }),
      }))
  })

  const rules = (doc && doc.rules) || []

  return React.createElement('div', { className: 'wst-root wst-settings' },
    React.createElement('div', { className: 'wst-sect' },
      t('title'),
      React.createElement('button', {
        className: 'wst-btn' + (doc && doc.enabled ? ' on' : ''),
        disabled: busy,
        onClick: () => send('toggle', {}),
      }, doc && doc.enabled ? t('disable') : t('enable')),
      React.createElement('button', { className: 'wst-btn', disabled: busy, onClick: () => { pull() } }, t('refresh')),
      React.createElement('button', {
        className: 'wst-btn',
        disabled: busy,
        onClick: () => { if (window.confirm(t('confirmReset'))) send('reset', {}) },
      }, t('reset'))),
    React.createElement('div', { className: 'wst-hint' }, t('hint')),
    err ? React.createElement('div', { className: 'wst-err' }, err) : null,
    msg ? React.createElement('div', { className: 'wst-ok' }, msg) : null,
    !state || state.hasSession === false
      ? React.createElement('div', { className: 'wst-empty' }, t('noSession'))
      : null,
    React.createElement('div', { className: 'wst-tabs' },
      tabs.map(([k, label]) => React.createElement('button', {
        key: k,
        className: 'wst-tab' + (tab === k ? ' active' : ''),
        onClick: () => setTab(k),
      }, label))),

    tab === 'presets' ? React.createElement('div', null,
      React.createElement('div', { className: 'wst-presets' }, presetCards),
      React.createElement('div', { className: 'wst-row', style: { marginTop: 10 } },
        React.createElement('button', {
          className: 'wst-btn',
          disabled: busy,
          onClick: () => {
            const id = window.prompt(t('saveNamePrompt'), '')
            if (!id) return
            send('save-preset', { id, name: id }).then((r) => { if (r) { flash(t('presetSaved')); pull() } })
          },
        }, t('saveAs')),
        React.createElement('button', {
          className: 'wst-btn',
          disabled: busy || !doc || !doc.preset || doc.preset === 'balanced',
          onClick: () => send('delete-preset', { id: doc.preset }).then(() => pull()),
        }, t('del')))) : null,

    tab === 'editor' ? editorForm : null,

    tab === 'dims' ? React.createElement('div', null,
      React.createElement('div', { className: 'wst-hint' }, t('scaleHint')),
      React.createElement('div', { className: 'wst-grid', style: { marginTop: 8 } }, dimFields)) : null,

    tab === 'words' ? React.createElement('div', null,
      React.createElement('div', { className: 'wst-field' },
        React.createElement('span', { className: 'wst-field-label' }, t('avoidLabel')),
        React.createElement('textarea', {
          className: 'wst-textarea',
          value: docVal('avoid', []).join('、'),
          disabled: busy,
          onChange: (e) => setDraft(Object.assign({}, draft, { avoid: e.target.value.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean) })),
          onBlur: () => commitText('avoid'),
        })),
      React.createElement('div', { className: 'wst-field', style: { marginTop: 8 } },
        React.createElement('span', { className: 'wst-field-label' }, t('preferLabel')),
        React.createElement('textarea', {
          className: 'wst-textarea',
          style: { minHeight: 46 },
          value: docVal('prefer', []).join('、'),
          disabled: busy,
          onChange: (e) => setDraft(Object.assign({}, draft, { prefer: e.target.value.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean) })),
          onBlur: () => commitText('prefer'),
        })),
      React.createElement('div', { className: 'wst-field', style: { marginTop: 8 } },
        React.createElement('span', { className: 'wst-field-label' }, t('directivesLabel')),
        React.createElement('textarea', {
          className: 'wst-textarea',
          value: docVal('directives', ''),
          disabled: busy,
          onChange: (e) => setDraft(Object.assign({}, draft, { directives: e.target.value })),
          onBlur: () => commitText('directives'),
        })),
      React.createElement('div', { className: 'wst-field', style: { marginTop: 8 } },
        React.createElement('span', { className: 'wst-field-label' }, t('sampleLabel')),
        React.createElement('textarea', {
          className: 'wst-textarea',
          style: { minHeight: 110 },
          value: docVal('sample', ''),
          disabled: busy,
          onChange: (e) => setDraft(Object.assign({}, draft, { sample: e.target.value })),
          onBlur: () => commitText('sample'),
        }))) : null,

    tab === 'rules' ? React.createElement('div', null,
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
          }, t('ruleAdd'))))) : null,

    tab === 'preview' ? React.createElement('div', null,
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
        }, t('refresh')))) : null)
}

// ---------------------------------------------------------------- 挂载

export function apply(ctx) {
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
    if (session && (typeof session === 'string' ? session : session.id)) {
      sessionId = typeof session === 'string' ? session : session.id
      try { localStorage.setItem('dsh-writing-style/session', sessionId) } catch { /* ignore */ }
    }
    return { React, t, rpc, useSession: ctx.slots && ctx.slots.useSession }
  }

  // 只在设置页注册。输入框上方的底栏按用户要求整块去掉：
  // 风格不是「每轮都要盯着调」的东西，写死在设置里、需要时用一句话改更顺手，
  // 也不占对话区的垂直空间。
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
}
