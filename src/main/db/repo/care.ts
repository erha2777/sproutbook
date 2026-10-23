/**
 * 养护计划仓储：规则库、计划、任务、日志。
 *
 * 生成策略上有一个要紧的取舍：**重新生成时不能把已完成的任务冲掉**。
 * 用户打了勾、写了备注，那是真实发生过的事；而规则可能会调整、可能再生成一次。
 * 所以按「日期 + 动作 + 标题」做签名匹配：已完成的保留，其余的才替换。
 */

import type { Db } from '../connection'
import type {
  CareActionType,
  CareHemisphere,
  CareLog,
  CareLogImage,
  CarePlan,
  CareRule,
  CareRuleInput,
  CareTask,
  CareTaskInput,
  CareTaskStatus
} from '../../../core/types'
import type {
  CareGenerateResult,
  CareOverview,
  CareTaskListItem,
  CareTaskPatch,
  CareTaskPurgeResult,
  CareTaskQuery
} from '../../../shared/api'
import {
  CARE_PHASE_LABELS,
  addDays,
  generateTasks,
  isCarePhase,
  normalizePhases,
  parseSpeciesKeys,
  ruleMatchesSpecies,
  serializeSpeciesKeys,
  summarizeTasks,
  todayIso
} from '../../../core/care'
import type { CarePhase, PlantStatus } from '../../../core/types'
import { deriveCarePhase } from '../../../core/phase'
import { readMonthSet } from '../../../core/growth'

// ---------------------------------------------------------------------------
// 规则库
// ---------------------------------------------------------------------------

interface CareRuleRow {
  id: number
  species_key: string
  hemisphere: string
  climate_zone: string | null
  month_from: number
  month_to: number | null
  month_from_day: number
  month_to_day: number | null
  repeat_days: number | null
  rotation_json: string | null
  active_phases: string | null
  once_per_window: number
  same_day: number
  anchor_day: number | null
  recipe_id: number | null
  action_type: string
  title: string
  detail: string | null
  priority: number
  source: string
  verified: number
  created_at: string
}

function mapRule(row: CareRuleRow): CareRule {
  return {
    id: row.id,
    speciesKeys: parseSpeciesKeys(row.species_key),
    hemisphere: row.hemisphere as CareHemisphere,
    climateZone: row.climate_zone,
    monthFrom: row.month_from,
    monthTo: row.month_to,
    monthFromDay: row.month_from_day ?? 1,
    monthToDay: row.month_to_day ?? null,
    repeatDays: row.repeat_days,
    oncePerWindow: row.once_per_window === 1,
    sameDay: row.same_day === 1,
    recipeId: row.recipe_id ?? null,
    rotation: parseRotation(row.rotation_json),
    activePhases: parsePhases(row.active_phases),
    actionType: row.action_type as CareActionType,
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    source: row.source as CareRule['source'],
    verified: row.verified === 1,
    createdAt: row.created_at
  }
}

/** 轮换步骤存成 JSON 数组。坏数据当作空，不因为一条规则读不出来就整个列表失败。 */
function parseRotation(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const list = parsed.map((s) => String(s).trim()).filter(Boolean)
    return list.length > 0 ? list : null
  } catch {
    return null
  }
}

/** 生效阶段同样存成 JSON 数组，非法值直接丢掉。 */
function parsePhases(raw: string | null): CareRule['activePhases'] {
  if (!raw) return null
  try {
    return normalizePhases(JSON.parse(raw))
  } catch {
    return null
  }
}

export function listCareRules(
  db: Db,
  options: { speciesKey?: string; hemisphere?: CareHemisphere } = {}
): CareRule[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.hemisphere) {
    where.push('hemisphere = ?')
    params.push(options.hemisphere)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rules = db
    .all<CareRuleRow>(`SELECT * FROM care_rules ${whereSql} ORDER BY species_key, month_from, priority`, ...params)
    .map(mapRule)

  // 适用物种是多值，SQL 的等值比较表达不了「列表里包含这个物种」，
  // 所以在 JS 里过滤。规则数量是几十条量级，不值得为它做关联表。
  if (options.speciesKey) {
    const want = options.speciesKey
    return rules.filter((r) => ruleMatchesSpecies(r.speciesKeys, want))
  }
  return rules
}

export function saveCareRule(db: Db, input: CareRuleInput): CareRule {
  const title = input.title.trim()
  if (!title) throw new Error('规则标题不能为空')
  if (input.monthFrom < 1 || input.monthFrom > 12) throw new Error('起始月份需要在 1~12 之间')
  if (input.repeatDays !== null && input.repeatDays !== undefined && input.repeatDays < 1) {
    throw new Error('重复间隔至少 1 天')
  }

  const rotation = input.rotation && input.rotation.length > 0 ? input.rotation : null
  const rotationJson = rotation ? JSON.stringify(rotation) : null
  const activePhases = normalizePhases(input.activePhases)
  const phasesJson = activePhases ? JSON.stringify(activePhases) : null
  const repeatDays = input.repeatDays ?? null
  /*
   * 两个频率语义互斥：按天重复是「隔几天做一次」，窗口内一次是「这段里做一次」。
   * 同时打开时按天优先（见 generateTasks 的分支顺序），这里就落成 false，
   * 免得库里存着一个自相矛盾的组合。
   */
  const oncePerWindow = repeatDays === null && input.oncePerWindow === true
  /*
   * 「同一天」现在是**默认**：用户要的是规律 —— 同一条规则下所有植株同一天做。
   * 只有显式传 false 才恢复「按植株错开」（日常浇水想摊开时可以用）。
   */
  const sameDay = input.sameDay !== false
  /*
   * 日期区间的两端：起始月的第几天（默认 1）、结束月的第几天（空＝月底）。
   * 夹到 1~31；小月由生成逻辑按当月天数收口（2 月不会出现 30 号）。
   */
  const clampDay = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.min(31, Math.max(1, Math.trunc(value)))
  }
  const monthFromDay = clampDay(input.monthFromDay) ?? 1
  const monthToDay = clampDay(input.monthToDay)

  if (input.id) {
    db.run(
      `UPDATE care_rules SET species_key=?, hemisphere=?, climate_zone=?, month_from=?, month_to=?,
         month_from_day=?, month_to_day=?,
         repeat_days=?, once_per_window=?, same_day=?, recipe_id=?, rotation_json=?, active_phases=?,
         action_type=?, title=?, detail=?, priority=?,
         source=?, verified=?
       WHERE id=?`,
      serializeSpeciesKeys(input.speciesKeys),
      input.hemisphere,
      input.climateZone,
      input.monthFrom,
      input.monthTo,
      monthFromDay,
      monthToDay,
      repeatDays,
      oncePerWindow ? 1 : 0,
      sameDay ? 1 : 0,
      input.recipeId ?? null,
      rotationJson,
      phasesJson,
      input.actionType,
      title,
      input.detail,
      input.priority,
      input.source,
      input.verified ? 1 : 0,
      input.id
    )
    const row = db.get<CareRuleRow>('SELECT * FROM care_rules WHERE id = ?', input.id)
    if (!row) throw new Error('规则更新失败')
    return mapRule(row)
  }

  const r = db.run(
    `INSERT INTO care_rules (species_key, hemisphere, climate_zone, month_from, month_to,
       month_from_day, month_to_day,
       repeat_days, once_per_window, same_day, recipe_id, rotation_json, active_phases,
       action_type, title, detail, priority, source, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    serializeSpeciesKeys(input.speciesKeys),
    input.hemisphere,
    input.climateZone,
    input.monthFrom,
    input.monthTo,
    monthFromDay,
    monthToDay,
    repeatDays,
    oncePerWindow ? 1 : 0,
    sameDay ? 1 : 0,
    input.recipeId ?? null,
    rotationJson,
    phasesJson,
    input.actionType,
    title,
    input.detail,
    input.priority,
    input.source,
    input.verified ? 1 : 0
  )
  const created = db.get<CareRuleRow>('SELECT * FROM care_rules WHERE id = ?', Number(r.lastInsertRowid))
  if (!created) throw new Error('规则创建失败')
  return mapRule(created)
}

export function deleteCareRule(db: Db, id: number): boolean {
  const r = db.run('DELETE FROM care_rules WHERE id = ?', id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

export function careRuleCount(db: Db): number {
  return Number(db.scalar<number>('SELECT COUNT(*) AS c FROM care_rules') ?? 0)
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

interface CarePlanRow {
  id: number
  plant_id: number | null
  name: string
  year: number | null
  source: string
  status: string
  created_at: string
  updated_at: string
}

function mapPlan(row: CarePlanRow): CarePlan {
  return {
    id: row.id,
    plantId: row.plant_id,
    name: row.name,
    year: row.year,
    source: row.source as CarePlan['source'],
    status: row.status as CarePlan['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 取某株某年的计划，没有就建一个。生成任务前先拿到 planId。 */
export function ensurePlan(db: Db, plantId: number | null, year: number, name?: string): CarePlan {
  const existing = plantId === null
    ? db.get<CarePlanRow>('SELECT * FROM care_plans WHERE plant_id IS NULL AND year = ? AND status = \'active\'', year)
    : db.get<CarePlanRow>(
        "SELECT * FROM care_plans WHERE plant_id = ? AND year = ? AND status = 'active'",
        plantId,
        year
      )
  if (existing) return mapPlan(existing)

  const r = db.run(
    'INSERT INTO care_plans (plant_id, name, year, source) VALUES (?, ?, ?, ?)',
    plantId,
    name ?? `${year} 年养护计划`,
    year,
    'generated'
  )
  const created = db.get<CarePlanRow>('SELECT * FROM care_plans WHERE id = ?', Number(r.lastInsertRowid))
  if (!created) throw new Error('计划创建失败')
  return mapPlan(created)
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

interface CareTaskRow {
  id: number
  plan_id: number | null
  plant_id: number | null
  action_type: string
  title: string
  detail: string | null
  due_date: string
  window_days: number
  recurrence: string | null
  priority: number
  status: string
  completed_at: string | null
  completed_note: string | null
  rule_id: number | null
  recipe_id: number | null
  source: string
  created_at: string
}

function mapTask(row: CareTaskRow): CareTask {
  return {
    id: row.id,
    planId: row.plan_id,
    plantId: row.plant_id,
    actionType: row.action_type as CareActionType,
    title: row.title,
    detail: row.detail,
    dueDate: row.due_date,
    windowDays: row.window_days,
    recurrence: row.recurrence,
    priority: row.priority,
    status: row.status as CareTaskStatus,
    completedAt: row.completed_at,
    completedNote: row.completed_note,
    ruleId: row.rule_id ?? null,
    recipeId: row.recipe_id ?? null,
    source: row.source as CareTask['source'],
    createdAt: row.created_at
  }
}

const TASK_SELECT = `
  SELECT t.*, p.nickname AS plant_name, s.common_name AS species_name
  FROM care_tasks t
  LEFT JOIN plants p ON p.id = t.plant_id
  LEFT JOIN species s ON s.id = p.species_id
`

export function listCareTasks(db: Db, query: CareTaskQuery = {}): CareTaskListItem[] {
  const where: string[] = []
  const params: Array<string | number> = []

  if (typeof query.plantId === 'number') {
    where.push('t.plant_id = ?')
    params.push(query.plantId)
  }
  if (query.from) {
    where.push('t.due_date >= ?')
    params.push(query.from)
  }
  if (query.to) {
    where.push('t.due_date <= ?')
    params.push(query.to)
  }
  if (query.completedFrom) {
    where.push('t.completed_at >= ?')
    params.push(query.completedFrom)
  }
  if (query.completedTo) {
    where.push('t.completed_at < ?')
    params.push(query.completedTo)
  }
  if (query.status === 'open') {
    where.push("t.status = 'pending'")
  } else if (query.status) {
    where.push('t.status = ?')
    params.push(query.status)
  }
  if (query.actionType) {
    where.push('t.action_type = ?')
    params.push(query.actionType)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = query.limit ? `LIMIT ${Math.max(1, Math.floor(query.limit))}` : ''
  const rows = db.all<CareTaskRow & { plant_name: string | null; species_name: string | null }>(
    `${TASK_SELECT} ${whereSql} ORDER BY t.due_date, t.priority, t.id ${limit}`,
    ...params
  )
  return rows.map((row) => ({ ...mapTask(row), plantName: row.plant_name, speciesName: row.species_name }))
}

export function getCareTask(db: Db, id: number): CareTask | null {
  const row = db.get<CareTaskRow>('SELECT * FROM care_tasks WHERE id = ?', id)
  return row ? mapTask(row) : null
}

export function createCareTask(db: Db, input: CareTaskInput): CareTask {
  const title = input.title.trim()
  if (!title) throw new Error('任务标题不能为空')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new Error('任务日期需要 YYYY-MM-DD 格式')

  const r = db.run(
    `INSERT INTO care_tasks (plan_id, plant_id, action_type, title, detail, due_date, window_days,
       recurrence, priority, rule_id, recipe_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.planId ?? null,
    input.plantId ?? null,
    input.actionType,
    title,
    input.detail ?? null,
    input.dueDate,
    input.windowDays ?? 3,
    input.recurrence ?? null,
    input.priority ?? 2,
    input.ruleId ?? null,
    input.recipeId ?? null,
    input.source ?? 'manual'
  )
  const created = getCareTask(db, Number(r.lastInsertRowid))
  if (!created) throw new Error('任务创建失败')
  return created
}

export function updateCareTask(db: Db, id: number, patch: CareTaskPatch): CareTask | null {
  const current = getCareTask(db, id)
  if (!current) return null

  db.run(
    `UPDATE care_tasks SET title=?, detail=?, due_date=?, window_days=?, priority=?, action_type=?, plant_id=?
     WHERE id=?`,
    patch.title?.trim() || current.title,
    patch.detail !== undefined ? patch.detail : current.detail,
    patch.dueDate ?? current.dueDate,
    patch.windowDays ?? current.windowDays,
    patch.priority ?? current.priority,
    patch.actionType ?? current.actionType,
    patch.plantId !== undefined ? patch.plantId : current.plantId,
    id
  )
  return getCareTask(db, id)
}

/**
 * 标记完成。
 *
 * 同时写一条养护日志 —— 完成情况本身就是「这株植物经历过什么」，
 * 分开维护两份记录迟早会对不上。日志是时间线，任务是待办，一条事实两处视角。
 */
export function completeCareTask(
  db: Db,
  id: number,
  note?: string | null,
  date?: string,
  imageIds?: number[]
): CareTask | null {
  return db.transaction(() => {
    const task = getCareTask(db, id)
    if (!task) return null
    const when = date ?? todayIso()

    db.run(
      "UPDATE care_tasks SET status='done', completed_at=?, completed_note=? WHERE id=?",
      new Date().toISOString(),
      note ?? null,
      id
    )

    let logId: number | null = null
    if (task.plantId !== null) {
      const r = db.run(
        `INSERT INTO care_logs (plant_id, task_id, log_date, kind, content, recipe_id) VALUES (?, ?, ?, ?, ?, ?)`,
        task.plantId,
        id,
        when,
        task.actionType,
        note?.trim() || task.title,
        /*
         * 记下当时用的是哪份配方。
         * 任务卡片说的是「打算怎么做」，日志记的是「实际怎么做的」——
         * 过一年回头看「这盆当时埋的什么」，只有日志能回答。
         */
        task.recipeId ?? null
      )
      logId = Number(r.lastInsertRowid)
    }

    /*
     * 完成时顺手带的照片：选图时已经导入 images 表，这里挂到刚写的日志上。
     * 没有日志（任务没绑植株）就不挂 —— 照片留在 images 里，不凭空丢掉。
     */
    if (logId !== null && imageIds && imageIds.length > 0) {
      const ids = imageIds.filter((v) => Number.isFinite(v))
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        db.run(
          `UPDATE images SET log_id = ?, plant_id = COALESCE(plant_id, ?) WHERE id IN (${placeholders})`,
          logId,
          task.plantId,
          ...ids
        )
      }
    }

    return getCareTask(db, id)
  })
}

export function skipCareTask(db: Db, id: number, reason?: string | null): CareTask | null {
  const task = getCareTask(db, id)
  if (!task) return null
  db.run(
    "UPDATE care_tasks SET status='skipped', completed_at=?, completed_note=? WHERE id=?",
    new Date().toISOString(),
    reason ?? null,
    id
  )
  return getCareTask(db, id)
}

/** 撤销完成 / 跳过，回到待办。对应的日志也会一并删掉，避免时间线留下假记录。 */
export function reopenCareTask(db: Db, id: number): CareTask | null {
  return db.transaction(() => {
    db.run('DELETE FROM care_logs WHERE task_id = ?', id)
    db.run(
      "UPDATE care_tasks SET status='pending', completed_at=NULL, completed_note=NULL WHERE id=?",
      id
    )
    return getCareTask(db, id)
  })
}

export function deleteCareTask(db: Db, id: number): boolean {
  return db.transaction(() => {
    // task_id 没有外键约束（日志要能在任务删除后继续存在），这里显式解绑
    db.run('UPDATE care_logs SET task_id = NULL WHERE task_id = ?', id)
    const r = db.run('DELETE FROM care_tasks WHERE id = ?', id)
    /*
     * 看的是**删任务**那条的 changes，不是解绑日志那条 ——
     * 日志本来就可能一条都没有，用它的行数判断会误报失败。
     * 影响 0 行说明这条任务已经不在了，如实返回 false。
     */
    return Number(r.changes) > 0
  })
}

/**
 * 批量清理一段日期范围内的任务。
 *
 * 生成计划是按年的，误点一下就排出整年。用户不小心生成了明年的计划之后
 * 没有任何出口 —— 只能一条条删，135 条根本删不动。
 *
 * **三种状态都能删**：用户要的就是「把这段范围清空」，
 * 包括已完成的记录。但**按状态分开计数**返回给界面，
 * 让它在确认前把「要删掉 7 条已完成的记录」摆在明面上 ——
 * 那是不可逆的，不能只给一个总数让人按下去。
 *
 * 日志本身不动，只解绑 task_id（和 deleteCareTask 同样的理由：
 * 日志要能在任务删除后继续存在，它是「那天做了什么」的记录）。
 */
export function purgeCareTasks(
  db: Db,
  input: { from: string; to: string; plantId?: number }
): CareTaskPurgeResult {
  return db.transaction(() => {
    const plantClause = input.plantId === undefined ? '' : ' AND plant_id = ?'
    const args: Array<string | number> = [input.from, input.to]
    if (input.plantId !== undefined) args.push(input.plantId)
    const where = `due_date >= ? AND due_date <= ?${plantClause}`

    const byStatus: Record<CareTaskStatus, number> = { pending: 0, done: 0, skipped: 0 }
    for (const row of db.all<{ status: CareTaskStatus; c: number }>(
      `SELECT status, COUNT(*) AS c FROM care_tasks WHERE ${where} GROUP BY status`,
      ...args
    )) {
      byStatus[row.status] = Number(row.c)
    }

    const ids = db.all<{ id: number }>(`SELECT id FROM care_tasks WHERE ${where}`, ...args).map((r) => r.id)
    if (ids.length === 0) return { deleted: 0, byStatus }

    const marks = ids.map(() => '?').join(',')
    // 先解绑日志，再删任务 —— 顺序反了会留下指向不存在任务的 task_id
    db.run(`UPDATE care_logs SET task_id = NULL WHERE task_id IN (${marks})`, ...ids)
    const r = db.run(`DELETE FROM care_tasks WHERE id IN (${marks})`, ...ids)
    return { deleted: Number(r.changes), byStatus }
  })
}

// ---------------------------------------------------------------------------
// 物候阶段
// ---------------------------------------------------------------------------

export interface PlantPhaseInfo {
  plantId: number
  phase: CarePhase | null
  changedAt: string | null
}

export function getPlantPhase(db: Db, plantId: number): PlantPhaseInfo {
  const row = db.get<{ id: number; phase: string | null; phase_changed_at: string | null }>(
    'SELECT id, phase, phase_changed_at FROM plants WHERE id = ?',
    plantId
  )
  return {
    plantId,
    phase: isCarePhase(row?.phase) ? row.phase : null,
    changedAt: row?.phase_changed_at ?? null
  }
}

/**
 * 标记植株当前处于哪个物候阶段。
 *
 * 同时写一条养护日志 ——「3 月 15 日标记为现蕾」本身就是这株植物经历过的事实，
 * 和「浇了水」「施了肥」一样属于时间线。分开记迟早会对不上。
 *
 * 阶段变化会立刻改变后续生成的任务（限定阶段的规则会随之生效或失效），
 * 所以这里只负责记录状态，重新生成由调用方决定。
 */
/**
 * 这一株**当年**有没有计划（= 有没有任务 / 计划行）。
 *
 * 用途：切阶段时判断要不要顺手重新生成任务。
 * 一株从没生成过计划的花，切个阶段不该凭空多出整年的任务 ——
 * 用户要的是"标记现状"，不是"替我做计划"。
 */
export function hasCarePlan(db: Db, plantId: number, year: number): boolean {
  const from = `${year}-01-01`
  const to = `${year + 1}-01-01`
  const task = db.scalar<number>(
    'SELECT 1 FROM care_tasks WHERE plant_id = ? AND due_date >= ? AND due_date < ? LIMIT 1',
    plantId,
    from,
    to
  )
  if (task) return true
  const plan = db.scalar<number>('SELECT 1 FROM care_plans WHERE plant_id = ? AND (year IS NULL OR year = ?) LIMIT 1', plantId, year)
  return Boolean(plan)
}
export function setPlantPhase(db: Db, plantId: number, phase: CarePhase | null, note?: string | null): PlantPhaseInfo {
  return db.transaction(() => {
    const now = new Date().toISOString()
    db.run('UPDATE plants SET phase = ?, phase_changed_at = ? WHERE id = ?', phase, now, plantId)

    if (phase !== null) {
      db.run(
        'INSERT INTO care_logs (plant_id, task_id, log_date, kind, content) VALUES (?, NULL, ?, ?, ?)',
        plantId,
        todayIso(),
        'phase',
        note?.trim() || `标记为「${CARE_PHASE_LABELS[phase]}」`
      )
    }
    return getPlantPhase(db, plantId)
  })
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 任务的「同一件事」签名：同一天、同一动作、同一标题。 */
function taskSignature(row: { due_date?: string; dueDate?: string; action_type?: string; actionType?: string; title: string }): string {
  const date = row.due_date ?? row.dueDate ?? ''
  const action = row.action_type ?? row.actionType ?? ''
  return `${date}|${action}|${row.title}`
}

/**
 * 为某株植物生成某年的任务。
 *
 * 幂等是硬要求：这个函数会在用户每次打开养护计划时被调用（规则可能变、植物可能新增），
 * 所以**签名相同就原样保留**，既不重复插入也不删了重插 ——
 * 后者虽然也不产生重复行，但每次都会换掉任务 ID，任何外部引用都会失效，
 * 而且「生成了 45 条」的计数会让人以为数据变了。
 *
 * 已完成 / 已跳过的任务一律保留：那是真实发生过的事，不能因为规则调整就抹掉。
 *
 * 默认**跳过时间窗已经结束的月份**：十月才装应用的人，一月的任务从来就不是
 * 他该做的 —— 生成一堆「已过期 286 天」既不符合事实，也会把真正该做的事淹掉。
 * 计划只能从今天往后排，过去的日子是历史，不是欠账。
 */
export function generateTasksForPlant(
  db: Db,
  plantId: number,
  year: number,
  options: {
    hemisphere?: CareHemisphere
    windowDays?: number
    /** 设为 false 可生成完整年份（含已过去的月份） */
    skipPast?: boolean
    /** 便于自检注入固定日期，不依赖运行时的机器时间 */
    today?: string
  } = {}
): CareGenerateResult {
  return db.transaction(() => {
    const plant = db.get<{
      id: number
      nickname: string
      species_id: number | null
      status: string
      phase: string | null
    }>('SELECT id, nickname, species_id, status, phase FROM plants WHERE id = ? AND archived_at IS NULL', plantId)
    if (!plant) return { created: 0, kept: 0, removed: 0, plants: 0 }

    const speciesRow = plant.species_id
      ? db.get<{ common_name: string; attributes_json: string }>(
          'SELECT common_name, attributes_json FROM species WHERE id = ?',
          plant.species_id
        )
      : null
    const speciesName = speciesRow?.common_name ?? null
    const speciesAttrs = speciesRow ? (JSON.parse(speciesRow.attributes_json || '{}') as Record<string, unknown>) : {}

    /*
     * 阶段是**算出来的**：状态（人观察的）+ 物种花期 / 休眠月份 + 今天。
     *
     * 以前读 plants.phase —— 那列是人手点的，和状态能互相打架
     * （状态写「有花芽」、阶段还停在「生长期」）。现在界面和任务生成都用同一个纯函数。
     */
    const derived = deriveCarePhase({
      status: plant.status as PlantStatus,
      bloomMonths: readMonthSet(speciesAttrs.bloom_months),
      dormancyMonths: readMonthSet(speciesAttrs.dormancy_months),
      today: options.today ?? todayIso()
    })

    const rules = listCareRules(db, { hemisphere: options.hemisphere ?? 'N' })
    const allGenerated = generateTasks(rules, speciesName, year, {
      hemisphere: options.hemisphere ?? 'N',
      defaultWindowDays: options.windowDays ?? 15,
      // 按植株错开锚点日：否则七株的任务全挤在同一天，月历就没法看了
      spreadSeed: plantId,
      // 算出来的阶段决定「限定阶段的规则」是否生效 —— 这就是停用的实现
      phase: derived.phase
    })

    /*
     * 过去的日子不再补生成：那些月份的计划还不存在，不该记成欠账。
     *
     * 但**当前月要留下来**。锚点日现在默认是 1 号，时间窗 ±15 天 ——
     * 到了 17 号以后，当月 1 号的任务窗口就已经走完；只用「窗口没过」筛的话，
     * 月中一重新生成，当月计划会整片消失（用户看到「本月 0 项」）。
     * 所以两条留一条：窗口还没结束 **或** 就在本月（含以后）。
     */
    const cutoff = options.today ?? todayIso()
    const monthStart = `${cutoff.slice(0, 7)}-01`
    const generated =
      options.skipPast === false
        ? allGenerated
        : allGenerated.filter(
            (t) => addDays(t.dueDate, t.windowDays) >= cutoff || t.dueDate >= monthStart
          )

    const plan = ensurePlan(db, plantId, year, `${plant.nickname} · ${year} 年养护`)

    const existing = db.all<CareTaskRow>(
      "SELECT * FROM care_tasks WHERE plant_id = ? AND source = 'generated' AND due_date LIKE ?",
      plantId,
      `${year}-%`
    )
    const existingBySignature = new Map<string, CareTaskRow>()
    for (const row of existing) existingBySignature.set(taskSignature(row), row)

    const wanted = new Set(generated.map((t) => taskSignature(t)))

    let kept = 0
    let removed = 0
    let created = 0

    // 1) 清掉规则已不再产生的**待办**（规则改了或删了就让它消失）
    for (const row of existing) {
      if (wanted.has(taskSignature(row))) continue
      if (row.status !== 'pending') {
        // 已完成的是历史记录，规则变了也不抹掉
        kept++
        continue
      }
      db.run('DELETE FROM care_tasks WHERE id = ?', row.id)
      removed++
    }

    // 2) 补上还没有的
    for (const task of generated) {
      const already = existingBySignature.get(taskSignature(task))
      if (already) {
        /*
         * 签名相同 = 这条任务已经在了，不重复生成。
         *
         * 但要**回填规则与配方的链接**：迁移之前生成的任务没有这两个字段，
         * 而「签名没变就一律不动」会让它们永远拿不到配方 ——
         * 用户明明给规则绑了配方，任务卡片上却一直是空的。
         * 值相同时不写库，所以仍然幂等。
         */
        if (already.rule_id !== task.ruleId || already.recipe_id !== task.recipeId) {
          db.run(
            'UPDATE care_tasks SET rule_id = ?, recipe_id = ? WHERE id = ?',
            task.ruleId,
            task.recipeId,
            already.id
          )
        }
        kept++
        continue
      }
      db.run(
        `INSERT INTO care_tasks (plan_id, plant_id, action_type, title, detail, due_date, window_days,
           priority, rule_id, recipe_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated')`,
        plan.id,
        plantId,
        task.actionType,
        task.title,
        task.detail,
        task.dueDate,
        task.windowDays,
        task.priority,
        // 任务要记得自己从哪条规则来 —— 做的时候才能直接看到配方
        task.ruleId,
        task.recipeId
      )
      created++
    }

    return { created, kept, removed, plants: 1 }
  })
}

export function generateTasksForAll(
  db: Db,
  year: number,
  options: { hemisphere?: CareHemisphere; skipPast?: boolean; today?: string } = {}
): CareGenerateResult {
  return db.transaction(() => {
    const plants = db.all<{ id: number }>('SELECT id FROM plants WHERE archived_at IS NULL')
    let created = 0
    let kept = 0
    let removed = 0
    for (const p of plants) {
      const r = generateTasksForPlant(db, p.id, year, options)
      created += r.created
      kept += r.kept
      removed += r.removed
    }
    return { created, kept, removed, plants: plants.length }
  })
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

interface CareLogRow {
  id: number
  plant_id: number
  task_id: number | null
  log_date: string
  kind: string
  content: string | null
  recipe_id: number | null
  image_id: number | null
  created_at: string
}

function mapLog(row: CareLogRow): CareLog {
  return {
    id: row.id,
    plantId: row.plant_id,
    taskId: row.task_id,
    logDate: row.log_date,
    kind: row.kind,
    content: row.content,
    recipeId: row.recipe_id ?? null,
    imageId: row.image_id,
    images: [],
    createdAt: row.created_at
  }
}

/** 一条日志的照片（按 sort_order） */
export function listLogImages(db: Db, logId: number): CareLogImage[] {
  return db
    .all<{ id: number; path: string; thumb_path: string | null }>(
      'SELECT id, path, thumb_path FROM images WHERE log_id = ? ORDER BY sort_order, id',
      logId
    )
    .map((row) => ({ id: row.id, path: row.path, thumbPath: row.thumb_path }))
}

/** 给一批日志挂上照片（一次查询，避免 N+1） */
function attachLogImages(db: Db, logs: CareLog[]): CareLog[] {
  if (logs.length === 0) return logs
  const ids = logs.map((l) => l.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.all<{ log_id: number; id: number; path: string; thumb_path: string | null }>(
    `SELECT log_id, id, path, thumb_path FROM images
     WHERE log_id IN (${placeholders}) ORDER BY sort_order, id`,
    ...ids
  )
  const byLog = new Map<number, CareLogImage[]>()
  for (const row of rows) {
    const list = byLog.get(row.log_id) ?? []
    list.push({ id: row.id, path: row.path, thumbPath: row.thumb_path })
    byLog.set(row.log_id, list)
  }
  for (const log of logs) log.images = byLog.get(log.id) ?? []
  return logs
}

export function listCareLogs(db: Db, options: { plantId?: number; limit?: number } = {}): CareLog[] {
  const where = options.plantId ? 'WHERE plant_id = ?' : ''
  const params = options.plantId ? [options.plantId] : []
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const logs = db
    .all<CareLogRow>(`SELECT * FROM care_logs ${where} ORDER BY log_date DESC, id DESC LIMIT ${limit}`, ...params)
    .map(mapLog)
  return attachLogImages(db, logs)
}

export function addCareLog(
  db: Db,
  input: {
    plantId: number
    taskId?: number | null
    logDate?: string
    kind?: string
    content?: string | null
    /** 先把照片导入 images 表，再把 id 传进来；保存时挂到这条日志上 */
    imageIds?: number[]
  }
): CareLog {
  const r = db.run(
    'INSERT INTO care_logs (plant_id, task_id, log_date, kind, content) VALUES (?, ?, ?, ?, ?)',
    input.plantId,
    input.taskId ?? null,
    input.logDate ?? todayIso(),
    input.kind ?? 'note',
    input.content ?? null
  )
  const logId = Number(r.lastInsertRowid)
  const created = db.get<CareLogRow>('SELECT * FROM care_logs WHERE id = ?', logId)
  if (!created) throw new Error('日志创建失败')

  /*
   * 挂照片：id 来自 images:pick（先导入、后保存）。
   * 顺手把 plant_id 补上（挑选时还不知道属于哪株），
   * 这样以后按植株浏览照片也能找到它们。
   */
  const ids = (input.imageIds ?? []).filter((id) => Number.isFinite(id))
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    db.run(
      `UPDATE images SET log_id = ?, plant_id = COALESCE(plant_id, ?) WHERE id IN (${placeholders})`,
      logId,
      input.plantId,
      ...ids
    )
  }

  const log = mapLog(created)
  log.images = listLogImages(db, log.id)
  return log
}

export function updateCareLog(
  db: Db,
  id: number,
  patch: {
    content?: string | null
    kind?: string
    logDate?: string
    /** 新加的照片（已导入 images 表） */
    addImageIds?: number[]
    /** 要摘掉的照片 id（文件由 IPC 层清理） */
    removeImageIds?: number[]
  }
): CareLog | null {
  const row = db.get<CareLogRow>('SELECT * FROM care_logs WHERE id = ?', id)
  if (!row) return null

  const sets: string[] = []
  const params: Array<string | number | null> = []
  if (patch.content !== undefined) {
    sets.push('content = ?')
    params.push(patch.content)
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?')
    params.push(patch.kind)
  }
  if (patch.logDate !== undefined) {
    sets.push('log_date = ?')
    params.push(patch.logDate)
  }
  if (sets.length > 0) {
    db.run(`UPDATE care_logs SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
  }

  const removeIds = (patch.removeImageIds ?? []).filter((v) => Number.isFinite(v))
  if (removeIds.length > 0) {
    const placeholders = removeIds.map(() => '?').join(',')
    // 限定 log_id：不让人通过日志编辑删掉别的记录上的照片
    db.run(`DELETE FROM images WHERE log_id = ? AND id IN (${placeholders})`, id, ...removeIds)
  }

  const addIds = (patch.addImageIds ?? []).filter((v) => Number.isFinite(v))
  if (addIds.length > 0) {
    const placeholders = addIds.map(() => '?').join(',')
    db.run(
      `UPDATE images SET log_id = ?, plant_id = COALESCE(plant_id, ?) WHERE id IN (${placeholders})`,
      id,
      row.plant_id,
      ...addIds
    )
  }

  const updated = db.get<CareLogRow>('SELECT * FROM care_logs WHERE id = ?', id)
  if (!updated) return null
  const log = mapLog(updated)
  log.images = listLogImages(db, id)
  return log
}

export function deleteCareLog(db: Db, id: number): boolean {
  // 先删照片记录；文件由 IPC 层在拿到文件名后清理（repo 不碰文件系统）
  db.run('DELETE FROM images WHERE log_id = ?', id)
  const r = db.run('DELETE FROM care_logs WHERE id = ?', id)
  /*
   * 影响 0 行说明那条记录已经不在了 —— 如实返回 false。
   * 一直 return true 的话，界面报「已删除」而对象还在列表里，
   * 用户会以为删除功能坏了。
   */
  return Number(r.changes) > 0
}

/**
 * 批量删除养护日志，返回真正删掉的条数。
 *
 * 一个事务里逐条删：某条已经不在了不该让整批失败（用户选的列表可能已经过期）。
 * 照片文件仍然由 IPC 层负责，这里只管数据库。
 */
export function deleteCareLogs(db: Db, ids: number[]): number {
  const clean = [...new Set(ids.filter((id) => Number.isFinite(id)))]
  if (clean.length === 0) return 0
  return db.transaction(() => {
    let removed = 0
    for (const id of clean) {
      db.run('DELETE FROM images WHERE log_id = ?', id)
      removed += Number(db.run('DELETE FROM care_logs WHERE id = ?', id).changes)
    }
    return removed
  })
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

export function careOverview(db: Db, year: number, today: string = todayIso()): CareOverview {
  const tasks = listCareTasks(db, { from: `${year}-01-01`, to: `${year}-12-31` })
  const s = summarizeTasks(tasks, today)
  const plantsWithoutTasks = Number(
    db.scalar<number>(
      `SELECT COUNT(*) AS c FROM plants p
       WHERE p.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM care_tasks t WHERE t.plant_id = p.id AND t.due_date LIKE ?)`,
      `${year}-%`
    ) ?? 0
  )
  return { ...s, rules: careRuleCount(db), plantsWithoutTasks, yearTasks: tasks }
}
