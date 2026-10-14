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
import { createField, deleteField, fieldUsage, getField, setFieldArchived, updateField } from './db/repo/fields'
import { getSpecies, listSpecies, saveSpecies, archiveSpecies, verifySpeciesFields } from './db/repo/species'
import { listPlants, plantStats, savePlant } from './db/repo/plants'
import { listEnvironments } from './db/repo/misc'
import { toCsv, parseCsv } from '../core/csv'
import { applyImport, buildExport, previewImport } from './services/transfer'
import { summarizeRecipe, scaleRecipe, validateRecipe } from '../core/recipes'
import type { RecipeItem } from '../core/types'
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

export function runSmoke(outFile: string): number {
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
      values: { nickname: '阳台那盆月季', acquired_at: '2024-03-15', pot_size: '25cm' },
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
      Boolean(plantRow?.attributes_json && plantRow.attributes_json.includes('pot_size')),
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
         VALUES (?, '老植株', NULL, 'dormant', '{}')`,
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
        values: { nickname: '阳台那盆', env_id: envs[0]?.id ?? null, status: 'dormant', pot_size: '25cm' }
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
