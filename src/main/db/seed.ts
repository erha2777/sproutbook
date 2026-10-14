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
    /**
     * 新字段插到哪里。
     *
     * 两个坑：
     *  1. 不能用「插入计数」当序号 —— 给已有库补字段时，被跳过的老字段不占号，
     *     新字段会拿到 0、1、2 撞上老字段，排序只能靠 id 兜底（那是巧合不是设计）。
     *  2. 也不能简单地追加到末尾 —— 升级用户会看到「所属物种 / 养护位置 / 状态」
     *     被排到「备注」后面，而这些恰恰是最常用的字段。
     *
     * 做法：按字段在模板里的规范序号插入，并把该位置及其后的已有字段整体后移一格。
     * 这样新字段落在正确位置，已有字段的**相对次序保持不变**，也没有并列。
     */
    const canonicalIndex: Record<string, number> = { species: 0, plant: 0 }

    for (const def of defs) {
      // 规范序号对「插入的」和「跳过的」都要推进，否则序号会整体前移
      const wanted = canonicalIndex[def.ownerKind] ?? 0
      canonicalIndex[def.ownerKind] = wanted + 1

      const existing = db.get<{ id: number }>(
        'SELECT id FROM field_definitions WHERE owner_kind = ? AND key = ?',
        def.ownerKind,
        def.key
      )
      if (existing) {
        skipped++
        continue
      }

      // 让位：把该位置及其后的字段整体后移一格
      db.run(
        'UPDATE field_definitions SET sort_order = sort_order + 1 WHERE owner_kind = ? AND sort_order >= ?',
        def.ownerKind,
        wanted
      )

      insertFieldDefinition(db, def, wanted)
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
        help_text, is_system, is_required, is_safety, column_name, relation_target, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    def.relationTarget ?? null,
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
