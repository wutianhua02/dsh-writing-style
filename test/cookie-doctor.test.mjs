// dsh-cookie-doctor 的测试。
//
// 背景：这不是本插件的 bug，而是 DSH 桌面端的设计缺陷 ——
// 每次启动都在 127.0.0.1 上新增一条 `dsh-auth-<hash(host:port)>` cookie，
// 浏览器 cookie 不按端口隔离，约 70 条后 Cookie 头超过 16 KB，
// Host 返回 HTTP 431，客户端误报成 `desktop welcome: Web authentication failed`。
//
// 这个工具的价值在于：诊断数字必须准（用户要能判断"是不是快爆了"），
// 清理必须只动 dsh-auth-* 且能备份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const TOOL = join(here, '..', 'tools', 'dsh-cookie-doctor.mjs')

/** 造一个带 cookies 表的 SQLite 库。 */
async function makeCookieDb(file, rows) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT,
    path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
    last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER,
    priority INTEGER, encrypted_value BLOB, samesite INTEGER,
    source_scheme INTEGER, source_port INTEGER, last_update_utc INTEGER
  )`)
  const stmt = db.prepare(`INSERT INTO cookies
    (host_key, name, value, path, expires_utc, is_secure, is_httponly, last_access_utc,
     has_expires, is_persistent, priority, encrypted_value, samesite, source_scheme, source_port, last_update_utc)
    VALUES (?,?,?,?,0,0,0,0,0,0,1,X'00',0,1,-1,0)`)
  for (const r of rows) stmt.run(r.host_key, r.name, r.value || '', '/')
  db.close()
}

async function countAuth(file) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  const n = db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%'").get().n
  const total = db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n
  db.close()
  return { auth: n, total }
}

function runTool(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout || '') + String(err.stderr || '') }
  }
}

/** 造一个「71 条 dsh-auth + 几条无关 cookie」的真实形状库。 */
async function makeFullFixture(dir) {
  const net = join(dir, 'Network')
  mkdirSync(net, { recursive: true })
  const file = join(net, 'Cookies')
  const rows = []
  for (let i = 0; i < 71; i++) {
    rows.push({
      host_key: '127.0.0.1',
      // 名字里带随机端口哈希，模拟真实形态；value 约 180 字节
      name: 'dsh-auth-' + ('PORT' + i).padEnd(43, 'x').slice(0, 43),
      value: 'v1.' + 'A'.repeat(176),
    })
  }
  // 无关 cookie：清理时必须保留
  rows.push({ host_key: '127.0.0.1', name: 'other-local', value: 'keep-me' })
  rows.push({ host_key: '.example.com', name: 'dsh-auth-should-not-touch', value: 'x' })
  rows.push({ host_key: '.deepseek.com', name: 'session', value: 'abc' })
  await makeCookieDb(file, rows)
  return { net, file }
}

test('诊断：71 条时判定为接近上限（对应真实事故的 99%）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net } = await makeFullFixture(dir)
    const { out } = runTool(['check', '--dir', net])
    assert.match(out, /71 条/)
    assert.match(out, /接近上限|已经超限/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('诊断：0 条时判定为干净', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const net = join(dir, 'Network')
    mkdirSync(net, { recursive: true })
    const file = join(net, 'Cookies')
    await makeCookieDb(file, [{ host_key: '.example.com', name: 'x', value: 'y' }])
    const { out } = runTool(['check', '--dir', net])
    assert.match(out, /0 条/)
    assert.match(out, /干净/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--dry-run 不修改文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net, file } = await makeFullFixture(dir)
    const before = await countAuth(file)
    const { out } = runTool(['clean', '--dir', net, '--force', '--dry-run'])
    assert.match(out, /未做任何修改/)
    const after = await countAuth(file)
    assert.deepEqual(after, before, 'dry-run 竟然改了数据')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('clean 只删 dsh-auth-*，其它 cookie 一条不少', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net, file } = await makeFullFixture(dir)
    const before = await countAuth(file)
    assert.equal(before.auth, 71)

    const { out } = runTool(['clean', '--dir', net, '--force'])
    assert.match(out, /清理完成/)

    const after = await countAuth(file)
    assert.equal(after.auth, 0, 'dsh-auth-* 应当清零')
    assert.equal(after.total, 3, '无关 cookie 必须保留：实际剩 ' + after.total)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('clean 会自动备份（改坏了能还原）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net } = await makeFullFixture(dir)
    runTool(['clean', '--dir', net, '--force'])
    const files = readdirSync(net)
    assert.ok(files.some((f) => f.startsWith('Cookies.bak-')), '没有生成备份：' + files.join(', '))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--keep-latest 至少保留 1 条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net, file } = await makeFullFixture(dir)
    runTool(['clean', '--dir', net, '--force', '--keep-latest'])
    const after = await countAuth(file)
    assert.equal(after.auth, 1, '应保留 1 条，实际 ' + after.auth)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('清理后诊断显示干净', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'))
  try {
    const { net } = await makeFullFixture(dir)
    runTool(['clean', '--dir', net, '--force'])
    const { out } = runTool(['check', '--dir', net])
    assert.match(out, /0 条/)
    assert.match(out, /干净/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('不存在的目录给出明确错误，而不是静默成功', async () => {
  const { code, out } = runTool(['check', '--dir', join(tmpdir(), 'definitely-not-here-xyz')])
  assert.notEqual(code, 0)
  assert.match(out, /找不到/)
})

test('--help 说明背景与用法', () => {
  const { out } = runTool(['--help'])
  assert.match(out, /dsh-auth/)
  assert.match(out, /431|16 KB/)
})
