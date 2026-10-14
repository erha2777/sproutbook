/**
 * SQLite 连接封装（基于 Node 24 内置的 node:sqlite）。
 *
 * 为什么不用 better-sqlite3：
 *   它是原生模块，需要本地编译或匹配 ABI 的预编译包，在没有 MSVC 构建工具的
 *   机器上会直接装不上。node:sqlite 是 Node 内置的，**零原生依赖、零编译**，
 *   这对「任何人 clone 下来就能跑」和 CI 构建稳定性都是决定性的。
 *
 * 本模块刻意不 import electron —— 传入文件路径即可，方便在 Electron 之外做自检。
 */

import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

export type BindValue = string | number | bigint | null | Uint8Array
export type RawBind = BindValue | boolean | undefined | Date

export interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

/**
 * node:sqlite 只接受 string / number / bigint / null / Uint8Array。
 * boolean、undefined、Date 都会直接抛错，所以统一在这里归一化。
 * 这是最容易踩的坑，收口成一个函数。
 */
function normalize(value: RawBind): BindValue {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

function normalizeAll(params: RawBind[]): BindValue[] {
  return params.map(normalize)
}

export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    // 崩溃安全性优先于极限吞吐：WAL + NORMAL 是本地应用的稳健组合
    this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA synchronous = NORMAL;')
    this.raw.exec('PRAGMA foreign_keys = ON;')
    this.raw.exec('PRAGMA busy_timeout = 5000;')
  }

  private stmt(sql: string): StatementSync {
    let cached = this.cache.get(sql)
    if (!cached) {
      cached = this.raw.prepare(sql)
      this.cache.set(sql, cached)
    }
    return cached
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  run(sql: string, ...params: RawBind[]): RunResult {
    const r = this.stmt(sql).run(...normalizeAll(params))
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  }

  all<T = Record<string, unknown>>(sql: string, ...params: RawBind[]): T[] {
    return this.stmt(sql).all(...normalizeAll(params)) as T[]
  }

  get<T = Record<string, unknown>>(sql: string, ...params: RawBind[]): T | undefined {
    return this.stmt(sql).get(...normalizeAll(params)) as T | undefined
  }

  /** 取单个标量值，用于 COUNT / MAX 这类查询。 */
  scalar<T = number>(sql: string, ...params: RawBind[]): T | undefined {
    const row = this.get<Record<string, T>>(sql, ...params)
    if (!row) return undefined
    const keys = Object.keys(row)
    return keys.length ? row[keys[0]] : undefined
  }

  /** 读取 pragma 值（node:sqlite 没有 db.pragma() 辅助方法）。 */
  pragma<T = unknown>(name: string): T | undefined {
    try {
      const row = this.get<Record<string, T>>(`PRAGMA ${name}`)
      if (!row) return undefined
      const keys = Object.keys(row)
      return keys.length ? row[keys[0]] : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 事务包装。回调抛错则整体回滚。
   * 注意：不支持嵌套 —— 嵌套调用会退化为普通执行（外层的提交仍然生效）。
   */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK')
      } catch {
        // 回滚本身失败（例如连接已断开）时，保留原始错误更有价值
      }
      throw error
    }
  }

  close(): void {
    this.cache.clear()
    try {
      this.raw.close()
    } catch {
      // 已关闭时忽略
    }
  }
}

export function sqliteVersion(db: Db): string {
  return String(db.pragma<string>('user_version') ?? '') && String(db.scalar<string>('SELECT sqlite_version() AS v') ?? 'unknown')
}
