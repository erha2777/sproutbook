/**
 * 工具启动器（仅用于本地验证 / CI 的便捷调用，不参与应用运行）。
 *
 * 背景：pnpm 在 Windows 上用 junction 链接顶层 node_modules 条目。直接执行
 * node_modules/<pkg>/bin/xxx.js 时，ESM 解析会停留在 junction 路径上，
 * 找不到该包自己的依赖（ERR_MODULE_NOT_FOUND）。
 *
 * 这里改为：先读顶层包的版本号，再据此定位 node_modules/.pnpm/<pkg>@<版本>*
 * 的真实目录，然后从真实路径导入 CLI —— 依赖就能正常解析了。
 *
 * 用法：node scripts/tool.mjs <包名> <参数...>
 * 例如：node scripts/tool.mjs electron-vite build
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [pkg, ...rest] = process.argv.slice(2)
if (!pkg) {
  console.error('用法：node scripts/tool.mjs <包名> <参数...>')
  process.exit(2)
}

const linkDir = resolve('node_modules', pkg)
if (!existsSync(linkDir)) {
  console.error(`找不到包：${pkg}（请先安装依赖）`)
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(join(linkDir, 'package.json'), 'utf-8'))
const version = manifest.version

// pnpm 的目录名：@scope/name → @scope+name；带 peer 依赖时会附加 _<hash> 后缀
const prefix = pkg.startsWith('@') ? pkg.replace('/', '+') : pkg
const pnpmRoot = resolve('node_modules', '.pnpm')

let realPkgDir = linkDir
if (existsSync(pnpmRoot)) {
  const candidates = readdirSync(pnpmRoot).filter((name) => name.startsWith(`${prefix}@${version}`))
  const hit = candidates.find((name) => existsSync(join(pnpmRoot, name, 'node_modules', pkg, 'package.json')))
  if (hit) realPkgDir = join(pnpmRoot, hit, 'node_modules', pkg)
}

const binField = manifest.bin
const binRel =
  typeof binField === 'string' ? binField : (binField?.[pkg] ?? (binField ? Object.values(binField)[0] : undefined))

if (!binRel) {
  console.error(`包 ${pkg} 没有可执行的 bin 入口`)
  process.exit(2)
}

const binPath = join(realPkgDir, binRel)
if (!existsSync(binPath)) {
  console.error(`CLI 入口不存在：${binPath}`)
  process.exit(2)
}

process.argv = [process.argv[0], binPath, ...rest]
await import(pathToFileURL(binPath).href)
