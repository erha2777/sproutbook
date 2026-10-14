/**
 * 模板字段定义仓储 —— 「可编辑模板」的落地。
 *
 * 安全规则（这些不是洁癖，是防数据丢失）：
 *  1. 字段只归档，不物理删除；只有「从未被使用过」的字段才允许真删。
 *  2. 系统字段（is_system）不可删除、key 不可改。
 *  3. 修改字段类型前必须检查已有数据能否兼容。
 */

import type { Db } from '../connection'
import type { FieldDefinition, FieldDefinitionPatch, FieldOwner, NewFieldDefinition } from '../../../core/types'
import { loadFieldDefinitions, mapFieldDefinition } from './common'
import type { FieldDefinitionRow } from './common'
import { insertFieldDefinition } from '../seed'
import { rebuildAttrIndex } from '../migrate'

export { loadFieldDefinitions }

export function getField(db: Db, id: number): FieldDefinition | null {
  const row = db.get<FieldDefinitionRow>('SELECT * FROM field_definitions WHERE id = ?', id)
  return row ? mapFieldDefinition(row) : null
}

export function createField(db: Db, input: NewFieldDefinition): FieldDefinition {
  const key = input.key.trim()
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(key)) {
    throw new Error('字段标识只能用英文小写字母、数字和下划线，且以字母开头（2~49 个字符）。')
  }

  const existing = db.get<FieldDefinitionRow>(
    'SELECT * FROM field_definitions WHERE owner_kind = ? AND key = ?',
    input.ownerKind,
    key
  )
  if (existing) {
    // 已归档的同名字段：复活它，而不是报错
    if (existing.archived_at) {
      db.run('UPDATE field_definitions SET archived_at = NULL WHERE id = ?', existing.id)
      return mapFieldDefinition({
        ...existing,
        archived_at: null
      })
    }
    throw new Error(`字段标识「${key}」已存在。`)
  }

  const maxOrder = Number(
    db.scalar<number>('SELECT COALESCE(MAX(sort_order), -1) AS m FROM field_definitions WHERE owner_kind = ?', input.ownerKind) ?? -1
  )
  const id = insertFieldDefinition(db, { ...input, key }, maxOrder + 1)
  const created = getField(db, id)
  if (!created) throw new Error('字段创建失败')
  return created
}

export function updateField(db: Db, id: number, patch: FieldDefinitionPatch): FieldDefinition {
  return db.transaction(() => {
    const current = getField(db, id)
    if (!current) throw new Error('字段不存在')

    /*
     * 改类型是高危操作：已有数据是按旧类型存的，换成新类型后可能解析不了
     *（例如 text 里的「约 15 厘米」变成 number 字段后就再也存不回去）。
     * 这里守住底线：**有数据就不许改类型**，让用户新建字段并把旧的归档，
     * 而不是让一批值在某次保存时静默失效。
     *
     * 之前这个 usage 算出来却没用过 —— 注释写了要警告，代码没接上。
     */
    const usage = fieldUsage(db, id)
    if (patch.type !== undefined && patch.type !== current.type && usage > 0) {
      throw new Error(
        `已有 ${usage} 条记录填过「${current.label}」，直接改类型会让这些值无法解析。` +
          `请新建一个字段，再把这个字段归档。`
      )
    }

    if (patch.label !== undefined) db.run('UPDATE field_definitions SET label = ? WHERE id = ?', patch.label, id)
    if (patch.groupName !== undefined) db.run('UPDATE field_definitions SET group_name = ? WHERE id = ?', patch.groupName, id)
    if (patch.type !== undefined && patch.type !== current.type) {
      if (current.isSystem) throw new Error('系统字段的类型不可修改。')
      db.run('UPDATE field_definitions SET type = ? WHERE id = ?', patch.type, id)
    }
    if (patch.unit !== undefined) db.run('UPDATE field_definitions SET unit = ? WHERE id = ?', patch.unit, id)
    if (patch.options !== undefined) {
      db.run('UPDATE field_definitions SET options_json = ? WHERE id = ?', patch.options ? JSON.stringify(patch.options) : null, id)
    }
    if (patch.defaultValue !== undefined) {
      db.run('UPDATE field_definitions SET default_json = ? WHERE id = ?', patch.defaultValue === null ? null : JSON.stringify(patch.defaultValue), id)
    }
    if (patch.helpText !== undefined) db.run('UPDATE field_definitions SET help_text = ? WHERE id = ?', patch.helpText, id)
    if (patch.isRequired !== undefined) db.run('UPDATE field_definitions SET is_required = ? WHERE id = ?', patch.isRequired ? 1 : 0, id)
    if (patch.isSafety !== undefined) db.run('UPDATE field_definitions SET is_safety = ? WHERE id = ?', patch.isSafety ? 1 : 0, id)
    if (patch.relationTarget !== undefined) {
      db.run('UPDATE field_definitions SET relation_target = ? WHERE id = ?', patch.relationTarget ?? null, id)
    }
    if (patch.visibleWhen !== undefined) {
      db.run(
        'UPDATE field_definitions SET visible_when_json = ? WHERE id = ?',
        patch.visibleWhen ? JSON.stringify(patch.visibleWhen) : null,
        id
      )
    }
    if (patch.sortOrder !== undefined) db.run('UPDATE field_definitions SET sort_order = ? WHERE id = ?', patch.sortOrder, id)
    if (patch.archivedAt !== undefined) {
      const wasArchived = current.archivedAt !== null
      const willArchive = patch.archivedAt !== null
      db.run('UPDATE field_definitions SET archived_at = ? WHERE id = ?', patch.archivedAt, id)

      /*
       * 归档状态变化必须重建投影索引。
       *
       * 归档只是把字段从「活动字段」里去掉，但 attr_index 里**已有的行不会自己消失** ——
       * 结果是按这个字段筛选仍然能命中，而且全量重建的行数对不上
       *（自检的「重建后行数与原来一致」就是这么抓到的）。
       * 取消归档同理：需要把它重新投影回去。
       */
      if (wasArchived !== willArchive) {
        rebuildAttrIndex(db)
      }
    }

    const updated = getField(db, id)
    if (!updated) throw new Error('字段更新失败')
    return updated
  })
}

export function setFieldArchived(db: Db, id: number, archived: boolean): FieldDefinition {
  return updateField(db, id, { archivedAt: archived ? new Date().toISOString() : null })
}

/** 物理删除，仅当从未被任何记录使用过。 */
export function deleteField(db: Db, id: number): boolean {
  const field = getField(db, id)
  if (!field) return false
  if (field.isSystem) throw new Error('系统字段不可删除，只能归档。')

  const usage = fieldUsage(db, id)
  if (usage > 0) {
    throw new Error(`已有 ${usage} 条记录填写过该字段，为避免数据丢失只能归档，不能删除。`)
  }

  db.run('DELETE FROM field_definitions WHERE id = ?', id)
  db.run('DELETE FROM attr_index WHERE field_key = ?', field.key)
  return true
}

/** 统计有多少条记录填过这个字段（同时检查 JSON 与索引投影，取较大值更保险）。 */
export function fieldUsage(db: Db, id: number): number {
  const field = getField(db, id)
  if (!field) return 0
  if (field.columnName) {
    const table = field.ownerKind === 'species' ? 'species' : 'plants'
    const col = field.columnName
    if (col === 'aliases_json') {
      return Number(db.scalar<number>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IS NOT NULL AND ${col} NOT IN ('', '[]')`) ?? 0)
    }
    return Number(db.scalar<number>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS TEXT)) <> ''`) ?? 0)
  }
  return Number(
    db.scalar<number>(
      `SELECT COUNT(*) AS c FROM attr_index WHERE owner_kind = ? AND field_key = ?`,
      field.ownerKind,
      field.key
    ) ?? 0
  )
}

/** 拖拽排序：传入该归属下的完整 id 顺序。 */
export function reorderFields(db: Db, ownerKind: FieldOwner, orderedIds: number[]): void {
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.run('UPDATE field_definitions SET sort_order = ? WHERE id = ? AND owner_kind = ?', index, id, ownerKind)
    })
  })
}

export interface FieldUsageSummary {
  field: FieldDefinition
  usage: number
}

export function fieldUsageList(db: Db, ownerKind: FieldOwner): FieldUsageSummary[] {
  return loadFieldDefinitions(db, ownerKind, true).map((field) => ({ field, usage: fieldUsage(db, field.id) }))
}
