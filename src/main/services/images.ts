/**
 * 图片服务：导入、生成缩略图、自定义协议读取。
 *
 * 设计要点：
 *  - 文件放 userData/images，数据库只存**文件名**，绝不存绝对路径（换机器就失效）。
 *  - 绝不把图片存成 base64 塞进数据库（会撑爆数据库、拖慢备份）。
 *  - 读取走自定义协议 plantimg://，并做路径穿越防护。
 */

import { app, nativeImage, net, protocol } from 'electron'
import { copyFileSync, existsSync, linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeQuery, parseBingResults, queryTokens, rankHits, type BingImageHit } from '../../core/imageSearch'

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

/** 一条网络图片候选：原图地址 + 缩略图（data URL，渲染层 CSP 只允许 data:） */
export interface WebImageCandidate {
  url: string
  thumb: string
  title: string | null
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ZH_LANG = 'zh-CN,zh-Hans;q=0.9,zh;q=0.8,en;q=0.6'

/**
 * 用必应图片搜索找候选图。
 *
 * 为什么不是「让模型给图片」：chat 模型没有联网工具，给不出真实图片地址；
 * 图片搜索/生成服务又都要各自的 key（百度图片接口已加反爬，直接 403）。
 * 必应图片的 HTML 里带真实 `murl`（原图）和 `turl`（缩略图），
 * 由**应用**去搜、由**用户**挑，这条链路既不依赖 key，也不怕模型编造。
 *
 * ## 为什么先"预热"再搜（2026-10-19 修）
 *
 * 直接对 `/images/async` 发请求、且**没有 cookie** 时，必应会退化成
 * 一份"热门图片"页面（南通街景、汽车、书籍贴图……），和用户浏览器里看到的
 * 结果完全无关。实测：先 GET 一次 `cn.bing.com/images` 拿到 MUID/_EDGE_S 等
 * cookie，再带着它搜同一个词，返回的就是正常结果。
 * 所以这里维护一个进程级 cookie，搜之前确保预热过；结果明显不对时再预热一次重试。
 *
 * ## 相关性校验
 *
 * 即使预热过，冷门词也可能拿到"猜你想搜"的泛化结果。这里用查询词给每条结果
 * 打分（标题 / 来源页里是否出现查询词或其片段），明显不相关的整批丢掉，
 * 宁可报"没搜到"也不给用户看一堆药盒子。
 *
 * 注意：缩略图转成 data URL 返回 —— 渲染层 CSP 是
 * `img-src 'self' plantimg: data: blob:`，远程 https 图片会被拦。
 */
export async function searchWebImages(query: string, limit = 12): Promise<WebImageCandidate[]> {
  const q = normalizeQuery(query)
  if (!q) throw new Error('先输入要搜的名称')

  await warmUpBing()
  let scored = await fetchAndScore(q)
  if (countRelevant(scored) < 4) {
    // 可能 cookie 过期 / 这次被降级了：强制重拿 cookie 再来一次
    await warmUpBing(true)
    const retry = await fetchAndScore(q)
    if (countRelevant(retry) > countRelevant(scored)) scored = retry
  }

  const relevant = scored.filter((item) => item.score > 0)
  if (relevant.length === 0) {
    if (scored.length === 0) throw new Error('没有搜到图片，换个名称再试')
    throw new Error('必应返回的结果和这个名称对不上，换个说法试试（比如只搜物种名，去掉品种名和引号）')
  }

  const picked = relevant.slice(0, limit)
  // 缩略图并发下载，失败就跳过（不因为没有预览就丢掉候选）
  const withThumbs = await Promise.all(
    picked.map(async (item) => {
      const thumb = item.turl ? await fetchAsDataUrl(item.turl) : null
      const fallback = thumb ?? (await fetchAsDataUrl(item.url, 1_500_000))
      return fallback ? { url: item.url, thumb: fallback, title: item.title } : null
    })
  )
  const items = withThumbs.filter((v): v is WebImageCandidate => v !== null)
  if (items.length === 0) throw new Error('图片都下载不下来，可能被站点限制了')
  return items
}

let bingCookies: string | null = null
let bingWarmAt = 0

const BING_ORIGIN = 'https://cn.bing.com'

async function warmUpBing(force = false): Promise<void> {
  // 20 分钟内的 cookie 直接复用
  if (!force && bingCookies && Date.now() - bingWarmAt < 20 * 60 * 1000) return
  try {
    const response = await net.fetch(`${BING_ORIGIN}/images`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html', 'accept-language': ZH_LANG }
    })
    // Electron 的 net.fetch 有时只给 `set-cookie` 单值头，没有 getSetCookie()；
    // 两条都兜一下，否则拿不到 cookie 就又会被降级成"热门图片"
    const jar =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/).filter(Boolean)
    bingCookies = jar.length > 0 ? jar.map((c) => c.split(';')[0]).join('; ') : bingCookies
    bingWarmAt = Date.now()
    await response.arrayBuffer()
  } catch {
    // 预热失败也继续 —— 可能本来就有 cookie，或者这次不需要
  }
}

async function fetchAndScore(q: string): Promise<Array<BingImageHit & { score: number }>> {
  const url = `${BING_ORIGIN}/images/async?q=${encodeURIComponent(q)}&first=0&count=35&mkt=zh-CN&FORM=IRFLTR`
  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept: 'text/html',
    'accept-language': ZH_LANG,
    referer: `${BING_ORIGIN}/images`
  }
  if (bingCookies) headers.cookie = bingCookies

  const response = await net.fetch(url, { headers })
  if (!response.ok) throw new Error(`搜索失败：HTTP ${response.status}`)
  const html = await response.text()
  return rankHits(parseBingResults(html), queryTokens(q))
}

function countRelevant(items: Array<{ score: number }>): number {
  return items.filter((item) => item.score > 0).length
}
/** 下载一张图并转 data URL；超过大小上限返回 null */
async function fetchAsDataUrl(url: string, maxBytes = 3_000_000): Promise<string | null> {
  try {
    const response = await net.fetch(url, {
      headers: { 'user-agent': BROWSER_UA, referer: 'https://cn.bing.com/' }
    })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > maxBytes) return null
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 从图片地址导入（用户粘贴的链接）。
 *
 * 为什么需要它：配置的聊天模型（如 deepseek-chat）拿不到图片，
 * 而国内的图片搜索大多要另外的 key。先给一条「复制图片地址 → 粘贴」的路，
 * 任何浏览器里能看到的图都能进来。
 *
 * 约束：只接受 http(s)、只接受 image/*、40MB 上限、超时 20 秒。
 */
export async function importImageFromUrl(url: string): Promise<ImportedImage> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('这不是一个合法的图片地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http / https 图片地址')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  let response: globalThis.Response
  try {
    response = await net.fetch(parsed.toString(), { signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    throw new Error(
      `下载失败：${error instanceof Error && error.name === 'AbortError' ? '超时（20 秒）' : '网络不可达'}`
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    throw new Error(`这个地址不是图片（Content-Type: ${contentType || '未知'}）`)
  }
  const ext = extFromContentType(contentType)
  if (!ext) throw new Error(`不支持的图片格式：${contentType}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('下载到的图片是空的')
  if (buffer.length > 40 * 1024 * 1024) throw new Error('图片超过 40MB，请先压缩后再导入')

  return saveImageBuffer(buffer, ext)
}

function extFromContentType(contentType: string): string | null {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('gif')) return '.gif'
  if (contentType.includes('bmp')) return '.bmp'
  return null
}

/** 把内存里的图片写进 images 目录并生成缩略图（链接导入与本地导入共用） */
function saveImageBuffer(buffer: Buffer, ext: string): ImportedImage {
  const dir = ensureImagesDir()
  const fileName = `${randomUUID()}${ext}`
  const target = join(dir, fileName)
  writeFileSync(target, buffer)

  let thumbName: string | null = null
  let width: number | null = null
  let height: number | null = null
  try {
    const image = nativeImage.createFromBuffer(buffer)
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

/**
 * 把已有图片「再记一份」：用**硬链接**而不是复制文件。
 *
 * 场景：植株借用物种图库里的图。复制一份能让两边独立删除（删图会连文件一起删），
 * 但同一张照片在磁盘上会存两份。硬链接两者兼得：
 *  - 两个文件名指向同一份数据，磁盘只占一份
 *  - 删掉任意一个文件名，另一个照常可用（内容直到最后一个链接被删才释放）
 *  - 之后「替换图片」是写新文件，不会改到原文件，所以不会串图
 *
 * 硬链接建不了（跨卷 / 文件系统不支持）就退回普通复制 —— 行为不变，只是多占空间。
 */
export function cloneImageFiles(sourceName: string, sourceThumb: string | null): ImportedImage {
  const dir = ensureImagesDir()
  const source = join(dir, basename(sourceName))
  if (!existsSync(source)) throw new Error('原图文件不存在')

  const ext = extname(source).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`)

  const fileName = `${randomUUID()}${ext}`
  linkOrCopy(source, join(dir, fileName))

  let thumbName: string | null = null
  if (sourceThumb) {
    const thumbSource = join(dir, basename(sourceThumb))
    if (existsSync(thumbSource)) {
      const thumbExt = extname(thumbSource).toLowerCase() || '.jpg'
      thumbName = `${basename(fileName, ext)}_thumb${thumbExt}`
      linkOrCopy(thumbSource, join(dir, thumbName))
    }
  }

  let width: number | null = null
  let height: number | null = null
  try {
    const image = nativeImage.createFromPath(source)
    if (!image.isEmpty()) {
      const size = image.getSize()
      width = size.width
      height = size.height
    }
  } catch {
    // 量不出尺寸不影响使用
  }

  return { fileName, thumbName, width, height }
}

/** 先试硬链接，失败退回复制 */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to)
  } catch {
    copyFileSync(from, to)
  }
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
