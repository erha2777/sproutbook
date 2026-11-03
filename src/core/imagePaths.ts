/**
 * 图片路径规则（纯函数，不碰 Electron / 文件系统）。
 *
 * 以前所有图片平铺在 `images/` 里、文件名是随机 UUID —— 在资源管理器里看不出
 * 哪几张是一起传的、属于谁。现在按两层分桶：
 *
 *   images/2026-11/plant-7/9f3c….jpg
 *   images/2026-11/log-142/9f3c….jpg
 *
 * 1. **年-月**：用户找文件时想的是"我上个月拍的"
 * 2. **归属**：同一株 / 同一条养护记录 / 同一个物种的照片躺在一起
 *
 * 数据库里一律存 `/` 分隔的相对路径：跨平台一致，也不受 Windows 反斜杠转义影响；
 * 换图片根目录时只需复制整棵树，记录一条都不用改。
 */

export type ImageGroupKind = 'plant' | 'species' | 'env' | 'material' | 'wishlist' | 'log' | 'misc'

export interface ImageGroup {
  kind: ImageGroupKind
  id?: number | null
}

/** 统一成 `/` 分隔、去掉空段与尾随分隔符 */
export function toPosixPath(rel: string): string {
  return rel.split(/[\\/]+/).filter(Boolean).join('/')
}

/** 年-月分桶，用**本地时间** */
export function monthBucket(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** 归属目录名（不含年-月）：plant-7 / log-142 / misc */
export function groupName(group?: ImageGroup | null): string {
  if (!group || group.kind === 'misc') return 'misc'
  const id = Number(group.id)
  if (!Number.isFinite(id)) return 'misc'
  return `${group.kind}-${Math.trunc(id)}`
}

/** 完整分桶相对目录：2026-11/plant-7 */
export function groupFolder(group?: ImageGroup | null, now: Date = new Date()): string {
  return `${monthBucket(now)}/${groupName(group)}`
}

/**
 * 从一行数据库记录推断归属（养护记录优先 —— 那是"一次上传"最自然的分组）。
 */
export function groupOfRow(row: {
  log_id?: number | null
  plant_id?: number | null
  species_id?: number | null
  environment_id?: number | null
  material_id?: number | null
  wishlist_id?: number | null
}): ImageGroup {
  const pairs: Array<[ImageGroupKind, number | null | undefined]> = [
    ['log', row.log_id],
    ['plant', row.plant_id],
    ['species', row.species_id],
    ['env', row.environment_id],
    ['material', row.material_id],
    ['wishlist', row.wishlist_id]
  ]
  for (const [kind, id] of pairs) {
    if (typeof id === 'number' && Number.isFinite(id)) return { kind, id }
  }
  return { kind: 'misc' }
}

/**
 * 把相对路径拼到根目录下，并挡住路径穿越 / 绝对路径 / 盘符。
 * 返回 null 表示这个路径不能碰。纯字符串运算，方便自检。
 */
export function resolveInsideRoot(root: string, rel: string | null | undefined): string | null {
  if (!rel) return null
  const raw = rel.trim()
  if (!raw) return null
  /*
   * 绝对路径要在归一化**之前**拦：toPosixPath 会把开头的分隔符吃掉，
   * 之后再看就分不清 "/etc/passwd" 和 "etc/passwd" 了。
   */
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) return null
  const posix = toPosixPath(raw)
  if (!posix) return null
  const segments = posix.split('/')
  if (segments.some((seg) => seg === '..' || seg === '.')) return null
  const rootClean = root.replace(/[\\/]+$/, '')
  const sep = rootClean.includes('\\') ? '\\' : '/'
  return `${rootClean}${sep}${segments.join(sep)}`
}

/** 从 plantimg://local/<相对路径> 里取出相对路径（保留子目录） */
export function relativeFromImageUrl(pathname: string): string {
  return toPosixPath(decodeURIComponent(pathname))
}
