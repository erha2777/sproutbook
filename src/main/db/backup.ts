/**
 * 数据库备份 —— 数据类应用的生命线。
 *
 * 策略：滚动保留最近 N 份，迁移前强制备份一次。
 * 依赖 WAL checkpoint 后再复制，保证备份文件是自洽的（不依赖 -wal 文件）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './connection'

export interface BackupInfo {
  path: string
  size: number
  createdAt: string
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 备份数据库。返回备份文件路径；若源文件不存在则返回 null（首次启动的正常情况）。
 */
export function backupDatabase(db: Db, dbFile: string, backupDir: string, keep = 5, tag = 'auto'): string | null {
  if (!existsSync(dbFile)) return null

  // 把 WAL 落盘并截断，确保主库文件自身就是完整的
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    // checkpoint 失败不应阻断备份，退化为尽力而为
  }

  ensureDir(backupDir)
  const target = join(backupDir, `sproutbook-${tag}-${timestampSlug()}.db`)
  copyFileSync(dbFile, target)
  pruneBackups(backupDir, keep)
  return target
}

export function listBackups(backupDir: string): BackupInfo[] {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = join(backupDir, f)
      const stat = statSync(full)
      return { path: full, size: stat.size, createdAt: stat.mtime.toISOString() }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function pruneBackups(backupDir: string, keep: number): number {
  const backups = listBackups(backupDir)
  let removed = 0
  for (const b of backups.slice(Math.max(keep, 1))) {
    try {
      unlinkSync(b.path)
      removed++
    } catch {
      // 文件被占用时跳过，下次启动再清理
    }
  }
  return removed
}
