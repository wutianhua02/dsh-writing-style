#!/usr/bin/env node
// 诊断：在当前进程里，写作风格插件会把「预设文件」解析到哪里，依据是什么。
//
// 为什么要单独一个工具：桌面端 rc.5 之后 Host 进程**没有** DSH_HOME
// （launcher 把 DSH_ 前缀剥掉了），预设存不上就是静默失败 —— 面板显示
// 「已保存」，磁盘上还是空的。光看代码猜不出来，必须问真实进程。
//
//   node tools/dsh-home-probe.mjs                 # 看当前解析结果
//   node tools/dsh-home-probe.mjs --sim-host      # 假装自己是桌面端 Host（argv 带 profiles 路径）
//   node tools/dsh-home-probe.mjs --no-env        # 先把 DSH_HOME 从环境里删掉再解析
import process from 'node:process'

const argv = process.argv.slice(2)

if (argv.includes('--no-env')) {
  for (const k of ['DSH_HOME', 'DSH_ROOT', 'DSH_DATA_HOME', 'WRITING_STYLE_HOME', 'DSH_WRITING_STYLE_HOME']) {
    delete process.env[k]
  }
}

if (argv.includes('--sim-host')) {
  // 复刻桌面端 Host 的真实命令行形态：第三个参数是 profile 目录。
  // 解析器不依赖 env，就是靠这一段认出 home 的。
  const home = process.env.USERPROFILE || process.env.HOME || '~'
  process.argv.push(
    'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
    'E:/dsh/resources/app.asar/dsh',
    home + '/.dsh/profiles/desktop',
    'E:/dsh/resources/runtime/primary-runtime',
  )
}

const mod = await import('../lib/index.js')
const info = typeof mod.storageInfo === 'function' ? mod.storageInfo() : null

if (!info) {
  console.log('lib/index.js 没有导出 storageInfo —— 请通过面板的 GET state 查看 storage 字段')
  process.exit(1)
}

console.log(JSON.stringify({
  'env 里有 DSH_HOME': !!process.env.DSH_HOME,
  解析到的home: info.home,
  依据: info.homeFrom,
  预设文件: info.file,
  可写: info.writable,
  错误: info.error || '',
  pid: info.pid,
}, null, 2))
