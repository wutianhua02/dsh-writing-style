// dsh-cookie-doctor —— 诊断 / 清理 DeepSeek Harness 桌面端的 dsh-auth-* cookie 累积
//
// 为什么需要它：
//   桌面端每次启动都会在 127.0.0.1 上留下一条 `dsh-auth-<hash(host:port)>` cookie。
//   浏览器 cookie **不按端口隔离**，所以每次启动是「新增」而不是「覆盖」。
//   攒到约 70 条时 Cookie 请求头超过 Node 默认的 16 KB，Host 返回 HTTP 431，
//   客户端把 431 误报成 `desktop welcome: Web authentication failed` —— 应用直接起不来。
//   而 Chromium 单 host 上限是 180 条，到那时头部约 38 KB，会永久无法启动。
//
// 用法：
//   node dsh-cookie-doctor.mjs check     # 只诊断，不修改（默认）
//   node dsh-cookie-doctor.mjs clean     # 关闭应用后清理
//   node dsh-cookie-doctor.mjs clean --dry-run
//
// 安全约束：
//   · 只动 host_key = '127.0.0.1' / 'localhost' 且 name 以 dsh-auth- 开头的行
//   · 其余 cookie、以及 Cookies 文件的其它表一律不碰
//   · 清理前自动备份；应用正在运行时拒绝操作（否则会写坏 Chromium 的库）
//   · 用 SQLite 原生能力读写，不做二进制补丁

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------- 路径

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const CANDIDATE_DIRS = [
  path.join(APPDATA, '@deepseek-ai', 'dsh-desktop'),
  path.join(APPDATA, 'dsh-desktop'),
  path.join(APPDATA, 'DeepSeek Harness'),
]

function findNetworkDir(explicit) {
  if (explicit) return explicit
  for (const base of CANDIDATE_DIRS) {
    const net = path.join(base, 'Network')
    if (fs.existsSync(path.join(net, 'Cookies'))) return net
  }
  return null
}

/** 阈值：Node 默认 max-http-header-size 是 16384，留出其它请求头的余量。 */
const HEADER_LIMIT = 16384
const WARN_COUNT = 50
const SAFE_COUNT = 30

// ---------------------------------------------------------------- 应用状态

/** 应用是否在运行（Cookies 被独占打开时也说明在运行）。 */
function appRunning(netDir) {
  const lockFile = path.join(netDir, 'Cookies')
  try {
    const fd = fs.openSync(lockFile, 'r+')
    fs.closeSync(fd)
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) return true
  }
  // Windows 上再兜一层：按进程名查
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (/DeepSeek Harness\.exe/i.test(out)) return true
    } catch { /* tasklist 不可用就算了 */ }
  }
  return false
}

// ---------------------------------------------------------------- SQLite

/**
 * 用 Node 内置的 node:sqlite（Node 22+）读库；没有就退到 sqlite3 命令行。
 * 两者都不可用时给出明确提示，而不是假装成功。
 *
 * 注意：库被正在运行的应用独占时，SQLite 会报 "unable to open database file"，
 * 这**不是**"文件不存在"，而是"被锁"。必须区分开，否则用户会以为路径写错了。
 */
async function openDb(file, { readOnly = false } = {}) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    let db
    try {
      db = readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file)
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (/unable to open database file/i.test(msg)) {
        throw new Error(
          'cookie 库被占用（DeepSeek Harness 正在运行）。\n' +
          '请先完全退出应用（含托盘图标）再试。',
        )
      }
      throw err
    }
    return {
      kind: 'node:sqlite',
      all(sql, ...params) {
        const stmt = db.prepare(sql)
        return stmt.all(...params)
      },
      run(sql, ...params) {
        const stmt = db.prepare(sql)
        return stmt.run(...params)
      },
      exec(sql) { db.exec(sql) },
      close() { try { db.close() } catch { /* ignore */ } },
    }
  } catch (err) {
    // 被锁的提示要原样抛出去，不要被下面的"退路"逻辑吞掉
    if (/被占用/.test(String((err && err.message) || err))) throw err
  }

  // 退路：sqlite3.exe（如果用户装了）
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore', windowsHide: true })
  } catch {
    throw new Error(
      '需要 Node 22+ 内置的 node:sqlite，或系统里有 sqlite3 命令行。\n' +
      '当前 Node 版本：' + process.version,
    )
  }
  const q = (sql) => execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8', windowsHide: true })
  return {
    kind: 'sqlite3',
    all(sql) { const out = q(sql).trim(); return out ? JSON.parse(out) : [] },
    run(sql) { q(sql) },
    close() {},
  }
}

// ---------------------------------------------------------------- 统计

const AUTH_WHERE = "(host_key = '127.0.0.1' OR host_key = 'localhost') AND name LIKE 'dsh-auth-%'"

function report(rows, file) {
  const count = rows.length
  const nameBytes = rows.reduce((a, r) => a + String(r.name || '').length, 0)
  // Cookie 头里每条是 "name=value; "，value 约 180 字节
  const estHeader = rows.reduce((a, r) => a + String(r.name || '').length + 1 + String(r.value || '').length + 2, 0)

  console.log('')
  console.log('  文件        ' + file)
  console.log('  dsh-auth-*  ' + count + ' 条（name 合计 ' + nameBytes + ' 字节）')
  console.log('  估算头部    ' + estHeader + ' 字节 / 上限 ' + HEADER_LIMIT + ' 字节'
    + '（' + Math.round((estHeader / HEADER_LIMIT) * 100) + '%）')
  console.log('')

  if (count === 0) {
    console.log('  ✓ 干净，没有累积。')
    return { count, level: 'ok' }
  }
  if (estHeader > HEADER_LIMIT) {
    console.log('  ✗ 已经超限 —— 启动会报 "Web authentication failed"（实为 HTTP 431）。')
    console.log('    执行：node dsh-cookie-doctor.mjs clean')
    return { count, level: 'critical' }
  }
  if (count >= WARN_COUNT) {
    console.log('  ⚠ 接近上限（约 ' + Math.round(HEADER_LIMIT / (estHeader / count)) + ' 条时溢出）。')
    console.log('    建议清理：node dsh-cookie-doctor.mjs clean')
    return { count, level: 'warn' }
  }
  console.log('  ✓ 正常（安全线 ' + SAFE_COUNT + ' 条以内）。')
  return { count, level: 'ok' }
}

// ---------------------------------------------------------------- 清理

async function clean(netDir, opts) {
  const file = path.join(netDir, 'Cookies')

  // 保护：应用在跑时改库会写坏 Chromium 的 SQLite。
  // 但「进程名匹配」在离线测试/多实例场景会误判，所以允许 --force 显式跳过。
  if (!opts.force && appRunning(netDir)) {
    console.error('')
    console.error('  ✗ DeepSeek Harness 正在运行，不能改 cookie 库。')
    console.error('    请先完全退出（含托盘图标），再运行一次。')
    console.error('    （确实确认没运行、只是被误判时，可加 --force）')
    console.error('')
    process.exitCode = 2
    return
  }

  const db = await openDb(file)
  try {
    const rows = db.all(`SELECT name, value FROM cookies WHERE ${AUTH_WHERE}`)
    const before = report(rows, file)
    if (before.count === 0) { db.close(); return }

    // 保留最近的一条（当前进程可能正需要它），其余删掉。
    // 保守起见：全删也不会坏 —— 下次启动会重新种一条 —— 但保留一条更平滑。
    const keep = opts.keepLatest ? rows.slice(0, 1).map((r) => r.name) : []
    const keepSet = new Set(keep)
    const toDelete = rows.filter((r) => !keepSet.has(r.name))

    console.log('  将删除 ' + toDelete.length + ' 条' + (keep.length ? '（保留最新 1 条）' : '') + '。')

    if (opts.dryRun) {
      console.log('  --dry-run：未做任何修改。')
      return
    }

    // 备份
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = file + '.bak-' + stamp
    fs.copyFileSync(file, backup)
    console.log('  已备份 → ' + backup)

    // 删除
    if (opts.keepLatest && keep.length) {
      db.run(`DELETE FROM cookies WHERE ${AUTH_WHERE} AND name NOT IN (${keep.map(() => '?').join(',')})`, ...keep)
    } else {
      db.run(`DELETE FROM cookies WHERE ${AUTH_WHERE}`)
    }

    // VACUUM 让文件真正缩小（否则删了行文件还是那么大，虽然不影响功能）
    try { db.exec('VACUUM') } catch { /* 非致命 */ }

    const after = db.all(`SELECT name, value FROM cookies WHERE ${AUTH_WHERE}`)
    console.log('')
    console.log('  ✓ 清理完成，剩余 ' + after.length + ' 条。')
    console.log('    现在可以正常启动 DeepSeek Harness。')
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log(`
dsh-cookie-doctor —— 诊断/清理 DSH 桌面端累积的 dsh-auth-* cookie

  node dsh-cookie-doctor.mjs [check|clean] [选项]

  check               只诊断（默认）
  clean               清理（需要先完全退出应用）
    --dry-run         只看会删多少，不真删
    --keep-latest     保留最近 1 条（更平滑，推荐）
    --force           跳过"应用正在运行"检查（确认没运行却误判时用）
    --dir <路径>      手动指定 Network 目录
    --json            输出机器可读结果

背景：桌面端每次启动都在 127.0.0.1 上新增一条 dsh-auth-* cookie（名字含随机端口，
浏览器 cookie 不按端口隔离），约 70 条后请求头超过 16 KB，Host 返回 HTTP 431，
应用报 "desktop welcome: Web authentication failed" 起不来。
`)
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'check'
  const has = (f) => argv.includes(f)
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

  if (has('-h') || has('--help')) { usage(); return }

  const netDir = findNetworkDir(val('--dir'))
  if (!netDir) {
    console.error('找不到 DSH 桌面端的 Network 目录。试过：')
    for (const b of CANDIDATE_DIRS) console.error('  ' + path.join(b, 'Network'))
    console.error('用 --dir 手动指定。')
    process.exitCode = 1
    return
  }

  const file = path.join(netDir, 'Cookies')
  if (!fs.existsSync(file)) {
    console.error('找不到 cookie 库：' + file)
    process.exitCode = 1
    return
  }

  if (cmd === 'clean') {
    await clean(netDir, {
      dryRun: has('--dry-run'),
      keepLatest: has('--keep-latest'),
      force: has('--force'),
    })
    return
  }

  // check
  const running = appRunning(netDir)
  let rows
  let db
  try {
    db = await openDb(file, { readOnly: true })
    rows = db.all(`SELECT name, value FROM cookies WHERE ${AUTH_WHERE}`)
  } catch (err) {
    // 被占用：应用正在运行。这是最常见的情况，给出可执行提示而不是报错退出。
    const msg = String((err && err.message) || err)
    if (/被占用/.test(msg)) {
      console.error('')
      console.error('  DeepSeek Harness 正在运行，cookie 库被独占，读不了。')
      console.error('  这是正常现象 —— 能启动说明 cookie 还没爆。')
      console.error('  想检查/清理请先完全退出应用（含托盘图标）。')
      console.error('')
      if (has('--json')) console.log(JSON.stringify({ file, running: true, readable: false }))
      return
    }
    throw err
  } finally {
    if (db) db.close()
  }
  const res = report(rows, file)
  if (running) console.log('  （应用正在运行，清理前需要先退出）')

  if (has('--json')) {
    console.log(JSON.stringify({ file, count: res.count, level: res.level, running }, null, 2))
  }
  if (res.level === 'critical') process.exitCode = 3
}

main().catch((err) => {
  console.error('出错：' + String((err && err.message) || err))
  process.exitCode = 1
})
