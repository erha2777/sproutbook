/**
 * 数据库单例：绑定到 Electron 的 userData 目录，负责迁移、备份与种子数据。
 */

import { app } from 'electron'
import { dirname, join } from 'node:path'
import { Db } from './connection'
import { backupDatabase, ensureDir, listBackups } from './backup'
import type { BackupInfo } from './backup'
import { migrate, rebuildAttrIndex } from './migrate'
import type { MigrationReport } from './migrate'
import { seedAll } from './seed'

let instance: Db | null = null
let lastReport: MigrationReport | null = null

export function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}

export function dbFilePath(): string {
  return join(dataDir(), 'sproutbook.db')
}

export function imagesDir(): string {
  return join(app.getPath('userData'), 'images')
}

export function backupsDir(): string {
  return join(app.getPath('userData'), 'backups')
}

export interface InitResult {
  report: MigrationReport
  seeded: { fields: number; environments: number }
  dbFile: string
  backups: BackupInfo[]
}

export function initDatabase(): InitResult {
  const file = dbFilePath()
  ensureDir(dirname(file))
  ensureDir(imagesDir())

  const db = new Db(file)

  // 迁移前备份：只有已存在数据（版本 > 0）才需要。
  // 起始版本由 migrate 的 onBefore 回传，不必在这里先查一次。
  const report = migrate(db, {
    onBefore: (from) => {
      if (from > 0) backupDatabase(db, file, backupsDir(), 5, `pre-v${from}`)
    }
  })

  if (!report.ok) {
    db.close()
    throw new Error(report.error ?? '数据库迁移失败')
  }

  const seeded = seedAll(db)

  // 投影表自愈：投影是纯派生数据，重建永远安全
  const indexed = Number(db.scalar<number>('SELECT COUNT(*) AS c FROM attr_index') ?? 0)
  if (indexed === 0) {
    try {
      rebuildAttrIndex(db)
    } catch {
      // 投影重建失败不影响主流程，后续保存时会补上
    }
  }

  instance = db
  lastReport = report

  return { report, seeded, dbFile: file, backups: listBackups(backupsDir()) }
}

export function getDb(): Db {
  if (!instance) throw new Error('数据库尚未初始化')
  return instance
}

export function getLastReport(): MigrationReport | null {
  return lastReport
}

export function closeDatabase(): void {
  if (!instance) return
  try {
    // 退出前落盘并做一次收尾备份
    backupDatabase(instance, dbFilePath(), backupsDir(), 5, 'exit')
  } catch {
    // 备份失败不应阻止退出
  }
  instance.close()
  instance = null
}

export function makeManualBackup(): BackupInfo | null {
  const db = getDb()
  const file = dbFilePath()
  const path = backupDatabase(db, file, backupsDir(), 20, 'manual')
  if (!path) return null
  const list = listBackups(backupsDir()).filter((b) => b.path === path)
  return list[0] ?? null
}
