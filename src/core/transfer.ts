/**
 * 导入导出的字段值转换 —— 纯函数。
 *
 * 设计要点：**只有两种情况需要特殊处理**，其余类型靠 `coerceFieldValue` 的宽松解析
 * 天然往返。这是当初把解析器写宽（`是/否`、`3-5,9-11`、`a,b` 都能读）换来的好处：
 *
 *   类型            导出成            导入时靠什么还原
 *   bool            是 / 否           coerce 认识「是/否」
 *   multiselect/tags  a,b              coerce 按 , ; 分割
 *   month_range     4,5,6,9,10,11     normalizeMonths 按 , 分割并展开区间
 *   hours_range     6-8               coerce 解析区间
 *   number/date/text 原样              原样
 *
 *   relation        **目标的名字**      需要按名字查回 ID（见下）
 *   select(status)  **中文标签**        需要按标签查回存储键（见下）
 *
 * 为什么 relation 必须导出名字而不是 ID：
 *   ID 是数据库内部的自增值，对用户毫无意义，导入到另一台机器还会指向别的记录。
 *   导出成「月季」「南向阳台」才是真正可移植的。同理 status 存的是 growing，
 *   导成人看的「生长中」。
 */

import type { FieldDefinition, FieldValue } from './types'

/** 转换时需要的外部查询能力，由调用方注入（core 不碰数据库）。 */
export interface TransferLookups {
  /** relation：目标记录 id → 显示名 */
  relationName?: (target: string, id: number) => string | null
  /** select：字段 key + 存储值 → 显示名（只对需要翻译的字段生效） */
  selectLabel?: (fieldKey: string, value: string) => string | null
}

/**
 * 把领域值转成适合导出的值。
 *
 * 返回原生类型（布尔 / 数字 / 数组 / 字符串），由调用方按格式落笔：
 *  - JSON 保留原生类型，方便程序直接消费
 *  - CSV 统一 String() 落到单元格（数组会变成 `a,b`，正好能被解析回来）
 *
 * 唯一的例外是 hours_range：它导出成 `6-8` 字符串而不是对象，
 * 因为 `String({min,max})` 会得到 `[object Object]`，CSV 与导入都读不回来。
 */
export function exportFieldValue(
  def: Pick<FieldDefinition, 'key' | 'type' | 'relationTarget'>,
  value: FieldValue,
  lookups: TransferLookups = {}
): string | number | boolean | number[] | string[] | null {
  if (value === null || value === undefined) return null

  switch (def.type) {
    case 'bool':
      return value === true

    case 'multiselect':
    case 'tags': {
      const arr = Array.isArray(value) ? value : [value]
      return arr.map((v) => String(v))
    }

    case 'month_range': {
      // 必须是阿拉伯数字：normalizeMonths 不认识「三月」
      const arr = Array.isArray(value) ? (value as number[]) : []
      return arr.length > 0 ? [...arr] : null
    }

    case 'hours_range': {
      const r = value as { min?: number | null; max?: number | null }
      if (r?.min === null || r?.min === undefined) return null
      return r.max === null || r.max === undefined || r.max === r.min ? String(r.min) : `${r.min}-${r.max}`
    }

    case 'relation': {
      const id = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(id)) return null
      const name = def.relationTarget ? lookups.relationName?.(def.relationTarget, id) : null
      // 查不到名字就退回 ID —— 宁可导出得难看，也不能丢数据
      return name ?? id
    }

    case 'select': {
      const s = String(value)
      return lookups.selectLabel?.(def.key, s) ?? s
    }

    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : String(value)
    }

    default:
      return typeof value === 'boolean' || typeof value === 'number' ? value : String(value)
  }
}

/** 导出时的列名：优先用中文标签（给人看），JSON 里另外保留 key。 */
export function columnHeader(def: Pick<FieldDefinition, 'key' | 'label'>): string {
  return def.label?.trim() || def.key
}

/** 把可读值转成能被 coerceFieldValue 接受的输入（relation / select 已在调用方处理）。 */
export function importFieldValue(raw: string): unknown {
  const s = raw.trim()
  if (s === '') return null
  return s
}
