// dsh-writing-style 客户端打包：client/index.jsx → ../client.js
//
// 产物格式固定为 DSH 客户端模块：window.__ModuleLoader__.load({ id, factory })。
// react / react-dom 由宿主以模块形式提供（require("react")），绝不能打进 bundle。
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

let src = await readFile(resolve(here, 'index.jsx'), 'utf8')
src = src.replace(/^export const /gm, 'const ')
src = src.replace(/^export function /gm, 'function ')

const out = `window.__ModuleLoader__.load({
  id: "dsh-writing-style",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${src}
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 测试缝：并发契约只能从 RPC 层验（组件只看得到结果，看不到「这次请求到底发没发」）。
    exports.__rpcForTest = __rpcForTest;
    return module.exports;
  }
});
`

await writeFile(resolve(pkgRoot, 'client.js'), out, 'utf8')
console.log('wrote client.js', out.length, 'bytes')
