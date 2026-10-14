/**
 * 启动日志。
 *
 * 用途：数据库初始化失败时，用户看到的往往只有一句 SQLite 原文
 * （例如「unable to open database file」），光凭它无法判断问题出在哪一步。
 * 这个模块把关键步骤与路径写进一个日志文件，出问题时可以直接把文件发来定位。
 *
 * 两条硬性要求：
 *  1. **绝不抛异常**。日志失败不能影响启动，任何一步出错都静默吞掉。
 *  2. 有回退路径。用户数据目录本身可能写不进去，那就退到系统临时目录。
 */

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let resolvedPath: string | null | undefined

function candidatePaths(): string[] {
  const list: string[] = []
  try {
    list.push(join(app.getPath('userData'), 'startup.log'))
  } catch {
    /* userData 极早期可能取不到 */
  }
  try {
    list.push(join(app.getPath('temp'), 'sproutbook-startup.log'))
  } catch {
    /* 忽略 */
  }
  list.push(join(tmpdir(), 'sproutbook-startup.log'))
  return list
}

function resolvePath(): string | null {
  if (resolvedPath !== undefined) return resolvedPath
  for (const path of candidatePaths()) {
    try {
      const dir = join(path, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(path, '')
      resolvedPath = path
      return path
    } catch {
      // 换下一个候选位置
    }
  }
  resolvedPath = null
  return null
}

/** 当前日志文件路径（可能为 null，表示哪里都写不进去）。 */
export function startupLogPath(): string | null {
  return resolvePath()
}

/**
 * 追加一行日志。自动带上时间戳与进程 id，便于对照多个实例。
 * 永远不抛异常。
 */
export function logStartup(step: string, detail?: unknown): void {
  const path = resolvePath()
  if (!path) return
  try {
    const time = new Date().toISOString()
    let suffix = ''
    if (detail !== undefined) {
      suffix =
        typeof detail === 'string'
          ? ` ${detail}`
          : ` ${JSON.stringify(detail, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v))}`
    }
    appendFileSync(path, `[${time}] pid=${process.pid} ${step}${suffix}\n`)
  } catch {
    // 日志写入失败绝不影响主流程
  }
}

/** 把一个文件/目录的可写性探测结果记下来，比单纯记路径有用得多。 */
export function logWritability(label: string, target: string): void {
  let writable = false
  let reason = ''
  try {
    if (!existsSync(target)) {
      reason = '不存在'
    } else {
      const probe = join(target, `.probe-${process.pid}`)
      appendFileSync(probe, '')
      writable = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('node:fs').unlinkSync(probe)
      } catch {
        /* 探测文件删不掉不影响结论 */
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  logStartup(`${label} 可写性`, { target, writable, reason: reason || undefined })
}
