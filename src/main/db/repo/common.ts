/**
 * 仓储层公共工具：行映射、索引投影写入、搜索文本生成。
 */

import type { Db } from '../connection'
import type { FieldDefinition, FieldValue } from '../../../core/types'
import { projectAttributes } from '../../../core/attributes'

// ---------------------------------------------------------------------------
// 字段定义
// ---------------------------------------------------------------------------

export interface FieldDefinitionRow {
  id: number
  owner_kind: string
  key: string
  label: string
  label_en: string | null
  group_name: string
  type: string
  unit: string | null
  options_json: string | null
  default_json: string | null
  help_text: string | null
  is_system: number
  is_required: number
  is_safety: number
  column_name: string | null
  sort_order: number
  archived_at: string | null
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function mapFieldDefinition(row: FieldDefinitionRow): FieldDefinition {
  return {
    id: row.id,
    ownerKind: row.owner_kind as FieldDefinition['ownerKind'],
    key: row.key,
    label: row.label,
    labelEn: row.label_en,
    groupName: row.group_name,
    type: row.type as FieldDefinition['type'],
    unit: row.unit,
    options: safeParse<string[] | null>(row.options_json, null),
    defaultValue: safeParse<FieldValue>(row.default_json, null),
    helpText: row.help_text,
    isSystem: row.is_system === 1,
    isRequired: row.is_required === 1,
    isSafety: row.is_safety === 1,
    columnName: row.column_name,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at
  }
}

export function loadFieldDefinitions(db: Db, ownerKind: 'species' | 'plant', includeArchived = false): FieldDefinition[] {
  const sql = includeArchived
    ? 'SELECT * FROM field_definitions WHERE owner_kind = ? ORDER BY sort_order, id'
    : 'SELECT * FROM field_definitions WHERE owner_kind = ? AND archived_at IS NULL ORDER BY sort_order, id'
  return db.all<FieldDefinitionRow>(sql, ownerKind).map(mapFieldDefinition)
}

// ---------------------------------------------------------------------------
// 索引投影
// ---------------------------------------------------------------------------

/**
 * 重写某个对象的索引投影。
 * 必须在保存主记录的**同一事务内**调用，否则投影会与真实数据不一致。
 */
export function writeAttrIndex(
  db: Db,
  ownerKind: 'species' | 'plant',
  ownerId: number,
  attributes: Record<string, FieldValue>,
  defs: FieldDefinition[]
): void {
  db.run('DELETE FROM attr_index WHERE owner_kind = ? AND owner_id = ?', ownerKind, ownerId)
  for (const row of projectAttributes(defs, attributes)) {
    db.run(
      `INSERT INTO attr_index (owner_kind, owner_id, field_key, idx, value_text, value_num, value_date)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(owner_kind, owner_id, field_key, idx)
       DO UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num`,
      ownerKind,
      ownerId,
      row.fieldKey,
      row.idx,
      row.text,
      row.num
    )
  }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

export function jsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function jsonObject(raw: string | null | undefined): Record<string, FieldValue> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, FieldValue>
    return {}
  } catch {
    return {}
  }
}

export function likeParam(query: string): string {
  // 转义 LIKE 通配符，避免用户输入的 % 或 _ 变成通配
  const escaped = query.replace(/[\\%_]/g, (m) => `\\${m}`)
  return `%${escaped.toLowerCase()}%`
}
