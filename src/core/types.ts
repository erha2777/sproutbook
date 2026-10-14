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
  /**
   * 关联到另一个实体（值存对方的主键）。
   *
   * 有了它，「所属物种」「养护位置」这类字段才能和其它字段一样进模板 ——
   * 否则只能硬编码在表单里，用户无法调整位置、改标签、换分组。
   * 目标表由 relationTarget 指定。
   */
  | 'relation'

/** relation 字段可以指向的目标。加新目标时，渲染层的选项来源也要一起补。 */
export type RelationTarget = 'environments' | 'species' | 'recipes'

export const RELATION_TARGETS: Array<{ value: RelationTarget; label: string }> = [
  { value: 'environments', label: '养护位置' },
  { value: 'species', label: '物种库' },
  { value: 'recipes', label: '配方' }
]

/**
 * 月份区间（旧写法，仍然兼容读取）。
 *
 * 现在 month_range 字段的值统一是**月份集合** `number[]`，
 * 因为这个形状表达不了「4~6 月 + 9~11 月」这种一年开两次的情况。
 * 保留这个类型是为了：老数据、字符串解析、以及 monthsInRange 展开。
 */
export interface MonthRange {
  from: number
  to: number
}

/** 数值区间，用于「光照时长 6~8 小时」这类字段。 */
export interface NumberRange {
  min: number | null
  max: number | null
}

export type FieldValue = string | number | boolean | string[] | number[] | MonthRange | NumberRange | null

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
  /** 仅 type='relation' 时有意义：指向哪张表。 */
  relationTarget: RelationTarget | null
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
  relationTarget?: RelationTarget | null
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
  relationTarget?: RelationTarget | null
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
// 材料与配方
// ---------------------------------------------------------------------------

export type MaterialKind = 'substrate' | 'fertilizer' | 'pesticide' | 'tool' | 'other'

export interface Material {
  id: number
  name: string
  kind: MaterialKind
  /** 常用单位（升 / 克 / 毫升）。留空表示按「份」计。 */
  unit: string | null
  note: string | null
}

export type MaterialInput = Omit<Material, 'id'> & { id?: number }

/**
 * 配方条目。
 *
 * 两种写法并存，因为它们回答的是不同问题：
 *  - **比例**（ratioPart）：配土这类「按份混合」的场景，关心的是泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2
 *  - **用量**（amount + unit）：肥料、药剂这类「每批加多少」的场景，关心的是 20 克
 * 一条目可以只有比例、只有用量，也可以两者都有（既说明占比又给出建议量）。
 *
 * materialId 为空时用 name 记一个临时材料，这样「手边只有一包不知名的土」也能录进来。
 */
export interface RecipeItem {
  id?: number
  materialId: number | null
  /** 材料库外的临时材料名；与 materialId 至少有一个 */
  name: string | null
  /** 比例份数 */
  ratioPart: number | null
  /** 绝对用量，与 unit 搭配 */
  amount: number | null
  unit: string | null
  note: string | null
  sortOrder: number
}

export interface Recipe {
  id: number
  name: string
  /** 配土 / 肥料 / 药剂 …（自由文本，给出常用建议值） */
  kind: string
  note: string | null
  items: RecipeItem[]
  createdAt: string
  archivedAt: string | null
}

export interface RecipeInput {
  id?: number
  name: string
  kind: string
  note: string | null
  items: RecipeItem[]
}

export interface RecipeListItem extends Recipe {
  /** 一行摘要，例如「泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2」 */
  summary: string
}

// ---------------------------------------------------------------------------
// 养护计划
// ---------------------------------------------------------------------------

export type CareActionType =
  | 'water'
  | 'fertilize'
  | 'prune'
  | 'repot'
  | 'pest'
  | 'protect'
  | 'observe'
  | 'other'

export type CareHemisphere = 'N' | 'S'

/**
 * 物种养护规则。
 *
 * `speciesKey` 为 `'*'` 时是通用规则（所有植物都适用），
 * 否则按**物种名**匹配 —— 规则库是给人看、可导出分享的数据，
 * 用名字比用自增 ID 有意义。代价是改物种名会让专属规则失配，
 * 所以生成任务时会把「用了哪些规则」记在计划里备查。
 */
export interface CareRule {
  id: number
  speciesKey: string
  hemisphere: CareHemisphere
  climateZone: string | null
  monthFrom: number
  /** 为空表示只作用于 monthFrom 这一个月 */
  monthTo: number | null
  /**
   * 重复间隔（天）。为空时保持「区间内每月一条」的老行为；
   * 填 7 ~ 10 这类值可表达「每 7~10 天一轮」的节奏。
   */
  repeatDays: number | null
  /**
   * 轮换步骤。非空时生成的任务会按顺序取名 ——
   * 例如 ["花多多1号","海藻精","腐植酸水溶肥"] 会产出
   * 「追肥 · 花多多1号」「追肥 · 海藻精」「追肥 · 腐植酸水溶肥」再循环。
   */
  rotation: string[] | null
  actionType: CareActionType
  title: string
  detail: string | null
  priority: number
  source: 'seed' | 'ai' | 'manual'
  /** 未经人工核实的 AI 规则，界面上要标出来 */
  verified: boolean
  createdAt: string
}

export type CareRuleInput = Omit<CareRule, 'id' | 'createdAt'> & { id?: number }

export type CarePlanStatus = 'active' | 'archived'

export interface CarePlan {
  id: number
  plantId: number | null
  name: string
  year: number | null
  source: 'manual' | 'generated'
  status: CarePlanStatus
  createdAt: string
  updatedAt: string
}

export type CareTaskStatus = 'pending' | 'done' | 'skipped'

export interface CareTask {
  id: number
  planId: number | null
  plantId: number | null
  actionType: CareActionType
  title: string
  detail: string | null
  /** YYYY-MM-DD */
  dueDate: string
  /** 时间窗：dueDate ± windowDays 内做都算准时 */
  windowDays: number
  recurrence: string | null
  priority: number
  status: CareTaskStatus
  completedAt: string | null
  completedNote: string | null
  source: 'seed' | 'ai' | 'manual' | 'generated'
  createdAt: string
}

export interface CareTaskInput {
  id?: number
  planId?: number | null
  plantId?: number | null
  actionType: CareActionType
  title: string
  detail?: string | null
  dueDate: string
  windowDays?: number
  recurrence?: string | null
  priority?: number
  source?: CareTask['source']
}

export interface CareLog {
  id: number
  plantId: number
  taskId: number | null
  /** YYYY-MM-DD */
  logDate: string
  kind: string
  content: string | null
  imageId: number | null
  createdAt: string
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
