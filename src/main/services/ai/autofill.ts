/**
 * AI 自动补全 —— 产出「草稿」，绝不直接落库。
 *
 * 三条铁律：
 *  1. AI 结果只是草稿，必须经用户逐字段勾选确认后才写入。
 *  2. 安全字段（毒性等）永远标记 needsReview，UI 必须显著提示。
 *  3. 没配 API Key 时应用功能完整可用 —— AI 只是增强，不是依赖。
 */

import type { Db } from '../../db/connection'
import type { AiAutofillResult, AiFieldDraft, FieldDefinition, FieldValue } from '../../../core/types'
import { coerceFieldValue, formatFieldValue } from '../../../core/fieldTypes'
import { chat, recordAiRun } from './client'
import type { ChatMessage } from './client'

export const PROMPT_VERSION = 'autofill-v1'

export interface AutofillParams {
  db: Db
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  timeoutMs: number
  maxRetries: number
  /** 用户输入的植物名称（中文名 / 学名 / 俗名都可） */
  plantName: string
  /** 可选的补充线索，能显著提高准确率 */
  hints?: string
  fields: FieldDefinition[]
  /** 该物种已有的值，用于提示 AI 不要覆盖已确认信息 */
  existing?: Record<string, FieldValue>
  signal?: AbortSignal
}

const SYSTEM_PROMPT = `你是一位严谨的园艺学与植物分类学资料助手，为中国家庭园艺爱好者整理植物档案。

你必须遵守：
1. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。
2. 每个字段的值形如 {"value": <值>, "confidence": <0~1 的数字>}。
3. **不确定就省略该字段**，绝不允许编造。宁缺毋滥。
4. 毒性、有毒部位、中毒症状这类安全信息必须格外保守：只有确凿时才给高置信度；有疑问时给低置信度（≤0.5）。
5. 无法确认的植物（名称含糊、可能是多种植物的俗称）请在 "_note" 字段里用一句话说明歧义。

字段说明会告诉你每个字段的类型和取值范围。`

function buildFieldSpec(fields: FieldDefinition[]): string {
  const lines: string[] = []
  for (const f of fields) {
    if (f.archivedAt) continue
    if (f.columnName === 'aliases_json') continue
    const parts = [`- ${f.key}（${f.label}）: 类型 ${f.type}`]
    if (f.unit) parts.push(`单位 ${f.unit}`)
    if (f.options && f.options.length) parts.push(`可选值 [${f.options.join(' / ')}]`)
    if (f.type === 'month_range') parts.push('值形如 {"from":3,"to":5}，跨年如 {"from":11,"to":2}')
    if (f.type === 'hours_range') parts.push('值形如 {"min":6,"max":8}')
    if (f.type === 'tags' || f.type === 'multiselect') parts.push('值是字符串数组')
    if (f.type === 'bool') parts.push('值是 true 或 false')
    if (f.type === 'number') parts.push('值是数字，不要带单位')
    if (f.isSafety) parts.push('【安全字段】')
    lines.push(parts.join('，'))
  }
  return lines.join('\n')
}

export async function autofillSpecies(params: AutofillParams): Promise<AiAutofillResult> {
  const name = params.plantName.trim()
  if (!name) {
    return { ok: false, message: '请先填写植物名称', speciesName: '', drafts: [], model: null, raw: null }
  }

  const fields = params.fields.filter((f) => !f.archivedAt && f.columnName !== 'aliases_json')
  const userParts = [`植物名称：${name}`]
  if (params.hints && params.hints.trim()) userParts.push(`补充线索：${params.hints.trim()}`)
  if (params.existing) {
    const known = Object.entries(params.existing)
      .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => {
        const def = fields.find((f) => f.key === k)
        return def ? `${def.label}=${formatFieldValue(def, v)}` : null
      })
      .filter(Boolean)
    if (known.length) userParts.push(`已知信息（可修正，但请优先保留正确的部分）：${known.join('；')}`)
  }
  userParts.push('', '请按下列字段定义输出 JSON：', buildFieldSpec(fields))

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') }
  ]

  const outcome = await chat({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    messages,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
    maxRetries: params.maxRetries,
    jsonMode: true,
    signal: params.signal
  })

  recordAiRun(params.db, {
    kind: 'fill_fields',
    baseUrl: params.baseUrl,
    model: params.model,
    promptVersion: PROMPT_VERSION,
    input: { name, hints: params.hints ?? null, fieldKeys: fields.map((f) => f.key) },
    output: outcome.ok ? outcome.content : null,
    status: params.signal?.aborted ? 'cancelled' : outcome.ok ? 'ok' : 'error',
    error: outcome.error ?? null,
    usage: outcome.usage,
    durationMs: outcome.durationMs
  })

  if (!outcome.ok) {
    return { ok: false, message: outcome.error ?? '调用失败', speciesName: name, drafts: [], model: null, raw: null }
  }

  const parsed = extractJsonObject(outcome.content)
  if (!parsed) {
    return {
      ok: false,
      message: '模型没有返回可解析的 JSON。可以换一个模型，或在设置中关闭「强制 JSON 模式」后重试。',
      speciesName: name,
      drafts: [],
      model: outcome.model,
      raw: outcome.content.slice(0, 2000)
    }
  }

  const payload = (parsed.values && typeof parsed.values === 'object' ? parsed.values : parsed) as Record<string, unknown>
  const drafts: AiFieldDraft[] = []

  for (const def of fields) {
    const entry = payload[def.key]
    if (entry === undefined || entry === null) continue

    // 同时兼容 {"value":..,"confidence":..} 与直接给值两种写法
    const rawValue =
      typeof entry === 'object' && entry !== null && 'value' in (entry as Record<string, unknown>)
        ? (entry as Record<string, unknown>).value
        : entry
    const confidence =
      typeof entry === 'object' && entry !== null && 'confidence' in (entry as Record<string, unknown>)
        ? Number((entry as Record<string, unknown>).confidence)
        : 0.6

    const coerced = coerceFieldValue(def, rawValue)
    // 校验失败的字段直接丢弃：宁可少给，不可给错
    if (!coerced.ok || coerced.value === null) continue

    const current = params.existing?.[def.key] ?? null
    drafts.push({
      fieldKey: def.key,
      label: def.label,
      value: coerced.value,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6,
      needsReview: def.isSafety,
      willOverwrite: current !== null && current !== undefined && !(Array.isArray(current) && current.length === 0),
      currentValue: current
    })
  }

  const note = typeof parsed._note === 'string' ? parsed._note : null

  return {
    ok: drafts.length > 0,
    message:
      drafts.length > 0
        ? note
          ? `已生成 ${drafts.length} 个字段草稿。模型提示：${note}`
          : `已生成 ${drafts.length} 个字段草稿，请逐项确认后再保存。`
        : note
          ? `模型没有给出可用字段。模型提示：${note}`
          : '模型没有给出任何可用字段。可以补充产地、株型等线索后重试。',
    speciesName: name,
    drafts,
    model: outcome.model,
    raw: null
  }
}

/** 从模型输出里抠出 JSON 对象，兼容 Markdown 代码块与前后多余文字。 */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  if (!content) return null
  const cleaned = content
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  const direct = tryParse(cleaned)
  if (direct) return direct

  // 退化路径：截取第一个 { 到最后一个 } 之间的内容
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const sliced = tryParse(cleaned.slice(start, end + 1))
    if (sliced) return sliced
  }
  return null
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}
