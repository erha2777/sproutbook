/**
 * 种草清单仓储。
 *
 * 一条记录 = 想买的一株植物：名字 + 店铺 + 价格 + 链接 + 简介 + 一张封面图。
 * 图片复用 `images` 表（owner 列 wishlist_id），和植株 / 物种 / 物品同一套文件管理。
 */

import type { Db } from '../connection'
import type { WishInput, WishItem } from '../../../core/types'

interface WishRow {
  id: number
  name: string
  shop: string | null
  price: number | null
  url: string | null
  note: string | null
  sort_order: number
  created_at: string
  image_id: number | null
  image_thumb: string | null
}

/** 左连第一张图当封面（和物品列表一个写法：没有图就是 null，不改行数） */
const SELECT_WISH = `
  SELECT w.*, i.id AS image_id, i.thumb_path AS image_thumb
  FROM wishlist w
  LEFT JOIN images i
    ON i.wishlist_id = w.id
   AND i.id = (SELECT MIN(id) FROM images WHERE wishlist_id = w.id)
`

function mapWish(row: WishRow): WishItem {
  return {
    id: row.id,
    name: row.name,
    shop: row.shop,
    price: row.price,
    url: row.url,
    note: row.note,
    coverImageId: row.image_id,
    coverThumb: row.image_thumb,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

export function listWishItems(db: Db): WishItem[] {
  return db.all<WishRow>(`${SELECT_WISH} ORDER BY w.sort_order, w.id DESC`).map(mapWish)
}

export function getWishItem(db: Db, id: number): WishItem | null {
  const row = db.get<WishRow>(`${SELECT_WISH} WHERE w.id = ?`, id)
  return row ? mapWish(row) : null
}

export function saveWishItem(db: Db, input: WishInput): WishItem {
  const name = input.name.trim()
  if (!name) throw new Error('植物名不能为空')

  if (input.id) {
    db.run(
      "UPDATE wishlist SET name = ?, shop = ?, price = ?, url = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      name,
      input.shop?.trim() || null,
      input.price,
      input.url?.trim() || null,
      input.note?.trim() || null,
      input.id
    )
    const updated = getWishItem(db, input.id)
    if (!updated) throw new Error('这条种草记录已经不在了')
    return updated
  }

  // 新的排在最前：种草清单是"最近想买什么"，不是按字母表
  const nextOrder =
    Number(db.scalar<number>('SELECT COALESCE(MIN(sort_order), 0) - 1 AS n FROM wishlist') ?? -1) ?? -1
  const r = db.run(
    'INSERT INTO wishlist (name, shop, price, url, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    name,
    input.shop?.trim() || null,
    input.price,
    input.url?.trim() || null,
    input.note?.trim() || null,
    nextOrder
  )
  const created = getWishItem(db, Number(r.lastInsertRowid))
  if (!created) throw new Error('种草记录创建失败')
  return created
}

export function removeWishItem(db: Db, id: number): boolean {
  // 图片会被外键 ON DELETE CASCADE 带走（文件由 IPC 那边删）
  const r = db.run('DELETE FROM wishlist WHERE id = ?', id)
  return Number(r.changes) > 0
}
