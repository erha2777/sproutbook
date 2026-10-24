/**
 * 渲染进程可用的 API 契约。
 *
 * preload 负责实现，renderer 只依赖这个接口 —— 这样两端永远不会因为通道名写错而静默失败：
 * 名字写错在编译期就会报错。
 */

import type { MusicMode, MusicSeason } from '../core/music'
import type { CareGuideTemplate } from '../core/careGuide'
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
  /** 全部未归档（含枯死） */
  total: number
  /** 在养：未归档且不是「已枯死」 */
  alive: number
  byStatus: Array<{ status: string; count: number }>
  byEnv: Array<{ envId: number | null; envName: string; count: number }>
  byFamily: Array<{ family: string; count: number }>
  bloomingThisMonth: number
  /** 购入价格合计（只统计填了价格的植株） */
  totalPrice: number
  /** 填了价格的植株数，用来提示「还有几株没记价格」 */
  pricedCount: number
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

/** 「网上找图」的一条候选：原图地址 + 可直接显示的缩略图（data URL） */
export interface WebImageCandidate {
  url: string
  thumb: string
  title: string | null
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
  /** 无边框窗口：自定义标题栏的按钮（最小化 / 最大化 / 关闭） */
  win: {
    minimize(): Promise<boolean>
    toggleMaximize(): Promise<boolean>
    close(): Promise<boolean>
  }
  app: {
    info(): Promise<AppInfo>
    paths(): Promise<AppPaths>
    backups(): Promise<BackupInfo[]>
    backupNow(): Promise<BackupInfo | null>
    openDataDir(): Promise<boolean>
    openImagesDir(): Promise<boolean>
    /** 打开音乐 / 背景图 / 素材总目录（不存在会先建） */
    openMediaDir(kind: 'music' | 'backgrounds' | 'root'): Promise<boolean>
    /** 退出应用（首页的「退出」按钮） */
    quit(): Promise<boolean>
    /** 私有字体：<userData>/fonts 里放了字体就返回 data URL（不打包进仓库） */
    fonts(): Promise<{ custom: string | null }>
    /**
     * 私有背景音乐：<userData>/textures/music 下的音频。
     * 按季节分子目录的，season 就是那一季；顶层曲子 season 为 null。
     */
    music(): Promise<Array<{ name: string; file: string; season: MusicSeason | null; url: string }>>
    /**
     * 弹文件对话框添加音乐，复制进自选目录（没选就是数据目录）。
     * season 传 'spring' 这类就落进对应季节子文件夹，和曲库的目录结构保持一致。
     */
    importMusic(season?: string | null): Promise<{
      canceled: boolean
      tracks: Array<{ name: string; file: string; season: MusicSeason | null; url: string }>
    }>
    /** 删掉一首（参数是相对曲库的路径），返回剩余列表 */
    removeMusic(file: string): Promise<
      Array<{ name: string; file: string; season: MusicSeason | null; url: string }>
    >
    /** 音乐目录：custom 为 null 表示用默认的数据目录 */
    musicDir(): Promise<{ custom: string | null; upload: string; dirs: string[] }>
    /** 选一个目录当曲库；取消时 canceled = true */
    pickMusicDir(): Promise<{ canceled: boolean; custom: string | null; upload: string; dirs: string[] }>
    /** 恢复默认目录（数据目录下的 textures/music） */
    resetMusicDir(): Promise<{ custom: string | null; upload: string; dirs: string[] }>
    /** 用户自己放的背景图（<userData>/textures/backgrounds，已缩到 1600 内的 data URL） */
    backdrops(): Promise<Array<{ name: string; url: string }>>
    /** 单独取某一张背景（列表里没有时兜底） */
    backdropUrl(name: string): Promise<string | null>
    importBackdrops(): Promise<{ canceled: boolean; backdrops: Array<{ name: string; url: string }> }>
    removeBackdrop(name: string): Promise<Array<{ name: string; url: string }>>
    /** 选中的曲目 / 背景 / 播放模式 / 音量 */
    mediaPrefs(): Promise<{
      musicTrack: string | null
      backdrop: string | null
      musicMode: MusicMode
      musicVolume: number
    }>
    setMediaPrefs(patch: {
      musicTrack?: string | null
      backdrop?: string | null
      musicMode?: MusicMode
      musicVolume?: number
    }): Promise<{
      musicTrack: string | null
      backdrop: string | null
      musicMode: MusicMode
      musicVolume: number
    }>
    /**
     * 私有素材：<userData>/textures 下的图片。
     * slots: home-bg / sign / button / panel / cloud
     * backgrounds: 其余图片，首页背景里缓慢飘动
     */
    textures(): Promise<{
      slots: Record<string, string>
      /** 九宫格边距（theme.json 里的 slice）：单值或 [上, 右, 下, 左] */
      slices: Record<string, number | [number, number, number, number]>
      backgrounds: string[]
      /** 图标覆盖：textures/icons/<name>.png，名字对应 PixelIcon 的 name */
      icons: Record<string, string>
    }>
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
    /**
     * 拿一株的完整档案问问题。只读不写：不产生待确认字段，不改任何数据。
     * requestId 用于取消；失败时 message 是给人看的原因。
     */
    askPlant(payload: {
      requestId: string
      plantId: number
      question: string
      /** 要一起发给模型的照片（植株相册 / 养护记录里的）；最多 8 张 */
      imageIds?: number[]
    }): Promise<{
      ok: boolean
      answer: string
      model: string | null
      message: string | null
    }>
    /**
     * 生成全年养护指南（按月分节，每条可解析成一条任务）。
     * 只生成、不保存 —— 界面先给用户看和改，确认后由保存植株写字段。
     */
    careGuide(payload: { requestId: string; plantId: number }): Promise<{
      ok: boolean
      text: string
      model: string | null
      message: string | null
      /** 解析出的条目数，0 表示 AI 没按格式写（仍可保存，但加不进计划） */
      itemCount?: number
    }>
    cancel(requestId: string): Promise<boolean>
  }
  /** 全年养护指南的格式模板 */
  careGuide: {
    templates(): Promise<{ templates: CareGuideTemplate[]; activeId: string }>
    saveTemplates(templates: CareGuideTemplate[]): Promise<{ templates: CareGuideTemplate[]; activeId: string }>
    setActive(id: string): Promise<{ templates: CareGuideTemplate[]; activeId: string }>
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
      /** 分类筛选：'' = 未分类 */
      category?: string
      /** 隐藏「已枯死」（列表默认隐藏，想看再打开） */
      hideDead?: boolean
      /** 最近改动 / 入手时间 / 购入价格 */
      sort?: 'updated' | 'acquired' | 'price'
      limit?: number
      offset?: number
    }): Promise<{ items: PlantListItem[]; total: number }>
    /** 现有分类（去重、去空），给筛选下拉用 */
    categories(): Promise<string[]>
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
    /** 指定封面用哪张照片；传 null 回到默认（最早导入的那张） */
    setCover(plantId: number, imageId: number | null): Promise<boolean>
  }
  env: {
    list(includeArchived?: boolean): Promise<Environment[]>
    save(input: EnvironmentInput): Promise<Environment>
    remove(id: number): Promise<boolean>
  }
  images: {
    list(owner: { plantId?: number; speciesId?: number; environmentId?: number }): Promise<ImageRecord[]>
    pick(owner: { plantId?: number; speciesId?: number; environmentId?: number }): Promise<ImportResponse>
    /** 从图片地址下载并导入（用户粘贴浏览器里看到的图片链接） */
    importUrl(
      owner: { plantId?: number; speciesId?: number; environmentId?: number },
      url: string
    ): Promise<ImageRecord>
    /** 用必应图片搜索找候选图（缩略图是 data URL，受 CSP 限制） */
    search(query: string): Promise<WebImageCandidate[]>
    /** 把物种图片复制一份给植株（复制文件，删一边不影响另一边） */
    remove(id: number): Promise<ImageRecord | null>
  }
  materials: {
    list(query?: string): Promise<Material[]>
    save(input: MaterialInput): Promise<Material>
    /** 被配方引用的物品会被拒绝删除并抛出人话错误 */
    remove(id: number): Promise<boolean>
    /** 有多少个配方在用这个物品 */
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
    /** 完成时会自动写一条养护日志；imageIds 会挂到那条日志上 */
    completeTask(id: number, note?: string | null, date?: string, imageIds?: number[]): Promise<CareTask | null>
    skipTask(id: number, reason?: string | null): Promise<CareTask | null>
    /** 撤销完成 / 跳过，并删掉对应日志 */
    reopenTask(id: number): Promise<CareTask | null>
    removeTask(id: number): Promise<boolean>
    /**
     * 批量清理某段日期范围内的**待办**任务（按年或按月）。
     * 误生成整年计划时的唯一出口 —— 135 条没法一条条删。
     */
    purgeTasks(input: { from: string; to: string; plantId?: number }): Promise<CareTaskPurgeResult>

    /** 生成是幂等的：签名相同的任务原样保留，已完成的一律不动 */
    generate(plantId: number, year: number): Promise<CareGenerateResult>
    generateAll(year: number): Promise<CareGenerateResult>
    /**
     * 把「全年养护指南」里解析出来的事项加进养护计划。
     * 同一天 + 同标题的跳过，所以重复点不会排两遍。
     */
    planFromGuide(
      plantId: number,
      year?: number
    ): Promise<{ created: number; skipped: number; total: number }>
    overview(year: number): Promise<CareOverview>

    /**
     * 把某一株的**全年**养护计划导出成独立 HTML（弹保存对话框）。
     * `canceled` 表示用户取消了保存。
     */
    exportPlanHtml(plantId: number, year: number): Promise<CarePlanExportResult>

    /** 这一株当年有没有计划（有没有任务 / 计划行） */
    hasPlan(plantId: number, year: number): Promise<boolean>

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
      /** 先从 images.pick 导入，再把 id 传进来；保存时挂到这条日志上 */
      imageIds?: number[]
    }): Promise<CareLog>
    /**
     * 改一条已有的记录：正文 / 类型 / 日期，以及照片的增删。
     *
     * 照片分两个方向：`addImageIds` 是先用 images.pick 导入的新图，
     * `removeImageIds` 是要摘掉的旧图（文件由主进程一并删除）。
      removeLog(id: number): Promise<boolean>
      /** 批量删除（日志页多选）；返回真正删掉的条数 */
      removeLogs(ids: number[]): Promise<number>
    updateLog(id: number, patch: CareLogPatch): Promise<CareLog | null>
    removeLog(id: number): Promise<boolean>
  }
}

export interface CareLogPatch {
  content?: string | null
  kind?: string
  /** YYYY-MM-DD */
  logDate?: string
  addImageIds?: number[]
  removeImageIds?: number[]
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
  /** YYYY-MM-DD，含（按**计划日期** due_date 筛） */
  from?: string
  /** YYYY-MM-DD，含（按**计划日期** due_date 筛） */
  to?: string
  /**
   * 按**完成时间**筛（ISO 时间点，含）。
   *
   * 和 from/to 不是一个维度：from/to 筛的是 `due_date`（计划日期），
   * 而「今天做完的」要的是完成时间 —— 一条 10 月 1 日到期、今天才补做的任务，
   * 用 due_date ± 7 天永远找不到，切换页面后它就从列表里消失了。
   */
  completedFrom?: string
  /** 完成时间上界（不含） */
  completedTo?: string
  /** 'open' = 只要待办 */
  status?: CareTaskStatus | 'open'
  actionType?: CareActionType
  limit?: number
}

/**
 * 批量清理计划任务。
 *
 * 存在的理由：生成计划是**按年**的，误点一下就排出整年 ——
 * 用户不小心生成了明年的计划之后，只能一条一条删，135 条根本删不动。
 *
 * 三种状态都能删（用户要求「已完成已跳过的也可以删除」），
 * 所以要把各状态**分开计数**，界面才能在确认前把「删掉几条待办、
 * 几条已完成」摆到明面上 —— 删掉做过的记录是不可逆的，
 * 不能只给一个总数让人按下去。
 */
export interface CareTaskPurgeResult {
  deleted: number
  /** 按状态分：删掉了几条 */
  byStatus: Record<CareTaskStatus, number>
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

export interface CarePlanExportResult {
  canceled: boolean
  /** 保存路径；用户取消时为 null */
  path: string | null
  /** 这份计划里的任务条数 */
  count: number
}
