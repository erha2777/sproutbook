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

/**
 * 字段的显示条件。
 *
 * 「盆径」只在你选了盆栽时才有意义，「中毒症状」只在毒性等级不是无毒时才有意义 ——
 * 无条件地把它们摆在表单上，一半时间都是噪音。
 *
 * 做成模板里的一条数据而不是写死在代码里，和这个应用一贯的做法一致：
 * 想加一条条件不用改前端。
 */
export interface FieldVisibleWhen {
  /** 依赖哪个字段（同一 owner 下的 key） */
  key: string
  /** 该字段取这些值之一时，本字段才显示 */
  in: string[]
}

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
  /** 为空表示总是显示 */
  visibleWhen: FieldVisibleWhen | null
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
  /** 传 null 表示清掉条件（总是显示） */
  visibleWhen?: FieldVisibleWhen | null
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
  /** 为空表示总是显示 */
  visibleWhen?: FieldVisibleWhen | null
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
  /**
   * 区 / 县 / 县级市。
   * 只有配了和风天气的 key 时，这一级才会真正影响坐标 ——
   * Open-Meteo 认不出中国的区县（示范县查不到，邻县却查得到）。
   */
  district: string | null
  lat: number | null
  lon: number | null
  canHeat: boolean
  frostProtected: boolean
  /** 位置备注：朝向、西晒、架子层高、冬天暖气…… 填表填不出来但一眼要看到的东西 */
  notes: string | null
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

/**
 * 植株状态：**人观察到的当前状态**，需要手动设置。
 *
 * 和「物候阶段」分开：阶段由物种花期 + 日期自动推算（见 core/phase.ts），
 * 这里记的是你亲眼看到的事实 —— 它可能比日历更准（阳台比露台晚开两周），
 * 也可能完全不在日历上（这盆突然烂根了）。
 */
export type PlantStatus =
  | 'seed'
  | 'growing'
  | 'budding'
  | 'blooming'
  | 'recovering'
  | 'sick'
  | 'dormant'
  | 'dead'
  | 'gifted'

export interface Plant {
  id: number
  speciesId: number | null
  nickname: string
  envId: number | null
  status: PlantStatus
  /**
   * 当前状态是从哪天开始的（YYYY-MM-DD）。
   * 改状态时更新；老数据用入手日期 / 建档日期兜底。
   */
  statusChangedAt: string | null
  /** 用户自己分的类（「月季类」「多肉类」），列表按它筛选 */
  category: string | null
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
// 物品与配方
// ---------------------------------------------------------------------------

export type MaterialKind = 'substrate' | 'fertilizer' | 'pesticide' | 'tool' | 'other'

export interface Material {
  /** 第一张照片（买的袋装土长什么样），没有就是 null；保存时不传也行 */
  imageId?: number | null
  imageThumb?: string | null
  id: number
  name: string
  kind: MaterialKind
  /** 常用单位（升 / 克 / 毫升）。留空表示按「份」计。 */
  unit: string | null
  /** 现在手头大概还有多少（单位同 unit）。null = 没记。 */
  stock: number | null
  /** 单价：每单位多少钱（元）。null = 没记。 */
  price: number | null
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
 * materialId 为空时用 name 记一个临时物品，这样「手边只有一包不知名的土」也能录进来。
 */
export interface RecipeItem {
  id?: number
  materialId: number | null
  /** 物品库外的临时物品名；与 materialId 至少有一个 */
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
  /** 手动标记「现在能做 / 物品齐了」。不自动推算，见 schema 里的说明。 */
  available: boolean
  items: RecipeItem[]
  createdAt: string
  archivedAt: string | null
}

export interface RecipeInput {
  id?: number
  name: string
  kind: string
  note: string | null
  available?: boolean
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

/** 植株的物候阶段。是「观察到的状态」而不是月份，所以由人标记。 */
export type CarePhase =
  | 'seed'
  | 'growing'
  | 'budding'
  | 'blooming'
  | 'dormant'
  | 'recovering'
  | 'pest'

/**
 * 物种养护规则。
 *
 * `speciesKeys` 含 `'*'` 时是通用规则（所有植物都适用），
 * 否则按**物种名**匹配 —— 规则库是给人看、可导出分享的数据，
 * 用名字比用自增 ID 有意义。代价是改物种名会让专属规则失配，
 * 所以生成任务时会把「用了哪些规则」记在计划里备查。
 *
 * 之所以是数组：真实的底肥方案里多个物种共用一套配比
 * （「绣球、无花果、月季」一套，「杜鹃、中华木绣球、三角梅」另一套），
 * 单值会逼出「一物种一条规则」，改一次配比要改好几处，迟早不同步。
 */
export interface CareRule {
  id: number
  speciesKeys: string[]
  hemisphere: CareHemisphere
  climateZone: string | null
  monthFrom: number
  /** 为空表示只作用于 monthFrom 这一个月 */
  monthTo: number | null
  /**
   * 起始月份的第几天（默认 1）。
   *
   * 规则不再只到月：起始月 + 起始日、结束月 + 结束日一起构成一个日期区间。
   * 每月一条的规则，日期就取每个月的这一天。
   */
  monthFromDay?: number
  /**
   * 结束月份的第几天。为空＝该月最后一天。
   *
   * 只用来收口区间：比如 3/15~6/10，6 月那条如果排在 15 号就超出区间，不再生成。
   */
  monthToDay?: number | null
  /**
   * 重复间隔（天）。为空时保持「区间内每月一条」的老行为；
   * 填 7 ~ 10 这类值可表达「每 7~10 天一轮」的节奏。
   */
  repeatDays: number | null
  /**
   * 跨月区间里只做一次。
   *
   * 原来「10~11 月」会在两个月各生成一条任务，但底肥一季只需要埋一次 ——
   * 那时只能把区间收窄到单月绕过，规则本身表达不了「这个窗口里做一次就够」。
   * 打开后每个连续区间只产出一条，落在窗口开头（这类事早做比晚做好）。
   * 与 repeatDays 同时打开时以 repeatDays 为准。
   */
  oncePerWindow: boolean
  /**
   * 同一条规则下所有植株在同一天做。
   *
   * 默认是**按植株错开**锚点日的（日常浇水不该全挤一天）；
   * 但秋埋底肥这类「一年一次、要一次把几盆都处理掉」的事，
   * 错开反而和实际做法相反 —— 打开后同一规则的所有植株用同一个锚点日。
   *
   * 旧数据没有这一列时按 false 处理（迁移里加了默认 0）。
   */
  sameDay?: boolean
  /** 绑定的配方。为空表示这条规则没有物品清单 */
  recipeId: number | null
  /**
   * 轮换步骤。非空时生成的任务会按顺序取名 ——
   * 例如 ["花多多1号","海藻精","腐植酸水溶肥"] 会产出
   * 「追肥 · 花多多1号」「追肥 · 海藻精」「追肥 · 腐植酸水溶肥」再循环。
   */
  rotation: string[] | null
  /**
   * 限定生效的物候阶段。为空＝按月份生效；
   * 非空时忽略月份，只在植株处于这些阶段之一时生效。
   * 「休眠期停止水溶追肥」就是靠这个表达的。
   */
  activePhases: CarePhase[] | null
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
  /** 由哪条规则生成。手动建的任务为空 */
  ruleId: number | null
  /**
   * 生成时那条规则绑的配方（冗余存一份）。
   * 规则后来改了配方不该影响已经生成的任务 —— 它提醒的是当时要做的那件事。
   */
  recipeId: number | null
  source: 'seed' | 'ai' | 'manual' | 'generated' | 'guide'
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
  /** 由哪条规则生成。手动建的任务为空 */
  ruleId?: number | null
  /** 生成时那条规则绑的配方 */
  recipeId?: number | null
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
  /**
   * 完成时用的配方。
   * 任务卡片说的是「打算怎么做」，日志记的是「实际怎么做的」——
   * 过一年回头看「这盆当时埋的什么」，只有它能回答。为空表示与配方无关。
   */
  recipeId: number | null
  imageId: number | null
  /**
   * 这条记录带的照片。
   *
   * 文件存在 userData/images，数据库只记文件名；界面用 plantimg:// 协议读。
   * 一条记录可以带多张 —— 换盆前后、虫害特写、开花状态都可能要留。
   */
  images: CareLogImage[]
  createdAt: string
}

/** 养护日志上的一张照片（只带展示需要的字段） */
export interface CareLogImage {
  id: number
  path: string
  thumbPath: string | null
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

export interface ImageRecord {
  id: number
  plantId: number | null
  speciesId: number | null
  /** 养护位置的图片（拍窗台、架子、光照），暂时只存着，留给以后的 AI 分析 */
  environmentId: number | null
  /** 物品的照片（买的袋装土、肥料长什么样） */
  materialId: number | null
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
