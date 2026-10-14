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
  CareTaskQuery
} from '../../../shared/api'
import { addDays, generateTasks, summarizeTasks, todayIso } from '../../../core/care'

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
    speciesKey: row.species_key,
    hemisphere: row.hemisphere as CareHemisphere,
    climateZone: row.climate_zone,
    monthFrom: row.month_from,
    monthTo: row.month_to,
    actionType: row.action_type as CareActionType,
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    source: row.source as CareRule['source'],
    verified: row.verified === 1,
    createdAt: row.created_at
  }
}

export function listCareRules(
  db: Db,
  options: { speciesKey?: string; hemisphere?: CareHemisphere } = {}
): CareRule[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.speciesKey) {
    where.push('species_key = ?')
    params.push(options.speciesKey)
  }
  if (options.hemisphere) {
    where.push('hemisphere = ?')
    params.push(options.hemisphere)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .all<CareRuleRow>(`SELECT * FROM care_rules ${whereSql} ORDER BY species_key, month_from, priority`, ...params)
    .map(mapRule)
}

export function saveCareRule(db: Db, input: CareRuleInput): CareRule {
  const title = input.title.trim()
  if (!title) throw new Error('规则标题不能为空')
  if (input.monthFrom < 1 || input.monthFrom > 12) throw new Error('起始月份需要在 1~12 之间')

  if (input.id) {
    db.run(
      `UPDATE care_rules SET species_key=?, hemisphere=?, climate_zone=?, month_from=?, month_to=?,
         action_type=?, title=?, detail=?, priority=?, source=?, verified=? WHERE id=?`,
      input.speciesKey.trim() || '*',
      input.hemisphere,
      input.climateZone,
      input.monthFrom,
      input.monthTo,
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
       action_type, title, detail, priority, source, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.speciesKey.trim() || '*',
    input.hemisphere,
    input.climateZone,
    input.monthFrom,
    input.monthTo,
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
  db.run('DELETE FROM care_rules WHERE id = ?', id)
  return true
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
       recurrence, priority, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.planId ?? null,
    input.plantId ?? null,
    input.actionType,
    title,
    input.detail ?? null,
    input.dueDate,
    input.windowDays ?? 3,
    input.recurrence ?? null,
    input.priority ?? 2,
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
export function completeCareTask(db: Db, id: number, note?: string | null, date?: string): CareTask | null {
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

    if (task.plantId !== null) {
      db.run(
        `INSERT INTO care_logs (plant_id, task_id, log_date, kind, content) VALUES (?, ?, ?, ?, ?)`,
        task.plantId,
        id,
        when,
        task.actionType,
        note?.trim() || task.title
      )
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
    db.run('DELETE FROM care_tasks WHERE id = ?', id)
    return true
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
    const plant = db.get<{ id: number; nickname: string; species_id: number | null }>(
      'SELECT id, nickname, species_id FROM plants WHERE id = ? AND archived_at IS NULL',
      plantId
    )
    if (!plant) return { created: 0, kept: 0, removed: 0, plants: 0 }

    const speciesName = plant.species_id
      ? (db.get<{ common_name: string }>('SELECT common_name FROM species WHERE id = ?', plant.species_id)
          ?.common_name ?? null)
      : null

    const rules = listCareRules(db, { hemisphere: options.hemisphere ?? 'N' })
    const allGenerated = generateTasks(rules, speciesName, year, {
      hemisphere: options.hemisphere ?? 'N',
      defaultWindowDays: options.windowDays ?? 15,
      // 按植株错开锚点日：否则七株的任务全挤在同一天，月历就没法看了
      spreadSeed: plantId
    })

    // 时间窗已经走完的月份不再生成：那些日子计划还不存在，不该记成欠账
    const cutoff = options.today ?? todayIso()
    const generated =
      options.skipPast === false
        ? allGenerated
        : allGenerated.filter((t) => addDays(t.dueDate, t.windowDays) >= cutoff)

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
      if (existingBySignature.has(taskSignature(task))) {
        kept++
        continue
      }
      db.run(
        `INSERT INTO care_tasks (plan_id, plant_id, action_type, title, detail, due_date, window_days,
           priority, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')`,
        plan.id,
        plantId,
        task.actionType,
        task.title,
        task.detail,
        task.dueDate,
        task.windowDays,
        task.priority
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
    imageId: row.image_id,
    createdAt: row.created_at
  }
}

export function listCareLogs(db: Db, options: { plantId?: number; limit?: number } = {}): CareLog[] {
  const where = options.plantId ? 'WHERE plant_id = ?' : ''
  const params = options.plantId ? [options.plantId] : []
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  return db
    .all<CareLogRow>(`SELECT * FROM care_logs ${where} ORDER BY log_date DESC, id DESC LIMIT ${limit}`, ...params)
    .map(mapLog)
}

export function addCareLog(
  db: Db,
  input: { plantId: number; taskId?: number | null; logDate?: string; kind?: string; content?: string | null }
): CareLog {
  const r = db.run(
    'INSERT INTO care_logs (plant_id, task_id, log_date, kind, content) VALUES (?, ?, ?, ?, ?)',
    input.plantId,
    input.taskId ?? null,
    input.logDate ?? todayIso(),
    input.kind ?? 'note',
    input.content ?? null
  )
  const created = db.get<CareLogRow>('SELECT * FROM care_logs WHERE id = ?', Number(r.lastInsertRowid))
  if (!created) throw new Error('日志创建失败')
  return mapLog(created)
}

export function deleteCareLog(db: Db, id: number): boolean {
  db.run('DELETE FROM care_logs WHERE id = ?', id)
  return true
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
  return { ...s, rules: careRuleCount(db), plantsWithoutTasks }
}
