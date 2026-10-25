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

import type { CareActionType, CarePhase, CareRule, CareTask } from './types'

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

/**
 * 养护日志的 kind → 中文标签。
 *
 * 为什么要单独一张表：`CareLog.kind` 是 `string`，比 `CareActionType` **宽** ——
 * 后端 `addCareLog` 在没给 kind 时写的是 `'note'`，而 `'note'` 根本不在
 * `CARE_ACTION_LABELS` 里。原来的代码是
 * `CARE_ACTION_LABELS[kind] ?? kind`，于是**把英文键名 note 直接显示给了用户**
 * （用户截图里那两个字就是这么来的）。
 *
 * 另一条兜底：认不出的 kind 显示「记录」而不是把原始值亮出来 ——
 * 那对用户没有任何意义。
 */
const LOG_KIND_ICONS: Record<string, string> = {
  ...CARE_ACTION_ICONS,
  note: '📝',
  phase: '🌿'
}

export const CARE_LOG_KIND_LABELS: Record<string, string> = {
  ...CARE_ACTION_LABELS,
  note: '记录',
  phase: '阶段标记'
}

/** 日志 kind → 「📝 记录」。认不出的一律落到「记录」。 */
export function logKindLabel(kind: string): string {
  const icon = LOG_KIND_ICONS[kind] ?? '📝'
  return `${icon} ${CARE_LOG_KIND_LABELS[kind] ?? '记录'}`
}

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
/**
 * 这条规则是否覆盖某个月（考虑跨年区间，如 11 月 ~ 次年 2 月）。
 *
 * 规则库现在只用来「提示这个月可能要做什么」，不生成任务，
 * 所以只要判断月份是否落在窗口里就够了。
 */
export function ruleCoversMonth(
  rule: { monthFrom: number; monthTo: number | null },
  month: number
): boolean {
  const from = rule.monthFrom
  const to = rule.monthTo ?? rule.monthFrom
  if (from <= to) return month >= from && month <= to
  // 跨年：11、12、1、2
  return month >= from || month <= to
}

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

const PHASE_KEYS = [
  'seed',
  'growing',
  'budding',
  'blooming',
  'dormant',
  'recovering',
  'pest'
] as const satisfies readonly CarePhase[]

export const CARE_PHASE_LABELS: Record<CarePhase, string> = {
  seed: '种子/种球期',
  growing: '生长期',
  budding: '花芽分化期',
  blooming: '花期',
  dormant: '休眠期',
  recovering: '缓苗期',
  pest: '病虫害期'
}

export const CARE_PHASE_ICONS: Record<CarePhase, string> = {
  seed: '🌰',
  growing: '🌱',
  budding: '🔍',
  blooming: '🌸',
  dormant: '😴',
  recovering: '🩹',
  pest: '🐛'
}

/** 界面上的说明：这个阶段什么时候算开始。 */
export const CARE_PHASE_HINTS: Record<CarePhase, string> = {
  seed: '播种到出苗、种球生根前，只做保湿和观察',
  growing: '春萌芽后，到花芽分化之前',
  budding: '现蕾之前，需要停高氮、改磷钾',
  blooming: '花苞显色开放，通常需要全部停肥',
  dormant: '落叶或低温停滞，水溶肥一律停',
  recovering: '缓苗、暴雨、换盆之后，只做恢复性处理',
  pest: '发现虫害/病斑期间，先处理病虫，暂停施肥'
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
/**
 * 是不是「月度事项」。
 *
 * 两个来源都算：
 *  - 由全年养护指南生成的任务（source='guide'）
 *  - 窗口长到覆盖大半个月的任务（旧数据没有 source 标记，靠这个兜底）
 *
 * 这类事的语义是「这个月内做完」，不是「某一天到期」：日历上只该出现一次，
 * 当天列表和「今天该做」也不该天天重复它。
 */
export function isMonthlyTask(t: { source?: string | null; windowDays?: number | null }): boolean {
  /*
   * 只看窗口长度。指南生成的「季节性事项」现在是正常的周级任务（7 天窗口），
   * 该出现在当天列表里；只有改造前那批「窗口开到月底」的月度任务才算特殊。
   */
  return typeof t.windowDays === 'number' && t.windowDays >= 20
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  // 用本地时间构造，和 toIsoDate 的取法一致，不会因为时区来回错一天
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  date.setDate(date.getDate() + days)
  return toIsoDate(date)
}

/**
 * 'YYYY-MM-DD' → 周四。
 *
 * 用 `new Date(y, m-1, d)` 解析：`new Date('2026-10-15')` 会按 UTC 解释，
 * 在东八区取出 getDay() 会差一天 —— 星期几错一天比不显示更糟。
 *
 * 放 core 而不是各页自己写：天气面板、今日页、月历的当天标题都要用，
 * 三份实现迟早会有一份忘了时区这回事。
 */
export function weekdayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] ?? ''
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
export function dateSpansFor(
  year: number,
  monthFrom: number,
  monthTo: number | null,
  monthFromDay = 1,
  monthToDay: number | null = null
): DateSpan[] {
  const months = monthsCovered({ monthFrom, monthTo })
  if (months.length === 0) return []

  const endMonth = monthTo === null || monthTo === undefined ? monthFrom : monthTo
  /** 把「几号」收口到当月真实天数内：2 月没有 30 号。 */
  const dayIn = (m: number, day: number | null): number => {
    const max = daysInMonth(year, m)
    if (day === null) return max
    return Math.min(Math.max(1, Math.trunc(day)), max)
  }
  /*
   * 区间端点的日：只有**包含起始月的那一段**用起始日，
   * 只有**包含结束月的那一段**用结束日 —— 中间的月份整月都在区间里。
   * 跨年拆成两段时（11~2 月），前一段从 11 月的起始日开始、到 12 月底；
   * 后一段从 1 月 1 日、到 2 月的结束日。
   */
  const spanStart = (m: number): DateSpan['from'] => {
    const day = m === monthFrom ? dayIn(m, monthFromDay) : 1
    return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const spanEnd = (m: number): DateSpan['to'] => {
    const day = m === endMonth ? dayIn(m, monthToDay) : dayIn(m, null)
    return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
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
    spans.push({ from: spanStart(runStart), to: spanEnd(prev) })
    runStart = cur
    prev = cur
  }
  spans.push({ from: spanStart(runStart), to: spanEnd(prev) })

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
  /** 生成时那条规则绑的配方。为空表示这条规则没有物品清单 */
  recipeId: number | null
}

/**
 * 把规则展开成某一年的一组任务。
 *
 * 两种节奏：
 *  - **按月**（默认）：区间内每月一条，日期取每个月的起始日；
 *    宽限从这一天到下一次之前（最后一次到区间结束）——
 *    于是「10 月 1 日」的这条整个 10 月都能做，而不是 15 天就过期。
 *  - **按天**（规则填了 repeatDays）：区间内每隔 N 天一条，
 *    宽限到下一次之前，相邻两次不会互相覆盖判定。
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
    /** @deprecated 宽限现在由规则区间算出来，这个参数不再使用。 */
    defaultWindowDays?: number
    /**
     * @deprecated 日期不再按植株错开（由规则的起始日决定）。
     * 保留这个参数只是为了不改一堆调用点，值会被忽略。
     */
    spreadSeed?: number
    /** 植株当前阶段。为空＝未标记，一切按月份走（不影响原有用法） */
    phase?: CarePhase | null
  } = {}
): GeneratedTask[] {
  const hemisphere = options.hemisphere ?? 'N'
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
    /*
     * 去重键。
     *
     * 按月 / 整段一次：**同一个月 + 同动作 + 同标题就算同一条** ——
     * 通用规则和物种专属规则写重了，只该留一条。
     * 这里不能带具体日期：默认「同日」是按**规则 id**取锚点，两条规则会算出
     * 两个不同的日子，带日期就永远去不了重（原来按植株错开时，两份规则
     * 恰好落在同一天，所以这个坑没露出来）。
     * 按天重复必须带日期，否则「每 N 天一轮」会被压成一条。
     */
    const period = rule.repeatDays && rule.repeatDays > 0 ? dueDate : dueDate.slice(0, 7)
    const signature = `${period}|${rule.actionType}|${title}`
    if (seen.has(signature)) return
    seen.add(signature)
    out.push({
      dueDate,
      title,
      detail: rule.detail,
      actionType: rule.actionType,
      priority: rule.priority,
      windowDays,
      ruleId: rule.id,
      // 冗余带一份配方：规则以后改了配方，已生成的任务仍显示当时那份
      recipeId: rule.recipeId ?? null
    })
  }

  for (const rule of applicable) {
    const spans = dateSpansFor(
      year,
      rule.monthFrom,
      rule.monthTo,
      rule.monthFromDay ?? 1,
      rule.monthToDay ?? null
    )
    if (spans.length === 0) continue

    const rotation = (rule.rotation ?? []).map((s) => s.trim()).filter(Boolean)
    /*
     * 日期由规则的**区间两端**决定：起始月/日 ~ 结束月/日。
     *
     * 不再有「每月几号」这种全局锚点，也不按植株或规则编号错开 ——
     * 每月一条的规则，日期就是每个月的「起始日」（例如起始 3/15，
     * 就是 3/15、4/15、5/15…，超出区间的那个月不生成）。
     */
    const fromDay = Math.max(1, Math.trunc(rule.monthFromDay ?? 1))
    const dateInMonth = (month: number): string => {
      const day = Math.min(fromDay, daysInMonth(year, month))
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
    /** 这个日期是否落在规则区间内（跨年时可能有两段） */
    const inWindow = (date: string): boolean => spans.some((s) => date >= s.from && date <= s.to)
    /** 从 dueDate 到 endDate 的宽限天数（窗口现在是「到期日 → 到期日+N」，见 windowRange） */
    const untilDays = (dueDate: string, endDate: string): number =>
      Math.max(0, daysBetween(endDate < dueDate ? dueDate : endDate, dueDate))

    // ---- 按天重复 ----
    if (rule.repeatDays !== null && rule.repeatDays !== undefined && rule.repeatDays > 0) {
      const step = Math.max(1, Math.trunc(rule.repeatDays))
      let index = 0

      for (const span of spans) {
        // 从区间起点开始按 N 天一轮
        let cursor = span.from
        // 上限保护：即使 repeatDays 被填成 1，也不会无限循环
        for (let guard = 0; guard < 400 && cursor <= span.to; guard++) {
          const label = rotation.length > 0 ? ` · ${rotation[index % rotation.length]}` : ''
          // 宽限到下一次之前（或区间结束），这样相邻两次不会互相覆盖
          const next = addDays(cursor, step)
          const end = next <= span.to ? addDays(next, -1) : span.to
          push(cursor, rule, `${rule.title}${label}`, untilDays(cursor, end))
          index++
          cursor = next
        }
      }
      continue
    }

    /*
     * ---- 窗口内只做一次 ----
     *
     * 「10~11 月」原样填会生成两条任务，但底肥一季只埋一次 ——
     * 那时只能把区间收窄到单月来绕过，规则本身表达不了「这个窗口里做一次就够」。
     *
     * 按 **spans** 而不是月份迭代：连续几个月在 dateSpansFor 里已经合成一段，
     * 而跨年写法（11,12,1,2）会断开成两段 —— 那本来就该是两个窗口。
     *
     * 日期落在区间起点（底肥这类事早做比晚做好），**宽限到区间结束**。
     */
    if (rule.oncePerWindow) {
      for (const span of spans) {
        push(span.from, rule, rule.title, untilDays(span.from, span.to))
      }
      continue
    }

    // ---- 每月一条（原行为）----
    // 注意：这里必须按**月份**迭代而不是 spans —— 3~4 月是连续的两个月，
    // dateSpansFor 会把它们合成一个 span，按 span 走只会产出一条任务。
    const occurrences: Array<{ date: string; end: string }> = []
    for (const month of monthsCovered(rule)) {
      const dueDate = dateInMonth(month)
      // 结束日早于起始日时，最后一个月那条会落到区间外（如 3/15~6/10 的 6 月），不生成
      if (!inWindow(dueDate)) continue
      const span = spans.find((s) => dueDate >= s.from && dueDate <= s.to)
      if (!span) continue
      occurrences.push({ date: dueDate, end: span.to })
    }
    // 每月这条的宽限：到下一次之前（最后一次到区间结束），
    // 于是「10 月 1 日」的任务整个 10 月都能做，而不是 15 天就过期
    occurrences.sort((a, b) => a.date.localeCompare(b.date))
    for (let i = 0; i < occurrences.length; i++) {
      const cur = occurrences[i]
      const next = occurrences[i + 1]
      /*
       * 宽限到「下一次之前」，但**不能跨出本段区间**。
       *
       * 跨年规则（11~2 月）会拆成两段：2/1 的下一次是 11/1，
       * 中间隔着 8 个月 —— 直接取「下一次前一天」会得到 10/31，
       * 于是 2 月的任务在整个夏天都算「该做了」。
       */
      const untilNext = next ? addDays(next.date, -1) : cur.end
      const end = untilNext < cur.end ? untilNext : cur.end
      push(cur.date, rule, rule.title, untilDays(cur.date, end))
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

/**
 * 任务的可执行区间。
 *
 * ⚠️ **窗口从到期日当天开始，往后延续 windowDays 天** —— 不是 ±N。
 *
 * 原来的 ±N 表示「提前 N 天就能做」，于是 10 月 1 日的任务在 9 月 16 日就
 * 算「该做了」，反过来 10 月 18 日又已经「已过期」（窗口 10-16 结束）——
 * 用户的原话是「生成的任务的时间窗不对」：规则写的是 10 月 1 日到 10 月 31 日，
 * 那这件事整个 10 月都应该能做。
 *
 * 所以 windowDays 现在的含义是「到期之后还能拖几天」：生成任务时按规则的
 * 日期区间算出这段宽限（10 月的任务 → 到 10 月 31 日为止），
 * 手动任务则用它自己填的宽限天数。
 */
export function windowRange(task: Pick<CareTask, 'dueDate' | 'windowDays'>): CareWindow {
  const w = Math.max(0, task.windowDays)
  return { from: task.dueDate, to: addDays(task.dueDate, w) }
}

/**
 * 把**同一条规则、同一天、同一个标题**的任务合成一组。
 *
 * 一条「秋季补肥」规则管着七株时，今日页原来会列出七行只差植株名的卡片；
 * 而实际动作是「今天把这几盆都补一遍」。合并后一行里挑植株即可。
 *
 * 手动任务没有 ruleId，永远各自一组（它们是各自独立的事）。
 * 返回顺序沿用原列表的首次出现顺序，不重新排序 —— 调用方已经排好了。
 */
export function groupTasksByRule<
  T extends { id: number; ruleId: number | null; dueDate: string; title: string }
>(tasks: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const task of tasks) {
    const key =
      task.ruleId === null ? `manual-${task.id}` : `rule-${task.ruleId}|${task.dueDate}|${task.title}`
    const list = groups.get(key)
    if (list) list.push(task)
    else groups.set(key, [task])
  }
  return [...groups.values()]
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

/**
 * 未完成任务按紧急度分桶。**今日页和养护计划共用这一份。**
 *
 * 存在的理由是一次真实的矛盾：今日页按「全部未完成」算，养护计划按
 * 「当月任务 + 另外补逾期」算，于是同一天同一批数据，
 * 一边写「今天该做 10」、一边写「该做了 6」——
 * 差的那 4 条是时间窗已经开始、到期日落在下个月的。
 * 用户一眼看出不对，但两边各自的算法都「说得通」。
 *
 * 所以口径只留一处：**全部未完成任务都进桶，不分月份**。
 * 月份只影响月历上画在哪个格子。
 *
 * ⚠️ `due` 和 `early` 的分界（1.8.4 加的）：
 * 时间窗一开就算「该做了」的话，11 月 2 日的任务在 10 月 18 日就进了
 * 「今天该做」——用户的原话是「今日要做怎么会有大于今天的计划」。
 * 所以窗口内再按**到期日**分一次：
 *   - `due`  ：到期日 ≤ 今天（真该做了，含时间窗内的「补做」）
 *   - `early`：到期日 > 今天（窗口开了，可以提前做，但不叫今天该做）
 * 今日页只列 `due`，`early` 只给一行数量 + 入口；养护计划的「该做」也只看 `due`。
 */
export function pendingBuckets<T extends Pick<CareTask, 'status' | 'dueDate' | 'windowDays' | 'priority'>>(
  tasks: T[],
  today: string = todayIso()
): { overdue: T[]; due: T[]; early: T[]; soon: T[]; later: T[] } {
  const buckets = {
    overdue: [] as T[],
    due: [] as T[],
    early: [] as T[],
    soon: [] as T[],
    later: [] as T[]
  }
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    const urgency = urgencyOf(task, today)
    if (urgency === 'closed') continue
    if (urgency === 'due') {
      // 窗口内：到期日还没到 → 「可以提前做」，不算今天该做
      if (task.dueDate > today) buckets.early.push(task)
      else buckets.due.push(task)
      continue
    }
    buckets[urgency].push(task)
  }
  // 同紧急度里：先按日期，再按优先级。两页的顺序也就不用各写一遍。
  const order = (a: T, b: T): number => a.dueDate.localeCompare(b.dueDate) || a.priority - b.priority
  buckets.overdue.sort(order)
  buckets.due.sort(order)
  buckets.early.sort(order)
  buckets.soon.sort(order)
  buckets.later.sort(order)
  return buckets
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
