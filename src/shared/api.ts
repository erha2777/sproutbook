/**
 * 渲染进程可用的 API 契约。
 *
 * preload 负责实现，renderer 只依赖这个接口 —— 这样两端永远不会因为通道名写错而静默失败：
 * 名字写错在编译期就会报错。
 */

import type {
  AiAutofillResult,
  AiConnectionResult,
  AiSettings,
  AiSettingsPatch,
  AppInfo,
  CareActionType,
  CareHemisphere,
  CareLog,
  CarePhase,
  CareRule,
  CareRuleInput,
  CareTask,
  CareTaskInput,
  CareTaskStatus,
  Environment,
  EnvironmentInput,
  FieldDefinition,
  FieldDefinitionPatch,
  FieldOwner,
  ImageRecord,
  Material,
  MaterialInput,
  NewFieldDefinition,
  Plant,
  PlantStatus,
  PlantWithSpecies,
  RecipeInput,
  RecipeListItem,
  SandboxShortcutStatus,
  SandboxStatus,
  Species
} from '../core/types'

export interface SpeciesListItem extends Species {
  coverThumb: string | null
  coverPath: string | null
  plantCount: number
  /** AI 填过、尚未人工核实的安全字段（非安全字段不需要核实） */
  pendingSafetyFields: string[]
}

export interface PlantListItem extends PlantWithSpecies {
  envName: string | null
  coverThumb: string | null
}

export interface FieldUsageSummary {
  field: FieldDefinition
  usage: number
}

export interface PlantListItemStats {
  total: number
  byStatus: Array<{ status: string; count: number }>
  byEnv: Array<{ envId: number | null; envName: string; count: number }>
  byFamily: Array<{ family: string; count: number }>
  bloomingThisMonth: number
}

export interface BackupInfo {
  path: string
  size: number
  createdAt: string
}

export interface AppPaths {
  userData: string
  data: string
  images: string
  backups: string
  db: string
  encryptionAvailable: boolean
}

export interface SaveSpeciesResponse {
  species: SpeciesListItem
  errors: Record<string, string>
  pendingReview: string[]
}

export interface SavePlantResponse {
  plant: PlantListItem | null
  errors: Record<string, string>
}

export interface ImportResponse {
  imported: ImageRecord[]
  canceled: boolean
  failures?: string[]
}

export interface AiRunRow {
  id: number
  kind: string
  model: string | null
  status: string
  error: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  duration_ms: number | null
  created_at: string
}

export interface SproutbookApi {
  app: {
    info(): Promise<AppInfo>
    paths(): Promise<AppPaths>
    backups(): Promise<BackupInfo[]>
    backupNow(): Promise<BackupInfo | null>
    openDataDir(): Promise<boolean>
    openImagesDir(): Promise<boolean>
  }
  /**
   * 沙箱兜底。
   * 受限环境（低完整性进程等）下 Chromium 沙箱无法初始化，普通双击会直接崩溃；
   * 由于沙箱初始化早于主进程 JS，应用内无法自救，只能靠命令行参数 ——
   * 这里提供「创建带 --no-sandbox 的原生快捷方式」，双击图标即可运行。
   */
  sandbox: {
    status(): Promise<SandboxStatus>
    createShortcut(scope?: 'desktop' | 'startMenu'): Promise<{
      created: SandboxShortcutStatus
      shortcuts: SandboxShortcutStatus[]
    }>
    removeShortcuts(): Promise<{ removed: string[]; shortcuts: SandboxShortcutStatus[] }>
  }
  ai: {
    getSettings(): Promise<AiSettings>
    setSettings(patch: AiSettingsPatch): Promise<AiSettings>
    clearApiKey(): Promise<AiSettings>
    keyWarning(): Promise<string | null>
    test(): Promise<AiConnectionResult>
    autofill(payload: {
      requestId: string
      plantName: string
      hints?: string
      existing?: Record<string, unknown>
    }): Promise<AiAutofillResult>
    /**
     * 识别一张**本地图片**（主进程弹文件对话框）。
     * 新建物种时相册里还没有图片，必须能从磁盘选。
     * 用户取消选择时 ok 为 false、message 为「没有选择图片。」。
     */
    identifyFile(payload: { requestId: string; hint?: string }): Promise<AiIdentifyResult>
    cancel(requestId: string): Promise<boolean>
  }
  fields: {
    list(ownerKind: FieldOwner, includeArchived?: boolean): Promise<FieldDefinition[]>
    create(input: NewFieldDefinition): Promise<FieldDefinition>
    update(id: number, patch: FieldDefinitionPatch): Promise<FieldDefinition>
    setArchived(id: number, archived: boolean): Promise<FieldDefinition>
    remove(id: number): Promise<boolean>
    usage(ownerKind: FieldOwner): Promise<FieldUsageSummary[]>
    reorder(ownerKind: FieldOwner, orderedIds: number[]): Promise<boolean>
  }
  species: {
    list(options?: {
      query?: string
      family?: string
      bloomMonth?: number
      limit?: number
      offset?: number
    }): Promise<{ items: SpeciesListItem[]; total: number }>
    get(id: number): Promise<SpeciesListItem | null>
    save(payload: {
      id?: number
      values: Record<string, unknown>
      origin?: 'manual' | 'ai'
      /** AI 填入的字段及置信度，用于把安全字段标记为「待核实」 */
      aiFields?: Array<{ key: string; confidence: number }>
    }): Promise<SaveSpeciesResponse>
    /** verified=false 表示撤回核实（点错了能反悔） */
    verify(id: number, fieldKeys: string[], verified?: boolean): Promise<Species | null>
    remove(id: number): Promise<boolean>
    families(): Promise<Array<{ family: string; count: number }>>
  }
  plants: {
    list(options?: {
      query?: string
      status?: PlantStatus
      envId?: number
      speciesId?: number
      limit?: number
      offset?: number
    }): Promise<{ items: PlantListItem[]; total: number }>
    save(payload: {
      id?: number
      speciesId?: number | null
      envId?: number | null
      nickname?: string
      status?: PlantStatus
      notes?: string | null
      values: Record<string, unknown>
    }): Promise<SavePlantResponse>
    remove(id: number): Promise<boolean>
    stats(month?: number): Promise<PlantListItemStats>
  }
  env: {
    list(includeArchived?: boolean): Promise<Environment[]>
    save(input: EnvironmentInput): Promise<Environment>
    remove(id: number): Promise<boolean>
  }
  images: {
    list(owner: { plantId?: number; speciesId?: number }): Promise<ImageRecord[]>
    pick(owner: { plantId?: number; speciesId?: number }): Promise<ImportResponse>
    remove(id: number): Promise<ImageRecord | null>
  }
  materials: {
    list(query?: string): Promise<Material[]>
    save(input: MaterialInput): Promise<Material>
    /** 被配方引用的材料会被拒绝删除并抛出人话错误 */
    remove(id: number): Promise<boolean>
    /** 有多少个配方在用这个材料 */
    usage(id: number): Promise<number>
  }
  recipes: {
    list(options?: { query?: string; kind?: string; includeArchived?: boolean }): Promise<RecipeListItem[]>
    save(input: RecipeInput): Promise<{ recipe: RecipeListItem | null; errors: Record<string, string> }>
    archive(id: number): Promise<boolean>
    restore(id: number): Promise<boolean>
    /** 配方里出现过的类型，供筛选下拉使用 */
    kinds(): Promise<string[]>
    stats(): Promise<{ materials: number; recipes: number }>
  }
  transfer: {
    export(
      kind: TransferKind,
      format: TransferFormat
    ): Promise<{ canceled: boolean; count: number; path: string | null }>
    /** 弹文件选择框并解析；取消返回 null。不写库。 */
    previewImport(kind: TransferKind): Promise<TransferPreview | null>
    applyImport(token: string, options?: TransferImportOptions): Promise<TransferResult>
    discardImport(token: string): Promise<boolean>
  }
  /**
   * 天气预警。
   *
   * **没有养护位置填了城市时，一个字节都不会发出去** ——
   * assess 会直接返回 configured: false，界面据此说明情况。
   */
  weather: {
    assess(force?: boolean): Promise<WeatherWarningResult>
    clearCache(): Promise<boolean>
    /** 天气数据源配置。**不返回 key 本身**，只说配没配 */
    config(): Promise<WeatherConfigSnapshot>
    saveConfig(patch: { provider?: 'open-meteo' | 'qweather'; qweatherHost?: string; qweatherKey?: string }): Promise<WeatherConfigSnapshot>
    /** 试一次定位，用来验证 key 和 Host 填对了没有 */
    testLocation(name: string): Promise<{ ok: boolean; label?: string; level?: string; error?: string }>
  }

  care: {
    rules(options?: { speciesKey?: string; hemisphere?: CareHemisphere }): Promise<CareRule[]>
    saveRule(input: CareRuleInput): Promise<CareRule>
    removeRule(id: number): Promise<boolean>

    tasks(query?: CareTaskQuery): Promise<CareTaskListItem[]>
    createTask(input: CareTaskInput): Promise<CareTask>
    updateTask(id: number, patch: CareTaskPatch): Promise<CareTask | null>
    /** 完成时会自动写一条养护日志 */
    completeTask(id: number, note?: string | null, date?: string): Promise<CareTask | null>
    skipTask(id: number, reason?: string | null): Promise<CareTask | null>
    /** 撤销完成 / 跳过，并删掉对应日志 */
    reopenTask(id: number): Promise<CareTask | null>
    removeTask(id: number): Promise<boolean>

    /** 生成是幂等的：签名相同的任务原样保留，已完成的一律不动 */
    generate(plantId: number, year: number): Promise<CareGenerateResult>
    generateAll(year: number): Promise<CareGenerateResult>
    overview(year: number): Promise<CareOverview>

    /** 植株当前物候阶段 */
    plantPhase(plantId: number): Promise<PlantPhaseInfo>
    /** 标记阶段；会写一条养护日志。phase 传 null 表示清除 */
    setPlantPhase(plantId: number, phase: CarePhase | null, note?: string | null): Promise<PlantPhaseInfo>

    logs(plantId?: number, limit?: number): Promise<CareLog[]>
    addLog(input: {
      plantId: number
      taskId?: number | null
      logDate?: string
      kind?: string
      content?: string | null
    }): Promise<CareLog>
    removeLog(id: number): Promise<boolean>
  }
}

// ---------------------------------------------------------------------------
// 养护计划（跨进程契约）
// ---------------------------------------------------------------------------

/** 任务带上植物与物种名 —— 列表里只说「施肥」没人知道是哪一盆 */
export interface CareTaskListItem extends CareTask {
  plantName: string | null
  speciesName: string | null
}

export interface CareTaskQuery {
  plantId?: number
  /** YYYY-MM-DD，含 */
  from?: string
  /** YYYY-MM-DD，含 */
  to?: string
  /** 'open' = 只要待办 */
  status?: CareTaskStatus | 'open'
  actionType?: CareActionType
  limit?: number
}

export interface CareTaskPatch {
  title?: string
  detail?: string | null
  dueDate?: string
  windowDays?: number
  priority?: number
  actionType?: CareActionType
  plantId?: number | null
}

export interface CareGenerateResult {
  created: number
  kept: number
  removed: number
  plants: number
}

export interface PlantPhaseInfo {
  plantId: number
  phase: CarePhase | null
  changedAt: string | null
}

export interface CareOverview {
  total: number
  pending: number
  done: number
  skipped: number
  overdue: number
  due: number
  rules: number
  /** 还没有生成过任务的植物数，界面用来提示「先生成计划」 */
  plantsWithoutTasks: number
  /**
   * 这一年**全部**任务。
   *
   * 上面那几个数字本来就是**全年**口径（careOverview 查的是 01-01~12-31），
   * 而主列表只加载当月 —— 于是「本年待办 24」点开只能看到当月那 10 条，
   * 数字和列表对不上。把全年任务一起带回来，界面才能让统计和列表同源。
   *
   * 量级很小（用户一年几十条），跟着统计一次取回比另开通道省事。
   */
  yearTasks: CareTaskListItem[]
}

// ---------------------------------------------------------------------------
// 导入导出（跨进程契约，放这里而不是 main 里，避免共享层反向依赖主进程）
// ---------------------------------------------------------------------------

export type TransferKind = 'species' | 'plants'
export type TransferFormat = 'csv' | 'json'

export interface TransferMappingEntry {
  /** 文件里的列名（CSV 表头 / JSON 的键） */
  header: string
  /** 匹配到的字段 key；null 表示这一列会被忽略 */
  fieldKey: string | null
  label: string | null
}

export interface TransferIssue {
  /** 数据行号，从 1 开始（不含表头） */
  row: number
  field: string
  message: string
}

export interface TransferPreview {
  token: string
  kind: TransferKind
  format: TransferFormat
  fileName: string
  mapping: TransferMappingEntry[]
  total: number
  /** 按当前映射可以顺利导入的行数 */
  ready: number
  duplicates: number
  issues: TransferIssue[]
  samples: string[][]
  headers: string[]
  /** 导入时会自动新建的关联对象（表格里的名字在库里不存在） */
  willCreate: string[]
}

export interface TransferImportOptions {
  /** 同名记录：跳过（默认）还是覆盖更新 */
  updateExisting?: boolean
  /** 关联目标不存在时是否自动新建（默认 true） */
  createMissing?: boolean
}

export interface TransferResult {
  imported: number
  updated: number
  skipped: number
  failed: number
  created: string[]
  errors: TransferIssue[]
}

/**
 * 天气预警结果。
 *
 * 刻意在 shared 里重新声明而不是从 main/services 导入 ——
 * renderer 引用主进程模块会把 fs / node:sqlite 一起拖进前端打包。
 * 两边形状必须一致，所以自检里有一条专门核对字段。
 */
export interface AiIdentifyCandidate {
  name: string
  scientificName: string | null
  /** 园艺品种名。认不出品种时为空 */
  cultivar: string | null
  /** 认到了哪一层。界面要如实说，别让用户以为认到品种了 */
  level: 'genus' | 'species' | 'cultivar' | null
  /** 0~1 */
  confidence: number
  reason: string
}

export interface AiIdentifyResult {
  ok: boolean
  candidates: AiIdentifyCandidate[]
  /** 识别用的图片来源（文件名），让用户确认看的是哪张 */
  sourceName?: string | null
  /**
   * 模型的原话。没给出候选时用它说明情况。
   * 认不出和没按格式返回分不出来，别替模型编原因。
   */
  raw?: string | null
  /** 失败原因，或「模型认不出」时的说明。成功且有候选时为 null */
  message: string | null
  /** 实际用的模型。出问题时能看出是不是用错了模型 */
  model: string | null
}

export interface WeatherConfigSnapshot {
  provider: 'open-meteo' | 'qweather'
  qweatherHost: string
  /** 钥匙串里有没有 key。**永不回显 key 本身** */
  hasWeatherKey: boolean
  /** host 和 key 都齐了才算可用 */
  qweatherReady: boolean
  /** 当前实际会用的源 */
  activeLabel: string
}

export interface WeatherPlace {
  name: string
  label: string
  /** 解析到了区县还是只到市。界面上要说清楚，不能含糊 */
  level: 'city' | 'district'
  /** 这个点来自哪个数据源 */
  provider: string
  /** 实际用的坐标。精度可见，用户才知道要不要填精确经纬度 */
  latitude: number
  longitude: number
  days: Array<{ date: string; tempMin: number; tempMax: number }>
  /**
   * 未来 24 小时。取不到时是空数组。
   *
   * kind 是**中性的天气类型** —— 两个数据源的编码（WMO / 和风图标号）
   * 已经在主进程那边翻译过了，界面只管按它画图标。
   */
  hours: Array<{ time: string; temp: number; kind: WeatherKind | null; pop: number | null }>
}

/**
 * 中性的天气类型。
 *
 * **用联合而不是 string** —— 界面和 core 里的 adviseToday 都要它，
 * 写成 string 的话每次跨边界都得 cast 一次，而 cast 会把拼写错误放过去
 *（`'rain'` 写成 `'rian'` 编译器不会吭声）。
 */
export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'snow' | 'storm' | 'fog'

export interface WeatherRiskItem {
  kind: 'frost' | 'heat'
  plantId: number
  plantName: string
  speciesName: string | null
  date: string
  forecastTemp: number
  tolerance: number
  margin: number
  severity: 'watch' | 'warn' | 'severe'
  message: string
}

export interface WeatherWarningResult {
  /**
   * 这次**实际**用的是哪个数据源。
   * **不能写死，也不能从配置推导** —— 和风失败时会静默退回 Open-Meteo。
   */
  providerLabel: string
  /**
   * 换源的原因。没换源时为 null。
   * 换源了就要在界面上说出来，否则用户会拿「已到区县」去信一份市级网格预报。
   */
  fallbackReason: string | null
  /** 今天向数据源发了几次请求 */
  requestsToday: number
  /** 有没有养护位置填了城市。false = 完全没联网 */
  configured: boolean
  places: WeatherPlace[]
  /** 收拢后的风险，每株每种一条 */
  risks: WeatherRiskItem[]
  /** 逐天明细 */
  daily: WeatherRiskItem[]
  unknownCold: string[]
  unknownHeat: string[]
  fetchedAt: string | null
  error: string | null
}

export type { Plant, PlantListItem as PlantCard }
