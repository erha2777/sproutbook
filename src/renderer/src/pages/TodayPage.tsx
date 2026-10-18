/**
 * 今日页。
 *
 * 从「养护计划」里拆出来的两块：**当天要处理的任务** 与 **天气预警**。
 * 拆的理由不是好看 —— 养护计划那一页同时承担四件事（月度任务、全年统计、
 * 月历、养护日志），而「今天该干什么」被埋在翻月、统计、天气之间，
 * 每次都要先翻到当月才看得见。
 *
 * 这一页只回答两个问题：今天有什么要做、今天天气要不要紧。
 * 其余（全年计划、月历、日志）留在养护计划里。
 *
 * 数据口径：
 * - 待办 = **全部未完成任务**按紧急度筛出「已过期」和「该做了（时间窗内）」，
 *   不受月份限制 —— 去年忘了做的事今天仍然该出现在这里。
 * - 今天做完的 = 完成时间落在今天（本地时区）的任务，勾错了可以就地撤销。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareTask, Material, RecipeListItem } from '@core/types'
import type { CareTaskListItem, WeatherRiskItem, WeatherWarningResult } from '@shared/api'
import { suggestTask } from '@core/weather'
import { addDays, CARE_ACTION_ICONS, CARE_ACTION_LABELS, CARE_URGENCY_LABELS, dueDescription, groupTasksByRule, pendingBuckets, todayIso, urgencyOf, windowRange } from '@core/care'
import { Badge, Button, EmptyState, Panel, SectionTitle, Spinner, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareTaskRow, TaskGroup, TaskRecipe, URGENCY_TONE } from '../components/CareTaskRow'
import { WeatherPanel, weatherTaskKey } from '../components/WeatherPanel'

/**
 * UTC ISO 串 → **本地**日期（YYYY-MM-DD）。
 *
 * completedAt 存的是 `new Date().toISOString()`（UTC）。直接 slice(0, 10)
 * 在东八区会把凌晨 0~8 点完成的算成前一天 —— 于是「今天做完的」里
 * 少一条，用户会以为勾没生效。
 */
function localDateOf(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 'YYYY-MM-DD' → 周五。按本地日期解析，不会因时区差一天。 */
function weekdayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()] ?? ''
}

export function TodayPage({
  onCareChanged,
  onGoPlans
}: {
  onCareChanged?: () => void
  onGoPlans: () => void
}): ReactNode {
  const toast = useToast()
  const today = todayIso()

  const [openTasks, setOpenTasks] = useState<CareTaskListItem[]>([])
  const [doneToday, setDoneToday] = useState<CareTaskListItem[]>([])
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [recipes, setRecipes] = useState<RecipeListItem[] | null>(null)
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [weather, setWeather] = useState<WeatherWarningResult | null>(null)
  const [weatherBusy, setWeatherBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<CareTask | null>(null)

  /**
   * 天气预警。
   *
   * 应用里唯一会往外发请求的功能，所以仍然**按需拉取**：只有打开这一页时问一次。
   * 后端在没有养护位置填城市时会直接返回 configured:false —— 不填城市就是完全离线。
   */
  const loadWeather = useCallback(async (force = false) => {
    setWeatherBusy(true)
    try {
      setWeather(await window.api.weather.assess(force))
    } catch {
      // 天气取不到不该影响这一页 —— 它是锦上添花，不是主线
      setWeather(null)
    } finally {
      setWeatherBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadWeather(false)
  }, [loadWeather])

  /**
   * 只刷待办列表。
   *
   * 「今天做完的」不跟着重取：那一份是**今天这一天内**的追加/移除，
   * 重取反而会把它冲掉（例如在别的页面完成、完成日期又不在今天的那些）。
   */
  const reloadOpen = useCallback(async (): Promise<void> => {
    try {
      setOpenTasks(await window.api.care.tasks({ status: 'open' }))
    } catch (error) {
      toast.push(`加载待办失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }, [toast])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [open, dueToday, plantList, recipeList, materialList] = await Promise.all([
          window.api.care.tasks({ status: 'open' }),
          /*
           * 「今天做完的」取 ±7 天窗口再按**完成时间**筛，不是只看今天到期的：
           * 一条昨天到期的任务今天补做，完成时间仍然是今天，也该出现在这里。
           * 完成时间存的是 UTC ISO，所以下面用 localDateOf 转成本地日期再比。
           */
          window.api.care.tasks({ from: addDays(today, -7), to: addDays(today, 7) }),
          window.api.plants.list({ limit: 500 }),
          /*
           * 任务卡片要显示绑定的配方，所以一起取。
           *
           * **失败时给 null，不要给 []** —— 空数组会让 TaskRecipe 断言
           * 「配方已删除」，用户就会去重建一份其实还在的配方。
           */
          window.api.recipes.list().catch(() => null),
          window.api.materials.list().catch(() => null)
        ])
        if (!alive) return
        setOpenTasks(open)
        /*
         * 「今天做完的」按完成时间筛，不是按计划日期：
         * 一条昨天的任务今天补做，也应该出现在这里。
         */
        setDoneToday(dueToday.filter((t) => t.status !== 'pending' && localDateOf(t.completedAt) === today))
        setPlants(
          plantList.items.map((p) => ({
            id: p.id,
            label: `${p.nickname}${p.species ? `（${p.species.commonName}）` : ''}`
          }))
        )
        setRecipes(recipeList)
        setMaterials(materialList)
      } catch (error) {
        if (alive) toast.push(`加载今日待办失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [today, toast])

  /**
   * 全部未完成任务按紧急度分组。
   *
   * 用的是 core 的 pendingBuckets —— 养护计划页用同一个函数，
   * 这样「今日 该做 N」和「养护计划 该做了 N」永远是同一个数。
   */
  const groups = useMemo(() => pendingBuckets(openTasks, today), [openTasks, today])

  /**
   * 已经加进计划里的天气任务。
   *
   * 从待办列表**推导**而不是自己记一份状态：完成 / 删除 / 撤销之后
   * 列表会重新加载，这里跟着就对了，不会出现「任务删了按钮还写着已加入」。
   */
  const addedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const t of openTasks) {
      if (t.status === 'pending' && t.plantId !== null) set.add(weatherTaskKey(t.plantId, t.dueDate, t.title))
    }
    return set
  }, [openTasks])

  /**
   * 把一条天气风险变成任务。
   *
   * **只在你点按钮时才写数据。** 预警本身永远不自动建任务 ——
   * 和 AI 草稿一样，它只提议，不替你做决定。
   */
  const createTaskFromRisk = async (risk: WeatherRiskItem): Promise<void> => {
    /*
     * 文案从 core 拿，**不再在这里抄一份**。
     * 这里曾经有一份逐字副本，而且已经漂移了（少了「前」字）。
     */
    const { title, detail } = suggestTask(risk)
    /*
     * 先查重。
     *
     * 第一版没有这一步：用户点了 4 次就建出 4 条一模一样的任务。
     * 所以两件事都要做：这里挡住重复，界面上把已加入的状态显示出来。
     */
    const key = weatherTaskKey(risk.plantId, risk.date, title)
    if (addedKeys.has(key)) {
      toast.push('这条已经在养护计划里了', 'info')
      return
    }
    try {
      await window.api.care.createTask({
        plantId: risk.plantId,
        actionType: risk.kind === 'frost' ? 'protect' : 'water',
        title,
        detail,
        dueDate: risk.date,
        windowDays: 2,
        priority: risk.severity === 'severe' ? 1 : 2,
        source: 'manual'
      })
      toast.push('已加入养护计划', 'success')
      await reloadOpen()
      onCareChanged?.()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '创建任务失败', 'error')
    }
  }

  /** 把刚完成 / 跳过的任务合并进「今天做完的」，同一条不重复 */
  const mergeDone = useCallback((task: CareTaskListItem, updated: CareTask): void => {
    setDoneToday((rows) => {
      const merged: CareTaskListItem = { ...task, ...updated }
      const rest = rows.filter((r) => r.id !== merged.id)
      return [merged, ...rest]
    })
  }, [])

  const act = async (
    task: CareTaskListItem,
    action: 'complete' | 'skip' | 'reopen',
    note?: string
  ): Promise<void> => {
    setBusyId(task.id)
    try {
      if (action === 'complete') {
        const updated = await window.api.care.completeTask(task.id, note?.trim() ? note : null)
        if (updated) mergeDone(task, updated)
        toast.push('已完成', 'success')
      } else if (action === 'skip') {
        const updated = await window.api.care.skipTask(task.id)
        if (updated) mergeDone(task, updated)
        toast.push('已跳过', 'success')
      } else {
        await window.api.care.reopenTask(task.id)
        // 撤销后它回到待办里，就不该再挂在「今天做完的」下面
        setDoneToday((rows) => rows.filter((r) => r.id !== task.id))
        toast.push('已撤销', 'success')
      }
      await reloadOpen()
      onCareChanged?.()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '操作失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const removeTask = async (task: CareTaskListItem): Promise<void> => {
    if (!window.confirm(`确定删除任务「${task.title}」吗？`)) return
    try {
      await window.api.care.removeTask(task.id)
      setDoneToday((rows) => rows.filter((r) => r.id !== task.id))
      toast.push('已删除', 'success')
      await reloadOpen()
      onCareChanged?.()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  const renderRow = (task: CareTaskListItem, compact = false): ReactNode => (
    <CareTaskRow
      key={task.id}
      task={task}
      today={today}
      compact={compact}
      busy={busyId === task.id}
      recipes={recipes}
      materials={materials}
      onComplete={(t, note) => void act(t, 'complete', note)}
      onSkip={(t) => void act(t, 'skip')}
      onReopen={(t) => void act(t, 'reopen')}
      onEdit={(t) => setEditing(t)}
      onDelete={(t) => void removeTask(t)}
    />
  )

  /**
   * 一组任务 → 分组展示。
   *
   * **只分组，不合并动作**：同一条规则的多株仍然是各自独立的一行
   * （各自的完成 / 跳过 / 备注，以后还要按株加照片日志）。
   * 分组头只负责把「这是同一件事」讲清楚：标题、日期、可做期、说明、配方，
   * 以及共几株 —— 否则七行重复的标题和说明会把页面撑得很长。
   */
  const renderGroup = (list: CareTaskListItem[]): ReactNode => {
    if (list.length === 1) return renderRow(list[0])
    const first = list[0]
    const urgency = urgencyOf(first, today)
    const dueText = dueDescription(first, today)
    const label = CARE_URGENCY_LABELS[urgency]
    return (
      <div className="task-group" key={`${first.ruleId}-${first.dueDate}-${first.title}`}>
        <div className="task-group-head">
          <span className="task-icon">{CARE_ACTION_ICONS[first.actionType]}</span>
          <b>{first.title}</b>
          <Badge tone={URGENCY_TONE[urgency]}>
            {dueText.startsWith(label) ? dueText : `${label} · ${dueText}`}
          </Badge>
          {first.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
          <Badge tone="muted">共 {list.length} 株</Badge>
          <span className="spacer" />
          <span className="small muted">
            {first.dueDate} · {CARE_ACTION_LABELS[first.actionType]}
            {first.windowDays > 0 ? ` · 可做至 ${windowRange(first).to}` : ''}
          </span>
        </div>
        {first.detail ? <div className="small task-group-note">{first.detail}</div> : null}
        {first.recipeId ? (
          <div className="task-group-note">
            <TaskRecipe recipeId={first.recipeId} recipes={recipes} materials={materials} />
          </div>
        ) : null}
        <div className="task-group-body">{list.map((t) => renderRow(t, true))}</div>
      </div>
    )
  }

  const nothingToDo = groups.overdue.length === 0 && groups.due.length === 0
  return (
    <div className="content-inner">
      {/*
        页头放进 Panel，而不是直接把「今日 + 日期」摆在天上。
        小字用 --ink-soft 写在蓝色画布上几乎看不清（用户之前就为
        「ghost 按钮在蓝色上看不见」提过一次），奶油面板上同样的字是清楚的，
        形式也和别的页一致。
      */}
      <Panel>
        <SectionTitle
          right={
            <>
              <span className="small muted">
                {today} · {weekdayOf(today)}
              </span>
              <Button size="small" onClick={onGoPlans}>
                完整养护计划 →
              </Button>
            </>
          }
        >
          今日
        </SectionTitle>
      </Panel>

      {loading ? (
        <Panel>
          <Spinner label="加载中…" />
        </Panel>
      ) : (
        <>
          {/*
            天气预警放最上面（用户明确要求）：先看天，再决定今天做什么 ——
            「今天要不要收盆、要不要避开正午浇水」本来也是行动的前提。
          */}
          <Panel>
            <SectionTitle
              right={
                <span className="small muted">
                  {weatherBusy
                    ? '正在查看…'
                    : weather?.fetchedAt
                      ? `数据时间 ${new Date(weather.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                </span>
              }
            >
              天气预警 <span className="small muted">（当天）</span>
            </SectionTitle>
            <WeatherPanel
              result={weather}
              addedKeys={addedKeys}
              busy={weatherBusy}
              onRefresh={() => void loadWeather(true)}
              onCreateTask={createTaskFromRisk}
            />
          </Panel>

          <Panel>
            <SectionTitle
              right={
                <span className="small muted">
                  {groups.overdue.length > 0 ? `已过期 ${groups.overdue.length} · ` : ''}
                  今天该做 {groups.due.length}
                  {doneToday.length > 0 ? ` · 今天完成 ${doneToday.length}` : ''}
                </span>
              }
            >
              今日待办
            </SectionTitle>

            {nothingToDo ? (
              <EmptyState
                icon="🌿"
                title={doneToday.length > 0 ? '今天的事都做完了' : '今天没有要做的事'}
                hint={
                  groups.early.length > 0
                    ? `已有 ${groups.early.length} 项进入时间窗（最早 ${groups.early[0].dueDate.slice(5)}），还没到期，可以提前做。`
                    : groups.soon.length > 0
                      ? `有 ${groups.soon.length} 项在 7 天内进入时间窗，可以到「养护计划」里提前处理。`
                      : '规则生成的任务会按时间窗落到这里；也可以到养护计划里手动加一条。'
                }
                action={<Button onClick={onGoPlans}>去看完整养护计划</Button>}
              />
            ) : (
              <>
                <TaskGroup title="已过期" count={groups.overdue.length} tone="safety">
                  {groupTasksByRule(groups.overdue).map(renderGroup)}
                </TaskGroup>
                <TaskGroup title="今天该做" count={groups.due.length} tone="warn">
                  {groupTasksByRule(groups.due).map(renderGroup)}
                </TaskGroup>
                {/*
                  「已经可以做」和「快到了」都**不列出来** ——
                  今日页只列今天（含逾期）真正该做的。但两条数量都要给：
                  一条都不提的话，用户会以为接下来一周没事。
                */}
                {groups.early.length > 0 || groups.soon.length > 0 ? (
                  <div className="row tight" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    {groups.early.length > 0 ? (
                      <span className="small muted">
                        另有 {groups.early.length} 项已进入时间窗（最早 {groups.early[0].dueDate.slice(5)}），
                        还没到期，可以提前做。
                      </span>
                    ) : null}
                    {groups.soon.length > 0 ? (
                      <span className="small muted">还有 {groups.soon.length} 项 7 天内进入时间窗。</span>
                    ) : null}
                    <Button size="small" variant="ghost" onClick={onGoPlans}>
                      去养护计划看
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          {doneToday.length > 0 ? (
            <Panel flat>
              <SectionTitle right={<span className="small muted">勾错了可以就地撤销</span>}>
                今天做完的（{doneToday.length}）
              </SectionTitle>
              {doneToday.map((task) => renderRow(task))}
            </Panel>
          ) : null}
        </>
      )}

      {editing ? (
        <CareTaskDialog
          task={editing}
          plants={plants}
          defaultDate={today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reloadOpen()
            onCareChanged?.()
          }}
        />
      ) : null}
    </div>
  )
}
