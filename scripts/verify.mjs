#!/usr/bin/env node
/**
 * 一条命令跑完全部检查：类型 → 自检 → 构建 →（可选）打包。
 *
 * ## 为什么要有这个脚本
 *
 * 因为**手工在命令行里串检查骗过我两次**：
 *
 *   1. `& $node tsc ... | Select-Object -First 5` —— 输出被截断，
 *      退出码没人看，紧接着的 git commit 照跑，于是**提交了一个类型检查失败的版本**
 *   2. 正则替换没匹配上，脚本却打印「已加入」——
 *      因为我把「命令跑过了」当成了「命令成功了」
 *
 * 一个"失败了还往下走"的流程比没有流程更危险：**它会让人以为检查过了。**
 *
 * 所以这里只有一条规矩：**任何一步非零退出，立刻停，后面的都不跑。**
 *
 * 用法：
 *   node scripts/verify.mjs            类型 + 自检 + 构建
 *   node scripts/verify.mjs --pack     再多做一步打包（会自动清 release）
 */

import { spawnSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const wantPack = process.argv.includes('--pack')

/**
 * ELECTRON_RUN_AS_NODE 会被某些终端注入进来，导致 Electron 以 Node 模式启动、
 * 窗口根本不开。每次调用前都清掉。
 */
function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function step(label, args) {
  process.stdout.write(`\n▸ ${label}\n`)
  const r = spawnSync(node, args, { cwd: root, stdio: 'inherit', env: cleanEnv() })
  if (r.error) {
    console.error(`\n✗ ${label} 起不来：${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（退出码 ${r.status}）`)
    console.error('  按规矩停在这里 —— 后面的步骤不跑，免得带着错的版本继续。')
    process.exit(r.status ?? 1)
  }
}

/** 打包前清 release：Electron 进程退出后文件锁不是立刻释放的，留着必然 EPERM/EBUSY。 */
function clearRelease() {
  const dir = join(root, 'release')
  for (let i = 1; i <= 8; i++) {
    rmSync(dir, { recursive: true, force: true })
    if (!existsSync(dir)) return true
    // 同步等待：这里是脚本，没必要引异步
    spawnSync(node, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' })
  }
  return !existsSync(dir)
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

step('类型检查 · 主进程', [tsc, '-p', 'tsconfig.node.json'])
step('类型检查 · 界面', [tsc, '-p', 'tsconfig.web.json'])
step('自检', [join(root, 'scripts', 'smoke.mjs')])
step('构建', [join(root, 'scripts', 'tool.mjs'), 'electron-vite', 'build'])

if (wantPack) {
  if (!clearRelease()) {
    console.error('\n✗ release 目录删不掉（多半还有 Electron 进程占着）。')
    console.error('  先关掉应用再跑，别绕过这一步 —— 带着旧文件打包出来的东西不算数。')
    process.exit(1)
  }
  step('打包', [join(root, 'scripts', 'tool.mjs'), 'electron-builder', '--win', '--publish', 'never'])

  /*
   * **打包之后必须验产物。**
   *
   * electron-builder 会因为文件锁**悄悄少拷文件**，然后照样退出 0。
   * 用户拿到的是一个启动就崩的程序：
   *
   *   ERROR:base\i18n\icu_util.cc:232] Invalid file descriptor to ICU data received.
   *   退出码 -2147483645 (0x80000003)
   *
   * 而这条命令当时报的是「✓ 全部通过」—— **又一次假绿**。
   * 缺的是 Electron 自己的运行时（ICU 数据、pak、DLL），不是我们的代码，
   * 所以任何代码层面的检查都发现不了它。
   */
  const critical = [
    'icudtl.dat',
    'resources.pak',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'v8_context_snapshot.bin',
    'ffmpeg.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'resources/app.asar'
  ]
  const unpacked = join(root, 'release', 'win-unpacked')
  const missing = critical.filter((f) => !existsSync(join(unpacked, f)))
  if (missing.length > 0) {
    console.error(`\n✗ 打包产物不完整，缺 ${missing.length} 个关键文件：`)
    for (const f of missing) console.error('    ' + f)
    console.error('  这样的包**启动就会崩**（Invalid file descriptor to ICU data）。')
    console.error('  多半是上一次的 Electron 进程还占着文件。关掉应用，重跑这条命令。')
    process.exit(1)
  }
  process.stdout.write(`\n▸ 产物检查：${critical.length} 个关键文件都在\n`)
}

process.stdout.write('\n✓ 全部通过\n')
