/**
 * 物种库仓储（知识层）。
 *
 * 不变量：主记录与 attr_index 投影必须在同一事务内更新，
 * 否则「列表筛选」和「详情显示」会出现不一致。
 */

import type { Db } from '../connection'
import type { FieldValue, Species } from '../../../core/types'
import { splitAttributes } from '../../../core/attributes'
import { jsonArray, jsonObject, likeParam, loadFieldDefinitions, mapFieldDefinition, writeAttrIndex } from './common'
import type { FieldDefinitionRow } from './common'

export interface SpeciesRow {
  id: number
  common_name: string
  scientific_name: string | null
  family: string | null
  genus: string | null
  aliases_json: string
  attributes_json: string
  source: string
  confidence_json: string
  verified_json: string
  search_blob: string
  created_at: string
  updated_at: string
  archived_at: string | null
  cover_thumb?: string | null
  cover_path?: string | null
}

const SELECT_BASE = `
  SELECT s.*,
    (SELECT thumb_path FROM images WHERE species_id = s.id ORDER BY sort_order, id LIMIT 1) AS cover_thumb,
    (SELECT path       FROM images WHERE species_id = s.id ORDER BY sort_order, id LIMIT 1) AS cover_path
  FROM species s
`

export function mapSpecies(row: SpeciesRow): Species {
  return {
    id: row.id,
    commonName: row.common_name,
    scientificName: row.scientific_name,
    family: row.family,
    genus: row.genus,
    aliases: jsonArray(row.aliases_json),
    attributes: jsonObject(row.attributes_json),
    source: row.source,
    confidence: jsonObject(row.confidence_json) as unknown as Record<string, number>,
    verifiedFields: jsonArray(row.verified_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface SpeciesListOptions {
  query?: string
  family?: string
  /** 只要「本月开花」：按 bloom_months 投影筛选 */
  bloomMonth?: number
  limit?: number
  offset?: number
}

export interface SpeciesListItem extends Species {
  coverThumb: string | null
  coverPath: string | null
  plantCount: number
}

export function listSpecies(db: Db, options: SpeciesListOptions = {}): { items: SpeciesListItem[]; total: number } {
  const where: string[] = ['s.archived_at IS NULL']
  const params: Array<string | number> = []

  if (options.query && options.query.trim()) {
    where.push("s.search_blob LIKE ? ESCAPE '\\'")
    params.push(likeParam(options.query.trim()))
  }
  if (options.family) {
    where.push('s.family = ?')
    params.push(options.family)
  }
  if (typeof options.bloomMonth === 'number') {
    where.push(
      `EXISTS (SELECT 1 FROM attr_index a WHERE a.owner_kind='species' AND a.owner_id=s.id
               AND a.field_key='bloom_months' AND a.value_num = ?)`
    )
    params.push(options.bloomMonth)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const offset = Math.max(options.offset ?? 0, 0)

  const total = Number(db.scalar<number>(`SELECT COUNT(*) AS c FROM species s ${whereSql}`, ...params) ?? 0)
  const rows = db.all<SpeciesRow & { plant_count: number }>(
    `${SELECT_BASE} ${whereSql}
     ORDER BY s.updated_at DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  )

  const items = rows.map((row) => {
    const plantCount = Number(
      db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE species_id = ? AND archived_at IS NULL', row.id) ?? 0
    )
    return {
      ...mapSpecies(row),
      coverThumb: row.cover_thumb ?? null,
      coverPath: row.cover_path ?? null,
      plantCount
    }
  })

  return { items, total }
}

export function getSpecies(db: Db, id: number): SpeciesListItem | null {
  const row = db.get<SpeciesRow>(`${SELECT_BASE} WHERE s.id = ?`, id)
  if (!row) return null
  const plantCount = Number(
    db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE species_id = ? AND archived_at IS NULL', id) ?? 0
  )
  return { ...mapSpecies(row), coverThumb: row.cover_thumb ?? null, coverPath: row.cover_path ?? null, plantCount }
}

export interface SaveSpeciesResult {
  species: SpeciesListItem
  errors: Record<string, string>
  /** 实际被 AI 之类外部来源写入、且需要人工核实的字段 */
  pendingReview: string[]
}

export function saveSpecies(
  db: Db,
  input: {
    id?: number
    values: Record<string, unknown>
    source?: string
    /** 本次由 AI 填入的字段及其置信度，用于标记「待核实」 */
    aiFields?: Array<{ key: string; confidence: number }>
  },
  origin: 'manual' | 'ai' | 'import' = 'manual'
): SaveSpeciesResult {
  return db.transaction(() => {
    const defs = loadFieldDefinitions(db, 'species', true)
    const { split, errors } = splitAttributes(defs, input.values)

    if (errors && Object.keys(errors).length > 0) {
      const existing = input.id ? getSpecies(db, input.id) : null
      return {
        species: existing ?? emptySpecies(),
        errors,
        pendingReview: []
      }
    }

    const id = input.id ?? null
    const existingRow = id ? db.get<SpeciesRow>('SELECT * FROM species WHERE id = ?', id) : null
    const existingAttrs = jsonObject(existingRow?.attributes_json)

    // 合并：未提交的字段保持原值，显式传 null 表示清空
    const mergedAttrs: Record<string, FieldValue> = { ...existingAttrs }
    for (const [k, v] of Object.entries(split.attributes)) {
      if (v === null) delete mergedAttrs[k]
      else mergedAttrs[k] = v
    }

    const col = split.columns
    const name = String(col.common_name ?? existingRow?.common_name ?? '').trim()
    if (!name) {
      return { species: id ? (getSpecies(db, id) ?? emptySpecies()) : emptySpecies(), errors: { common_name: '植物名称 是必填项' }, pendingReview: [] }
    }

    const aliases = String(col.aliases_json ?? existingRow?.aliases_json ?? '[]')
    const scientificName = (col.scientific_name as string | undefined) ?? existingRow?.scientific_name ?? null
    const family = (col.family as string | undefined) ?? existingRow?.family ?? null
    const genus = (col.genus as string | undefined) ?? existingRow?.genus ?? null

    const searchBlob = buildSearchBlob(name, aliases, scientificName, family, genus, mergedAttrs, defs)

    const source = input.source ?? existingRow?.source ?? origin

    // AI 来源标记：只有「安全字段被 AI 填过」才需要人工核实。
    // 精确到字段而不是整条记录，避免把用户手填的安全信息也标成待核实。
    const aiFields = input.aiFields ?? []
    const confidence = { ...jsonObject(existingRow?.confidence_json) } as Record<string, number>
    for (const item of aiFields) {
      confidence[item.key] = Number.isFinite(item.confidence) ? item.confidence : 0.6
    }
    const pendingReview = aiFields
      .filter((item) => defs.find((d) => d.key === item.key)?.isSafety)
      .map((item) => item.key)

    let savedId = id
    if (savedId) {
      db.run(
        `UPDATE species SET common_name=?, scientific_name=?, family=?, genus=?, aliases_json=?,
           attributes_json=?, source=?, confidence_json=?, search_blob=?, updated_at=datetime('now')
         WHERE id=?`,
        name,
        scientificName,
        family,
        genus,
        aliases,
        JSON.stringify(mergedAttrs),
        source,
        JSON.stringify(confidence),
        searchBlob,
        savedId
      )
    } else {
      const r = db.run(
        `INSERT INTO species (common_name, scientific_name, family, genus, aliases_json, attributes_json, source, confidence_json, search_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name,
        scientificName,
        family,
        genus,
        aliases,
        JSON.stringify(mergedAttrs),
        source,
        JSON.stringify(confidence),
        searchBlob
      )
      savedId = Number(r.lastInsertRowid)
    }

    writeAttrIndex(db, 'species', savedId, mergedAttrs, defs)

    return { species: getSpecies(db, savedId) ?? emptySpecies(), errors: {}, pendingReview }
  })
}

/** 标记某些字段已由人工确认（AI 填充后的信任闭环）。 */
export function verifySpeciesFields(db: Db, id: number, fieldKeys: string[]): Species | null {
  return db.transaction(() => {
    const row = db.get<SpeciesRow>('SELECT * FROM species WHERE id = ?', id)
    if (!row) return null
    const current = new Set(jsonArray(row.verified_json))
    for (const k of fieldKeys) current.add(k)
    db.run('UPDATE species SET verified_json = ?, updated_at = datetime(\'now\') WHERE id = ?', JSON.stringify([...current]), id)
    return mapSpecies(db.get<SpeciesRow>('SELECT * FROM species WHERE id = ?', id) as SpeciesRow)
  })
}

export function archiveSpecies(db: Db, id: number): boolean {
  const used = Number(db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE species_id = ? AND archived_at IS NULL', id) ?? 0)
  if (used > 0) {
    throw new Error(`还有 ${used} 株植物引用该物种，请先移除引用再删除。`)
  }
  db.run("UPDATE species SET archived_at = datetime('now') WHERE id = ?", id)
  return true
}

export function familyStats(db: Db): Array<{ family: string; count: number }> {
  return db
    .all<{ family: string; count: number }>(
      `SELECT COALESCE(NULLIF(TRIM(family), ''), '未分类') AS family, COUNT(*) AS count
       FROM species WHERE archived_at IS NULL
       GROUP BY family ORDER BY count DESC, family ASC`
    )
    .map((r) => ({ family: r.family, count: Number(r.count) }))
}

function buildSearchBlob(
  name: string,
  aliasesJson: string,
  scientificName: string | null,
  family: string | null,
  genus: string | null,
  attributes: Record<string, FieldValue>,
  defs: ReturnType<typeof loadFieldDefinitions>
): string {
  const parts = [name, ...jsonArray(aliasesJson), scientificName ?? '', family ?? '', genus ?? '']
  for (const def of defs) {
    if (def.columnName) continue
    const v = attributes[def.key]
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) parts.push(v.join(' '))
    else if (v !== null && typeof v === 'object') parts.push(Object.values(v as unknown as Record<string, unknown>).join(' '))
    else parts.push(String(v))
  }
  return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function emptySpecies(): SpeciesListItem {
  return {
    id: 0,
    commonName: '',
    scientificName: null,
    family: null,
    genus: null,
    aliases: [],
    attributes: {},
    source: 'manual',
    confidence: {},
    verifiedFields: [],
    createdAt: '',
    updatedAt: '',
    coverThumb: null,
    coverPath: null,
    plantCount: 0
  }
}

export { mapFieldDefinition }
export type { FieldDefinitionRow }
