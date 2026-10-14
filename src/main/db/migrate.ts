/**
 * 迁移执行器。
 *
 * 处理原则：
 *  - 每个迁移在**独立事务**中执行，失败即回滚，绝不留下半截结构。
 *  - 记录每个迁移的版本与名称，便于排查「用户库卡在哪一版」。
 *  - 迁移前由调用方负责备份（本模块只发通知，不碰文件系统）。
 */

import { Db } from './connection'
import { MIGRATIONS, LATEST_VERSION } from './schema'
import { projectFieldValue } from '../../core/fieldTypes'
import type { FieldValue } from '../../core/types'

export interface MigrationReport {
  from: number
  to: number
  applied: Array<{ version: number; name: string }>
  /** 迁移过程中是否出错（出错时数据库保持迁移前状态） */
  ok: boolean
  error?: string
}

export function currentVersion(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  const v = db.scalar<number>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
  return Number(v ?? 0)
}

export interface MigrateOptions {
  /** 在真正开始改动结构**之前**调用，让调用方有机会备份数据库文件。 */
  onBefore?: (from: number, to: number) => void
  /** 每个迁移应用后的回调，便于进度提示。 */
  onProgress?: (version: number, name: string) => void
}

export function migrate(db: Db, options: MigrateOptions = {}): MigrationReport {
  const from = currentVersion(db)
  const applied: Array<{ version: number; name: string }> = []

  if (from > LATEST_VERSION) {
    return {
      from,
      to: from,
      applied,
      ok: false,
      error: `数据库版本（${from}）高于本程序支持的版本（${LATEST_VERSION}）。请升级应用，不要用旧版本打开新数据。`
    }
  }

  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  if (pending.length === 0) {
    return { from, to: from, applied, ok: true }
  }

  options.onBefore?.(from, LATEST_VERSION)

  try {
    for (const m of pending) {
      db.transaction(() => {
        // 结构迁移写 SQL；需要改数据的迁移（比如值形状变化）用 run 回调。
        // 两者都在同一个事务里，失败即整体回滚。
        if (m.run) m.run(db)
        if (m.sql) db.exec(m.sql)
        db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', m.version, m.name)
      })
      applied.push({ version: m.version, name: m.name })
      options.onProgress?.(m.version, m.name)
    }
    return { from, to: LATEST_VERSION, applied, ok: true }
  } catch (error) {
    return {
      from,
      to: currentVersion(db),
      applied,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 从 JSON 全量重建 attr_index —— 投影坏了随时可以自愈，不需要数据修复脚本。 */
export function rebuildAttrIndex(db: Db): number {
  return db.transaction(() => {
    db.exec('DELETE FROM attr_index;')
    let count = 0
    const species = db.all<{ id: number; attributes_json: string }>('SELECT id, attributes_json FROM species;')
    for (const row of species) {
      count += projectInto(db, 'species', row.id, row.attributes_json)
    }
    const plants = db.all<{ id: number; attributes_json: string }>('SELECT id, attributes_json FROM plants;')
    for (const row of plants) {
      count += projectInto(db, 'plant', row.id, row.attributes_json)
    }
    return count
  })
}

function projectInto(db: Db, ownerKind: string, ownerId: number, attributesJson: string): number {
  let attributes: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(attributesJson || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) attributes = parsed as Record<string, unknown>
  } catch {
    return 0
  }

  const defs = db.all<{ key: string; type: string; unit: string | null; label: string }>(
    'SELECT key, type, unit, label FROM field_definitions WHERE owner_kind = ? AND archived_at IS NULL',
    ownerKind
  )

  let written = 0
  for (const def of defs) {
    const value = attributes[def.key]
    if (value === null || value === undefined) continue
    // 复用 core 的投影实现 —— 投影规则只能有一份，否则重建会与写入产生偏差
    for (const row of projectFieldValue(def as Parameters<typeof projectFieldValue>[0], value as FieldValue)) {
      db.run(
        `INSERT INTO attr_index (owner_kind, owner_id, field_key, idx, value_text, value_num, value_date)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(owner_kind, owner_id, field_key, idx)
         DO UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num`,
        ownerKind,
        ownerId,
        def.key,
        row.idx,
        row.text,
        row.num
      )
      written++
    }
  }
  return written
}
