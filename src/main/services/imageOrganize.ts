/**
 * 图片文件整理 / 迁移。
 *
 * 两件事，都只动**文件**和 images 表里的相对路径，不动任何业务数据：
 *
 *  1. `organizeImages` —— 把平铺在 images/ 根目录里的老文件按「年-月 / 归属」
 *     搬进子目录。升级前传的图都堆在一个文件夹里、文件名是 UUID，
 *     在资源管理器里既看不出属于谁、也分不清哪几张是一起传的。
 *
 *  2. `moveImagesRoot` —— 换图片根目录（图片是应用里最占空间的，很多人想放 D 盘）。
 *     因为库里存的是相对路径，这里只要把整棵树复制过去、改设置即可，
 *     记录一条都不用动；旧目录保留不删，确认没问题再由用户自己清理。
 */

import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from '../db/connection'
import { getSetting, setSetting } from '../db/repo/misc'
import { imagesDir, resolveImagePath, setImagesRoot, toPosixPath } from './images'
import { groupName, groupOfRow, monthBucket } from '../../core/imagePaths'

export const IMAGES_DIR_KEY = 'images.dir'

interface ImageRowForOrganize {
  id: number
  path: string
  thumb_path: string | null
  created_at: string
  plant_id: number | null
  species_id: number | null
  environment_id: number | null
  material_id: number | null
  wishlist_id: number | null
  log_id: number | null
}

export interface OrganizeReport {
  moved: number
  already: number
  missing: number
  failed: string[]
}

/** created_at（本地时间字符串）→ 该文件上传时的年-月桶 */
function bucketOf(createdAt: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(createdAt ?? '')
  if (m) return `${m[1]}-${m[2]}`
  return monthBucket()
}

/**
 * 把已有的图片整理进子目录。幂等：已经在正确位置的会跳过。
 * 单条失败不影响其它记录（把原因收集起来返回）。
 */
export function organizeImages(db: Db): OrganizeReport {
  const rows = db.all<ImageRowForOrganize>('SELECT * FROM images ORDER BY id')
  const report: OrganizeReport = { moved: 0, already: 0, missing: 0, failed: [] }

  for (const row of rows) {
    const group = groupOfRow(row)
    const bucket = bucketOf(row.created_at)
    const targetFolder = `${bucket}/${groupName(group)}`
    const name = row.path.split(/[\\/]/).pop() ?? ''
    const targetRel = toPosixPath(`${targetFolder}/${name}`)
    if (toPosixPath(row.path) === targetRel) {
      report.already++
      continue
    }

    const from = resolveImagePath(row.path)
    const to = resolveImagePath(targetRel)
    if (!from || !to) {
      report.failed.push(`#${row.id} 路径不合法：${row.path}`)
      continue
    }
    if (!existsSync(from)) {
      report.missing++
      continue
    }

    try {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)

      let thumbRel: string | null = null
      if (row.thumb_path) {
        const thumbName = row.thumb_path.split(/[\\/]/).pop() ?? ''
        thumbRel = toPosixPath(`${targetFolder}/${thumbName}`)
        const thumbFrom = resolveImagePath(row.thumb_path)
        const thumbTo = resolveImagePath(thumbRel)
        if (thumbFrom && thumbTo && existsSync(thumbFrom)) {
          mkdirSync(dirname(thumbTo), { recursive: true })
          renameSync(thumbFrom, thumbTo)
        }
      }

      db.run('UPDATE images SET path = ?, thumb_path = COALESCE(?, thumb_path) WHERE id = ?', targetRel, thumbRel, row.id)
      report.moved++
    } catch (error) {
      report.failed.push(`#${row.id}：${error instanceof Error ? error.message : '移动失败'}`)
    }
  }

  return report
}

export interface MoveRootResult {
  dir: string
  copied: boolean
  images: number
}

/**
 * 换图片根目录：先把现有文件整树复制过去，再改设置。
 *
 * 不删旧目录 —— 复制过程中断电、或者用户其实只是"换个地方看看"都能退回去。
 */
export function moveImagesRoot(db: Db, nextDir: string): MoveRootResult {
  const from = imagesDir()
  const to = nextDir.trim()
  if (!to) throw new Error('目录不能为空')

  const normFrom = from.replace(/[\\/]+$/, '').toLowerCase()
  const normTo = to.replace(/[\\/]+$/, '').toLowerCase()
  if (normFrom === normTo) throw new Error('新目录和当前目录是同一个')
  if (normTo.startsWith(normFrom + '\\') || normTo.startsWith(normFrom + '/')) {
    throw new Error('新目录不能放在当前图片目录里面')
  }

  let copied = false
  if (existsSync(from)) {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
    copied = true
  } else {
    mkdirSync(to, { recursive: true })
  }

  setSetting(db, IMAGES_DIR_KEY, to)
  setImagesRoot(to)

  const images = Number(db.scalar<number>('SELECT COUNT(*) AS n FROM images') ?? 0)
  return { dir: to, copied, images }
}

/** 启动时把设置里的图片根目录装上（没有就用 userData/images） */
export function applyImagesRootSetting(db: Db): string {
  const stored = getSetting<string | null>(db, IMAGES_DIR_KEY, null)
  setImagesRoot(typeof stored === 'string' ? stored : null)
  return imagesDir()
}

/** 设置页显示用：当前图片目录，以及它是不是被改过 */
export function imagesRootInfo(): { dir: string; defaultValue: string; isCustom: boolean } {
  const dir = imagesDir()
  const defaultValue = join(app.getPath('userData'), 'images')
  return { dir, defaultValue, isCustom: dir !== defaultValue }
}
