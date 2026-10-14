/**
 * 配方的纯逻辑：摘要文本、按份数换算、校验。
 *
 * 不放渲染层是因为主进程也要用：将来「按配方算用量」「养护计划里引用配方」
 * 都要拿到同一个换算结果，两处各写一份必然对不上。
 */

import type { MaterialKind, Recipe, RecipeItem } from './types'

export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = {
  substrate: '基质',
  fertilizer: '肥料',
  pesticide: '药剂',
  tool: '工具',
  other: '其他'
}

export const MATERIAL_KIND_OPTIONS = (Object.keys(MATERIAL_KIND_LABELS) as MaterialKind[]).map((value) => ({
  value,
  label: MATERIAL_KIND_LABELS[value]
}))

/** 配方类型的常用值。存的是自由文本，所以用户想写「扦插基质」也完全可以。 */
export const RECIPE_KIND_SUGGESTIONS = ['配土', '肥料', '药剂', '扦插基质', '其他']

/** 条目在界面上的名字：优先材料库，其次临时名。 */
export function itemName(item: RecipeItem, materialNames?: Map<number, string>): string {
  if (item.materialId !== null) {
    const fromLib = materialNames?.get(item.materialId)
    if (fromLib) return fromLib
  }
  return item.name?.trim() || '（未命名材料）'
}

/** 保留三位小数并去掉多余的 0：1.5 → "1.5"，2 → "2"。 */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

/**
 * 一行摘要，例如「泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2」。
 * 没有比例条目时退回列出材料名（「泥炭、珍珠岩」），至少能看出用了什么。
 */
export function summarizeRecipe(items: RecipeItem[], materialNames?: Map<number, string>): string {
  const names = items.map((i) => itemName(i, materialNames))
  const withRatio = items.filter((i) => i.ratioPart !== null)

  if (withRatio.length === items.length && items.length > 0) {
    const parts = withRatio.map((i) => num(i.ratioPart as number))
    return `${names.join(' : ')} = ${parts.join(' : ')}`
  }
  if (items.length === 0) return '（还没有材料）'
  return names.join('、')
}

export interface ScaledItem {
  name: string
  /** 已按份数缩放后的数量显示文本 */
  text: string
  note: string | null
}

/**
 * 按份数换算用量。
 *
 * 「1 份」= 配方本身。配 N 份就是把每条目都乘以 N ——
 * 比例条目和绝对用量条目都如此：前者得到「泥炭 15 份」，
 * 后者得到「缓释肥 60 克」。这样「配 10 盆要多少材料」就是一个乘法。
 *
 * 条目同时写了比例和用量时以**绝对用量**为准显示（用户既然写了克数，
 * 说明他关心的是实际称量，而不是份数比例），比例仍会出现在摘要里。
 */
export function scaleRecipe(items: RecipeItem[], portions: number, materialNames?: Map<number, string>): ScaledItem[] {
  const factor = Number.isFinite(portions) && portions > 0 ? portions : 1
  return items.map((item) => {
    const name = itemName(item, materialNames)
    if (item.amount !== null) {
      const unit = item.unit?.trim()
      return { name, text: `${num(item.amount * factor)}${unit ? ` ${unit}` : ''}`, note: item.note }
    }
    if (item.ratioPart !== null) {
      const unit = item.unit?.trim() || '份'
      return { name, text: `${num(item.ratioPart * factor)} ${unit}`, note: item.note }
    }
    return { name, text: '—', note: item.note }
  })
}

/**
 * 校验配方。
 *
 * 只拦「明显没意义」的情况，不做过度限制 —— 配方是给人看的记录，
 * 不是要交给机器的配方单。比如允许材料全用临时名（手边只有一包不知名的土）。
 */
export function validateRecipe(input: {
  name: string
  items: Array<Pick<RecipeItem, 'materialId' | 'name' | 'ratioPart' | 'amount'>>
}): Record<string, string> {
  const errors: Record<string, string> = {}

  if (!input.name.trim()) errors.name = '配方名称不能为空'

  input.items.forEach((item, index) => {
    const key = String(index)
    const hasMaterial = item.materialId !== null || Boolean(item.name?.trim())
    if (!hasMaterial) {
      errors[key] = '请选择材料，或填一个名称'
      return
    }
    const hasQuantity = item.ratioPart !== null || item.amount !== null
    if (!hasQuantity) {
      errors[key] = '请填比例份数或用量'
      return
    }
    if (item.ratioPart !== null && !(item.ratioPart > 0)) errors[key] = '比例份数要大于 0'
    if (item.amount !== null && !(item.amount > 0)) errors[key] = '用量要大于 0'
  })

  return errors
}

/** 配方用到的材料 id 集合（用于「这个材料被哪些配方用了」）。 */
export function materialIdsIn(recipe: Pick<Recipe, 'items'>): number[] {
  const out = new Set<number>()
  for (const item of recipe.items) {
    if (item.materialId !== null) out.add(item.materialId)
  }
  return [...out]
}
