import type { PlantStatus } from '@core/types'

/** 把数据库里的文件名转成渲染进程可用的图片地址（对应主进程注册的 plantimg:// 协议）。 */
export function imageUrl(fileName: string | null | undefined): string | null {
  if (!fileName) return null
  return `plantimg://local/${encodeURIComponent(fileName)}`
}

export const PLANT_STATUS_LABELS: Record<PlantStatus, string> = {
  growing: '生长中',
  dormant: '休眠',
  sick: '有状况',
  dead: '已枯死',
  gifted: '已送人'
}

export const PLANT_STATUS_ICONS: Record<PlantStatus, string> = {
  growing: '🌿',
  dormant: '💤',
  sick: '🤒',
  dead: '🥀',
  gifted: '🎁'
}

export const PLANT_STATUS_OPTIONS: Array<{ value: PlantStatus; label: string }> = (
  Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]
).map((value) => ({ value, label: `${PLANT_STATUS_ICONS[value]} ${PLANT_STATUS_LABELS[value]}` }))

export const ENV_KIND_LABELS: Record<string, string> = {
  indoor: '室内',
  balcony: '阳台',
  terrace: '露台',
  ground: '地栽',
  greenhouse: '温室'
}

export const LIGHT_LEVEL_LABELS: Record<string, string> = {
  full_sun: '全日照',
  part_shade: '半阴',
  shade: '荫蔽'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  // 数据库里存的是 UTC 格式的 datetime('now') 或 ISO 串，统一按本地时间展示
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 当前月份（1~12）。 */
export function currentMonth(): number {
  return new Date().getMonth() + 1
}

/** 生成一个足够唯一的请求 id，用于取消 AI 请求。 */
export function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
