/**
 * 物候阶段：**自动推算**，不是手动标记。
 *
 * 这两个概念以前混在一起 —— 界面上有一排「生长期 / 花芽分化期 / 花期 / 休眠期」
 * 按钮让人点，点了还会写日志、重排任务。但植物在哪个时期是**物种 + 日期**决定的：
 * 月季 4 月开花，不是"用户觉得它在开花"。
 *
 * 现在分成两层：
 *   - **状态（PlantStatus）**：你亲眼看到的事实，手动设。种子没发芽、缓苗、有花芽、正开着花……
 *   - **阶段（CarePhase）**：由状态和物种的花期 / 休眠月份推出来，只用来显示和给规则用。
 *
 * 例外：状态里那些"事件性"的（种子 / 缓苗 / 病虫害）会直接决定阶段 ——
 * 缓苗中的植物谈不上"花期"，这是观察压过推算。
 */

import type { CarePhase, PlantStatus } from './types'

export type PhaseSource = 'status' | 'bloom' | 'dormancy' | 'default' | 'unknown'

export interface PhaseDerivation {
  /** 推不出阶段时是 null（例如已枯死 / 已送人） */
  phase: CarePhase | null
  source: PhaseSource
  /** 给人看的一句话依据 */
  reason: string
}

export interface PhaseInput {
  status?: PlantStatus | null
  /** 物种的开花月份（1~12） */
  bloomMonths?: number[] | null
  /** 物种的休眠月份（1~12） */
  dormancyMonths?: number[] | null
  /** 今天，便于自检注入固定日期 */
  today: string
}

/** 手动状态直接对应的阶段（观察压过推算） */
const STATUS_PHASE: Partial<Record<PlantStatus, CarePhase>> = {
  seed: 'seed',
  recovering: 'recovering',
  sick: 'pest',
  budding: 'budding',
  blooming: 'blooming',
  dormant: 'dormant'
}

const STATUS_REASON: Partial<Record<PlantStatus, string>> = {
  seed: '状态是「种子 / 种球」，还没发芽',
  recovering: '状态是「缓苗」',
  sick: '状态是「病虫害」，先处理病虫',
  budding: '状态是「有花芽」',
  blooming: '状态是「开花」',
  dormant: '状态是「休眠」'
}

export function deriveCarePhase(input: PhaseInput): PhaseDerivation {
  const status = input.status ?? null

  // 已枯死 / 已送人：不再谈物候
  if (status === 'dead') return { phase: null, source: 'unknown', reason: '植株已枯死' }
  if (status === 'gifted') return { phase: null, source: 'unknown', reason: '植株已送人' }

  // 1) 手动状态里带"事件"性质的，直接决定阶段
  if (status && STATUS_PHASE[status]) {
    return { phase: STATUS_PHASE[status]!, source: 'status', reason: STATUS_REASON[status] ?? '按植株状态' }
  }

  // 2) 按物种的花期 / 休眠月份推算
  const month = Number(input.today.slice(5, 7))
  const bloom = input.bloomMonths ?? []
  const dormancy = input.dormancyMonths ?? []

  if (bloom.includes(month)) {
    return { phase: 'blooming', source: 'bloom', reason: `${month} 月在开花期内` }
  }
  const nextMonth = month === 12 ? 1 : month + 1
  if (bloom.includes(nextMonth) && !dormancy.includes(month)) {
    return { phase: 'budding', source: 'bloom', reason: `下个月（${nextMonth} 月）进入开花期` }
  }
  if (dormancy.includes(month)) {
    return { phase: 'dormant', source: 'dormancy', reason: `${month} 月在休眠期内` }
  }

  // 3) 什么都没填也还是生长期 —— 阶段总要有一个
  const hasCalendar = bloom.length > 0 || dormancy.length > 0
  return {
    phase: 'growing',
    source: hasCalendar ? 'default' : 'default',
    reason: hasCalendar ? '不在花期，也不在休眠期' : '物种没填花期 / 休眠期，按生长期算'
  }
}
