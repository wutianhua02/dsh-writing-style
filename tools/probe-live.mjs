#!/usr/bin/env node
// 直接问**运行中的宿主**：面板该拿到的数据到底有没有？线上跑的 bundle 是不是磁盘这份？
//
// 为什么需要它：2026-11-01「预设页签一片空白」那次，单元测试全绿、boot.log 全正常，
// 光看代码根本分不清是「服务端没数据」还是「前端没拿到」。这个工具把三件事一次问清：
//   ① 路由本身：GET /dsh-writing-style/state 与 /presets 的状态码、预设条数、storage
//   ② 线上 bundle：页面实际加载的那份是否逐字等于磁盘上的 client.js
//   ③ 会话无关性：带各种 session（不存在的、空串、旧会话）时会不会 404/500
//
// 鉴权：宿主用一张按 `sha256(Host)` 命名、HMAC 签名的 cookie 把外行挡住（401）。
// 它把签名密钥存在 `<home>/.credentials.yaml` 的 `client-connection/browser-session` 里，
// 所以本工具**只读**那个文件、在本地签一张票 —— 不需要借用浏览器，也不碰任何 cookie 数据库。
//
// 用法：
//   node tools/probe-live.mjs                 # 自动找 GUI 端口（从 ~/.dsh 里最近的心跳/端口推断不出来时用参数）
//   node tools/probe-live.mjs 127.0.0.1:64446
//   node tools/probe-live.mjs --no-bundle     # 只看接口，不拉 8MB 的组合 bundle
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import process from 'node:process'

const args = process.argv.slice(2)
const withBundle = !args.includes('--no-bundle')
const hostArg = args.find((a) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a) || /^[\w.-]+:\d+$/.test(a))

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
const CRED = join(HOME, '.credentials.yaml')

function loadSecret() {
  if (!existsSync(CRED)) return null
  const yaml = readFileSync(CRED, 'utf8')
  const m = /browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/.exec(yaml)
  if (!m) return null
  return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** 造一张宿主认的 cookie（格式见 app.asar 里 dsh-client-connection 的 encodeCookie）。 */
function mintCookie(secret, host) {
  const now = Date.now()
  const payload = { version: 1, authority: host, issuedAt: now, expiresAt: now + 3600_000 }
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64u(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(host).digest())
  return `${name}=v1.${body}.${sig}`
}

/** 没给端口时，试着从 index 探测常见端口范围也不现实：直接让用户给。 */
async function guessHost() {
  // 桌面包会把 GUI URL 打在进程参数/日志里，但外行读不到；退而求其次问一遍常见端口。
  for (const port of [64446, 63983, 62517, 3080, 3000, 8080]) {
    const host = `127.0.0.1:${port}`
    try {
      const res = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(800) })
      if (res.status === 401 || res.status === 200) return host
    } catch { /* 下一个 */ }
  }
  return null
}

async function main() {
  const secret = loadSecret()
  if (!secret) {
    console.error(`找不到 ${CRED} 里的 browser-session secret —— 桌面端还没跑过？`)
    process.exit(1)
  }
  const host = hostArg || await guessHost()
  if (!host) {
    console.error('猜不到 GUI 端口：请显式传一个，例如 `node tools/probe-live.mjs 127.0.0.1:64446`')
    process.exit(1)
  }
  const cookie = mintCookie(secret, host)
  const req = async (path, init) => {
    const body = init && init.body
    const res = await fetch(`http://${host}${path}`, {
      ...(init || {}),
      headers: { cookie, host, ...(body ? { 'content-type': 'application/json' } : {}) },
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  const get = (path) => req(path)
  const post = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body || {}) })

  console.log(`目标：http://${host}`)

  // ---------- ① 路由 ----------
  const state = await get('/dsh-writing-style/state')
  if (state.json) {
    const p = state.json.presets
    console.log(`\nGET /dsh-writing-style/state → ${state.status}`)
    console.log(`  预设：${Array.isArray(p) ? p.length : '(不是数组)'} 条 ｜ ${(p || []).map((x) => x.id).join(', ')}`)
    console.log(`  doc.enabled=${state.json.doc && state.json.doc.enabled} ｜ preset=${state.json.doc && state.json.doc.preset} ｜ hasSession=${state.json.hasSession}`)
    console.log(`  storage=${JSON.stringify(state.json.storage)}`)
    // 2026-11-02 的教训：内置预设卡缺 prefer/sample 时，面板「更改」拿到的五项是
    // undefined；JSON 又把 undefined 键整个丢掉，只有逐张点数才看得出来。
    const fields = ['dims', 'directives', 'avoid', 'prefer', 'sample']
    const missing = (p || []).filter((x) => fields.some((f) => !(f in x)))
    console.log(`  卡片五字段：${missing.length ? `✖ ${missing.length} 张缺（${missing.slice(0, 3).map((x) => x.id).join(', ')}…）` : '✔ 全部齐备（dims/directives/avoid/prefer/sample）'}`)
  } else {
    console.log(`\nGET /state → ${state.status}（非 JSON）：${state.text.slice(0, 160)}`)
  }
  const presets = await get('/dsh-writing-style/presets')
  console.log(`GET /dsh-writing-style/presets → ${presets.status}` + (presets.json ? ` ｜ ${(presets.json.presets || []).length} 条` : ''))

  // ---------- ④ preview 契约（2026-11-02 起是产品路径：编辑器「预览注入效果」） ----------
  // 只读：POST 一个带标记的草稿 doc，断言 200 且 directive 里能看到这些标记，
  // 再比对会话文档没被改（不同只告警 —— 用户可能同时在打字，不能当成失败）。
  const draft = {
    doc: {
      enabled: true,
      preset: 'probe-draft',
      presetName: '探针草稿',
      dims: { sentence: 15 },
      directives: '【探针附加要求】',
      avoid: ['探针禁用词'],
      prefer: ['探针偏好词'],
      sample: '探针范文句。',
      rules: [],
    },
  }
  const beforeDoc = state.json ? JSON.stringify(state.json.doc) : ''
  const prev = await post('/dsh-writing-style/preview', draft)
  if (prev.json && typeof prev.json.directive === 'string') {
    const marks = ['【探针附加要求】', '探针禁用词', '探针偏好词', '探针范文句']
    const hits = marks.map((m) => [m, prev.json.directive.includes(m)])
    const ok = prev.status === 200 && hits.every(([, v]) => v)
    console.log(`\nPOST /preview（草稿 doc）→ ${prev.status}  ${ok ? '✔ 注入正文按草稿渲染' : '✖ 草稿没进注入正文'}`)
    console.log('  ' + hits.map(([m, v]) => `${m}:${v ? '在' : '不在'}`).join(' ｜ '))
  } else {
    console.log(`\nPOST /preview → ${prev.status}（非预期返回）：${prev.text.slice(0, 160)}`)
  }
  const after = await get('/dsh-writing-style/state')
  if (beforeDoc && JSON.stringify(after.json && after.json.doc) !== beforeDoc) {
    console.log('  ⚠️ /state 的 doc 在 preview 前后不同（可能只是你同时在操作，不代表 preview 写了盘）')
  }

  // ---------- ③ 会话无关性 ----------
  for (const sid of ['', 'session-does-not-exist', 'undefined']) {
    const q = sid ? `?session=${encodeURIComponent(sid)}` : ''
    const r = await get('/dsh-writing-style/state' + q)
    console.log(`  session=${JSON.stringify(sid).padEnd(28)} → ${r.status}` + (r.json ? ` ｜ presets=${(r.json.presets || []).length}` : ''))
  }

  // ---------- ② 线上 bundle 是否为磁盘那份 ----------
  if (!withBundle) return
  const idx = await get('/')
  if (idx.status !== 200) { console.log(`\nGET / → ${idx.status}（拿不到 index，跳过 bundle 比对）`); return }
  const href = [...idx.text.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .find((u) => u.includes('dsh-writing-style/client.js'))
  if (!href) { console.log('\nindex 里没有 dsh-writing-style 的 bundle —— 插件没被挂进客户端图？'); return }

  const bundle = await get('/' + href.replace(/&amp;/g, '&'))
  const diskPath = join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-writing-style', 'client.js')
  const disk = existsSync(diskPath) ? readFileSync(diskPath, 'utf8') : null
  console.log(`\n线上组合 bundle → ${bundle.status}（${bundle.text.length} 字符）`)
  if (!disk) {
    console.log(`  磁盘上没有 ${diskPath} —— 跳过比对`)
    return
  }
  const same = bundle.text.includes(disk.slice(0, 400))
  console.log(`  磁盘 client.js（${disk.length} 字符）${same ? '原样出现在线上 ✔' : '与线上不同 ✖ —— 刷新页面看是否更新，或检查 sync'}`)
  for (const marker of ['正在连接宿主', 'tries > 8', 'dsh-writing-style/state']) {
    console.log(`  标记 ${marker}：${bundle.text.includes(marker) ? '在' : '不在'}`)
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
