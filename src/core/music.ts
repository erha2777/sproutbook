/**
 * 四季音乐：季节判断、播放模式、选曲。
 *
 * 都是纯函数，放在 core 里是为了自检能钉住 —— 选曲逻辑要是错了，
 * 表现是"夏天放冬天的曲子"这种很难复现的问题。
 *
 * 曲库按文件夹分季（春季（Spring）/ 夏季（Summer）…），顶层的曲子不属于任何季节，
 * 单曲循环时照样能选，但当季模式下不参与。
 */

export type MusicSeason = 'spring' | 'summer' | 'autumn' | 'winter'

export type MusicMode = 'season-random' | 'season-rotate' | 'single'

export const MUSIC_MODE_LABELS: Record<MusicMode, string> = {
  'season-random': '当季随机循环',
  'season-rotate': '当季轮播',
  single: '单曲循环'
}

export const MUSIC_MODE_HINTS: Record<MusicMode, string> = {
  'season-random': '每次打开应用，从当季的曲子里随机挑一首，一直循环',
  'season-rotate': '当季的曲子按顺序播，放完一首换下一首',
  single: '从全部曲子里挑一首，一直循环'
}

export const SEASON_LABELS: Record<MusicSeason, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬'
}

export const SEASON_ORDER: MusicSeason[] = ['spring', 'summer', 'autumn', 'winter']

/**
 * 月份 → 季节（北半球，气象季节）。
 * 3/4/5 春，6/7/8 夏，9/10/11 秋，12/1/2 冬。
 */
export function seasonOfMonth(month: number): MusicSeason {
  const m = Math.trunc(month)
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'autumn'
  return 'winter'
}

/** 文件夹名 → 季节；认不出来（顶层曲子）就是 null */
export function seasonOfFolderName(name: string): MusicSeason | null {
  const lower = name.toLowerCase()
  if (name.includes('春') || lower.includes('spring')) return 'spring'
  if (name.includes('夏') || lower.includes('summer')) return 'summer'
  if (name.includes('秋') || lower.includes('fall') || lower.includes('autumn')) return 'autumn'
  if (name.includes('冬') || lower.includes('winter')) return 'winter'
  return null
}

/** 老配置里的脏值一律收敛成默认模式，不让界面拿到不认识的字符串 */
export function normalizeMusicMode(value: unknown): MusicMode {
  return value === 'season-rotate' || value === 'single' || value === 'season-random'
    ? value
    : 'season-random'
}

/**
 * 当季曲目。
 *
 * 一首都没有（用户还没放当季的曲子）就退回全部 —— 宁可放别的季节，
 * 也不要因为没歌而彻底安静。
 */
export function seasonTracks<T extends { season: MusicSeason | null }>(
  tracks: T[],
  season: MusicSeason
): T[] {
  const same = tracks.filter((t) => t.season === season)
  return same.length > 0 ? same : tracks
}

/** 从 n 首里随机挑一首；n <= 0 返回 -1。random 可注入，方便自检 */
export function randomIndex(n: number, random: () => number = Math.random): number {
  if (n <= 0) return -1
  const r = random()
  const clamped = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0
  return Math.floor(clamped * n) % n
}

/** 轮播的下一首；列表为空返回 -1 */
export function nextIndex(current: number, n: number): number {
  if (n <= 0) return -1
  return (Math.trunc(current) + 1 + n) % n
}
