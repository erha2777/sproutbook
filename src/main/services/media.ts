/**
 * 音乐 / 背景的"选哪个"偏好，和用户自己放的背景图。
 *
 * 文件都落在 <userData>/textures 下：
 *   - textures/music/*.mp3   背景音乐
 *   - textures/backgrounds/* 背景图
 *
 * 和皮肤素材同目录的理由：备份、迁移、清理只需盯一个地方；
 * 这两个功能本来就是"用户自己的素材"，跟主题是一类东西。
 */

import { app, nativeImage } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface MediaPrefs {
  /** 选中的曲目文件名；null = 用列表里的第一首 */
  musicTrack: string | null
  /** 选中的背景图文件名；null = 全部轮播 */
  backdrop: string | null
}

export const EMPTY_MEDIA_PREFS: MediaPrefs = { musicTrack: null, backdrop: null }
/** settings 表里的键 */
export const MEDIA_KEY = 'media.prefs'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export function backdropsDir(): string {
  return join(app.getPath('userData'), 'textures', 'backgrounds')
}

export interface BackdropItem {
  name: string
  url: string
}

/**
 * 背景图列表。
 *
 * 转成 JPEG data URL 之前先缩到最长边 1600：原图动辄 5MB，
 * 直接 base64 会让整个界面卡一下；背景是铺满屏的，1600 足够。
 * 转不出来（格式怪、文件坏）就退回原文件的 data URL。
 */
export function listBackdrops(): BackdropItem[] {
  const dir = backdropsDir()
  if (!existsSync(dir)) return []
  let names: string[] = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: BackdropItem[] = []
  for (const name of names) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    const url = readAsUrl(file)
    if (url) out.push({ name, url })
  }
  return out
}

function readAsUrl(file: string): string | null {
  try {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) {
      const size = image.getSize()
      const maxEdge = 1600
      const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
      const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image
      const buffer = resized.toJPEG(86)
      if (buffer.length > 0) return `data:image/jpeg;base64,${buffer.toString('base64')}`
    }
  } catch {
    // 落到下面的原文件兜底
  }
  try {
    if (statSync(file).size > 24 * 1024 * 1024) return null
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
