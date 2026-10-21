/**
 * 物种库仓储（知识层）。
 *
 * 不变量：主记录与 attr_index 投影必须在同一事务内更新，
 * 否则「列表筛选」和「详情显示」会出现不一致。
 */

import type { Db } from '../connection'
import type { FieldValue, Species } from '../../../core/types'
import { buildSearchBlob, requiredErrors, splitAttributes } from '../../../core/attributes'
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
  /**
   * AI 填过、尚未人工核实的**安全**字段。
   *
   * 只有安全字段需要核实 —— 学名、科属这类填错了也不会有危险，
   * 不该让列表页一直挂着「待核实」的角标。所以这里在仓储层就算好，
   * 而不是让界面自己去猜哪些算安全字段。
   */
  pendingSafetyFields: string[]
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

  // 安全字段清单只查一次，避免逐行查询
  const safetyKeys = speciesSafetyKeys(db)

  const items = rows.map((row) => {
    const plantCount = Number(
      db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE species_id = ? AND archived_at IS NULL', row.id) ?? 0
    )
    const mapped = mapSpecies(row)
    return {
      ...mapped,
      coverThumb: row.cover_thumb ?? null,
      coverPath: row.cover_path ?? null,
      plantCount,
      pendingSafetyFields: filterPendingSafety(mapped, safetyKeys)
    }
  })

  return { items, total }
}

/**
 * 「AI 填过但还没核实的**安全**字段」。
 *
 * 抽成纯函数是为了让列表页、详情页、空记录三处口径一致 ——
 * 之前列表和详情各算各的，条件还不一样，界面自然会互相矛盾。
 */
function filterPendingSafety(species: Species, safetyKeys: Set<string>): string[] {
  return Object.keys(species.confidence).filter(
    (k) => safetyKeys.has(k) && !species.verifiedFields.includes(k)
  )
}

/** 物种模板里的安全字段标识。列表页只查一次，避免逐行查询。 */
function speciesSafetyKeys(db: Db): Set<string> {
  return new Set(
    db
      .all<{ key: string }>("SELECT key FROM field_definitions WHERE owner_kind = 'species' AND is_safety = 1")
      .map((r) => r.key)
  )
}

export function getSpecies(db: Db, id: number): SpeciesListItem | null {
  const row = db.get<SpeciesRow>(`${SELECT_BASE} WHERE s.id = ?`, id)
  if (!row) return null
  const plantCount = Number(
    db.scalar<number>('SELECT COUNT(*) AS c FROM plants WHERE species_id = ? AND archived_at IS NULL', id) ?? 0
  )
  const mapped = mapSpecies(row)
  return {
    ...mapped,
    coverThumb: row.cover_thumb ?? null,
    coverPath: row.cover_path ?? null,
    plantCount,
    pendingSafetyFields: filterPendingSafety(mapped, speciesSafetyKeys(db))
  }
}

export interface SaveSpeciesResult {
  /**
   * 保存后的物种；**失败时为 null**。
   * 界面必须判断它 —— 不然会拿着 null 去 setState 然后报「已保存」。
   */
  species: SpeciesListItem | null
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
        // 校验没过就别递一个 id:0 的假物种回去 —— null 才是实话
        species: existing,
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

    /*
     * 重名检查。
     *
     * 物种是"一个物种一条记录"，同名两条会让规则、封面、搜索全部对不上 ——
     * 而且用户很难自己发现：列表里两行字一样，只能靠记忆。
     *
     * 比的是 trim + 忽略大小写之后的名字，忽略已归档的记录，自己不算重复。
     * 报错挂在 common_name 字段上，表单会把它显示在那一格下面。
     */
    if (name) {
      const dup = db.get<{ id: number; archived_at: string | null }>(
        'SELECT id, archived_at FROM species WHERE lower(trim(common_name)) = lower(?) AND id != ? LIMIT 1',
        name,
        id ?? 0
      )
      if (dup && dup.archived_at === null) {
        return {
          species: id ? getSpecies(db, id) : null,
          errors: {
            common_name: `已经有叫「${name}」的物种了。重名会让规则、封面、搜索都对不上；` +
              '如果是同一种的另一个叫法，去那一条里加「别名」。'
          },
          pendingReview: []
        }
      }
    }

    /*
     * 必填校验走模板定义，而不是硬编码某个字段名。
     * 之前只检查 common_name，用户在「信息模板」里标的「必填」形同虚设。
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
      return {
        // 同上：拿不到就是拿不到
        species: id ? getSpecies(db, id) : null,
        errors: requiredIssues,
        pendingReview: []
      }
    }

    const aliases = String(col.aliases_json ?? existingRow?.aliases_json ?? '[]')
    const scientificName = (col.scientific_name as string | undefined) ?? existingRow?.scientific_name ?? null
    const family = (col.family as string | undefined) ?? existingRow?.family ?? null
    const genus = (col.genus as string | undefined) ?? existingRow?.genus ?? null

    /*
     * 用 core 里的那一份，不再自己维护一个副本。
     *
     * 两份**已经漂移了**：core 版对每个字段走 formatFieldValue（**带单位**，
     * 例如「25 cm」），repo 这份用 String(v) 把单位丢了；core 版遍历全部字段，
     * repo 这份跳过列字段、把名称/别名/学名/科/属手工拼在前面。
     *
     * 合并方向是「用 core 那份 + 把系统列当 extra 传进去」——
     * 列字段会被遍历到两次，对一个搜索用的文本串无害，而带上单位是有益的。
     */
    const searchBlob = buildSearchBlob(defs, mergedAttrs, [
      name,
      ...jsonArray(aliases),
      scientificName ?? '',
      family ?? '',
      genus ?? ''
    ])

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
      const r = db.run(
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
      /*
       * **检查影响行数。**
       *
       * 目标行不存在时这里是 0 行受影响，SQLite 不报错；接着 getSpecies 返回 null，
       * 由下面的 `?? emptySpecies()` 递回一个 id:0 / 空名、**看起来完全正常**的对象，
       * 编辑器照单全收：标题变成「未命名」，还弹绿色的「已保存」。
       *
       * 这正是「改了却看不出改了什么」那类问题的来源。
       * 植株那边（savePlant）本来就有 null 分支，物种这边漏了 —— 同一个问题修了一半。
       */
      if (Number(r.changes) === 0) {
        return {
          species: null,
          errors: { common_name: '这条物种已不存在，可能已被删除。请返回列表刷新后再试。' },
          pendingReview: []
        }
      }
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

/**
 * 标记（或取消标记）某些字段已由人工确认 —— AI 填充后的信任闭环。
 *
 * verified=false 用于「点错了想撤回」：核实是个人的判断，
 * 必须能反悔，否则用户只能重新录入整条记录。
 */
export function verifySpeciesFields(
  db: Db,
  id: number,
  fieldKeys: string[],
  verified = true
): Species | null {
  return db.transaction(() => {
    const row = db.get<SpeciesRow>('SELECT * FROM species WHERE id = ?', id)
    if (!row) return null
    const current = new Set(jsonArray(row.verified_json))
    for (const k of fieldKeys) {
      if (verified) current.add(k)
      else current.delete(k)
    }
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
    plantCount: 0,
    pendingSafetyFields: []
  }
}

export { mapFieldDefinition }
export type { FieldDefinitionRow }
