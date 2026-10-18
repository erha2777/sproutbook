/**
 * 把本地字体装进应用数据目录（私有字体，不进仓库）。
 *
 * 用法：
 *   node scripts/install-font.mjs 路径\字体.woff2
 *   node scripts/install-font.mjs 路径\字体.ttf --data-dir=.cache/demo-sameday
 *
 * 为什么这样装：HZK / IPix 这类点阵字体的字模版权不清晰，
 * 不能跟着公开仓库分发；放进 userData/fonts 只在本机生效。
 * 应用启动时读取该目录，注册成 `Sproutbook Custom`，失败就回落到 Fusion Pixel。
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const dataDirArg = args.find((a) => a.startsWith('--data-dir='))

if (!file) {
  console.error('用法：node scripts/install-font.mjs <字体文件> [--data-dir=<目录>]')
  process.exit(1)
}

const ext = extname(file).toLowerCase()
if (!['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) {
  console.error(`不支持的字体格式：${ext}（要 woff2 / woff / ttf / otf）`)
  process.exit(1)
}

const resolved = resolve(file)
if (!existsSync(resolved)) {
  console.error(`找不到文件：${resolved}`)
  process.exit(1)
}

function defaultUserData() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? '', 'Sproutbook')
  if (process.platform === 'darwin') return join(process.env.HOME ?? '', 'Library', 'Application Support', 'Sproutbook')
  return join(process.env.HOME ?? '', '.config', 'Sproutbook')
}

const base = dataDirArg ? resolve(dataDirArg.slice('--data-dir='.length)) : defaultUserData()
const dir = join(base, 'fonts')
mkdirSync(dir, { recursive: true })

const target = join(dir, basename(resolved))
copyFileSync(resolved, target)

console.log(`已安装：${target}`)
console.log('重启应用后生效（应用启动时读取 <userData>/fonts 下的第一个字体文件）。')
