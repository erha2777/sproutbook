/**
 * 首次启动的种子数据：默认信息模板 + 一个示例环境档案。
 *
 * 幂等：重复调用不会产生重复字段（按键名判重）。
 */

import { Db } from './connection'
import { defaultFieldDefinitions, SYSTEM_COLUMNS } from '../../core/defaultTemplate'
import type { NewFieldDefinition } from '../../core/types'

export function seedFieldDefinitions(db: Db): { inserted: number; skipped: number } {
  const defs = defaultFieldDefinitions()
  let inserted = 0
  let skipped = 0

  db.transaction(() => {
    const counters: Record<string, number> = { species: 0, plant: 0 }
    for (const def of defs) {
      const existing = db.get<{ id: number }>(
        'SELECT id FROM field_definitions WHERE owner_kind = ? AND key = ?',
        def.ownerKind,
        def.key
      )
      if (existing) {
        skipped++
        continue
      }
      const order = counters[def.ownerKind] ?? 0
      counters[def.ownerKind] = order + 1
      insertFieldDefinition(db, def, order)
      inserted++
    }
  })

  return { inserted, skipped }
}

export function insertFieldDefinition(db: Db, def: NewFieldDefinition, sortOrder: number): number {
  const columnName = SYSTEM_COLUMNS[def.key] ?? null
  const isSystem = columnName ? 1 : 0
  const r = db.run(
    `INSERT INTO field_definitions
       (owner_kind, key, label, label_en, group_name, type, unit, options_json, default_json,
        help_text, is_system, is_required, is_safety, column_name, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    def.ownerKind,
    def.key,
    def.label,
    def.labelEn ?? null,
    def.groupName,
    def.type,
    def.unit ?? null,
    def.options ? JSON.stringify(def.options) : null,
    def.defaultValue === undefined ? null : JSON.stringify(def.defaultValue),
    def.helpText ?? null,
    isSystem,
    def.isRequired ? 1 : 0,
    def.isSafety ? 1 : 0,
    columnName,
    sortOrder
  )
  return Number(r.lastInsertRowid)
}

export function seedEnvironments(db: Db): number {
  const existing = db.scalar<number>('SELECT COUNT(*) AS c FROM environments')
  if (Number(existing ?? 0) > 0) return 0

  const rows: Array<[string, string, string, number, number]> = [
    ['南向阳台', 'balcony', 'full_sun', 6, 1],
    ['北向窗台', 'indoor', 'shade', 1, 0],
    ['露台', 'terrace', 'full_sun', 8, 0],
    ['室内补光', 'indoor', 'part_shade', 4, 1]
  ]
  db.transaction(() => {
    rows.forEach((r, i) => {
      db.run(
        `INSERT INTO environments (name, kind, light_level, light_hours, frost_protected, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        r[0],
        r[1],
        r[2],
        r[3],
        r[4],
        i
      )
    })
  })
  return rows.length
}

export function seedAll(db: Db): { fields: number; environments: number } {
  const fields = seedFieldDefinitions(db)
  const environments = seedEnvironments(db)
  return { fields: fields.inserted, environments }
}
