/**
 * 养护计划的纯逻辑：规则展开成任务、时间窗、紧急度。
 *
 * 关键设计：**规则只描述「哪个月该做什么」，不描述具体哪天**。
 * 「3~5 月每月施一次薄肥」是知识，「3 月 15 日施肥」是排期 ——
 * 后者取决于你什么时候有空、天气如何。所以生成任务时给的是
 * 「某月 1 日 + 一个时间窗」，窗口内做都算准时，而不是一个死线。
 *
 * 放 core 是因为主进程（生成计划、写日历）和渲染层（显示、排序）
 * 都要用同一套判断，两处各写一份必然会出现「列表说逾期、日历说还早」。
 */

import type { CareActionType, CareRule, CareTask, CareTaskStatus } from './types'

export const CARE_ACTION_LABELS: Record<CareActionType, string> = {
  water: '浇水',
  fertilize: '施肥',
  prune: '修剪',
  repot: '翻盆换土',
  pest: '病虫防治',
  protect: '防寒防暑',
  observe: '观察记录',
  other: '其他'
}

export const CARE_ACTION_ICONS: Record<CareActionType, string> = {
  water: '💧',
  fertilize: '🌾',
  prune: '✂️',
  repot: '🪴',
  pest: '🐛',
  protect: '🧣',
  observe: '👀',
  other: '📌'
}

export const CARE_ACTION_OPTIONS = (Object.keys(CARE_ACTION_LABELS) as CareActionType[]).map((value) => ({
  value,
  label: `${CARE_ACTION_ICONS[value]} ${CARE_ACTION_LABELS[value]}`
}))

/** 通用规则的 key：所有植物都适用。 */
export const UNIVERSAL_SPECIES_KEY = '*'

// ---------------------------------------------------------------------------
// 日期（不引依赖，也不碰时区：全部按「本地日历日」处理）
// ---------------------------------------------------------------------------

/** 把 Date 转成 YYYY-MM-DD（按本地时间，避免 UTC 偏移让日期差一天）。 */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayIso(): string {
  return toIsoDate(new Date())
}

/** 在 YYYY-MM-DD 上加减天数。 */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  // 用本地时间构造，和 toIsoDate 的取法一致，不会因为时区来回错一天
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  date.setDate(date.getDate() + days)
  return toIsoDate(date)
}

/** 两个日期相差的天数（a - b）。 */
export function daysBetween(a: string, b: string): number {
  const parse = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
  }
  return Math.round((parse(a) - parse(b)) / 86_400_000)
}

// ---------------------------------------------------------------------------
// 规则 → 任务
// ---------------------------------------------------------------------------

/** 规则覆盖的月份（自动处理跨年，如 11~2 月）。 */
export function monthsCovered(rule: Pick<CareRule, 'monthFrom' | 'monthTo'>): number[] {
  const from = Number(rule.monthFrom)
  const to = rule.monthTo === null || rule.monthTo === undefined ? from : Number(rule.monthTo)
  if (!Number.isFinite(from) || from < 1 || from > 12) return []
  if (!Number.isFinite(to) || to < 1 || to > 12) return [from]
  const out: number[] = []
  let cur = from
  // 最多 12 次，杜绝异常输入导致的死循环
  for (let i = 0; i < 12; i++) {
    out.push(cur)
    if (cur === to) break
    cur = cur === 12 ? 1 : cur + 1
  }
  return out
}

/** 某年某月有多少天。 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * 生成任务时的「锚点日」。
 *
 * 规则只到月，所以原则上可以全放在 1 号 —— 但那样七株植物的任务会全挤在
 * 同一天（月历上就是「1 号 8 项、其余全空」），失去参考价值。
 * 这里按植株错开，把同月的工作量摊开。
 *
 * 注意这不是「精确排期」：真正可做的区间是时间窗，锚点日只是让你有个先后。
 */
export function spreadDay(year: number, month: number, seed: number): number {
  const max = daysInMonth(year, month)
  const raw = 1 + (Math.abs(Math.trunc(seed)) * 7) % 27
  return Math.min(raw, max)
}

export interface GeneratedTask {
  dueDate: string
  title: string
  detail: string | null
  actionType: CareActionType
  priority: number
  windowDays: number
  ruleId: number
}

/**
 * 把规则展开成某一年的一组任务。
 *
 * 每月一条，日期取该月的锚点日（见 spreadDay），时间窗默认 ±15 天 ——
 * 也就是「这个月内做都行」。不细化到具体某天，是因为规则本身只到月；
 * 假装精确反而是误导。
 */
export function generateTasks(
  rules: CareRule[],
  speciesName: string | null,
  year: number,
  options: { hemisphere?: 'N' | 'S'; defaultWindowDays?: number; spreadSeed?: number } = {}
): GeneratedTask[] {
  const hemisphere = options.hemisphere ?? 'N'
  const windowDays = options.defaultWindowDays ?? 15
  const name = speciesName?.trim().toLowerCase() ?? ''
  const seed = options.spreadSeed ?? 0

  const applicable = rules.filter((r) => {
    if (r.hemisphere !== hemisphere) return false
    const key = r.speciesKey.trim().toLowerCase()
    return key === UNIVERSAL_SPECIES_KEY || (name !== '' && key === name)
  })

  const out: GeneratedTask[] = []
  const seen = new Set<string>()

  for (const rule of applicable) {
    for (const month of monthsCovered(rule)) {
      const day = spreadDay(year, month, seed)
      const dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      // 同一株同一月同一件事只留一条：通用规则和物种规则可能重复
      const signature = `${dueDate}|${rule.actionType}|${rule.title}`
      if (seen.has(signature)) continue
      seen.add(signature)
      out.push({
        dueDate,
        title: rule.title,
        detail: rule.detail,
        actionType: rule.actionType,
        priority: rule.priority,
        windowDays,
        ruleId: rule.id
      })
    }
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

// ---------------------------------------------------------------------------
// 任务状态
// ---------------------------------------------------------------------------

export type CareUrgency = 'overdue' | 'due' | 'soon' | 'later' | 'closed'

export interface CareWindow {
  from: string
  to: string
}

/** 任务的可执行区间。 */
export function windowRange(task: Pick<CareTask, 'dueDate' | 'windowDays'>): CareWindow {
  const w = Math.max(0, task.windowDays)
  return { from: addDays(task.dueDate, -w), to: addDays(task.dueDate, w) }
}

/** 逾期判定留一点余量，避免「昨天该浇水」就被标红。 */
const SOON_DAYS = 7

export function urgencyOf(
  task: Pick<CareTask, 'status' | 'dueDate' | 'windowDays'>,
  today: string = todayIso()
): CareUrgency {
  if (task.status !== 'pending') return 'closed'
  const win = windowRange(task)
  if (today > win.to) return 'overdue'
  if (today >= win.from) return 'due'
  // 窗口还没开始，但已经不远
  return daysBetween(win.from, today) <= SOON_DAYS ? 'soon' : 'later'
}

export const CARE_URGENCY_LABELS: Record<CareUrgency, string> = {
  overdue: '已过期',
  due: '该做了',
  soon: '快到了',
  later: '还早',
  closed: '已完成'
}

/** 排序用：越紧急越靠前，同紧急度按优先级与日期。 */
export function compareTasks(a: CareTask, b: CareTask, today: string = todayIso()): number {
  const rank: Record<CareUrgency, number> = { overdue: 0, due: 1, soon: 2, later: 3, closed: 4 }
  const ra = rank[urgencyOf(a, today)]
  const rb = rank[urgencyOf(b, today)]
  if (ra !== rb) return ra - rb
  if (a.priority !== b.priority) return a.priority - b.priority
  return a.dueDate.localeCompare(b.dueDate)
}

/**
 * 「还有几天」/「过了几天」的人话描述。
 *
 * 必须**基于时间窗**而不是计划日期：任务写着 10 月 1 日，时间窗 ±15 天，
 * 那 10 月 14 日仍是「窗口内，还剩 2 天」，说成「已过 13 天」会让人以为逾期了。
 * 窗口才是这件事的真实有效期。
 */
export function dueDescription(
  task: Pick<CareTask, 'dueDate' | 'windowDays'>,
  today: string = todayIso()
): string {
  const win = windowRange(task)
  if (today > win.to) return `已过期 ${daysBetween(today, win.to)} 天`
  if (today >= win.from) {
    const left = daysBetween(win.to, today)
    return left === 0 ? '今天是最后一天' : `时间窗内，还剩 ${left} 天`
  }
  return `还有 ${daysBetween(win.from, today)} 天`
}

/** 统计一组任务的完成情况，用于月历表头与概览。 */
export function summarizeTasks(tasks: CareTask[], today: string = todayIso()): {
  total: number
  pending: number
  done: number
  skipped: number
  overdue: number
  due: number
} {
  let pending = 0
  let done = 0
  let skipped = 0
  let overdue = 0
  let due = 0
  for (const t of tasks) {
    if (t.status === 'done') done++
    else if (t.status === 'skipped') skipped++
    else {
      pending++
      const u = urgencyOf(t, today)
      if (u === 'overdue') overdue++
      else if (u === 'due') due++
    }
  }
  return { total: tasks.length, pending, done, skipped, overdue, due }
}

export function taskStatusLabel(status: CareTaskStatus): string {
  return status === 'done' ? '已完成' : status === 'skipped' ? '已跳过' : '待办'
}
