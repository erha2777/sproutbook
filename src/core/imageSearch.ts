/**
 * 必应图片结果的**纯解析/打分**逻辑。
 *
 * 单独放在 core 里（不 import electron）是为了能脱离应用直接测：
 * 抓一份真实 HTML，喂给这里的函数，就能验证「解析对不对、相关性判断准不准」。
 */

/** 一条从 HTML 里解析出来的候选 */
export interface BingImageHit {
  url: string
  turl: string | null
  title: string | null
  purl: string | null
}

/** 去掉引号 / 全角引号、折叠空白 —— 物种名里常带着 `"粉白桃之辉"` 这种引号 */
export function normalizeQuery(raw: string): string {
  return raw
    .replace(/[“”„‟"'‘’「」『』]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 查询词拆成用于打分的 token：
 * 先按空格拆；中文再补上 2 字片段（「酢酱草」→「酢酱」「酱草」），
 * 这样「粉白桃之辉酢浆草」这种标题也能命中。
 */
export function queryTokens(q: string): string[] {
  const tokens = new Set<string>()
  for (const word of q.split(/\s+/)) {
    const w = word.trim().toLowerCase()
    if (w.length < 2) continue
    tokens.add(w)
    if (/[\u4e00-\u9fa5]/.test(w) && w.length >= 3) {
      for (let i = 0; i + 2 <= w.length; i++) tokens.add(w.slice(i, i + 2))
    }
  }
  return [...tokens]
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 解析必应图片页里的 `m="{...}"` 元数据块。
 *
 * 比按 `murl&quot;:&quot;(.*?)&quot;` 逐字段抓更稳：那条正则会把
 * 「相关搜索 / 热门图片」模块里的图也一起卷进来，而且字段错位后标题和原图对不上。
 */
export function parseBingResults(html: string): BingImageHit[] {
  const seen = new Set<string>()
  const out: BingImageHit[] = []
  for (const match of html.matchAll(/m="(\{.*?\})"/gs)) {
    let meta: { murl?: string; turl?: string; t?: string; purl?: string }
    try {
      meta = JSON.parse(decodeHtml(match[1])) as typeof meta
    } catch {
      continue
    }
    const url = meta.murl ?? ''
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ url, turl: meta.turl ?? null, title: meta.t ?? null, purl: meta.purl ?? null })
  }
  return out
}

/** 标题 / 来源页 / 图片地址里命中了几个 token（0 = 判断为不相关） */
export function scoreHit(hit: BingImageHit, tokens: string[]): number {
  const haystack = `${hit.title ?? ''} ${hit.purl ?? ''} ${hit.url}`.toLowerCase()
  return tokens.filter((t) => haystack.includes(t)).length
}

/**
 * 给整批结果打分并按相关度排序；调用方只保留 score > 0 的。
 * 全部命中同一批 token 时保持必应原本的顺序（稳定排序）。
 */
export function rankHits(hits: BingImageHit[], tokens: string[]): Array<BingImageHit & { score: number }> {
  return hits
    .map((hit) => ({ ...hit, score: scoreHit(hit, tokens) }))
    .sort((a, b) => b.score - a.score)
}
