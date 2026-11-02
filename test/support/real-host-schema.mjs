// 从**真宿主的 app.asar**里把 output.schema 校验器原样取出来跑。
//
// 目的：不再用「我自己理解的宿主要求」当标准答案。宿主的
// `@deepseek-ai/dsh-tools/lib/types/json-schema.js` 是判定 schema 合不合法的
// 唯一权威（`tools.register()` 里第一行就调它），所以这里把那个文件从 asar
// 里按 asar header 的 offset 精确切出来，配两个桩模块后 import 执行。
//
// 找不到 asar（换机器 / 未安装桌面端）时返回 null，调用方应当跳过而不是失败。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_PATH = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'

/** 候选 asar 位置（可用 DSH_ASAR 覆盖）。 */
export function asarCandidates() {
  const out = []
  if (process.env.DSH_ASAR) out.push(process.env.DSH_ASAR)
  out.push('E:/dsh/resources/app.asar', 'E:\\dsh\\resources\\app.asar')
  // 从本文件往上找（<repo>/dsh-writing-style/test/support → 逐级向上）
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      out.push(path.join(dir, 'resources', 'app.asar'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* ignore */ }
  return out
}

function pickAsar() {
  for (const p of asarCandidates()) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* next */ }
  }
  return null
}

/** 读出 asar 里的文件表：path → {offset,size}。 */
export function readAsarIndex(asarFile) {
  const buf = fs.readFileSync(asarFile)
  const headerLen = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'))
  const base = 16 + headerLen
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name
      if (entry.files) walk(entry, p)
      else if (entry.offset !== undefined) files.set(p, { offset: base + Number(entry.offset), size: entry.size })
    }
  }
  walk(header, '')
  return { buf, files }
}

/**
 * 取出真宿主的校验器。
 * @returns {Promise<{assertSupportedJsonSchema: Function, assertObjectJsonSchema: Function, JsonSchemaError: Function, asar: string, moduleFile: string} | null>}
 */
export async function loadRealHostValidator() {
  const asar = pickAsar()
  if (!asar) return null
  let index
  try { index = readAsarIndex(asar) } catch { return null }
  const hit = index.files.get(MODULE_PATH)
  if (!hit) return null

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-schema-'))
  const target = path.join(dir, 'node_modules/@deepseek-ai/dsh-tools/lib/types/', path.basename(MODULE_PATH))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, index.buf.subarray(hit.offset, hit.offset + hit.size))

  // 桩：宿主只用到 HarnessError（错误基类）与两个 JSON 取值工具
  const stubs = {
    'dsh-llm': 'export class HarnessError extends Error { constructor(message, code) { super(message); this.code = code } }\n',
    'dsh-util-values': [
      'export function assertNever(value, what) { throw new Error("unexpected " + what + ": " + String(value)) }',
      'export function isJsonValue(value) {',
      '  try {',
      '    if (value === null) return true',
      '    const t = typeof value',
      '    if (t === "string" || t === "boolean") return true',
      '    if (t === "number") return Number.isFinite(value) && !Object.is(value, -0)',
      '    if (Array.isArray(value)) return value.every(isJsonValue)',
      '    if (t === "object") { const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) return false; return Object.values(value).every(isJsonValue) }',
      '    return false',
      '  } catch { return false }',
      '}',
    ].join('\n'),
  }
  for (const [name, body] of Object.entries(stubs)) {
    const pkgDir = path.join(dir, 'node_modules/@deepseek-ai', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.0.0-stub', type: 'module', main: './index.js', exports: './index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), body)
  }
  // 让 json-schema.js 自己的相对/裸 import 能解析（它只 import 上面两个包）
  fs.writeFileSync(path.join(dir, 'node_modules/@deepseek-ai/dsh-tools/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-extracted', type: 'module', main: './lib/index.js' }))

  const mod = await import(new URL('file://' + target.replace(/\\/g, '/')).href)
  return { ...mod, asar, moduleFile: target, dir }
}
