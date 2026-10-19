/**
 * IPC 注册中心。
 *
 * 统一约定：
 *  - 每个通道都返回 IpcResult<T>，**永不向渲染进程抛异常**
 *    （未捕获的 handler 异常会让 Electron 打印错误并让界面永远等下去）
 *  - 通道名统一 `域:动作`
 *  - 所有输入都在主进程重新校验：渲染进程的输入一律视为不可信
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { logStartup } from '../startupLog'
import { buildCarePlanHtml } from '../../core/carePlanHtml'
import { assessPlantsWeather, clearWeatherCache } from '../services/weather'
import { getWeatherKey, setWeatherKey } from '../services/secrets'
import { qweatherLookupDetailed, readWeatherConfig, saveWeatherConfig } from '../services/weather-providers'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, normalize, resolve } from 'node:path'
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
import { archivePlant, getPlant, listPlants, plantStats, savePlant, setPlantCover } from '../db/repo/plants'
import {
  addImage,
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
  listLogImages,
  deleteCareRule,
  deleteCareTask,
  purgeCareTasks,
  generateTasksForAll,
  generateTasksForPlant,
  getPlantPhase,
  listCareLogs,
  listCareRules,
  listCareTasks,
  reopenCareTask,
  saveCareRule,
  setPlantPhase,
  hasCarePlan,
  skipCareTask,
  updateCareLog,
  updateCareTask
} from '../db/repo/care'
import type { CareLogPatch, CareTaskPatch, CareTaskQuery } from '../../shared/api'
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
import { identifyPlant } from '../services/ai/identify'
import { chat, DEFAULT_BASE_URL, listModels, normalizeBaseUrl, recordAiRun } from '../services/ai/client'
import { clearApiKey, getApiKey, hasApiKey, isEncryptionAvailable, isKeyPlaintext, setApiKey } from '../services/secrets'
import { importImage, importImageFromUrl, removeImageFiles, searchWebImages } from '../services/images'
import { listMusic } from '../services/music'
import { EMPTY_MEDIA_PREFS, MEDIA_KEY, backdropsDir, listBackdrops, type MediaPrefs } from '../services/media'
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

  /*
   * 私有字体：放在 <userData>/fonts/ 下的 woff2/ttf/otf 会被加载成界面字体。
   *
   * 为什么走运行时而不是打包进 assets：
   * - 某些像素字体（如 HZK / IPix 系）字模版权不清晰，不能进公开仓库；
   * - 放 userData 后，只有本机装了字体的人才用得上，仓库和 CI 都不受影响。
   */
  handle('app:fonts', () => {
    const dir = join(app.getPath('userData'), 'fonts')
    if (!existsSync(dir)) return { custom: null }
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => /\.(woff2|woff|ttf|otf)$/i.test(n))
    } catch {
      return { custom: null }
    }
    if (names.length === 0) return { custom: null }
    const file = join(dir, names.sort()[0])
    try {
      const stat = statSync(file)
      if (stat.size > 12 * 1024 * 1024) return { custom: null }
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
      const mime =
        ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'ttf' ? 'font/ttf' : 'font/otf'
      const base64 = readFileSync(file).toString('base64')
      return { custom: `data:${mime};base64,${base64}` }
    } catch {
      return { custom: null }
    }
  })

  /*
   * 私有素材：<userData>/textures/ 下的图片按文件名当皮肤用（不进仓库）。
   *
   * 支持的槽位（png / jpg / webp）：
   *   home-bg  首页整屏背景
   *   sign     首页木牌（含标题的整张图）
   *   button   首页按钮底图
   *   panel    所有木色面板的底图
   *   cloud    云的贴图
   *
   * 为什么走运行时：星露谷 wiki 上的图是版权素材，不能随仓库/安装包分发；
   * 用户自己拿到的图放本地即可替换外观。
   */
  /*
   * 私有素材：<userData>/textures（开发期加上 appPath/textures）。
   *
   * 两种用法：
   *  1) theme.json —— 支持子目录、裁切(crop) 和九宫格边距(slice)，适合素材包；
   *  2) 约定文件名(legacy) —— sign/home-bg/button/panel/cloud + 其余图片当巡视背景。
   *
   * 为什么走运行时：商业游戏的图是版权素材，不能随仓库/安装包分发。
   */
  handle('app:textures', () => {
    const dirs = [join(app.getPath('userData'), 'textures')]
    if (!app.isPackaged) dirs.push(join(app.getAppPath(), 'textures'))
    const slots: Record<string, string> = {}
    const slices: Record<string, number | [number, number, number, number]> = {}
    const backgrounds: string[] = []
    const exts = ['png', 'jpg', 'jpeg', 'webp']
    const seen = new Set<string>()

    const mimeOf = (file: string): string => {
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
      return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    }
    const readAsUrl = (file: string): string | null => {
      try {
        if (statSync(file).size > 24 * 1024 * 1024) return null
        return `data:${mimeOf(file)};base64,${readFileSync(file).toString('base64')}`
      } catch {
        return null
      }
    }

    /** 把任意图片（可裁切）转成 data URL；裁切时统一转 PNG 保留透明 */
    const loadSlotImage = (dir: string, entry: { file: string; crop?: { x: number; y: number; w: number; h: number } }): string | null => {
      const file = resolve(normalize(join(dir, entry.file)))
      if (!file.startsWith(resolve(dir))) return null
      if (!existsSync(file)) return null
      if (!entry.crop) return readAsUrl(file)
      try {
        const img = nativeImage.createFromPath(file)
        if (img.isEmpty()) return null
        const { x, y, w, h } = entry.crop
        const size = img.getSize()
        const rect = {
          x: Math.max(0, Math.min(x, size.width - 1)),
          y: Math.max(0, Math.min(y, size.height - 1)),
          width: Math.max(1, Math.min(w, size.width)),
          height: Math.max(1, Math.min(h, size.height))
        }
        const png = img.crop(rect).toPNG().toString('base64')
        return `data:image/png;base64,${png}`
      } catch {
        return null
      }
    }

    /*
     * 图标覆盖：<dir>/icons/<name>.png → 前端 PixelIcon 按 name 取图。
     * 没放同名文件就继续用画出来的默认图标。
     */
    const icons: Record<string, string> = {}
    for (const dir of dirs) {
      const iconDir = join(dir, 'icons')
      if (!existsSync(iconDir)) continue
      let names: string[] = []
      try {
        names = readdirSync(iconDir).sort()
      } catch {
        names = []
      }
      for (const name of names) {
        const dot = name.lastIndexOf('.')
        if (dot <= 0) continue
        if (!exts.includes(name.slice(dot + 1).toLowerCase())) continue
        const key = name.slice(0, dot)
        if (icons[key]) continue
        const url = readAsUrl(join(iconDir, name))
        if (url) icons[key] = url
      }
    }

    interface ThemeEntry {
      file: string
      crop?: { x: number; y: number; w: number; h: number }
      /** 九宫格边距：一个数（四边相同）或 [上, 右, 下, 左] */
      slice?: number | [number, number, number, number]
    }
    interface ThemeFile {
      slots?: Record<string, ThemeEntry>
      backgrounds?: string[]
    }

    // 1) theme.json（先找到的目录优先）
    for (const dir of dirs) {
      const themePath = join(dir, 'theme.json')
      if (!existsSync(themePath)) continue
      let theme: ThemeFile
      try {
        theme = JSON.parse(readFileSync(themePath, 'utf-8')) as ThemeFile
      } catch {
        continue
      }
      for (const [slot, entry] of Object.entries(theme.slots ?? {})) {
        if (!entry || typeof entry.file !== 'string') continue
        const url = loadSlotImage(dir, entry)
        if (url) slots[slot] = url
        if (typeof entry.slice === 'number' && entry.slice > 0) {
          slices[slot] = entry.slice
        } else if (Array.isArray(entry.slice) && entry.slice.length === 4 && entry.slice.every((v) => typeof v === 'number' && v > 0)) {
          slices[slot] = entry.slice as [number, number, number, number]
        }
      }
      for (const rel of theme.backgrounds ?? []) {
        if (backgrounds.length >= 8) break
        const file = resolve(normalize(join(dir, rel)))
        if (!file.startsWith(resolve(dir)) || !existsSync(file)) continue
        if (seen.has(file)) continue
        const url = readAsUrl(file)
        if (!url) continue
        seen.add(file)
        backgrounds.push(url)
      }
      logStartup('皮肤 theme.json', { dir, slots: Object.keys(slots), slices })
      return { slots, slices, backgrounds, icons }
    }

    // 2) 没有 theme.json：约定文件名
    const legacySlots = ['home-bg', 'sign', 'button', 'panel', 'cloud']
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const slot of legacySlots) {
        if (slots[slot]) continue
        for (const ext of exts) {
          const file = join(dir, `${slot}.${ext}`)
          if (!existsSync(file)) continue
          const url = readAsUrl(file)
          if (url) slots[slot] = url
          break
        }
      }
      let names: string[] = []
      try {
        names = readdirSync(dir)
          .filter((n) => exts.some((e) => n.toLowerCase().endsWith(`.${e}`)))
          .sort()
      } catch {
        names = []
      }
      for (const name of names) {
        if (backgrounds.length >= 8) break
        const base = name.slice(0, name.lastIndexOf('.'))
        if (legacySlots.includes(base) || seen.has(name)) continue
        const url = readAsUrl(join(dir, name))
        if (!url) continue
        seen.add(name)
        backgrounds.push(url)
      }
    }

    return { slots, slices, backgrounds, icons }
  })

  /** 私有背景音乐列表（<userData>/textures/music） */
  handle('app:music', () => listMusic())

  /*
   * 音乐与背景的「上传 + 切换」。
   *
   * 文件都落在 <userData>/textures 下，和皮肤素材同一个地方 ——
   * 备份、迁移、清理只要盯着这一个目录。
   * 选中的是哪一首 / 哪一张存在 settings 表里（media.prefs），重启后仍然生效。
   */
  handle('app:importMusic', async () => {
    const dir = join(app.getPath('userData'), 'textures', 'music')
    mkdirSync(dir, { recursive: true })
    const result = await dialog.showOpenDialog({
      title: '添加音乐',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'opus'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, tracks: listMusic() }
    for (const src of result.filePaths) {
      try {
        const name = basename(src)
        const target = join(dir, name)
        if (!existsSync(target)) copyFileSync(src, target)
      } catch {
        // 单个文件失败不影响其他
      }
    }
    return { canceled: false, tracks: listMusic() }
  })

  handle('app:removeMusic', (name: string) => {
    const dir = resolve(join(app.getPath('userData'), 'textures', 'music'))
    const file = resolve(join(dir, basename(String(name ?? ''))))
    if (!file.startsWith(dir) || !existsSync(file)) return listMusic()
    try {
      unlinkSync(file)
    } catch {
      // 文件被占用就留着
    }
    // 删掉的正好是选中的那首 → 清掉偏好
    const prefs = getSetting<MediaPrefs>(getDb(), MEDIA_KEY, EMPTY_MEDIA_PREFS)
    if (prefs.musicTrack === basename(file)) {
      setSetting(getDb(), MEDIA_KEY, { ...prefs, musicTrack: null })
    }
    return listMusic()
  })

  /** 用户自己放的背景图（<userData>/textures/backgrounds） */
  handle('app:backdrops', () => listBackdrops())

  handle('app:importBackdrops', async () => {
    const dir = backdropsDir()
    mkdirSync(dir, { recursive: true })
    const result = await dialog.showOpenDialog({
      title: '添加背景图',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, backdrops: listBackdrops() }
    for (const src of result.filePaths) {
      try {
        const name = basename(src)
        const target = join(dir, name)
        if (!existsSync(target)) copyFileSync(src, target)
      } catch {
        // 单个失败不影响其他
      }
    }
    return { canceled: false, backdrops: listBackdrops() }
  })

  handle('app:removeBackdrop', (name: string) => {
    const dir = resolve(backdropsDir())
    const file = resolve(join(dir, basename(String(name ?? ''))))
    if (!file.startsWith(dir) || !existsSync(file)) return listBackdrops()
    try {
      unlinkSync(file)
    } catch {
      // 留着
    }
    const prefs = getSetting<MediaPrefs>(getDb(), MEDIA_KEY, EMPTY_MEDIA_PREFS)
    if (prefs.backdrop === basename(file)) {
      setSetting(getDb(), MEDIA_KEY, { ...prefs, backdrop: null })
    }
    return listBackdrops()
  })

  handle('app:mediaPrefs', () => getSetting<MediaPrefs>(getDb(), MEDIA_KEY, EMPTY_MEDIA_PREFS))
  handle('app:setMediaPrefs', (patch: Partial<MediaPrefs>) => {
    const db = getDb()
    const current = getSetting<MediaPrefs>(db, MEDIA_KEY, EMPTY_MEDIA_PREFS)
    const next: MediaPrefs = {
      musicTrack: patch.musicTrack === undefined ? current.musicTrack : patch.musicTrack,
      backdrop: patch.backdrop === undefined ? current.backdrop : patch.backdrop
    }
    setSetting(db, MEDIA_KEY, next)
    return next
  })

  /** 首页的「退出」按钮 */
  handle('app:quit', () => {
    app.quit()
    return true
  })

  handle('app:paths', () => ({
    userData: app.getPath('userData'),
    data: dataDir(),
    images: imagesDir(),
    backups: backupsDir(),
    db: dbFilePath(),
    encryptionAvailable: isEncryptionAvailable()
  }))

  /*
   * 无边框窗口的按钮。
   *
   * `frame: false` 之后原生标题栏没了，最小化/最大化/关闭只能由渲染层
   * 通过这里调。点按钮必然先激活那个窗口，所以取「当前聚焦窗口」是对的；
   * `handle` 不转发事件对象，拿不到 sender。
   */
  const focusedWindow = (): BrowserWindow | null =>
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

  handle('window:minimize', () => {
    focusedWindow()?.minimize()
    return true
  })
  handle('window:toggleMaximize', () => {
    const win = focusedWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle('window:close', () => {
    focusedWindow()?.close()
    return true
  })
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


  handle('plants:save', (payload: Parameters<typeof savePlant>[1]) => savePlant(getDb(), payload))
  handle('plants:cover', (plantId: number, imageId: number | null) => setPlantCover(getDb(), plantId, imageId))

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
  handle('images:list', (owner: { plantId?: number; speciesId?: number; environmentId?: number }) =>
    listImages(getDb(), owner)
  )

  handle('images:search', (query: string) => searchWebImages(query, 12))
  /*
   * 从图片地址导入。
   *
   * 模型（deepseek-chat 之类）拿不到图片，国内的图片搜索又多要单独的 key，
   * 所以先给一条「浏览器里看到图 → 复制图片地址 → 粘贴」的路。
   */
  handle('images:importUrl', async (owner: { plantId?: number; speciesId?: number }, url: string) => {
    const file = await importImageFromUrl(url)
    return addImage(getDb(), {
      plantId: owner.plantId ?? null,
      speciesId: owner.speciesId ?? null,
      path: file.fileName,
      thumbPath: file.thumbName,
      origin: 'url'
    })
  })

  handle('images:pick', async (owner: { plantId?: number; speciesId?: number; environmentId?: number }) => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
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
          environmentId: owner.environmentId ?? null,
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
  handle('care:task.complete', (id: number, note?: string | null, date?: string, imageIds?: number[] | null) =>
    completeCareTask(getDb(), id, note, date, imageIds ?? undefined)
  )
  handle('care:task.skip', (id: number, reason?: string | null) => skipCareTask(getDb(), id, reason))
  handle('care:task.reopen', (id: number) => reopenCareTask(getDb(), id))
  handle('care:task.delete', (id: number) => deleteCareTask(getDb(), id))
  // 批量清理：误生成整年计划时的出口，只删待办
  handle('care:tasks.purge', (input: { from: string; to: string; plantId?: number }) =>
    purgeCareTasks(getDb(), input)
  )

  handle('care:generate', (plantId: number, year: number) => generateTasksForPlant(getDb(), plantId, year))
  handle('care:generateAll', (year: number) => generateTasksForAll(getDb(), year))
  handle('care:overview', (year: number) => careOverview(getDb(), year))

  /*
   * 导出「这一株的全年计划」为独立 HTML。
   * 只读数据库 + 拼字符串，然后弹保存框；不写库，也不依赖渲染进程。
   */
  handle('care:plan.exportHtml', async (plantId: number, year: number) => {
    const db = getDb()
    const plant = getPlant(db, plantId)
    if (!plant) throw new Error('植株不存在')
    const tasks = listCareTasks(db, { plantId, from: `${year}-01-01`, to: `${year}-12-31` })
    // 封面：thumb_path 是 imagesDir() 里的文件名，读出来内联成 data URI（HTML 要能单文件带走）
    let coverDataUrl: string | null = null
    if (plant.coverThumb) {
      try {
        const file = join(imagesDir(), plant.coverThumb)
        if (existsSync(file)) {
          const ext = plant.coverThumb.toLowerCase().split('.').pop() ?? 'png'
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
          coverDataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`
        }
      } catch {
        // 图读不出来就不带封面，不影响导出
      }
    }
    const html = buildCarePlanHtml({
      plantName: plant.nickname,
      coverDataUrl,
      speciesName: plant.species?.commonName ?? null,
      year,
      tasks: tasks.map((task) => ({
        actionType: task.actionType,
        title: task.title,
        detail: task.detail,
        dueDate: task.dueDate,
        windowDays: task.windowDays,
        status: task.status
      })),
      generatedAt: new Date()
    })
    const safeName = plant.nickname.replace(/[\\/:*?"<>|]/g, '_')
    const result = await dialog.showSaveDialog({
      title: '导出全年养护计划',
      defaultPath: `${safeName}-${year}-养护计划.html`,
      filters: [{ name: 'HTML 网页', extensions: ['html'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, path: null, count: tasks.length }
    writeFileSync(result.filePath, html, 'utf8')
    return { canceled: false, path: result.filePath, count: tasks.length }
  })

  // 物候阶段：切换会立刻改变任务生成结果，也会写一条养护日志
  handle('care:plantPhase', (plantId: number) => getPlantPhase(getDb(), plantId))
  /*
   * 这一株当年有没有计划。渲染层在「切阶段要不要顺手重排任务」时问它。
   * 没有计划就不生成 —— 标记现状 ≠ 替用户排计划。
   */
  handle('care:hasPlan', (plantId: number, year: number) => hasCarePlan(getDb(), plantId, year))
  handle('care:setPlantPhase', (plantId: number, phase: CarePhase | null, note?: string | null) =>
    setPlantPhase(getDb(), plantId, phase, note)
  )

  handle('care:logs', (plantId?: number, limit?: number) => listCareLogs(getDb(), { plantId, limit }))
  handle('care:log.add', (input: Parameters<typeof addCareLog>[1]) => addCareLog(getDb(), input))
  handle('care:log.update', (id: number, patch: CareLogPatch) => {
    /*
     * 先记下要摘掉的照片文件名，改完再把文件删掉 ——
     * 记录删掉之后就查不到 path 了。
     */
    const removeIds = (patch.removeImageIds ?? []).filter((v) => Number.isFinite(v))
    const files =
      removeIds.length > 0
        ? getDb()
            .all<{ path: string; thumb_path: string | null }>(
              `SELECT path, thumb_path FROM images WHERE log_id = ? AND id IN (${removeIds.map(() => '?').join(',')})`,
              id,
              ...removeIds
            )
            .flatMap((row) => [row.path, row.thumb_path])
        : []
    const updated = updateCareLog(getDb(), id, patch)
    if (updated) removeImageFiles(files)
    return updated
  })
  handle('care:log.delete', (id: number) => {
    /*
     * 先取文件名再删记录 —— 删完就查不到 path 了。
     * 文件清理放在 IPC 层：repo 只管数据库。
     */
    const files = listLogImages(getDb(), id).flatMap((img) => [img.path, img.thumbPath])
    const ok = deleteCareLog(getDb(), id)
    if (ok) removeImageFiles(files)
    return ok
  })

  // -------------------------------------------------------------------------
  // 材料与配方
  // -------------------------------------------------------------------------

  handle('materials:list', (query?: string) => listMaterials(getDb(), query))
  handle('materials:save', (input: MaterialInput) => saveMaterial(getDb(), input))
  handle('materials:delete', (id: number) => deleteMaterial(getDb(), id))
  handle('materials:usage', (id: number) => materialUsage(getDb(), id))

  handle('recipes:list', (options?: RecipeListOptions) => listRecipes(getDb(), options ?? {}))
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

  /*
   * 识图：把一张已有的图片发给视觉模型，拿回 Top-3 候选。
   *
   * 只做「认出是什么」，**不写任何数据** —— 候选交给现有的
   * 「草稿 → 逐字段勾选 → 写入」流程处理，那条路的规矩（永不自动写、
   * 安全字段强制人工核实）不该在这里被绕过。
   *
   * 图片**先缩小再发**：手机照片动辄几 MB，base64 还要再涨三分之一，
   * 直接发多半被接口按体积拒掉。识别不需要原始分辨率。
   */
  /**
   * 把一张图片处理成可以发给模型的 data URL。
   *
   * **先缩到长边 1024 再发**：手机照片动辄几 MB，base64 还要再涨三分之一，
   * 直接发多半被接口按体积拒掉。识别不需要原始分辨率。
   * 用 Electron 自带的 nativeImage，不引新依赖。
   *
   * 读不出来时回落到原图 —— 宁可发大图被接口拒，也不要在这里静默失败。
   */
  function prepareImageDataUrl(file: string): string {
    const native = nativeImage.createFromPath(file)
    const resized = native.isEmpty() ? null : native.resize({ width: 1024, quality: 'good' })
    if (resized) return `data:image/jpeg;base64,${resized.toJPEG(82).toString('base64')}`
    return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`
  }


  /*
   * 识别一张**本地图片**（弹文件对话框选）。
   *
   * 为什么要这条：识图最该用的地方是「录入一种新植物」——
   * 拍了照想知道是什么。可那时相册里还没有这张图，所以必须能从磁盘选。
   *
   * 文件对话框放在主进程：不让界面直接传任意路径进来。
   */
  handle('ai:identifyFile', async (payload: { requestId: string; hint?: string }) => {
    const fail = (message: string) => ({ ok: false as const, candidates: [], message, model: null, sourceName: null })

    const picked = await dialog.showOpenDialog({
      title: '选一张植物照片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return fail('没有选择图片。')

    const db = getDb()
    const settings = readAiSettings(db)
    const apiKey = getApiKey()
    if (!apiKey) return fail('尚未配置 API Key。请到「设置 → AI」填写后再试。')

    // 视觉模型留空时回落到对话模型 —— deepseek-flash 本身就能读图
    const model = (settings.visionModel ?? '').trim() || settings.chatModel
    if (!model) return fail('尚未配置模型。请到「设置 → AI」填写对话模型。')

    const file = picked.filePaths[0]
    if (!existsSync(file)) return fail('文件读不到了。')

    const controller = new AbortController()
    runningAi.set(payload.requestId, controller)
    try {
      const result = await identifyPlant({
        baseUrl: settings.baseUrl,
        apiKey,
        model,
        imageDataUrl: prepareImageDataUrl(file),
        hint: payload.hint,
        // 库里已有的名字当线索 —— 把开放问题变成选择题，但它只是线索不是答案
        knownNames: listSpecies(db, { limit: 200 }).items.map((s) => s.commonName),
        temperature: settings.temperature,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
        signal: controller.signal
      })
      const sourceName = file.split(/[\\/]/).pop() ?? null
      return {
        ok: result.ok,
        candidates: result.candidates,
        message: result.error,
        raw: result.raw,
        model: result.model,
        sourceName
      }
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


}
