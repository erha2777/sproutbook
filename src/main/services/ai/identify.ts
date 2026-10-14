/**
 * 识图生成 —— 拍/选一张照片，让模型给出候选植物。
 *
 * ## 这一层只负责「认出是什么」，不负责写数据
 *
 * 识别结果交给现有的「草稿 → 逐字段勾选 → 写入」流程，
 * 那条路的规矩已经立住了：**永不自动写、安全字段强制人工核实**。
 * 这里再造一条写入路径只会让规矩多一个可能被绕过的口子。
 *
 * ## 为什么要允许「认不出」
 *
 * 植物识别本身就不可靠，尤其是只有一张照片、没有花果的时候。
 * 提示词里明确要求「不确定就少给候选、降低置信度」，
 * 而不是硬凑三个 —— 凑出来的候选会让用户以为有得选，反而误导。
 */

import { extractJsonObject } from './autofill'
import { chat } from './client'
import type { ChatMessage } from './client'

export interface IdentifyCandidate {
  /** 中文俗名，最常用的那个 */
  name: string
  /** 学名。模型不确定时为空 */
  scientificName: string | null
  /** 0~1。模型给百分数时会换算 */
  confidence: number
  /** 一句话依据，让用户判断模型是不是在瞎猜 */
  reason: string
}

export interface IdentifyResult {
  ok: boolean
  candidates: IdentifyCandidate[]
  error: string | null
  /** 实际用的模型，出问题时能看出来是不是用错了模型 */
  model: string | null
}

const SYSTEM_PROMPT = `你是植物识别助手。用户会给你一张植物照片，你要判断它最可能是什么。

只输出一个 JSON 对象，不要任何解释文字，格式：
{"candidates":[{"name":"中文俗名","scientificName":"学名或空字符串","confidence":0.85,"reason":"一句话依据"}]}

规则：
- 最多 3 个候选，按可能性从高到低。
- confidence 是 0 到 1 之间的小数，不是百分数。
- reason 要写你凭什么这么判断（叶形、叶序、花色、株型等），一句话即可。
- **看不清或没有把握时，少给候选并降低 confidence**，不要为了凑数编造。
  只有一个候选也行，甚至给空数组也行 —— 猜错比说不知道更糟。
- 不要输出养护建议、毒性等额外字段，这一步只认品种。`

/** 把一张图（data URL）和可选提示拼成消息。抽出来是为了能脱机自检。 */
export function buildIdentifyMessages(imageDataUrl: string, hint?: string | null): ChatMessage[] {
  const text = hint?.trim()
    ? `请识别这张植物照片。用户补充：${hint.trim()}`
    : '请识别这张植物照片。'
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    }
  ]
}

/**
 * 从回答里抠出 JSON —— **对象和数组都要认**。
 *
 * 复用的 extractJsonObject 只找 `{...}`，所以模型直接返回
 * `[{...}]` 时会解析不出来（下面那段 Array.isArray 的分支永远走不到）。
 * 这是自检里「直接返回数组也认」那条抓出来的。
 *
 * 顺序：先直接 parse（最常见，jsonMode 下就是纯 JSON），
 * 再退回到「从文字里找一段」。
 */
function extractAnyJson(content: string): unknown {
  const trimmed = content.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // 落到下面的抽取
    }
  }

  const asObject = extractJsonObject(content)
  if (asObject) return asObject

  // 数组：找第一段方括号，按括号配对切出来
  const start = content.indexOf('[')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 解析模型的回答。
 *
 * 刻意写得宽容：模型不按格式返回是常态（包一层 markdown、多给字段、
 * confidence 写成百分数、直接给个数组）。**这里只做归一，不因为格式
 * 不完美就把结果丢掉** —— 用户等着的是候选，不是格式错误。
 */
export function parseIdentifyResponse(content: string): IdentifyCandidate[] {
  const parsed = extractAnyJson(content)
  if (!parsed) return []

  const asRecord = (parsed ?? {}) as Record<string, unknown>
  const raw = Array.isArray(parsed) ? parsed : (asRecord.candidates ?? asRecord.results ?? asRecord.plants)
  if (!Array.isArray(raw)) return []

  const out: IdentifyCandidate[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = String(o.name ?? o.commonName ?? o.common_name ?? '').trim()
    if (!name) continue

    // confidence 可能是 0~1、百分数、字符串，甚至没有
    let conf = Number(o.confidence ?? o.score ?? o.probability ?? NaN)
    if (!Number.isFinite(conf)) conf = 0.5
    if (conf > 1) conf = conf / 100
    conf = Math.min(1, Math.max(0, conf))

    const sci = String(o.scientificName ?? o.scientific_name ?? '').trim()
    out.push({
      name,
      scientificName: sci === '' ? null : sci,
      confidence: Math.round(conf * 100) / 100,
      reason: String(o.reason ?? o.why ?? o.basis ?? '').trim()
    })
  }

  // 高的在前，最多三个
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 3)
}

export interface IdentifyParams {
  baseUrl: string
  apiKey: string
  /** 视觉模型。为空时由调用方回落到对话模型 */
  model: string
  imageDataUrl: string
  hint?: string | null
  temperature?: number
  timeoutMs?: number
  maxRetries?: number
  signal?: AbortSignal
}

export async function identifyPlant(params: IdentifyParams): Promise<IdentifyResult> {
  const outcome = await chat({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    messages: buildIdentifyMessages(params.imageDataUrl, params.hint),
    // 识别要的是稳定答案，不是创造力
    temperature: params.temperature ?? 0.1,
    // 图片比纯文本慢，超时给宽一点
    timeoutMs: params.timeoutMs ?? 60000,
    maxRetries: params.maxRetries,
    jsonMode: true,
    signal: params.signal
  })

  if (!outcome.ok) {
    return { ok: false, candidates: [], error: outcome.error ?? '调用失败', model: params.model }
  }

  const candidates = parseIdentifyResponse(outcome.content ?? '')
  if (candidates.length === 0) {
    /*
     * 调用成功但没解析出候选：可能是模型说「认不出」，
     * 也可能是没按格式返回。两种都如实告诉用户，不假装识别成功。
     */
    return {
      ok: true,
      candidates: [],
      error: null,
      model: params.model
    }
  }
  return { ok: true, candidates, error: null, model: params.model }
}
