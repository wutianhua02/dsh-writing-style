// home 解析优先级：**实测证据（这个进程的 argv）必须排在「拿默认值猜一下」前面**。
//
// 2026-11-01 事故（RPG 插件先中，这里同源）：宿主升级成解包树之后
// `@deepseek-ai/dsh-home-paths` 变得可解析，它返回 homedir/.dsh；那个目录在用户机器上
// **真实存在**，于是 isDir 放行、把 argv 里的真实 home 顶掉 —— 预设静默写进另一个 home，
// 面板照常显示「已保存」，只有翻文件才能发现写错了地方。
//
// 这里用子进程钉住两件事：argv 赢过 homedir 猜测；显式覆盖赢过一切。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const node = process.execPath

/** 剥掉 DSH_* / ELECTRON_*（模拟桌面端 Launcher），只留调用方给的那几个。 */
function hostEnv(extra) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^DSH_/.test(k) || /^ELECTRON_/.test(k)) continue
    if (k === 'WRITING_STYLE_HOME' || k === 'DSH_WRITING_STYLE_HOME') continue
    env[k] = v
  }
  return Object.assign(env, extra || {})
}

/**
 * 在子进程里跑一次解析。必须用子进程：argv 得在 lib/ 被 import 之前成立，
 * 而且解析结果是模块级缓存，本进程里多个用例会互相污染。
 */
function resolve(argv, extraEnv) {
  const prelude = `process.argv = ${JSON.stringify(argv)};\n`
  const body = `
    const m = await import('./lib/index.js');
    process.stdout.write(JSON.stringify({ home: m.dshHome(), ...m.homeDiagnostics() }));
  `
  const r = spawnSync(node, ['--input-type=module', '-e', prelude + body], {
    cwd: root, env: hostEnv(extraEnv), encoding: 'utf8', timeout: 60000,
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

/** 实测形状的宿主 argv：真正带 home 的那一段是 `<base>/profiles/desktop`。 */
const hostArgv = (base) => [
  'E:\\dsh\\DeepSeek Harness.exe', '--expose-internals',
  'E:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  'E:\\dsh\\resources\\app.asar\\dsh',
  join(base, 'profiles', 'desktop'),
]

test('home：真实命令行赢过 homedir 的猜测（不许静默写到 ~/.dsh）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-ws-argv-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-ws-fakehome-'))
  try {
    // 让 homedir 一侧「有东西」：`~/.dsh` 真实存在，正是当年骗过 isDir 的那个条件
    mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
    const out = resolve(hostArgv(base), { HOME: fakeHome, USERPROFILE: fakeHome })
    assert.equal(out.home, base, 'argv 给的 home 必须赢')
    assert.equal(out.why, 'argv', '命中阶段必须是 argv')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('home：WRITING_STYLE_HOME 覆盖一切（排查和测试都靠它）', () => {
  const override = mkdtempSync(join(tmpdir(), 'dsh-ws-override-'))
  const base = mkdtempSync(join(tmpdir(), 'dsh-ws-argv2-'))
  try {
    const out = resolve(hostArgv(base), { WRITING_STYLE_HOME: override })
    assert.equal(out.home, override)
    assert.equal(out.why, 'override')
  } finally {
    rmSync(override, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})
