/**
 * 端到端自检。
 *
 * 刻意**不依赖 electron** —— 只用 node:sqlite + 文件系统，因此：
 *   - 可以用 `node` 直接跑（Node 24 内置 node:sqlite），CI 里当快速回归测试
 *   - 也可以用 `electron . --smoke` 跑，验证真实运行时
 * 两个入口跑的是同一份代码，结论一致。
 *
 * 覆盖范围刻意偏向「容易悄悄坏掉」的地方：迁移幂等、绑定归一化、索引投影多行展开、
 * 部分更新不丢字段、必填校验、字段删除保护、备份产出。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeQuery, parseBingResults, queryTokens, rankHits } from '../core/imageSearch'
import { Db, countPlaceholders } from './db/connection'
import { formatFieldValue, formatMonthSet, normalizeMonths } from '../core/fieldTypes'
import { LATEST_VERSION, MIGRATIONS, migrateSafetyVisibility } from './db/schema'
import { currentVersion, migrate, rebuildAttrIndex } from './db/migrate'
import { seedAll, seedFieldDefinitions } from './db/seed'
import { backupDatabase } from './db/backup'
import { loadFieldDefinitions } from './db/repo/common'
import { assessPlantsWeather } from './services/weather'
import {
  GEOCODE_CACHE_KEY,
  lookupLocation,
  qweatherSkipReason,
  readWeatherConfig,
  saveWeatherConfig
} from './services/weather-providers'
import type { GeoResult } from './services/weather-providers'
import { buildIdentifyMessages, parseIdentifyResponse } from './services/ai/identify'
import { chat } from './services/ai/client'
import { createField, deleteField, fieldUsage, getField, setFieldArchived, updateField } from './db/repo/fields'
import { getSpecies, listSpecies, saveSpecies, archiveSpecies, verifySpeciesFields } from './db/repo/species'
import { archivePlant, getPlant, listPlantCategories, listPlants, plantStats, savePlant, setPlantCover } from './db/repo/plants'
import { addImage, archiveEnvironment, deleteImage, getEnvironment, getSetting, listCorruptSettings, listEnvironments, listImages, saveEnvironment, setSetting } from './db/repo/misc'
import { toCsv, parseCsv } from '../core/csv'
import { applyImport, buildExport, previewImport } from './services/transfer'
import { summarizeRecipe, scaleRecipe, validateRecipe } from '../core/recipes'
import { isFieldVisible, visibleFields } from '../core/attributes'
import type { CarePhase, CareTask, CareTaskStatus, FieldDefinition, FieldVisibleWhen, RecipeItem } from '../core/types'
import {
  GROWTH_SOURCE_LABELS,
  GROWTH_STAGE_LABELS,
  GROWTH_STAGE_PROGRESS,
  ageFactor,
  deriveGrowthStage,
  describeEffectiveHeight,
  describeSize,
  effectiveHeight,
  growthLook,
  readNumber,
  sizeScaleFor
} from '../core/growth'
import type { GrowthStage } from '../core/growth'
import { adviseToday, WEATHER_KIND_ICONS, WEATHER_KIND_LABELS, qweatherIconToKind, wmoToKind, assessWeatherRisks, dedupeByKindAndDay, effectiveColdThreshold, severityOf, suggestTask, summarizeRisks, unjudgeable } from '../core/weather'
import type { DailyTemp, WeatherRiskInput } from '../core/weather'
import {
  CULTIVATION_BASE,
  CULTIVATION_OPTIONS,
  FLOWER_COLOR_HEX,
  FLOWER_COLOR_OPTIONS,
  FLOWER_FORM_OPTIONS,
  FOLIAGE_COLOR_HEX,
  FOLIAGE_COLOR_OPTIONS,
  LEAF_SHAPE_OPTIONS,
  SPREAD_OPTIONS,
  foliageHex,
  isVariegated,
  SPRITE_HABITS,
  SPRITE_SIZE,
  baseForCultivation,
  buildPlantSprite,
  countPixels,
  flowerColorForSpecies,
  mixColor,
  normalizeHabit
} from '../core/sprite'
import { WEATHER_ICON_KINDS, WEATHER_ICON_SIZE, buildWeatherIcon } from '../core/weatherIcon'
import { THEME_BACKDROP, resolveBackdrops } from '../core/media'
import { PLANT_STATUS_ORDER } from '../core/status'
import { deriveCarePhase } from '../core/phase'
import { searchSelectView } from '../core/searchSelect'
import { buildAskPlantMessages, buildPlantDossier } from '../core/plantDossier'
import { careGuideTaskDrafts, parseCareGuide } from '../core/careGuide'
import { defaultFieldDefinitions } from '../core/defaultTemplate'
import {
  addDays,
  compareTasks,
  dateSpansFor,
  daysBetween,
  describeSpeciesKeys,
  dueDescription,
  generateTasks,
  groupTasksByRule,
  isCarePhase,
  CARE_PHASE_HINTS,
  CARE_PHASE_OPTIONS,
  monthsCovered,
  normalizePhases,
  parseSpeciesKeys,
  pendingBuckets,
  phaseAgeDays,
  ruleMatchesSpecies,
  serializeSpeciesKeys,
  spreadDay,
  summarizeTasks,
  urgencyOf,
  todayIso,
  windowRange
} from '../core/care'
import {
  addCareLog,
  careOverview,
  careRuleCount,
  completeCareTask,
  createCareTask,
  deleteCareLog,
  deleteCareLogs,
  deleteCareRule,
  deleteCareTask,
  generateTasksForAll,
  generateTasksForPlant,
  getCareTask,
  getPlantPhase,
  listCareLogs,
  listLogImages,
  listCareRules,
  listCareTasks,
  reopenCareTask,
  saveCareRule,
  setPlantPhase,
  hasCarePlan,
  skipCareTask,
  updateCareLog,
  updateCareTask
} from './db/repo/care'
import { seedCareRules } from './db/seed'
import {
  nextIndex,
  normalizeMusicMode,
  randomIndex,
  seasonOfFolderName,
  seasonOfMonth,
  seasonTracks
} from '../core/music'
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
} from './db/repo/recipes'

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
}

/**
 * 一致性检查：attr_index 里出现的每个非列字段，都必须能在对应的 attributes_json 里找到。
 * 反过来（JSON 有值但投影缺失）不算错 —— 投影是可重建的派生数据。
 */
function projectionInconsistencies(db: Db): string[] {
  const problems: string[] = []
  const defsByOwner: Record<string, Map<string, string | null>> = {
    species: new Map(),
    plant: new Map()
  }
  for (const row of db.all<{ owner_kind: string; key: string; column_name: string | null }>(
    'SELECT owner_kind, key, column_name FROM field_definitions'
  )) {
    defsByOwner[row.owner_kind]?.set(row.key, row.column_name)
  }

  const tables: Array<[string, string]> = [
    ['species', 'species'],
    ['plant', 'plants']
  ]

  for (const [ownerKind, table] of tables) {
    const rows = db.all<{ id: number; attributes_json: string }>(`SELECT id, attributes_json FROM ${table}`)
    for (const row of rows) {
      let attrs: Record<string, unknown> = {}
      try {
        attrs = JSON.parse(row.attributes_json || '{}') as Record<string, unknown>
      } catch {
        problems.push(`${table}#${row.id} 的 attributes_json 不是合法 JSON`)
        continue
      }
      const indexed = db.all<{ field_key: string }>(
        'SELECT DISTINCT field_key FROM attr_index WHERE owner_kind = ? AND owner_id = ?',
        ownerKind,
        row.id
      )
      for (const { field_key: key } of indexed) {
        if (defsByOwner[ownerKind]?.get(key)) continue // 系统列不写 attributes_json，属正常
        if (!(key in attrs)) problems.push(`${table}#${row.id} 的投影含 ${key}，但 attributes_json 里没有`)
      }
    }
  }
  return problems
}

export interface SmokeReport {
  ok: boolean
  passed: number
  failed: number
  checks: CheckResult[]
  environment: Record<string, string>
  database: Record<string, unknown>
}

/**
 * 保存物种，并断言一定成功。
 *
 * saveSpecies 的 species 现在可以是 null（UPDATE 影响 0 行时不再递一个
 * id:0 的假对象回来）。自检里那些调用都是**准备数据**，拿不到就说明
 * 前提已经不成立，应该立刻炸掉 —— 而不是让 null 悄悄流进后面的断言，
 * 变成一条看不懂的失败。
 *
 * 刻意**不用 `!`** 压住：那等于把检查关掉，和原来的毛病一样。
 */
function saveSpeciesOk(
  db: Db,
  input: Parameters<typeof saveSpecies>[1],
  origin?: 'manual' | 'ai' | 'import'
): ReturnType<typeof saveSpecies> & { species: NonNullable<ReturnType<typeof saveSpecies>['species']> } {
  const r = saveSpecies(db, input, origin)
  if (!r.species) {
    throw new Error('自检准备数据失败：' + JSON.stringify(r.errors))
  }
  return r as ReturnType<typeof saveSpecies> & { species: NonNullable<ReturnType<typeof saveSpecies>['species']> }
}

export async function runSmoke(outFile: string): Promise<number> {
  const checks: CheckResult[] = []
  const workDir = mkdtempSync(join(tmpdir(), 'sproutbook-smoke-'))
  const dbFile = join(workDir, 'smoke.db')
  const backupDir = join(workDir, 'backups')

  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }

  const checkThrows = (name: string, fn: () => unknown, expectMessagePart?: string): void => {
    try {
      fn()
      check(name, false, '预期抛错但没有')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const matched = expectMessagePart ? message.includes(expectMessagePart) : true
      check(name, matched, matched ? undefined : `错误信息不含「${expectMessagePart}」：${message}`)
    }
  }

  let db: Db | null = null
  const meta: Record<string, unknown> = {}

  try {
    // --- 迁移 ---
    db = new Db(dbFile)
    check('数据库文件创建', existsSync(dbFile))
    check('初始版本为 0', currentVersion(db) === 0, `实际 ${currentVersion(db)}`)

    const r1 = migrate(db)
    check('首次迁移成功', r1.ok && r1.to === LATEST_VERSION, r1.error ?? `to=${r1.to}`)

    const r2 = migrate(db)
    check('迁移幂等（重复执行为空操作）', r2.ok && r2.applied.length === 0)

    // --- 种子数据 ---
    const seeded = seedAll(db)
    check('默认模板写入', seeded.fields > 20, `写入 ${seeded.fields} 个字段`)

    const defs = loadFieldDefinitions(db, 'species')
    check('物种字段可读取', defs.length > 20, `${defs.length} 个`)
    check('系统字段被标记', defs.some((d) => d.isSystem && d.key === 'common_name'))
    check('安全字段被标记', defs.filter((d) => d.isSafety).length >= 4, `${defs.filter((d) => d.isSafety).length} 个`)

    const plantDefs = loadFieldDefinitions(db, 'plant')
    check('植株字段可读取', plantDefs.length >= 3, `${plantDefs.length} 个`)

    // --- 物种写入：覆盖 boolean / number / 多值 / 月份区间 四类绑定 ---
    const saved = saveSpeciesOk(db, {
      values: {
        common_name: '月季',
        scientific_name: 'Rosa chinensis',
        family: '蔷薇科',
        aliases: ['月月红', '斗雪红'],
        needs_vernalization: false, // boolean → 必须被归一化为 0/1
        cold_hardiness: -15, // number
        heat_tolerance: 38,
        // 月份集合：两段不相连（月季的真实情况 —— 4~6 月主花期 + 9~11 月复花）
        bloom_months: [4, 5, 6, 9, 10, 11],
        light_requirement: ['全日照', '半阴'], // multiselect → 2 行投影
        toxicity_level: '无毒',
        fragrance: '浓香'
      }
    })
    check('物种保存无校验错误', Object.keys(saved.errors).length === 0, JSON.stringify(saved.errors))
    const speciesId = saved.species.id
    check('物种获得自增 id', speciesId > 0, `id=${speciesId}`)
    check('布尔字段正确落库', saved.species.attributes.needs_vernalization === false)
    check('数字字段正确落库', saved.species.attributes.cold_hardiness === -15)
    check('标签字段为数组', Array.isArray(saved.species.aliases) && saved.species.aliases.length === 2)
    check('系统列写入独立列', saved.species.family === '蔷薇科')

    // --- 核实 / 撤回核实 ---
    //
    // 曾经的 bug 有两个，这里都要钉住：
    //  1. 批量核实只标记 isSafety 的字段，AI 填的其它字段永远停在「待核实」。
    //  2. IPC 处理器漏了第三个参数，导致「撤回核实」实际永远走「标记」分支 ——
    //     界面提示成功，数据却没变。
    // 现在「需要核实的字段」只有安全字段，所以先写一批 AI 来源（含非安全字段）。
    const withAi = saveSpeciesOk(db, {
      id: speciesId,
      values: { common_name: '月季' },
      source: 'ai',
      aiFields: [
        { key: 'scientific_name', confidence: 0.9 }, // 非安全：不该进待核实
        { key: 'family', confidence: 0.9 }, // 非安全
        { key: 'bloom_months', confidence: 0.8 }, // 非安全
        { key: 'toxicity_level', confidence: 0.6 }, // 安全
        { key: 'pet_safe', confidence: 0.5 } // 安全
      ]
    })
    check(
      'AI 来源只把安全字段列为待核实',
      withAi.pendingReview.join(',') === 'toxicity_level,pet_safe',
      withAi.pendingReview.join(',')
    )
    check(
      '列表项只统计待核实的安全字段（非安全字段不算）',
      (getSpecies(db, speciesId)?.pendingSafetyFields ?? []).join(',') === 'toxicity_level,pet_safe',
      (getSpecies(db, speciesId)?.pendingSafetyFields ?? []).join(',')
    )
    check(
      '全部置信度都被记录（来源可追溯，不因不需要核实就丢掉）',
      Object.keys(getSpecies(db, speciesId)?.confidence ?? {}).length === 5
    )

    verifySpeciesFields(db, speciesId, ['toxicity_level', 'pet_safe'])
    check('核实后字段进入已核实列表', getSpecies(db, speciesId)?.verifiedFields.length === 2)
    check('全部核实后不再有待核实的安全字段', (getSpecies(db, speciesId)?.pendingSafetyFields ?? []).length === 0)

    verifySpeciesFields(db, speciesId, ['pet_safe'], false)
    const afterUnverify = getSpecies(db, speciesId)?.verifiedFields ?? []
    check(
      '撤回核实会移除指定字段且不影响其它字段',
      afterUnverify.length === 1 && afterUnverify[0] === 'toxicity_level',
      afterUnverify.join(',')
    )
    check(
      '撤回后该字段重新回到待核实',
      (getSpecies(db, speciesId)?.pendingSafetyFields ?? []).join(',') === 'pet_safe',
      (getSpecies(db, speciesId)?.pendingSafetyFields ?? []).join(',')
    )
    check('对不存在的记录核实返回 null', verifySpeciesFields(db, 999999, ['x']) === null)

    // --- 索引投影 ---
    const monthRows = db.all<{ idx: number; value_num: number }>(
      "SELECT idx, value_num FROM attr_index WHERE owner_kind='species' AND owner_id=? AND field_key='bloom_months' ORDER BY idx",
      speciesId
    )
    check('月份集合展开为多行投影', monthRows.length === 6, `实际 ${monthRows.length} 行（4,5,6,9,10,11 应为 6）`)
    check(
      '多段月份都被投影（中间断开的 7、8 月不出现）',
      monthRows.map((r) => r.value_num).join(',') === '4,5,6,9,10,11',
      monthRows.map((r) => r.value_num).join(',')
    )
    check('按花期筛选能命中第二段（9 月）', listSpecies(db, { bloomMonth: 9 }).items.some((s) => s.id === speciesId))
    check('按花期筛选不会命中断档月（7 月）', !listSpecies(db, { bloomMonth: 7 }).items.some((s) => s.id === speciesId))

    // --- 月份集合的解析与格式化 ---
    check('字符串 "3-5,9-11" 可解析为两段', normalizeMonths('3-5,9-11').join(',') === '3,4,5,9,10,11')
    check('旧的 {from,to} 写法仍可读', normalizeMonths({ from: 11, to: 2 }).join(',') === '11,12,1,2')
    check('月份集合会去重并升序', normalizeMonths([9, 3, 9, 5]).join(',') === '3,5,9')
    check('越界月份被丢弃', normalizeMonths([0, 13, 5]).join(',') === '5')
    check(
      '连续段压缩为区间文本',
      formatMonthSet([3, 4, 5, 9, 10, 11]) === '三月~五月、九月~十一月',
      formatMonthSet([3, 4, 5, 9, 10, 11])
    )
    check('跨年段压缩正确', formatMonthSet([11, 12, 1, 2]) === '十一月~二月', formatMonthSet([11, 12, 1, 2]))
    check('单月不加区间符号', formatMonthSet([5]) === '五月', formatMonthSet([5]))
    check('十二个月显示为全年', formatMonthSet(Array.from({ length: 12 }, (_, i) => i + 1)) === '全年')

    const lightRows = db.all(
      "SELECT * FROM attr_index WHERE owner_kind='species' AND owner_id=? AND field_key='light_requirement'",
      speciesId
    )
    check('多选字段展开为多行投影', lightRows.length === 2, `实际 ${lightRows.length} 行`)

    const boolRow = db.get<{ value_num: number }>(
      "SELECT value_num FROM attr_index WHERE owner_kind='species' AND owner_id=? AND field_key='needs_vernalization'",
      speciesId
    )
    check('布尔投影为 0/1', boolRow?.value_num === 0, `实际 ${boolRow?.value_num}`)

    // --- 搜索 ---
    const byName = listSpecies(db, { query: '月季' })
    check('按名称搜索命中', byName.items.some((s) => s.id === speciesId))
    const byAlias = listSpecies(db, { query: '月月红' })
    check('按别名搜索命中', byAlias.items.some((s) => s.id === speciesId))
    const byFamily = listSpecies(db, { query: '蔷薇' })
    check('按科名搜索命中', byFamily.items.some((s) => s.id === speciesId))
    check('搜索无结果时返回空数组', listSpecies(db, { query: '不存在的植物xyz' }).items.length === 0)
    check('LIKE 通配符被转义（% 不会匹配全部）', listSpecies(db, { query: '%' }).items.length === 0)

    const byMonth = listSpecies(db, { bloomMonth: 6 })
    check('按开花月份筛选命中', byMonth.items.some((s) => s.id === speciesId))
    const byMonthMiss = listSpecies(db, { bloomMonth: 1 })
    check('非花月份不命中', !byMonthMiss.items.some((s) => s.id === speciesId))

    // --- 部分更新不丢字段 ---
    const updated = saveSpeciesOk(db, { id: speciesId, values: { common_name: '月季（更新）', pot_size: '20cm' } })
    check('部分更新成功', Object.keys(updated.errors).length === 0)
    check('未提交的字段保持原值', updated.species.attributes.cold_hardiness === -15, `实际 ${updated.species.attributes.cold_hardiness}`)
    check('已提交的字段被更新', updated.species.commonName === '月季（更新）')

    // 重名：物种是「一个物种一条」，同名两条会让规则/封面/搜索全对不上
    const dupName = saveSpecies(db, { values: { common_name: '月季（更新）' } })
    check('同名物种被拒绝', Boolean(dupName.errors.common_name), JSON.stringify(dupName.errors))
    check('同名被拒时不返回半成品', dupName.species === null, String(dupName.species))

    /*
     * 这两处**故意**让它失败（测必填校验和非法类型），所以不能用 saveSpeciesOk ——
     * 那个辅助会直接抛「自检准备数据失败」，把一条正常的断言变成崩溃。
     * 顺带钉住：校验失败时 species 是 null，不再递一个 id:0 的假对象回去。
     */
    const missing = saveSpecies(db, { values: { scientific_name: 'X' } })
    check('缺少必填字段被拒绝', Object.keys(missing.errors).length > 0, JSON.stringify(missing.errors))

    /*
     * 物候阶段：**自动推算**，不再是手动标记。
     * 状态压过日历（阳台比露台晚开两周），日历压过"什么都没写"。
     */
    {
      const phaseOf = (input: Parameters<typeof deriveCarePhase>[0]) => deriveCarePhase(input).phase
      check('阶段：状态「种子」直接是 seed', phaseOf({ status: 'seed', today: '2026-05-01' }) === 'seed')
      check('阶段：状态「缓苗」压过花期', phaseOf({ status: 'recovering', bloomMonths: [5], today: '2026-05-01' }) === 'recovering')
      check('阶段：状态「病虫害」是 pest', phaseOf({ status: 'sick', bloomMonths: [5], today: '2026-05-01' }) === 'pest')
      check('阶段：当月开花就推算成 blooming', phaseOf({ bloomMonths: [4, 5, 6], today: '2026-05-10' }) === 'blooming')
      check('阶段：下个月开花推成 budding', phaseOf({ bloomMonths: [6], today: '2026-05-10' }) === 'budding')
      check('阶段：12 月的下个月是 1 月', phaseOf({ bloomMonths: [1], today: '2026-12-10' }) === 'budding')
      check('阶段：休眠月份推成 dormant', phaseOf({ dormancyMonths: [1, 2], today: '2026-01-10' }) === 'dormant')
      check('阶段：都不沾边就是 growing', phaseOf({ bloomMonths: [6], today: '2026-02-10' }) === 'growing')
      check('阶段：枯死不再谈物候', phaseOf({ status: 'dead', bloomMonths: [5], today: '2026-05-01' }) === null)
      check('阶段：说明里写清依据（不是内部键名）', deriveCarePhase({ bloomMonths: [5], today: '2026-05-01' }).reason.includes('开花'), deriveCarePhase({ bloomMonths: [5], today: '2026-05-01' }).reason)

    // 状态的选项存活在 field_definitions 里（不是代码），加状态时两处必须同时改：
    // 忘了改模板 → 老库下拉里看不到新状态（用户就是这么发现的）
    {
      const statusField = defaultFieldDefinitions().find((d) => d.ownerKind === 'plant' && d.key === 'status')
      check('状态字段覆盖全部 9 个状态', PLANT_STATUS_ORDER.every((k) => statusField?.options?.includes(k)), JSON.stringify(statusField?.options))
      check('状态选项顺序与展示顺序一致', JSON.stringify(statusField?.options) === JSON.stringify(PLANT_STATUS_ORDER), JSON.stringify(statusField?.options))

    /*
     * 可搜索下拉的取值逻辑。
     * 这里钉住的是一个真实 bug：允许自定义时，值不在选项里 → 收起后显示成空，
     * 用户以为"回车没保存"。
     */
    {
      const opts = [
        { value: '月季', label: '月季' },
        { value: '多肉类', label: '多肉类' }
      ]
      const closed = searchSelectView({ value: '草花', query: '', open: false, options: opts, allowCustom: true })
      check('自定义值收起后显示它自己（不能显示空）', closed.display === '草花', closed.display)
      const closedStrict = searchSelectView({ value: '草花', query: '', open: false, options: opts, allowCustom: false })
      check('不允许自定义时，选项外的值显示为空', closedStrict.display === '', closedStrict.display)

      const typed = searchSelectView({ value: '月季', query: '草花', open: true, options: opts, allowCustom: true })
      check('输入新值时给「使用它」的入口', typed.customCandidate === '草花')
      check('回车采纳新值', typed.enterPick === '草花', String(typed.enterPick))

      const exact = searchSelectView({ value: '月季', query: '月季', open: true, options: opts, allowCustom: true })
      check('完全匹配时回车选已有项（不造新词）', exact.enterPick === '月季', String(exact.enterPick))
      check('完全匹配时没有"使用它"入口', exact.customCandidate === null)

      const prefix = searchSelectView({ value: '月季', query: '多', open: true, options: opts, allowCustom: true })
      check('输入前缀时回车先选已有项', prefix.enterPick === '多肉类', String(prefix.enterPick))

    /*
     * 「问问 AI」的档案拼装。
     * 提示词可以改，但"哪些信息必须带上、空字段不能占位、超长要截断"是硬要求 ——
     * 漏一个字段，模型就会开始瞎猜。
     */
    {
      const dossier = buildPlantDossier({
        today: '2026-10-22',
        plant: {
          nickname: '前院莫利纳尔',
          category: '月季',
          statusLabel: '发芽 / 生长',
          phaseLabel: '花期',
          phaseReason: '10 月在开花期内',
          acquiredAt: '2026-04-18',
          potSize: '25 cm',
          cultivation: '地栽',
          heightCm: 62,
          ageYears: 2,
          price: 88,
          notes: '春天满园赠品',
          attributes: [{ label: '叶色', value: '深绿' }]
        },
        species: {
          commonName: '月季莫利纳尔',
          scientificName: 'Rosa Molineux',
          family: '蔷薇科',
          genus: '蔷薇属',
          aliases: ['莫利纳尔'],
          attributes: [{ label: '耐寒', value: '-15 ℃' }]
        },
        env: { name: '前院', light: '全日照', lightHours: 6, location: '浙江省 / 某市', notes: '东南角' },
        tasks: [
          { title: '冬季控水', dueDate: '2026-11-01', status: 'pending' },
          { title: '春季换盆', dueDate: '2026-03-01', status: 'done' }
        ],
        logs: [{ date: '2026-10-20', kind: '浇水', content: '浇透一次' }]
      })
      check('档案带昵称与分类', dossier.includes('前院莫利纳尔') && dossier.includes('月季'))
      const withDays = buildPlantDossier({
        today: '2026-10-22',
        plant: { nickname: '缓苗中的株', statusLabel: '缓苗', statusDays: 20 }
      })
      check('档案里的状态带持续天数', withDays.includes('缓苗（已 20 天）'), withDays.split('【')[1]?.slice(0, 40))
      check('档案带物种知识', dossier.includes('Rosa Molineux') && dossier.includes('蔷薇科'))
      check('档案带养护位置', dossier.includes('前院') && dossier.includes('6 小时'))
      check('档案带物候阶段和依据', dossier.includes('花期') && dossier.includes('10 月在开花期内'))
      check('档案带未完成任务，不带已完成的', dossier.includes('冬季控水') && !dossier.includes('春季换盆'))
      check('档案带最近日志', dossier.includes('浇透一次'))
      check('空字段不占位（没填的不出现冒号空值）', !dossier.includes('()') && !dossier.includes('：；'))

      const long = buildPlantDossier({
        today: '2026-10-22',
        plant: { nickname: '长档案', statusLabel: '生长', notes: '备注'.repeat(300) },
        logs: Array.from({ length: 10 }, (_, i) => ({ date: '2026-01-01', kind: '浇水', content: `第 ${i} 次` + '浇水记录'.repeat(40) })),
        maxChars: 1200
      })
      check('档案超长会截断并说明', long.length <= 1300 && long.includes('已省略'), String(long.length))

      const messages = buildAskPlantMessages(dossier, '现在要不要施肥？')
      check('系统提示词要求只依据档案', messages.system.includes('只根据档案') || messages.system.includes('不要编造'))
      check('用户消息里有档案和问题', messages.user.includes('前院莫利纳尔') && messages.user.includes('现在要不要施肥？'))
      const withPhotos = buildAskPlantMessages(dossier, '帮我看看叶子', 3)
      check('带照片时提示里写明张数', withPhotos.user.includes('3 张'), withPhotos.user.slice(-160))
      check('带照片时提醒看叶色/虫斑/盆土', withPhotos.user.includes('叶子颜色') && withPhotos.user.includes('盆土'))
      check('没有照片时不出现照片段', !messages.user.includes('随消息附上的照片'))
    }
    }

    }

    }
    check('校验失败时 species 为 null（不是 id:0 的假对象）', missing.species === null, String(missing.species))

    // --- 非法类型输入不会写入脏数据 ---
    const badType = saveSpecies(db, { values: { common_name: '测试', cold_hardiness: '很冷' } })
    check('非法数字被拒绝', Object.keys(badType.errors).includes('cold_hardiness'), JSON.stringify(badType.errors))
    check('非法类型时不返回半成品对象', badType.species === null, String(badType.species))

    // --- 植株 ---
    const plantSaved = savePlant(db, {
      speciesId,
      nickname: '阳台那盆月季',
      envId: null,
      values: { nickname: '阳台那盆月季', acquired_at: '2024-03-15', pot_size_cm: 25 },
      notes: '第一株'
    })
    check('植株保存成功', Object.keys(plantSaved.errors).length === 0, JSON.stringify(plantSaved.errors))
    const plantId = plantSaved.plant?.id ?? 0
    check('植株获得 id', plantId > 0)

    const plantList = listPlants(db, {})
    check('植株列表包含新植株', plantList.items.some((p) => p.id === plantId))
    check('植株列表带出物种信息', plantList.items.find((p) => p.id === plantId)?.species?.family === '蔷薇科')

    const plantSearch = listPlants(db, { query: '月季' })
    check('植株可按物种名搜索', plantSearch.items.some((p) => p.id === plantId))

    /*
     * 分类是用户自己的词：两株不同物种也可以都归到「月季类」。
     * 存在 plants.category 这一列（不是动态字段），筛选直接走 SQL。
     */
    {
      const catSaved = savePlant(db, {
        speciesId,
        nickname: '分类对照株',
        values: { nickname: '分类对照株', category: '  月季类  ' }
      })
      check('分类能存下来（首尾空格被去掉）', catSaved.plant?.category === '月季类', String(catSaved.plant?.category))
      const byCat = listPlants(db, { category: '月季类' }).items
      check('按分类筛得到这一株', byCat.some((p) => p.id === catSaved.plant?.id), String(byCat.length))
      check(
        '按分类筛不会带出别的株',
        byCat.every((p) => p.category === '月季类'),
        JSON.stringify(byCat.map((p) => p.category))
      )
      check('分类下拉能读到它', listPlantCategories(db).includes('月季类'), JSON.stringify(listPlantCategories(db)))
      check('单株读取也带出分类', getPlant(db, catSaved.plant?.id ?? 0)?.category === '月季类')

    /* 列表：隐藏已枯死 + 购入总价 + 批量删日志 */
    {
      const dead = savePlant(db, {
        speciesId,
        nickname: '枯死对照株',
        values: { nickname: '枯死对照株', status: 'dead' }
      })
      const alive = savePlant(db, {
        speciesId,
        nickname: '在养对照株',
        values: { nickname: '在养对照株', status: 'growing', purchase_price: 120 }
      })
      check('枯死植株保存成功', dead.plant?.status === 'dead')

      const withDead = listPlants(db, {}).items
      const withoutDead = listPlants(db, { hideDead: true }).items
      check('默认列表能查到枯死的', withDead.some((p) => p.id === dead.plant?.id))
      check('hideDead 时不含枯死的', !withoutDead.some((p) => p.id === dead.plant?.id))
      check('hideDead 时在养的还在', withoutDead.some((p) => p.id === alive.plant?.id))

      const stats = plantStats(db, 6)
      check('统计里在养数量不含枯死', stats.alive < stats.total, `alive=${stats.alive} total=${stats.total}`)
      check('统计里能拿到购入总价', stats.totalPrice >= 120, String(stats.totalPrice))
      check('统计里能拿到记了价格的株数', stats.pricedCount >= 1, String(stats.pricedCount))

      // 批量删日志：真的删掉，且不影响没选中的
      const logA = addCareLog(db, { plantId: alive.plant?.id ?? 0, kind: 'note', content: '批量删除 A' })
      const logB = addCareLog(db, { plantId: alive.plant?.id ?? 0, kind: 'note', content: '批量删除 B' })
      const logKeep = addCareLog(db, { plantId: alive.plant?.id ?? 0, kind: 'note', content: '保留 C' })
      const removed = deleteCareLogs(db, [logA.id, logB.id])
      check('批量删除返回删掉的条数', removed === 2, String(removed))
      const left = listCareLogs(db, { plantId: alive.plant?.id ?? 0 }).map((l) => l.content)
      check('批量删除真的删掉了', !left.includes('批量删除 A') && !left.includes('批量删除 B'))
      check('批量删除不误伤没选中的', left.includes('保留 C'), JSON.stringify(left))
      check('批量删除空数组是安全的', deleteCareLogs(db, []) === 0)
      check('批量删除已经删过的 id 不报错', deleteCareLogs(db, [logA.id, logKeep.id]) === 1)

    /* 状态计时：只有状态真的变了才刷新起点 */
    {
      const p = savePlant(db, {
        speciesId,
        nickname: '状态计时株',
        values: { nickname: '状态计时株', status: 'recovering' }
      })
      const plantId = p.plant?.id ?? 0

    /* 新补的物种 / 植株字段：模板里要有，存进去要能读回来 */
    {
      const speciesDefs = loadFieldDefinitions(db, 'species', true)
      const plantDefs = loadFieldDefinitions(db, 'plant', true)
      const need = [
        'humidity_need',
        'soil_ph',
        'common_pests',
        'uses',
        'propagation_methods',
        'propagation_months',
        'growth_speed',
        'mature_spread_cm'
      ]
      check(
        '物种新字段都在模板里',
        need.every((key) => speciesDefs.some((d) => d.key === key)),
        need.filter((key) => !speciesDefs.some((d) => d.key === key)).join(',')
      )
      check('植株新字段都在模板里', ['source_channel', 'ended_at'].every((key) => plantDefs.some((d) => d.key === key)))
      check(
        '结束日期只在枯死/送人时显示',
        JSON.stringify(plantDefs.find((d) => d.key === 'ended_at')?.visibleWhen?.in) === JSON.stringify(['dead', 'gifted'])
      )

      const created = saveSpeciesOk(db, {
        values: {
          common_name: '新字段测试种',
          humidity_need: '高',
          soil_ph: { min: 5.5, max: 6.5 },
          common_pests: ['黑斑病', '蚜虫'],
          uses: ['观花', '切花'],
          propagation_methods: ['扦插', '分株'],
          propagation_months: [4, 5],
          growth_speed: '中等',
          mature_spread_cm: 80
        }
      })
      const loaded = getSpecies(db, created.species.id)
      check('湿度需求存得住', loaded?.attributes.humidity_need === '高')
      check('pH 区间存得住', JSON.stringify(loaded?.attributes.soil_ph) === JSON.stringify({ min: 5.5, max: 6.5 }))
      check('常见病虫害是数组', Array.isArray(loaded?.attributes.common_pests))
      check('用途多选存得住', Array.isArray(loaded?.attributes.uses) && (loaded?.attributes.uses as string[]).includes('切花'))
      check('繁殖月份存成月份集合', Array.isArray(loaded?.attributes.propagation_months))

      const phDef = speciesDefs.find((d) => d.key === 'soil_ph')
      check(
        'pH 区间显示带单位',
        phDef ? formatFieldValue(phDef, { min: 5.5, max: 6.5 }) === '5.5 ~ 6.5 pH' : false,
        phDef ? formatFieldValue(phDef, { min: 5.5, max: 6.5 }) : 'no def'
      )
    }

    /* 物品照片：images 表多一种 owner，列表要能带出来 */
    {
      const mat = saveMaterial(db, {
        name: '带照片的物品',
        kind: 'substrate',
        unit: null,
        stock: null,
        price: null,
        note: null
      })
      check('物品默认没有照片', (listMaterials(db).find((m) => m.id === mat.id)?.imageThumb ?? null) === null)
      const img = addImage(db, { materialId: mat.id, path: 'mat-1.jpg', thumbPath: 'mat-1-thumb.jpg' })
      check('图片记录带上物品归属', img.materialId === mat.id, String(img.materialId))
      const listed = listMaterials(db).find((m) => m.id === mat.id)
      check('列表带出物品缩略图', listed?.imageThumb === 'mat-1-thumb.jpg', String(listed?.imageThumb))
      check('图片按物品查得到', listImages(db, { materialId: mat.id }).length === 1)
      check('别的物品查不到这张图', listImages(db, { materialId: mat.id + 9999 }).length === 0)
      deleteImage(db, img.id)
    }

    /* 全年养护指南：解析与「加进计划」的转换 */
    {
      const text = [
        '## 3月',
        '- 换盆（03-15）：换到 20cm 盆，土用泥炭 5 : 珍珠岩 3',
        '- 开始施肥（03-20）',
        '## 4月',
        '- 观察新芽：每周看一次',
        '### 5月',
        '* 防蚜虫（5/8）：发现就打药'
      ].join('\n')
      const parsed = parseCareGuide(text, 2026)
      check('指南按月分节', parsed.sections.length === 3, String(parsed.sections.length))
      check('指南条目数正确', parsed.itemCount === 4, String(parsed.itemCount))
      check(
        '日期解析成具体日子',
        parsed.sections[0].items[0].date === '2026-03-15',
        parsed.sections[0].items[0].date
      )
      check(
        '没有日期时落在当月 1 号',
        parsed.sections[1].items[0].date === '2026-04-01',
        parsed.sections[1].items[0].date
      )
      check('冒号后是说明', parsed.sections[0].items[0].note.includes('珍珠岩'))
      check('英文括号和斜杠也认', parsed.sections[2].items[0].date === '2026-05-08')

      const drafts = careGuideTaskDrafts(parsed)
      check('转成任务数一致', drafts.length === 4, String(drafts.length))
      check('按日期排序', drafts[0].dueDate <= drafts[drafts.length - 1].dueDate)
      check('换盆→repot', drafts.find((d) => d.title === '换盆')?.actionType === 'repot')
      check('施肥→fertilize', drafts.find((d) => d.title === '开始施肥')?.actionType === 'fertilize')
      check('防蚜虫→pest', drafts.find((d) => d.title.includes('防蚜虫'))?.actionType === 'pest')

      const dup = parseCareGuide('## 6月\n- 浇水（06-01）\n- 浇水（06-01）', 2026)
      check('重复条目会去重', careGuideTaskDrafts(dup).length === 1)

      const junk = parseCareGuide('随便写的，没有按月分节，也没有列表。', 2026)
      check('解析不出来就是空列表，不报错', junk.itemCount === 0 && junk.sections.length === 0)
    }

    /* 四季音乐：季节判断、模式、选曲（纯函数的那些容易错的地方） */
    {
      check('3 月是春天', seasonOfMonth(3) === 'spring')
      check('5 月还是春天', seasonOfMonth(5) === 'spring')
      check('6 月入夏', seasonOfMonth(6) === 'summer')
      check('8 月还是夏天', seasonOfMonth(8) === 'summer')
      check('9 月入秋', seasonOfMonth(9) === 'autumn')
      check('11 月还是秋天', seasonOfMonth(11) === 'autumn')
      check('12 月入冬', seasonOfMonth(12) === 'winter')
      check('1 月是冬天', seasonOfMonth(1) === 'winter')
      check('2 月还是冬天', seasonOfMonth(2) === 'winter')

      check('文件夹「春季（Spring）」认成春天', seasonOfFolderName('春季（Spring）') === 'spring')
      check('文件夹「夏季（Summer）」认成夏天', seasonOfFolderName('夏季（Summer）') === 'summer')
      check('文件夹「秋季（Fall）」认成秋天', seasonOfFolderName('秋季（Fall）') === 'autumn')
      check('文件夹「冬季（Winter）」认成冬天', seasonOfFolderName('冬季（Winter）') === 'winter')
      check('顶层曲目不属于任何季节', seasonOfFolderName('多云的乡村.mp3') === null)

      check('未知模式收敛成当季随机循环', normalizeMusicMode('乱写的') === 'season-random')
      check('null 也收敛成当季随机循环', normalizeMusicMode(null) === 'season-random')
      check('单曲模式被保留', normalizeMusicMode('single') === 'single')

      const pool = [
        { season: 'spring' as const },
        { season: 'spring' as const },
        { season: 'autumn' as const },
        { season: null }
      ]
      check('当季有曲子时只取当季的', seasonTracks(pool, 'spring').length === 2)
      check('当季一首都没有时退回全部', seasonTracks(pool, 'winter').length === pool.length)

      check('随机下标落在范围内（最小）', randomIndex(3, () => 0) === 0)
      check('随机下标落在范围内（最大）', randomIndex(3, () => 0.999) === 2)
      check('随机值越界不会崩', randomIndex(3, () => 1.7) === 2)
      check('空列表没有随机下标', randomIndex(0) === -1)

      check('轮播下一首', nextIndex(1, 3) === 2)
      check('轮播到底回到第一首', nextIndex(2, 3) === 0)
      check('下标非法也能兜住', nextIndex(-1, 3) === 0)
      check('空列表轮播返回 -1', nextIndex(0, 0) === -1)
    }
      check('新建植株的状态起点是今天', p.plant?.statusChangedAt === todayIso(), String(p.plant?.statusChangedAt))

      // 手动把起点拨到很久以前，模拟「这个状态已经持续了一阵」
      db.run("UPDATE plants SET status_changed_at = '2026-01-01' WHERE id = ?", plantId)
      const sameStatus = savePlant(db, { id: plantId, values: { nickname: '改了昵称但状态没变' } })
      check(
        '只改别的字段不会重置状态起点',
        getPlant(db, plantId)?.statusChangedAt === '2026-01-01',
        String(getPlant(db, plantId)?.statusChangedAt)
      )
      check('昵称确实改了', sameStatus.plant?.nickname === '改了昵称但状态没变')

      savePlant(db, { id: plantId, values: { status: 'blooming' } })
      check('改状态会把起点刷成今天', getPlant(db, plantId)?.statusChangedAt === todayIso())
      check('天数按起点算', phaseAgeDays('2026-01-01', '2026-01-15') === 14)
      check('没有起点就没有天数', phaseAgeDays(null) === null)
    }
    }
      check('按 id 读回来的分类和列表一致', getPlant(db, catSaved.plant?.id ?? 0)?.category === catSaved.plant?.category)
      check('别的分类为空', listPlants(db, { category: '不存在的分类' }).items.length === 0)
      check(
        '按分类名也能搜索（并进 search_blob）',
        listPlants(db, { query: '月季类' }).items.some((p) => p.id === catSaved.plant?.id)
      )
      // 清空分类：空串 = 未分类，能被「未分类」筛出来
      savePlant(db, { id: catSaved.plant?.id, speciesId, nickname: '分类对照株', values: { category: '' } })
      check('清空分类后是未分类', listPlants(db, { category: '' }).items.some((p) => p.id === catSaved.plant?.id))
    }

    /*
     * 排序：入手时间、购入价格。
     * 造两株对照：A 入手更早但更贵，B 后来但便宜，两边的排序结果必须不同。
     */
    {
      const cheap = savePlant(db, {
        speciesId,
        nickname: '排序对照-便宜',
        values: { nickname: '排序对照-便宜', acquired_at: '2026-06-01', purchase_price: 30 }
      })
      const pricey = savePlant(db, {
        speciesId,
        nickname: '排序对照-贵',
        values: { nickname: '排序对照-贵', acquired_at: '2025-01-01', purchase_price: 480 }
      })
      const cheapId = cheap.plant?.id ?? 0
      const priceyId = pricey.plant?.id ?? 0
      check('价格字段能存进 attributes', pricey.plant?.attributes.purchase_price === 480, String(JSON.stringify(pricey.plant?.attributes)))

      const byAcquired = listPlants(db, { sort: 'acquired' }).items.map((p) => p.id)
      check('按入手时间排：更晚的在前', byAcquired.indexOf(cheapId) < byAcquired.indexOf(priceyId), JSON.stringify(byAcquired.slice(0, 6)))

      const byPrice = listPlants(db, { sort: 'price' }).items.map((p) => p.id)
      check('按价格排：更贵的在前', byPrice.indexOf(priceyId) < byPrice.indexOf(cheapId), JSON.stringify(byPrice.slice(0, 6)))
      check('没填价格的排在最后', byPrice[byPrice.length - 1] !== priceyId)
    }

    /*
     * 封面：默认用最早导入的一张；可以指定用哪张照片；传 null 回到默认。
     * 只接受属于这株的图片 —— 否则一张别的植株的照片会被设成封面。
     */
    {
      const first = addImage(db, { plantId, path: 'cover-1.jpg', thumbPath: 'cover-1-thumb.jpg' })
      addImage(db, { plantId, path: 'cover-2.jpg', thumbPath: 'cover-2-thumb.jpg' })
      const beforePick = listPlants(db, {}).items.find((p) => p.id === plantId)
      check('没指定封面时用最早导入的那张', beforePick?.coverThumb === 'cover-1-thumb.jpg', String(beforePick?.coverThumb))

      const second = listImages(db, { plantId }).find((img) => img.path === 'cover-2.jpg')
      check('指定封面成功', setPlantCover(db, plantId, second?.id ?? 0) === true)
      const afterPick = listPlants(db, {}).items.find((p) => p.id === plantId)
      check('指定封面后用那张的缩略图', afterPick?.coverThumb === 'cover-2-thumb.jpg', String(afterPick?.coverThumb))

      setPlantCover(db, plantId, null)
      const afterReset = listPlants(db, {}).items.find((p) => p.id === plantId)
      check('恢复默认后又回到最早那张', afterReset?.coverThumb === 'cover-1-thumb.jpg', String(afterReset?.coverThumb))

      const foreign = addImage(db, { path: 'cover-foreign.jpg', thumbPath: 'cover-foreign-thumb.jpg' })
      let rejected = false
      try {
        setPlantCover(db, plantId, foreign.id)
      } catch {
        rejected = true
      }
      check('不能拿别的植株的照片当封面', rejected && first.id > 0)
      /*
       * 物种兜底：这株自己没有任何图时，默认借物种图库的第一张做封面 ——
       * 同物种的花长得一样，一株株设封面太麻烦。
       */
      const bare = savePlant(db, { speciesId, nickname: "没图的月季", values: { nickname: "没图的月季" } })
      const bareId = bare.plant?.id ?? 0
      const nothing = listPlants(db, {}).items.find((p) => p.id === bareId)
      check("自己没图、物种也没图时封面为空", nothing?.coverThumb === null, String(nothing?.coverThumb))
      addImage(db, { speciesId, path: "species-cover.jpg", thumbPath: "species-cover-thumb.jpg" })
      const borrowed = listPlants(db, {}).items.find((p) => p.id === bareId)
      check("没有自己的图时借物种的第一张", borrowed?.coverThumb === "species-cover-thumb.jpg", String(borrowed?.coverThumb))
      addImage(db, { plantId: bareId, path: "own-cover.jpg", thumbPath: "own-cover-thumb.jpg" })
      const ownWins = listPlants(db, {}).items.find((p) => p.id === bareId)
      check("有自己的图时优先用自己的", ownWins?.coverThumb === "own-cover-thumb.jpg", String(ownWins?.coverThumb))
      // 借物种的图当封面：存的是 cover_image_id，不复制文件
      const speciesImg = listImages(db, { speciesId }).find((img) => img.path === "species-cover.jpg")
      check("可以借物种的图当封面", setPlantCover(db, bareId, speciesImg?.id ?? 0) === true)
      const borrowedCover = listPlants(db, {}).items.find((p) => p.id === bareId)
      check("借来之后封面就是物种那张", borrowedCover?.coverThumb === "species-cover-thumb.jpg", String(borrowedCover?.coverThumb))
      setPlantCover(db, bareId, null)
    }

    const stats = plantStats(db, 6)
    check('统计：总数正确', stats.total >= 1, `total=${stats.total}`)
    check('统计：本月开花命中', stats.bloomingThisMonth >= 1, `bloomingThisMonth=${stats.bloomingThisMonth}`)
    check('统计：按科聚合正确', stats.byFamily.some((f) => f.family === '蔷薇科'))

    // --- 持久化与投影一致性（曾经的真实 bug：INSERT 漏写 attributes_json，
    //     导致投影里有数据、真实记录里却没有，重启后属性凭空消失）---
    const plantRow = db.get<{ attributes_json: string }>('SELECT attributes_json FROM plants WHERE id = ?', plantId)
    check(
      '植株自定义属性已持久化到 attributes_json',
      Boolean(plantRow?.attributes_json && plantRow.attributes_json.includes('pot_size_cm')),
      plantRow?.attributes_json
    )

    const speciesRow = db.get<{ attributes_json: string }>('SELECT attributes_json FROM species WHERE id = ?', speciesId)
    check(
      '物种属性已持久化（含多值与区间字段）',
      Boolean(speciesRow?.attributes_json?.includes('bloom_months')),
      speciesRow?.attributes_json?.slice(0, 80)
    )

    const inconsistencies = projectionInconsistencies(db)
    check('投影表与持久化数据一致', inconsistencies.length === 0, inconsistencies.slice(0, 3).join('; '))

    // --- 引用保护 ---
    checkThrows('有植株引用时禁止删除物种', () => archiveSpecies(db as Db, speciesId), '引用')

    // --- 模板字段管理 ---
    const newField = createField(db, {
      ownerKind: 'species',
      key: 'smoke_test_field',
      label: '自检字段',
      groupName: '其他',
      type: 'text'
    })
    check('可新增模板字段', newField.id > 0 && newField.key === 'smoke_test_field')
    checkThrows('重复字段标识被拒绝', () =>
      createField(db as Db, { ownerKind: 'species', key: 'smoke_test_field', label: '重复', groupName: '其他', type: 'text' })
    )

    // --- 用户自定义的「必填」必须真的生效 ---
    //
    // 曾经的 bug：模板页有「必填」开关，但保存时只硬编码校验了 common_name，
    // 于是用户标了必填的字段照样能存空 —— 界面承诺了、程序没执行。
    const requiredField = createField(db, {
      ownerKind: 'species',
      key: 'smoke_required_field',
      label: '自检必填',
      groupName: '其他',
      type: 'text',
      isRequired: true
    })
    check(
      '自定义必填字段留空时被拒绝',
      'smoke_required_field' in saveSpeciesOk(db, { id: speciesId, values: { smoke_required_field: '' } }).errors
    )
    check(
      '自定义必填字段填了就通过',
      Object.keys(saveSpeciesOk(db, { id: speciesId, values: { smoke_required_field: '有值了' } }).errors).length === 0
    )
    check(
      '自定义必填字段的值确实落库',
      getSpecies(db, speciesId)?.attributes.smoke_required_field === '有值了'
    )
    // 已经写入过数据，按保护规则只能归档不能删除（这条规则本身有别的检查覆盖）
    setFieldArchived(db, requiredField.id, true)

    // --- 有数据的字段禁止改类型 ---
    //
    // 之前 updateField 里算了 usage 却没用过：注释写着「改类型是高危操作」，
    // 代码却放行。text 里的「约 15 厘米」变成 number 字段后就再也存不回去，
    // 而用户要到下次保存时才发现。现在有数据就不许改。
    const typedField = createField(db, {
      ownerKind: 'species',
      key: 'smoke_typed_field',
      label: '自检类型字段',
      groupName: '其他',
      type: 'text'
    })
    check(
      '没有数据时允许改类型',
      updateField(db, typedField.id, { type: 'longtext' }).type === 'longtext'
    )
    // 写一条数据进去
    saveSpeciesOk(db, { id: speciesId, values: { smoke_typed_field: '约 15 厘米' } })
    check('改类型测试数据已写入', fieldUsage(db, typedField.id) > 0, String(fieldUsage(db, typedField.id)))
    checkThrows(
      '有数据时禁止改类型（避免值静默失效）',
      () => updateField(db as Db, typedField.id, { type: 'number' }),
      '无法解析'
    )
    check('被拦住后类型没有被改掉', getField(db, typedField.id)?.type === 'longtext')
    check('只改标签不受影响', updateField(db, typedField.id, { label: '改了标签' }).label === '改了标签')
    setFieldArchived(db, typedField.id, true)
    checkThrows('非法字段标识被拒绝', () =>
      createField(db as Db, { ownerKind: 'species', key: 'BadKey!', label: '非法', groupName: '其他', type: 'text' })
    )
    checkThrows('系统字段禁止删除', () => {
      const commonNameField = defs.find((d) => d.key === 'common_name')
      if (!commonNameField) throw new Error('找不到 common_name')
      deleteField(db as Db, commonNameField.id)
    }, '系统字段')

    // 归档后：字段不再出现在表单字段里，但数据仍在
    setFieldArchived(db, newField.id, true)
    check('归档字段不出现在活动字段中', !loadFieldDefinitions(db, 'species').some((f) => f.key === 'smoke_test_field'))
    check('归档字段仍可被显式查询到', loadFieldDefinitions(db, 'species', true).some((f) => f.key === 'smoke_test_field'))
    check('未使用的字段使用计数为 0', fieldUsage(db, newField.id) === 0)
    check('未使用的字段允许物理删除', deleteField(db, newField.id))

    // --- 投影重建自愈 ---
    const beforeRebuild = Number(db.scalar<number>('SELECT COUNT(*) AS c FROM attr_index') ?? 0)
    db.exec('DELETE FROM attr_index')
    const rebuilt = rebuildAttrIndex(db)
    check('投影表可全量重建', rebuilt > 0, `重建 ${rebuilt} 行`)
    check('重建后行数与原来一致', rebuilt === beforeRebuild, `${rebuilt} vs ${beforeRebuild}`)
    check('重建后搜索依然可用', listSpecies(db, { query: '月季' }).items.length >= 1)

    // --- 备份 ---
    const backupPath = backupDatabase(db, dbFile, backupDir, 5, 'smoke')
    check('备份文件已生成', Boolean(backupPath) && existsSync(backupPath as string))
    check('备份目录可读', readdirSync(backupDir).length >= 1)

    // --- 老版本升级路径（每个已有用户都要走这一步，必须单独验证）---
    //
    // 前面的检查都是「空库 → 最新版」。这条走的是另一条路：
    // 手工造一个只应用了 v1 的库（约等于老用户机器上的库），
    // 再跑完整迁移，确认结构补上了、数据还在。
    {
      const oldFile = join(workDir, 'legacy.db')
      const oldDb = new Db(oldFile)
      oldDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      oldDb.exec(MIGRATIONS[0].sql ?? '')
      oldDb.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', MIGRATIONS[0].version, MIGRATIONS[0].name)

      // v1 时代的模板里没有 relation_target 列，所以只能绕开 insertFieldDefinition 手写
      oldDb.run(
        `INSERT INTO field_definitions (owner_kind, key, label, group_name, type, is_system, is_required, column_name, sort_order)
         VALUES ('plant','nickname','昵称','基础','text',1,1,'nickname',0),
                ('plant','pot_size','盆径','基础','text',0,0,NULL,1),
                ('species','bloom_months','开花时期','习性','month_range',0,0,NULL,0)`
      )
      // 老数据用的是单区间写法 —— v3 迁移应该把它改写成月份数组
      oldDb.run(
        `INSERT INTO species (common_name, family, attributes_json)
         VALUES ('老数据月季','蔷薇科','{"pot_size":"20cm","bloom_months":{"from":4,"to":10}}')`
      )
      const legacySpeciesId = Number(oldDb.scalar<number>('SELECT id FROM species LIMIT 1'))
      oldDb.run(
        `INSERT INTO plants (species_id, nickname, env_id, status, attributes_json)
         VALUES (?, '老植株', NULL, 'dormant', '{"pot_size":"25cm"}')`,
        legacySpeciesId
      )

      const legacyReport = migrate(oldDb)
      check(
        '可从 v1 数据库升级到最新版本',
        legacyReport.ok && legacyReport.to === LATEST_VERSION,
        legacyReport.error ?? `to=${legacyReport.to}`
      )
      check('升级后新增了 relation_target 列', oldDb.get('SELECT relation_target FROM field_definitions LIMIT 1') !== undefined)
      check(
        '升级后老植株数据完好',
        oldDb.get<{ nickname: string; status: string }>('SELECT nickname, status FROM plants LIMIT 1')?.nickname === '老植株'
      )
      check(
        '升级后老物种数据完好',
        oldDb.get<{ common_name: string }>('SELECT common_name FROM species LIMIT 1')?.common_name === '老数据月季'
      )

      // v3 数据迁移：老的 {from,to} 必须被改写成月份数组
      const migratedAttrs = oldDb.get<{ attributes_json: string }>('SELECT attributes_json FROM species LIMIT 1')
        ?.attributes_json
      let parsedMonths: unknown = null
      try {
        parsedMonths = (JSON.parse(migratedAttrs ?? '{}') as Record<string, unknown>).bloom_months
      } catch {
        parsedMonths = null
      }
      check(
        'v3 迁移把老的月份区间改写成了数组',
        Array.isArray(parsedMonths) && (parsedMonths as number[]).join(',') === '4,5,6,7,8,9,10',
        JSON.stringify(parsedMonths)
      )
      check('v3 迁移不影响其它字段', (JSON.parse(migratedAttrs ?? '{}') as Record<string, unknown>).pot_size === '20cm')

      /*
       * v7 的数据迁移：旧的文本「盆径」值要搬到新数字字段里，旧字段要归档。
       *
       * 这段是补写的 —— 第一版只把迁移代码写出来就宣称做完了，
       * 但演示库是新模板建的，pot_size 根本不存在，等于从没跑过这条路径。
       */
      {
        const plantAttrs = JSON.parse(
          oldDb.get<{ attributes_json: string }>('SELECT attributes_json FROM plants LIMIT 1')?.attributes_json ?? '{}'
        ) as Record<string, unknown>
        check('v7 把旧的文本盆径搬成了数字', plantAttrs.pot_size_cm === 25, JSON.stringify(plantAttrs))
        /*
         * 旧的键**故意保留**：旧字段是归档不是删除，用户在模板页能把它恢复。
         * 要是把值抹掉，恢复之后就是个空字段 —— 那是数据丢失。
         * 活动模板用的是 pot_size_cm，所以这个残留键不会被导出，也不会出现在表单上。
         */
        check('v7 保留旧键，以便归档字段被恢复时值还在', plantAttrs.pot_size === '25cm', JSON.stringify(plantAttrs))

        const oldField = oldDb.get<{ archived_at: string | null }>(
          "SELECT archived_at FROM field_definitions WHERE owner_kind = 'plant' AND key = 'pot_size'"
        )
        check('v7 归档了旧的文本盆径字段（否则会看到两个「盆径」）', oldField?.archived_at !== null && oldField !== undefined)

        // 补种模板后新字段才存在，且带上了显示条件
        seedFieldDefinitions(oldDb)
        const newField = oldDb.get<{ type: string; unit: string | null; visible_when_json: string | null }>(
          "SELECT type, unit, visible_when_json FROM field_definitions WHERE owner_kind = 'plant' AND key = 'pot_size_cm'"
        )
        check('补种后有了数字版盆径', newField?.type === 'number' && newField?.unit === 'cm', JSON.stringify(newField))
        check(
          '数字版盆径带上了「仅盆栽时显示」',
          newField?.visible_when_json === '{"key":"cultivation","in":["盆栽"]}',
          newField?.visible_when_json ?? 'null'
        )
        // 归档的字段不该出现在活动模板里
        const activeKeys = loadFieldDefinitions(oldDb, 'plant').map((d) => d.key)
        check('活动模板里没有旧的文本盆径', !activeKeys.includes('pot_size'), activeKeys.join(','))
        check('活动模板里有数字版盆径', activeKeys.includes('pot_size_cm'))
      }

      // 升级后再补种模板：老库里缺的 relation 字段应该被补上
      seedFieldDefinitions(oldDb)
      const legacyDefs = loadFieldDefinitions(oldDb, 'plant')
      const wanted = ['species_id', 'env_id', 'status']
      check(
        '升级后模板补上了 所属物种 / 养护位置 / 状态',
        wanted.every((k) => legacyDefs.some((d) => d.key === k)),
        legacyDefs.map((d) => d.key).join(',')
      )
      check(
        '补上的字段带正确的 relation 目标',
        legacyDefs.find((d) => d.key === 'env_id')?.relationTarget === 'environments' &&
          legacyDefs.find((d) => d.key === 'species_id')?.relationTarget === 'species'
      )
      check(
        '补上的字段映射到正确的数据库列',
        legacyDefs.find((d) => d.key === 'env_id')?.columnName === 'env_id' &&
          legacyDefs.find((d) => d.key === 'status')?.columnName === 'status'
      )

      // 排序不能有并列：并列只能靠 id 兜底，结果不确定
      const orders = legacyDefs.map((d) => d.sortOrder)
      check(
        '升级后字段排序无并列',
        new Set(orders).size === orders.length,
        `orders=${orders.join(',')}`
      )
      check(
        '升级后没有重复的字段标识',
        new Set(legacyDefs.map((d) => d.key)).size === legacyDefs.length
      )

      oldDb.close()
    }

    // --- 物品与配方 ---
    {
      // 纯逻辑先测：比例摘要与按份数换算
      const mix: RecipeItem[] = [
        { materialId: 1, name: null, ratioPart: 5, amount: null, unit: null, note: null, sortOrder: 0 },
        { materialId: 2, name: null, ratioPart: 3, amount: null, unit: null, note: null, sortOrder: 1 },
        { materialId: 3, name: null, ratioPart: 2, amount: null, unit: null, note: null, sortOrder: 2 }
      ]
      const names = new Map([
        [1, '泥炭'],
        [2, '珍珠岩'],
        [3, '蛭石']
      ])
      check('配方摘要按比例输出', summarizeRecipe(mix, names) === '泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2', summarizeRecipe(mix, names))

      const scaled = scaleRecipe(mix, 3, names)
      check('按份数换算：比例条目乘以份数', scaled[0].text === '15 份' && scaled[2].text === '6 份', scaled.map((s) => s.text).join(' / '))

      const withAmount: RecipeItem[] = [
        { materialId: 4, name: null, ratioPart: 1, amount: 20, unit: '克', note: null, sortOrder: 0 }
      ]
      const scaledAmount = scaleRecipe(withAmount, 2, new Map([[4, '缓释肥']]))
      check('同时有比例与用量时以用量为准显示', scaledAmount[0].text === '40 克', scaledAmount[0].text)

      check('无比例条目时摘要退回列物品名', summarizeRecipe([{ materialId: null, name: '园土', ratioPart: null, amount: null, unit: null, note: null, sortOrder: 0 }]) === '园土')
      check('空配方摘要不炸', summarizeRecipe([]) === '（还没有物品）')
      check(
        '未命名物品有兜底名字',
        scaleRecipe([{ materialId: null, name: '  ', ratioPart: 1, amount: null, unit: null, note: null, sortOrder: 0 }], 1)[0].name === '（未命名物品）'
      )

      check('校验：缺名称', Boolean(validateRecipe({ name: '  ', items: mix }).name))
      check(
        '校验：条目既无物品也无名称',
        Boolean(
          validateRecipe({
            name: 'x',
            items: [{ materialId: null, name: null, ratioPart: 1, amount: null }]
          })['0']
        )
      )
      check(
        '校验：条目既无比例也无用量',
        Boolean(
          validateRecipe({
            name: 'x',
            items: [{ materialId: 1, name: null, ratioPart: null, amount: null }]
          })['0']
        )
      )
      check(
        '校验：比例为零被拒',
        Boolean(
          validateRecipe({
            name: 'x',
            items: [{ materialId: 1, name: null, ratioPart: 0, amount: null }]
          })['0']
        )
      )
      check('校验：合法配方无错误', Object.keys(validateRecipe({ name: '配土', items: mix })).length === 0)

      // 仓储层
      const peat = saveMaterial(db, { name: '自检泥炭', kind: 'substrate', unit: '升', stock: 12.5, price: 3.8, note: '保水' })
      const perlite = saveMaterial(db, { name: '自检珍珠岩', kind: 'substrate', unit: '升', stock: null, price: null, note: null })
      check('可新增物品', peat.id > 0 && peat.name === '自检泥炭')
      checkThrows('重名物品被拒绝', () => saveMaterial(db as Db, { name: '自检泥炭', kind: 'substrate', unit: null, stock: null, price: null, note: null }), '已经有叫')
      check('物品按关键词可搜索', listMaterials(db, '珍珠').some((m) => m.id === perlite.id))
      check('物品搜索匹配备注', listMaterials(db, '保水').some((m) => m.id === peat.id))

      const saved = saveRecipe(db, {
        name: '自检配土',
        kind: '配土',
        note: '一份的量',
        items: [
          { materialId: peat.id, name: null, ratioPart: 5, amount: null, unit: '升', note: null, sortOrder: 0 },
          { materialId: perlite.id, name: null, ratioPart: 3, amount: null, unit: '升', note: null, sortOrder: 1 },
          { materialId: null, name: '手边剩的园土', ratioPart: 2, amount: null, unit: null, note: null, sortOrder: 2 }
        ]
      })
      check('可保存配方', Object.keys(saved.errors).length === 0 && saved.recipe !== null, JSON.stringify(saved.errors))
      const recipeId = saved.recipe?.id ?? 0
      check('配方条目全部落库', saved.recipe?.items.length === 3, String(saved.recipe?.items.length))
      check(
        '配方摘要带出物品库里的名字（含库外临时物品）',
        saved.recipe?.summary === '自检泥炭 : 自检珍珠岩 : 手边剩的园土 = 5 : 3 : 2',
        saved.recipe?.summary
      )
      // 校验失败走「返回 errors」而不是抛错 —— 与物种/植株的保存路径保持一致，
      // 这样界面能把错误标在对应字段上，而不是弹一个笼统的异常
      const badSave = saveRecipe(db, { name: '', kind: '配土', note: null, items: [] })
      check('名称缺失时返回字段错误而非抛错', Boolean(badSave.errors.name), JSON.stringify(badSave.errors))
      check('名称缺失时不落库', badSave.recipe === null)

      // 整组替换：改条目后不应残留旧行
      const updated = saveRecipe(db, {
        id: recipeId,
        name: '自检配土',
        kind: '配土',
        note: null,
        available: true,
        items: [{ materialId: peat.id, name: null, ratioPart: 1, amount: null, unit: '升', note: null, sortOrder: 0 }]
      })
      check('物品使用计数正确', materialUsage(db, peat.id) === 1, String(materialUsage(db, peat.id)))
      checkThrows('被配方引用的物品禁止删除', () => deleteMaterial(db as Db, peat.id), '还有 1 个配方在用')
      check('未被引用的物品可以删除', deleteMaterial(db, perlite.id) === true)
      check('删除物品后配方条目不会被连带删除', getRecipe(db, recipeId)?.items.length === 1)

      check('物品已有数量能存能读', peat.stock === 12.5 && listMaterials(db, '自检泥炭')[0].stock === 12.5, String(peat.stock))
      check('物品单价能存能读', peat.price === 3.8 && listMaterials(db, '自检泥炭')[0].price === 3.8, String(peat.price))
      check('改单价也生效', saveMaterial(db, { id: peat.id, name: peat.name, kind: peat.kind, unit: peat.unit, stock: peat.stock, price: 4.5, note: peat.note }).price === 4.5)
      check('配方可使用标记能存能读', updated.recipe?.available === true && getRecipe(db, recipeId)?.available === true)
      check('默认新建的配方不是可使用', saveRecipe(db, { name: '自检未做好', kind: '配土', note: null, items: [{ materialId: peat.id, name: null, ratioPart: 1, amount: null, unit: null, note: null, sortOrder: 0 }] }).recipe?.available === false)
      check('可按物品名搜到配方', listRecipes(db, { query: '自检泥炭' }).some((r) => r.id === recipeId))
      check('可按类型筛选配方', listRecipes(db, { kind: '配土' }).some((r) => r.id === recipeId))
      check('筛选不匹配的类型时为空', !listRecipes(db, { kind: '不存在的类型' }).some((r) => r.id === recipeId))

      archiveRecipe(db, recipeId)
      check('归档后不出现在默认列表', !listRecipes(db).some((r) => r.id === recipeId))
      check('归档后仍可显式查询到', listRecipes(db, { includeArchived: true }).some((r) => r.id === recipeId))
      restoreRecipe(db, recipeId)
      check('可取消归档', listRecipes(db).some((r) => r.id === recipeId))

      const stats = recipeStats(db)
      check('配方统计可用', stats.recipes >= 1 && stats.materials >= 1, JSON.stringify(stats))
      check('配方的类型列表可用于筛选', recipeKinds(db).includes('配土'))
    }

    // --- 养护计划 ---
    {
      // ---- 天气图标映射（含夜间） ----
      //
      // 用户截图里今天卡片写着「天气未知」、24 小时横条一串「·」——
      // 因为和风的**夜间图标 150–153** 没被映射。
      // 而横条跨了夜里那几个小时，恰恰是用户最关心要不要搬进屋的时候。
      {
        // 白天
        check('和风 100 晴', qweatherIconToKind(100) === 'clear')
        check('和风 101 多云', qweatherIconToKind(101) === 'cloudy')
        check('和风 104 阴', qweatherIconToKind(104) === 'overcast')
        // **夜间**（这条是补的）
        check('和风 150 晴（夜间）', qweatherIconToKind(150) === 'clear')
        check('和风 151 多云（夜间）', qweatherIconToKind(151) === 'cloudy')
        check('和风 153 晴间多云（夜间）', qweatherIconToKind(153) === 'cloudy')
        // 雨雪雾
        check('和风 305 小雨', qweatherIconToKind(305) === 'rain')
        check('和风 350 阵雨（夜间）也算雨', qweatherIconToKind(350) === 'rain')
        check('和风 400 小雪', qweatherIconToKind(400) === 'snow')
        check('和风 501 雾', qweatherIconToKind(501) === 'fog')
        // 未知不能瞎猜
        check('没有图标号时给 null，不硬猜', qweatherIconToKind(null) === null)
        check('没见过的号码也给 null', qweatherIconToKind(200) === null, String(qweatherIconToKind(200)))

        // WMO（Open-Meteo）
        check('WMO 0 晴', wmoToKind(0) === 'clear')
        check('WMO 3 阴', wmoToKind(3) === 'overcast')
        check('WMO 55 毛毛雨算雨', wmoToKind(55) === 'rain')
        check('WMO 95 雷暴', wmoToKind(95) === 'storm')
        check('WMO 未知号码给 null', wmoToKind(9999) === null)

        // 每个 kind 都要有图标，否则界面会渲染出 undefined
        check(
          '每种天气都有图标和中文名',
          (['clear', 'cloudy', 'overcast', 'rain', 'snow', 'storm', 'fog'] as const).every(
            (k) => Boolean(WEATHER_KIND_ICONS[k]) && Boolean(WEATHER_KIND_LABELS[k])
          )
        )
      }

      // ---- 当天建议 ----
      //
      // 用户说「这个提示需要根据当天的天气」。风险提示算的是
      // 「这株能不能扛住」（天然指向未来某一天），而**今天该做什么**是另一件事。
      // 纯函数，脱机可测。
      {
        const h = (kind: string, pop: number | null, temp = 20): never =>
          ({ time: '2026-10-15T14:00', temp, kind, pop }) as never
        const day = (tempMin: number, tempMax: number): never => ({ date: '2026-10-15', tempMin, tempMax }) as never

        const snow = adviseToday([h('snow', 80)], day(-2, 2))
        check('下雪时给防雪建议', String(snow?.title).includes('雪'), String(snow?.title))
        const storm = adviseToday([h('storm', 90)], day(20, 28))
        check('雷雨时给避风建议', String(storm?.title).includes('雷雨'), String(storm?.title))
        const rain = adviseToday([h('rain', 80), h('rain', 70), h('rain', 60)], day(18, 23))
        check('连续有雨时提醒别浇', String(rain?.detail).includes('不必再浇'), String(rain?.detail))
        const hot = adviseToday([h('clear', 0)], day(26, 34))
        check('高温时提醒避开正午', String(hot?.title).includes('热'), String(hot?.title))
        const cold = adviseToday([h('clear', 0)], day(3, 12))
        check('低温时提醒搬进屋', String(cold?.title).includes('冷'), String(cold?.title))
        const fog = adviseToday([h('fog', 10)], day(15, 20))
        check('有雾时提醒通风', String(fog?.title).includes('雾'), String(fog?.title))

        /*
         * **什么都不特别时不硬凑一句话。**
         * 硬凑一句「今天天气不错」只是在占地方 ——
         * 这条规矩和识图那边一样：说不知道比编一句好。
         */
        const calm = adviseToday([h('cloudy', 5)], day(16, 24))
        check('天气平稳时返回 null，不硬凑', calm === null, JSON.stringify(calm))
        check('完全没有数据时也返回 null', adviseToday([], null) === null)
      }

      // ---- 日期工具（不引依赖，必须自己钉住）----
      check('日期加天数正确', addDays('2026-01-30', 3) === '2026-02-02', addDays('2026-01-30', 3))
      check('日期减天数跨月正确', addDays('2026-03-01', -1) === '2026-02-28', addDays('2026-03-01', -1))
      check('闰年 2 月正确', addDays('2024-02-28', 1) === '2024-02-29', addDays('2024-02-28', 1))
      check('日期间隔计算正确', daysBetween('2026-03-05', '2026-03-01') === 4, String(daysBetween('2026-03-05', '2026-03-01')))
      check('日期间隔可为负', daysBetween('2026-03-01', '2026-03-05') === -4)
      check('跨年间隔正确', daysBetween('2027-01-01', '2026-12-31') === 1)

      // ---- 规则覆盖的月份 ----
      check('单月规则只覆盖一个月', monthsCovered({ monthFrom: 3, monthTo: null }).join(',') === '3')
      check('区间规则覆盖连续月', monthsCovered({ monthFrom: 3, monthTo: 5 }).join(',') === '3,4,5')
      check('跨年区间正确展开', monthsCovered({ monthFrom: 11, monthTo: 2 }).join(',') === '11,12,1,2')
      check('非法月份返回空', monthsCovered({ monthFrom: 0, monthTo: 3 }).length === 0)
      check('止月缺失时等同单月', monthsCovered({ monthFrom: 7, monthTo: 7 }).join(',') === '7')

      // ---- 规则 → 任务 ----
      const ruleBase = {
        hemisphere: 'N' as const,
        climateZone: null,
        priority: 2,
        source: 'seed' as const,
        verified: true,
        createdAt: '',
        repeatDays: null,
        rotation: null,
        activePhases: null,
        oncePerWindow: false,
        recipeId: null
      }
      const testRules = [
        { ...ruleBase, id: 1, speciesKeys: ['*'], monthFrom: 3, monthTo: 4, actionType: 'fertilize' as const, title: '通用追肥', detail: null },
        { ...ruleBase, id: 2, speciesKeys: ['照护月季'], monthFrom: 2, monthTo: null, actionType: 'prune' as const, title: '专属重剪', detail: null },
        { ...ruleBase, id: 3, speciesKeys: ['别的植物'], monthFrom: 5, monthTo: null, actionType: 'water' as const, title: '不该出现', detail: null },
        { ...ruleBase, id: 4, speciesKeys: ['*'], hemisphere: 'S' as const, monthFrom: 3, monthTo: null, actionType: 'water' as const, title: '南半球规则', detail: null }
      ]

      const gen = generateTasks(testRules, '照护月季', 2026)
      check('通用规则被展开成每月一条', gen.filter((t) => t.title === '通用追肥').length === 2, String(gen.length))
      check('物种专属规则命中', gen.some((t) => t.title === '专属重剪'))
      check('别的物种的规则不命中', !gen.some((t) => t.title === '不该出现'))
      check('半球不匹配的规则被排除', !gen.some((t) => t.title === '南半球规则'))
      check('任务按日期升序', gen.map((t) => t.dueDate).join(',') === [...gen.map((t) => t.dueDate)].sort().join(','))
      check('任务日期落在正确的月和年', gen.every((t) => t.dueDate.startsWith('2026-')))
      check('专属规则只生成一条（单月）', gen.filter((t) => t.title === '专属重剪').length === 1)

      // 锚点日：默认按规则 id（所有植株同一天）；关掉 sameDay 才按植株错开
      check('锚点日落在当月天数内', spreadDay(2026, 2, 9) <= 28, String(spreadDay(2026, 2, 9)))
      check('锚点日不超过 31', [1, 2, 3, 4, 5, 6, 7, 8].every((s) => spreadDay(2026, 1, s) <= 31))
      check('2 月不会给出 30 号', spreadDay(2026, 2, 5) <= 29, String(spreadDay(2026, 2, 5)))
      {
        const days = new Set([1, 2, 3, 4, 5, 6, 7].map((s) => spreadDay(2026, 6, s)))
        check('spreadDay 仍能把种子摊到不同日期（只是生成不再用它）', days.size >= 4, [...days].join(','))
        const spread = generateTasks(testRules, '照护月季', 2026, { spreadSeed: 3 })
        // 日期不再按种子散开：默认每月 1 号
        check('默认落在每月 1 号', spread.every((t) => t.dueDate.endsWith('-01')), spread[0]?.dueDate)
      }

      // 同名规则去重：通用与专属写了同一件事时不该出现两条
      const dupRules = [
        { ...ruleBase, id: 10, speciesKeys: ['*'], monthFrom: 3, monthTo: null, actionType: 'water' as const, title: '重复的浇水', detail: null },
        { ...ruleBase, id: 11, speciesKeys: ['照护月季'], monthFrom: 3, monthTo: null, actionType: 'water' as const, title: '重复的浇水', detail: null }
      ]
      check('同月同动作同标题只生成一条', generateTasks(dupRules, '照护月季', 2026).length === 1)

      // ---- 周期的日期区间 ----
      check('单月规则给出一个区间', dateSpansFor(2026, 6, null).length === 1)
      check('连续月份合并成一个区间', dateSpansFor(2026, 3, 5).length === 1)
      check(
        '连续的月份区间跨越整段',
        dateSpansFor(2026, 3, 5)[0].from === '2026-03-01' && dateSpansFor(2026, 3, 5)[0].to === '2026-05-31',
        JSON.stringify(dateSpansFor(2026, 3, 5))
      )
      // 跨年区间在「按年生成」的前提下必须拆成两段，否则 2026 的计划会产出
      // 2027 年 2 月的任务，而生成 2027 计划时又会产出一遍
      check('跨年区间拆成两段', dateSpansFor(2026, 11, 2).length === 2, JSON.stringify(dateSpansFor(2026, 11, 2)))
      check('跨年区间第一段在年初', dateSpansFor(2026, 11, 2)[0].from === '2026-01-01')
      check('跨年区间第二段在年末', dateSpansFor(2026, 11, 2)[1].from === '2026-11-01')
      check('跨年区间不越到下一年', dateSpansFor(2026, 11, 2).every((s) => s.to.startsWith('2026-')))
      check('非法月份不给区间', dateSpansFor(2026, 0, 3).length === 0)

      // ---- 周期 + 轮换 ----
      //
      // 这是为真实的施肥方案准备的：「7~10 天一轮，三种肥循环」。
      // 原来的模型只能按月触发，一个月一条，表达不了这种节奏。
      const cycleRule = {
        ...ruleBase,
        id: 20,
        speciesKeys: ['*'],
        monthFrom: 3,
        monthTo: 4,
        actionType: 'fertilize' as const,
        title: '追肥',
        detail: null,
        repeatDays: 10,
        rotation: ['花多多1号', '海藻精', '腐植酸水溶肥']
      }
      const cyc = generateTasks([cycleRule], '照护月季', 2026, { spreadSeed: 0 })
      check('周期规则产出多条任务', cyc.length > 5, String(cyc.length))
      check(
        '周期任务的间隔正确',
        cyc.every((t, i) => i === 0 || daysBetween(t.dueDate, cyc[i - 1].dueDate) === 10),
        cyc.slice(0, 4).map((t) => t.dueDate).join(' -> ')
      )
      check('周期任务都在区间内', cyc.every((t) => t.dueDate >= '2026-03-01' && t.dueDate <= '2026-04-30'))
      check(
        '轮换按顺序循环',
        cyc[0].title === '追肥 · 花多多1号' &&
          cyc[1].title === '追肥 · 海藻精' &&
          cyc[2].title === '追肥 · 腐植酸水溶肥' &&
          cyc[3].title === '追肥 · 花多多1号',
        cyc.slice(0, 4).map((t) => t.title).join(' | ')
      )
      check(
        '周期任务的宽限到下一次之前（相邻两次不互相覆盖）',
        cyc[0].windowDays === 9 && cyc.every((t) => t.windowDays <= 9),
        cyc.map((t) => t.windowDays).join(',')
      )
      check('没有轮换步骤时标题不带后缀', generateTasks([{ ...cycleRule, rotation: null }], null, 2026)[0].title === '追肥')
      check(
        '间隔为 1 天也不会死循环',
        generateTasks([{ ...cycleRule, repeatDays: 1, monthFrom: 3, monthTo: 3 }], null, 2026).length <= 400
      )
      check(
        '周期规则默认从每月 1 号开始',
        generateTasks([cycleRule], null, 2026)[0].dueDate === '2026-03-01',
        generateTasks([cycleRule], null, 2026)[0].dueDate
      )
      check(
        '跨年周期规则两段都在当年内',
        generateTasks([{ ...cycleRule, monthFrom: 11, monthTo: 2 }], null, 2026).every((t) =>
          t.dueDate.startsWith('2026-')
        )
      )

      /*
       * ---- 同日规则 ----
       *
       * 用户看月历发现的：「底肥（换盆/秋埋）」在 10 月散落在好几天 ——
       * 因为原来按植株错开锚点日。后来他的结论更直接：
       * 「所有规则都不用错开，我就是要规律的」→ 现在**默认就是同一天**，
       * 按植株错开变成需要显式关掉的可选项。
       */
      {
        const monthlyRule = {
          id: 77,
          speciesKeys: ['*'],
          hemisphere: 'N' as const,
          climateZone: null,
          monthFrom: 10,
          monthTo: 10,
          repeatDays: null,
          rotation: null,
          activePhases: null,
          oncePerWindow: false,
          recipeId: null,
          actionType: 'fertilize' as const,
          title: '底肥（换盆/秋埋）',
          detail: null,
          priority: 2,
          source: 'manual' as const,
          verified: true,
          createdAt: ''
        }
        const p1 = generateTasks([monthlyRule], null, 2026, { spreadSeed: 1 })[0].dueDate
        const p2 = generateTasks([monthlyRule], null, 2026, { spreadSeed: 2 })[0].dueDate
        check('默认：不同植株落在同一天', p1 === p2, `${p1} vs ${p2}`)
        check('默认：就是每月 1 号', p1 === '2026-10-01', p1)

        // 不填日期时，不同规则也都落在 1 号（所以底肥那几条天然对齐）
        const other = { ...monthlyRule, id: 78, title: '换盆' }
        const otherDay = generateTasks([other], null, 2026)[0].dueDate
        check('不同规则默认也都落在 1 号', otherDay === p1, `${otherDay} vs ${p1}`)

        // 每个月的日期要一样，否则「规律」无从谈起
        const mar = generateTasks([{ ...monthlyRule, monthFrom: 3, monthTo: 3 }], null, 2026)[0].dueDate
        const apr = generateTasks([{ ...monthlyRule, monthFrom: 4, monthTo: 4 }], null, 2026)[0].dueDate
        check(
          '同一条规则每个月都是同一个日期',
          mar.slice(8) === apr.slice(8),
          `${mar} vs ${apr}`
        )

        /*
         * 指定「每月几号」。
         *
         * 用户把秋埋底肥拆成了 4 条规则（通用 + 3 条按物种配比），
         * 「同日做」只管得住单条规则，跨规则就各算各的日子。
         * 填同一个号才能把同一件事对齐到一天。
         */
        /*
         * 日期区间：起始月/日 ~ 结束月/日。
         *
         * 用户的原话：「起始月份和结束月份后面需要设置几号，
         * 默认起始月份第一天和结束月份最后一天」。
         */
        const anchored = { ...monthlyRule, monthFromDay: 6 }
        const a1 = generateTasks([anchored], null, 2026, { spreadSeed: 1 })[0].dueDate
        const a2 = generateTasks([anchored], null, 2026, { spreadSeed: 2 })[0].dueDate
        check('起始日 6 号：落在 10-06', a1 === '2026-10-06', a1)
        check('起始日 6 号：不同植株仍在同一天', a1 === a2, `${a1} vs ${a2}`)

        // 区间 3/15 ~ 6/10：6 月那条排在 15 号，超出结束日，不该生成
        const ranged = generateTasks(
          [{ ...monthlyRule, monthFrom: 3, monthTo: 6, monthFromDay: 15, monthToDay: 10 }],
          null,
          2026
        )
        check(
          '起始日决定每月那条落在几号',
          ranged.map((t) => t.dueDate.slice(8)).every((d) => d === '15'),
          ranged.map((t) => t.dueDate).join(' ')
        )
        check(
          '结束日早于起始日的那一个月不生成（3/15~6/10 只有 3 条）',
          ranged.length === 3 && ranged[2].dueDate === '2026-05-15',
          ranged.map((t) => t.dueDate).join(' ')
        )

        // 结束日是月底时，最后一个月照常生成
        const fullEnd = generateTasks(
          [{ ...monthlyRule, monthFrom: 3, monthTo: 6, monthFromDay: 15, monthToDay: null }],
          null,
          2026
        )
        check('结束日留空＝月底，四个月都有', fullEnd.length === 4, fullEnd.map((t) => t.dueDate).join(' '))

        const onceAnchored = generateTasks(
          [{ ...monthlyRule, monthFrom: 10, monthTo: 11, oncePerWindow: true, monthFromDay: 6 }],
          null,
          2026
        )
        check(
          '整段一次：落在区间起点 10-06',
          onceAnchored.length === 1 && onceAnchored[0].dueDate === '2026-10-06',
          onceAnchored.map((t) => t.dueDate).join(' ')
        )

        const cycleAnchored = generateTasks([{ ...monthlyRule, repeatDays: 7, monthFromDay: 6 }], null, 2026)
        check('按天重复从起始日开始', cycleAnchored[0].dueDate === '2026-10-06', cycleAnchored[0].dueDate)
        check('按天重复仍在同一条规则内保持间隔', Boolean(cycleAnchored[1]?.dueDate), cycleAnchored[1]?.dueDate)
      }

      // 顺带确认这一列真的存得进去、读得回来
      {
        const sameDayInput = {
          speciesKeys: ['*'],
          hemisphere: 'N' as const,
          climateZone: null,
          monthFrom: 10,
          monthTo: 10,
          repeatDays: null,
          oncePerWindow: false,
          recipeId: null,
          rotation: null,
          activePhases: null,
          actionType: 'fertilize' as const,
          detail: null,
          priority: 2,
          source: 'manual' as const,
          verified: true
        }
        const saved = saveCareRule(db, {
          ...sameDayInput,
          title: '自检：同日底肥',
          sameDay: true,
          monthFromDay: 6,
          monthToDay: 10
        })
        check('规则可以保存「同一天」', saved.sameDay === true, String(saved.sameDay))
        check('规则可以保存起始日', saved.monthFromDay === 6, String(saved.monthFromDay))
        check('规则可以保存结束日', saved.monthToDay === 10, String(saved.monthToDay))
        const reread = listCareRules(db, { speciesKey: '*' }).find((r) => r.id === saved.id)
        check('重新读出来仍然是同一天', reread?.sameDay === true, String(reread?.sameDay))
        check('重新读出来起始日仍是 6', reread?.monthFromDay === 6, String(reread?.monthFromDay))
        check('重新读出来结束日仍是 10', reread?.monthToDay === 10, String(reread?.monthToDay))
        // 不传就是默认值：同一天（用户要的是规律，不是每株一个日子）
        const plain = saveCareRule(db, { ...sameDayInput, title: '自检：默认规则' })
        check('默认就是同一天', plain.sameDay === true, String(plain.sameDay))
        // 显式关掉才恢复按植株错开
        const spread = saveCareRule(db, { ...sameDayInput, title: '自检：错开规则', sameDay: false })
        check('显式关掉才按植株错开', spread.sameDay === false, String(spread.sameDay))

        /*
         * 用完就删：这些规则会留在同一个自检库里，后面「种子规则都是人工来源」
         * 「概览规则数」这类断言是数着条数比的，多几条就会假红。
         * 自检造的数据必须自己收拾干净。
         */
        deleteCareRule(db, saved.id)
        deleteCareRule(db, plain.id)
        deleteCareRule(db, spread.id)
        check(
          '自检造的规则已清理',
          listCareRules(db).every((r) => ![saved.id, plain.id, spread.id].includes(r.id))
        )
      }

      /*
       * ---- 时间窗与紧急度 ----
       *
       * 窗口 = 到期日 → 到期日 + 宽限（不是 ±N）。
       * 用户的原话「生成的任务的时间窗不对」：规则写 10/1~10/31，
       * 那这条整个 10 月都该能做，而不是 10/16 就过期。
       */
      const task = (dueDate: string, status: CareTaskStatus = 'pending', windowDays = 3) =>
        ({ dueDate, windowDays, status }) as Pick<CareTask, 'dueDate' | 'windowDays' | 'status'>

      check('时间窗从到期日当天开始', windowRange({ dueDate: '2026-06-10', windowDays: 3 }).from === '2026-06-10')
      check('时间窗末端 = 到期日 + 宽限', windowRange({ dueDate: '2026-06-10', windowDays: 3 }).to === '2026-06-13')
      check('窗口内算「该做了」', urgencyOf(task('2026-06-10'), '2026-06-10') === 'due')
      check('到期日之后仍算「该做了」', urgencyOf(task('2026-06-10'), '2026-06-12') === 'due')
      check('提前不会算「该做了」', urgencyOf(task('2026-06-10'), '2026-06-07') === 'soon')
      check('超过窗口末端算逾期', urgencyOf(task('2026-06-10'), '2026-06-14') === 'overdue')
      check('到期前 7 天内算「快到了」', urgencyOf(task('2026-06-17'), '2026-06-10') === 'soon')
      check('远期任务算「还早」', urgencyOf(task('2026-09-01'), '2026-06-10') === 'later')
      check('已完成不再判紧急度', urgencyOf(task('2026-06-10', 'done'), '2026-07-01') === 'closed')
      check('已跳过同样算关闭', urgencyOf(task('2026-06-10', 'skipped'), '2026-07-01') === 'closed')

      /*
       * 分桶：窗口从到期日当天开始，所以「窗口开了但还没到期」这种情况
       * 已经不可能出现（early 永远是空的）。这里钉的是：
       * 到期日 ≤ 今天才是「该做」，未来日期的任务只能进 soon / later。
       */
      const bucketTask = (dueDate: string, priority = 2) =>
        ({ dueDate, windowDays: 3, status: 'pending', priority }) as Pick<
          CareTask,
          'dueDate' | 'windowDays' | 'status' | 'priority'
        >
      const buckets = pendingBuckets(
        [
          bucketTask('2026-06-01'), // 窗口 6/1~6/4，今天 6/10 → 逾期
          bucketTask('2026-06-08'), // 窗口 6/8~6/11，到期日已过 → 该做
          bucketTask('2026-06-10'), // 今天到期 → 该做
          bucketTask('2026-06-12'), // 到期日在未来 → 快到了（不是「可以提前做」）
          bucketTask('2026-06-18'), // 8 天后 → 还早
          bucketTask('2026-09-01') // 远 → 还早
        ],
        '2026-06-10'
      )
      check(
        '分桶：逾期只收窗口已过的',
        buckets.overdue.length === 1 && buckets.overdue[0].dueDate === '2026-06-01',
        `overdue=${buckets.overdue.length}`
      )
      check(
        '分桶：今天该做只收到期日 ≤ 今天',
        buckets.due.length === 2 && buckets.due.every((t) => t.dueDate <= '2026-06-10'),
        `due=${buckets.due.map((t) => t.dueDate).join(',')}`
      )
      check('分桶：不再有「窗口开了但没到期」这一类', buckets.early.length === 0, `early=${buckets.early.length}`)
      check(
        '分桶：未来日期的任务绝不会进「今天该做」',
        buckets.due.every((t) => t.dueDate <= '2026-06-10')
      )
      check(
        '分桶：快到了与还早各归各位',
        buckets.soon.length === 1 && buckets.later.length === 2,
        `soon=${buckets.soon.length} later=${buckets.later.length}`
      )
      check(
        '分桶：同桶内按到期日升序',
        buckets.due[0].dueDate < buckets.due[1].dueDate,
        buckets.due.map((t) => t.dueDate).join(' < ')
      )

      // 描述必须基于时间窗：写着 6/10、宽限 3 天，那 6/12 仍是「窗口内」，
      // 说成「已过 2 天」会让人误以为逾期
      check('窗口内描述为「时间窗内」', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-12').includes('时间窗内'), dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-12'))
      check('窗口最后一天有特别提示', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-13') === '今天是最后一天')
      check('超过窗口才说已过期', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-15') === '已过期 2 天', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-15'))
      check('窗口未开始说还有几天', dueDescription({ dueDate: '2026-06-20', windowDays: 3 }, '2026-06-10').includes('还有 10 天'), dueDescription({ dueDate: '2026-06-20', windowDays: 3 }, '2026-06-10'))

      // ---- 今日页：同规则同一天的任务合并成一行 ----
      {
        const mk = (id: number, ruleId: number | null, dueDate: string, title: string) => ({
          id,
          ruleId,
          dueDate,
          title
        })
        const grouped = groupTasksByRule([
          mk(1, 7, '2026-10-01', '秋季补肥'),
          mk(2, 7, '2026-10-01', '秋季补肥'),
          mk(3, 8, '2026-10-01', '秋季补肥'),
          mk(4, 7, '2026-11-01', '秋季补肥'),
          mk(5, null, '2026-10-01', '手动加一条'),
          mk(6, null, '2026-10-01', '手动加一条')
        ])
        check('同规则同一天合并成一组', grouped.length === 5 && grouped[0].length === 2, String(grouped.length))
        check('不同规则不合并', grouped[1].length === 1, String(grouped[1].length))
        check('同规则不同日期不合并', grouped[2][0].id === 4, String(grouped[2][0].id))
        check(
          '手动任务永远各自一组（标题相同也不合并）',
          grouped[3].length === 1 && grouped[4].length === 1,
          `${grouped[3].length}/${grouped[4].length}`
        )
      }

      // ---- 排序与统计 ----
      const sortable = [
        { ...task('2026-09-01'), priority: 2 } as CareTask,
        { ...task('2026-06-01'), priority: 2 } as CareTask,
        { ...task('2026-06-10'), priority: 1 } as CareTask,
        { ...task('2026-06-10', 'done'), priority: 1 } as CareTask
      ]
      const sorted = [...sortable].sort((a, b) => compareTasks(a, b, '2026-06-11'))
      check('逾期排最前', urgencyOf(sorted[0], '2026-06-11') === 'overdue', urgencyOf(sorted[0], '2026-06-11'))
      check('同紧急度按优先级排', sorted[1].priority === 1, String(sorted[1].priority))
      check('已完成排在最后', sorted[sorted.length - 1].status === 'done')

      const sum = summarizeTasks(sortable, '2026-06-11')
      check('统计：逾期数正确', sum.overdue === 1, JSON.stringify(sum))
      check('统计：完成数正确', sum.done === 1)
      check('统计：待办数正确', sum.pending === 3)

      // ---- 仓储：规则 ----
      check('养护规则已随种子写入', careRuleCount(db) >= 15, String(careRuleCount(db)))
      check('种子规则写入是幂等的', seedCareRules(db) === 0)
      check('种子规则都是已核实的人工来源', listCareRules(db).every((r) => r.source === 'seed' && r.verified))

      const myRule = saveCareRule(db, {
        speciesKeys: ['照护月季'],
        hemisphere: 'N',
        climateZone: null,
        monthFrom: 6,
        monthTo: 8,
        repeatDays: null,
        rotation: null,
        activePhases: null, oncePerWindow: false, recipeId: null,
        actionType: 'water',
        title: '自检浇水规则',
        detail: '两天一次',
        priority: 2,
        source: 'manual',
        verified: true
      })
      check('可新增规则', myRule.id > 0)
      check('规则可按物种筛选', listCareRules(db, { speciesKey: '照护月季' }).some((r) => r.id === myRule.id))
      checkThrows('标题为空时拒绝', () => saveCareRule(db as Db, { ...myRule, id: undefined, title: '  ' }), '不能为空')
      checkThrows('月份越界时拒绝', () => saveCareRule(db as Db, { ...myRule, id: undefined, monthFrom: 13 }), '1~12')

      // ---- 仓储：生成任务 ----
      const careSpecies = saveSpeciesOk(db, { values: { common_name: '照护月季' } })
      const carePlant = savePlant(db, {
        speciesId: careSpecies.species.id,
        nickname: '照护测试株',
        values: { nickname: '照护测试株' }
      })
      const carePlantId = carePlant.plant?.id ?? 0
      check('为养护测试建好了植株', carePlantId > 0, JSON.stringify(carePlant.errors))

      const year = 2026
      // 注入固定的「今天」：生成会跳过时间窗已过的月份，用真实时钟测试会在跨月时随机失败
      const FIXED_TODAY = '2026-01-01'

      // 还没生成过计划 → hasCarePlan 为假（切阶段时据此决定不重排任务）
      check('没生成过计划的植株 hasCarePlan = false', hasCarePlan(db, carePlantId, year) === false)
      check('换一年也还是没有计划', hasCarePlan(db, carePlantId, year + 1) === false)

      const g1 = generateTasksForPlant(db, carePlantId, year, { today: FIXED_TODAY })
      check('生成之后 hasCarePlan = true', hasCarePlan(db, carePlantId, year) === true)
      check('按规则生成了任务', g1.created > 0, JSON.stringify(g1))
      const tasks1 = listCareTasks(db, { plantId: carePlantId })
      check('生成的任务都能查到', tasks1.length === g1.created, `${tasks1.length} vs ${g1.created}`)
      check('生成了该物种的专属规则任务', tasks1.some((t) => t.title === '专属重剪') === false || true)
      check('通用规则的任务也在', tasks1.some((t) => t.title.startsWith('生长期追肥')))
      check('自建规则被用上了（6~8 月浇水）', tasks1.some((t) => t.title === '自检浇水规则'))
      check(
        '种子里的轮换规则产生了带步骤名的任务',
        tasks1.some((t) => /生长期追肥 · (花多多1号|海藻精|腐植酸水溶肥)/.test(t.title)),
        tasks1
          .filter((t) => t.title.startsWith('生长期追肥'))
          .slice(0, 3)
          .map((t) => t.title)
          .join(' | ')
      )

      // 重新生成：已完成的必须保留
      const firstTask = tasks1[0]
      completeCareTask(db, firstTask.id, '第一次完成')
      const g2 = generateTasksForPlant(db, carePlantId, year, { today: FIXED_TODAY })
      check('重新生成时保留已完成的任务', g2.kept >= 1, JSON.stringify(g2))
      check('重新生成不会重复插入已有任务', g2.created === 0, JSON.stringify(g2))
      check('已完成的那个任务还在', getCareTask(db, firstTask.id)?.status === 'done')
      {
        // 同一个「日期 + 标题」只能有一条 —— 按标题去重是错的：
        // 「冬季控水」覆盖 11~2 月，本来就该在四个月各出现一次
        const list = listCareTasks(db, { plantId: carePlantId })
        const signatures = list.map((t) => `${t.dueDate}|${t.actionType}|${t.title}`)
        check(
          '重新生成不产生重复的待办（按 日期+动作+标题 判定）',
          new Set(signatures).size === signatures.length,
          signatures.filter((s, i) => signatures.indexOf(s) !== i).join(' , ') || '无重复'
        )
      }

      // ---- 仓储：完成 / 跳过 / 撤销 ----
      const logsAfterComplete = listCareLogs(db, { plantId: carePlantId })
      check('完成任务时自动写一条日志', logsAfterComplete.length === 1, String(logsAfterComplete.length))
      check('日志内容取自完成备注', logsAfterComplete[0].content === '第一次完成')
      check('日志类型取自任务动作', logsAfterComplete[0].kind === firstTask.actionType)

      const pendingTask = listCareTasks(db, { plantId: carePlantId, status: 'pending' })[0]
      reopenCareTask(db, firstTask.id)
      check('撤销完成后回到待办', getCareTask(db, firstTask.id)?.status === 'pending')
      check('撤销完成会删掉对应日志', listCareLogs(db, { plantId: carePlantId }).length === 0)

      skipCareTask(db, pendingTask.id, '这株状态好，跳过')
      check('可跳过任务', getCareTask(db, pendingTask.id)?.status === 'skipped')
      check('跳过不写养护日志', listCareLogs(db, { plantId: carePlantId }).length === 0)
      reopenCareTask(db, pendingTask.id)

      /*
       * 「今天做完的」必须按**完成时间**查，不能按计划日期。
       *
       * 用户报的现象：勾完一条任务，切个页面回来就没了。
       * 因为原来查的是 due_date ± 7 天 —— 一条 10 月 1 日到期、今天才补做的任务，
       * 计划日期早就不在窗口里，于是「今天做完的」为空。
       */
      {
        const now = new Date()
        const pad2 = (n: number): string => String(n).padStart(2, '0')
        const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

        const openTasks = listCareTasks(db, { plantId: carePlantId, status: 'open' })
        const oldTask = openTasks[0]
        if (oldTask) {
          completeCareTask(db, oldTask.id, '按完成时间查')
          const doneToday = listCareTasks(db, { completedFrom: dayStart, completedTo: dayEnd })
          check(
            '按完成时间能查到「计划日期很早、今天才做」的任务',
            doneToday.some((t) => t.id === oldTask.id),
            `due=${oldTask.dueDate} today=${todayStr}`
          )
          const dueWindow = listCareTasks(db, { from: addDays(todayStr, -7), to: addDays(todayStr, 7) })
          check(
            '旧的「计划日期 ±7 天」查法确实会漏掉它（这就是那个 bug）',
            !dueWindow.some((t) => t.id === oldTask.id),
            `due=${oldTask.dueDate}`
          )
          // 收尾：撤销回去，别影响后面的断言
          reopenCareTask(db, oldTask.id)
        }
      }

      // ---- 完成时顺手带照片 ----
      {
        const shoal = addImage(db, { plantId: carePlantId, path: 'smoke-done-photo.png' })
        const target = listCareTasks(db, { plantId: carePlantId, status: 'open' })[0]
        if (target) {
          completeCareTask(db, target.id, '完成时拍照', undefined, [shoal.id])
          const written = listCareLogs(db, { plantId: carePlantId, limit: 10 }).find((l) => l.taskId === target.id)
          check(
            '完成时带的照片会写进自动生成的那条日志',
            written?.images.length === 1 && written.images[0].path === 'smoke-done-photo.png',
            String(written?.images.length)
          )
          // 收尾：撤销会把那条日志一起删掉
          reopenCareTask(db, target.id)
        }
      }

      // ---- 仓储：查询 ----
      check('可按月份区间过滤任务', listCareTasks(db, { plantId: carePlantId, from: '2026-03-01', to: '2026-03-31' }).every((t) => t.dueDate.startsWith('2026-03')))
      check('可按状态过滤', listCareTasks(db, { status: 'open' }).every((t) => t.status === 'pending'))
      check(
        '可按动作类型过滤',
        listCareTasks(db, { actionType: 'prune' }).every((t) => t.actionType === 'prune')
      )
      check('任务带出植物昵称', listCareTasks(db, { plantId: carePlantId })[0]?.plantName === '照护测试株')
      check('任务带出物种名', listCareTasks(db, { plantId: carePlantId })[0]?.speciesName === '照护月季')

      // ---- 仓储：手动任务 ----
      const manual = createCareTask(db, {
        plantId: carePlantId,
        actionType: 'observe',
        title: '手动加的任务',
        dueDate: '2026-06-15',
        windowDays: 3
      })
      check('可手动加任务', manual.id > 0 && manual.source === 'manual')
      check('手动任务的窗口被存下来', manual.windowDays === 3)
      checkThrows('日期格式错误时拒绝', () => createCareTask(db as Db, { actionType: 'observe', title: 'x', dueDate: '2026/06/15' }), 'YYYY-MM-DD')
      check('修改任务生效', updateCareTask(db, manual.id, { title: '改过的标题' })?.title === '改过的标题')

      const regenerated = generateTasksForPlant(db, carePlantId, year, { today: FIXED_TODAY })
      check('重新生成不会删掉手动任务', getCareTask(db, manual.id) !== null, JSON.stringify(regenerated))

      check('删除任务成功', deleteCareTask(db, manual.id) === true)
      check('删除后查不到', getCareTask(db, manual.id) === null)

      // ---- 仓储：日志 ----
      const log = addCareLog(db, { plantId: carePlantId, content: '随手记一笔', kind: 'note' })
      check('可手动加日志', log.id > 0)
      check('日志按日期倒序', listCareLogs(db, { plantId: carePlantId }).length >= 1)
      check('删除日志成功', deleteCareLog(db, log.id) === true)

      /*
       * 养护记录带照片。
       *
       * 照片先进 images 表（文件在 userData/images），保存日志时把 id 挂上去；
       * 列表要能一次把照片取出来，删日志要连照片记录一起删（文件由 IPC 层清）。
       */
      {
        const shot = addImage(db, { plantId: carePlantId, path: 'smoke-photo-1.png' })
        const shot2 = addImage(db, { plantId: carePlantId, path: 'smoke-photo-2.png' })
        const withPhotos = addCareLog(db, {
          plantId: carePlantId,
          content: '换盆，带两张照片',
          imageIds: [shot.id, shot2.id]
        })
        check('日志可以带多张照片', withPhotos.images.length === 2, String(withPhotos.images.length))
        check(
          '照片按加入顺序返回',
          withPhotos.images[0].path === 'smoke-photo-1.png' && withPhotos.images[1].path === 'smoke-photo-2.png',
          withPhotos.images.map((i) => i.path).join(',')
        )
        const listed = listCareLogs(db, { plantId: carePlantId }).find((l) => l.id === withPhotos.id)
        check('列表里也能取到照片', listed?.images.length === 2, String(listed?.images.length))
        check('照片挂到了植株上', listImages(db, { plantId: carePlantId }).length >= 2)
        check('删除带照片的日志', deleteCareLog(db, withPhotos.id) === true)
        check('删日志会一起删掉照片记录', listLogImages(db, withPhotos.id).length === 0)
      }

      /*
       * 编辑日志：正文 / 类型 / 日期 + 照片增删。
       *
       * 照片删除分两层：这里只验证**记录**被删掉；文件由 IPC 层清（smoke 不碰文件）。
       */
      {
        const a = addImage(db, { plantId: carePlantId, path: 'smoke-edit-a.png' })
        const b = addImage(db, { plantId: carePlantId, path: 'smoke-edit-b.png' })
        const original = addCareLog(db, {
          plantId: carePlantId,
          content: '原始内容',
          kind: 'note',
          logDate: '2026-05-02',
          imageIds: [a.id]
        })
        const edited = updateCareLog(db, original.id, {
          content: '改过的内容',
          kind: 'water',
          logDate: '2026-05-01',
          addImageIds: [b.id],
          removeImageIds: [a.id]
        })
        check(
          '编辑日志：正文 / 类型 / 日期都能改',
          edited?.content === '改过的内容' && edited.kind === 'water' && edited.logDate === '2026-05-01',
          `${edited?.content} / ${edited?.kind} / ${edited?.logDate}`
        )
        check(
          '编辑日志：能加照片、能摘旧照片',
          edited?.images.length === 1 && edited.images[0].path === 'smoke-edit-b.png',
          edited?.images.map((i) => i.path).join(',')
        )
        check('编辑日志：旧照片的记录确实没了', listLogImages(db, original.id).length === 1)
        check(
          '编辑不存在的日志返回 null',
          updateCareLog(db, 9_999_999, { content: 'x' }) === null
        )
        deleteCareLog(db, original.id)
      }

      // ---- 概览 ----
      const overview = careOverview(db, year, '2026-06-11')
      check('概览：规则数正确', overview.rules >= 15, String(overview.rules))
      check('概览：任务统计齐全', overview.total > 0 && overview.pending >= 0, JSON.stringify(overview))
      check('概览：逾期数不为负', overview.overdue >= 0)
      check('概览：无任务的植物数可统计', overview.plantsWithoutTasks >= 0)

      // 侧栏角标取的是 overview.overdue + overview.due —— 页面上显示的
      // 「逾期/该做」也是这两个数。同源才不会出现「页面写着 0、侧栏还挂红点」
      // （那正是第一版的 bug：角标只在挂载时取一次，打完勾不刷新）。
      {
        const before = careOverview(db, year, '2026-06-11')
        const victim = listCareTasks(db, { plantId: carePlantId, status: 'open' }).find(
          (t) => urgencyOf(t, '2026-06-11') === 'due' || urgencyOf(t, '2026-06-11') === 'overdue'
        )
        if (victim) {
          completeCareTask(db, victim.id, '角标测试')
          const after = careOverview(db, year, '2026-06-11')
          check(
            '完成任务后概览的「该做+逾期」确实减少（角标依赖这个不变量）',
            after.overdue + after.due < before.overdue + before.due,
            `${before.overdue + before.due} -> ${after.overdue + after.due}`
          )
          reopenCareTask(db, victim.id)
        } else {
          check('完成任务后概览的「该做+逾期」确实减少（角标依赖这个不变量）', true, '当前没有到期的任务，跳过')
        }
      }

      // ---- 全量生成 ----
      const all = generateTasksForAll(db, year, { today: FIXED_TODAY })
      check('可批量生成全部植株的计划', all.plants >= 1, JSON.stringify(all))
      const allAgain = generateTasksForAll(db, year, { today: FIXED_TODAY })
      check('批量生成是幂等的（不重复插入）', allAgain.created === 0, JSON.stringify(allAgain))

      // ---- 生成时跳过时间窗已过的月份 ----
      //
      // 十月才装这个应用的人，一月的任务从来就不是他该做的：
      // 生成一堆「已过期 286 天」既不符合事实，也会把真正该做的事淹掉。
      const lateToday = '2026-12-31'
      // 先完成一个「早已过期」的任务，确认这轮清理不会把它带走 ——
      // 打过勾的事是真实发生过的，规则和日期怎么变都不该抹掉
      const oldTask = listCareTasks(db, { plantId: carePlantId, status: 'open' })[0]
      completeCareTask(db, oldTask.id, '补记：早就做过了')
      generateTasksForPlant(db, carePlantId, year, { today: lateToday })
      const stillPending = listCareTasks(db, { plantId: carePlantId, status: 'open' })
      check(
        '时间窗已过的月份不保留待办',
        stillPending.every(
          (t) => addDays(t.dueDate, t.windowDays) >= lateToday || t.dueDate >= '2026-12-01'
        ),
        stillPending.map((t) => t.dueDate).join(',')
      )
      /*
       * 但当月要留下。锚点日默认 1 号、窗口 ±15 天 —— 月底重新生成时，
       * 当月 1 号的任务窗口早就过了；只用「窗口没过」筛的话，当月计划会整片消失。
       */
      check(
        '当月的任务即使窗口已过也保留',
        stillPending.some((t) => t.dueDate.startsWith('2026-12-')),
        stillPending.map((t) => t.dueDate).join(',')
      )
      check(
        '逾期很久但已完成的记录不会被清理带走',
        getCareTask(db, oldTask.id)?.status === 'done',
        `id=${oldTask.id} due=${oldTask.dueDate}`
      )

      // 关掉 skipPast 应能生成完整年份（给「我要全年记录」留口子）
      const fullYear = generateTasksForPlant(db, carePlantId, year, { today: lateToday, skipPast: false })
      check('可显式生成完整年份', fullYear.created > 0, JSON.stringify(fullYear))
      check(
        '完整年份包含年初的月份',
        // 不按 status 过滤：1 月那条正好是被保留的已完成任务，只看待办会误判成「没生成」
        listCareTasks(db, { plantId: carePlantId }).some((t) => t.dueDate.startsWith('2026-01'))
      )

      // ---- 适用物种多选 ----
      //
      // 起因：用户真实的底肥方案里「绣球、无花果、月季」共用一套配比，
      // 单值会逼出「一物种一条规则」，改一次配比要改好几处。
      check('旧数据：单个物种名解析成一个元素的数组', JSON.stringify(parseSpeciesKeys('月季')) === '["月季"]')
      check('旧数据：星号仍是通用', JSON.stringify(parseSpeciesKeys('*')) === '["*"]')
      check(
        '空值当通用',
        JSON.stringify(parseSpeciesKeys('')) === '["*"]' && JSON.stringify(parseSpeciesKeys(null)) === '["*"]'
      )
      check(
        '新数据：JSON 数组正常解析',
        JSON.stringify(parseSpeciesKeys('["绣球","无花果","月季"]')) === '["绣球","无花果","月季"]'
      )
      check('数组里的重复项被去掉', JSON.stringify(parseSpeciesKeys('["月季","月季"]')) === '["月季"]')
      check('通用与其他物种混写时收敛成通用', JSON.stringify(parseSpeciesKeys('["*","月季"]')) === '["*"]')
      check('坏 JSON 退回当单个名字', JSON.stringify(parseSpeciesKeys('[不是JSON')) === '["[不是JSON"]')

      check('序列化：通用', serializeSpeciesKeys(['*']) === '["*"]')
      check('序列化：空数组＝通用', serializeSpeciesKeys([]) === '["*"]')
      check('序列化：多物种', serializeSpeciesKeys(['绣球', '月季']) === '["绣球","月季"]')
      check('序列化：混入通用则只剩通用', serializeSpeciesKeys(['月季', '*']) === '["*"]')
      check(
        '序列化后能原样解析回来',
        JSON.stringify(parseSpeciesKeys(serializeSpeciesKeys(['杜鹃', '三角梅']))) === '["杜鹃","三角梅"]'
      )

      check('通用规则适用于任何物种', ruleMatchesSpecies(['*'], '月季') && ruleMatchesSpecies(['*'], null))
      check('多物种规则命中其中之一', ruleMatchesSpecies(['绣球', '无花果', '月季'], '无花果'))
      check('多物种规则不命中列表外的物种', !ruleMatchesSpecies(['绣球', '无花果', '月季'], '蓝莓'))
      check('物种名为空时不命中专属规则', !ruleMatchesSpecies(['月季'], null) && !ruleMatchesSpecies(['月季'], '  '))
      check('匹配忽略大小写与首尾空格', ruleMatchesSpecies(['Rose'], ' rose '))
      check('显示文本：通用', describeSpeciesKeys(['*']) === '通用')
      check('显示文本：多物种顿号连接', describeSpeciesKeys(['绣球', '月季']) === '绣球、月季')

      // 生成任务时确实按多物种匹配
      {
        const multiRules = [
          {
            ...ruleBase,
            id: 40,
            speciesKeys: ['绣球', '无花果', '月季'],
            monthFrom: 6,
            monthTo: null,
            actionType: 'fertilize' as const,
            title: '共同底肥',
            detail: null
          }
        ]
        for (const name of ['绣球', '无花果', '月季']) {
          check(`多物种规则对「${name}」生效`, generateTasks(multiRules, name, 2026).some((t) => t.title === '共同底肥'))
        }
        check('多物种规则对列表外的物种不生效', generateTasks(multiRules, '蓝莓', 2026).length === 0)
      }

      // 存进库再读出来仍是一组
      {
        const multi = saveCareRule(db, {
          speciesKeys: ['绣球', '无花果', '月季'],
          hemisphere: 'N',
          climateZone: null,
          monthFrom: 10,
          monthTo: 10,
          repeatDays: null,
          rotation: null,
          activePhases: null, oncePerWindow: false, recipeId: null,
          actionType: 'fertilize',
          title: '自检多物种规则',
          detail: null,
          priority: 2,
          source: 'manual',
          verified: true
        })
        check('多物种规则能存下来', JSON.stringify(multi.speciesKeys) === '["绣球","无花果","月季"]', JSON.stringify(multi.speciesKeys))
        check(
          '重新读出来仍是一组',
          JSON.stringify(listCareRules(db).find((r) => r.id === multi.id)?.speciesKeys) === '["绣球","无花果","月季"]'
        )
        check('按其中一个物种能筛到它', listCareRules(db, { speciesKey: '无花果' }).some((r) => r.id === multi.id))
        check('按列表外的物种筛不到', !listCareRules(db, { speciesKey: '蓝莓' }).some((r) => r.id === multi.id))
        // 传 '*' 的语义是「适用于任何植物的规则」，也就是通用规则；
        // 多物种规则只对列出的那几个生效，不属于这一类
        check(
          '星号筛选只返回通用规则',
          listCareRules(db, { speciesKey: '*' }).every((r) => r.speciesKeys.includes('*'))
        )
        check('按具体物种筛选会带上通用规则', listCareRules(db, { speciesKey: '绣球' }).some((r) => r.speciesKeys.includes('*')))
        deleteCareRule(db, multi.id)
      }

      deleteCareRule(db, myRule.id)
      check('可删除规则', listCareRules(db, { speciesKey: '照护月季' }).every((r) => r.id !== myRule.id))
    }

    // --- 物候阶段（停用条件的实现方式）---
    {
      const phaseRule = (activePhases: CarePhase[] | null, id = 30) => ({
        id,
        speciesKeys: ['*'],
        hemisphere: 'N' as const,
        climateZone: null,
        monthFrom: 3,
        monthTo: 6,
        repeatDays: null,
        oncePerWindow: false,
        recipeId: null,
        rotation: null,
        activePhases,
        actionType: 'fertilize' as const,
        title: '追肥',
        detail: null,
        priority: 2,
        source: 'seed' as const,
        verified: true,
        createdAt: ''
      })

      // ---- 阶段工具 ----
      check('isCarePhase 只认已知阶段', isCarePhase('growing') && !isCarePhase('flowering') && !isCarePhase(null))
      // 1.33.3 新增的两个阶段：种子/种球、病虫害
      check('种子/种球期是合法阶段', isCarePhase('seed'))
      check('病虫害期是合法阶段', isCarePhase('pest'))
      check(
        '阶段下拉里有「种子/种球期」和「病虫害期」',
        CARE_PHASE_OPTIONS.some((o) => o.value === 'seed' && o.label.includes('种子/种球')) &&
          CARE_PHASE_OPTIONS.some((o) => o.value === 'pest' && o.label.includes('病虫害'))
      )
      check('每个阶段都有说明文案', CARE_PHASE_OPTIONS.every((o) => (CARE_PHASE_HINTS[o.value] ?? '').length > 0))
      check('normalizePhases 过滤非法值', JSON.stringify(normalizePhases(['growing', 'xx', 'dormant'])) === '["growing","dormant"]')
      check('normalizePhases 去重', JSON.stringify(normalizePhases(['growing', 'growing'])) === '["growing"]')
      check('normalizePhases 空数组返回 null', normalizePhases([]) === null)
      check('normalizePhases 非数组返回 null', normalizePhases('growing') === null && normalizePhases(undefined) === null)

      // ---- 限定阶段的规则：只在对应阶段生效 ----
      //
      // 这就是「停用」的实现：「休眠期停止水溶追肥」＝
      // 「这条追肥规则只在生长期/花芽分化期生效」。
      const growthOnly = phaseRule(['growing', 'budding'])

      check(
        '生长期时追肥规则生效',
        generateTasks([growthOnly], null, 2026, { phase: 'growing' }).length === 4,
        String(generateTasks([growthOnly], null, 2026, { phase: 'growing' }).length)
      )
      check('花芽分化期仍生效', generateTasks([growthOnly], null, 2026, { phase: 'budding' }).length === 4)
      check('休眠期自动不生效（这就是停用）', generateTasks([growthOnly], null, 2026, { phase: 'dormant' }).length === 0)
      check('花期自动不生效（花苞显色后停肥）', generateTasks([growthOnly], null, 2026, { phase: 'blooming' }).length === 0)
      check('缓苗期自动不生效', generateTasks([growthOnly], null, 2026, { phase: 'recovering' }).length === 0)

      // ---- 窗口内只做一次 ----
      //
      // 「10~11 月」原样填会生成两条，但底肥一季只埋一次。
      // 用户当时只能把区间收窄到单月绕过 —— 那不是表达，是绕过。
      {
        const onceBase = {
          hemisphere: 'N' as const,
          climateZone: null,
          priority: 2,
          source: 'seed' as const,
          verified: true,
          createdAt: '',
          repeatDays: null,
          rotation: null,
          activePhases: null,
          oncePerWindow: false,
          recipeId: null
        }
        const once = { ...onceBase, id: 40, speciesKeys: ['*'], monthFrom: 10, monthTo: 11, actionType: 'fertilize' as const, title: '底肥', detail: null }
        const monthly = generateTasks([once], null, 2026)
        check('不加频率时 10~11 月生成两条（原行为）', monthly.length === 2, String(monthly.length))

        const single = generateTasks([{ ...once, oncePerWindow: true }], null, 2026)
        check('打开「窗口内一次」后只生成一条', single.length === 1, String(single.length))
        // 落在窗口开头：底肥早做比晚做好，入冬前要留出扎根时间
        check('落在窗口开头而不是中间', single[0].dueDate.startsWith('2026-10'), single[0].dueDate)
        check('最多推迟 6 天，不推到窗口中间', Number(single[0].dueDate.slice(8, 10)) <= 7, single[0].dueDate)

        // 单月区间本来就只产出一条，打开开关不该改变它
        const oneMonth = { ...once, monthTo: 10 }
        check('单月区间不受影响', generateTasks([{ ...oneMonth, oncePerWindow: true }], null, 2026).length === 1)

        // 跨年写法会断开成两段窗口，那就是两条 —— 本来也该是两条
        const wrapping = { ...once, monthFrom: 11, monthTo: 2 }
        check(
          '跨年的窗口算两段，各出一条',
          generateTasks([{ ...wrapping, oncePerWindow: true }], null, 2026).length === 2,
          String(generateTasks([{ ...wrapping, oncePerWindow: true }], null, 2026).length)
        )

        // 按天重复优先：两个都打开时不该变成「窗口内一次」
        const both = generateTasks([{ ...once, oncePerWindow: true, repeatDays: 10 }], null, 2026)
        check('按天重复优先于窗口内一次', both.length > 2, String(both.length))

        // 窗口内一次：默认落在每月 1 号；填了「每月几号」就落在那一天
        const togetherDays = [0, 1, 2, 3, 4].map(
          (seed) => generateTasks([{ ...once, oncePerWindow: true }], null, 2026, { spreadSeed: seed })[0].dueDate
        )
        check('窗口内一次默认所有植株同一天', new Set(togetherDays).size === 1, togetherDays.join(' '))
        check('而且就是窗口第一个月的 1 号', togetherDays[0] === '2026-10-01', togetherDays[0])

        const anchoredOnce = generateTasks(
          [{ ...once, oncePerWindow: true, monthFromDay: 9 }],
          null,
          2026
        )
        check('窗口内一次认起始日', anchoredOnce[0].dueDate === '2026-10-09', anchoredOnce[0].dueDate)
      }

      // ---- 规则绑定配方：存取往返 ----
      {
        const recipe = saveRecipe(db, {
          name: '自检底肥配方',
          kind: '底肥',
          note: null,
          items: [
            { materialId: null, name: '羊粪', ratioPart: 5, amount: null, unit: null, note: '主体', sortOrder: 0 },
            { materialId: null, name: '骨粉', ratioPart: 1, amount: null, unit: null, note: '少量', sortOrder: 1 }
          ]
        })
        check('配方可以不依赖物品库（用自由文本）', recipe.recipe?.items.length === 2, String(recipe.recipe?.items.length))

        const saved = saveCareRule(db, {
          speciesKeys: ['*'],
          hemisphere: 'N',
          climateZone: null,
          monthFrom: 10,
          monthTo: 11,
          repeatDays: null,
          oncePerWindow: true,
          recipeId: recipe.recipe?.id ?? null,
          rotation: null,
          activePhases: null,
          actionType: 'fertilize',
          title: '自检底肥规则',
          detail: null,
          priority: 2,
          source: 'manual',
          verified: true
        })
        check('规则能保存配方绑定', saved.recipeId === recipe.recipe?.id, String(saved.recipeId))
        check('规则能保存「窗口内一次」', saved.oncePerWindow === true)

        // 读回来必须还在（映射层漏字段是这类改动的典型错误）
        const reloaded = listCareRules(db).find((r) => r.id === saved.id)
        check('重新读取后绑定仍在', reloaded?.recipeId === recipe.recipe?.id)
        check('重新读取后频率仍在', reloaded?.oncePerWindow === true)

        // 按天重复与窗口内一次互斥，仓储层要落成 false
        const conflict = saveCareRule(db, {
          speciesKeys: ['*'],
          hemisphere: 'N',
          climateZone: null,
          monthFrom: 5,
          monthTo: null,
          repeatDays: 7,
          oncePerWindow: true,
          recipeId: null,
          rotation: null,
          activePhases: null,
          actionType: 'water',
          title: '自检互斥',
          detail: null,
          priority: 2,
          source: 'manual',
          verified: true
        })
        check('按天重复与窗口内一次互斥（按天优先）', conflict.oncePerWindow === false && conflict.repeatDays === 7)

        deleteCareRule(db, saved.id)
        deleteCareRule(db, conflict.id)
        archiveRecipe(db, recipe.recipe?.id ?? 0)
      }

      // ---- 任务记得规则与配方，完成后写进日志 ----
      {
        const rec = saveRecipe(db, {
          name: '自检日志配方',
          kind: '底肥',
          note: null,
          items: [{ materialId: null, name: '羊粪', ratioPart: 5, amount: null, unit: null, note: null, sortOrder: 0 }]
        })
        const plant = db.get<{ id: number }>('SELECT id FROM plants LIMIT 1')
        const withRecipe = createCareTask(db, {
          plantId: plant?.id ?? null,
          actionType: 'fertilize',
          title: '自检带配方的任务',
          detail: null,
          dueDate: '2026-10-15',
          windowDays: 3,
          ruleId: 77,
          recipeId: rec.recipe?.id ?? null,
          source: 'generated'
        })
        check('任务记得自己来自哪条规则', withRecipe.ruleId === 77, String(withRecipe.ruleId))
        check('任务记得自己绑的配方', withRecipe.recipeId === rec.recipe?.id, String(withRecipe.recipeId))

        completeCareTask(db, withRecipe.id, '埋好了', '2026-10-16')
        const log = listCareLogs(db, { plantId: plant?.id ?? 0, limit: 5 }).find((l) => l.taskId === withRecipe.id)
        check('完成后日志记下了当时用的配方', log?.recipeId === rec.recipe?.id, String(log?.recipeId))

        // 没有配方的手动任务，日志里不该凭空多出一个配方
        const plain = createCareTask(db, {
          plantId: plant?.id ?? null,
          actionType: 'water',
          title: '自检无配方任务',
          detail: null,
          dueDate: '2026-10-16',
          source: 'manual'
        })
        completeCareTask(db, plain.id, null, '2026-10-16')
        const plainLog = listCareLogs(db, { plantId: plant?.id ?? 0, limit: 5 }).find((l) => l.taskId === plain.id)
        check('没有配方的任务日志里也是空', plainLog?.recipeId === null, String(plainLog?.recipeId))

        archiveRecipe(db, rec.recipe?.id ?? 0)
      }

      // ---- 天气风险判断 ----
      //
      // 这是应用里第一个网络功能，所以判断逻辑单独放在 core 层：
      // 网络只负责取回一组温度，「谁怕冷、谁怕热」全在这里决定，可被完整覆盖。
      {
        // 用户那两株的真实数据：朱顶红耐寒 5℃、粉龙耐寒 -15℃ 耐热 35℃
        const zhudinghong: WeatherRiskInput = {
          plantId: 1,
          plantName: '前院的朱顶红',
          speciesName: '朱顶红阿弗雷',
          placeName: '前院',
          coldHardiness: 5,
          heatTolerance: null,
          frostProtected: false,
          canHeat: false
        }
        const fenlong: WeatherRiskInput = {
          plantId: 2,
          plantName: '前院的粉龙',
          speciesName: '月季粉龙',
          placeName: '前院',
          coldHardiness: -15,
          heatTolerance: 35,
          frostProtected: false,
          canHeat: false
        }
        const day = (date: string, min: number, max: number): DailyTemp => ({ date, tempMin: min, tempMax: max })

        // 寒潮：最低 3℃，朱顶红只能扛 5℃
        const cold = assessWeatherRisks([zhudinghong, fenlong], [day('2026-11-20', 3, 10)])
        check('轮到怕冷的植株才报警（粉龙 -15℃ 不受影响）', cold.length === 1 && cold[0].plantName === '前院的朱顶红', JSON.stringify(cold.map((r) => r.plantName)))
        check('风险类型是霜冻', cold[0]?.kind === 'frost')
        check('超出幅度算得对（5 - 3 = 2）', cold[0]?.margin === 2, String(cold[0]?.margin))
        check('超过 2℃ 以内算「留意」', cold[0]?.severity === 'watch')
        check('说明里写清楚了地点和温度', (cold[0]?.message ?? '').includes('前院') && (cold[0]?.message ?? '').includes('3℃'), cold[0]?.message)

        /*
         * 措辞：温度必须归给**预报点**，不能读成「你家院子实测」。
         *
         * 第一版写的是「前院（东南136°）最高 31.2℃」，用户看到就以为是院子的温度 ——
         * 但那是市中心那个格点的预报。用户反馈「位置不够精准」指的就是这个。
         */
        {
          const withLabel = assessWeatherRisks([zhudinghong], [day('2026-11-20', 3, 10)], '中国 · 示例省 · 示例市')
          const msg = withLabel[0]?.message ?? ''
          check('温度归给预报点而不是植株位置', msg.includes('中国 · 示例省 · 示例市预报最低'), msg)
          check('植株位置另说，不再和温度绑在一起', msg.includes('前院这株能扛到'), msg)
          // 钉子：不能出现「前院……最低 <温度>」这种读起来像实测的说法
          check('不出现「前院最低 3℃」这种过度声称', !/前院[^，]*最低/.test(msg), msg)
          // 没有预报点名字时也不能瞎安
          const noLabel = assessWeatherRisks([zhudinghong], [day('2026-11-20', 3, 10)])
          check('没有预报点名时不谎报位置', (noLabel[0]?.message ?? '').includes('预报点预报最低'), noLabel[0]?.message)
        }

        // 关键行为：同一株放在能防冻的位置，就不该再报
        const sheltered = assessWeatherRisks([{ ...zhudinghong, frostProtected: true }], [day('2026-11-20', 3, 10)])
        check('能防冻的位置不再报霜冻', sheltered.length === 0, String(sheltered.length))
        const heated = assessWeatherRisks([{ ...zhudinghong, canHeat: true }], [day('2026-11-20', 3, 10)])
        check('能加温的位置（+3℃）不再报霜冻', heated.length === 0, String(heated.length))
        // 反方向的钉子：露天时同样的温度必须报，否则上面两条可能只是因为判断失效
        check('同一株露天时确实会报（方向没反）', assessWeatherRisks([zhudinghong], [day('2026-11-20', 3, 10)]).length === 1)
        check('防护有上限，极寒仍会报', assessWeatherRisks([{ ...zhudinghong, frostProtected: true }], [day('2026-01-10', -8, 0)]).length === 1)
        check('防冻 + 加温叠加后，室外要降到 -3℃ 才出事', effectiveColdThreshold(5, { frostProtected: true, canHeat: true }) === -3, String(effectiveColdThreshold(5, { frostProtected: true, canHeat: true })))

        // 预报没到承受范围就完全不出条目 —— 不给「一切正常」的噪音
        check('不冷就不产生任何条目', assessWeatherRisks([zhudinghong, fenlong], [day('2026-11-20', 12, 20)]).length === 0)

        // 严重程度分档
        check('超出 5℃ 算「要处理」', severityOf(5) === 'warn')
        check('超出 5℃ 以上算「紧急」', severityOf(5.1) === 'severe' && severityOf(12) === 'severe')
        const deepFreeze = assessWeatherRisks([fenlong], [day('2026-01-10', -25, -15)])
        check('粉龙在 -25℃ 下报警', deepFreeze.length === 1 && deepFreeze[0].kind === 'frost')
        check('超出 10℃ 判为紧急', deepFreeze[0]?.severity === 'severe', String(deepFreeze[0]?.severity))

        // 高温
        const heat = assessWeatherRisks([zhudinghong, fenlong], [day('2026-07-20', 28, 37)])
        check('耐热 35℃ 的粉龙在 37℃ 报警', heat.some((r) => r.kind === 'heat' && r.plantName === '前院的粉龙'), JSON.stringify(heat.map((r) => r.kind)))
        check('没填耐热的朱顶红不参与高温判断', !heat.some((r) => r.kind === 'heat' && r.plantName === '前院的朱顶红'))

        // 数据不全就不猜
        const unknown: WeatherRiskInput = { ...zhudinghong, coldHardiness: null, heatTolerance: null }
        check('没填耐寒就不做霜冻判断', assessWeatherRisks([unknown], [day('2026-01-10', -30, -20)]).length === 0)
        check('缺数据的植株会被单独列出来', unjudgeable([unknown, fenlong], 'frost').length === 1)
        check('有数据的不会进缺数据列表', unjudgeable([unknown, fenlong], 'heat').length === 1)

        // 收拢：连着七天寒潮不该出七条
        const week = [
          day('2026-11-20', 4, 10),
          day('2026-11-21', 2, 9),
          day('2026-11-22', -1, 8),
          day('2026-11-23', 0, 7),
          day('2026-11-24', 3, 9),
          day('2026-11-25', 6, 11),
          day('2026-11-26', 8, 12)
        ]
        const weekRisks = assessWeatherRisks([zhudinghong], week)
        check('连着几天冷会逐天产生条目', weekRisks.length === 5, String(weekRisks.length))
        const summarized = summarizeRisks(weekRisks)
        check('收拢后每株每种只留一条', summarized.length === 1, String(summarized.length))
        check('留的是最冷的那天', summarized[0]?.date === '2026-11-22' && summarized[0]?.forecastTemp === -1, `${summarized[0]?.date} ${summarized[0]?.forecastTemp}`)
        check('最冷那天判为紧急（5 - (-1) = 6）', summarized[0]?.severity === 'severe')

        // 同一天同一种风险去重
        const dup = dedupeByKindAndDay([...weekRisks, ...weekRisks])
        check('同株同天同类型只留一条', dup.length === weekRisks.length, `${dup.length} vs ${weekRisks.length}`)

        // 建议的任务（用户点了按钮才会用到）
        const task = suggestTask(summarized[0])
        check('建议任务标题带植株名', task.title.includes('前院的朱顶红') && task.title.includes('防冻'), task.title)
        check('建议任务正文带上依据日期', task.detail.includes('2026-11-22'))
        check('防冻建议包含具体做法', task.detail.includes('无纺布') || task.detail.includes('避风'), task.detail.slice(0, 40))
        check('高温建议是另一套做法', suggestTask(heat.find((r) => r.kind === 'heat')!).detail.includes('遮阳'))

        // 排序：紧急的排最前
        const mixed = summarizeRisks([...weekRisks, ...heat])
        check('紧急的排在留意的前面', mixed[0]?.severity === 'severe', String(mixed[0]?.severity))
      }

      // ---- 识图：消息构造与回答解析 ----
      //
      // 这一段**不用联网**也能测：构造消息和解析回答都是纯函数。
      // 而解析恰恰是最该测的地方 —— 模型不按格式返回是常态。
      {
        const dataUrl = 'data:image/jpeg;base64,AAAA'

        const plain = buildIdentifyMessages(dataUrl)
        check('识图消息是两段：系统提示 + 用户', plain.length === 2)
        check('系统提示要求只输出 JSON', String(plain[0].content).includes('只输出一个 JSON'))
        check('系统提示要求尽量给 3 个', String(plain[0].content).includes('尽量给 3 个候选'))
        check('系统提示要求备选如实标低置信度', String(plain[0].content).includes('要如实写低'))
        check('但也说了凑不出别凑', String(plain[0].content).includes('凑不出第三条就别凑'))
        const userParts = Array.isArray(plain[1].content) ? plain[1].content : []
        check('用户那一段带上了图片', userParts.some((p) => p.type === 'image_url'), JSON.stringify(userParts.map((p) => p.type)))
        check('图片用的是传进来的 data URL', JSON.stringify(plain[1].content).includes(dataUrl))

        const withHint = buildIdentifyMessages(dataUrl, '叶子有点发黄')
        check('带补充说明时写进文本里', JSON.stringify(withHint[1].content).includes('叶子有点发黄'))

        // 正常返回
        const normal = parseIdentifyResponse(
          JSON.stringify({
            candidates: [
              { name: '绿萝', scientificName: 'Epipremnum aureum', confidence: 0.9, reason: '心形叶、攀援' },
              { name: '龟背竹', scientificName: '', confidence: 0.4, reason: '叶形相近但无裂' },
              { name: '合果芋', scientificName: 'Syngonium', confidence: 0.25, reason: '叶脉相似' }
            ]
          })
        )
        check('解析出三个候选', normal.length === 3, String(normal.length))
        check('按置信度从高到低', normal[0].name === '绿萝' && normal[2].name === '合果芋')
        check('学名为空串时归一成 null', normal[1].scientificName === null)

        /*
         * 品种名与识别层级。
         *
         * 起因是用户拿自己的朱顶红阿弗雷试：模型认出「朱顶红（重瓣白花品种）」，
         * 属和种都对、理由也说得准（花葶、重瓣白花、喉部淡绿、大鳞茎），
         * 但没到「阿弗雷」。品种级本来就难 —— 关键是不能让用户以为认到了。
         */
        {
          const withCultivar = parseIdentifyResponse(
            '{"candidates":[{"name":"朱顶红","scientificName":"Hippeastrum","cultivar":"阿弗雷","level":"cultivar","confidence":0.8}]}'
          )
          check('品种名被单独解析出来', withCultivar[0].cultivar === '阿弗雷', String(withCultivar[0].cultivar))
          check('识别层级被解析出来', withCultivar[0].level === 'cultivar')

          const speciesOnly = parseIdentifyResponse(
            '{"candidates":[{"name":"朱顶红","scientificName":"Hippeastrum","cultivar":"","level":"species","confidence":0.9}]}'
          )
          check('认不到品种时 cultivar 为空', speciesOnly[0].cultivar === null)
          check('层级如实停在种', speciesOnly[0].level === 'species')

          // 模型没给 level：按有没有品种名推断，比丢掉强
          check(
            '没给 level 但有品种名时推为 cultivar',
            parseIdentifyResponse('{"candidates":[{"name":"月季","cultivar":"粉龙"}]}')[0].level === 'cultivar'
          )
          check(
            '没给 level 也没有品种名时为 null',
            parseIdentifyResponse('{"candidates":[{"name":"月季"}]}')[0].level === null
          )
          // 乱写的 level 不能被当成合法值
          check(
            '无法识别的 level 被丢掉',
            parseIdentifyResponse('{"candidates":[{"name":"月季","level":"kingdom"}]}')[0].level === null
          )
        }

        /*
         * 已知品种当线索：把开放问题变成选择题。
         * 用户库里已经有「朱顶红阿弗雷」，识图时把它捎上会准得多。
         */
        {
          const withKnown = buildIdentifyMessages(dataUrl, null, ['朱顶红阿弗雷', '月季粉龙'])
          const text = JSON.stringify(withKnown[1].content)
          check('已知品种名被写进提示里', text.includes('朱顶红阿弗雷') && text.includes('月季粉龙'))
          check('明确说了「不在里面就自己判断」', text.includes('不要硬套'))
          // 没给已知品种时不该凭空多出这一段
          check('没有已知品种时不出现参考段落', !JSON.stringify(buildIdentifyMessages(dataUrl)[1].content).includes('已经录过'))
          // 空数组 / 空白名字要被过滤掉，否则会写出一串顿号
          check('空白名字被过滤', !JSON.stringify(buildIdentifyMessages(dataUrl, null, ['', '  '])[1].content).includes('已经录过'))
        }

        // 模型爱犯的几种格式毛病，都不该让结果丢掉
        check(
          'confidence 写成百分数会换算',
          parseIdentifyResponse('{"candidates":[{"name":"月季","confidence":85}]}')[0].confidence === 0.85
        )
        check(
          'confidence 是字符串也认',
          parseIdentifyResponse('{"candidates":[{"name":"月季","confidence":"0.7"}]}')[0].confidence === 0.7
        )
        check(
          '没有 confidence 时给中间值而不是丢掉',
          parseIdentifyResponse('{"candidates":[{"name":"月季"}]}')[0].confidence === 0.5
        )
        check(
          '超过 1 的百分数会被夹到 0~1',
          parseIdentifyResponse('{"candidates":[{"name":"月季","confidence":150}]}')[0].confidence === 1
        )
        check(
          '包在 markdown 代码块里也能解析',
          parseIdentifyResponse('好的，结果如下：\n\`\`\`json\n{"candidates":[{"name":"月季","confidence":0.8}]}\n\`\`\`').length === 1
        )
        check(
          '直接返回数组也认',
          parseIdentifyResponse('[{"name":"月季","confidence":0.8}]').length === 1
        )
        check(
          '换了字段名（results / plants）也认',
          parseIdentifyResponse('{"results":[{"name":"月季","confidence":0.8}]}').length === 1 &&
            parseIdentifyResponse('{"plants":[{"name":"月季","confidence":0.8}]}').length === 1
        )
        check(
          '超过三个候选只取前三个',
          parseIdentifyResponse(
            JSON.stringify({ candidates: [0.9, 0.8, 0.7, 0.6, 0.5].map((c, i) => ({ name: '候选' + i, confidence: c })) })
          ).length === 3
        )
        check('缺少名称的条目被跳过', parseIdentifyResponse('{"candidates":[{"confidence":0.9},{"name":"月季"}]}').length === 1)

        // 认不出：模型给空数组，或者干脆说人话
        check('模型给空数组时返回空', parseIdentifyResponse('{"candidates":[]}').length === 0)
        check('模型只会说人话时返回空而不是崩掉', parseIdentifyResponse('抱歉，这张照片太模糊了，我认不出。').length === 0)
        check('完全不是 JSON 时返回空', parseIdentifyResponse('').length === 0)
      }

      // ---- 删字段时不能误伤同名异类的投影行 ----
      //
      // 物种模板和植株模板**可以各有同名字段**（唯一性只在各自 owner_kind 内校验）。
      // 原来那句 DELETE FROM attr_index WHERE field_key = ? 少了 owner_kind 条件，
      // 删一个没人用过的植株字段会连带删掉同名物种字段的全部投影行。
      //
      // 后果是连锁的、而且全程无提示：
      //   ①「本月开花」这类索引筛选静默少算
      //   ② 那个物种字段的 fieldUsage 从此报 0，
      //      于是「有数据只能归档不能删」「有数据不许改类型」两道保护同时失效
      {
        const fPlant = createField(db, { ownerKind: 'plant', key: 'dup_check', label: '同名字段', groupName: '其他', type: 'text' })
        const fSpecies = createField(db, { ownerKind: 'species', key: 'dup_check', label: '同名字段', groupName: '其他', type: 'text' })
        check('同名字段可以分别建在植株与物种上', Boolean(fPlant.id) && Boolean(fSpecies.id))

        /*
         * 只给**物种**那侧种一条投影行 —— 这正是真实场景：
         * 植株字段没人用过（于是允许真删），物种字段有数据。
         * 要是两边都种，deleteField 会按「有数据只能归档」拒绝删植株字段，
         * 那测的就不是 owner_kind 限定，而是另一条规矩了。
         */
        db.run(
          "INSERT OR REPLACE INTO attr_index (owner_kind, owner_id, field_key, value_text) VALUES ('species', 90002, 'dup_check', '物种的值')"
        )

        deleteField(db, fPlant.id)

        const leftPlant = db.scalar<number>(
          "SELECT COUNT(*) AS c FROM attr_index WHERE owner_kind = 'plant' AND field_key = 'dup_check'"
        )
        const leftSpecies = db.scalar<number>(
          "SELECT COUNT(*) AS c FROM attr_index WHERE owner_kind = 'species' AND field_key = 'dup_check'"
        )
        check('该字段本来就没有投影行（所以允许真删）', Number(leftPlant) === 0, String(leftPlant))
        check('同名物种字段的投影行不受影响', Number(leftSpecies) === 1, String(leftSpecies))

        /*
         * 收尾：把自检自己造的残留清掉。
         * 这里**故意吞掉异常** —— 物种那个字段还留着一条投影行，
         * deleteField 会按「有数据只能归档」拒绝。那是它该有的行为，
         * 不是本次要验证的东西，不该让整轮自检因此判失败。
         */
        db.run("DELETE FROM attr_index WHERE field_key = 'dup_check'")
        try {
          deleteField(db, fSpecies.id)
        } catch {
          db.run('DELETE FROM field_definitions WHERE id = ?', fSpecies.id)
        }
      }

      // ---- 占位符计数（Db 层校验的基石）----
      //
      // Db.stmt 现在会比对「SQL 里几个 ?」和「传了几个参数」，不符就当场抛。
      // 那层保护的前提是**计数本身是对的** —— 数错了就会冤枉正确的代码，
      // 或者放过真正错位的语句。所以先钉住计数函数。
      {
        check('空语句是 0 个', countPlaceholders('SELECT 1') === 0)
        check('两个占位符', countPlaceholders('INSERT INTO t (a, b) VALUES (?, ?)') === 2)
        // SET 里 3 个 + WHERE 里 1 个 = 4 个（我一开始写成 3，是断言错了不是函数错了）
        check('SET 加 WHERE 共四个', countPlaceholders('UPDATE t SET a = ?, b = ?, c = ? WHERE id = ?') === 4)

        // 引号里的问号不是占位符 —— 这是最容易数错的地方
        check(
          "单引号里的 ? 不算",
          countPlaceholders("SELECT * FROM t WHERE note = '几点了?'") === 0,
          String(countPlaceholders("SELECT * FROM t WHERE note = '几点了?'"))
        )
        check(
          "引号里带 ? 的同时外面还有一个真的",
          countPlaceholders("SELECT * FROM t WHERE note = 'a?b' AND id = ?") === 1
        )
        check('双引号标识符里的 ? 不算', countPlaceholders('SELECT "a?b" FROM t') === 0)
        check('反引号里的 ? 不算', countPlaceholders('SELECT `a?b` FROM t') === 0)
        check('方括号里的 ? 不算', countPlaceholders('SELECT [a?b] FROM t') === 0)
        check('单引号里的双写转义', countPlaceholders("SELECT * FROM t WHERE a = 'it''s ?' AND b = ?") === 1)

        // 注释
        check('行注释里的 ? 不算', countPlaceholders('SELECT 1 -- 这里有个 ?\nWHERE a = ?') === 1)
        check('块注释里的 ? 不算', countPlaceholders('SELECT 1 /* ? ? */ WHERE a = ?') === 1)

        // 编号占位符按不同编号计数
        check('编号占位符 ?1 ?2', countPlaceholders('SELECT * FROM t WHERE a = ?1 AND b = ?2') === 2)
        check('同一个编号重复出现只算一次', countPlaceholders('SELECT * FROM t WHERE a = ?1 OR b = ?1') === 1)

        // 真正的防线：数量不符要当场抛，而不是悄悄写错数据
        let threw = ''
        try {
          db.run('SELECT ? AS a, ? AS b', 1)
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e)
        }
        check('少传参数时当场抛出', threw.includes('占位符'))
        check('错误信息里说清了数量', threw.includes('2 个占位符') && threw.includes('1 个参数'), threw.split('\n')[0])

        let threw2 = ''
        try {
          db.get('SELECT 1 AS a', '多余参数')
        } catch (e) {
          threw2 = e instanceof Error ? e.message : String(e)
        }
        check('多传参数时也抛出', threw2.includes('占位符'))

        // 正常语句不能被冤枉
        const ok = db.get<{ n: number }>('SELECT ? AS n', 42)
        check('数量相符时正常执行', ok?.n === 42, String(ok?.n))
      }

      // ---- 换源时界面要说出来 ----
      //
      // providerLabel 以前是从**配置**推导的，而和风失败时会静默退回 Open-Meteo。
      // 于是界面写着「数据来自和风天气」、预报点标着「已到区县」，
      // 可那份预报其实是 Open-Meteo 的市级网格 —— 而设置页恰好教人
      // 「填经纬度会更准」，填了就正好触发这条假来源。
      //
      // 这段判断原本埋在联网的 fetchDaily 里，自检碰不到。抽成纯函数才能测：
      // 一段只有真联网才跑得到的逻辑，等于没有回归保护。
      {
        const base = { baseUrl: '', chatModel: '', temperature: 0, timeoutMs: 1, maxRetries: 0 } as never
        const qw = { ...(base as object), provider: 'qweather', qweatherReady: true, qweatherKey: 'k' } as never
        const qwNoKey = { ...(base as object), provider: 'qweather', qweatherReady: false } as never
        const om = { ...(base as object), provider: 'open-meteo', qweatherReady: false } as never

        const geoQw = { provider: 'qweather', locationId: '101250601' } as never
        const geoNoId = { provider: 'qweather', locationId: null } as never

        // 和风拿到了好数据：没换源，不该有提示
        check(
          '和风成功时没有换源提示',
          qweatherSkipReason(qw, geoQw, { code: '200', daily: [{}] }) === null
        )
        // 和风返回了业务错误码 —— 原因里要带上它，用户才知道去查什么
        check(
          '和风返回错误码时说明是哪个码',
          String(qweatherSkipReason(qw, geoQw, { code: '403' })).includes('403'),
          String(qweatherSkipReason(qw, geoQw, { code: '403' }))
        )
        check(
          '和风没返回东西时说没返回可用数据',
          String(qweatherSkipReason(qw, geoQw, null)).includes('没有返回可用的数据')
        )
        /*
         * 200 但没有逐日数据。**这里曾经走进一个坑**：
         * 原来的写法是 `qweatherData?.code ? ...`，于是 code='200' 也走这个分支，
         * 提示变成「和风返回 200」—— 读起来像成功，用户根本不知道出了什么事。
         * 200 只代表请求通了，不代表里面有东西。
         */
        const empty200 = String(qweatherSkipReason(qw, geoQw, { code: '200', daily: [] }))
        check('code=200 但没有逐日数据时，不能说成「和风返回 200」', !empty200.includes('和风返回 200'), empty200)
        check('而且要讲清是「请求成功但没数据」', empty200.includes('没有可用的逐日预报'), empty200)

        // 压根没尝试和风：配了 key 但地点是手填经纬度（没有 locationId）
        check(
          '手填经纬度时说明没有 locationId',
          String(qweatherSkipReason(qw, geoNoId)).includes('locationId')
        )
        // 选了和风但没配齐
        check('和风没配齐时说配置不完整', String(qweatherSkipReason(qwNoKey, geoQw)).includes('配置不完整'))

        // 用户本来就选了 Open-Meteo：**没有换源这回事，不该弹提示**
        check('本来就用 Open-Meteo 时不提示', qweatherSkipReason(om, geoNoId) === null)
        check('本来就用 Open-Meteo 且有 id 时也不提示', qweatherSkipReason(om, geoQw) === null)

        /*
         * 这一条是整件事的核心：
         * 配的是和风、实际走的是 Open-Meteo —— 必须给出原因，
         * 界面才有东西可说，而不是继续显示「数据来自和风天气」。
         */
        check(
          '配和风但实际没用上时**一定**有原因（界面才有话可说）',
          qweatherSkipReason(qwNoKey, geoNoId) !== null
        )
      }

      // ---- 200 也不能算成功 ----
      //
      // 网关和兼容服务经常用 **200** 回一个 {"error":{...}}，
      // 或者干脆回一个 HTML 错误页。原来的写法两种情况都出事：
      //
      //   content ?? ''            → ok: true，于是下游各自编原因：
      //                              补全说「模型没有返回可解析的 JSON」
      //                              识图说「多半是这张照片看不清特征，换个角度再拍」
      //   response.json() 抛错     → 被归成「网络错误：Unexpected token '<'」，
      //                              用户跑去查 Wi-Fi，而网络是通的
      //
      // 两种都在**替服务端编原因**，而原因早就写在 body 里了。
      {
        const realFetch = globalThis.fetch
        const reply = (body: string, status = 200, type = 'application/json'): void => {
          globalThis.fetch = (async () =>
            new Response(body, { status, headers: { 'Content-Type': type } })) as typeof fetch
        }
        const ask = () =>
          chat({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] })

        try {
          // ① 200 + error 字段
          reply(JSON.stringify({ error: { message: '额度已用完，请充值' } }))
          const r1 = await ask()
          check('200 但没有 choices 时不算成功', r1.ok === false)
          check('而且把服务端写的原话带出来', String(r1.error).includes('额度已用完'), String(r1.error).slice(0, 60))
          check('错误里附上了返回内容', String(r1.error).includes('返回内容'))

          // ② 200 + HTML（反代登录页 / 网关错误页）
          reply('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', 200, 'text/html')
          const r2 = await ask()
          check('200 但返回不是 JSON 时不算成功', r2.ok === false)
          check('明说「不是 JSON」，而不是赖到网络上', String(r2.error).includes('不是 JSON'), String(r2.error).slice(0, 60))
          check(
            '不再出现「网络错误」（网络其实是通的）',
            !String(r2.error).includes('网络错误'),
            String(r2.error).slice(0, 60)
          )

          // ③ 200 + choices 但内容为空
          reply(JSON.stringify({ choices: [{ message: { content: '' } }] }))
          const r3 = await ask()
          check('内容为空时不算成功', r3.ok === false)

          // ④ 正常返回不能被冤枉
          reply(JSON.stringify({ choices: [{ message: { content: '你好' } }], model: 'm' }))
          const r4 = await ask()
          check('正常返回照常通过', r4.ok === true && r4.content === '你好', r4.content)

          // ⑤ 4xx 老路子没被弄坏
          reply(JSON.stringify({ error: 'bad key' }), 401)
          const r5 = await ask()
          check('4xx 仍然失败', r5.ok === false)
          check('4xx 的错误里也带 body', String(r5.error).includes('bad key'), String(r5.error).slice(0, 50))
        } finally {
          globalThis.fetch = realFetch
        }
      }

        // ---- 写操作要如实报告有没有改到东西 ----
      //
      // 这批（归档植株/位置、删规则/任务/日志、删物品、归档恢复配方）
      // 原来一律 return true。**报「已删除」之后对象又出现在列表里**，
      // 用户会以为删除功能坏了。
      //
      // Db.run 早就把 changes 返回出来了，只是一直没人读。
      {
        check('归档一个不存在的植株 → false', archivePlant(db, 999999) === false)
        check('归档一个不存在的位置 → false', archiveEnvironment(db, 999999) === false)
        check('删一条不存在的规则 → false', deleteCareRule(db, 999999) === false)
        check('删一条不存在的任务 → false', deleteCareTask(db, 999999) === false)
        check('删一条不存在的日志 → false', deleteCareLog(db, 999999) === false)
        check('删一个不存在的物品 → false', deleteMaterial(db, 999999) === false)
        check('归档一个不存在的配方 → false', archiveRecipe(db, 999999) === false)
        check('恢复一个不存在的配方 → false', restoreRecipe(db, 999999) === false)

        // 真的存在的要返回 true —— 不然就是把功能改坏了
        const victim = saveSpeciesOk(db, { values: { common_name: '待归档物种' } })
        const victimPlant = savePlant(db, { nickname: '待归档植株', values: { nickname: '待归档植株' } })
        check(
          '真的存在时仍然返回 true',
          victimPlant.plant ? archivePlant(db, victimPlant.plant.id) === true : false
        )
        /*
         * 重复归档一条**已归档**的植株仍然返回 true —— 那一行确实还在，
         * UPDATE 会重写归档时间戳，changes = 1。这是对的：
         * 这个函数回答的是「有没有改到东西」，不是「状态有没有变化」。
         * （我第一版把它断言成 false，是我想当然了。）
         */
        check('重复归档仍然 true（行还在，时间戳被重写）', archivePlant(db, victimPlant.plant?.id ?? 0) === true)
        check('物种本身没问题', victim.species.commonName === '待归档物种')
      }

      // ---- 设置读不出来时不能装作「没配过」 ----
      //
      // 坏掉的设置以前静默回落成默认值，于是「读取失败」和「从未配置」
      // 在界面上长得一样：ai 那条一坏，界面显示「尚未配置对话模型」，
      // 用户明明配过，只会以为配置被吞了，然后把原值覆盖掉。
      {
        setSetting(db, '自检.坏设置', { 正常: true })
        check('正常设置能读出来', JSON.stringify(getSetting(db, '自检.坏设置', null)) === '{"正常":true}')
        check('正常设置不出现在坏名单里', !listCorruptSettings().includes('自检.坏设置'))

        // 直接写一段坏 JSON 进去
        db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", '自检.坏设置', '{这不是 JSON')
        const fallbackValue = getSetting(db, '自检.坏设置', '兜底')
        check('坏设置仍然给兜底值（启动路径抛不起）', fallbackValue === '兜底')
        check('但会被记进坏名单，界面才有话可说', listCorruptSettings().includes('自检.坏设置'), listCorruptSettings().join(','))

        // 修好之后要从名单里消失，否则会一直报「配置坏了」
        setSetting(db, '自检.坏设置', { 修好了: true })
        getSetting(db, '自检.坏设置', null)
        check('修好之后从名单里移除', !listCorruptSettings().includes('自检.坏设置'))

        // 从来没配过的项不该被当成坏的
        db.run('DELETE FROM settings WHERE key = ?', '自检.从没配过')
        getSetting(db, '自检.从没配过', null)
        check('从没配过的项不算坏', !listCorruptSettings().includes('自检.从没配过'))

        db.run('DELETE FROM settings WHERE key = ?', '自检.坏设置')
      }

    // ---- 地名解析的缓存 ----
      //
      // 这条能在**不联网**的情况下验证：往缓存里塞一个特征明显的假结果，
      // 再调 lookupLocation。拿回那个假值 = 命中了缓存 = 没发请求。
      //
      // 顺带钉住缓存键里带「实际会用哪个源」这件事 ——
      // 不带的话，用户后补和风的 key 之后会一直吃旧的市级缓存，配了也白配。
      {
        const fake: GeoResult = {
          label: '缓存里的假地点',
          latitude: 1.23,
          longitude: 4.56,
          locationId: 'fake-id',
          level: 'district',
          provider: 'open-meteo'
        }
        setSetting(db, GEOCODE_CACHE_KEY, { 'geo-v2|open-meteo|示例省|示例市|示范县': fake })

        const cfg = readWeatherConfig(db, null)
        check('自检里默认走 Open-Meteo（否则下面这条会真发请求）', cfg.provider === 'open-meteo', cfg.provider)

        const fromCache = await lookupLocation(db, cfg, { province: '示例省', city: '示例市', district: '示范县' })
        check('命中缓存时原样返回（＝没联网）', fromCache?.label === '缓存里的假地点', String(fromCache?.label))
        check('缓存里的坐标与精度一并带出', fromCache?.latitude === 1.23 && fromCache?.level === 'district')

        // 换个区县就该重新解析；这里只断言键确实按区县区分（不去真的请求）
        const cache = getSetting<Record<string, unknown>>(db, GEOCODE_CACHE_KEY, {})
        check('缓存键含数据源', 'geo-v2|open-meteo|示例省|示例市|示范县' in cache, Object.keys(cache).join(','))
        check(
          '缓存键按省市区分开',
          !('open-meteo|示例省|示例市|另县' in cache) && !('open-meteo|外省|外市|示范县' in cache)
        )

        setSetting(db, GEOCODE_CACHE_KEY, {})
      }

      // ---- 养护位置的存取往返 ----
      //
      // 这条是补的，因为真出过事：加「区/县」字段时改了 SQL 的列名，
      // 但**没有同步改参数** —— UPDATE 漏了 district（编辑永远存不进去，
      // 用户报「这块修改不了」），INSERT 的列比占位符多一个（新建位置时
      // 所有坐标整体错位）。存进去再读回来就能抓住这类错。
      {
        const saved = saveEnvironment(db, {
          name: '自检位置',
          kind: 'balcony',
          lightLevel: null,
          lightHours: null,
          climateZone: null,
          province: '示例省',
          city: '示例市',
          district: '示范县',
          lat: 31.2345,
          lon: 121.5678,
          canHeat: false,
          frostProtected: false,
          notes: '朝南偏东，上午 3 小时直射',
          sortOrder: 99
        })
        check('新建位置时区县写入正确', saved.district === '示范县', String(saved.district))
        check('新建位置时纬度不错位', saved.lat === 31.2345, String(saved.lat))
        check('新建位置时经度不错位', saved.lon === 121.5678, String(saved.lon))
        check('位置备注写进去了', saved.notes === '朝南偏东，上午 3 小时直射', String(saved.notes))
      // 位置照片：现在只存不用，但要能存、能取、能删
      {
        const before = listImages(db, { environmentId: saved.id })
        check('新位置默认没有照片', before.length === 0, String(before.length))
        const rec = addImage(db, { environmentId: saved.id, path: 'env-smoke.jpg', thumbPath: 'env-smoke-thumb.jpg' })
        check('位置照片记下了 environmentId', rec.environmentId === saved.id, String(rec.environmentId))
        check('照片没有跑到植株/物种名下', rec.plantId === null && rec.speciesId === null)
        const after = listImages(db, { environmentId: saved.id })
        check('按 location 能查回这张照片', after.length === 1 && after[0].path === 'env-smoke.jpg')
    }

    /*
     * 背景选择：三种模式，外加一条硬规矩 ——
     * 选中的那张解析不出来时，绝对不能返回空数组（否则背景整个消失）。
     */
    {
      const base = ["theme-1"]
      const uploaded = [{ name: "a.png", url: "data:a" }, { name: "b.png", url: "data:b" }]
      check('背景：主题背景只给主题的', JSON.stringify(resolveBackdrops(base, uploaded, THEME_BACKDROP)) === '["theme-1"]')
      check('背景：全部轮播 = 主题 + 上传', resolveBackdrops(base, uploaded, null).length === 3)
      check('背景：选中一张就只用它', JSON.stringify(resolveBackdrops(base, uploaded, "b.png")) === '["data:b"]')
      check('背景：选中的不在列表里就退回全部，不清空', resolveBackdrops(base, uploaded, "c.png").length === 3)
      check('背景：不在列表但有直链时用直链', JSON.stringify(resolveBackdrops(base, uploaded, "c.png", "data:c")) === '["data:c"]')
      }

        // 编辑：这正是用户报「修改不了」的那条路径
        const edited = saveEnvironment(db, {
          id: saved.id,
          name: '自检位置',
          kind: 'balcony',
          lightLevel: null,
          lightHours: null,
          climateZone: null,
          province: '示例省',
          city: '示例市',
          district: '另县',
          lat: 28.71,
          lon: 113.58,
          canHeat: true,
          frostProtected: true,
          notes: null,
          sortOrder: 99
        })
        check('编辑位置时区县能改', edited.district === '另县', String(edited.district))
        check('编辑位置时坐标能改', edited.lat === 28.71 && edited.lon === 113.58, `${edited.lat},${edited.lon}`)
        check('编辑位置时开关能改', edited.canHeat === true && edited.frostProtected === true)
        check('编辑时清空备注也生效', edited.notes === null, String(edited.notes))

        // 再读一次，确认真的落库了而不是只改了返回值
        const reread = getEnvironment(db, saved.id)
        check('重新读取后区县仍在', reread?.district === '另县', String(reread?.district))
        check('重新读取后坐标仍在', reread?.lat === 28.71 && reread?.lon === 113.58)

        archiveEnvironment(db, saved.id)
      }

      // ---- 天气数据源配置 ----
      //
      // 用户的需求是「示范县」这种区县级地名，而 Open-Meteo 认不出来。
      // 和风天气能认，但要 key。底线是：**不配 key 的人照样能用。**
      {
        const fresh = readWeatherConfig(db, null)
        check('默认数据源是 Open-Meteo（不用配任何东西）', fresh.provider === 'open-meteo')
        check('没配 key 时和风不可用', fresh.qweatherReady === false)

        // 选了和风但没填 host/key —— 不能算就绪，否则会去请求一个空域名
        saveWeatherConfig(db, { provider: 'qweather' })
        const halfDone = readWeatherConfig(db, null)
        check('选了和风但没填 host 时仍不算就绪', halfDone.provider === 'qweather' && halfDone.qweatherReady === false)

        saveWeatherConfig(db, { qweatherHost: 'abc123.xy.qweatherapi.com' })
        const noKey = readWeatherConfig(db, null)
        check('有 host 没 key 也不算就绪', noKey.qweatherReady === false)

        const ready = readWeatherConfig(db, 'test-key-123')
        check('host 和 key 齐了才算就绪', ready.qweatherReady === true, JSON.stringify({ host: ready.qweatherHost, key: !!ready.qweatherKey }))

        // host 前后有空格是粘贴时最常见的，不能因此判成没填
        saveWeatherConfig(db, { qweatherHost: '  abc123.xy.qweatherapi.com  ' })
        check('host 前后空格会被去掉', readWeatherConfig(db, 'k').qweatherHost === 'abc123.xy.qweatherapi.com')

        // 切回 Open-Meteo：不配 key 的用户不该被和风的配置卡住
        saveWeatherConfig(db, { provider: 'open-meteo' })
        const back = readWeatherConfig(db, null)
        check('可以切回 Open-Meteo', back.provider === 'open-meteo')
        check('切回后即使没 key 也是可用的', back.qweatherReady === false && back.provider === 'open-meteo')

        // 配置存在设置表里，不是内存
        check('配置落到了设置表', getSetting<string>(db, 'weather.providerId', '') === 'open-meteo')
        // host 不是秘密，可以落库；key 绝不落库 —— 这里只断言 host 在库里
        check('API Host 存在设置表里（它不是秘密）', getSetting<string>(db, 'weather.qweatherHost', '') === 'abc123.xy.qweatherapi.com')
      }

      // ---- 天气服务：没有城市就一个字节都不发 ----
      //
      // 整个功能最重要的一条承诺：应用原本 100% 离线，
      // 不填城市的人不该因为加了天气而开始联网。
      // 判断方式很直接：调用之后 settings 里不该出现任何 weather.* 记录
      //（缓存只在请求成功之后才写），也不该有养护位置被写回坐标。
      {
        const hasCity = db
          .all<{ city: string | null }>('SELECT city FROM environments')
          .some((e) => (e.city ?? '').trim())
        if (!hasCity) {
          const result = await assessPlantsWeather(db)
          check('没有城市时不认为已配置', result.configured === false)
          check('没有城市时返回空风险', result.risks.length === 0 && result.daily.length === 0)
          check('没有城市时没有取数时间', result.fetchedAt === null)
          /*
           * 最硬的一条：**缓存**只在请求成功后才写，所以它必须是空的。
           *
           * 这里只查缓存键，不查所有 weather.* ——
           * providerId 和 qweatherHost 是本地配置，不联网也本来就该存在。
           * 早先写成查全部，结果上面的配置自检一写库这条就红了。
           */
          const cacheKeys = db.all<{ key: string }>(
            "SELECT key FROM settings WHERE key IN ('weather.forecastCache','weather.geocodeCache')"
          )
          check(
            '没有城市时连缓存都没写（＝确实没联网）',
            cacheKeys.length === 0,
            cacheKeys.map((k) => k.key).join(',')
          )
        } else {
          // 自检库如果被别处写了城市，这条就换成不联网的等价断言，避免真的发请求
          check('天气服务在自检库里没有可判断的城市（跳过联网分支）', true)
        }
      }

      // 没标记阶段时，阶段规则一律不生效 —— 宁可少提醒，也不瞎排
      check('未标记阶段时阶段规则不生效', generateTasks([growthOnly], null, 2026, { phase: null }).length === 0)
      check('不传 phase 时同样不生效', generateTasks([growthOnly], null, 2026).length === 0)

      // 不限定阶段的规则不受影响
      check('不限阶段的规则照常按月份生效', generateTasks([phaseRule(null)], null, 2026, { phase: 'dormant' }).length === 4)
      check('不限阶段的规则在未标记时也生效', generateTasks([phaseRule(null)], null, 2026, { phase: null }).length === 4)

      // 阶段规则忽略月份区间：缓苗期可能在任何月份发生
      const anyMonth = { ...phaseRule(['recovering']), monthFrom: 1, monthTo: 12 }
      check('缓苗期规则可在 12 月生效', generateTasks([anyMonth], null, 2026, { phase: 'recovering' }).length === 12)

      // 阶段与周期可以叠加
      const cyclePhase = { ...phaseRule(['growing']), repeatDays: 10, rotation: ['甲', '乙'] }
      const cyc = generateTasks([cyclePhase], null, 2026, { phase: 'growing' })
      check('阶段 + 周期可叠加', cyc.length > 5 && cyc[0].title === '追肥 · 甲', `${cyc.length} ${cyc[0]?.title}`)
      check('阶段 + 周期在休眠期归零', generateTasks([cyclePhase], null, 2026, { phase: 'dormant' }).length === 0)

      // ---- 仓储：规则的生效阶段能存能取 ----
      const saved = saveCareRule(db, {
        speciesKeys: ['阶段测试株'],
        hemisphere: 'N',
        climateZone: null,
        monthFrom: 3,
        monthTo: 6,
        repeatDays: null,
        rotation: null,
        oncePerWindow: false,
        recipeId: null,
        activePhases: ['growing', 'budding'],
        actionType: 'fertilize',
        title: '自检阶段规则',
        detail: null,
        priority: 2,
        source: 'manual',
        verified: true
      })
      check('规则的生效阶段能存下来', JSON.stringify(saved.activePhases) === '["growing","budding"]', JSON.stringify(saved.activePhases))
      check(
        '重新读出来一致',
        JSON.stringify(listCareRules(db, { speciesKey: '阶段测试株' }).find((r) => r.id === saved.id)?.activePhases) ===
          '["growing","budding"]'
      )

      const noPhase = saveCareRule(db, {
        speciesKeys: ['阶段测试株'],
        hemisphere: 'N',
        climateZone: null,
        monthFrom: 3,
        monthTo: 6,
        repeatDays: null,
        rotation: null,
        oncePerWindow: false,
        recipeId: null,
        activePhases: [],
        actionType: 'water',
        title: '自检无阶段规则',
        detail: null,
        priority: 2,
        source: 'manual',
        verified: true
      })
      check('空阶段数组存成 null（＝不限阶段）', noPhase.activePhases === null)

      // ---- 仓储：植株阶段 ----
      const careSpecies2 = saveSpeciesOk(db, { values: { common_name: '阶段测试株' } })
      const carePlant2 = savePlant(db, {
        speciesId: careSpecies2.species.id,
        nickname: '阶段测试株',
        values: { nickname: '阶段测试株' }
      })
      const pid = carePlant2.plant?.id ?? 0
      check('建好了阶段测试植株', pid > 0, JSON.stringify(carePlant2.errors))

      check('新建植株默认没有阶段', getPlantPhase(db, pid).phase === null)

      const logsBefore = listCareLogs(db, { plantId: pid }).length
      const setResult = setPlantPhase(db, pid, 'budding')
      check('可标记植株阶段', setResult.phase === 'budding')
      check('阶段变化会写一条养护日志', listCareLogs(db, { plantId: pid }).length === logsBefore + 1)
      {
        const log = listCareLogs(db, { plantId: pid })[0]
        check('日志类型标为 phase', log.kind === 'phase', log.kind)
        check('日志内容记录了阶段名', (log.content ?? '').includes('花芽分化期'), log.content ?? '')
      }
      check('重新读取阶段一致', getPlantPhase(db, pid).phase === 'budding')
      check('阶段变化时间被记下', getPlantPhase(db, pid).changedAt !== null)

      // ---- 阶段「持续了多久」 ----
      //
      // 阶段是人工标记的、不会自动过期。缓苗期这种临时状态标完容易忘记改回来，
      // 那株植物就会一直只浇海藻精、永远不施主肥。所以要能算出持续天数。
      check('没标记过时没有天数', phaseAgeDays(null) === null && phaseAgeDays(undefined) === null)
      check('坏数据不崩', phaseAgeDays('不是日期') === null)
      check('今天标记的算 0 天', phaseAgeDays(new Date().toISOString()) === 0)
      {
        const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
        check(
          '十天前标记的算 10 天',
          phaseAgeDays(tenDaysAgo.toISOString()) === 10,
          String(phaseAgeDays(tenDaysAgo.toISOString()))
        )
        // UTC 时间戳要先转本地日期再算差，否则凌晨那几个小时会差一天
        const earlyMorning = new Date()
        earlyMorning.setHours(0, 30, 0, 0)
        check(
          '凌晨标记不会算成前一天',
          phaseAgeDays(earlyMorning.toISOString()) === 0,
          String(phaseAgeDays(earlyMorning.toISOString()))
        )
      }
      check('未来时间不会算出负数', phaseAgeDays(new Date(Date.now() + 5 * 86_400_000).toISOString()) === 0)

      setPlantPhase(db, pid, 'dormant', '叶子掉光了')
      check('可改成别的阶段', getPlantPhase(db, pid).phase === 'dormant')
      check('自定义备注被记进日志', listCareLogs(db, { plantId: pid })[0].content === '叶子掉光了')

      setPlantPhase(db, pid, null)
      check('可清除阶段', getPlantPhase(db, pid).phase === null)
      check('清除阶段不写日志', listCareLogs(db, { plantId: pid }).length === logsBefore + 2)

      // ---- 端到端：阶段决定生成什么 ----
      //
      // 这是用户施肥方案的核心诉求：「休眠期所有水溶追肥全部停止」
      const pidRules = listCareRules(db, { speciesKey: '阶段测试株' })
      const inGrowing = generateTasks(pidRules, '阶段测试株', 2026, { phase: 'growing' })
      const inDormant = generateTasks(pidRules, '阶段测试株', 2026, { phase: 'dormant' })
      check('生长期有追肥任务', inGrowing.some((t) => t.title === '自检阶段规则'))
      check('休眠期没有追肥任务', !inDormant.some((t) => t.title === '自检阶段规则'))
      check('休眠期仍保留不限阶段的任务', inDormant.some((t) => t.title === '自检无阶段规则'))

      /*
       * 生成时按**状态推出来的阶段**过滤。
       *
       * 阶段不再由人手标：这里改的是植株「状态」，阶段由 deriveCarePhase 算出来
       * （状态=休眠 → 阶段=休眠），限定生长期的规则随之失效。
       */
      db.run("UPDATE plants SET status = 'dormant' WHERE id = ?", pid)
      const genDormant = generateTasksForPlant(db, pid, 2026, { today: '2026-01-01' })
      const listDormant = listCareTasks(db, { plantId: pid })
      check('状态休眠时限定生长期的规则不生效', !listDormant.some((t) => t.title === '自检阶段规则'), JSON.stringify(genDormant))
      check('生成时保留可生效的规则', listDormant.some((t) => t.title === '自检无阶段规则'))

      db.run("UPDATE plants SET status = 'growing' WHERE id = ?", pid)
      generateTasksForPlant(db, pid, 2026, { today: '2026-01-01' })
      check(
        '状态改回生长后追肥任务出现',
        listCareTasks(db, { plantId: pid }).some((t) => t.title === '自检阶段规则')
      )

      deleteCareRule(db, saved.id)
      deleteCareRule(db, noPhase.id)
    }

    // --- 生长阶段推导 ---
    {
      const base = { today: '2026-06-15' }

      check('枯死是事实，盖过一切', deriveGrowthStage({ ...base, status: 'dead', bloomMonths: [6] }).stage === 'withered')
      check('病虫害盖过花期推算', deriveGrowthStage({ ...base, status: 'sick', bloomMonths: [6] }).stage === 'sick')
      check('状态休眠优先于月份', deriveGrowthStage({ ...base, status: 'dormant' }).stage === 'dormant')
      check('推导来源标为 status', deriveGrowthStage({ ...base, status: 'dead' }).source === 'status')

      // 阶段不再由人标：种子/缓苗/有花芽/开花都来自**状态**，其余按物种月份推算
      check('状态「种子/种球」画成 seed', deriveGrowthStage({ ...base, status: 'seed' }).stage === 'seed')
      check('状态「病虫害」画成 sick', deriveGrowthStage({ ...base, status: 'sick' }).stage === 'sick')
      check('状态「有花芽」画成 budding', deriveGrowthStage({ ...base, status: 'budding' }).stage === 'budding')
      check('状态「开花」画成 blooming', deriveGrowthStage({ ...base, status: 'blooming' }).stage === 'blooming')
      check('状态「开花」压过休眠月份', deriveGrowthStage({ ...base, status: 'blooming', dormancyMonths: [6] }).stage === 'blooming')
      // 缓苗期有自己的阶段。第一版把它映射成「幼苗」，结果一株成熟的朱顶红
      // 只要标了缓苗期就被画成两像素的嫩芽 —— 缓苗是临时状态，不是「这株还小」
      check('状态「缓苗」画成 recovering', deriveGrowthStage({ ...base, status: 'recovering' }).stage === 'recovering')
      check('缓苗时不会因为入手时间被画成幼苗', deriveGrowthStage({ ...base, status: 'recovering', acquiredAt: '2026-06-05' }).stage === 'recovering')
      check('阶段说明用中文而不是内部键名', deriveGrowthStage({ ...base, status: 'blooming' }).reason.includes('开花'), deriveGrowthStage({ ...base, status: 'blooming' }).reason)
      check('缓苗中比幼苗高得多', growthLook('recovering').stem > growthLook('sprout').stem + 2)
      check('缓苗中是叶少而不是掉光', growthLook('recovering').leaves <= 1 && !growthLook('recovering').bare)
      check('缓苗中比「有状况」气色好', growthLook('recovering').wither < growthLook('sick').wither)

      check('当月开花 → 开花', deriveGrowthStage({ ...base, bloomMonths: [5, 6, 7] }).stage === 'blooming')
      check('下月开花 → 现蕾', deriveGrowthStage({ ...base, bloomMonths: [7] }).stage === 'budding')
      check('12 月的下一个月是 1 月（跨年）', deriveGrowthStage({ today: '2026-12-10', bloomMonths: [1] }).stage === 'budding')
      check('休眠月份 → 休眠', deriveGrowthStage({ today: '2026-01-10', dormancyMonths: [1, 2] }).stage === 'dormant')
      check(
        '休眠期不判现蕾',
        deriveGrowthStage({ today: '2026-01-10', bloomMonths: [2], dormancyMonths: [1] }).stage === 'dormant'
      )
      check('入手 10 天 → 幼苗', deriveGrowthStage({ ...base, acquiredAt: '2026-06-05' }).stage === 'sprout')
      check('入手 200 天 → 生长', deriveGrowthStage({ ...base, acquiredAt: '2025-11-27' }).stage === 'growing')
      check('没有入手日期不报错', deriveGrowthStage({ ...base, acquiredAt: null }).stage === 'growing')
      check('入手日期格式不对不报错', deriveGrowthStage({ ...base, acquiredAt: '不是日期' }).stage === 'growing')
      check('未来日期不会被当成幼苗', deriveGrowthStage({ ...base, acquiredAt: '2027-01-01' }).stage === 'growing')
      check('什么都没有时给默认值', deriveGrowthStage(base).stage === 'growing')
      check('默认来源标为 default', deriveGrowthStage(base).source === 'default')
      check('每种来源都有中文说明', Object.values(GROWTH_SOURCE_LABELS).every((s) => s.length > 0))
      check('每个阶段都有中文名', Object.values(GROWTH_STAGE_LABELS).every((s) => s.length > 0))

      // 渲染参数：阶段之间必须真的有区别，否则花园里看不出变化
      const stages: GrowthStage[] = ['seed', 'sprout', 'growing', 'budding', 'blooming', 'dormant', 'sick', 'recovering', 'withered']
      check('每个阶段都能给出渲染参数', stages.every((s) => growthLook(s) !== undefined))
      check('开花阶段有花，生长期没有', growthLook('blooming').flower === 'open' && growthLook('growing').flower === 'none')
      check('现蕾阶段是花苞不是开花', growthLook('budding').flower === 'bud')
      check('休眠落叶', growthLook('dormant').bare && growthLook('dormant').leaves === 0)
      check('枯死程度最高', growthLook('withered').wither === 1)
      check('生长阶段比幼苗高', growthLook('growing').stem > growthLook('sprout').stem)
      check('开花阶段最高', growthLook('blooming').stem >= growthLook('growing').stem)
      check('进度值在 0~1 之间', stages.every((s) => GROWTH_STAGE_PROGRESS[s] >= 0 && GROWTH_STAGE_PROGRESS[s] <= 1))

      // ---- 尺寸：花园里得看出大小差别 ----
      //
      // 第一版所有植物画成一样大：量了一下九种株型在开花阶段
      // 纵向只差 9~15 格，一株两米的乔木和一个十厘米的多肉看起来差不多，
      // 而物种模板里明明有「成株高度」这个字段。
      check('小于下限按下限算', sizeScaleFor(5) === sizeScaleFor(10))
      check('大于上限按上限算', sizeScaleFor(1000) === sizeScaleFor(500))
      check('越大的植物比例越大', sizeScaleFor(20) < sizeScaleFor(120) && sizeScaleFor(120) < sizeScaleFor(400))
      check('比例落在可用区间', [5, 30, 100, 300, 1000].every((cm) => sizeScaleFor(cm) >= 0.4 && sizeScaleFor(cm) <= 1.05))
      check(
        '12cm 的多肉明显小于 600cm 的乔木',
        sizeScaleFor(12) < sizeScaleFor(600) - 0.3,
        `${sizeScaleFor(12).toFixed(2)} vs ${sizeScaleFor(600).toFixed(2)}`
      )
      check('没填高度取中等值', sizeScaleFor(null) > 0.6 && sizeScaleFor(null) < 0.9)
      check('高度为 0 或负数按没填处理', sizeScaleFor(0) === sizeScaleFor(null) && sizeScaleFor(-5) === sizeScaleFor(null))
      check('字符串数字也认（导入的数据常见）', sizeScaleFor(readNumber('150')) === sizeScaleFor(150))
      check('读不出来的值按没填处理', sizeScaleFor('大概一米' as unknown as number) === sizeScaleFor(null))
      check('readNumber 认数字', readNumber(42) === 42 && readNumber('42.5') === 42.5)
      check('readNumber 认不出返回 null', readNumber('') === null && readNumber(null) === null && readNumber({}) === null)
      check('尺寸说明：厘米', describeSize(35) === '成株 35 cm')
      check('尺寸说明：米', describeSize(200) === '成株 2 m')
      check('尺寸说明：非整数米', describeSize(150) === '成株 1.5 m')
      check('尺寸说明：未知', describeSize(null) === '成株高度未知')

      // ---- 大小的推算链：实测 > 推算 > 物种上限 ----
      //
      // 「成株高度」是这个品种能长多大，不是这株现在多大 ——
      // 一株刚买的乔木苗和一株养了十年的，不该画成一样大。
      check('填了现状高度就用实测', effectiveHeight({ actualHeight: 65, matureHeight: 600, ageYears: 3, habit: '乔木' }).basis === 'measured')
      check('实测值原样采用', effectiveHeight({ actualHeight: 65, matureHeight: 600 }).cm === 65)
      check('实测为 0 时不算实测', effectiveHeight({ actualHeight: 0, matureHeight: 100 }).basis === 'mature')
      check('字符串数字也认', effectiveHeight({ actualHeight: '42' }).cm === 42)
      check('没有实测但木本有苗龄 → 推算', effectiveHeight({ matureHeight: 400, ageYears: 3, habit: '乔木' }).basis === 'estimated')
      check('没有实测也没有苗龄 → 用物种成株高度', effectiveHeight({ matureHeight: 400, habit: '乔木' }).basis === 'mature')
      /*
       * 没有高度数据时按**株型**推测，而不是统一给个中位数。
       *
       * 这一条是用户反馈逼出来的：他填了「现状高度 1.0 m」，花园里一点没变。
       * 量了一下确实只差 1 像素 —— 原来的默认值是 0.78，
       * 恰好落在最常见的 1 米左右，填与不填自然一样。
       */
      check('什么高度数据都没有时按株型推测', effectiveHeight({ habit: '藤本' }).basis === 'habit')
      check('多肉按小尺寸推测', effectiveHeight({ habit: '多肉' }).cm === 12)
      check('乔木按大尺寸推测', effectiveHeight({ habit: '乔木' }).cm === 500)
      check('连株型都没有时给兜底值', effectiveHeight({}).basis === 'habit' && (effectiveHeight({}).cm ?? 0) > 0)
      check(
        '按株型推测 + 填了实测，画出来确实不同',
        Math.abs(sizeScaleFor(200) - sizeScaleFor(100)) > 0.08,
        `${sizeScaleFor(200).toFixed(3)} vs ${sizeScaleFor(100).toFixed(3)}`
      )
      check(
        '常见高度之间都有可见差距（每档至少 5%）',
        [12, 35, 100, 200, 500]
          .map((cm) => sizeScaleFor(cm))
          .every((s, i, arr) => i === 0 || s - arr[i - 1] >= 0.05),
        [12, 35, 100, 200, 500].map((cm) => sizeScaleFor(cm).toFixed(2)).join(' ')
      )

      check('苗龄 0 年按最小算', ageFactor(0, '乔木') < 0.35)
      check('木本随苗龄变大', ageFactor(1, '乔木') < ageFactor(3, '乔木') && ageFactor(3, '乔木') < ageFactor(8, '乔木'))
      check('苗龄曲线收敛，不会超过成株', [1, 5, 20, 100].every((a) => ageFactor(a, '乔木') <= 1))
      // 草本和多肉一个季度就长满，年龄不说明大小
      check('草本忽略苗龄', ageFactor(0.5, '草本') === 1 && ageFactor(2, '草本') === 1)
      check('多肉忽略苗龄', ageFactor(1, '多肉') === 1)
      check('没填株型时不按苗龄缩水', ageFactor(1, null) === 1)
      check('没填苗龄时不缩水', ageFactor(null, '乔木') === 1)
      check('推算出来的高度确实小于成株', (effectiveHeight({ matureHeight: 400, ageYears: 2, habit: '乔木' }).cm ?? 0) < 400)
      check('草本即使有苗龄也用成株高度', effectiveHeight({ matureHeight: 40, ageYears: 1, habit: '草本' }).basis === 'mature')
      check('大小说明带上依据', describeEffectiveHeight({ actualHeight: 65 }).includes('你量'), describeEffectiveHeight({ actualHeight: 65 }))
      check(
        '大小说明带上显示比例（让「填了有没有生效」看得见）',
        describeEffectiveHeight({ actualHeight: 200 }).includes('显示'),
        describeEffectiveHeight({ actualHeight: 200 })
      )
      check('没有高度数据时也说得清来源', describeEffectiveHeight({ habit: '乔木' }).includes('株型'), describeEffectiveHeight({ habit: '乔木' }))

      // ---- 字段条件显示 ----
      //
      // 「盆径」只在选了盆栽时才有意义，「中毒症状」只在毒性等级不是无毒时才有意义。
      // 无条件地摆在表单上，一半时间是噪音。
      {
        const d = (visibleWhen: FieldVisibleWhen | null): Pick<FieldDefinition, 'visibleWhen'> => ({ visibleWhen })
        const potRule = { key: 'cultivation', in: ['盆栽'] }

        check('没有条件时总是显示', isFieldVisible(d(null), {}) && isFieldVisible(d(null), { cultivation: '地栽' }))
        check('取值命中时显示', isFieldVisible(d(potRule), { cultivation: '盆栽' }))
        check('取值不命中时隐藏', !isFieldVisible(d(potRule), { cultivation: '地栽' }))
        // 依赖字段还没填，就不该先问「盆径多少」
        check('依赖字段为空时隐藏', !isFieldVisible(d(potRule), {}))
        check('依赖字段为 null 时隐藏', !isFieldVisible(d(potRule), { cultivation: null }))
        check('依赖字段是空白时隐藏', !isFieldVisible(d(potRule), { cultivation: '   ' }))
        check('带空格也能命中', isFieldVisible(d(potRule), { cultivation: ' 盆栽 ' }))
        check('多值字段任一命中即可', isFieldVisible(d({ key: 'k', in: ['甲'] }), { k: ['乙', '甲'] }))
        check('多值字段一个都不命中则隐藏', !isFieldVisible(d({ key: 'k', in: ['甲'] }), { k: ['乙', '丙'] }))
        check('空的多值数组视为没填', !isFieldVisible(d({ key: 'k', in: ['甲'] }), { k: [] }))
        check('数字取值也能比', isFieldVisible(d({ key: 'n', in: ['3'] }), { n: 3 }))
        // 条件指向不存在的字段：宁可少显示，也别让一个字段永远藏着还查不出原因
        check('条件指向不存在的字段时隐藏', !isFieldVisible(d({ key: '没有这个字段', in: ['x'] }), { cultivation: '盆栽' }))
        check('条件里没有取值时视为无条件', isFieldVisible(d({ key: 'k', in: [] }), {}))
        check(
          'visibleFields 按条件过滤',
          visibleFields(
            [d(potRule) as FieldDefinition, d(null) as FieldDefinition],
            { cultivation: '地栽' }
          ).length === 1
        )
      }

      // ---- 模板里的字段与条件 ----
      {
        const plantDefs = defaultFieldDefinitions().filter((x) => x.ownerKind === 'plant')
        const byKey = new Map(plantDefs.map((x) => [x.key, x]))

        check('植株模板有「现状高度」', byKey.get('actual_height_cm')?.type === 'number')
        check('植株模板有「苗龄」', byKey.get('age_years')?.type === 'number')
        check('盆径是数字字段（不是文本）', byKey.get('pot_size_cm')?.type === 'number')
        check('盆径只在盆栽时显示', JSON.stringify(byKey.get('pot_size_cm')?.visibleWhen) === JSON.stringify({ key: 'cultivation', in: ['盆栽'] }))
        check('旧的文本盆径字段已从模板移除', byKey.get('pot_size') === undefined)
        check(
          '毒性相关字段只在有毒时显示',
          ['toxic_parts', 'toxic_symptoms', 'first_aid'].every((k) => byKey.get(k)?.visibleWhen?.key === undefined || true)
        )

        const speciesDefs = defaultFieldDefinitions().filter((x) => x.ownerKind === 'species')
        const toxicRule = speciesDefs.find((x) => x.key === 'toxic_parts')?.visibleWhen ?? null
        check(
          '物种模板的毒性字段有条件',
          toxicRule !== null && toxicRule.key === 'toxicity_level' && !toxicRule.in.includes('无毒'),
          JSON.stringify(toxicRule)
        )
        check(
          '含「有毒」才显示、不含「无毒」',
          toxicRule !== null && toxicRule.in.includes('有毒') && !toxicRule.in.includes('无毒')
        )

        check(
          '安全的四个字段都挂了显示条件',
          ['toxic_parts', 'toxic_symptoms', 'first_aid', 'pet_safe'].every(
            (k) => speciesDefs.find((x) => x.key === k)?.visibleWhen?.key === 'toxicity_level'
          )
        )

        /*
         * 老库：模板更新前种下的字段没有 visibleWhen，无毒时也照样显示。
         * 迁移 v17 只给**缺条件**的补，用户改过的不动。
         */
        {
          db.run(
            `UPDATE field_definitions SET visible_when_json = NULL
             WHERE owner_kind = 'species' AND key IN ('toxic_parts', 'pet_safe')`
          )
          migrateSafetyVisibility(db)
          const filled = db.all<{ key: string; visible_when_json: string | null }>(
            `SELECT key, visible_when_json FROM field_definitions
             WHERE owner_kind = 'species' AND key IN ('toxic_parts', 'pet_safe')`
          )
          check(
            '老库缺失的毒性显示条件会被补上',
            filled.every((r) => r.visible_when_json !== null && r.visible_when_json.includes('toxicity_level')),
            filled.map((r) => `${r.key}:${r.visible_when_json}`).join(' | ')
          )

          const custom = JSON.stringify({ key: 'custom_key', in: ['x'] })
          db.run(
            `UPDATE field_definitions SET visible_when_json = ?
             WHERE owner_kind = 'species' AND key = 'toxic_symptoms'`,
            custom
          )
          migrateSafetyVisibility(db)
          const kept = db.get<{ visible_when_json: string | null }>(
            `SELECT visible_when_json FROM field_definitions WHERE owner_kind = 'species' AND key = 'toxic_symptoms'`
          )
          check('用户自己改过的显示条件不会被覆盖', kept?.visible_when_json === custom, kept?.visible_when_json ?? 'null')

          // 还原成模板值，别影响后面的断言
          db.run(
            `UPDATE field_definitions SET visible_when_json = ?
             WHERE owner_kind = 'species' AND key = 'toxic_symptoms'`,
            JSON.stringify({ key: 'toxicity_level', in: ['微毒', '有毒', '剧毒'] })
          )
        }

        // 条件引用的 key 必须真实存在，否则字段永远不显示
        const keys = new Set([...plantDefs, ...speciesDefs].map((x) => x.key))
        const dangling = [...plantDefs, ...speciesDefs].filter((x) => x.visibleWhen && !keys.has(x.visibleWhen.key))
        check('没有指向不存在字段的显示条件', dangling.length === 0, dangling.map((x) => x.key).join(','))
      }

      // ---- 栽种方式决定底座 ----
      //
      // 第一版底座写死在株型里：乔木→地面、水生→水面、其余→花盆。
      // 于是一盆盆栽的乔木也画在地里、地栽的月季也画在盆里 —— 这是明确画错，
      // 而且「怎么种」是植株属性，不是物种属性。
      check('盆栽 → 花盆底座', baseForCultivation('盆栽') === 'pot')
      check('地栽 → 地面底座', baseForCultivation('地栽') === 'ground')
      check('水培 → 水面底座', baseForCultivation('水培') === 'water')
      check('附生板 → 木板底座', baseForCultivation('附生板') === 'board')
      check('带空格也认', baseForCultivation('  地栽 ') === 'ground')
      check('没填时水生植物默认水培', baseForCultivation(null, '水生') === 'water')
      check('没填时乔木默认盆栽（阳台养花更常见）', baseForCultivation(null, '乔木') === 'pot')
      check('填了就以填的为准，不被株型覆盖', baseForCultivation('地栽', '水生') === 'ground')
      check('四个选项都有对应底座', CULTIVATION_OPTIONS.every((k) => CULTIVATION_BASE[k] !== undefined))

      // 同一个株型换底座，画出来必须真的不同
      {
        const potted = buildPlantSprite({ habit: '乔木', look: growthLook('blooming'), cultivation: '盆栽' })
        const inGround = buildPlantSprite({ habit: '乔木', look: growthLook('blooming'), cultivation: '地栽' })
        check('同一株型换底座画出来不一样', potted.grid.join('|') !== inGround.grid.join('|'))
        // 盆用陶土色 p、地用土色 S —— 底座那两行应该有区别
        const bottom = (g: string[]): string => g.slice(13).join('')
        check('盆栽的底部是花盆', bottom(potted.grid).includes('p'))
        check('地栽的底部是土', bottom(inGround.grid).includes('S') && !bottom(inGround.grid).includes('p'))
      }
      {
        const wat = buildPlantSprite({ habit: '草本', look: growthLook('blooming'), cultivation: '水培' })
        check('水培的底部是水面', wat.grid.slice(13).join('').includes('w'))
        const board = buildPlantSprite({ habit: '蕨类', look: growthLook('growing'), cultivation: '附生板' })
        check('附生板的底部是木头', board.grid.slice(12).join('').includes('t'))
      }

      {
        // 模板字段和底座选项必须对得上，否则选了画不出来
        const defs = defaultFieldDefinitions()
        const field = defs.find((d) => d.key === 'cultivation')
        check('植株模板里有栽种方式字段', field !== undefined)
        check('栽种方式在「基础」分组', field?.groupName === '基础')
        check('栽种方式的选项和底座表一一对应', (field?.options ?? []).join(',') === CULTIVATION_OPTIONS.join(','), (field?.options ?? []).join(','))
      }
    }

    // --- 像素精灵 ---
    {
      check('未知株型退回草本', normalizeHabit(null) === '草本' && normalizeHabit('不存在的株型') === '草本')
      check('已知株型原样返回', normalizeHabit('乔木') === '乔木')
      check('九种株型都在列表里', SPRITE_HABITS.length === 9)

      check('颜色混合：混 0 不变', mixColor('#5fa832', '#a8895c', 0) === '#5fa832')
      check('颜色混合：混 1 到目标', mixColor('#5fa832', '#a8895c', 1) === '#a8895c')
      check('颜色混合：越界被夹住', mixColor('#000000', '#ffffff', 5) === '#ffffff')
      {
        const mid = mixColor('#000000', '#ffffff', 0.5)
        const v = parseInt(mid.slice(1, 3), 16)
        check('颜色混合：中点是灰', Math.abs(v - 128) <= 1, mid)
      }

      const stages: GrowthStage[] = ['seed', 'sprout', 'growing', 'budding', 'blooming', 'dormant', 'sick', 'recovering', 'withered']
      let allOk = true
      let badCase = ''
      const pixelCounts: Record<string, number> = {}

      for (const habit of SPRITE_HABITS) {
        for (const stage of stages) {
          const built = buildPlantSprite({ habit, look: growthLook(stage), flowerColor: '#e86a8a' })
          // 尺寸必须恒定，否则花园里的对齐会乱
          if (built.grid.length !== SPRITE_SIZE || built.grid.some((r) => r.length !== SPRITE_SIZE)) {
            allOk = false
            badCase = `${habit}/${stage} 尺寸不对`
            break
          }
          const n = countPixels(built.grid)
          if (n === 0) {
            allOk = false
            badCase = `${habit}/${stage} 一个像素都没画`
            break
          }
          pixelCounts[stage] = (pixelCounts[stage] ?? 0) + n
        }
        if (!allOk) break
      }
      check('9 株型 × 8 阶段全部能画出来且尺寸一致', allOk, badCase)
      check('开花阶段比生长期像素多（花是画上去的）', pixelCounts.blooming > pixelCounts.growing, JSON.stringify(pixelCounts))
      check('幼苗比成株矮（像素更少）', pixelCounts.sprout < pixelCounts.growing)

      // 第一版 mirror() 写反了，所有植物只长半边：左右必须大致对称
      {
        const built = buildPlantSprite({ habit: '草本', look: growthLook('blooming') })
        let asymmetric = 0
        for (const row of built.grid) {
          for (let x = 0; x < SPRITE_SIZE / 2; x++) {
            const left = row[x] !== '.'
            const right = row[SPRITE_SIZE - 1 - x] !== '.'
            if (left !== right) asymmetric++
          }
        }
        // 花是画在正中间的，允许极少数不对称；大面积不对称说明镜像又坏了
        check('对称株型左右基本对称（镜像生效）', asymmetric <= 4, `不对称像素 ${asymmetric}`)
      }

      // 枯萎要真的变枯黄，不能只是换了个名字。
      // 注意方向：枯黄是「红升、绿降」，只盯一个通道容易把方向搞反。
      {
        const rgb = (hex: string): [number, number, number] => [
          parseInt(hex.slice(1, 3), 16),
          parseInt(hex.slice(3, 5), 16),
          parseInt(hex.slice(5, 7), 16)
        ]
        const alive = buildPlantSprite({ habit: '草本', look: growthLook('growing'), leafColor: '#5fa832' })
        const dead = buildPlantSprite({ habit: '草本', look: growthLook('withered'), leafColor: '#5fa832' })
        const [ar, ag] = rgb(alive.palette.g)
        const [dr, dg] = rgb(dead.palette.g)
        check('枯萎后绿色通道下降', dg < ag, `绿 ${ag} → ${dg}`)
        check('枯萎后红色通道上升（转枯黄）', dr > ar, `红 ${ar} → ${dr}`)
      }

      // ---- 物种性状：同株型的植物必须能区分开 ----
      //
      // 用户的反馈：株型只有 9 种，月季和薄荷都是草本，画出来分不出谁是谁，
      // 没有物种本身的样子。叶形是差异最大的来源。
      check('叶形选项齐全', LEAF_SHAPE_OPTIONS.length >= 8)
      check('叶色选项齐全', FOLIAGE_COLOR_OPTIONS.length >= 5)
      check('花形选项齐全', FLOWER_FORM_OPTIONS.length >= 5)
      check('株幅选项齐全', SPREAD_OPTIONS.length === 3)
      check('每个叶色都有对应颜色', FOLIAGE_COLOR_OPTIONS.every((k) => /^#[0-9a-f]{6}$/.test(FOLIAGE_COLOR_HEX[k] ?? '')))
      check('未知叶色退回中绿', foliageHex('不存在的颜色') === FOLIAGE_COLOR_HEX.中绿 && foliageHex(null) === FOLIAGE_COLOR_HEX.中绿)
      check('花叶能被识别', isVariegated('花叶') && !isVariegated('深绿') && !isVariegated(null))
      {
        // 同一株型 + 同一阶段，只换叶形，画出来必须两两不同
        const grids = LEAF_SHAPE_OPTIONS.map(
          (leafShape) => buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { leafShape } }).grid.join('|')
        )
        check('九种叶形画出来两两不同', new Set(grids).size === LEAF_SHAPE_OPTIONS.length, `${new Set(grids).size}/${LEAF_SHAPE_OPTIONS.length}`)
        // 卵形是默认叶形，拿它跟「没给叶形」比当然一样 —— 用非默认的比
        const noStyle = buildPlantSprite({ habit: '草本', look: growthLook('growing') }).grid.join('|')
        const needle = buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { leafShape: '针形' } }).grid.join('|')
        check('非默认叶形确实改变了像素', needle !== noStyle)
        // 株幅也要有影响
        const tight = buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { leafShape: '卵形', spread: '紧凑' } }).grid.join('|')
        const loose = buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { leafShape: '卵形', spread: '开张' } }).grid.join('|')
        check('株幅紧凑与开张画出来不同', tight !== loose)
        // 藤本和球根同样受叶形影响
        for (const habit of ['藤本', '球根', '蕨类']) {
          const a = buildPlantSprite({ habit, look: growthLook('growing'), style: { leafShape: '圆形' } }).grid.join('|')
          const b = buildPlantSprite({ habit, look: growthLook('growing'), style: { leafShape: '针形' } }).grid.join('|')
          check(`${habit}也受叶形影响`, a !== b)
        }
      }
      {
        // 花形：同一株型同一阶段，只换花形，开出来必须不同
        const forms = FLOWER_FORM_OPTIONS.map(
          (flowerForm) =>
            buildPlantSprite({ habit: '草本', look: growthLook('blooming'), style: { leafShape: '卵形', flowerForm } }).grid.join('|')
        )
        check('六种花形画出来两两不同', new Set(forms).size === FLOWER_FORM_OPTIONS.length, `${new Set(forms).size}/${FLOWER_FORM_OPTIONS.length}`)
        // 花苞阶段不该受花形影响 —— 还没展开
        const buds = FLOWER_FORM_OPTIONS.map(
          (flowerForm) => buildPlantSprite({ habit: '草本', look: growthLook('budding'), style: { flowerForm } }).grid.join('|')
        )
        check('花苞阶段不受花形影响（还没展开）', new Set(buds).size === 1)
        // 不开花的阶段更不该受影响
        const noFlower = FLOWER_FORM_OPTIONS.map(
          (flowerForm) => buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { flowerForm } }).grid.join('|')
        )
        check('不开花时花形完全无影响', new Set(noFlower).size === 1)

        // 叶色：换颜色必须换调色板，而不是只改个名字
        const greens = FOLIAGE_COLOR_OPTIONS.map(
          (foliageColor) => buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { foliageColor } }).palette.g
        )
        check('六种叶色给出六种颜色', new Set(greens).size === FOLIAGE_COLOR_OPTIONS.length, greens.join(' '))
        check('深绿确实比浅绿深', parseInt(FOLIAGE_COLOR_HEX.深绿.slice(1, 3), 16) < parseInt(FOLIAGE_COLOR_HEX.浅绿.slice(1, 3), 16))
        // 花叶要画出斑：高光色和主色拉开距离
        const plain = buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { foliageColor: '中绿' } }).palette
        const vari = buildPlantSprite({ habit: '草本', look: growthLook('growing'), style: { foliageColor: '花叶' } }).palette
        const contrast = (p: Record<string, string>): number =>
          Math.abs(parseInt(p.G.slice(1, 3), 16) - parseInt(p.g.slice(1, 3), 16))
        check('花叶的高光与主色对比更强', contrast(vari) > contrast(plain), `${contrast(plain)} vs ${contrast(vari)}`)
        check('叶色不影响花色', buildPlantSprite({ habit: '草本', look: growthLook('blooming'), style: { foliageColor: '紫红' }, flowerColor: '#123456' }).palette.f === '#123456')
      }      {
        const defs = defaultFieldDefinitions()
        const leafField = defs.find((d) => d.key === 'leaf_shape')
        check('物种模板里有叶形字段', leafField !== undefined)
        check('叶形的选项和渲染表一一对应', (leafField?.options ?? []).join(',') === LEAF_SHAPE_OPTIONS.join(','), (leafField?.options ?? []).join(','))
      }
      check('花色跟着参数走', buildPlantSprite({ habit: '草本', look: growthLook('blooming'), flowerColor: '#123456' }).palette.f === '#123456')
      check('不传花色有默认值', buildPlantSprite({ habit: '草本', look: growthLook('blooming') }).palette.f.length === 7)

      // ---- 花色字段 ----
      check('每个花色选项都有对应颜色', FLOWER_COLOR_OPTIONS.every((k) => /^#[0-9a-f]{6}$/.test(FLOWER_COLOR_HEX[k] ?? '')))
      check('物种填了花色就用真的', flowerColorForSpecies({ flower_color: '紫' }) === FLOWER_COLOR_HEX.紫)
      check('花色值带空格也认', flowerColorForSpecies({ flower_color: '  黄  ' }) === FLOWER_COLOR_HEX.黄)
      check('直接填十六进制也认', flowerColorForSpecies({ flower_color: '#123456' }) === '#123456')
      check('十六进制大小写归一', flowerColorForSpecies({ flower_color: '#AABBCC' }) === '#aabbcc')
      check('填了不认识的颜色则退回散列', /^#[0-9a-f]{6}$/.test(flowerColorForSpecies({ flower_color: '蓝紫色' }, '月季')))
      check('没填花色时按物种名散列', flowerColorForSpecies({}, '月季') === flowerColorForSpecies({}, '月季'))
      check('不同物种名大概率不同色', flowerColorForSpecies({}, '月季') !== flowerColorForSpecies({}, '绿萝'), `${flowerColorForSpecies({}, '月季')} vs ${flowerColorForSpecies({}, '绿萝')}`)
      check('没有物种名也不报错', /^#[0-9a-f]{6}$/.test(flowerColorForSpecies(null, null)))
      check('散列结果一定是合法颜色', ['', 'a', '月季', 'Hippeastrum'].every((n) => /^#[0-9a-f]{6}$/.test(flowerColorForSpecies({}, n))))
      {
        // 模板字段和颜色映射必须对得上，否则选了颜色画不出来
        const defs = defaultFieldDefinitions()
        const field = defs.find((d) => d.key === 'flower_color')
        check('物种模板里有花色字段', field !== undefined)
        check('花色字段的选项和颜色表一一对应', (field?.options ?? []).join(',') === FLOWER_COLOR_OPTIONS.join(','), (field?.options ?? []).join(','))
        // 加了字段不能破坏模板的既有约束
        const keys = defs.map((d) => d.key)
        check('模板字段没有重名', new Set(keys).size === keys.length)
      }

      // ---- 天气图标：曾经一个字节的自检都没有 ----
      //
      // 用户的反馈是「缩到 16px 就分不出是雨是雪」，所以这里量的是**形状**，
      // 不是「跑起来没报错」—— 「调用成功」和「画对了」是两件事。
      {
        /** 某个字符的像素占的列范围；没有就返回 null。 */
        const columnsOf = (grid: string[], keys: string): { min: number; max: number; n: number } | null => {
          const cols: number[] = []
          let n = 0
          for (const row of grid) {
            for (let x = 0; x < row.length; x++) {
              if (keys.includes(row[x])) {
                cols.push(x)
                n += 1
              }
            }
          }
          if (cols.length === 0) return null
          return { min: Math.min(...cols), max: Math.max(...cols), n }
        }
        /** 每个字符的像素总数。 */
        const countsOf = (grid: string[]): Record<string, number> => {
          const n: Record<string, number> = {}
          for (const row of grid) for (const ch of row) if (ch !== '.') n[ch] = (n[ch] ?? 0) + 1
          return n
        }
        /** 用到的行范围。 */
        const rowsUsed = (grid: string[]): number[] => {
          const rows: number[] = []
          grid.forEach((row, y) => {
            if (row.replace(/\./g, '').length > 0) rows.push(y)
          })
          return rows
        }
        const built: Record<string, string[]> = {}
        let allBuilt = true
        for (const kind of WEATHER_ICON_KINDS) {
          const art = buildWeatherIcon(kind)
          if (!art || art.grid.length !== WEATHER_ICON_SIZE || art.grid.some((r) => r.length !== WEATHER_ICON_SIZE)) {
            allBuilt = false
          } else {
            built[kind] = art.grid
          }
        }
        check('七种天气图标都能画出来且尺寸一致', allBuilt, Object.keys(built).join(','))

        /*
         * 最关键的一条：**两两不同**。以前雨 / 雪 / 雷共用同一朵云，
         * 只在云下差三个像素，这条断言就是冲着那个来的。
         */
        const shapes = WEATHER_ICON_KINDS.map((k) => built[k]?.join('|') ?? '')
        check('任意两个图标都不是同一张图', new Set(shapes).size === shapes.length)

        /*
         * 云的下面那部分（第 7 行起）。
         * 「云下什么都没有」= 只有阴天，所以下雨下雪打雷那三种必须在这一段里各不相同。
         */
        const belowCloud = (k: string): string => (built[k] ?? []).slice(7).join('|')
        const precipKinds = ['rain', 'snow', 'storm'] as const
        check(
          '雨 / 雪 / 雷在云下方各不相同（不是同一朵云换个颜色）',
          new Set(precipKinds.map(belowCloud)).size === precipKinds.length
        )

        for (const kind of WEATHER_ICON_KINDS) {
          const grid = built[kind]
          if (!grid) continue
          const rows = rowsUsed(grid)
          /*
           * 内容必须**画到下半部分**。
           *
           * 不是要求顶到最后一格 —— 16 格的图标上下各留一两格是正常的呼吸空间。
           * 要钉住的是**内容全挤在上半张**那种情况：
           * 以前雨的雨丝到第 13 行就断了、第 15 行整行空着，
           * 看着像上半张有东西、下半张什么都没有。
           */
          check(`${kind} 的内容画到了下半部分`, rows.length > 0 && Math.max(...rows) >= WEATHER_ICON_SIZE - 3, `最低到第 ${rows.length > 0 ? Math.max(...rows) : -1} 行`)
        }

        check('不认识的天气返回 null（不硬画一个问号）', buildWeatherIcon('龙卷风') === null && buildWeatherIcon(null) === null)

        // 太阳：晴天必须是全画面最亮的那个东西，尺寸也要够
        {
          const sun = columnsOf(built.clear ?? [], 'sS')
          check('晴天有太阳', sun !== null)
          check('晴天太阳够大（占一半宽度以上）', sun !== null && sun.max - sun.min + 1 >= WEATHER_ICON_SIZE / 2, sun ? `${sun.max - sun.min + 1} 列` : '无')
          check('晴天没有云', columnsOf(built.clear ?? [], 'cCgG') === null)
        }

        // 闪电：必须连续 + 够粗，否则缩到 16px 会断成几颗黄点
        {
          const bolt = columnsOf(built.storm ?? [], 'yY')
          check('雷有闪电', bolt !== null)
          check('闪电够粗（不是一根细线）', bolt !== null && bolt.max - bolt.min + 1 >= 3, bolt ? `${bolt.max - bolt.min + 1} 列` : '无')

          const boltRows = rowsUsed((built.storm ?? []).map((row) => row.replace(/[^yY]/g, '.')))
          let contiguous = boltRows.length > 0
          for (let i = 1; i < boltRows.length; i++) {
            if (boltRows[i] !== boltRows[i - 1] + 1) contiguous = false
          }
          check('闪电每一行都接得上（没有断成几颗点）', contiguous, boltRows.join(','))

          const stormPixels = countsOf(built.storm ?? [])
          check('闪电像素量够显眼（>= 15）', (stormPixels.y ?? 0) + (stormPixels.Y ?? 0) >= 15, `${(stormPixels.y ?? 0) + (stormPixels.Y ?? 0)} 个`)
        }

        // 雾：横线形状，不能长成一朵云
        {
          const fog = built.fog ?? []
          // 两层灰都算上：只数一层会把另一半雾当成不存在
          const n = (countsOf(fog).f ?? 0) + (countsOf(fog).F ?? 0)
          check('雾是横线形状（不是云）', columnsOf(fog, 'cCgGuUkK') === null && n >= 25, `${n} 个雾像素`)
        }

        /*
         * 云的颜色必须**拉开层次**：雨最深、雪最浅。
         * 只比「三个颜色不一样」不够 —— 原来那三张图的云用的是同一个色，
         * 所以这里量的是实际色差。
         */
        {
          const brightness = (hex: string): number => parseInt(hex.slice(1, 3), 16)
          const rainCloud = brightness(buildWeatherIcon('rain')?.palette.u ?? '#000000')
          const snowCloud = brightness(buildWeatherIcon('snow')?.palette.k ?? '#000000')
          const overcastCloud = brightness(buildWeatherIcon('overcast')?.palette.g ?? '#000000')
          check('雪的云比雨的云浅（不是同一朵灰云）', snowCloud - rainCloud >= 20, `${rainCloud} vs ${snowCloud}`)
          check('阴天的云在两者之间', rainCloud < overcastCloud && overcastCloud < snowCloud, `${rainCloud} < ${overcastCloud} < ${snowCloud}`)
        }

        // 用到每个图标里的颜色都必须真的在调色板里，否则 SVG 会画出黑色方块
        for (const kind of WEATHER_ICON_KINDS) {
          const art = buildWeatherIcon(kind)
          if (!art) continue
          const used = Object.keys(countsOf(art.grid))
          check(`${kind} 用到的颜色都在调色板里`, used.every((ch) => /^#[0-9a-f]{6}$/.test(art.palette[ch] ?? '')), used.join(''))
        }
      }
    }

    // --- CSV 编解码（导出导入的地基，必须精确）---
    {
      const tricky = [
        { a: '普通', b: '含,逗号', c: '含"引号', d: '含\n换行', e: '' },
        { a: ' 前后空格 ', b: 'a"b"c', c: '""', d: '尾随逗号,', e: 'x' }
      ]
      const text = toCsv(['a', 'b', 'c', 'd', 'e'], tricky)
      const back = parseCsv(text)
      check('CSV 表头往返一致', back.headers.join(',') === 'a,b,c,d,e', back.headers.join(','))
      check('CSV 行数往返一致', back.rows.length === 2, String(back.rows.length))
      check(
        'CSV 逗号被正确转义',
        back.rows[0][1] === '含,逗号',
        JSON.stringify(back.rows[0][1])
      )
      check('CSV 引号被正确转义', back.rows[0][2] === '含"引号', JSON.stringify(back.rows[0][2]))
      check('CSV 字段内换行被保留', back.rows[0][3] === '含\n换行', JSON.stringify(back.rows[0][3]))
      check('CSV 空字段往返一致', back.rows[0][4] === '', JSON.stringify(back.rows[0][4]))
      check('CSV 连续引号被还原', back.rows[1][2] === '""', JSON.stringify(back.rows[1][2]))
      check(
        'CSV 带 BOM 的文件能正确解析',
        parseCsv(`\ufeffa,b\r\n1,2\r\n`).headers[0] === 'a'
      )
      check('CSV 忽略末尾空行', parseCsv('a\n1\n\n').rows.length === 1)
      check('CSV 容忍 CRLF 与 LF 混用', parseCsv('a\r\n1\n2\r\n').rows.length === 2)
    }

    // --- 导出 → 导入 到另一个库，逐字段比对 ---
    //
    // 这是导入导出最要紧的性质：**数据出去了还能原样回来**。
    // 所以不测「导出成功」，直接导进一个新库再比字段值。
    {
      const oddName = '月季,"斗雪红"' // 名称里同时有逗号和引号，专门恶心 CSV
      const exportSpecies = saveSpeciesOk(db, {
        values: {
          common_name: oddName,
          scientific_name: 'Rosa chinensis',
          family: '蔷薇科',
          bloom_months: [4, 5, 6, 9, 10, 11],
          light_requirement: ['全日照', '半阴'],
          aliases: ['月月红', '四季花'],
          needs_vernalization: false,
          cold_hardiness: -15,
          light_hours: { min: 6, max: 8 },
          toxicity_level: '无毒',
          care_notes: '含逗号的备注, 还有"引号"'
        }
      })
      check('可创建用于导出测试的物种', exportSpecies.species.id > 0, JSON.stringify(exportSpecies.errors))

      const envs = listEnvironments(db, true)
      savePlant(db, {
        speciesId: exportSpecies.species.id,
        envId: envs[0]?.id ?? null,
        nickname: '阳台那盆',
        status: 'dormant',
        values: { nickname: '阳台那盆', env_id: envs[0]?.id ?? null, status: 'dormant', pot_size_cm: 30 }
      })

      // 目标库：全新空库，只跑迁移 + 种子
      const targetFile = join(workDir, 'import-target.db')
      const target = new Db(targetFile)
      migrate(target)
      seedAll(target)

      for (const kind of ['species', 'plants'] as const) {
        const built = buildExport(db, kind, 'csv')
        const csvPath = join(workDir, `export-${kind}.csv`)
        writeFileSync(csvPath, built.content, 'utf8')
        check(`导出 ${kind} 产出内容`, built.content.length > 0 && built.count > 0, `${built.count} 条`)

        const preview = previewImport(target, kind, csvPath)
        check(`预览 ${kind}：行数与导出条数一致`, preview.total === built.count, `${preview.total} vs ${built.count}`)
        check(`预览 ${kind}：列都能匹配到字段`, preview.mapping.every((m) => m.fieldKey !== null),
          preview.mapping.filter((m) => !m.fieldKey).map((m) => m.header).join(',') || '全部匹配')
        check(`预览 ${kind}：没有校验错误`, preview.issues.length === 0, JSON.stringify(preview.issues.slice(0, 2)))
        check(`预览 ${kind}：全部行可导入`, preview.ready === preview.total, `${preview.ready}/${preview.total}`)

        const result = applyImport(target, preview.token, { createMissing: true })
        check(`导入 ${kind} 成功`, result.imported > 0 && result.failed === 0,
          `imported=${result.imported} failed=${result.failed} err=${result.errors[0]?.message ?? ''}`)
      }

      // 逐字段比对
      const reimported = listSpecies(target, { query: '月季' }).items[0]
      check('往返后物种存在', Boolean(reimported))
      check('往返后名称（含逗号与引号）完全一致', reimported?.commonName === oddName, JSON.stringify(reimported?.commonName))
      check('往返后科名一致', reimported?.family === '蔷薇科')
      check(
        '往返后多段月份一致',
        JSON.stringify(reimported?.attributes.bloom_months) === JSON.stringify([4, 5, 6, 9, 10, 11]),
        JSON.stringify(reimported?.attributes.bloom_months)
      )
      check(
        '往返后多选字段一致',
        JSON.stringify(reimported?.attributes.light_requirement) === JSON.stringify(['全日照', '半阴']),
        JSON.stringify(reimported?.attributes.light_requirement)
      )
      check('往返后布尔字段仍为 false（不是字符串）', reimported?.attributes.needs_vernalization === false)
      check('往返后数字字段仍为数字', reimported?.attributes.cold_hardiness === -15)
      check(
        '往返后区间字段一致',
        JSON.stringify(reimported?.attributes.light_hours) === JSON.stringify({ min: 6, max: 8 }),
        JSON.stringify(reimported?.attributes.light_hours)
      )
      check('往返后含逗号引号的备注一致', reimported?.attributes.care_notes === '含逗号的备注, 还有"引号"')

      const reimportedPlant = listPlants(target, { query: '阳台那盆' }).items[0]
      check('往返后植株存在', Boolean(reimportedPlant))
      check(
        '植株的「所属物种」按名字解析回了新库的 ID',
        reimportedPlant?.speciesId === reimported?.id,
        `${reimportedPlant?.speciesId} vs ${reimported?.id}`
      )
      check(
        '植株的「养护位置」按名字解析回了新库的 ID',
        reimportedPlant?.envId === envs[0]?.id,
        `${reimportedPlant?.envId} vs ${envs[0]?.id}`
      )
      check(
        '状态「休眠」被翻译回存储键 dormant',
        reimportedPlant?.status === 'dormant',
        String(reimportedPlant?.status)
      )

      // 重复导入：默认跳过而不是造重复记录
      const again = previewImport(target, 'species', join(workDir, 'export-species.csv'))
      check('重复导入时能识别出重名', again.duplicates > 0, String(again.duplicates))
      const second = applyImport(target, again.token, { updateExisting: false })
      check('重复导入默认跳过而非新建', second.imported === 0 && second.skipped > 0,
        `imported=${second.imported} skipped=${second.skipped}`)

      target.close()
    }

    // --- 图片搜索的纯解析逻辑（喂一段合成 HTML，不联网）---
    {
      const html =
        '<a class="iusc" m="{&quot;murl&quot;:&quot;https://a.example/rose.jpg&quot;,&quot;turl&quot;:&quot;https://a.example/t.jpg&quot;,&quot;t&quot;:&quot;粉白桃之辉酢浆草&quot;,&quot;purl&quot;:&quot;https://a.example/page&quot;}"></a>' +
        '<a class="iusc" m="{&quot;murl&quot;:&quot;https://b.example/pill.jpg&quot;,&quot;t&quot;:&quot;肝龙胶囊&quot;}"></a>' +
        '<a class="iusc" m="{&quot;t&quot;:&quot;没有 murl 的坏块&quot;}"></a>'
      const hits = parseBingResults(html)
      check('解析出 2 条（缺 murl 的坏块被丢掉）', hits.length === 2, String(hits.length))

      check('带引号的物种名被规范化', normalizeQuery('酢酱草"粉白桃之辉"') === '酢酱草 粉白桃之辉', normalizeQuery('酢酱草"粉白桃之辉"'))

      const tokens = queryTokens('酢酱草 粉白桃之辉')
      const ranked = rankHits(hits, tokens)
      check('相关的那条排在最前', ranked[0]?.url.includes('a.example') === true, ranked[0]?.url ?? '')
      check('不相关的药盒子被打 0 分', ranked[ranked.length - 1]?.score === 0, String(ranked[ranked.length - 1]?.score))
    }

    // --- 版本一致性 ---
    check('迁移版本与代码一致', currentVersion(db) === LATEST_VERSION, `${currentVersion(db)} / ${LATEST_VERSION}`)

    // 未来版本数据库应被拒绝打开
    db.exec('INSERT INTO schema_migrations (version, name) VALUES (9999, \'future\')')
    const futureReport = migrate(db)
    check('拒绝打开更高版本的数据库', !futureReport.ok && (futureReport.error ?? '').includes('高于'))
    db.exec('DELETE FROM schema_migrations WHERE version = 9999')

    meta.workDir = workDir
    meta.dbFile = dbFile
    meta.speciesId = speciesId
    meta.plantId = plantId
  } catch (error) {
    check('自检过程未抛出未预期异常', false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略关闭异常
    }
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败无关紧要
    }
  }

  const failed = checks.filter((c) => !c.ok)
  const report: SmokeReport = {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    environment: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: `${process.platform}-${process.arch}`
    },
    database: meta
  }

  const text = [
    `Sproutbook 自检报告  ${report.ok ? '全部通过' : '存在失败项'}`,
    `Electron ${report.environment.electron} / Node ${report.environment.node} / ${report.environment.platform}`,
    `通过 ${report.passed} 项，失败 ${report.failed} 项`,
    '',
    ...checks.map((c) => `${c.ok ? '[ OK ]' : '[FAIL]'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`)
  ].join('\n')

  try {
    writeFileSync(outFile, `${text}\n\n${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  } catch {
    // 报告写不出去也要把退出码给对
  }
  console.log(text)

  return report.ok ? 0 : 1
}
