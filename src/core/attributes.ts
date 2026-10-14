/**
 * 属性读写与列 / JSON 分流 —— 纯函数。
 *
 * 设计要点：系统字段存独立列，其余字段存 attributes_json。
 * 这里提供唯一的分流实现，避免 main 与 renderer 各写一份导致行为漂移。
 */

import { SYSTEM_COLUMNS } from './defaultTemplate'
import { coerceFieldValue, projectFieldValue, indexTextForSearch, validateRequired } from './fieldTypes'
import type { ProjectionRow } from './fieldTypes'
import type { FieldDefinition, FieldValue } from './types'

export interface SplitResult {
  /** 要写入独立列的值 */
  columns: Record<string, string | number | null>
  /** 要写入 attributes_json 的值 */
  attributes: Record<string, FieldValue>
}

/**
 * 把一份「fieldKey → 原始输入」的表单数据，校验并分流成列 + JSON。
 * 校验失败会收集到 errors，成功的部分照常返回，让 UI 能逐字段提示。
 */
export function splitAttributes(
  defs: FieldDefinition[],
  input: Record<string, unknown>
): { split: SplitResult; errors: Record<string, string> } {
  const columns: Record<string, string | number | null> = {}
  const attributes: Record<string, FieldValue> = {}
  const errors: Record<string, string> = {}

  for (const def of defs) {
    if (def.archivedAt) continue
    if (!(def.key in input)) continue

    const result = coerceFieldValue(def, input[def.key])
    if (!result.ok) {
      errors[def.key] = result.error
      continue
    }
    if (result.value === null) {
      // 显式清空
      if (def.columnName) columns[def.columnName] = null
      else attributes[def.key] = null
      continue
    }

    if (def.columnName === 'aliases_json') {
      columns[def.columnName] = JSON.stringify(result.value)
    } else if (def.columnName) {
      columns[def.columnName] = typeof result.value === 'number' ? result.value : String(result.value)
    } else {
      attributes[def.key] = result.value
    }
  }

  return { split: { columns, attributes }, errors }
}

/**
 * 必填校验 —— 对**合并后的最终值**校验，而不是只校验本次提交的字段。
 *
 * 为什么不能在 splitAttributes 里顺手做：那里只看到本次提交的键，
 * 缺键无法区分「用户清空」和「本次没改」。所以调用方要传一个
 * 「按字段取最终值」的读取器（列字段取列，其余取 attributes_json）。
 */
export function requiredErrors(
  defs: FieldDefinition[],
  read: (def: FieldDefinition) => FieldValue | undefined
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const def of defs) {
    if (def.archivedAt || !def.isRequired) continue
    const message = validateRequired(def, read(def) ?? null)
    if (message) errors[def.key] = message
  }
  return errors
}

/** 生成 attr_index 投影行（多值字段会产生多行）。 */
export function projectAttributes(
  defs: FieldDefinition[],
  attributes: Record<string, FieldValue>
): Array<{ fieldKey: string } & ProjectionRow> {
  const rows: Array<{ fieldKey: string } & ProjectionRow> = []
  for (const def of defs) {
    if (def.archivedAt) continue
    const value = attributes[def.key]
    if (value === null || value === undefined) continue
    for (const row of projectFieldValue(def, value)) {
      rows.push({ fieldKey: def.key, ...row })
    }
  }
  return rows
}

/** 生成用于 LIKE 搜索的扁平文本（小数据集下比 FTS5 更可靠，且支持 2 字中文查询）。 */
export function buildSearchBlob(defs: FieldDefinition[], attributes: Record<string, FieldValue>, extra: string[] = []): string {
  const parts = [...extra.filter(Boolean), indexTextForSearch(defs, attributes)]
  return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim()
}

export { SYSTEM_COLUMNS }
