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
