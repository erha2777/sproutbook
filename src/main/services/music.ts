/**
 * 私有背景音乐：从 <userData>/textures/music（开发期也读仓库 textures/music）取歌。
 *
 * 为什么走自定义协议而不是 data URL：
 * 一首 mp3 动辄几 MB，base64 会变成 1.33 倍内存占用，而且没法 Range 拖动；
 * 用 `sproutmusic://` 交给 Chromium 流式读取，循环播放也更稳。
 *
 * 只读、只认音频扩展名，路径必须落在允许的目录里（防目录穿越）。
 */

import { app, net, protocol } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MUSIC_SCHEME = 'sproutmusic'
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.opus'])

export interface MusicTrack {
  name: string
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
      // sproutmusic://music/<文件名>
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!name || name.includes('..') || !AUDIO_EXT.has(extname(name).toLowerCase())) {
        return new Response('bad track', { status: 400 })
      }
      for (const dir of musicDirs()) {
        const file = resolve(normalize(join(dir, name)))
        if (!file.startsWith(resolve(dir))) continue
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

/** 列出可用曲目（最多 20 首） */
export function listMusic(): MusicTrack[] {
  const out: MusicTrack[] = []
  const seen = new Set<string>()
  for (const dir of musicDirs()) {
    if (!existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (out.length >= 20) break
      const ext = extname(name).toLowerCase()
      if (!AUDIO_EXT.has(ext) || seen.has(name)) continue
      try {
        if (!statSync(join(dir, name)).isFile()) continue
      } catch {
        continue
      }
      seen.add(name)
      out.push({ name, url: `${MUSIC_SCHEME}://music/${encodeURIComponent(name)}` })
    }
  }
  return out
}
