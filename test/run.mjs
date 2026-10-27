// 一把跑完所有套件。
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()

const child = spawn(process.execPath, ['--test', ...files.map((f) => resolve(here, f))], {
  stdio: 'inherit',
  cwd: resolve(here, '..'),
})
child.on('exit', (code) => process.exit(code ?? 1))
