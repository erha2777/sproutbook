/**
 * 领域类型定义 —— 纯类型，无任何运行时依赖。
 *
 * 分层原则：
 *  - species（物种库 / 知识层）：百科式信息，可共享、可由 AI 补全
 *  - plants （我的植株 / 实例层）：私有实例，引用一个 species
 *  - environments（环境档案）：位置 / 光照 / 气候，被多株植株引用
 *  - field_definitions（模板字段）：决定上面两层各有哪些属性，用户可编辑
 */

// ---------------------------------------------------------------------------
// 模板字段
// ---------------------------------------------------------------------------

export type FieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'bool'
  | 'select'
  | 'multiselect'
  | 'tags'
  | 'month_range'
  | 'hours_range'
  | 'date'
  | 'image'
  | 'link'

/** 月份区间。from > to 表示跨年（如 11 月 ~ 次年 2 月）。 */
export interface MonthRange {
  from: number
  to: number
}

/** 数值区间，用于「光照时长 6~8 小时」这类字段。 */
export interface NumberRange {
  min: number | null
  max: number | null
}

export type FieldValue = string | number | boolean | string[] | MonthRange | NumberRange | null

export type FieldOwner = 'species' | 'plant'

export interface FieldDefinition {
  id: number
  ownerKind: FieldOwner
  key: string
  label: string
  labelEn: string | null
  groupName: string
  type: FieldType
  unit: string | null
  options: string[] | null
  defaultValue: FieldValue
  helpText: string | null
  /** 系统字段不可删除，只能改标签 / 排序 / 归档。 */
  isSystem: boolean
  isRequired: boolean
  /** 安全相关字段（毒性等）：AI 填充后必须由人工确认。 */
  isSafety: boolean
  /** 若非空，值存放在该数据库列上而不是 attributes_json。 */
  columnName: string | null
  sortOrder: number
  archivedAt: string | null
}

/** 只包含「可以改」的部分，用于模板编辑。 */
export interface FieldDefinitionPatch {
  label?: string
  groupName?: string
  /** 改类型可能让已有数据无法解析，仓储层会返回使用量供界面提示 */
  type?: FieldType
  unit?: string | null
  options?: string[] | null
  defaultValue?: FieldValue
  helpText?: string | null
  isRequired?: boolean
  isSafety?: boolean
  sortOrder?: number
  archivedAt?: string | null
}

export interface NewFieldDefinition {
  ownerKind: FieldOwner
  key: string
  label: string
  labelEn?: string | null
  groupName: string
  type: FieldType
  unit?: string | null
  options?: string[] | null
  defaultValue?: FieldValue
  helpText?: string | null
  isRequired?: boolean
  isSafety?: boolean
}

// ---------------------------------------------------------------------------
// 环境档案
// ---------------------------------------------------------------------------

export type EnvironmentKind = 'indoor' | 'balcony' | 'terrace' | 'ground' | 'greenhouse'
export type LightLevel = 'full_sun' | 'part_shade' | 'shade'

export interface Environment {
  id: number
  name: string
  kind: EnvironmentKind
  lightLevel: LightLevel | null
  /** 实际直射小时数，用于与物种「光照时长」需求做匹配度计算。 */
  lightHours: number | null
  climateZone: string | null
  province: string | null
  city: string | null
  lat: number | null
  lon: number | null
  canHeat: boolean
  frostProtected: boolean
  sortOrder: number
  archivedAt: string | null
}

export type EnvironmentInput = Omit<Environment, 'id' | 'archivedAt'> & { id?: number }

// ---------------------------------------------------------------------------
// 物种与植株
// ---------------------------------------------------------------------------

export interface Species {
  id: number
  commonName: string
  scientificName: string | null
  family: string | null
  genus: string | null
  aliases: string[]
  attributes: Record<string, FieldValue>
  /** manual | ai | imported | seed */
  source: string
  /** 逐字段 AI 置信度：{ fieldKey: 0~1 } */
  confidence: Record<string, number>
  /** 已人工确认过的字段 key 列表 */
  verifiedFields: string[]
  createdAt: string
  updatedAt: string
}

export type PlantStatus = 'growing' | 'dormant' | 'sick' | 'dead' | 'gifted'

export interface Plant {
  id: number
  speciesId: number | null
  nickname: string
  envId: number | null
  status: PlantStatus
  acquiredAt: string | null
  potSize: string | null
  attributes: Record<string, FieldValue>
  notes: string | null
  coverImageId: number | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface PlantWithSpecies extends Plant {
  species: Pick<Species, 'id' | 'commonName' | 'scientificName' | 'family' | 'aliases'> | null
  coverImagePath: string | null
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

export interface ImageRecord {
  id: number
  plantId: number | null
  speciesId: number | null
  path: string
  thumbPath: string | null
  caption: string | null
  origin: string
  sortOrder: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// 设置与 AI
// ---------------------------------------------------------------------------

export type AiProviderId = 'openai-compatible'

export interface AiSettings {
  enabled: boolean
  provider: AiProviderId
  baseUrl: string
  chatModel: string
  visionModel: string
  /** 请求超时（毫秒） */
  timeoutMs: number
  /** 失败重试次数 */
  maxRetries: number
  temperature: number
  /** 是否有已保存的密钥（不返回密钥本身） */
  hasApiKey: boolean
  /** 密钥是否以明文存储（系统钥匙串不可用时降级） */
  keyStoredInPlaintext: boolean
}

export interface AiSettingsPatch extends Partial<Omit<AiSettings, 'hasApiKey' | 'keyStoredInPlaintext'>> {
  /** 传入则覆盖密钥；传入空字符串表示清除。 */
  apiKey?: string
}

export interface AiConnectionResult {
  ok: boolean
  message: string
  /** 探测到的可用模型列表（部分服务不支持，故可为空） */
  models?: string[]
  latencyMs?: number
}

/** AI 生成的字段草稿：不直接落库，必须经用户确认。 */
export interface AiFieldDraft {
  fieldKey: string
  label: string
  value: FieldValue
  confidence: number
  /** 安全字段必须人工确认 */
  needsReview: boolean
  /** 该字段当前已有值，落库会覆盖 */
  willOverwrite: boolean
  currentValue: FieldValue
}

export interface AiAutofillResult {
  ok: boolean
  message: string
  speciesName: string
  drafts: AiFieldDraft[]
  model: string | null
  raw: string | null
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  sqlite: string
  platform: string
  userDataPath: string
  dbPath: string
  /** 是否已关闭 Chromium 沙箱（受限环境下的兜底） */
  sandboxDisabled: boolean
  /** 关闭原因，便于排查与支持 */
  sandboxReason: string | null
  /** 进程完整性级别；低完整性时 Chromium 沙箱无法初始化 */
  integrityLevel: string | null
}

/** 沙箱兜底的诊断与快捷方式状态。 */
export interface SandboxShortcutStatus {
  path: string
  scope: 'desktop' | 'startMenu'
  exists: boolean
}

export interface SandboxStatus {
  disabled: boolean
  reason: string | null
  integrityLevel: string | null
  /** 是否支持创建快捷方式（仅 Windows） */
  canCreateShortcut: boolean
  shortcuts: SandboxShortcutStatus[]
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
