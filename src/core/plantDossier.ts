/**
 * 「这一株的全部信息」→ 一段给 AI 看的档案。
 *
 * 放在 core 是为了能用自检钉住：提示词可以改，但"哪些信息必须带上、
 * 空字段不能占位、超长要截断"这些是硬要求 —— 漏一个字段，AI 就会开始瞎猜。
 */

export interface DossierField {
  label: string
  value: string
}

export interface DossierPlant {
  nickname: string
  category?: string | null
  statusLabel: string
  /** 当前状态已经持续了几天（从最后改状态那天算起）；null / 省略表示不知道 */
  statusDays?: number | null
  /** 自动推算的物候阶段（中文名），没有就 null */
  phaseLabel?: string | null
  /** 阶段的依据，例如「10 月在开花期内」 */
  phaseReason?: string | null
  acquiredAt?: string | null
  potSize?: string | null
  cultivation?: string | null
  heightCm?: number | null
  ageYears?: number | null
  price?: number | null
  notes?: string | null
  /** 其余模板字段（已格式化成中文标签 + 值） */
  attributes?: DossierField[]
}

export interface DossierSpecies {
  commonName: string
  scientificName?: string | null
  family?: string | null
  genus?: string | null
  aliases?: string[]
  attributes?: DossierField[]
}

export interface DossierEnv {
  name: string
  light?: string | null
  lightHours?: number | null
  location?: string | null
  notes?: string | null
}

export interface DossierTask {
  title: string
  dueDate: string
  status: string
}

export interface DossierLog {
  date: string
  kind: string
  content: string
}

export interface DossierInput {
  plant: DossierPlant
  species?: DossierSpecies | null
  env?: DossierEnv | null
  /** 未完成 / 已完成的养护任务（调用方决定给哪些） */
  tasks?: DossierTask[]
  /** 最近的养护日志（新→旧） */
  logs?: DossierLog[]
  today: string
  /** 超过这个长度就截断（日志最后截），默认 6000 */
  maxChars?: number
}

const STATUS_TEXT: Record<string, string> = {
  pending: '待做',
  done: '已完成',
  skipped: '已跳过'
}

function joinFields(fields: DossierField[]): string {
  return fields
    .filter((f) => f.value.trim() !== '')
    .map((f) => `${f.label}：${f.value.trim()}`)
    .join('；')
}

function line(label: string, body: string): string | null {
  return body.trim() ? `${label}${body.trim()}` : null
}

export function buildPlantDossier(input: DossierInput): string {
  const { plant, species, env, tasks = [], logs = [], today } = input
  const maxChars = Math.max(1000, input.maxChars ?? 6000)
  const parts: string[] = []

  parts.push(`（今天 ${today}）`)

  // 1) 植株本体
  const p: DossierField[] = [
    { label: '昵称', value: plant.nickname },
    { label: '分类', value: plant.category ?? '' },
    {
      label: '状态',
      // 带上「已 N 天」：'缓苗 20 天还蔫' 和 '今天刚缓苗' 该给的答案完全不同
      value:
        typeof plant.statusDays === 'number'
          ? `${plant.statusLabel}（已 ${plant.statusDays} 天）`
          : plant.statusLabel
    }
  ]
  if (plant.phaseLabel) {
    p.push({
      label: '物候阶段',
      value: plant.phaseReason ? `${plant.phaseLabel}（${plant.phaseReason}）` : plant.phaseLabel
    })
  }
  p.push(
    { label: '入手/播种', value: plant.acquiredAt ?? '' },
    { label: '栽种方式', value: plant.cultivation ?? '' },
    { label: '盆径', value: plant.potSize ?? '' },
    { label: '现状高度', value: plant.heightCm !== null && plant.heightCm !== undefined ? `${plant.heightCm} cm` : '' },
    { label: '苗龄', value: plant.ageYears !== null && plant.ageYears !== undefined ? `${plant.ageYears} 年` : '' },
    { label: '购入价格', value: plant.price !== null && plant.price !== undefined ? `${plant.price} 元` : '' }
  )
  for (const f of plant.attributes ?? []) p.push(f)
  const plantLine = line('【植株】', joinFields(p))
  if (plantLine) parts.push(plantLine)

  if (plant.notes && plant.notes.trim()) parts.push(`【本株备注】${plant.notes.trim()}`)

  // 2) 物种（知识层）
  if (species) {
    const s: DossierField[] = [
      { label: '名称', value: species.commonName },
      { label: '学名', value: species.scientificName ?? '' },
      { label: '科属', value: [species.family, species.genus].filter(Boolean).join(' / ') },
      { label: '别名', value: (species.aliases ?? []).join('、') }
    ]
    for (const f of species.attributes ?? []) s.push(f)
    const speciesLine = line('【物种】', joinFields(s))
    if (speciesLine) parts.push(speciesLine)
  }

  // 3) 养护位置
  if (env) {
    const e: DossierField[] = [
      { label: '名称', value: env.name },
      { label: '光照等级', value: env.light ?? '' },
      { label: '每日直射', value: env.lightHours !== null && env.lightHours !== undefined ? `${env.lightHours} 小时` : '' },
      { label: '地点', value: env.location ?? '' },
      { label: '备注', value: env.notes ?? '' }
    ]
    const envLine = line('【养护位置】', joinFields(e))
    if (envLine) parts.push(envLine)
  }

  // 4) 计划与日志
  const open = tasks.filter((t) => t.status === 'pending').slice(0, 12)
  if (open.length > 0) {
    const rows = open.map((t) => `- ${t.dueDate} ${t.title}（${STATUS_TEXT[t.status] ?? t.status}）`)
    parts.push(`【接下来的养护任务】\n${rows.join('\n')}`)
  }
  const recent = logs.slice(0, 10)
  if (recent.length > 0) {
    /*
     * 日志里写的是**已经发生的事**。用户「昨天已经种下了」之后，模型还在写
     * 「11 月：缓苗后定植」—— 因为它把日志当成了背景资料而不是事实。
     * 这里先明确一句，再把「已种下」单独提出来，免得和字段里的「盆栽」打架。
     */
    const planted = recent.find((l) => /种下|地栽|定植|入土|栽到|上盆/.test(l.content))
    if (planted) {
      parts.push(`【栽种状态】日志显示已经种下 / 定植（${planted.date}）—— 不要再把定植、上盆、缓苗前的步骤写成待办`)
    }
    const rows = recent.map((l) => `- ${l.date} [${l.kind}] ${l.content}`)
    parts.push(`【最近的养护日志】（已经发生的事，按它们修正计划）\n${rows.join('\n')}`)
  }

  let text = parts.join('\n')
  if (text.length > maxChars) {
    // 从尾部截（日志最先被丢），并明确告诉模型"后面还有，只是没给出"
    text = `${text.slice(0, maxChars)}\n…（档案过长，后面还有内容已省略）`
  }
  return text
}

export const ASK_PLANT_SYSTEM_PROMPT = [
  '你是一位耐心、务实的家庭植物养护顾问。',
  '用户会给你一株植物的完整档案（植株、物种、养护位置、养护任务、最近日志），然后问一个问题。',
  '',
  '回答要求：',
  '1. 只根据档案里的事实回答；档案没写的，不要编造。',
  '2. 先给结论，再用 2~4 条要点说理由和下一步怎么做。',
  '3. 如果信息不足以判断（比如没记录浇水频率、没照片），直接说明缺什么，并给出你可以怎么确认。',
  '4. 涉及安全（毒性、用药剂量）时，宁可保守，并提示以专业意见为准。',
  '5. 中文回答，不要输出 Markdown 表格，不要客套话。'
].join('\n')

export interface AskPlantMessages {
  system: string
  user: string
}

export function buildAskPlantMessages(
  dossier: string,
  question: string,
  /** 随消息附上的照片数量；0 / 省略表示纯文本提问 */
  imageCount = 0
): AskPlantMessages {
  const photoNote =
    imageCount > 0
      ? `\n\n【随消息附上的照片】\n共 ${imageCount} 张，都是这株植物的照片（植株相册或养护记录里选的）。\n` +
        '看照片时请注意：叶子颜色与形态、有没有斑点/虫、盆土干湿、枝条状态。看不清楚就说明看不清，不要猜。'
      : ''
  return {
    system: ASK_PLANT_SYSTEM_PROMPT,
    user: `【这株植物的档案】\n${dossier}${photoNote}\n\n【问题】\n${question.trim()}`
  }
}
