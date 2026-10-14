/**
 * 图片服务：导入、生成缩略图、自定义协议读取。
 *
 * 设计要点：
 *  - 文件放 userData/images，数据库只存**文件名**，绝不存绝对路径（换机器就失效）。
 *  - 绝不把图片存成 base64 塞进数据库（会撑爆数据库、拖慢备份）。
 *  - 读取走自定义协议 plantimg://，并做路径穿越防护。
 */

import { app, nativeImage, net, protocol } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'

const IMAGE_SCHEME = 'plantimg'
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export function imagesDir(): string {
  return join(app.getPath('userData'), 'images')
}

function ensureImagesDir(): string {
  const dir = imagesDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface ImportedImage {
  fileName: string
  thumbName: string | null
  width: number | null
  height: number | null
}

/**
 * 把一个外部图片文件复制进应用数据目录，并生成缩略图。
 * 失败时抛错，由调用方转成用户可读的提示 —— 不静默失败。
 */
export function importImage(sourcePath: string): ImportedImage {
  if (!existsSync(sourcePath)) throw new Error('图片文件不存在')
  const stat = statSync(sourcePath)
  if (!stat.isFile()) throw new Error('选择的不是一个文件')
  if (stat.size > 40 * 1024 * 1024) throw new Error('图片超过 40MB，请先压缩后再导入')

  const ext = extname(sourcePath).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}。支持 png / jpg / webp / gif / bmp。`)
  }

  const dir = ensureImagesDir()
  const fileName = `${randomUUID()}${ext}`
  const target = join(dir, fileName)
  copyFileSync(sourcePath, target)

  let thumbName: string | null = null
  let width: number | null = null
  let height: number | null = null

  try {
    const image = nativeImage.createFromPath(target)
    if (!image.isEmpty()) {
      const size = image.getSize()
      width = size.width
      height = size.height
      const maxEdge = 640
      const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
      const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image
      thumbName = `${basename(fileName, ext)}_thumb.jpg`
      writeFileSync(join(dir, thumbName), resized.toJPEG(82))
    }
  } catch {
    // 缩略图失败不影响主流程，前端会退回显示原图
    thumbName = null
  }

  return { fileName, thumbName, width, height }
}

/** 删除图片文件。文件不存在时也返回 true（幂等）。 */
export function removeImageFiles(fileNames: Array<string | null | undefined>): void {
  const dir = imagesDir()
  for (const name of fileNames) {
    if (!name) continue
    // 只允许删除 images 目录内的文件，杜绝通过构造文件名删除任意文件
    const target = normalize(join(dir, basename(name)))
    if (!target.startsWith(normalize(dir))) continue
    try {
      if (existsSync(target)) unlinkSync(target)
    } catch {
      // 文件被占用时忽略，不影响数据库记录删除
    }
  }
}

/**
 * 注册 plantimg:// 自定义协议。
 * 必须在 app ready 之前调用 registerSchemesAsPrivileged，之后调用 protocol.handle。
 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

export function handleImageProtocol(): void {
  const dir = imagesDir()
  protocol.handle(IMAGE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // plantimg://local/<filename>  →  取最后一段作为文件名
      const name = basename(decodeURIComponent(url.pathname))
      if (!name) return new Response('bad request', { status: 400 })

      const target = normalize(join(dir, name))
      if (!target.startsWith(normalize(dir))) {
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(target)) return new Response('not found', { status: 404 })

      return await net.fetch(`file://${target.replace(/\\/g, '/')}`)
    } catch (error) {
      return new Response(`error: ${error instanceof Error ? error.message : 'unknown'}`, { status: 500 })
    }
  })
}

/** 渲染进程使用的 URL 形式。 */
export function imageUrl(fileName: string | null | undefined): string | null {
  if (!fileName) return null
  return `${IMAGE_SCHEME}://local/${encodeURIComponent(basename(fileName))}`
}
