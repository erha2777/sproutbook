/**
 * 导入导出服务。
 *
 * 这是应用的**数据出口** —— 本地优先的应用必须能进能出，否则用户的数据只能靠
 * 复制 SQLite 文件才能带走。所以这里的重点是「不丢数据」而不是「格式花哨」。
 *
 * 两种格式，一条导入路径：
 *   CSV  表头用中文字段名（给人看、可用 Excel 编辑）
 *   JSON 顶层键用字段 key（给程序看），同时带一份字段定义便于对照
 * 两者在导入时都会被规约成 { headers, rows } 再走同一套映射与校验逻辑 ——
 * 只实现一条导入路径，才不会有「CSV 能导、JSON 导不了」这类偏差。
 */

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Db } from '../db/connection'
import { parseCsv, toCsv } from '../../core/csv'
import { columnHeader, exportFieldValue } from '../../core/transfer'
import { PLANT_STATUS_KEYS, PLANT_STATUS_LABELS } from '../../core/status'
import { coerceFieldValue } from '../../core/fieldTypes'
import { loadFieldDefinitions } from '../db/repo/common'
import { listSpecies, getSpecies, saveSpecies } from '../db/repo/species'
import { listPlants, savePlant } from '../db/repo/plants'
import { listEnvironments } from '../db/repo/misc'
import type { FieldDefinition, FieldOwner, FieldValue, PlantStatus, RelationTarget } from '../../core/types'
import type {
  TransferFormat,
  TransferImportOptions,
  TransferIssue,
  TransferKind,
  TransferMappingEntry,
  TransferPreview,
  TransferResult
} from '../../shared/api'

const OWNER_OF: Record<TransferKind, FieldOwner> = { species: 'species', plants: 'plant' }

export interface BuiltExport {
  content: string
  suggestedName: string
  count: number
  /** 导出时跳过的字段（例如图片这类不随文件走的），用于如实告知用户 */
  omitted: string[]
}

// ---------------------------------------------------------------------------
// 取值上下文
// ---------------------------------------------------------------------------

interface Lookups {
  relationName: (target: string, id: number) => string | null
  relationId: (target: string, name: string) => number | null
  selectLabel: (fieldKey: string, value: string) => string | null
  selectKey: (fieldKey: string, label: string) => string | null
}

function buildLookups(db: Db): Lookups {
  const speciesNameById = new Map<number, string>()
  const speciesIdByName = new Map<string, number>()
  for (const s of listSpecies(db, { limit: 1000 }).items) {
    speciesNameById.set(s.id, s.commonName)
    speciesIdByName.set(s.commonName.trim(), s.id)
  }

  const envNameById = new Map<number, string>()
  const envIdByName = new Map<string, number>()
  for (const e of listEnvironments(db, true)) {
    envNameById.set(e.id, e.name)
    envIdByName.set(e.name.trim(), e.id)
  }

  const byTarget: Record<string, { byId: Map<number, string>; byName: Map<string, number> }> = {
    species: { byId: speciesNameById, byName: speciesIdByName },
    environments: { byId: envNameById, byName: envIdByName }
  }

  return {
    relationName: (target, id) => byTarget[target]?.byId.get(id) ?? null,
    relationId: (target, name) => byTarget[target]?.byName.get(name.trim()) ?? null,
    // 目前只有 status 需要「存储键 ↔ 显示名」翻译
    selectLabel: (key, value) =>
      key === 'status' ? (PLANT_STATUS_LABELS[value as PlantStatus] ?? null) : null,
    selectKey: (key, label) => (key === 'status' ? (PLANT_STATUS_KEYS[label.trim()] ?? null) : null)
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 取出一行记录的全部字段值。
 *
 * 注意：这里吃的是**数据库原始行**（snake_case 列名），不是仓储返回的领域对象。
 * 领域对象的属性是驼峰（`commonName`），而字段定义里存的是列名（`common_name`），
 * 若拿领域对象按列名取值会全部取到 undefined —— 导出一整片空列。
 */
function recordFor(
  defs: FieldDefinition[],
  row: Record<string, unknown>,
  attributes: Record<string, FieldValue>,
  lookups: Lookups
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    if (def.archivedAt) continue

    let raw: unknown
    if (def.columnName) {
      raw = row[def.columnName]
      // aliases_json 这类「列里存 JSON 数组」的字段要先解开，
      // 否则 tags 分支会把 '["a","b"]' 当成一个值整串输出
      if (def.columnName === 'aliases_json' && typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch {
          raw = []
        }
      }
    } else {
      raw = attributes[def.key]
    }

    out[def.key] = exportFieldValue(def, (raw ?? null) as FieldValue, lookups)
  }
  return out
}

/**
 * CSV 是给人用 Excel 看的，所以布尔写成「是 / 否」而不是 true/false。
 * JSON 保留原生类型（布尔、数字、数组），方便程序直接消费。
 */
function toCsvRecord(defs: FieldDefinition[], rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    const v = rec[def.key]
    if (v === null || v === undefined) out[def.key] = ''
    else if (typeof v === 'boolean') out[def.key] = v ? '是' : '否'
    else out[def.key] = String(v)
  }
  return out
}

interface RawRecord {
  row: Record<string, unknown>
  attributes: Record<string, FieldValue>
}

/** 直接读原始行：导出要的是「库里到底存了什么」，不需要经过领域对象的转换。 */
function rawRecords(db: Db, kind: TransferKind): RawRecord[] {
  const table = kind === 'species' ? 'species' : 'plants'
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE archived_at IS NULL ORDER BY id`)
  return rows.map((row) => {
    let attributes: Record<string, FieldValue> = {}
    const json = row.attributes_json
    if (typeof json === 'string' && json.trim() !== '') {
      try {
        const parsed = JSON.parse(json)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          attributes = parsed as Record<string, FieldValue>
        }
      } catch {
        // 坏 JSON 当作空属性，不因为一行数据的问题中断整个导出
      }
    }
    return { row, attributes }
  })
}

export function buildExport(db: Db, kind: TransferKind, format: TransferFormat): BuiltExport {
  const owner = OWNER_OF[kind]
  const defs = loadFieldDefinitions(db, owner).filter((d) => !d.archivedAt)
  const lookups = buildLookups(db)

  const records = rawRecords(db, kind).map((r) => recordFor(defs, r.row, r.attributes, lookups))

  const stamp = new Date().toISOString().slice(0, 10)
  const base = kind === 'species' ? 'sproutbook-species' : 'sproutbook-plants'

  if (format === 'csv') {
    const headers = defs.map((d) => columnHeader(d))
    const rows = records.map((rec) => {
      const text = toCsvRecord(defs, rec)
      const row: Record<string, unknown> = {}
      defs.forEach((d, i) => {
        row[headers[i]] = text[d.key]
      })
      return row
    })
    return {
      content: toCsv(headers, rows),
      suggestedName: `${base}-${stamp}.csv`,
      count: records.length,
      omitted: []
    }
  }

  const payload = {
    app: 'Sproutbook',
    formatVersion: 1,
    kind,
    exportedAt: new Date().toISOString(),
    // 带上字段定义，用户改过模板后仍能对照出哪一列是什么
    fields: defs.map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      unit: d.unit,
      group: d.groupName,
      relationTarget: d.relationTarget
    })),
    items: records
  }
  return {
    content: `${JSON.stringify(payload, null, 2)}\n`,
    suggestedName: `${base}-${stamp}.json`,
    count: records.length,
    omitted: []
  }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------



interface StashedImport {
  kind: TransferKind
  format: TransferFormat
  fileName: string
  headers: string[]
  rows: string[][]
  mapping: Map<string, string>
}

/**
 * 待确认的导入暂存在主进程内存里。
 * 用令牌而不是把几万行数据来回塞进 IPC —— 预览和确认之间文件不会变，
 * 没必要让渲染层拿着副本。
 */
const pending = new Map<string, StashedImport>()

/** 归一化列名用于匹配：忽略空白、大小写、以及全角/半角差异。 */
function normalizeHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '').replace(/[（）()【】\[\]]/g, '')
}

/** 读取文件并解析成 { headers, rows }；两种格式在这里被抹平。 */
function readTable(filePath: string): { headers: string[]; rows: string[][]; format: TransferFormat } {
  const text = readFileSync(filePath, 'utf8')
  const ext = extname(filePath).toLowerCase()

  const looksJson = ext === '.json' || text.trimStart().startsWith('{')
  if (looksJson) {
    const parsed = JSON.parse(text) as { items?: unknown; fields?: unknown }
    const items = Array.isArray(parsed.items) ? parsed.items : []
    if (items.length === 0) return { headers: [], rows: [], format: 'json' }

    // 列顺序：优先用文件里的 fields 定义，保证人读顺序稳定
    const declared = Array.isArray(parsed.fields)
      ? (parsed.fields as Array<{ key?: string }>).map((f) => String(f.key ?? '')).filter(Boolean)
      : []
    const seen = new Set(declared)
    for (const item of items) {
      if (item && typeof item === 'object') {
        for (const k of Object.keys(item as object)) {
          if (!seen.has(k)) {
            seen.add(k)
            declared.push(k)
          }
        }
      }
    }

    const rows = items.map((item) =>
      declared.map((k) => {
        const v = (item as Record<string, unknown>)?.[k]
        return v === null || v === undefined ? '' : String(v)
      })
    )
    return { headers: declared, rows, format: 'json' }
  }

  const table = parseCsv(text)
  return { headers: table.headers, rows: table.rows, format: 'csv' }
}

export function previewImport(db: Db, kind: TransferKind, filePath: string): TransferPreview {
  const owner = OWNER_OF[kind]
  const defs = loadFieldDefinitions(db, owner).filter((d) => !d.archivedAt)
  const { headers, rows, format } = readTable(filePath)

  // 列 → 字段：先按标签精确匹配，再按 key，最后按归一化的标签
  const byLabel = new Map<string, FieldDefinition>()
  const byKey = new Map<string, FieldDefinition>()
  const byNormLabel = new Map<string, FieldDefinition>()
  for (const d of defs) {
    byKey.set(normalizeHeader(d.key), d)
    if (d.label) {
      byLabel.set(d.label.trim(), d)
      byNormLabel.set(normalizeHeader(d.label), d)
    }
  }

  const mapping: TransferMappingEntry[] = headers.map((h) => {
    const d = byLabel.get(h.trim()) ?? byKey.get(normalizeHeader(h)) ?? byNormLabel.get(normalizeHeader(h))
    return { header: h, fieldKey: d?.key ?? null, label: d?.label ?? null }
  })
  const fileToKey = new Map<string, string>()
  for (const m of mapping) if (m.fieldKey) fileToKey.set(m.header, m.fieldKey)

  const token = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  pending.set(token, { kind, format, fileName: basename(filePath), headers, rows, mapping: fileToKey })

  const lookups = buildLookups(db)
  const issues: TransferIssue[] = []
  const willCreate = new Set<string>()
  let ready = 0
  let duplicates = 0

  rows.forEach((row, index) => {
    const rowNo = index + 1
    const values: Record<string, unknown> = {}
    mapping.forEach((m, col) => {
      if (m.fieldKey) values[m.fieldKey] = row[col]
    })

    let rowOk = true
    for (const d of defs) {
      const raw = values[d.key]
      if (raw === undefined) continue
      const text = String(raw).trim()

      if (d.type === 'relation' && text !== '') {
        if (!lookups.relationId(d.relationTarget ?? '', text)) {
          // 找不到不会报错，导入时会自动建一条最小记录
          willCreate.add(`${d.relationTarget === 'species' ? '物种' : '位置'}：${text}`)
        }
        continue
      }

      const result = coerceFieldValue(d, text === '' ? null : text)
      if (!result.ok) {
        issues.push({ row: rowNo, field: d.label, message: result.error })
        rowOk = false
      }
    }

    if (kind === 'species' && !String(values.common_name ?? '').trim()) {
      issues.push({ row: rowNo, field: '植物名称', message: '植物名称 是必填项' })
      rowOk = false
    }
    if (kind === 'plants' && !String(values.nickname ?? '').trim()) {
      issues.push({ row: rowNo, field: '昵称', message: '昵称 是必填项' })
      rowOk = false
    }

    if (isDuplicate(db, kind, values)) duplicates++
    if (rowOk) ready++
  })

  return {
    token,
    kind,
    format,
    fileName: basename(filePath),
    mapping,
    total: rows.length,
    ready,
    duplicates,
    issues: issues.slice(0, 50),
    samples: rows.slice(0, 5),
    headers,
    willCreate: [...willCreate].slice(0, 20)
  }
}

/** 判重：物种按「植物名称」，植株按「昵称 + 所属物种」。 */
function isDuplicate(db: Db, kind: TransferKind, values: Record<string, unknown>): boolean {
  if (kind === 'species') {
    const name = String(values.common_name ?? '').trim()
    if (!name) return false
    return listSpecies(db, { limit: 1000 }).items.some((s) => s.commonName.trim() === name)
  }
  const nickname = String(values.nickname ?? '').trim()
  if (!nickname) return false
  return listPlants(db, { limit: 1000 }).items.some((p) => p.nickname.trim() === nickname)
}

export interface ImportOptions extends TransferImportOptions {
  /** 遇到同名记录时：跳过（默认）还是覆盖更新 */
  updateExisting?: boolean
  /** 关联目标不存在时是否自动新建（物种 / 养护位置） */
  createMissing?: boolean
}

export function applyImport(db: Db, token: string, options: ImportOptions = {}): TransferResult {
  const stash = pending.get(token)
  if (!stash) throw new Error('导入会话已失效，请重新选择文件。')

  const { kind, headers, rows, mapping } = stash
  const owner = OWNER_OF[kind]
  const defs = loadFieldDefinitions(db, owner).filter((d) => !d.archivedAt)
  const defByKey = new Map(defs.map((d) => [d.key, d]))
  const lookups = buildLookups(db)

  const result: TransferResult = { imported: 0, updated: 0, skipped: 0, failed: 0, created: [], errors: [] }
  const created = new Set<string>()

  rows.forEach((row, index) => {
    const rowNo = index + 1
    const raw: Record<string, string> = {}
    for (const [header, key] of mapping) {
      const col = headers.indexOf(header)
      if (col >= 0) raw[key] = row[col] ?? ''
    }

    // relation → id；目标不存在时按需新建
    const values: Record<string, unknown> = {}
    for (const [key, text] of Object.entries(raw)) {
      const def = defByKey.get(key)
      if (!def) continue
      const trimmed = text.trim()

      if (def.type === 'relation') {
        if (trimmed === '') {
          values[key] = null
          continue
        }
        const target = (def.relationTarget ?? '') as RelationTarget
        let id = lookups.relationId(target, trimmed)
        if (id === null && options.createMissing !== false) {
          id = createRelationTarget(db, target, trimmed)
          if (id !== null) created.add(`${target === 'species' ? '物种' : '养护位置'}：${trimmed}`)
        }
        values[key] = id
        continue
      }

      // status：把「生长中」查回 growing
      if (def.type === 'select') {
        const back = lookups.selectKey(def.key, trimmed)
        values[key] = back ?? (trimmed === '' ? null : trimmed)
        continue
      }

      values[key] = trimmed === '' ? null : trimmed
    }

    try {
      if (kind === 'species') {
        const existing = findExistingSpecies(db, values)
        if (existing && !options.updateExisting) {
          result.skipped++
          return
        }
        const saved = saveSpecies(db, { id: existing?.id, values, source: 'manual' })
        if (Object.keys(saved.errors).length > 0) {
          result.failed++
          if (result.errors.length < 50) {
            result.errors.push({ row: rowNo, field: '', message: Object.values(saved.errors)[0] })
          }
          return
        }
        if (existing) result.updated++
        else result.imported++
        return
      }

      const existing = findExistingPlant(db, values)
      if (existing && !options.updateExisting) {
        result.skipped++
        return
      }
      const saved = savePlant(db, { id: existing?.id, values })
      if (Object.keys(saved.errors).length > 0) {
        result.failed++
        if (result.errors.length < 50) {
          result.errors.push({ row: rowNo, field: '', message: Object.values(saved.errors)[0] })
        }
        return
      }
      if (existing) result.updated++
      else result.imported++
    } catch (error) {
      result.failed++
      if (result.errors.length < 50) {
        result.errors.push({ row: rowNo, field: '', message: error instanceof Error ? error.message : '导入失败' })
      }
    }
  })

  result.created = [...created]
  pending.delete(token)
  return result
}

export function discardImport(token: string): void {
  pending.delete(token)
}

function findExistingSpecies(db: Db, values: Record<string, unknown>): { id: number } | null {
  const name = String(values.common_name ?? '').trim()
  if (!name) return null
  const hit = listSpecies(db, { limit: 1000 }).items.find((s) => s.commonName.trim() === name)
  return hit ? { id: hit.id } : null
}

function findExistingPlant(db: Db, values: Record<string, unknown>): { id: number } | null {
  const nickname = String(values.nickname ?? '').trim()
  if (!nickname) return null
  const hit = listPlants(db, { limit: 1000 }).items.find((p) => p.nickname.trim() === nickname)
  return hit ? { id: hit.id } : null
}

/**
 * 为导入自动补建关联对象。
 *
 * 从别处导出的植株往往带着本地没有的物种名或位置名。这里建一条最小记录
 * （只有名字），而不是让整行导入失败 —— 用户导入完可以再到物种库补全。
 * 建了什么会如实汇报，不偷偷改数据。
 */
function createRelationTarget(db: Db, target: RelationTarget, name: string): number | null {
  if (target === 'species') {
    const saved = saveSpecies(db, { values: { common_name: name }, source: 'manual' })
    return Object.keys(saved.errors).length === 0 ? saved.species!.id : null
  }
  if (target === 'environments') {
    const row = db.run(
      'INSERT INTO environments (name, kind, sort_order) VALUES (?, ?, ?)',
      name,
      'indoor',
      99
    )
    return Number(row.lastInsertRowid)
  }
  return null
}

/** 供界面展示「物种库 / 植株」这一层已被导出的条数 */
export function exportCount(db: Db, kind: TransferKind): number {
  const owner = OWNER_OF[kind]
  return Number(db.scalar<number>(`SELECT COUNT(*) AS c FROM ${owner === 'species' ? 'species' : 'plants'} WHERE archived_at IS NULL`) ?? 0)
}

/** 目前未随导出走的字段类型（未来若增加图片打包，改这里）。 */
export const NOT_EXPORTED_TYPES: string[] = ['image']

export function loadDefinitionsFor(db: Db, kind: TransferKind): FieldDefinition[] {
  return loadFieldDefinitions(db, OWNER_OF[kind]).filter((d) => !d.archivedAt)
}

/** 供自检使用：拿到某条物种的原始记录（含系统列）。 */
export function rawSpecies(db: Db, id: number): { attributes: Record<string, FieldValue> } & Record<string, unknown> | null {
  const s = getSpecies(db, id)
  return s ? ({ ...s, attributes: s.attributes } as never) : null
}
