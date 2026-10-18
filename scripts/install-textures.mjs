/**
 * 把本地图片装成应用皮肤（私有，不进仓库）。
 *
 * 用法：
 *   node scripts/install-textures.mjs 目录\素材 --data-dir=D:\sproutbook-data
 *   node scripts/install-textures.mjs 目录\素材
 *
 * 目录里按约定的文件名放图即可（png / jpg / webp）：
 *   home-bg.png   首页整屏背景
 *   sign.png      首页木牌（整张图，带标题）
 *   button.png    首页按钮底图
 *   panel.png     所有木色面板底图
 *   cloud.png     云朵贴图
 *
 * 注意：星露谷等商业游戏的素材受版权保护。这里只负责把你**自己**准备的
 * 图片放进本机数据目录，不上传、不打包、不随仓库分发。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const SLOTS = ['home-bg', 'sign', 'button', 'panel', 'cloud']
const EXTS = ['.png', '.jpg', '.jpeg', '.webp']

const args = process.argv.slice(2)
const source = args.find((a) => !a.startsWith('--'))
const dataDirArg = args.find((a) => a.startsWith('--data-dir='))

if (!source) {
  console.error('用法：node scripts/install-textures.mjs <图片目录> [--data-dir=<目录>]')
  process.exit(1)
}

function defaultUserData() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? '', 'Sproutbook')
  if (process.platform === 'darwin') return join(process.env.HOME ?? '', 'Library', 'Application Support', 'Sproutbook')
  return join(process.env.HOME ?? '', '.config', 'Sproutbook')
}

const srcDir = resolve(source)
if (!existsSync(srcDir)) {
  console.error(`找不到目录：${srcDir}`)
  process.exit(1)
}

const base = dataDirArg ? resolve(dataDirArg.slice('--data-dir='.length)) : defaultUserData()
const destDir = join(base, 'textures')
mkdirSync(destDir, { recursive: true })

const files = readdirSync(srcDir)
let installed = 0
for (const slot of SLOTS) {
  const match = files.find((name) => {
    const ext = extname(name).toLowerCase()
    return EXTS.includes(ext) && name.slice(0, -ext.length) === slot
  })
  if (!match) continue
  copyFileSync(join(srcDir, match), join(destDir, match))
  console.log(`✓ ${slot} ← ${match}`)
  installed++
}

if (installed === 0) {
  console.log(`没有找到约定命名的图片（${SLOTS.join(' / ')}）。`)
  console.log('文件名示例：home-bg.png、sign.png、button.png、panel.png、cloud.png')
} else {
  console.log(`\n已安装 ${installed} 个槽位到：${destDir}`)
  console.log('重启应用后生效。')
}
