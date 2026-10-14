/**
 * 独立自检：`node scripts/smoke.mjs`
 *
 * 不需要 Electron，也不需要打包器 —— 用 TypeScript 编译器 API 在进程内编译，
 * 再用 Node 24 内置的 node:sqlite 跑完整数据链路。
 *
 * 退出码 0 = 全部通过，1 = 有失败项，可直接用于 CI。
 * 应用内也有同样的入口：`electron . --smoke`，跑的是同一份 src/main/smoke.ts。
 */

import { join } from 'node:path'
import { compileAndLoad, projectRoot } from './lib/compile.mjs'

const { require: load } = compileAndLoad(['src/main/smoke.ts'], { label: '自检编译' })
const { runSmoke } = load(join('main', 'smoke.js'))

const reportPath = join(projectRoot, '.cache', 'smoke-report.txt')
const code = await runSmoke(reportPath)

console.log(`\n详细报告：${reportPath}`)
process.exit(code)
