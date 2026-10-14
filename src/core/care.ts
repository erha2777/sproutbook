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

import type { CareActionType, CarePhase, CareRule, CareTask, CareTaskStatus } from './types'

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
// 规则的适用物种
// ---------------------------------------------------------------------------

/**
 * 一条规则可以同时适用于多个物种。
 *
 * 起因是用户真实的底肥方案：「绣球、无花果、月季」共用一套配比，
 * 「杜鹃、中华木绣球、三角梅」共用另一套，蓝莓单独一套。
 * 原来的单值 species_key 只能一物种一条规则 —— 三个组合要建七条，
 * 改一次配比得改七处，迟早不同步。
 *
 * 存储用 JSON 数组。旧数据是纯字符串（单个物种名或 `*`），
 * 解析时原样当成一个 key，不必先迁移也能读。
 */
export function parseSpeciesKeys(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return [UNIVERSAL_SPECIES_KEY]
  if (trimmed === UNIVERSAL_SPECIES_KEY) return [UNIVERSAL_SPECIES_KEY]

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        const list = [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))]
        if (list.length > 0) {
          // 「通用 + 某个物种」是冗余的，通用已经覆盖一切
          return list.includes(UNIVERSAL_SPECIES_KEY) ? [UNIVERSAL_SPECIES_KEY] : list
        }
      }
    } catch {
      // 坏数据退回当单个名字处理，不因为一条规则读不出来就整个列表失败
    }
  }
  return [trimmed]
}

export function serializeSpeciesKeys(keys: string[]): string {
  const cleaned = [...new Set(keys.map((k) => k.trim()).filter(Boolean))]
  if (cleaned.length === 0 || cleaned.includes(UNIVERSAL_SPECIES_KEY)) {
    return JSON.stringify([UNIVERSAL_SPECIES_KEY])
  }
  return JSON.stringify(cleaned)
}

export function isUniversalRule(keys: string[]): boolean {
  return keys.includes(UNIVERSAL_SPECIES_KEY)
}

/** 规则的适用物种里是否包含这株植物的物种。 */
export function ruleMatchesSpecies(keys: string[], speciesName: string | null): boolean {
  if (isUniversalRule(keys)) return true
  const name = speciesName?.trim().toLowerCase() ?? ''
  if (name === '') return false
  return keys.some((k) => k.trim().toLowerCase() === name)
}

/** 界面上显示用：通用 或 「月季、绣球、无花果」 */
export function describeSpeciesKeys(keys: string[]): string {
  return isUniversalRule(keys) ? '通用' : keys.join('、')
}

// ---------------------------------------------------------------------------
// 物候阶段
// ---------------------------------------------------------------------------

/**
 * 植株的物候阶段。
 *
 * 这些东西是**观察到的状态**，不是月份 —— 同一个月里，南阳台的可能已经现蕾，
 * 北窗台的还没动。所以它记在植株上、由人来标记，而不是从日期推算。
 *
 * 它的主要用途是表达「什么时候停」：把「生长期追肥」限定在
 * growing / budding，休眠期它就自动不生效了 —— 停用不需要另一套机制。
 */
export type { CarePhase }

const PHASE_KEYS = ['growing', 'budding', 'blooming', 'dormant', 'recovering'] as const satisfies readonly CarePhase[]

export const CARE_PHASE_LABELS: Record<CarePhase, string> = {
  growing: '生长期',
  budding: '花芽分化期',
  blooming: '花期',
  dormant: '休眠期',
  recovering: '缓苗期'
}

export const CARE_PHASE_ICONS: Record<CarePhase, string> = {
  growing: '🌱',
  budding: '🔍',
  blooming: '🌸',
  dormant: '😴',
  recovering: '🩹'
}

/** 界面上的说明：这个阶段什么时候算开始。 */
export const CARE_PHASE_HINTS: Record<CarePhase, string> = {
  growing: '春萌芽后，到花芽分化之前',
  budding: '现蕾之前，需要停高氮、改磷钾',
  blooming: '花苞显色开放，通常需要全部停肥',
  dormant: '落叶或低温停滞，水溶肥一律停',
  recovering: '缓苗、暴雨、换盆之后，只做恢复性处理'
}

export const CARE_PHASE_OPTIONS = (Object.keys(CARE_PHASE_LABELS) as CarePhase[]).map((value) => ({
  value,
  label: `${CARE_PHASE_ICONS[value]} ${CARE_PHASE_LABELS[value]}`
}))

export function isCarePhase(value: unknown): value is CarePhase {
  return typeof value === 'string' && (PHASE_KEYS as readonly string[]).includes(value)
}

/**
 * 当前阶段已经持续了几天。
 *
 * 存在的理由：阶段是人工标记的，**没有自动过期**。像「缓苗期」这种临时状态，
 * 标记完很容易忘记改回来 —— 那株植物就会一直只浇海藻精、永远不施主肥。
 * 界面上把「已标记 N 天」显示出来，是提醒你回头重新看一眼。
 *
 * phase_changed_at 存的是 UTC 时间戳，这里先转成本地日期再算差，
 * 否则凌晨那几个小时会差一天。
 */
export function phaseAgeDays(changedAt: string | null | undefined, today: string = todayIso()): number | null {
  if (!changedAt) return null
  const ms = Date.parse(changedAt)
  if (Number.isNaN(ms)) return null
  const changedLocal = toIsoDate(new Date(ms))
  return Math.max(0, daysBetween(today, changedLocal))
}

/** 把任意输入收敛成合法的阶段数组；空数组返回 null（＝不限阶段）。 */
export function normalizePhases(input: unknown): CarePhase[] | null {
  if (!Array.isArray(input)) return null
  const list = [...new Set(input.filter(isCarePhase))]
  return list.length > 0 ? list : null
}

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

export interface DateSpan {
  /** YYYY-MM-DD，含 */
  from: string
  /** YYYY-MM-DD，含 */
  to: string
}

/**
 * 规则在**指定年份内**覆盖的日期区间。
 *
 * 跨年区间（如 11~2 月）会拆成两段，而不是横跨到次年 ——
 * 因为计划是按年生成的：横跨的话，2026 年的计划会产出 2027 年 2 月的任务，
 * 而生成 2027 年计划时又会产出一次，同一件事出现两遍。
 * 拆成「年初 1~2 月 + 年末 11~12 月」既在一个自然年内，也不重不漏。
 */
export function dateSpansFor(year: number, monthFrom: number, monthTo: number | null): DateSpan[] {
  const months = monthsCovered({ monthFrom, monthTo })
  if (months.length === 0) return []

  const monthSpan = (m: number): DateSpan => {
    const mm = String(m).padStart(2, '0')
    return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(daysInMonth(year, m)).padStart(2, '0')}` }
  }

  const sorted = [...months].sort((a, b) => a - b)
  const spans: DateSpan[] = []

  // monthsCovered 是「环绕顺序」（11,12,1,2），排序后会变成两段
  let runStart = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    if (cur === prev + 1) {
      prev = cur
      continue
    }
    spans.push({ from: monthSpan(runStart).from, to: monthSpan(prev).to })
    runStart = cur
    prev = cur
  }
  spans.push({ from: monthSpan(runStart).from, to: monthSpan(prev).to })

  return spans
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
 * 两种节奏：
 *  - **按月**（默认）：区间内每月一条，日期取该月的锚点日（见 spreadDay），
 *    时间窗默认 ±15 天 —— 也就是「这个月内做都行」。
 *  - **按天**（规则填了 repeatDays）：区间内每隔 N 天一条。
 *    这是为「7~10 天一轮」这类真实节奏准备的；时间窗收窄到半个间隔，
 *    这样相邻两次不会互相覆盖判定。
 *
 * 规则填了 rotation 时，每次取序列里的下一步，标题变成「追肥 · 花多多1号」，
 * 循环使用 —— 对应施肥方案里的三肥轮换。
 *
 * 规则填了 activePhases 时，只在该植株正处于这些阶段之一时才生效
 * （且忽略月份区间）—— 这就是「停用」的实现方式：
 * 「休眠期停止水溶追肥」＝「这条追肥规则只在生长期/花芽分化期生效」。
 */
export function generateTasks(
  rules: CareRule[],
  speciesName: string | null,
  year: number,
  options: {
    hemisphere?: 'N' | 'S'
    defaultWindowDays?: number
    spreadSeed?: number
    /** 植株当前阶段。为空＝未标记，一切按月份走（不影响原有用法） */
    phase?: CarePhase | null
  } = {}
): GeneratedTask[] {
  const hemisphere = options.hemisphere ?? 'N'
  const defaultWindow = options.defaultWindowDays ?? 15
  const seed = options.spreadSeed ?? 0
  const phase = options.phase ?? null

  const applicable = rules.filter((r) => {
    if (r.hemisphere !== hemisphere) return false
    if (!ruleMatchesSpecies(r.speciesKeys, speciesName)) return false

    // 限定了阶段：只有植株正处于其中某个阶段时才生效。
    // 注意「没标记阶段」的情况：这时阶段规则一律不生效 ——
    // 宁可少提醒，也不要在一个你不知道处于什么状态的植株上瞎排任务。
    if (r.activePhases && r.activePhases.length > 0) {
      return phase !== null && r.activePhases.includes(phase)
    }
    return true
  })

  const out: GeneratedTask[] = []
  const seen = new Set<string>()

  const push = (dueDate: string, rule: CareRule, title: string, windowDays: number): void => {
    const signature = `${dueDate}|${rule.actionType}|${title}`
    if (seen.has(signature)) return
    seen.add(signature)
    out.push({
      dueDate,
      title,
      detail: rule.detail,
      actionType: rule.actionType,
      priority: rule.priority,
      windowDays,
      ruleId: rule.id
    })
  }

  for (const rule of applicable) {
    const spans = dateSpansFor(year, rule.monthFrom, rule.monthTo)
    if (spans.length === 0) continue

    const rotation = (rule.rotation ?? []).map((s) => s.trim()).filter(Boolean)

    // ---- 按天重复 ----
    if (rule.repeatDays !== null && rule.repeatDays !== undefined && rule.repeatDays > 0) {
      const step = Math.max(1, Math.trunc(rule.repeatDays))
      // 相邻两次不能共用同一个判定窗口，否则「该做了」会一直亮着
      const win = Math.max(1, Math.min(defaultWindow, Math.floor(step / 2)))
      let index = 0

      for (const span of spans) {
        // 起始日按植株错开，避免所有植物同一天施肥
        const offset = Math.max(0, spreadDay(year, Number(span.from.slice(5, 7)), seed) - 1)
        let cursor = addDays(span.from, offset)
        // 上限保护：即使 repeatDays 被填成 1，也不会无限循环
        for (let guard = 0; guard < 400 && cursor <= span.to; guard++) {
          const label = rotation.length > 0 ? ` · ${rotation[index % rotation.length]}` : ''
          push(cursor, rule, `${rule.title}${label}`, win)
          index++
          cursor = addDays(cursor, step)
        }
      }
      continue
    }

    // ---- 每月一条（原行为）----
    // 注意：这里必须按**月份**迭代而不是 spans —— 3~4 月是连续的两个月，
    // dateSpansFor 会把它们合成一个 span，按 span 走只会产出一条任务。
    for (const month of monthsCovered(rule)) {
      const day = spreadDay(year, month, seed)
      push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, rule, rule.title, defaultWindow)
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
