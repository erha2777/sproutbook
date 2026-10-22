/**
 * 植株状态的显示名与图标。
 *
 * 放在 core 而不是渲染层，是因为主进程也需要它：
 * 导入导出要把 `growing` 写成给人看的「生长中」，再按名字查回去；
 * 日志与错误信息里也常要显示中文状态。
 * 这类「领域词汇」只有一个来源，才不会出现两边翻译不一致。
 */

import type { PlantStatus } from './types'

/*
 * 顺序就是下拉里的顺序：从"还没发芽"到"送人"，按生命周期排。
 * 状态是**手动**的观察结果；物候阶段另有自动推算（core/phase.ts）。
 */
export const PLANT_STATUS_LABELS: Record<PlantStatus, string> = {
  seed: '种子 / 种球（未发芽）',
  growing: '发芽 / 生长',
  budding: '有花芽',
  blooming: '开花',
  recovering: '缓苗',
  sick: '病虫害',
  dormant: '休眠',
  dead: '已枯死',
  gifted: '已送人'
}

export const PLANT_STATUS_ICONS: Record<PlantStatus, string> = {
  seed: '🌰',
  growing: '🌿',
  budding: '🔍',
  blooming: '🌸',
  recovering: '🩹',
  sick: '🐛',
  dormant: '😴',
  dead: '🥀',
  gifted: '🎁'
}

/**
 * 显示名 → 存储键（导入时用）。
 * 宽松匹配：忽略空白与大小写，也接受存储键本身，这样用户手改过的表格也能导进来。
 */
export const PLANT_STATUS_KEYS: Record<string, PlantStatus> = (() => {
  const map: Record<string, PlantStatus> = {}
  for (const key of Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]) {
    map[key.toLowerCase()] = key
    map[PLANT_STATUS_LABELS[key]] = key
    map[`${PLANT_STATUS_ICONS[key]} ${PLANT_STATUS_LABELS[key]}`] = key
  }
  return map
})()

/**
 * 状态的展示顺序：从"还没发芽"到"送人"。
 *
 * 数据库里的 `field_definitions.options_json` 存的就是这个数组 ——
 * **加新状态必须同时改这里和那条字段定义**，否则下拉里看不到
 * （迁移 v21 会把老库的 5 项换成这一份）。
 */
export const PLANT_STATUS_ORDER: PlantStatus[] = [
  'seed',
  'growing',
  'budding',
  'blooming',
  'recovering',
  'sick',
  'dormant',
  'dead',
  'gifted'
]
/** 供下拉框使用：带图标的选项。 */
export const PLANT_STATUS_OPTIONS: Array<{ value: PlantStatus; label: string }> = (
  Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]
).map((value) => ({ value, label: `${PLANT_STATUS_ICONS[value]} ${PLANT_STATUS_LABELS[value]}` }))
