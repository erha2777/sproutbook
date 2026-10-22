/**
 * 材料与配方仓储。
 *
 * 数据模型上的两个取舍：
 *  1. 条目**整组替换**而不是逐条 diff。配方条目撑死十几条，整组替换的代码
 *     简单到不会错；做增量更新则要处理「哪条删了、哪条改了」，
 *     在这么小的数据量上纯粹是给自己找 bug。
 *  2. 材料删除做**引用保护**：被配方用到的材料只能归档不能删，
 *     否则配方里那一条会变成「（未命名材料）」，用户不知道原来是什么。
 */

import type { Db } from '../connection'
import type { Material, MaterialInput, RecipeInput, RecipeItem, RecipeListItem } from '../../../core/types'
import { summarizeRecipe, validateRecipe } from '../../../core/recipes'

// ---------------------------------------------------------------------------
// 材料库
// ---------------------------------------------------------------------------

interface MaterialRow {
  id: number
  name: string
  kind: string
  unit: string | null
  stock: number | null
  price: number | null
  note: string | null
}

function mapMaterial(row: MaterialRow): Material {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Material['kind'],
    unit: row.unit,
    stock: row.stock ?? null,
    price: row.price ?? null,
    note: row.note
  }
}

export function listMaterials(db: Db, query?: string): Material[] {
  if (query && query.trim()) {
    // 名称与备注都搜，方便「我上次记的那种颗粒土叫什么来着」
    const like = `%${query.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`
    return db
      .all<MaterialRow>(
        "SELECT * FROM materials WHERE name LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' ORDER BY kind, name",
        like,
        like
      )
      .map(mapMaterial)
  }
  return db.all<MaterialRow>('SELECT * FROM materials ORDER BY kind, name').map(mapMaterial)
}

export function getMaterial(db: Db, id: number): Material | null {
  const row = db.get<MaterialRow>('SELECT * FROM materials WHERE id = ?', id)
  return row ? mapMaterial(row) : null
}

export function saveMaterial(db: Db, input: MaterialInput): Material {
  const name = input.name.trim()
  if (!name) throw new Error('材料名称不能为空')

  // name 列有 UNIQUE 约束：重名时给出人话，而不是把 SQLite 的原文抛给用户
  const clash = db.get<{ id: number }>('SELECT id FROM materials WHERE name = ? AND id IS NOT ?', name, input.id ?? null)
  if (clash) throw new Error(`已经有叫「${name}」的材料了`)

  if (input.id) {
    db.run(
      'UPDATE materials SET name = ?, kind = ?, unit = ?, stock = ?, price = ?, note = ? WHERE id = ?',
      name,
      input.kind,
      input.unit,
      input.stock ?? null,
      input.price ?? null,
      input.note,
      input.id
    )
    const updated = getMaterial(db, input.id)
    if (!updated) throw new Error('材料更新失败')
    return updated
  }

  const r = db.run(
    'INSERT INTO materials (name, kind, unit, stock, price, note) VALUES (?, ?, ?, ?, ?, ?)',
    name,
    input.kind,
    input.unit,
    input.stock ?? null,
    input.price ?? null,
    input.note
  )
  const created = getMaterial(db, Number(r.lastInsertRowid))
  if (!created) throw new Error('材料创建失败')
  return created
}

/** 有多少个配方在用这个材料。 */
export function materialUsage(db: Db, id: number): number {
  return Number(
    db.scalar<number>('SELECT COUNT(DISTINCT recipe_id) AS c FROM recipe_items WHERE material_id = ?', id) ?? 0
  )
}

export function deleteMaterial(db: Db, id: number): boolean {
  const used = materialUsage(db, id)
  if (used > 0) {
    throw new Error(`还有 ${used} 个配方在用这个材料，删掉会让那些配方缺一项。请先改配方，或保留它。`)
  }
  const r = db.run('DELETE FROM materials WHERE id = ?', id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

// ---------------------------------------------------------------------------
// 配方
// ---------------------------------------------------------------------------

interface RecipeRow {
  id: number
  name: string
  kind: string
  note: string | null
  available: number
  created_at: string
  archived_at: string | null
}

interface RecipeItemRow {
  id: number
  recipe_id: number
  material_id: number | null
  name: string | null
  ratio_part: number | null
  amount: number | null
  unit: string | null
  note: string | null
  sort_order: number
}

function mapItem(row: RecipeItemRow): RecipeItem {
  return {
    id: row.id,
    materialId: row.material_id,
    name: row.name,
    ratioPart: row.ratio_part,
    amount: row.amount,
    unit: row.unit,
    note: row.note,
    sortOrder: row.sort_order
  }
}

function loadItems(db: Db, recipeId: number): RecipeItem[] {
  return db
    .all<RecipeItemRow>('SELECT * FROM recipe_items WHERE recipe_id = ? ORDER BY sort_order, id', recipeId)
    .map(mapItem)
}

function materialNameMap(db: Db): Map<number, string> {
  const map = new Map<number, string>()
  for (const row of db.all<{ id: number; name: string }>('SELECT id, name FROM materials')) {
    map.set(row.id, row.name)
  }
  return map
}

function mapRecipe(db: Db, row: RecipeRow, names: Map<number, string>): RecipeListItem {
  const items = loadItems(db, row.id)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    note: row.note,
    available: row.available === 1,
    items,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    summary: summarizeRecipe(items, names)
  }
}

export interface RecipeListOptions {
  query?: string
  kind?: string
  includeArchived?: boolean
}

export function listRecipes(db: Db, options: RecipeListOptions = {}): RecipeListItem[] {
  const where: string[] = []
  const params: Array<string | number> = []

  if (!options.includeArchived) where.push('archived_at IS NULL')
  if (options.kind) {
    where.push('kind = ?')
    params.push(options.kind)
  }
  if (options.query && options.query.trim()) {
    // 名称、类型、说明、以及材料名都参与搜索：
    // 用户常按「珍珠岩」找配方，而材料名在另一张表里
    const like = `%${options.query.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`
    where.push(
      `(name LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM recipe_items ri
                   LEFT JOIN materials m ON m.id = ri.material_id
                   WHERE ri.recipe_id = recipes.id
                     AND (m.name LIKE ? ESCAPE '\\' OR ri.name LIKE ? ESCAPE '\\')))`
    )
    params.push(like, like, like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.all<RecipeRow>(`SELECT * FROM recipes ${whereSql} ORDER BY kind, name, id`, ...params)
  const names = materialNameMap(db)
  return rows.map((row) => mapRecipe(db, row, names))
}

export function getRecipe(db: Db, id: number): RecipeListItem | null {
  const row = db.get<RecipeRow>('SELECT * FROM recipes WHERE id = ?', id)
  return row ? mapRecipe(db, row, materialNameMap(db)) : null
}

/** 配方里出现过的类型，供筛选下拉使用。 */
export function recipeKinds(db: Db): string[] {
  return db
    .all<{ kind: string }>('SELECT DISTINCT kind FROM recipes WHERE archived_at IS NULL ORDER BY kind')
    .map((r) => r.kind)
}

export interface SaveRecipeResult {
  /** 保存后的完整配方（带条目与摘要） */
  recipe: RecipeListItem | null
  errors: Record<string, string>
}

export function saveRecipe(db: Db, input: RecipeInput): SaveRecipeResult {
  return db.transaction(() => {
    const errors = validateRecipe({ name: input.name, items: input.items })
    if (Object.keys(errors).length > 0) {
      return { recipe: input.id ? getRecipe(db, input.id) : null, errors }
    }

    const name = input.name.trim()
    const kind = input.kind.trim() || '配土'
    let id = input.id ?? null

    const available = input.available ? 1 : 0
    if (id) {
      db.run(
        'UPDATE recipes SET name = ?, kind = ?, note = ?, available = ? WHERE id = ?',
        name,
        kind,
        input.note,
        available,
        id
      )
    } else {
      const r = db.run(
        'INSERT INTO recipes (name, kind, note, available) VALUES (?, ?, ?, ?)',
        name,
        kind,
        input.note,
        available
      )
      id = Number(r.lastInsertRowid)
    }

    // 整组替换：小数据量下这是最不容易写错的策略
    db.run('DELETE FROM recipe_items WHERE recipe_id = ?', id)
    input.items.forEach((item, index) => {
      db.run(
        `INSERT INTO recipe_items (recipe_id, material_id, name, ratio_part, amount, unit, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        item.materialId,
        item.name?.trim() || null,
        item.ratioPart,
        item.amount,
        item.unit?.trim() || null,
        item.note?.trim() || null,
        index
      )
    })

    return { recipe: getRecipe(db, id), errors: {} }
  })
}

export function archiveRecipe(db: Db, id: number): boolean {
  const r = db.run("UPDATE recipes SET archived_at = datetime('now') WHERE id = ?", id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

/** 取消归档（配方误删的退路）。 */
export function restoreRecipe(db: Db, id: number): boolean {
  const r = db.run('UPDATE recipes SET archived_at = NULL WHERE id = ?', id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

/** 统计：材料数与配方数，用于界面上的概览。 */
export function recipeStats(db: Db): { materials: number; recipes: number } {
  return {
    materials: Number(db.scalar<number>('SELECT COUNT(*) AS c FROM materials') ?? 0),
    recipes: Number(db.scalar<number>('SELECT COUNT(*) AS c FROM recipes WHERE archived_at IS NULL') ?? 0)
  }
}
