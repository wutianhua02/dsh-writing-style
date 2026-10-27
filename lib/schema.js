// dsh-writing-style —— 投影 schema（zod 兼容最小实现）
//
// 为什么手写：DSH 的 session-projection 注册表把 `stateSchema` / `viewSchema`
// 当 zod schema 用，冷读历史时直接 `.parse()`，那几处不在 try/catch 里。
// 没有 `.parse` 的纯 JSON Schema 会让**任何已有会话**抛
// `wire.viewSchema.parse is not a function` —— 表现就是「历史加载失败」。
// 这里只实现投影真正用到的 parse / safeParse / is。

export function makeSchema(check, label) {
  const assert = (value) => {
    const problem = check(value)
    if (problem !== null) throw new Error(`writing-style: invalid ${label}: ${problem}`)
    return value
  }
  return {
    parse: assert,
    safeParse(value) {
      try { return { success: true, data: assert(value) } } catch (error) { return { success: false, error } }
    },
    is(value) { return check(value) === null },
    toString() { return `[writing-style ${label} schema]` }
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 信封校验：本插件写进会话日志的载荷形状。null 表示「还没有存档」。 */
export function checkEnvelope(value) {
  if (value === null) return null
  if (!isObj(value)) return 'expected null or an object'
  const doc = value.doc
  if (!isObj(doc)) return 'doc must be an object'
  if (doc.dims !== undefined && !isObj(doc.dims)) return 'doc.dims must be an object'
  for (const key of ['rules', 'avoid', 'prefer']) {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) return `doc.${key} must be an array`
  }
  if (value.turn !== undefined && value.turn !== null && !Number.isFinite(Number(value.turn))) return 'turn must be a number or null'
  if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string') return 'updatedAt must be a string'
  if (value.ev !== undefined && value.ev !== null && !Number.isFinite(Number(value.ev))) return 'ev must be a number'
  return null
}

export const stateSchema = makeSchema(checkEnvelope, 'state')
export const viewSchema = makeSchema(checkEnvelope, 'wire')
