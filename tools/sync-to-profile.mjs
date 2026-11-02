#!/usr/bin/env node
// 把工作区里的插件同步到桌面端安装目录。
//
// ⚠️ 关键：安装目录里 vendor/ 和 node_modules/ 是**同一份文件的硬链接**
// （link count 2）。如果用「删掉再复制」的方式同步，硬链接就断了，
// 两个目录会各自留下不同版本 —— 宿主读 node_modules，你看到的却是
// vendor 里那份新代码，然后开始怀疑人生。
//
// 所以这里一律 **原地覆盖写入**（writeFileSync 截断已有文件，不换 inode），
// 硬链接关系保持不变；只有新文件才在两边建硬链接。
//
//   node tools/sync-to-profile.mjs            # 同步
//   node tools/sync-to-profile.mjs --check    # 只比对，不写
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const PROFILE = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop')
const VENDOR = join(PROFILE, 'vendor', 'dsh-writing-style')
const MODULES = join(PROFILE, 'node_modules', 'dsh-writing-style')

// 宿主真正加载的是 node_modules 那份；vendor 是它的硬链接搭档。
// test/ 不在 package.json 的 files 里，不同步。
const DIRS = ['lib', 'client']
const FILES = ['client.js', 'README.md', 'package.json', 'cordis.patch.yml']

function collect() {
  const out = FILES.map((f) => join(SRC, f)).filter((f) => existsSync(f))
  for (const d of DIRS) {
    const base = join(SRC, d)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) out.push(join(base, name))
  }
  return out.filter((f) => f !== join(SRC, 'client', 'build.mjs') || true)
}

const check = process.argv.includes('--check')
let changed = 0
for (const src of collect()) {
  const rel = relative(SRC, src)
  if (!rel) continue
  const content = readFileSync(src)
  for (const root of [VENDOR, MODULES]) {
    const dest = join(root, rel)
    const destDir = dirname(dest)
    if (!existsSync(destDir)) {
      console.log((check ? '[skip] ' : '[mkdir] ') + rel + '  (缺目录 ' + destDir + ')')
      if (!check) mkdirSync(destDir, { recursive: true })
      continue
    }
    if (!existsSync(dest)) {
      console.log((check ? '[new ] ' : '[add ] ') + rel + ' → ' + root.replace(PROFILE, ''))
      changed++
      if (!check) writeFileSync(dest, content)
      continue
    }
    if (readFileSync(dest).equals(content)) continue
    console.log((check ? '[diff] ' : '[writ] ') + rel + ' → ' + root.replace(PROFILE, ''))
    changed++
    // 截断写入，不换 inode —— 这正是保住硬链接的关键。
    if (!check) writeFileSync(dest, content)
  }
}

console.log(changed ? (check ? `有 ${changed} 处差异` : `已同步 ${changed} 处`) : '已是最新')
console.log('\n⚠️ lib/ 与 client.js 的改动要**重启桌面端**才生效（宿主在启动时加载插件）。')
