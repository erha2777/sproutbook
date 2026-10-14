/**
 * 环境档案 / 图片 / 设置 仓储。
 */

import type { Db } from '../connection'
import type { Environment, EnvironmentInput, ImageRecord } from '../../../core/types'

// ---------------------------------------------------------------------------
// 环境档案
// ---------------------------------------------------------------------------

interface EnvironmentRow {
  id: number
  name: string
  kind: string
  light_level: string | null
  light_hours: number | null
  climate_zone: string | null
  province: string | null
  city: string | null
  district: string | null
  lat: number | null
  lon: number | null
  can_heat: number
  frost_protected: number
  sort_order: number
  archived_at: string | null
}

function mapEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Environment['kind'],
    lightLevel: row.light_level as Environment['lightLevel'],
    lightHours: row.light_hours,
    climateZone: row.climate_zone,
    province: row.province,
    city: row.city,
    district: row.district ?? null,
    lat: row.lat,
    lon: row.lon,
    canHeat: row.can_heat === 1,
    frostProtected: row.frost_protected === 1,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at
  }
}

export function listEnvironments(db: Db, includeArchived = false): Environment[] {
  const sql = includeArchived
    ? 'SELECT * FROM environments ORDER BY sort_order, id'
    : 'SELECT * FROM environments WHERE archived_at IS NULL ORDER BY sort_order, id'
  return db.all<EnvironmentRow>(sql).map(mapEnvironment)
}

export function getEnvironment(db: Db, id: number): Environment | null {
  const row = db.get<EnvironmentRow>('SELECT * FROM environments WHERE id = ?', id)
  return row ? mapEnvironment(row) : null
}

export function saveEnvironment(db: Db, input: EnvironmentInput): Environment {
  const id = input.id ?? null
  if (id) {
    db.run(
      `UPDATE environments SET name=?, kind=?, light_level=?, light_hours=?, climate_zone=?, province=?, city=?,
         lat=?, lon=?, can_heat=?, frost_protected=?, sort_order=? WHERE id=?`,
      input.name,
      input.kind,
      input.lightLevel,
      input.lightHours,
      input.climateZone,
      input.province,
      input.city,
      input.lat,
      input.lon,
      input.canHeat ? 1 : 0,
      input.frostProtected ? 1 : 0,
      input.sortOrder,
      id
    )
    const updated = getEnvironment(db, id)
    if (!updated) throw new Error('环境档案更新失败')
    return updated
  }

  const r = db.run(
    `INSERT INTO environments (name, kind, light_level, light_hours, climate_zone, province, city, district, lat, lon, can_heat, frost_protected, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.kind,
    input.lightLevel,
    input.lightHours,
    input.climateZone,
    input.province,
    input.city,
    input.lat,
    input.lon,
    input.canHeat ? 1 : 0,
    input.frostProtected ? 1 : 0,
    input.sortOrder
  )
  const created = getEnvironment(db, Number(r.lastInsertRowid))
  if (!created) throw new Error('环境档案创建失败')
  return created
}

export function archiveEnvironment(db: Db, id: number): boolean {
  db.run("UPDATE environments SET archived_at = datetime('now') WHERE id = ?", id)
  return true
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

interface ImageRow {
  id: number
  plant_id: number | null
  species_id: number | null
  path: string
  thumb_path: string | null
  caption: string | null
  origin: string
  sort_order: number
  created_at: string
}

function mapImage(row: ImageRow): ImageRecord {
  return {
    id: row.id,
    plantId: row.plant_id,
    speciesId: row.species_id,
    path: row.path,
    thumbPath: row.thumb_path,
    caption: row.caption,
    origin: row.origin,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

export function listImages(db: Db, owner: { plantId?: number; speciesId?: number }): ImageRecord[] {
  if (typeof owner.plantId === 'number') {
    return db
      .all<ImageRow>('SELECT * FROM images WHERE plant_id = ? ORDER BY sort_order, id', owner.plantId)
      .map(mapImage)
  }
  if (typeof owner.speciesId === 'number') {
    return db
      .all<ImageRow>('SELECT * FROM images WHERE species_id = ? ORDER BY sort_order, id', owner.speciesId)
      .map(mapImage)
  }
  return []
}

export function addImage(
  db: Db,
  input: { plantId?: number | null; speciesId?: number | null; path: string; thumbPath?: string | null; origin?: string }
): ImageRecord {
  const nextOrder = Number(
    db.scalar<number>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM images
       WHERE (plant_id IS ? OR ? IS NULL) AND (species_id IS ? OR ? IS NULL)`,
      input.plantId ?? null,
      input.plantId ?? null,
      input.speciesId ?? null,
      input.speciesId ?? null
    ) ?? 0
  )
  const r = db.run(
    `INSERT INTO images (plant_id, species_id, path, thumb_path, origin, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.plantId ?? null,
    input.speciesId ?? null,
    input.path,
    input.thumbPath ?? null,
    input.origin ?? 'user',
    nextOrder
  )
  const row = db.get<ImageRow>('SELECT * FROM images WHERE id = ?', Number(r.lastInsertRowid))
  if (!row) throw new Error('图片记录创建失败')
  return mapImage(row)
}

export function deleteImage(db: Db, id: number): ImageRecord | null {
  const row = db.get<ImageRow>('SELECT * FROM images WHERE id = ?', id)
  if (!row) return null
  db.run('DELETE FROM images WHERE id = ?', id)
  return mapImage(row)
}

// ---------------------------------------------------------------------------
// 设置（键值，值统一存 JSON 字符串）
// ---------------------------------------------------------------------------

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value)
  )
}

export function allSettings(db: Db): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    try {
      out[row.key] = JSON.parse(row.value)
    } catch {
      out[row.key] = row.value
    }
  }
  return out
}
