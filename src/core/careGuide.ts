import type { CareActionType } from './types'

/**
 * 全年养护指南：AI 生成 + 解析成养护任务。
 *
 * 指南是给**人看**的长文本，但要能"加入养护计划"，就必须有一个**机器也能读**的形状。
 * 所以格式是硬约定（提示词里反复强调、解析器只认这个形状）：
 *
 *   ## 3月
 *   - 换盆（03-15）：换到 20cm 盆，土用…
 *   - 开始施肥（03-20）
 *
 * 解析不出来（AI 没守格式、用户自己编辑坏了）不算错 —— 返回空列表，
 * 调用方据此退回"按规则库生成"，而不是丢一堆莫名其妙的日期出去。
 */

export interface CareGuideTemplate {
  id: string
  name: string
  /** 追加到提示词里的额外要求 */
  instruction: string
}

export interface CareGuideItem {
  /** 事项，例如「换盆」 */
  title: string
  /** 建议日期 YYYY-MM-DD；只写到月份时取该月 1 号 */
  date: string
  /** 冒号后面的说明（可能为空） */
  note: string
}

export interface CareGuideSection {
  month: number
  items: CareGuideItem[]
}

export interface ParsedCareGuide {
  sections: CareGuideSection[]
  /** 解析出的总条数（给界面提示用） */
  itemCount: number
}

/** 指南的格式约定：写进系统提示词，也直接展示给用户看 */
export const CARE_GUIDE_FORMAT = [
  '## 3月',
  '- 换盆（03-15）：换到 20cm 盆，土用泥炭 5 : 珍珠岩 3',
  '- 开始施肥（03-20）'
].join('\n')

export const CARE_GUIDE_SYSTEM_PROMPT = [
  '你是一位植物养护顾问，为**某一株**植物写一份全年养护指南。',
  '',
  '规则：',
  '1. 只依据用户给的档案（物种、养护位置、这一株的信息）来写；档案里没有的事实不要编造。',
  '2. 输出 Markdown，按月分节，**必须**按下面的格式：',
  '',
  CARE_GUIDE_FORMAT,
  '',
  '   每月 2~4 条，日期写在中文括号里（MM-DD）；能不给日期就只写「## N月」一节的条目不带日期。',
  '3. 每条先写事项（浇水 / 施肥 / 修剪 / 换盆 / 防寒 / 病虫害检查…），冒号后一句说明「怎么做、做到什么程度」。',
  '4. 结合这株的位置（光照、是否室外、所在城市）和当前状态调整，例如室外要写霜冻防护、室内要写通风。',
  '5. 涉及用药、剂量、毒性时保守表述，提示以专业意见为准。',
  '6. 中文；不要写表格；不要寒暄；不要在开头写总结段落 —— 直接从「## 1月」开始。'
].join('\n')

export interface CareGuideMessages {
  system: string
  user: string
}

export function buildCareGuideMessages(dossier: string, templateInstruction: string | null): CareGuideMessages {
  const extra = templateInstruction?.trim()
  return {
    system: CARE_GUIDE_SYSTEM_PROMPT,
    user: [
      `【这株植物的档案】\n${dossier}`,
      extra ? `【本次的额外要求（格式模板）】\n${extra}` : '',
      '【任务】\n按上面的格式写这株植物的全年（1–12 月）养护指南。'
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}

const MONTH_HEADING = /^#{1,4}\s*(\d{1,2})\s*月/
const ITEM_LINE = /^\s*(?:[-*·+]|\d+[.、)])\s*(.+)$/
const DATE_IN_PARENS = /[（(]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[)）]/
const MONTH_ONLY = /[（(]\s*(\d{1,2})\s*月\s*[)）]/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 解析指南文本。
 *
 * 容错点（都是实际会遇到的写法）：
 *  - 标题 `## 3月` / `### 3 月` / `3月`
 *  - 条目 `- xxx` / `* xxx` / `1. xxx`
 *  - 日期 `（03-15）` / `(3/15)` / `（3月15日）` / 没有日期
 *  - 说明用中文或英文冒号分隔
 */
export function parseCareGuide(text: string, year = new Date().getFullYear()): ParsedCareGuide {
  const sections: CareGuideSection[] = []
  let current: CareGuideSection | null = null
  let currentMonth: number | null = null

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const heading = line.match(MONTH_HEADING)
    if (heading) {
      const month = Number(heading[1])
      if (month >= 1 && month <= 12) {
        currentMonth = month
        current = { month, items: [] }
        sections.push(current)
        continue
      }
    }
    // 也接受「3月」这种不带 # 的裸标题
    const bareHeading = line.match(/^(\d{1,2})\s*月\s*$/)
    if (bareHeading) {
      const month = Number(bareHeading[1])
      if (month >= 1 && month <= 12) {
        currentMonth = month
        current = { month, items: [] }
        sections.push(current)
        continue
      }
    }

    const item = line.match(ITEM_LINE)
    if (!item || currentMonth === null) continue
    let body = item[1].trim()
    if (!body) continue

    let day: number | null = null
    const withDate = body.match(DATE_IN_PARENS)
    if (withDate) {
      // （03-15）里的 3 是"月"，和所在小节可能不一致（AI 偶尔写错），以括号里的为准
      const m = Number(withDate[1])
      const d = Number(withDate[2])
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        body = body.replace(withDate[0], '').trim()
        // 日期里带了月份就尊重它；这里直接算成具体日期
        const date = `${year}-${pad2(m)}-${pad2(d)}`
        pushItem(current ?? sections[sections.length - 1], body, date)
        continue
      }
    }
    const monthOnly = body.match(MONTH_ONLY)
    if (monthOnly) {
      const m = Number(monthOnly[1])
      if (m >= 1 && m <= 12) {
        body = body.replace(monthOnly[0], '').trim()
        pushItem(current ?? sections[sections.length - 1], body, `${year}-${pad2(m)}-01`)
        continue
      }
    }
    pushItem(current ?? sections[sections.length - 1], body, `${year}-${pad2(currentMonth)}-${pad2(day ?? 1)}`)
  }

  const cleaned = sections.filter((s) => s.items.length > 0)
  return { sections: cleaned, itemCount: cleaned.reduce((n, s) => n + s.items.length, 0) }
}

/** 把「事项（日期）：说明」拆成标题和说明，塞进当前小节 */
function pushItem(section: CareGuideSection | undefined, body: string, date: string): void {
  if (!section) return
  const [titlePart, ...rest] = body.split(/[:：]/)
  const title = titlePart.trim().replace(/[，,。；;]$/, '')
  if (!title) return
  section.items.push({
    title,
    date,
    note: rest.join('：').trim()
  })
}

/**
 * 按标题猜动作类型：指南里写的是自然语言（「换盆」「打药」「搬进室内」），
 * 而 care_tasks 需要一个 actionType 才能上色/分组。猜错也只是图标不同，不影响执行。
 */
export function guessCareAction(title: string): CareActionType {
  const t = title
  if (/浇|水|浸盆/.test(t)) return 'water'
  if (/肥|追肥|基肥/.test(t)) return 'fertilize'
  if (/剪|修剪|摘心|疏芽|抹芽/.test(t)) return 'prune'
  if (/换盆|翻盆|换土|上盆/.test(t)) return 'repot'
  if (/虫|病|打药|喷药|杀菌|防治/.test(t)) return 'pest'
  if (/寒|冻|遮阴|防晒|降温|保温|搬.*室内|越冬|越夏/.test(t)) return 'protect'
  if (/观察|检查|记录|拍照/.test(t)) return 'observe'
  return 'other'
}

export interface CareGuideTaskDraft {
  title: string
  dueDate: string
  note: string
  /** 猜出来的动作类型，只影响图标 / 分组 */
  actionType: CareActionType
}

/**
 * 指南 → 待创建的养护任务。
 *
 * 同一天、同名的事项只留一条（AI 有时在小节之间重复写），
 * 已经存在于计划里的由调用方去重（数据库有唯一约束/跳过逻辑）。
 */
export function careGuideTaskDrafts(parsed: ParsedCareGuide): CareGuideTaskDraft[] {
  const seen = new Set<string>()
  const out: CareGuideTaskDraft[] = []
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const key = `${item.date}|${item.title}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title: item.title, dueDate: item.date, note: item.note, actionType: guessCareAction(item.title) })
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'zh'))
}
