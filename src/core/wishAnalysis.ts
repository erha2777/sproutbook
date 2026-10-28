/**
 * 种草清单的「AI 适配分析」：提示词 + 结果解析。
 *
 * 纯逻辑放这里（可被自检覆盖），网络请求在 IPC 层。
 *
 * 设计要点：
 *  - **分品类**：月季有专门的抗病/耐性维度（用户种得多、维护难），其它三类走通用维度
 *  - **评分要拉开**：提示词里给了明确的档位与"不允许大量同分"的约束，
 *    解析时再做一次兜底（缺维度补位、越界钳制），保证界面拿到的是一份完整结果
 *  - 结果以 JSON 存回种草记录，下次打开直接看，不重复花钱
 */

import type { WishAnalysis, WishCategory } from './types'

export const WISH_CATEGORY_LABELS: Record<WishCategory, string> = {
  rose: '月季',
  hydrangea: '绣球',
  bougainvillea: '三角梅',
  other: '其他'
}

export const WISH_CATEGORY_ORDER: WishCategory[] = ['rose', 'hydrangea', 'bougainvillea', 'other']

export interface DimSpec {
  key: string
  label: string
  /** 这一维度在提示词里的评分要点 */
  hint: string
}

/** 月季专属：抗病 + 耐性 + 株型（用户明确要求的那几项） */
export const ROSE_DIMS: DimSpec[] = [
  { key: 'black_spot', label: '抗黑斑病', hint: '雨季黑斑是最主要的落叶原因，看是否高抗/免疫' },
  { key: 'powdery', label: '抗白粉病', hint: '干湿交替、通风差时高发，看品种抗性记录' },
  { key: 'downy', label: '抗霜霉病', hint: '低温高湿、连续阴雨时高发，看抗性与易感程度' },
  { key: 'rain', label: '耐雨淋', hint: '连续降雨下花苞是否烂、花瓣是否打不开、黑斑是否爆发' },
  { key: 'sun', label: '耐晒', hint: '盛夏烈日下花瓣是否焦边、褪色、花期是否明显缩短' },
  { key: 'shade', label: '耐阴', hint: '半日照/散射光下能否正常生长与开花' },
  { key: 'vigor', label: '长势', hint: '发枝量与成株速度；弱苗难养，过旺也难控' },
  { key: 'rebloom', label: '复花性', hint: '一年开几轮、两轮之间隔多久、是否四季开花' },
  { key: 'upright', label: '直立性', hint: '枝条是否挺立、花头是否垂头、是否适合盆栽/小空间' }
]

/** 其它品类：通用维度（不做品类特殊处理） */
export const COMMON_DIMS: DimSpec[] = [
  { key: 'light', label: '光照匹配', hint: '需求光照与所选位置的直射时长是否吻合' },
  { key: 'climate', label: '气候适应', hint: '耐寒/耐热与该地气候（含湿度、冬季低温）是否匹配' },
  { key: 'maintenance', label: '养护省心度', hint: '日常浇水施肥修剪的工作量；分越高越省心' },
  { key: 'vigor', label: '长势', hint: '成株速度与长势强弱' },
  { key: 'pest', label: '抗病虫', hint: '常见病虫害的抗性' },
  { key: 'ornamental', label: '观赏价值', hint: '花型、花色、花期长度、四季表现' }
]

export function dimsFor(category: WishCategory): DimSpec[] {
  return category === 'rose' ? ROSE_DIMS : COMMON_DIMS
}

export interface WishAnalysisContext {
  name: string
  note: string | null
  shop: string | null
  price: number | null
  category: WishCategory
  location: {
    name: string
    lightLevel: string | null
    lightHours: number | null
    province: string | null
    city: string | null
    district: string | null
    frostProtected: boolean
    canHeat: boolean
    notes: string | null
  } | null
}

const LIGHT_LABELS: Record<string, string> = {
  full_sun: '全日照',
  part_shade: '半阴',
  shade: '荫蔽',
  bright_indirect: '明亮散射光'
}

export function describeLocation(ctx: WishAnalysisContext['location']): string {
  if (!ctx) return '（未选择养护位置）'
  const parts = [
    `名称：${ctx.name}`,
    `光照：${ctx.lightLevel ? (LIGHT_LABELS[ctx.lightLevel] ?? ctx.lightLevel) : '未填'}`,
    ctx.lightHours !== null ? `每日直射约 ${ctx.lightHours} 小时` : '',
    [ctx.province, ctx.city, ctx.district].filter(Boolean).join(' / ') || '',
    ctx.frostProtected ? '冬季有防冻条件' : '',
    ctx.canHeat ? '可加温' : '',
    ctx.notes ? `备注：${ctx.notes}` : ''
  ]
  return parts.filter(Boolean).join('；')
}

export const WISH_ANALYSIS_SYSTEM_PROMPT = [
  '你是一位严格的园艺评估师，帮用户判断"这个品种值不值得在指定位置种"。',
  '',
  '输出要求：**只输出一个 JSON 对象**，不要 Markdown、不要解释、不要代码块围栏。结构：',
  '{',
  '  "score": 1-100 的整数（总评），',
  '  "verdict": "一句话结论（≤40 字）",',
  '  "pros": ["优点，3~5 条，每条 ≤30 字"],',
  '  "cons": ["缺点/风险，2~4 条，每条 ≤30 字"],',
  '  "dims": [{"key": "维度 key", "score": 1-100 的整数, "comment": "≤20 字依据"}],',
  '  "tips": ["针对这个位置的具体建议，2~4 条"]',
  '}',
  '',
  '评分纪律（**必须遵守**）：',
  '1. 先按档位定性，再在档内微调：90=极好、75=良好、60=一般、45=偏差、30=不推荐；档内 ±7 分。',
  '2. **禁止大量同分**：同一份结果里，各维度分数不得出现 3 个以上相同整数；',
  '   相邻维度的分数尽量错开 2 分以上。总分不要用维度平均分，按对该位置的重要性加权后再给。',
  '3. 分数要有区分度：优点明显 ≠ 满分；没有证据的维度给 55~65 并在 comment 里写明"资料不足"。',
  '4. 不要因为"它是名品"就抬分；抗性差就是差（黑斑/白粉高发的品种该维度必须 ≤45）。',
  '5. 只依据你确知的品种特性与给定位置条件判断，不要编造没把握的数据。'
].join('\n')

export function buildWishAnalysisMessages(
  ctx: WishAnalysisContext
): { system: string; user: string } {
  const dims = dimsFor(ctx.category)
  const dimLines = dims.map((d, i) => `${i + 1}. ${d.key}（${d.label}）：${d.hint}`).join('\n')
  const lines = [
    '【想种的植物】',
    `名称：${ctx.name}`,
    `品类：${WISH_CATEGORY_LABELS[ctx.category]}`,
    ctx.shop ? `店铺：${ctx.shop}` : '',
    ctx.price !== null ? `参考价：${ctx.price} 元` : '',
    ctx.note ? `简介/备注：${ctx.note}` : '',
    '',
    '【打算种在哪里】',
    describeLocation(ctx.location),
    '',
    '【需要打分的维度】',
    dimLines,
    '',
    '请按上面给定的维度**全部**打分（key 用括号里的英文 key），再给总评与优缺点。',
    ctx.category === 'rose'
      ? '这是月季：抗病性与耐性是重点，用户最在意"少打药也能活"。'
      : '这是常见园艺植物：按通用维度评估，不必套用月季的抗病细分。'
  ]
  return {
    system: WISH_ANALYSIS_SYSTEM_PROMPT,
    user: lines.filter((line) => line !== '').join('\n')
  }
}

function clampScore(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(100, Math.round(n)))
}

function asText(value: unknown, max = 60): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asList(value: unknown, max = 6, each = 60): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => asText(v, each))
    .filter((v) => v !== '')
    .slice(0, max)
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏、前后解释文字） */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export interface ParsedWishAnalysis extends Omit<WishAnalysis, 'at' | 'model'> {}

/**
 * 解析模型输出。
 *
 * 容错原则：**能救就救，救不了返回 null**。
 *  - 维度按品类定义补齐：模型漏掉的给 60 分并注明"未给出依据"
 *  - 分数钳到 1~100，非数字用兜底值
 *  - pros / cons 至少各 1 条，否则整体判失败（那就没必要展示）
 */
export function parseWishAnalysis(
  text: string,
  ctx: { category: WishCategory; locationName: string | null; locationSnapshot: string }
): ParsedWishAnalysis | null {
  const json = extractJsonObject(text)
  if (!json) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }

  const dims = dimsFor(ctx.category)
  const rawDims = Array.isArray(raw.dims) ? (raw.dims as Array<Record<string, unknown>>) : []
  const byKey = new Map<string, { score: number; comment: string }>()
  for (const item of rawDims) {
    const key = asText(item?.key, 40)
    if (!key) continue
    byKey.set(key, {
      score: clampScore(item?.score, 60),
      comment: asText(item?.comment, 40) || '未给出依据'
    })
  }

  const pros = asList(raw.pros, 5, 40)
  const cons = asList(raw.cons, 4, 40)
  if (pros.length === 0 || cons.length === 0) return null

  return {
    score: clampScore(raw.score, 60),
    verdict: asText(raw.verdict, 60) || '（模型没有给结论）',
    pros,
    cons,
    dims: dims.map((d) => {
      const hit = byKey.get(d.key)
      return { key: d.key, label: d.label, score: hit?.score ?? 60, comment: hit?.comment ?? '模型未给出这一项' }
    }),
    tips: asList(raw.tips, 4, 80),
    category: ctx.category,
    locationName: ctx.locationName,
    locationSnapshot: ctx.locationSnapshot
  }
}

/** 维度分与总分的展示色（同一套阈值，界面和自检共用） */
export function scoreTone(score: number): 'good' | 'ok' | 'warn' | 'bad' {
  if (score >= 80) return 'good'
  if (score >= 65) return 'ok'
  if (score >= 50) return 'warn'
  return 'bad'
}
