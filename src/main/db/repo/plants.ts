/**
 * 植株仓储（实例层）—— 用户实际养的那一株。
 */

import type { Db } from '../connection'
import type { FieldValue, Plant, PlantStatus, PlantWithSpecies } from '../../../core/types'
import { requiredErrors, splitAttributes } from '../../../core/attributes'
import { jsonObject, likeParam, loadFieldDefinitions, writeAttrIndex } from './common'

export interface PlantRow {
  id: number
  species_id: number | null
  nickname: string
  env_id: number | null
  status: string
  acquired_at: string | null
  pot_size: string | null
  substrate_recipe_id: number | null
  cover_image_id: number | null
  attributes_json: string
  notes: string | null
  search_blob: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface PlantListRow extends PlantRow {
  species_name: string | null
  species_scientific: string | null
  species_family: string | null
  env_name: string | null
  cover_thumb: string | null
}

const SELECT_BASE = `
  SELECT p.*,
    s.common_name     AS species_name,
    s.scientific_name AS species_scientific,
    s.family          AS species_family,
    e.name            AS env_name,
    /*
     * 封面，三级兜底：
     *   1. 用户在这一株里指定的那张（plants.cover_image_id）
     *   2. 这一株自己最早导入的一张
     *   3. **物种图库里的第一张** —— 同物种的花长得一样，一株株设封面太麻烦；
     *      只是显示时借用，不复制文件、也不写入这一株的图片列表
     */
    COALESCE(
      (SELECT thumb_path FROM images WHERE id = p.cover_image_id),
      (SELECT thumb_path FROM images WHERE plant_id = p.id ORDER BY sort_order, id LIMIT 1),
      (SELECT thumb_path FROM images WHERE species_id = p.species_id ORDER BY sort_order, id LIMIT 1)
    ) AS cover_thumb
  FROM plants p
  LEFT JOIN species s      ON s.id = p.species_id
  LEFT JOIN environments e ON e.id = p.env_id
`

function mapPlant(row: PlantRow): Plant {
  return {
    id: row.id,
    speciesId: row.species_id,
    nickname: row.nickname,
    envId: row.env_id,
    status: row.status as PlantStatus,
    acquiredAt: row.acquired_at,
    potSize: row.pot_size,
    attributes: jsonObject(row.attributes_json),
    notes: row.notes,
    coverImageId: row.cover_image_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

export interface PlantListItem extends PlantWithSpecies {
  envName: string | null
  coverThumb: string | null
}

export function mapPlantListItem(row: PlantListRow): PlantListItem {
  const base = mapPlant(row)
  return {
    ...base,
    species: row.species_id
      ? {
          id: row.species_id,
          commonName: row.species_name ?? '',
          scientificName: row.species_scientific,
          family: row.species_family,
          aliases: []
        }
      : null,
    envName: row.env_name,
    coverThumb: row.cover_thumb,
    coverImagePath: row.cover_thumb
  }
}

export interface PlantListOptions {
  query?: string
  status?: PlantStatus
  envId?: number
  speciesId?: number
  limit?: number
  offset?: number
}

export function listPlants(db: Db, options: PlantListOptions = {}): { items: PlantListItem[]; total: number } {
  const where: string[] = ['p.archived_at IS NULL']
  const params: Array<string | number> = []

  if (options.query && options.query.trim()) {
    where.push("p.search_blob LIKE ? ESCAPE '\\'")
    params.push(likeParam(options.query.trim()))
  }
  if (options.status) {
    where.push('p.status = ?')
    params.push(options.status)
  }
  if (typeof options.envId === 'number') {
    where.push('p.env_id = ?')
    params.push(options.envId)
  }
  if (typeof options.speciesId === 'number') {
    where.push('p.species_id = ?')
    params.push(options.speciesId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 300, 1), 1000)
  const offset = Math.max(options.offset ?? 0, 0)

  const total = Number(db.scalar<number>(`SELECT COUNT(*) AS c FROM plants p ${whereSql}`, ...params) ?? 0)
  const rows = db.all<PlantListRow>(
    `${SELECT_BASE} ${whereSql} ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  )
  return { items: rows.map(mapPlantListItem), total }
}

export function getPlant(db: Db, id: number): PlantListItem | null {
  const row = db.get<PlantListRow>(`${SELECT_BASE} WHERE p.id = ?`, id)
  return row ? mapPlantListItem(row) : null
}

export interface SavePlantInput {
  id?: number
  speciesId?: number | null
  values: Record<string, unknown>
  notes?: string | null
  status?: PlantStatus
  envId?: number | null
  /** 显式指定昵称（也允许通过 values.nickname 传入） */
  nickname?: string
}

export interface SavePlantResult {
  plant: PlantListItem | null
  errors: Record<string, string>
}

/**
 * 指定封面：用哪张照片当这一株的封面。传 null 表示回到默认（最早那张）。
 *
 * 只接受**属于这株**的图片；否则一张别的植株的照片可能被设成封面。
 */
export function setPlantCover(db: Db, plantId: number, imageId: number | null): boolean {
  if (imageId === null) {
    const r = db.run('UPDATE plants SET cover_image_id = NULL, updated_at = ? WHERE id = ?', new Date().toISOString(), plantId)
    return Number(r.changes) > 0
  }
  const belongs = db.get<{ id: number }>('SELECT id FROM images WHERE id = ? AND plant_id = ?', imageId, plantId)
  if (!belongs) throw new Error('这张图片不属于这株植物')
  const r = db.run('UPDATE plants SET cover_image_id = ?, updated_at = ? WHERE id = ?', imageId, new Date().toISOString(), plantId)
  return Number(r.changes) > 0
}

export function savePlant(db: Db, input: SavePlantInput): SavePlantResult {
  return db.transaction(() => {
    const defs = loadFieldDefinitions(db, 'plant', true)
    const { split, errors } = splitAttributes(defs, input.values)
    if (Object.keys(errors).length > 0) {
      return { plant: input.id ? getPlant(db, input.id) : null, errors }
    }

    const id = input.id ?? null
    const existingRow = id ? db.get<PlantRow>('SELECT * FROM plants WHERE id = ?', id) : null
    const existingAttrs = jsonObject(existingRow?.attributes_json)

    const mergedAttrs: Record<string, FieldValue> = { ...existingAttrs }
    for (const [k, v] of Object.entries(split.attributes)) {
      if (v === null) delete mergedAttrs[k]
      else mergedAttrs[k] = v
    }

    const col = split.columns
    const nickname = String(
      input.nickname ?? col.nickname ?? existingRow?.nickname ?? ''
    ).trim()

    /*
     * 必填校验：对**合并后的最终值**检查，而不是只看本次提交的字段。
     *
     * 之前只硬编码校验了 nickname，于是用户在「信息模板」里把任何字段标成
     * 「必填」都不生效 —— 界面承诺了、程序没执行。现在统一走模板定义。
     * 读取器要同时覆盖两条存储路径：系统字段在独立列里，其余在 attributes_json。
     */
    const finalValue = (def: (typeof defs)[number]): FieldValue | undefined => {
      if (def.columnName) {
        const v = def.columnName in col ? col[def.columnName] : (existingRow as Record<string, unknown> | null)?.[def.columnName]
        return (v ?? null) as FieldValue
      }
      return mergedAttrs[def.key]
    }

    const requiredIssues = requiredErrors(defs, finalValue)
    if (Object.keys(requiredIssues).length > 0) {
      return { plant: id ? getPlant(db, id) : null, errors: requiredIssues }
    }

    /*
     * 取值优先级：显式参数 → 模板字段写进列的值 → 数据库里的原值。
     *
     * 「所属物种 / 养护位置 / 状态」现在是模板字段（relation / select），
     * 值经 splitAttributes 落到 columns 里。如果这里只看 input.*，
     * 用户在表单里改这三项就会被无声忽略 —— 所以必须把 col 也纳入。
     * 显式参数保留是为了向后兼容（例如从物种库「添加一株」时预置物种）。
     */
    const fromCol = (key: string): unknown => (key in col ? col[key] : undefined)

    const speciesId =
      input.speciesId !== undefined
        ? input.speciesId
        : ((fromCol('species_id') as number | null | undefined) ?? existingRow?.species_id ?? null)
    const envId =
      input.envId !== undefined
        ? input.envId
        : ((fromCol('env_id') as number | null | undefined) ?? existingRow?.env_id ?? null)
    const status =
      input.status ??
      ((fromCol('status') as PlantStatus | undefined) ?? (existingRow?.status as PlantStatus | undefined) ?? 'growing')
    const acquiredAt = (col.acquired_at as string | undefined) ?? existingRow?.acquired_at ?? null
    const potSize = (col.pot_size as string | undefined) ?? existingRow?.pot_size ?? null
    const notes = input.notes !== undefined ? input.notes : (existingRow?.notes ?? null)

    const speciesName = speciesId
      ? (db.scalar<string>('SELECT common_name FROM species WHERE id = ?', speciesId) ?? '')
      : ''
    const searchBlob = [nickname, speciesName, notes ?? '', potSize ?? '']
      .concat(Object.values(mergedAttrs).map((v) => (Array.isArray(v) ? v.join(' ') : String(v ?? ''))))
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()

    let savedId = id
    if (savedId) {
      db.run(
        `UPDATE plants SET species_id=?, nickname=?, env_id=?, status=?, acquired_at=?, pot_size=?,
           attributes_json=?, notes=?, search_blob=?, updated_at=datetime('now')
         WHERE id=?`,
        speciesId,
        nickname,
        envId,
        status,
        acquiredAt,
        potSize,
        JSON.stringify(mergedAttrs),
        notes,
        searchBlob,
        savedId
      )
    } else {
      const r = db.run(
        `INSERT INTO plants (species_id, nickname, env_id, status, acquired_at, pot_size, attributes_json, notes, search_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        speciesId,
        nickname,
        envId,
        status,
        acquiredAt,
        potSize,
        JSON.stringify(mergedAttrs),
        notes,
        searchBlob
      )
      savedId = Number(r.lastInsertRowid)
    }

    writeAttrIndex(db, 'plant', savedId, mergedAttrs, defs)
    return { plant: getPlant(db, savedId), errors: {} }
  })
}

export function archivePlant(db: Db, id: number): boolean {
  const r = db.run("UPDATE plants SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

export interface PlantStats {
  total: number
  byStatus: Array<{ status: string; count: number }>
  byEnv: Array<{ envId: number | null; envName: string; count: number }>
  byFamily: Array<{ family: string; count: number }>
  bloomingThisMonth: number
}

export function plantStats(db: Db, month = new Date().getMonth() + 1): PlantStats {
  const total = Number(db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE archived_at IS NULL') ?? 0)

  const byStatus = db
    .all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM plants WHERE archived_at IS NULL GROUP BY status ORDER BY count DESC`
    )
    .map((r) => ({ status: r.status, count: Number(r.count) }))

  const byEnv = db
    .all<{ env_id: number | null; env_name: string | null; count: number }>(
      `SELECT p.env_id, e.name AS env_name, COUNT(*) AS count
       FROM plants p LEFT JOIN environments e ON e.id = p.env_id
       WHERE p.archived_at IS NULL GROUP BY p.env_id ORDER BY count DESC`
    )
    .map((r) => ({ envId: r.env_id, envName: r.env_name ?? '未分配位置', count: Number(r.count) }))

  const byFamily = db
    .all<{ family: string; count: number }>(
      `SELECT COALESCE(NULLIF(TRIM(s.family), ''), '未分类') AS family, COUNT(*) AS count
       FROM plants p JOIN species s ON s.id = p.species_id
       WHERE p.archived_at IS NULL GROUP BY family ORDER BY count DESC`
    )
    .map((r) => ({ family: r.family, count: Number(r.count) }))

  // 「本月开花」直接命中 attr_index，不需要扫描 JSON —— 这正是投影表的价值
  const bloomingThisMonth = Number(
    db.scalar<number>(
      `SELECT COUNT(DISTINCT p.id) AS c
       FROM plants p
       JOIN attr_index a ON a.owner_kind = 'species' AND a.owner_id = p.species_id
       WHERE p.archived_at IS NULL AND a.field_key = 'bloom_months' AND a.value_num = ?`,
      month
    ) ?? 0
  )

  return { total, byStatus, byEnv, byFamily, bloomingThisMonth }
}
