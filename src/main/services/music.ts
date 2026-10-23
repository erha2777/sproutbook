/**
 * 私有背景音乐：从 <userData>/textures/music（开发期也读仓库 textures/music）取歌。
 *
 * 曲库按季节分文件夹（`春季（Spring）` / `夏季（Summer）` …），顶层的曲子算"不分季节"。
 * 之所以支持子目录：用户就是把四季的曲子按文件夹分开放的（星露谷原声那种命名）。
 *
 * 为什么走自定义协议而不是 data URL：
 * 一首 mp3 动辄几 MB，base64 会变成 1.33 倍内存占用，而且没法 Range 拖动；
 * 用 `sproutmusic://` 交给 Chromium 流式读取，循环播放也更稳。
 *
 * 只读、只认音频扩展名，路径必须落在允许的目录里（防目录穿越）。
 */

import { app, net, protocol } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { seasonOfFolderName } from '../../core/music'
import type { MusicSeason } from '../../core/music'

const MUSIC_SCHEME = 'sproutmusic'
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.opus'])

/** 最多收多少首：再多界面也翻不过来，而且扫描会变慢 */
const MAX_TRACKS = 200

export interface MusicTrack {
  /** 显示名（去掉扩展名） */
  name: string
  /** 相对 music 目录的路径，单曲循环时用它当唯一标识（同名文件可能在两季里都有） */
  file: string
  season: MusicSeason | null
  url: string
}

export function musicDirs(): string[] {
  const dirs = [join(app.getPath('userData'), 'textures', 'music')]
  if (!app.isPackaged) dirs.push(join(app.getAppPath(), 'textures', 'music'))
  return dirs
}

/** ready 之前调用 */
export function registerMusicScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MUSIC_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

/** ready 之后调用 */
export function handleMusicProtocol(): void {
  protocol.handle(MUSIC_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // sproutmusic://music/<可能带子目录的相对路径>
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!isSafeRelative(name)) return new Response('bad track', { status: 400 })
      for (const dir of musicDirs()) {
        const file = resolve(normalize(join(dir, name)))
        if (!file.startsWith(resolve(dir) + sep)) continue
        if (!existsSync(file)) continue
        // net.fetch 处理 file:// 时会顺带支持 Range，音频可拖动
        return net.fetch(pathToFileURL(file).toString())
      }
      return new Response('not found', { status: 404 })
    } catch {
      return new Response('error', { status: 500 })
    }
  })
}

/**
 * 相对路径白名单：只允许 `子目录/文件名.mp3` 这种形状。
 * `..`、绝对路径、盘符都挡掉；扩展名必须在音频白名单里。
 */
function isSafeRelative(name: string): boolean {
  if (!name || name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return false
  if (/^[a-z]:/i.test(name)) return false
  return AUDIO_EXT.has(extname(name).toLowerCase())
}

/** 列出可用曲目（递归一层子目录，按季节归类） */
export function listMusic(): MusicTrack[] {
  const out: MusicTrack[] = []
  const seen = new Set<string>()

  const push = (dir: string, relative: string, season: MusicSeason | null): void => {
    if (out.length >= MAX_TRACKS) return
    const ext = extname(relative).toLowerCase()
    if (!AUDIO_EXT.has(ext) || seen.has(relative)) return
    try {
      if (!statSync(join(dir, relative)).isFile()) return
    } catch {
      return
    }
    seen.add(relative)
    const base = relative.split(/[\\/]/).pop() ?? relative
    const slashPath = relative.split(sep).join('/')
    out.push({
      name: base.slice(0, base.length - ext.length),
      file: slashPath,
      season,
      url: `${MUSIC_SCHEME}://music/${encodeURI(slashPath)}`
    })
  }

  for (const dir of musicDirs()) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir).sort((a, b) => a.localeCompare(b, 'zh'))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= MAX_TRACKS) break
      let isDir = false
      try {
        isDir = statSync(join(dir, entry)).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        // 季节子目录：再扫一层
        const season = seasonOfFolderName(entry)
        let inner: string[] = []
        try {
          inner = readdirSync(join(dir, entry)).sort((a, b) => a.localeCompare(b, 'zh'))
        } catch {
          continue
        }
        for (const file of inner) {
          /*
           * 第一个参数必须是**曲库根目录**：push 内部会用它 + relative 拼绝对路径。
           * 早先这里传的是子目录，于是拼成 `秋季（Fall）/秋季（Fall）/xx.mp3`，
           * statSync 全部失败 —— 表现就是四季的曲子一首都没扫进来。
           */
          push(dir, `${entry}/${file}`, season)
        }
      } else {
        // 顶层的曲子：不属于任何季节，单曲循环时可选
        push(dir, entry, null)
      }
    }
  }
  return out
}
