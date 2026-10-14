/**
 * IPC 注册中心。
 *
 * 统一约定：
 *  - 每个通道都返回 IpcResult<T>，**永不向渲染进程抛异常**
 *    （未捕获的 handler 异常会让 Electron 打印错误并让界面永远等下去）
 *  - 通道名统一 `域:动作`
 *  - 所有输入都在主进程重新校验：渲染进程的输入一律视为不可信
 */

import { app, dialog, ipcMain, shell } from 'electron'
import { assessPlantsWeather, clearWeatherCache } from '../services/weather'
import { getWeatherKey, setWeatherKey } from '../services/secrets'
import { qweatherLookupDetailed, readWeatherConfig, saveWeatherConfig } from '../services/weather-providers'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { Db } from '../db/connection'
import { backupsDir, dataDir, dbFilePath, getDb, imagesDir, makeManualBackup } from '../db'
import { listBackups } from '../db/backup'
import { loadFieldDefinitions } from '../db/repo/common'
import {
  createField,
  deleteField,
  fieldUsageList,
  reorderFields,
  setFieldArchived,
  updateField
} from '../db/repo/fields'
import { archiveSpecies, familyStats, getSpecies, listSpecies, saveSpecies, verifySpeciesFields } from '../db/repo/species'
import { archivePlant, getPlant, listPlants, plantStats, savePlant } from '../db/repo/plants'
import {
  addImage,
  allSettings,
  archiveEnvironment,
  deleteImage,
  getSetting,
  listEnvironments,
  listImages,
  saveEnvironment,
  setSetting
} from '../db/repo/misc'
import type { EnvironmentInput } from '../../core/types'
import {
  archiveRecipe,
  deleteMaterial,
  getRecipe,
  listMaterials,
  listRecipes,
  materialUsage,
  recipeKinds,
  recipeStats,
  restoreRecipe,
  saveMaterial,
  saveRecipe
} from '../db/repo/recipes'
import type { RecipeListOptions } from '../db/repo/recipes'
import type { MaterialInput, RecipeInput } from '../../core/types'
import {
  addCareLog,
  careOverview,
  completeCareTask,
  createCareTask,
  deleteCareLog,
  deleteCareRule,
  deleteCareTask,
  generateTasksForAll,
  generateTasksForPlant,
  getPlantPhase,
  listCareLogs,
  listCareRules,
  listCareTasks,
  reopenCareTask,
  saveCareRule,
  setPlantPhase,
  skipCareTask,
  updateCareTask
} from '../db/repo/care'
import type { CareTaskPatch, CareTaskQuery } from '../../shared/api'
import { CARE_PHASE_LABELS } from '../../core/care'
import type { CareHemisphere, CarePhase, CareRuleInput, CareTaskInput } from '../../core/types'
import {
  applyImport,
  buildExport,
  discardImport,
  previewImport
} from '../services/transfer'
import type { TransferImportOptions, TransferFormat, TransferKind } from '../../shared/api'
import type {
  AiConnectionResult,
  AiSettings,
  AiSettingsPatch,
  AppInfo,
  FieldOwner,
  IpcResult,
  NewFieldDefinition,
  FieldDefinitionPatch,
  SandboxStatus
} from '../../core/types'
import { autofillSpecies } from '../services/ai/autofill'
import { chat, DEFAULT_BASE_URL, listModels, normalizeBaseUrl, recordAiRun } from '../services/ai/client'
import { clearApiKey, getApiKey, hasApiKey, isEncryptionAvailable, isKeyPlaintext, setApiKey } from '../services/secrets'
import { importImage, removeImageFiles } from '../services/images'
import {
  createCompatShortcut,
  detectIntegrityLevel,
  getSandboxDecision,
  listCompatShortcuts,
  removeCompatShortcuts
} from '../sandbox'

const AI_SETTINGS_KEY = 'ai'

const DEFAULT_AI_SETTINGS: Omit<AiSettings, 'hasApiKey' | 'keyStoredInPlaintext'> = {
  enabled: true,
  provider: 'openai-compatible',
  baseUrl: DEFAULT_BASE_URL,
  chatModel: '',
  visionModel: '',
  timeoutMs: 60000,
  maxRetries: 2,
  temperature: 0.3
}

function readAiSettings(db: Db): AiSettings {
  const stored = getSetting<Partial<AiSettings>>(db, AI_SETTINGS_KEY, {})
  return {
    ...DEFAULT_AI_SETTINGS,
    ...stored,
    baseUrl: normalizeBaseUrl(stored.baseUrl ?? DEFAULT_AI_SETTINGS.baseUrl),
    hasApiKey: hasApiKey(),
    keyStoredInPlaintext: isKeyPlaintext()
  }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '发生未知错误'
  return { ok: false, error: message }
}

/** 包装 handler：统一 try/catch + 统一返回结构。 */
function handle<T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await (fn as (...a: unknown[]) => T | Promise<T>)(...args)
      return ok(data)
    } catch (error) {
      // 主进程控制台留完整堆栈便于排查，返回给界面的只有人话
      console.error(`[ipc] ${channel} 失败:`, error)
      return fail(error)
    }
  })
}

/** 正在进行的 AI 请求，支持用户取消。 */
const runningAi = new Map<string, AbortController>()

export function registerIpc(): void {
  registerAppIpc()
  registerSettingsIpc()
  registerFieldIpc()
  registerSpeciesIpc()
  registerPlantIpc()
  registerEnvironmentIpc()
  registerImageIpc()
  registerAiIpc()
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

function registerAppIpc(): void {
  handle<AppInfo>('app:info', () => {
    const db = getDb()
    const sandbox = getSandboxDecision()
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      sqlite: String(db.scalar<string>('SELECT sqlite_version() AS v') ?? ''),
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dbPath: dbFilePath(),
      sandboxDisabled: sandbox.disabled,
      sandboxReason: sandbox.reason,
      integrityLevel: detectIntegrityLevel()
    }
  })

  // ---- 沙箱兜底 ----
  // 受限环境（低完整性进程等）下 Chromium 沙箱无法初始化，普通双击会直接崩溃，
  // 且应用内无法自救（沙箱初始化早于主进程 JS，已实测确认）。
  // 所以这里提供的是「创建带 --no-sandbox 的原生快捷方式」，让用户双击一个图标即可。
  handle<SandboxStatus>('sandbox:status', () => ({
    disabled: getSandboxDecision().disabled,
    reason: getSandboxDecision().reason,
    integrityLevel: detectIntegrityLevel(),
    canCreateShortcut: process.platform === 'win32',
    shortcuts: listCompatShortcuts()
  }))

  handle('sandbox:createShortcut', (scope: 'desktop' | 'startMenu' = 'desktop') => {
    const created = createCompatShortcut(scope)
    return { created, shortcuts: listCompatShortcuts() }
  })

  handle('sandbox:removeShortcuts', () => ({
    removed: removeCompatShortcuts(),
    shortcuts: listCompatShortcuts()
  }))

  handle('app:openDataDir', async () => {
    await shell.openPath(dataDir())
    return true
  })

  handle('app:openImagesDir', async () => {
    await shell.openPath(imagesDir())
    return true
  })

  handle('app:backups', () => listBackups(backupsDir()))

  handle('app:backupNow', () => makeManualBackup())

  handle('app:paths', () => ({
    userData: app.getPath('userData'),
    data: dataDir(),
    images: imagesDir(),
    backups: backupsDir(),
    db: dbFilePath(),
    encryptionAvailable: isEncryptionAvailable()
  }))
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function registerSettingsIpc(): void {
  handle<AiSettings>('settings:getAi', () => readAiSettings(getDb()))

  handle<AiSettings>('settings:setAi', (patch: AiSettingsPatch) => {
    const db = getDb()
    const current = readAiSettings(db)
    const next = { ...current, ...patch }
    delete (next as Record<string, unknown>).apiKey
    delete (next as Record<string, unknown>).hasApiKey
    delete (next as Record<string, unknown>).keyStoredInPlaintext

    setSetting(db, AI_SETTINGS_KEY, {
      enabled: next.enabled,
      provider: next.provider,
      baseUrl: normalizeBaseUrl(next.baseUrl),
      chatModel: next.chatModel,
      visionModel: next.visionModel,
      timeoutMs: next.timeoutMs,
      maxRetries: next.maxRetries,
      temperature: next.temperature
    })

    if (patch.apiKey !== undefined) {
      const result = setApiKey(patch.apiKey)
      if (result.warning) {
        // 通过设置值回传给界面展示，避免静默降级
        setSetting(db, 'ai.keyWarning', result.warning)
      } else {
        setSetting(db, 'ai.keyWarning', null)
      }
    }

    return readAiSettings(db)
  })

  handle('settings:clearApiKey', () => {
    clearApiKey()
    return readAiSettings(getDb())
  })

  handle<string | null>('settings:keyWarning', () => getSetting<string | null>(getDb(), 'ai.keyWarning', null))

  handle<AiConnectionResult>('settings:testAi', async () => {
    const db = getDb()
    const settings = readAiSettings(db)
    const apiKey = getApiKey()
    const started = Date.now()

    if (!apiKey) {
      return { ok: false, message: '尚未填写 API Key', latencyMs: 0 }
    }

    // 先试 /models（更省 token），不支持时退化为一次极短的对话补全
    const models = await listModels(settings.baseUrl, apiKey, Math.min(settings.timeoutMs, 20000))
    if (models.ok) {
      return {
        ok: true,
        message: `连接成功，服务端返回 ${models.models.length} 个模型。`,
        models: models.models.slice(0, 200),
        latencyMs: Date.now() - started
      }
    }

    if (!settings.chatModel) {
      return {
        ok: false,
        message: `无法列出模型（${models.error ?? '未知原因'}），且未填写对话模型，无法进一步测试。`,
        latencyMs: Date.now() - started
      }
    }

    const outcome = await chat({
      baseUrl: settings.baseUrl,
      apiKey,
      model: settings.chatModel,
      messages: [
        { role: 'system', content: '你是一个测试端点。只回复 OK。' },
        { role: 'user', content: 'ping' }
      ],
      timeoutMs: Math.min(settings.timeoutMs, 20000),
      maxRetries: 0
    })

    recordAiRun(db, {
      kind: 'test_connection',
      baseUrl: settings.baseUrl,
      model: settings.chatModel,
      promptVersion: null,
      input: { via: 'chat' },
      output: outcome.ok ? outcome.content : null,
      status: outcome.ok ? 'ok' : 'error',
      error: outcome.error ?? null,
      usage: outcome.usage,
      durationMs: outcome.durationMs
    })

    return {
      ok: outcome.ok,
      message: outcome.ok ? '连接成功。' : `连接失败：${outcome.error ?? '未知错误'}`,
      latencyMs: Date.now() - started
    }
  })
}

// ---------------------------------------------------------------------------
// 模板字段
// ---------------------------------------------------------------------------

function registerFieldIpc(): void {
  handle('fields:list', (ownerKind: FieldOwner, includeArchived = false) =>
    loadFieldDefinitions(getDb(), ownerKind, Boolean(includeArchived))
  )

  handle('fields:create', (input: NewFieldDefinition) => createField(getDb(), input))

  handle('fields:update', (id: number, patch: FieldDefinitionPatch) => updateField(getDb(), id, patch))

  handle('fields:setArchived', (id: number, archived: boolean) => setFieldArchived(getDb(), id, archived))

  handle('fields:delete', (id: number) => deleteField(getDb(), id))

  handle('fields:usage', (ownerKind: FieldOwner) => fieldUsageList(getDb(), ownerKind))

  handle('fields:reorder', (ownerKind: FieldOwner, orderedIds: number[]) => {
    reorderFields(getDb(), ownerKind, orderedIds)
    return true
  })
}

// ---------------------------------------------------------------------------
// 物种
// ---------------------------------------------------------------------------

function registerSpeciesIpc(): void {
  handle('species:list', (options: Parameters<typeof listSpecies>[1]) => listSpecies(getDb(), options ?? {}))

  handle('species:get', (id: number) => getSpecies(getDb(), id))

  handle(
    'species:save',
    (payload: {
      id?: number
      values: Record<string, unknown>
      origin?: 'manual' | 'ai'
      aiFields?: Array<{ key: string; confidence: number }>
    }) =>
      saveSpecies(
        getDb(),
        { id: payload.id, values: payload.values, aiFields: payload.aiFields },
        payload.origin ?? 'manual'
      )
  )

  handle('species:verify', (id: number, fieldKeys: string[], verified = true) =>
    verifySpeciesFields(getDb(), id, fieldKeys, verified !== false)
  )

  handle('species:delete', (id: number) => archiveSpecies(getDb(), id))

  handle('species:families', () => familyStats(getDb()))
}

// ---------------------------------------------------------------------------
// 植株
// ---------------------------------------------------------------------------

function registerPlantIpc(): void {
  handle('plants:list', (options: Parameters<typeof listPlants>[1]) => listPlants(getDb(), options ?? {}))

  handle('plants:get', (id: number) => getPlant(getDb(), id))

  handle('plants:save', (payload: Parameters<typeof savePlant>[1]) => savePlant(getDb(), payload))

  handle('plants:delete', (id: number) => archivePlant(getDb(), id))

  handle('plants:stats', (month?: number) => plantStats(getDb(), month))
}

// ---------------------------------------------------------------------------
// 环境档案
// ---------------------------------------------------------------------------

function registerEnvironmentIpc(): void {
  handle('env:list', (includeArchived = false) => listEnvironments(getDb(), Boolean(includeArchived)))

  handle('env:save', (input: EnvironmentInput) => saveEnvironment(getDb(), input))

  handle('env:delete', (id: number) => archiveEnvironment(getDb(), id))
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

function registerImageIpc(): void {
  handle('images:list', (owner: { plantId?: number; speciesId?: number }) => listImages(getDb(), owner))

  handle('images:pick', async (owner: { plantId?: number; speciesId?: number }) => {
    const result = await dialog.showOpenDialog({
      title: '选择植物图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { imported: [], canceled: true }

    const imported = []
    const failures: string[] = []
    for (const filePath of result.filePaths) {
      try {
        const file = importImage(filePath)
        const record = addImage(getDb(), {
          plantId: owner.plantId ?? null,
          speciesId: owner.speciesId ?? null,
          path: file.fileName,
          thumbPath: file.thumbName
        })
        imported.push(record)
      } catch (error) {
        failures.push(`${filePath}：${error instanceof Error ? error.message : '导入失败'}`)
      }
    }
    return { imported, canceled: false, failures }
  })

  // -------------------------------------------------------------------------
  // 养护计划
  // -------------------------------------------------------------------------

  /*
   * 天气预警。
   *
   * 这是应用里第一个网络功能，所以刻意做成**拉取式**而不是后台轮询：
   * 界面打开养护计划页时才问一次，其余时间一个请求都不发。
   * 而且 assessPlantsWeather 在没有养护位置填城市时会直接返回，
   * 不填城市 = 完全离线，不是「降级」而是等价的选择。
   */
  handle('weather:assess', (force?: boolean) =>
    // key 在 IPC 这一层从钥匙串取 —— 服务层不碰 Electron API
    assessPlantsWeather(getDb(), force === true, getWeatherKey())
  )
  /** 给界面的配置快照 —— **绝不包含 key 本身**，只说配没配 */
  function weatherConfigSnapshot(db: ReturnType<typeof getDb>, key: string | null) {
    const config = readWeatherConfig(db, key)
    return {
      provider: config.provider,
      qweatherHost: config.qweatherHost,
      hasWeatherKey: (key ?? '') !== '',
      qweatherReady: config.qweatherReady,
      activeLabel:
        config.provider === 'qweather' && config.qweatherReady
          ? '和风天气（可精确到区县）'
          : config.provider === 'qweather'
            ? 'Open-Meteo（和风配置不完整，暂时退回）'
            : 'Open-Meteo（免注册）'
    }
  }

  handle('weather:config', () => weatherConfigSnapshot(getDb(), getWeatherKey()))
  handle('weather:saveConfig', (patch: { provider?: 'open-meteo' | 'qweather'; qweatherHost?: string; qweatherKey?: string }) => {
    const db = getDb()
    /*
     * key 单独走钥匙串。传空串＝清掉，传 undefined＝不动 ——
     * 界面上「改了 Host 但没重填 key」是常见操作，不能顺手把 key 抹了。
     */
    if (patch.qweatherKey !== undefined) setWeatherKey(patch.qweatherKey)
    saveWeatherConfig(db, { provider: patch.provider, qweatherHost: patch.qweatherHost })
    return weatherConfigSnapshot(db, getWeatherKey())
  })
  handle('weather:testLocation', async (name: string) => {
    const db = getDb()
    const config = readWeatherConfig(db, getWeatherKey())
    /*
     * 只在和风的域里查，不走兜底 —— 这是「验证配置」而不是「取天气」。
     *
     * 失败原因**原样透出去**：403 要去查 key 和 Host，404 才是地名的问题，
     * 连不上又是另一回事。第一版把它们都吞成「查不到这个地名」，
     * 用户会去改完全无关的地方。
     */
    const outcome = await qweatherLookupDetailed(config, { city: name })
    if (!outcome.geo) {
      return { ok: false, error: outcome.error ?? '查询失败', code: outcome.code }
    }
    return { ok: true, label: outcome.geo.label, level: outcome.geo.level }
  })
  handle('weather:clearCache', () => {
    clearWeatherCache(getDb())
    return true
  })

  handle('care:rules', (options?: { speciesKey?: string; hemisphere?: CareHemisphere }) =>
    listCareRules(getDb(), options ?? {})
  )
  handle('care:rule.save', (input: CareRuleInput) => saveCareRule(getDb(), input))
  handle('care:rule.delete', (id: number) => deleteCareRule(getDb(), id))

  handle('care:tasks', (query?: CareTaskQuery) => listCareTasks(getDb(), query ?? {}))
  handle('care:task.create', (input: CareTaskInput) => createCareTask(getDb(), input))
  handle('care:task.update', (id: number, patch: CareTaskPatch) => updateCareTask(getDb(), id, patch))
  handle('care:task.complete', (id: number, note?: string | null, date?: string) =>
    completeCareTask(getDb(), id, note, date)
  )
  handle('care:task.skip', (id: number, reason?: string | null) => skipCareTask(getDb(), id, reason))
  handle('care:task.reopen', (id: number) => reopenCareTask(getDb(), id))
  handle('care:task.delete', (id: number) => deleteCareTask(getDb(), id))

  handle('care:generate', (plantId: number, year: number) => generateTasksForPlant(getDb(), plantId, year))
  handle('care:generateAll', (year: number) => generateTasksForAll(getDb(), year))
  handle('care:overview', (year: number) => careOverview(getDb(), year))

  // 物候阶段：切换会立刻改变任务生成结果，也会写一条养护日志
  handle('care:plantPhase', (plantId: number) => getPlantPhase(getDb(), plantId))
  handle('care:setPlantPhase', (plantId: number, phase: CarePhase | null, note?: string | null) =>
    setPlantPhase(getDb(), plantId, phase, note)
  )
  handle('care:phases', () => Object.keys(CARE_PHASE_LABELS) as CarePhase[])

  handle('care:logs', (plantId?: number, limit?: number) => listCareLogs(getDb(), { plantId, limit }))
  handle('care:log.add', (input: Parameters<typeof addCareLog>[1]) => addCareLog(getDb(), input))
  handle('care:log.delete', (id: number) => deleteCareLog(getDb(), id))

  // -------------------------------------------------------------------------
  // 材料与配方
  // -------------------------------------------------------------------------

  handle('materials:list', (query?: string) => listMaterials(getDb(), query))
  handle('materials:save', (input: MaterialInput) => saveMaterial(getDb(), input))
  handle('materials:delete', (id: number) => deleteMaterial(getDb(), id))
  handle('materials:usage', (id: number) => materialUsage(getDb(), id))

  handle('recipes:list', (options?: RecipeListOptions) => listRecipes(getDb(), options ?? {}))
  handle('recipes:get', (id: number) => getRecipe(getDb(), id))
  handle('recipes:save', (input: RecipeInput) => saveRecipe(getDb(), input))
  handle('recipes:archive', (id: number) => archiveRecipe(getDb(), id))
  handle('recipes:restore', (id: number) => restoreRecipe(getDb(), id))
  handle('recipes:kinds', () => recipeKinds(getDb()))
  handle('recipes:stats', () => recipeStats(getDb()))

  // -------------------------------------------------------------------------
  // 导入导出
  // -------------------------------------------------------------------------

  handle('transfer:export', async (kind: TransferKind, format: TransferFormat) => {
    const built = buildExport(getDb(), kind, format)
    const result = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: built.suggestedName,
      filters:
        format === 'csv'
          ? [{ name: 'CSV 表格', extensions: ['csv'] }]
          : [{ name: 'JSON 数据', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0, path: null }
    writeFileSync(result.filePath, built.content, 'utf8')
    return { canceled: false, count: built.count, path: result.filePath }
  })

  handle('transfer:previewImport', async (kind: TransferKind) => {    const result = await dialog.showOpenDialog({
      title: '选择要导入的文件',
      properties: ['openFile'],
      filters: [{ name: '数据文件', extensions: ['csv', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return previewImport(getDb(), kind, result.filePaths[0])
  })

  handle('transfer:applyImport', (token: string, options: TransferImportOptions) =>
    applyImport(getDb(), token, options)
  )

  handle('transfer:discardImport', (token: string) => {
    discardImport(token)
    return true
  })

  handle('images:delete', (id: number) => {
    const record = deleteImage(getDb(), id)
    if (record) removeImageFiles([record.path, record.thumbPath])
    return record
  })

  handle('images:reveal', async (fileName: string) => {
    await shell.openPath(join(imagesDir(), fileName))
    return true
  })
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function registerAiIpc(): void {
  handle('ai:autofill', async (payload: { requestId: string; plantName: string; hints?: string; existing?: Record<string, never> }) => {
    const db = getDb()
    const settings = readAiSettings(db)
    const apiKey = getApiKey()

    if (!apiKey) {
      return {
        ok: false,
        message: '尚未配置 API Key。请到「设置 → AI」填写后再试。',
        speciesName: payload.plantName,
        drafts: [],
        model: null,
        raw: null
      }
    }
    if (!settings.chatModel) {
      return {
        ok: false,
        message: '尚未配置对话模型。请到「设置 → AI」填写模型名（如 deepseek-chat）。',
        speciesName: payload.plantName,
        drafts: [],
        model: null,
        raw: null
      }
    }

    const controller = new AbortController()
    runningAi.set(payload.requestId, controller)
    try {
      return await autofillSpecies({
        db,
        baseUrl: settings.baseUrl,
        apiKey,
        model: settings.chatModel,
        temperature: settings.temperature,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
        plantName: payload.plantName,
        hints: payload.hints,
        fields: loadFieldDefinitions(db, 'species', false),
        existing: (payload.existing ?? {}) as never,
        signal: controller.signal
      })
    } finally {
      runningAi.delete(payload.requestId)
    }
  })

  handle('ai:cancel', (requestId: string) => {
    const controller = runningAi.get(requestId)
    if (!controller) return false
    controller.abort()
    runningAi.delete(requestId)
    return true
  })

  handle('ai:runs', (limit = 50) =>
    getDb().all(
      `SELECT id, kind, model, status, error, prompt_tokens, completion_tokens, duration_ms, created_at
       FROM ai_runs ORDER BY id DESC LIMIT ?`,
      Math.min(Math.max(limit, 1), 200)
    )
  )

  handle('ai:settingsSnapshot', () => {
    const db = getDb()
    const s = readAiSettings(db)
    // 明确不返回密钥
    return { ...s, apiKey: undefined, allSettings: Object.keys(allSettings(db)) }
  })
}
