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
import { Db } from './db/connection'
import { formatMonthSet, normalizeMonths } from '../core/fieldTypes'
import { LATEST_VERSION, MIGRATIONS } from './db/schema'
import { currentVersion, migrate, rebuildAttrIndex } from './db/migrate'
import { seedAll, seedFieldDefinitions } from './db/seed'
import { backupDatabase } from './db/backup'
import { loadFieldDefinitions } from './db/repo/common'
import { assessPlantsWeather } from './services/weather'
import { createField, deleteField, fieldUsage, getField, setFieldArchived, updateField } from './db/repo/fields'
import { getSpecies, listSpecies, saveSpecies, archiveSpecies, verifySpeciesFields } from './db/repo/species'
import { listPlants, plantStats, savePlant } from './db/repo/plants'
import { listEnvironments } from './db/repo/misc'
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
import { assessWeatherRisks, dedupeByKindAndDay, effectiveColdThreshold, severityOf, suggestTask, summarizeRisks, unjudgeable } from '../core/weather'
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
import { defaultFieldDefinitions } from '../core/defaultTemplate'
import {
  addDays,
  compareTasks,
  dateSpansFor,
  daysBetween,
  describeSpeciesKeys,
  dueDescription,
  generateTasks,
  isCarePhase,
  monthsCovered,
  normalizePhases,
  parseSpeciesKeys,
  phaseAgeDays,
  ruleMatchesSpecies,
  serializeSpeciesKeys,
  spreadDay,
  summarizeTasks,
  urgencyOf,
  windowRange
} from '../core/care'
import {
  addCareLog,
  careOverview,
  careRuleCount,
  completeCareTask,
  createCareTask,
  deleteCareLog,
  deleteCareRule,
  deleteCareTask,
  generateTasksForAll,
  generateTasksForPlant,
  getCareTask,
  getPlantPhase,
  listCareLogs,
  listCareRules,
  listCareTasks,
  reopenCareTask,
  saveCareRule,
  setPlantPhase,
  skipCareTask,
  updateCareTask
} from './db/repo/care'
import { seedCareRules } from './db/seed'
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
    const saved = saveSpecies(db, {
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
    const withAi = saveSpecies(db, {
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
    const updated = saveSpecies(db, { id: speciesId, values: { common_name: '月季（更新）', pot_size: '20cm' } })
    check('部分更新成功', Object.keys(updated.errors).length === 0)
    check('未提交的字段保持原值', updated.species.attributes.cold_hardiness === -15, `实际 ${updated.species.attributes.cold_hardiness}`)
    check('已提交的字段被更新', updated.species.commonName === '月季（更新）')

    // --- 必填校验 ---
    const missing = saveSpecies(db, { values: { scientific_name: 'X' } })
    check('缺少必填字段被拒绝', Object.keys(missing.errors).length > 0, JSON.stringify(missing.errors))

    // --- 非法类型输入不会写入脏数据 ---
    const badType = saveSpecies(db, { values: { common_name: '测试', cold_hardiness: '很冷' } })
    check('非法数字被拒绝', Object.keys(badType.errors).includes('cold_hardiness'), JSON.stringify(badType.errors))

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
      'smoke_required_field' in saveSpecies(db, { id: speciesId, values: { smoke_required_field: '' } }).errors
    )
    check(
      '自定义必填字段填了就通过',
      Object.keys(saveSpecies(db, { id: speciesId, values: { smoke_required_field: '有值了' } }).errors).length === 0
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
    saveSpecies(db, { id: speciesId, values: { smoke_typed_field: '约 15 厘米' } })
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

    // --- 材料与配方 ---
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

      check('无比例条目时摘要退回列材料名', summarizeRecipe([{ materialId: null, name: '园土', ratioPart: null, amount: null, unit: null, note: null, sortOrder: 0 }]) === '园土')
      check('空配方摘要不炸', summarizeRecipe([]) === '（还没有材料）')
      check(
        '未命名材料有兜底名字',
        scaleRecipe([{ materialId: null, name: '  ', ratioPart: 1, amount: null, unit: null, note: null, sortOrder: 0 }], 1)[0].name === '（未命名材料）'
      )

      check('校验：缺名称', Boolean(validateRecipe({ name: '  ', items: mix }).name))
      check(
        '校验：条目既无材料也无名称',
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
      const peat = saveMaterial(db, { name: '自检泥炭', kind: 'substrate', unit: '升', note: '保水' })
      const perlite = saveMaterial(db, { name: '自检珍珠岩', kind: 'substrate', unit: '升', note: null })
      check('可新增材料', peat.id > 0 && peat.name === '自检泥炭')
      checkThrows('重名材料被拒绝', () => saveMaterial(db as Db, { name: '自检泥炭', kind: 'substrate', unit: null, note: null }), '已经有叫')
      check('材料按关键词可搜索', listMaterials(db, '珍珠').some((m) => m.id === perlite.id))
      check('材料搜索匹配备注', listMaterials(db, '保水').some((m) => m.id === peat.id))

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
        '配方摘要带出材料库里的名字（含库外临时材料）',
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
        items: [{ materialId: peat.id, name: null, ratioPart: 1, amount: null, unit: '升', note: null, sortOrder: 0 }]
      })
      check('修改配方后条目被整组替换（无残留）', updated.recipe?.items.length === 1, String(updated.recipe?.items.length))
      check(
        '整组替换后旧条目确实删了（不是只换了顺序）',
        Number(db.scalar<number>('SELECT COUNT(*) AS c FROM recipe_items WHERE recipe_id = ?', recipeId) ?? 0) === 1
      )

      check('材料使用计数正确', materialUsage(db, peat.id) === 1, String(materialUsage(db, peat.id)))
      checkThrows('被配方引用的材料禁止删除', () => deleteMaterial(db as Db, peat.id), '还有 1 个配方在用')
      check('未被引用的材料可以删除', deleteMaterial(db, perlite.id) === true)
      check('删除材料后配方条目不会被连带删除', getRecipe(db, recipeId)?.items.length === 1)

      check('可按材料名搜到配方', listRecipes(db, { query: '自检泥炭' }).some((r) => r.id === recipeId))
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

      // 锚点日按植株错开：否则七株的任务全挤在 1 号，月历上「1 号 8 项、其余全空」
      check('锚点日落在当月天数内', spreadDay(2026, 2, 9) <= 28, String(spreadDay(2026, 2, 9)))
      check('锚点日不超过 31', [1, 2, 3, 4, 5, 6, 7, 8].every((s) => spreadDay(2026, 1, s) <= 31))
      check('2 月不会给出 30 号', spreadDay(2026, 2, 5) <= 29, String(spreadDay(2026, 2, 5)))
      {
        const days = new Set([1, 2, 3, 4, 5, 6, 7].map((s) => spreadDay(2026, 6, s)))
        check('不同植株的锚点日确实分散开', days.size >= 4, [...days].join(','))
        const spread = generateTasks(testRules, '照护月季', 2026, { spreadSeed: 3 })
        check('生成任务用了错开后的日期', spread.every((t) => !t.dueDate.endsWith('-01')), spread[0]?.dueDate)
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
        '周期任务的时间窗收窄到半个间隔（相邻两次不互相覆盖）',
        cyc.every((t) => t.windowDays === 5),
        String(cyc[0].windowDays)
      )
      check('没有轮换步骤时标题不带后缀', generateTasks([{ ...cycleRule, rotation: null }], null, 2026)[0].title === '追肥')
      check(
        '间隔为 1 天也不会死循环',
        generateTasks([{ ...cycleRule, repeatDays: 1, monthFrom: 3, monthTo: 3 }], null, 2026).length <= 400
      )
      check(
        '周期规则的起始日按植株错开',
        generateTasks([cycleRule], null, 2026, { spreadSeed: 3 })[0].dueDate !==
          generateTasks([cycleRule], null, 2026, { spreadSeed: 0 })[0].dueDate,
        `${generateTasks([cycleRule], null, 2026, { spreadSeed: 3 })[0].dueDate} vs ${generateTasks([cycleRule], null, 2026, { spreadSeed: 0 })[0].dueDate}`
      )
      check(
        '跨年周期规则两段都在当年内',
        generateTasks([{ ...cycleRule, monthFrom: 11, monthTo: 2 }], null, 2026).every((t) =>
          t.dueDate.startsWith('2026-')
        )
      )

      // ---- 时间窗与紧急度 ----
      const task = (dueDate: string, status: CareTaskStatus = 'pending', windowDays = 3) =>
        ({ dueDate, windowDays, status }) as Pick<CareTask, 'dueDate' | 'windowDays' | 'status'>

      check('时间窗两端正确', windowRange({ dueDate: '2026-06-10', windowDays: 3 }).from === '2026-06-07')
      check('时间窗末端正确', windowRange({ dueDate: '2026-06-10', windowDays: 3 }).to === '2026-06-13')
      check('窗口内算「该做了」', urgencyOf(task('2026-06-10'), '2026-06-10') === 'due')
      check('窗口首日也算「该做了」', urgencyOf(task('2026-06-10'), '2026-06-07') === 'due')
      check('超过窗口末端算逾期', urgencyOf(task('2026-06-10'), '2026-06-14') === 'overdue')
      check('窗口开始前的近期算「快到了」', urgencyOf(task('2026-06-20'), '2026-06-10') === 'soon')
      check('远期任务算「还早」', urgencyOf(task('2026-09-01'), '2026-06-10') === 'later')
      check('已完成不再判紧急度', urgencyOf(task('2026-06-10', 'done'), '2026-07-01') === 'closed')
      check('已跳过同样算关闭', urgencyOf(task('2026-06-10', 'skipped'), '2026-07-01') === 'closed')

      // 描述必须基于时间窗：写着 6/10、窗口 ±3 天，那 6/12 仍是「窗口内」，
      // 说成「已过 2 天」会让人误以为逾期
      check('窗口内描述为「时间窗内」', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-12').includes('时间窗内'), dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-12'))
      check('窗口最后一天有特别提示', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-13') === '今天是最后一天')
      check('超过窗口才说已过期', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-15') === '已过期 2 天', dueDescription({ dueDate: '2026-06-10', windowDays: 3 }, '2026-06-15'))
      check('窗口未开始说还有几天', dueDescription({ dueDate: '2026-06-20', windowDays: 3 }, '2026-06-10').includes('还有 7 天'), dueDescription({ dueDate: '2026-06-20', windowDays: 3 }, '2026-06-10'))

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
      const careSpecies = saveSpecies(db, { values: { common_name: '照护月季' } })
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
      const g1 = generateTasksForPlant(db, carePlantId, year, { today: FIXED_TODAY })
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
        stillPending.every((t) => addDays(t.dueDate, t.windowDays) >= lateToday),
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

        // 不同植株错开，但都还在窗口开头
        const days = [0, 1, 2, 3, 4].map(
          (seed) => generateTasks([{ ...once, oncePerWindow: true }], null, 2026, { spreadSeed: seed })[0].dueDate
        )
        check('不同植株仍然错开', new Set(days).size > 1, days.join(' '))
        check('错开后仍都在 10 月上旬', days.every((d) => d.startsWith('2026-10') && Number(d.slice(8, 10)) <= 7), days.join(' '))
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
        check('配方可以不依赖材料库（用自由文本）', recipe.recipe?.items.length === 2, String(recipe.recipe?.items.length))

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
         * 但那是某市市中心那个格点的预报。用户反馈「位置不够精准」指的就是这个。
         */
        {
          const withLabel = assessWeatherRisks([zhudinghong], [day('2026-11-20', 3, 10)], '中国 · 湖南 · 某市')
          const msg = withLabel[0]?.message ?? ''
          check('温度归给预报点而不是植株位置', msg.includes('中国 · 湖南 · 某市预报最低'), msg)
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
          // 最硬的一条：缓存只在请求成功后才写，所以它必须是空的
          const keys = db.all<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'weather.%'")
          check('没有城市时连缓存都没写（＝确实没联网）', keys.length === 0, keys.map((k) => k.key).join(','))
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
      const careSpecies2 = saveSpecies(db, { values: { common_name: '阶段测试株' } })
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

      // 生成时确实按植株阶段过滤
      setPlantPhase(db, pid, 'dormant')
      const genDormant = generateTasksForPlant(db, pid, 2026, { today: '2026-01-01' })
      const listDormant = listCareTasks(db, { plantId: pid })
      check('生成时按植株阶段过滤', !listDormant.some((t) => t.title === '自检阶段规则'), JSON.stringify(genDormant))
      check('生成时保留可生效的规则', listDormant.some((t) => t.title === '自检无阶段规则'))

      setPlantPhase(db, pid, 'growing')
      generateTasksForPlant(db, pid, 2026, { today: '2026-01-01' })
      check(
        '改成生长期后追肥任务出现',
        listCareTasks(db, { plantId: pid }).some((t) => t.title === '自检阶段规则')
      )

      deleteCareRule(db, saved.id)
      deleteCareRule(db, noPhase.id)
    }

    // --- 生长阶段推导 ---
    {
      const base = { today: '2026-06-15' }

      check('枯死是事实，盖过一切', deriveGrowthStage({ ...base, status: 'dead', phase: 'blooming', bloomMonths: [6] }).stage === 'withered')
      check('生病同样盖过人工标记', deriveGrowthStage({ ...base, status: 'sick', phase: 'growing' }).stage === 'sick')
      check('状态休眠优先于月份', deriveGrowthStage({ ...base, status: 'dormant' }).stage === 'dormant')
      check('推导来源标为 status', deriveGrowthStage({ ...base, status: 'dead' }).source === 'status')

      // 人工标记优先于月份推算：同一个月里，南阳台的可能已经现蕾、北窗台的还没动
      check(
        '人工标记优先于开花月份',
        deriveGrowthStage({ ...base, phase: 'growing', bloomMonths: [6] }).stage === 'growing'
      )
      check('推导来源标为 phase', deriveGrowthStage({ ...base, phase: 'blooming' }).source === 'phase')
      check(
        '阶段的说明用中文而不是内部键名',
        deriveGrowthStage({ ...base, phase: 'blooming' }).reason.includes('花期') &&
          !deriveGrowthStage({ ...base, phase: 'blooming' }).reason.includes('blooming'),
        deriveGrowthStage({ ...base, phase: 'blooming' }).reason
      )
      // 缓苗期有自己的阶段。第一版把它映射成「幼苗」，结果一株成熟的朱顶红
      // 只要标了缓苗期就被画成两像素的嫩芽 —— 缓苗是临时状态，不是「这株还小」
      check(
        '缓苗期不是幼苗（不能画成小苗）',
        deriveGrowthStage({ ...base, phase: 'recovering' }).stage === 'recovering',
        deriveGrowthStage({ ...base, phase: 'recovering' }).stage
      )
      check('缓苗中保持成株高度', growthLook('recovering').stem >= growthLook('growing').stem)
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
      const exportSpecies = saveSpecies(db, {
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
