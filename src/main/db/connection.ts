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

/**
 * 数一条 SQL 里有多少个位置占位符。
 *
 * **必须跳过引号里的内容**，否则 `WHERE note = '几点了?'` 会被多数一个。
 * 顺带跳过标识符引号（"x" / `x` / [x]）和注释。
 *
 * 支持编号占位符 `?1`：按不同编号计数。
 */
export function countPlaceholders(sql: string): number {
  const numbered = new Set<number>()
  let bare = 0

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < sql.length) {
        if (sql[i] === ch) {
          // 双写表示转义，例如 'it''s'
          if (sql[i + 1] === ch) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      continue
    }
    if (ch === '[') {
      while (i < sql.length && sql[i] !== ']') i++
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i++
      continue
    }

    if (ch === '?') {
      let j = i + 1
      let digits = ''
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') digits += sql[j++]
      if (digits) {
        numbered.add(Number(digits))
        i = j - 1
      } else {
        bare++
      }
    }
  }

  return numbered.size > 0 ? numbered.size : bare
}

export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()
  /** 每条 SQL 的占位符个数，首次见到时数一次 */
  private readonly placeholders = new Map<string, number>()
  /** 事务嵌套深度。SQLite 不支持嵌套事务，内层必须退化为普通执行。 */
  private txDepth = 0

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    // 崩溃安全性优先于极限吞吐：WAL + NORMAL 是本地应用的稳健组合
    this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA synchronous = NORMAL;')
    this.raw.exec('PRAGMA foreign_keys = ON;')
    this.raw.exec('PRAGMA busy_timeout = 5000;')
  }

  /**
   * 取（并缓存）预处理语句。
   *
   * ## 为什么在这里校验占位符个数
   *
   * 这里是**所有读写路径的唯一入口**（run / all / get / scalar 都走它），
   * 所以改一处就覆盖全项目每一条 SQL —— 不用写审计脚本，也不用靠人来数。
   *
   * 这类错真的发生过：给 environments 加 district 时改了 SQL 的列名却没改参数，
   * UPDATE 少一个 `?`，**整条语句静默失效**，用户看到的现象只有一句「这块修改不了」。
   * node:sqlite 的 `run(sql, ...params)` 是变参，类型系统管不到，只能在这里拦。
   *
   * 宁可**当场抛出**，也不要让它悄悄写错数据 —— 少一个参数时 SQLite 会把
   * 剩下的参数按位置错配，那比直接失败危险得多（坐标串位就是这么来的）。
   */
  private stmt(sql: string, paramCount: number): StatementSync {
    let expected = this.placeholders.get(sql)
    if (expected === undefined) {
      expected = countPlaceholders(sql)
      this.placeholders.set(sql, expected)
    }
    if (expected !== paramCount) {
      throw new Error(
        `SQL 占位符与参数数量不符：语句里有 ${expected} 个占位符，却传了 ${paramCount} 个参数。\n` +
          `（改了 SQL 记得同步改参数列表 —— 少传参数时 SQLite 会把参数按位置错配，` +
          `比直接失败更危险。）\n${sql}`
      )
    }

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
    const r = this.stmt(sql, params.length).run(...normalizeAll(params))
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  }

  all<T = Record<string, unknown>>(sql: string, ...params: RawBind[]): T[] {
    return this.stmt(sql, params.length).all(...normalizeAll(params)) as T[]
  }

  get<T = Record<string, unknown>>(sql: string, ...params: RawBind[]): T | undefined {
    return this.stmt(sql, params.length).get(...normalizeAll(params)) as T | undefined
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
    // 已经在事务里就不要再 BEGIN —— SQLite 会报
    //「cannot start a transaction within a transaction」。
    // 内层的异常照常抛出，由最外层统一 ROLLBACK，语义上等价于嵌套事务。
    if (this.txDepth > 0) return fn()

    this.raw.exec('BEGIN')
    this.txDepth++
    try {
      const result = fn()
      this.txDepth--
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.txDepth--
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
