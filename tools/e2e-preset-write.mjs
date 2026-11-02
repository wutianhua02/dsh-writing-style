#!/usr/bin/env node
// 端到端：在「桌面端 Host 的形状」下真实写一次预设并读回来。
//
// 复现的是用户的报障：点「写入预设」→ 面板显示已保存 → 磁盘上还是空的。
// 根因是 Host 进程没有 DSH_HOME，presetFile() 返回 ''，写入静默返回 false。
// 这里刻意 **删掉所有 DSH_* 环境变量**，只留 argv 形态，看能不能真的落盘。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const child = `
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const HOME = mkdtempSync(join(tmpdir(), 'ws-e2e-'))
process.env.WRITING_STYLE_HOME = HOME
const mod = await import('./lib/index.js')
const routes = []
const services = {
  tools: { register: () => () => {} },
  sessionProjections: { register: () => () => {} },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  webServer: { register: (d) => { routes.push(d); return () => {} } },
  agents: { list: () => [], get: () => undefined },
}
mod.apply({
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
  get: (n) => services[n],
  inject: (_n, fn) => fn({ get: (n) => services[n], agent: null }),
}, {})

const call = (method, path, body) => new Promise((resolve) => {
  const req = { method, url: '/dsh-writing-style/' + path, headers: { host: '127.0.0.1:56080' },
    on(ev, fn) { if (ev === 'data') fn(Buffer.from(JSON.stringify(body || {}))); if (ev === 'end') fn() } }
  const res = { writeHead(c) { this.code = c }, end(p) { resolve({ code: this.code, body: JSON.parse(p) }) } }
  routes[0].handler(req, res)
})

const state = await call('GET', 'state')
console.log('storage =', JSON.stringify(state.body.storage))
const out = await call('POST', 'write-preset', {
  id: 'e2e-check', name: '端到端检查', dims: { sentence: 12, pov: 'first' }, sample: '测试范文。',
})
console.log('write code =', out.code, 'ok =', out.body.ok, 'storedDims =', JSON.stringify(out.body.storedDims))
console.log('note =', JSON.stringify(out.body.note || ''))
console.log('error =', JSON.stringify(out.body.error || ''))
const file = state.body.storage.file
console.log('existsSync =', existsSync(file))
if (existsSync(file)) console.log('disk =', readFileSync(file, 'utf8'))
const del = await call('POST', 'delete-preset', { id: 'e2e-check' })
console.log('delete code =', del.code, 'ok =', del.body.ok)
`

const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('DSH_')) delete env[k]
delete env.WRITING_STYLE_HOME

const c = spawn(process.execPath, ['--input-type=module', '-e', child], {
  stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)), env,
})
c.on('exit', (code) => process.exit(code ?? 1))
