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
import { basename, join, resolve } from 'node:path'

export interface MediaPrefs {
  /**
   * 单曲循环时选中的曲目（相对 music 目录的路径，允许带季节子目录）；
   * null = 没选，按当季随机走。
   */
  musicTrack: string | null
  /** 选中的背景图文件名；null = 全部轮播 */
  backdrop: string | null
  /**
   * 音乐播放模式：
   *  - season-random（默认）：每次打开应用，从当季曲子里随机挑一首循环
   *  - season-rotate：当季曲子按顺序轮播
   *  - single：只放 musicTrack 那一首
   */
  musicMode: 'season-random' | 'season-rotate' | 'single'
  /** 音乐音量 0~1（音效音量是另一条线，互不影响） */
  musicVolume: number
}

export const EMPTY_MEDIA_PREFS: MediaPrefs = {
  musicTrack: null,
  backdrop: null,
  musicMode: 'season-random',
  musicVolume: 0.3
}
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

function readAsUrl(file: string): string | null {  try {
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
/**
 * 单独取一张背景图（按文件名）。
 *
 * 用途：偏好里存的文件名在列表里找不到时（列表扫描失败、文件刚被占用），
 * 还能直接把它读出来 —— 否则背景会变成"什么都没有"。
 * 路径必须落在 backgrounds 目录里，防目录穿越。
 */
export function readBackdrop(name: string): string | null {
  const raw = String(name ?? '')
  if (!raw || raw === '__theme__') return null
  const dir = resolve(backdropsDir())
  const file = resolve(join(dir, basename(raw)))
  if (!file.startsWith(dir)) return null
  if (!existsSync(file)) return null
  return readAsUrl(file)
}
