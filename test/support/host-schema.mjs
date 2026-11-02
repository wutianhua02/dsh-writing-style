// 宿主 output.schema 校验子集的**可执行副本**（供假宿主使用）。
//
// 为什么需要它：真机的 `tools.register()` 第一件事就是
//   assertSupportedJsonSchema(output.schema)
// 而在 2026-10-31 之前，本套件的假宿主把这个调用整个省略了 —— 于是
// `type: 'json'` 这种宿主要拒的形状在测试里 106 项全绿，真机却 4 个工具
// **一个都注册不上**（boot.log: tools-registered {"count":0}）。
// 这就是「绿灯不可信」的根源，所以必须把校验放进假宿主。
//
// 这里的规则是对 `@deepseek-ai/dsh-tools/lib/types/json-schema.js`
// 的逐条移植：允许的 type 只有 object/array/string/number/integer/boolean/null；
// 关键字只有 type/oneOf/properties/required/additionalProperties/items/enum/const
// （外加 description/title/default/examples 注解）；诊断文案也保持一致，
// 这样测试失败时能直接跟真机 boot.log 对上。
//
// 副本毕竟可能漂移，所以 test/host-schema.test.mjs 会在拿得到 app.asar 的机器上
// 用**真宿主的模块**跟这份副本逐条对账（见 loadRealHostValidator）。

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

export class JsonSchemaError extends Error {
  constructor(violations) {
    super('unsupported JSON schema: ' + violations.join('; '))
    this.name = 'JsonSchemaError'
    this.code = 'UNSUPPORTED_SCHEMA'
    this.violations = violations
  }
}

function isSchemaRecord(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isPlainArray(v) {
  return Array.isArray(v) && Reflect.ownKeys(v).length === v.length + 1
}

function isJsonNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)
}

function isJsonValue(v) {
  // 够用的 lossless JSON 判断（注解只用来放字符串/数字/布尔/数组/对象）
  try {
    if (v === null) return true
    const t = typeof v
    if (t === 'string' || t === 'boolean') return true
    if (t === 'number') return isJsonNumber(v)
    if (Array.isArray(v)) return v.every(isJsonValue)
    if (t === 'object') return isSchemaRecord(v) && Object.values(v).every(isJsonValue)
    return false
  } catch {
    return false
  }
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function checkObjectSchemaTail(node, path, properties, violations) {
  const hasRequired = Object.hasOwn(node, 'required')
  if (hasRequired) {
    const required = node.required
    if (!isPlainArray(required) || required.some((entry) => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of strings`)
    } else {
      const declared = isSchemaRecord(properties) ? properties : {}
      for (const key of required) {
        if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
}

function checkSchemaNode(root, rootPath, violations) {
  const seen = new Set()
  const tasks = [{ kind: 'enter', node: root, path: rootPath }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') { seen.delete(task.node); continue }
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`)
      }
      continue
    }
    if (task.kind === 'object-tail') {
      checkObjectSchemaTail(task.node, task.path, task.properties, violations)
      continue
    }
    const { node, path } = task
    if (!isSchemaRecord(node)) { violations.push(`${path} must be a schema object`); continue }
    if (seen.has(node)) { violations.push(`${path} is circular`); continue }
    seen.add(node)
    tasks.push({ kind: 'leave', node })
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        continue
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) { violations.push(`${path} cannot declare both type and oneOf`); continue }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      continue
    }
    if (hasOneOf) {
      const oneOf = node.oneOf
      tasks.push({ kind: 'one-of-tail', node, path })
      if (!isPlainArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (let index = oneOf.length - 1; index >= 0; index--) {
          tasks.push({ kind: 'enter', node: oneOf[index], path: `${path}.oneOf[${index}]` })
        }
      }
      continue
    }
    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      continue
    }
    const allowedFor = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(type)) {
        violations.push(`${path}.${key} is not supported on type "${type}"`)
      }
    }
    if (type === 'object') {
      const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
      tasks.push({ kind: 'object-tail', node, path, properties })
      if (Object.hasOwn(node, 'properties')) {
        if (!isSchemaRecord(properties)) {
          violations.push(`${path}.properties must be an object of schemas`)
        } else {
          const entries = Object.entries(properties)
          for (let index = entries.length - 1; index >= 0; index--) {
            tasks.push({ kind: 'enter', node: entries[index][1], path: `${path}.properties.${entries[index][0]}` })
          }
        }
      }
    } else if (type === 'array') {
      if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` })
    } else {
      const hasEnum = Object.hasOwn(node, 'enum')
      const allowed = hasEnum ? node.enum : undefined
      const enumValid = isPlainArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry))
      if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`)
      const hasConst = Object.hasOwn(node, 'const')
      if (hasConst) {
        if (!scalarMatches(type, node.const)) violations.push(`${path}.const must be a ${type} value`)
        else if (enumValid && !allowed.includes(node.const)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
      }
    }
  }
}

/** 收集违规项（不抛），供测试断言用。 */
export function hostSchemaViolations(schema, rootPath = 'schema') {
  const violations = []
  checkSchemaNode(schema, rootPath, violations)
  return violations
}

/** 与宿主 `tools.register()` 同一道闸：不合法就抛 JsonSchemaError。 */
export function assertSupportedJsonSchema(schema) {
  const violations = hostSchemaViolations(schema)
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

export function assertObjectJsonSchema(schema) {
  const violations = hostSchemaViolations(schema)
  if (violations.length === 0 && (!isSchemaRecord(schema) || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaError(violations)
}
