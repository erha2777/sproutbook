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

/** 认到了哪一层。品种级最难，认不到就该老实停在种。 */
export type IdentifyLevel = 'genus' | 'species' | 'cultivar'

export interface IdentifyCandidate {
  /** 中文俗名，最常用的那个 */
  name: string
  /** 学名。模型不确定时为空 */
  scientificName: string | null
  /**
   * 园艺品种名，例如「阿弗雷」或 'Alfresco'。
   *
   * 单独一个字段，因为它和「是什么植物」是两回事：
   * 认出是朱顶红不难，认出是哪个品种很难 ——
   * 上千个园艺品种在照片上常常看不出差别，人也不行。
   */
  cultivar: string | null
  /** 认到了哪一层。界面要说出来，别让用户以为认到品种了 */
  level: IdentifyLevel | null
  /** 0~1。模型给百分数时会换算 */
  confidence: number
  /** 一句话依据，让用户判断模型是不是在瞎猜 */
  reason: string
}

export interface IdentifyResult {
  ok: boolean
  /**
   * 模型的原话。
   *
   * 认不出和没按格式返回，从解析结果上分不出来 —— 所以把原文交给用户，
   * 让他自己看一眼，而不是替他编一个原因（「多半是照片看不清」就是这么来的）。
   */
  raw: string | null
  candidates: IdentifyCandidate[]
  error: string | null
  /** 实际用的模型，出问题时能看出来是不是用错了模型 */
  model: string | null
}

const SYSTEM_PROMPT = `你是植物识别助手。用户会给你一张植物照片，你要判断它最可能是什么。

只输出一个 JSON 对象，不要任何解释文字，格式：
{"candidates":[{"name":"中文名","scientificName":"学名或空字符串","cultivar":"园艺品种名或空字符串","level":"genus|species|cultivar","confidence":0.85,"reason":"一句话依据"}]}

关于 level —— 要如实说认到了哪一层：
- cultivar：能确定是哪个园艺品种（例如「阿弗雷」/'Alfresco'）
- species：只知道是什么种（例如「朱顶红」Hippeastrum）
- genus：只到属

**园艺品种是最难的一层**：同一个属里常有成百上千个品种，照片上往往看不出差别。
认不出品种就老实填 species，把 cultivar 留空 —— **不要编一个听起来像的品种名**。
用户宁可看到「朱顶红（到种）」，也不要看到一个错的「阿弗雷」。

规则：
- **尽量给 3 个候选**，按可能性从高到低。第 3 个可以是可能性较低的备选 ——
  万一正确答案在第三条，总比只给两条强。
- confidence 是 0 到 1 之间的小数，不是百分数。备选那条**要如实写低**
  （例如 0.25），不要为了让它好看而抬高。
- reason 要写你凭什么这么判断（叶形、叶序、花色、花型、株型等），一句话即可；
  是备选就说清它为什么不如前两个。
- **实在凑不出第三条就别凑**：只有一个候选也行，甚至给空数组也行 ——
  编一条出来比少给一条更糟，宁可只给两条。
- 不要输出养护建议、毒性等额外字段，这一步只认品种。`

/** 把一张图（data URL）和可选提示拼成消息。抽出来是为了能脱机自检。 */
export function buildIdentifyMessages(
  imageDataUrl: string,
  hint?: string | null,
  /**
   * 用户库里已有的物种名。
   *
   * 这是**把开放问题变成选择题**：他可能正在识别一株自己已经录过的植物，
   * 或者同类的另一个品种。把候选范围先收窄，比让模型从全世界的植物里挑准得多。
   * 但它只是线索不是答案 —— 提示词里写明了「不在里面就自己判断」。
   */
  knownNames?: string[]
): ChatMessage[] {
  const lines: string[] = []
  lines.push(hint?.trim() ? `请识别这张植物照片。用户补充：${hint.trim()}` : '请识别这张植物照片。')

  const known = (knownNames ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 50)
  if (known.length > 0) {
    lines.push('')
    lines.push(`用户已经录过这些植物，供参考：${known.join('、')}`)
    lines.push('如果这张照片属于其中某一种，**优先用那个名字**，并把 level 填成对应的层级；')
    lines.push('如果明显不是其中任何一种，就按你自己的判断回答，不要硬套。')
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: lines.join('\n') },
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
    const cultivar = String(o.cultivar ?? o.cultivarName ?? o.variety ?? '').trim()
    const levelRaw = String(o.level ?? '').trim().toLowerCase()
    const level: IdentifyLevel | null =
      levelRaw === 'genus' || levelRaw === 'species' || levelRaw === 'cultivar'
        ? levelRaw
        : // 模型没给 level 时按「有没有品种名」推断，比丢掉强
          cultivar !== ''
          ? 'cultivar'
          : null

    out.push({
      name,
      scientificName: sci === '' ? null : sci,
      cultivar: cultivar === '' ? null : cultivar,
      level,
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
  /** 用户库里已有的物种名，作为线索传给模型 */
  knownNames?: string[]
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
    messages: buildIdentifyMessages(params.imageDataUrl, params.hint, params.knownNames),
    // 识别要的是稳定答案，不是创造力
    temperature: params.temperature ?? 0.1,
    // 图片比纯文本慢，超时给宽一点
    timeoutMs: params.timeoutMs ?? 60000,
    maxRetries: params.maxRetries,
    jsonMode: true,
    signal: params.signal
  })

  if (!outcome.ok) {
    return { ok: false, candidates: [], error: outcome.error ?? '调用失败', raw: outcome.content ?? null, model: params.model }
  }

  const candidates = parseIdentifyResponse(outcome.content ?? '')
  if (candidates.length === 0) {
    /*
     * 调用成功但没解析出候选。两种情况：
     *   ① 模型真的认不出（给了空数组或说了句人话）
     *   ② 模型没按格式返回
     *
     * **从解析结果上分不出是哪一种**，所以别替它下结论 ——
     * 原话一起带回去。界面上原本写死了「多半是这张照片看不清特征，
     * 换个角度再拍」，那是在替服务端编原因：用户会去反复重拍，
     * 而问题可能根本不在照片上。
     */
    return {
      ok: true,
      candidates: [],
      error: null,
      raw: outcome.content ?? '',
      model: params.model
    }
  }
  return { ok: true, candidates, error: null, raw: outcome.content ?? null, model: params.model }
}
