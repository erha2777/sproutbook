/**
 * 生长阶段推导。
 *
 * 花园视图要回答一个很朴素的问题：**这盆现在长到哪一步了？**
 *
 * 输入来自三个地方，优先级从硬到软：
 *  1. 植株状态（枯死、生病）—— 这是事实，盖过一切
 *  2. 物候阶段 —— 你亲眼看到的，比任何推算都准
 *  3. 开花月份 / 休眠月份 / 入手日期 —— 没人工标记时才靠推算
 *
 * 之所以要分优先级：同一个月里，南阳台的可能已经现蕾、北窗台的还没动。
 * 纯按月份推算会让花园长得一模一样，那这个视图就没有意义了。
 */

import type { CarePhase, PlantStatus } from './types'
import { CARE_PHASE_LABELS } from './care'

// ---------------------------------------------------------------------------
// 阶段
// ---------------------------------------------------------------------------

export type GrowthStage =
  | 'seed' // 播种 / 刚埋下
  | 'sprout' // 幼苗
  | 'growing' // 生长
  | 'budding' // 现蕾
  | 'blooming' // 开花
  | 'dormant' // 休眠
  | 'sick' // 有状况
  | 'recovering' // 缓苗中
  | 'withered' // 枯死

export const GROWTH_STAGE_LABELS: Record<GrowthStage, string> = {
  seed: '播种',
  sprout: '幼苗',
  growing: '生长',
  budding: '现蕾',
  blooming: '开花',
  dormant: '休眠',
  sick: '有状况',
  recovering: '缓苗中',
  withered: '枯死'
}

/** 推导结果的来源，界面上要说清楚「这是推算的还是你标的」。 */
export type GrowthSource = 'status' | 'phase' | 'bloom' | 'dormancy' | 'age' | 'default'

export const GROWTH_SOURCE_LABELS: Record<GrowthSource, string> = {
  status: '按植株状态',
  phase: '按你标记的阶段',
  bloom: '按开花月份推算',
  dormancy: '按休眠月份推算',
  age: '按入手时间推算',
  default: '默认'
}

export interface GrowthResult {
  stage: GrowthStage
  source: GrowthSource
  /** 给界面用的一句话解释 */
  reason: string
}

// ---------------------------------------------------------------------------
// 推导
// ---------------------------------------------------------------------------

/** 入手多久之内算「幼苗」。 */
const SPROUT_DAYS = 45

/**
 * 从物种属性里读「月份集合」。
 *
 * 属性值经过导入、AI 补全、手工编辑之后可能是数组、单个数字、
 * 甚至 "4,5,6" 这样的字符串 —— 只要有一种没考虑到，
 * 花园里就会出现「明明在花期却显示生长期」这种查不出原因的现象。
 */
export function readMonthSet(value: unknown): number[] {
  const clean = (n: unknown): number[] => {
    const v = Number(n)
    return Number.isFinite(v) && v >= 1 && v <= 12 ? [Math.trunc(v)] : []
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap(clean))].sort((a, b) => a - b)
  if (typeof value === 'string') return [...new Set(value.split(/[,，、\s]+/).flatMap(clean))].sort((a, b) => a - b)
  return clean(value)
}

function daysSince(iso: string | null | undefined, today: string): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  const a = iso.slice(0, 10).split('-').map(Number)
  const b = today.split('-').map(Number)
  const diff = (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000
  return Number.isFinite(diff) ? Math.round(diff) : null
}

/**
 * 物候阶段 → 生长阶段的直接映射。人标了就以人的为准。
 *
 * 注意「缓苗期」有自己的阶段，**不是幼苗**。
 * 第一版把它映射成 sprout，结果一株成熟的朱顶红只要标了缓苗期，
 * 在花园里就被画成两像素的嫩芽 —— 但它球体还是那么大、根系还在，
 * 只是掉了叶子。缓苗是**临时状态**，不是「这株还小」。
 */
const PHASE_TO_STAGE: Record<CarePhase, GrowthStage> = {
  growing: 'growing',
  budding: 'budding',
  blooming: 'blooming',
  dormant: 'dormant',
  recovering: 'recovering'
}

export interface GrowthInput {
  /** 物种的株型（决定用哪套素材）。推导本身不用它，透传给渲染层。 */
  growthHabit?: string | null
  /** 物种的开花月份（1~12） */
  bloomMonths?: number[] | null
  /** 物种的休眠月份（1~12） */
  dormancyMonths?: number[] | null
  /** 植株状态 */
  status?: PlantStatus | null
  /** 人工标记的物候阶段 */
  phase?: CarePhase | null
  /** 入手 / 播种日期 YYYY-MM-DD */
  acquiredAt?: string | null
  /** 今天，便于自检注入固定日期 */
  today: string
}

export function deriveGrowthStage(input: GrowthInput): GrowthResult {
  const today = input.today
  const month = Number(today.slice(5, 7))

  // 1) 植株状态是事实，盖过一切推算
  if (input.status === 'dead') {
    return { stage: 'withered', source: 'status', reason: '植株状态记为「已枯死」' }
  }
  if (input.status === 'sick') {
    return { stage: 'sick', source: 'status', reason: '植株状态记为「有状况」' }
  }
  if (input.status === 'dormant') {
    return { stage: 'dormant', source: 'status', reason: '植株状态记为「休眠」' }
  }

  // 2) 人工标记的物候阶段 —— 你亲眼看到的，比月份推算准
  if (input.phase) {
    return {
      stage: PHASE_TO_STAGE[input.phase],
      source: 'phase',
      // 说中文。第一版这里直接拼了内部键名，界面上出现「你标记为「blooming」阶段」
      reason: `你标记为「${CARE_PHASE_LABELS[input.phase]}」`
    }
  }

  // 3) 按月份推算
  const bloom = input.bloomMonths ?? []
  const dormancy = input.dormancyMonths ?? []

  if (bloom.includes(month)) {
    return { stage: 'blooming', source: 'bloom', reason: `${month} 月在开花期内` }
  }
  // 下个月要开花，这个月该现蕾了。跨年时 12 月的下一个月是 1 月。
  const nextMonth = month === 12 ? 1 : month + 1
  if (bloom.includes(nextMonth) && !dormancy.includes(month)) {
    return { stage: 'budding', source: 'bloom', reason: `下个月（${nextMonth} 月）进入开花期` }
  }
  if (dormancy.includes(month)) {
    return { stage: 'dormant', source: 'dormancy', reason: `${month} 月在休眠期内` }
  }

  // 4) 刚入手不久，当成幼苗
  const age = daysSince(input.acquiredAt, today)
  if (age !== null && age >= 0 && age <= SPROUT_DAYS) {
    return { stage: 'sprout', source: 'age', reason: `入手才 ${age} 天` }
  }

  return { stage: 'growing', source: 'default', reason: '没有特殊标记，按生长期显示' }
}

// ---------------------------------------------------------------------------
// 渲染参数
// ---------------------------------------------------------------------------

/**
 * 一个阶段该画成什么样。
 *
 * 用参数而不是每个阶段一张图：9 种株型 × 8 个阶段 = 72 张手绘贴图，
 * 画不完也维护不动。改成「主茎多高、几对叶、有没有花、枯到什么程度」，
 * 渲染层按参数拼出来，株型只影响形状。
 */
export interface GrowthLook {
  /** 主茎高度（像素格） */
  stem: number
  /** 叶片对数 */
  leaves: number
  /** 花的状态 */
  flower: 'none' | 'bud' | 'open'
  /** 枯萎程度 0~1，影响颜色和下垂 */
  wither: number
  /** 是否落叶（休眠时只剩枝干） */
  bare: boolean
}

export function growthLook(stage: GrowthStage): GrowthLook {
  switch (stage) {
    case 'seed':
      return { stem: 0, leaves: 0, flower: 'none', wither: 0, bare: false }
    case 'sprout':
      return { stem: 2, leaves: 1, flower: 'none', wither: 0, bare: false }
    case 'growing':
      return { stem: 6, leaves: 3, flower: 'none', wither: 0, bare: false }
    case 'budding':
      return { stem: 7, leaves: 3, flower: 'bud', wither: 0, bare: false }
    case 'blooming':
      return { stem: 8, leaves: 4, flower: 'open', wither: 0, bare: false }
    case 'dormant':
      return { stem: 4, leaves: 0, flower: 'none', wither: 0.25, bare: true }
    case 'sick':
      return { stem: 5, leaves: 2, flower: 'none', wither: 0.45, bare: false }
    /*
     * 缓苗中：**保持成株高度**，只是叶子稀少、颜色偏淡。
     * 它不该被画小 —— 缓苗说明这株受了伤，不说明它还小。
     */
    case 'recovering':
      return { stem: 7, leaves: 1, flower: 'none', wither: 0.15, bare: false }
    case 'withered':
      return { stem: 3, leaves: 0, flower: 'none', wither: 1, bare: true }
  }
}

/** 0~1 的进度，用于排序或进度条。 */
export const GROWTH_STAGE_PROGRESS: Record<GrowthStage, number> = {
  seed: 0,
  sprout: 0.15,
  growing: 0.45,
  budding: 0.7,
  blooming: 1,
  dormant: 0.3,
  sick: 0.35,
  // 缓苗是「受伤后恢复」，不是没长大 —— 进度按成株算
  recovering: 0.6,
  withered: 0
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/** 从物种属性里读一个数字。属性值可能是字符串（导入/AI 补全之后很常见）。 */
export function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    // 空串必须先挡掉：Number('') 是 0，会被当成「高度 0」而不是「没填」
    if (text === '') return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 物种大小 → 花园里的显示比例。
 *
 * 起因：第一版所有植物都画成一样大。量了一下，九种株型在开花阶段
 * 纵向只差 9~15 格 —— 一株两米的乔木和一个十厘米的多肉看起来差不多，
 * 而物种模板里明明有「成株高度」这个字段，花园根本没读。
 * 真实高度差着几十倍却画成一样大，这个视图就失去意义了。
 *
 * 用**对数刻度**：10cm 到 20cm 的视觉差别，比 200cm 到 300cm 明显得多。
 * 线性刻度会让小草全挤在底部、大树全顶格，中间一片空白。
 */
export function sizeScaleFor(matureHeightCm: number | null | undefined): number {
  const MIN_CM = 10
  const MAX_CM = 500
  const MIN_SCALE = 0.42
  const MAX_SCALE = 1

  const cm = readNumber(matureHeightCm)
  // 走到这里说明连株型都没有，给个中等值
  if (cm === null || cm <= 0) return 0.72

  const clamped = Math.min(MAX_CM, Math.max(MIN_CM, cm))
  const t = Math.log(clamped / MIN_CM) / Math.log(MAX_CM / MIN_CM)
  return MIN_SCALE + (MAX_SCALE - MIN_SCALE) * t
}

/**
 * 不知道高度时，按株型猜一个常见值。
 *
 * 起因是一个真实的反馈：用户填了「现状高度 1.0 m」，花园里**一点变化都没有**。
 * 量了一下确实只差 1 像素 —— 因为原来的默认值是不分株型的 0.78，
 * 而它恰好落在最常见的 1 米左右，填与不填自然一样。
 *
 * 更好的做法是别用「所有植物的中位数」：不知道高度，但知道是藤本还是多肉，
 * 而这两类的常见尺寸差着十倍。
 */
const HABIT_TYPICAL_CM: Record<string, number> = {
  多肉: 12,
  水生: 30,
  附生: 30,
  草本: 35,
  蕨类: 40,
  球根: 45,
  灌木: 120,
  藤本: 200,
  乔木: 500
}

/** 连株型都没填时的兜底。 */
const UNKNOWN_TYPICAL_CM = 60

/** 给界面看的一句话说明。 */
export function describeSize(cm: number | null | undefined): string {
  const v = readNumber(cm)
  if (v === null || v <= 0) return '成株高度未知'
  const text = v >= 100 ? `${(v / 100).toFixed(v % 100 === 0 ? 0 : 1)} m` : `${Math.round(v)} cm`
  return `成株 ${text}`
}

/** 木本才会随年龄长大。草本、多肉一个季度就长到全尺寸，年龄不说明大小。 */
const WOODY_HABITS = new Set(['乔木', '灌木', '藤本'])

/**
 * 苗龄 → 相对成株的比例。
 *
 * 用饱和曲线而不是线性：木本头几年长得快、后面趋缓。
 * 线性的话「养了 20 年」会算出 3 倍于成株的荒谬结果。
 */
export function ageFactor(ageYears: number | null | undefined, habit: string | null | undefined): number {
  const age = readNumber(ageYears)
  if (age === null || age < 0) return 1
  if (!WOODY_HABITS.has((habit ?? '').trim())) return 1
  return 0.3 + 0.7 * (1 - Math.exp(-age / 4))
}

export interface EffectiveHeightInput {
  /** 植株的「现状高度」：你自己量的，最准 */
  actualHeight?: unknown
  /** 物种的「成株高度」 */
  matureHeight?: unknown
  /** 植株的「苗龄」 */
  ageYears?: unknown
  /** 物种的「株型」，决定年龄算不算数 */
  habit?: string | null
}

export interface EffectiveHeight {
  /** 用来算显示高度的厘米数；null 表示完全没依据 */
  cm: number | null
  /** 这个数字是怎么来的 */
  basis: 'measured' | 'estimated' | 'mature' | 'habit' | 'unknown'
}

export const HEIGHT_BASIS_LABELS: Record<EffectiveHeight['basis'], string> = {
  measured: '你量的现状高度',
  estimated: '按成株高度 × 苗龄推算',
  mature: '按物种的成株高度',
  habit: '按株型的常见高度推测',
  unknown: '没有高度数据'
}

/**
 * 一株植物在花园里该按多大画。
 *
 * 优先级：**实测 > 推算 > 物种上限 > 株型推测**。
 * 「成株高度」是这个品种能长多大，不是这株现在多大 ——
 * 一株刚买的乔木苗和一株养了十年的，不该画成一样大。
 *
 * 最后那层「株型推测」是后加的：原来是统一给个中位数，
 * 结果用户填了真实高度反而看不出变化（那个中位数恰好就是常见值）。
 */
export function effectiveHeight(input: EffectiveHeightInput): EffectiveHeight {
  const actual = readNumber(input.actualHeight)
  if (actual !== null && actual > 0) return { cm: actual, basis: 'measured' }

  const mature = readNumber(input.matureHeight)
  if (mature !== null && mature > 0) {
    const age = readNumber(input.ageYears)
    if (age !== null && age >= 0 && WOODY_HABITS.has((input.habit ?? '').trim())) {
      return { cm: mature * ageFactor(age, input.habit), basis: 'estimated' }
    }
    return { cm: mature, basis: 'mature' }
  }

  const habit = (input.habit ?? '').trim()
  return { cm: HABIT_TYPICAL_CM[habit] ?? UNKNOWN_TYPICAL_CM, basis: 'habit' }
}

/** 高度的中文描述，带上依据和显示比例 —— 让「填了到底有没有生效」看得见。 */
export function describeEffectiveHeight(input: EffectiveHeightInput): string {
  const { cm, basis } = effectiveHeight(input)
  if (cm === null) return '大小无依据'
  const text = cm >= 100 ? `${(cm / 100).toFixed(1)} m` : `${Math.round(cm)} cm`
  const scale = Math.round(sizeScaleFor(cm) * 100)
  return `${text}（${HEIGHT_BASIS_LABELS[basis]} · 显示 ${scale}%）`
}
