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
    cancel(requestId: string): Promise<boolean>
    runs(limit?: number): Promise<AiRunRow[]>
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
    get(id: number): Promise<PlantListItem | null>
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
    reveal(fileName: string): Promise<boolean>
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
    get(id: number): Promise<RecipeListItem | null>
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

export type { Plant, PlantListItem as PlantCard }
