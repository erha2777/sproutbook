/**
 * 在进程内用 TypeScript 编译器 API 编译并加载 TS 模块。
 *
 * 为什么不用 tsx / ts-node：它们要么需要额外依赖，要么要派生带管道的子进程，
 * 在受限环境里会被直接拒绝。编译器 API 是纯 JS，稳定且零额外依赖。
 *
 * 编译产物落在 .cache/ts-build（已被 .gitignore 忽略）。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function compileAndLoad(rootFiles, { outDirName = 'ts-build', clean = true, label = '编译' } = {}) {
  let ts
  try {
    ts = require('typescript')
  } catch {
    throw new Error('找不到 typescript，请先安装依赖（pnpm install）')
  }

  const outDir = join(projectRoot, '.cache', outDirName)
  if (clean) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const options = {
    outDir,
    rootDir: join(projectRoot, 'src'),
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2023.d.ts'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    forceConsistentCasingInFileNames: true,
    types: ['node'],
    noEmit: false
  }

  const absoluteRoots = rootFiles.map((f) => join(projectRoot, f))
  const program = ts.createProgram(absoluteRoots, options)
  const emitResult = program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)

  if (errors.length > 0) {
    console.error(`${label}失败：`)
    for (const d of errors.slice(0, 30)) {
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
      if (d.file && typeof d.start === 'number') {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
        console.error(`  ${d.file.fileName}:${line + 1}:${character + 1}  ${message}`)
      } else {
        console.error(`  ${message}`)
      }
    }
    if (errors.length > 30) console.error(`  ...还有 ${errors.length - 30} 条`)
    process.exit(1)
  }

  return {
    outDir,
    require: (relativePath) => {
      const full = join(outDir, relativePath)
      if (!existsSync(full)) throw new Error(`编译产物不存在：${full}`)
      return require(full)
    }
  }
}
