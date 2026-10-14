/**
 * 字段类型系统 —— 纯函数，可单测，零框架依赖。
 *
 * 这里是「可编辑模板」的心脏：所有取值校验、显示格式化、索引投影都收口在此，
 * UI 与数据库都只调用这里的函数，保证三处行为永远一致。
 */

import type { FieldDefinition, FieldType, FieldValue, MonthRange, NumberRange } from './types'

export interface FieldTypeMeta {
  type: FieldType
  label: string
  /** 是否可以有多个值（投影到索引表时会产生多行） */
  multiValued: boolean
  hint: string
}

export const FIELD_TYPES: FieldTypeMeta[] = [
  { type: 'text', label: '单行文本', multiValued: false, hint: '如「月季』' },
  { type: 'longtext', label: '多行文本', multiValued: false, hint: '长段落、养护要点' },
  { type: 'number', label: '数字', multiValued: false, hint: '可带单位，如 ℃ / cm / 天' },
  { type: 'bool', label: '是否', multiValued: false, hint: '是 / 否' },
  { type: 'select', label: '单选', multiValued: false, hint: '从预设选项里选一个' },
  { type: 'multiselect', label: '多选', multiValued: true, hint: '从预设选项里选多个' },
  { type: 'tags', label: '标签', multiValued: true, hint: '自由输入多个值' },
  { type: 'month_range', label: '月份', multiValued: true, hint: '可多段，如花期 4~6 月 + 9~11 月；支持跨年' },
  { type: 'hours_range', label: '数值区间', multiValued: false, hint: '如光照 6~8 小时' },
  { type: 'date', label: '日期', multiValued: false, hint: 'YYYY-MM-DD' },
  { type: 'image', label: '图片', multiValued: false, hint: '本地图片路径' },
  { type: 'link', label: '链接', multiValued: false, hint: '外部网址' },
  { type: 'relation', label: '关联', multiValued: false, hint: '关联到养护位置、物种库等另一个实体' }
]

export function fieldTypeMeta(type: FieldType): FieldTypeMeta | undefined {
  return FIELD_TYPES.find((t) => t.type === type)
}

export function isMultiValued(type: FieldType): boolean {
  return fieldTypeMeta(type)?.multiValued ?? false
}

const MONTH_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

export function monthLabel(m: number): string {
  return `${MONTH_NAMES[m - 1] ?? m}月`
}

function clampMonth(n: unknown): number | null {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return null
  const i = Math.trunc(v)
  if (i < 1 || i > 12) return null
  return i
}

/**
 * 把 from~to 展开成月份数组（自动处理跨年，如 11~2 月 → [11,12,1,2]）。
 * 旧的单区间写法仍然支持，但内部统一用「月份集合」表示。
 */
export function monthsInRange(range: MonthRange): number[] {
  const from = clampMonth(range.from)
  const to = clampMonth(range.to)
  if (from === null || to === null) return []
  if (from === to) return [from]
  const out: number[] = []
  let cur = from
  // 最多循环 12 次，杜绝异常输入导致的死循环
  for (let i = 0; i < 12; i++) {
    out.push(cur)
    if (cur === to) break
    cur = cur === 12 ? 1 : cur + 1
  }
  return out
}

/**
 * 把任意输入归一化成「月份集合」：去重、升序、限定 1~12。
 *
 * 为什么用集合而不是区间：很多植物一年开两次（月季 4~6 月 + 9~11 月），
 * 还有的夏天和冬天各休眠一次。单个 {from,to} 表达不了这种「多段」，
 * 而区间只是集合的一个特例，所以底层统一用集合，展示时再压缩成区间文本。
 */
export function normalizeMonths(raw: unknown): number[] {
  if (raw === null || raw === undefined) return []

  // 旧格式 { from, to }
  if (typeof raw === 'object' && !Array.isArray(raw) && 'from' in (raw as object)) {
    return monthsInRange(raw as MonthRange)
  }

  // 字符串：支持 "3-5,9-11" / "3,4,5" / "3月~5月" / "3 至 5" 等写法
  if (typeof raw === 'string') {
    const nums = raw
      .replace(/[月号]/g, '')
      .split(/[,，、;；]/)
      .flatMap((segment) => {
        const parts = segment
          .split(/[-~～至到]/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
        if (parts.length < 2) return parts
        // 段内是区间，展开
        return monthsInRange({ from: parts[0], to: parts[parts.length - 1] })
      })
      .map((n) => clampMonth(n))
      .filter((n): n is number => n !== null)
    return Array.from(new Set(nums)).sort((a, b) => a - b)
  }

  if (typeof raw === 'number') {
    const m = clampMonth(raw)
    return m === null ? [] : [m]
  }

  if (Array.isArray(raw)) {
    const nums = raw.map((n) => clampMonth(n)).filter((n): n is number => n !== null)
    return Array.from(new Set(nums)).sort((a, b) => a - b)
  }

  return []
}

/**
 * 把月份集合压缩成给人看的文本： [3,4,5,9,10,11] → 「3~5月、9~11月」。
 * 连续的一段合成区间；若同时覆盖了 1 月和 12 月，则合成跨年区间。
 */
export function formatMonthSet(months: number[]): string {
  const sorted = Array.from(new Set(months.filter((m) => m >= 1 && m <= 12))).sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  if (sorted.length === 12) return '全年'

  // 切成连续段
  const runs: Array<[number, number]> = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    if (cur === prev + 1) {
      prev = cur
      continue
    }
    runs.push([start, prev])
    start = cur
    prev = cur
  }
  runs.push([start, prev])

  // 首段从 1 月、末段到 12 月时合并成跨年区间（如 11,12,1,2 → 11~2月）
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][1] === 12) {
    const head = runs.shift() as [number, number]
    const tail = runs.pop() as [number, number]
    runs.unshift([tail[0], head[1]])
  }

  return runs.map(([a, b]) => (a === b ? monthLabel(a) : `${monthLabel(a)}~${monthLabel(b)}`)).join('、')
}

// ---------------------------------------------------------------------------
// 校验与归一化
// ---------------------------------------------------------------------------

export type CoerceResult =
  | { ok: true; value: FieldValue }
  | { ok: false; error: string }

const OK_EMPTY: CoerceResult = { ok: true, value: null }

function isEmptyRaw(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true
  if (typeof raw === 'string') return raw.trim() === ''
  if (Array.isArray(raw)) return raw.length === 0
  return false
}

/**
 * 把任意输入（来自表单 / AI / 导入文件）归一化成该字段类型的合法值。
 * 永远不抛异常 —— 校验失败返回 { ok: false }，由调用方决定如何提示。
 */
export function coerceFieldValue(def: Pick<FieldDefinition, 'type' | 'options' | 'label'>, raw: unknown): CoerceResult {
  if (isEmptyRaw(raw)) return OK_EMPTY

  switch (def.type) {
    case 'text':
    case 'longtext':
    case 'link':
    case 'image': {
      const s = String(raw).trim()
      return s ? { ok: true, value: s } : OK_EMPTY
    }

    case 'number': {
      const v = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(v)) return { ok: false, error: `${def.label} 需要一个数字` }
      return { ok: true, value: v }
    }

    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      const s = String(raw).trim().toLowerCase()
      if (['true', '1', 'yes', 'y', '是', '有'].includes(s)) return { ok: true, value: true }
      if (['false', '0', 'no', 'n', '否', '无'].includes(s)) return { ok: true, value: false }
      return { ok: false, error: `${def.label} 需要一个「是 / 否」值` }
    }

    case 'select': {
      const s = String(raw).trim()
      const options = def.options ?? []
      if (options.length > 0 && !options.includes(s)) {
        // 宽松策略：不在选项里也接受，但原样保留（用户可能先填后补选项）
        return { ok: true, value: s }
      }
      return { ok: true, value: s }
    }

    case 'multiselect':
    case 'tags': {
      const arr = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(/[,，;；\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
      const cleaned = Array.from(new Set(arr.map((s) => String(s).trim()).filter(Boolean)))
      return cleaned.length ? { ok: true, value: cleaned } : OK_EMPTY
    }

    case 'month_range': {
      // 值统一是月份集合（number[]）。旧的 {from,to} 写法照样能读进来。
      const months = normalizeMonths(raw)
      if (months.length === 0) {
        return { ok: false, error: `${def.label} 需要至少一个月份（可写 3-5、3,4,5 或 3-5,9-11）` }
      }
      return { ok: true, value: months }
    }

    case 'hours_range': {
      if (typeof raw === 'object' && raw !== null && ('min' in raw || 'max' in raw)) {
        const r = raw as { min: unknown; max: unknown }
        return { ok: true, value: normalizeRange(r.min, r.max) }
      }
      const nums = String(raw)
        .replace(/[小时hH]/g, '')
        .split(/[-~～至到,，]/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
      if (nums.length === 0) return { ok: false, error: `${def.label} 需要形如 6-8 的数值区间` }
      return { ok: true, value: normalizeRange(nums[0], nums.length > 1 ? nums[1] : nums[0]) }
    }

    case 'date': {
      const s = String(raw).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: `${def.label} 需要 YYYY-MM-DD 格式` }
      return { ok: true, value: s }
    }

    case 'relation': {
      // 存的是目标记录的主键。空值表示「未关联」，是合法状态。
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return { ok: false, error: `${def.label} 需要一个有效的关联项` }
      return { ok: true, value: Math.trunc(n) }
    }

    default:
      return { ok: true, value: String(raw) }
  }
}

function normalizeRange(a: unknown, b: unknown): NumberRange {
  const na = Number(a)
  const nb = Number(b)
  const min = Number.isFinite(na) ? na : null
  const max = Number.isFinite(nb) ? nb : null
  if (min !== null && max !== null && min > max) return { min: max, max: min }
  return { min, max }
}

/** 必填校验，在 coerce 之后调用。 */
export function validateRequired(def: Pick<FieldDefinition, 'label' | 'isRequired'>, value: FieldValue): string | null {
  if (!def.isRequired) return null
  if (value === null || value === undefined) return `${def.label} 是必填项`
  if (typeof value === 'string' && value.trim() === '') return `${def.label} 是必填项`
  if (Array.isArray(value) && value.length === 0) return `${def.label} 是必填项`
  return null
}

// ---------------------------------------------------------------------------
// 显示格式化
// ---------------------------------------------------------------------------

export function formatFieldValue(def: Pick<FieldDefinition, 'type' | 'unit' | 'label'>, value: FieldValue): string {
  if (value === null || value === undefined) return ''
  switch (def.type) {
    case 'bool':
      return value ? '是' : '否'
    case 'number':
      return def.unit ? `${value} ${def.unit}` : String(value)
    case 'multiselect':
    case 'tags':
      return Array.isArray(value) ? value.join('、') : String(value)
    case 'month_range': {
      // 值可能是新的月份集合，也可能是老数据里的 {from,to}
      const months = normalizeMonths(value)
      return months.length > 0 ? formatMonthSet(months) : ''
    }
    case 'hours_range': {
      const r = value as NumberRange
      if (typeof r !== 'object' || r === null) return String(value)
      const body = r.min === r.max ? `${r.min}` : `${r.min ?? '?'} ~ ${r.max ?? '?'}`
      return def.unit ? `${body} ${def.unit}` : body
    }
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

// ---------------------------------------------------------------------------
// 索引投影
// ---------------------------------------------------------------------------

export interface ProjectionRow {
  idx: number
  text: string | null
  num: number | null
}

/**
 * 把一个字段值投影成 attr_index 的行。
 *
 * 关键设计：多值字段和月份区间会产生**多行**（用 idx 区分），
 * 这样「本月开花」「含某标签」这类查询就是一次普通的索引命中，
 * 不需要在 SQL 里做字符串切分。
 */
export function projectFieldValue(def: Pick<FieldDefinition, 'type' | 'unit' | 'label'>, value: FieldValue): ProjectionRow[] {
  if (value === null || value === undefined) return []
  const text = formatFieldValue(def, value)

  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return [{ idx: 0, text, num: Number.isFinite(n) ? n : null }]
    }
    case 'bool':
      return [{ idx: 0, text: value ? '1' : '0', num: value ? 1 : 0 }]
    case 'hours_range': {
      const r = value as NumberRange
      return [{ idx: 0, text, num: typeof r?.min === 'number' ? r.min : null }]
    }
    case 'month_range': {
      // 一个月一行 —— 所以「本月开花」永远是一次索引命中，
      // 无论用户填的是一个区间还是多段不相连的月份。
      return normalizeMonths(value).map((m, i) => ({ idx: i, text: monthLabel(m), num: m }))
    }
    case 'multiselect':
    case 'tags': {
      const arr = Array.isArray(value) ? value : [String(value)]
      return arr.map((v, i) => ({ idx: i, text: String(v), num: null }))
    }
    default:
      return text ? [{ idx: 0, text, num: null }] : []
  }
}

/** 合并多行索引文本，用于列表页的关键词搜索列。 */
export function indexTextForSearch(defs: Array<Pick<FieldDefinition, 'key' | 'type' | 'unit' | 'label'>>, attributes: Record<string, FieldValue>): string {
  const parts: string[] = []
  for (const def of defs) {
    const v = attributes[def.key]
    if (v === null || v === undefined) continue
    const s = formatFieldValue(def, v)
    if (s) parts.push(s)
  }
  return parts.join(' ').toLowerCase()
}
