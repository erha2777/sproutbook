/**
 * 养护计划页。
 *
 * 信息组织上做了一个选择：**先按紧急度，再按月份**。
 * 纯粹的月历很好看，但「上个月忘做的事」会被翻页翻掉——
 * 而那恰恰是最需要被提醒的。所以逾期任务永远置顶，
 * 月份只用来筛选「这个月原本要做什么」。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog, CarePhase, CareTask, Material, RecipeListItem } from '@core/types'
import type { CareOverview, CareTaskListItem, PlantPhaseInfo, WeatherRiskItem, WeatherWarningResult } from '@shared/api'
import { SEVERITY_LABELS } from '@core/weather'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  CARE_PHASE_HINTS,
  CARE_PHASE_ICONS,
  CARE_PHASE_LABELS,
  CARE_PHASE_OPTIONS,
  CARE_URGENCY_LABELS,
  dueDescription,
  phaseAgeDays,
  summarizeTasks,
  todayIso,
  urgencyOf
} from '@core/care'
import type { CareUrgency } from '@core/care'
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareRuleManager } from '../components/CareRuleManager'
import { CareCalendar } from '../components/CareCalendar'

/**
 * 天气预警面板。
 *
 * 四种状态各有各的话要说，尤其是「没配置」那一种 ——
 * 用户需要知道**不填城市就不会联网**，而不是以为功能坏了。
 *
 * 定义在模块层而不是 CarePage 内部：组件内定义会让每次渲染产生新的函数标识，
 * React 视为换了类型就整个重挂子树（之前笔记输入框打不进字就是这个原因）。
 */
/**
 * 天气任务的身份：同一株 + 同一天 + 同一个标题就算同一条。
 *
 * 抽成模块层函数是为了让**建之前的查重**和**按钮的禁用态**
 * 用同一个定义 —— 两处各写一遍迟早会漂移，然后就是「按钮说已加入、
 * 点了却又建一条」这种自相矛盾。
 */
function weatherTaskKey(plantId: number, date: string, title: string): string {
  return `${plantId}|${date}|${title}`
}

function WeatherPanel({
  result,
  addedKeys,
  busy,
  onRefresh,
  onCreateTask
}: {
  result: WeatherWarningResult | null
  /** 已经加进计划的任务身份，用来把按钮变成禁用态 */
  addedKeys: Set<string>
  busy: boolean
  onRefresh: () => void
  onCreateTask: (risk: WeatherRiskItem) => void | Promise<void>
}): ReactNode {
  if (busy && !result) return <div className="small muted">正在查看天气…</div>
  if (!result) return <div className="small muted">暂时拿不到天气数据。</div>

  if (!result.configured) {
    return (
      <div className="small muted">
        还没有养护位置填过城市，所以<b>没有联网</b>。
        到「设置 → 养护位置」给露天的位置填上城市（比如「岳阳」），
        这里就会按那儿的实际天气提醒你防冻、防暑。
        <div style={{ marginTop: 4 }}>
          判断依据是每个物种的「耐寒 / 耐热」温度，以及这个位置能不能防冻、能不能加温。
        </div>
      </div>
    )
  }

  const risks = result.risks
  const nothing = risks.length === 0

  return (
    <div>
      {result.error ? <div className="small muted">⚠ {result.error}（下面可能是缓存的数据）</div> : null}

      {nothing ? (
        <div className="small muted">
          未来几天{result.places.length > 0 ? `（${result.places.map((p) => p.label || p.name).join('、')}）` : ''}
          没有超出任何植株的承受范围。
        </div>
      ) : (
        <div className="weather-risks">
          {risks.map((r) => {
            const added = addedKeys.has(
              weatherTaskKey(r.plantId, r.date, `${r.kind === 'frost' ? '防冻' : '防暑'}：${r.plantName}`)
            )
            return (
            <div key={`${r.kind}-${r.plantId}`} className={`weather-risk sev-${r.severity}`}>
              <div className="weather-risk-head">
                <span className={`weather-badge sev-${r.severity}`}>
                  {r.kind === 'frost' ? '❄' : '☀'} {SEVERITY_LABELS[r.severity]}
                </span>
                <b>{r.plantName}</b>
                <span className="muted small">{r.date}</span>
                <span style={{ flex: 1 }} />
                {added ? (
                  <span className="small muted">✓ 已在养护计划里</span>
                ) : (
                  <Button size="small" onClick={() => void onCreateTask(r)}>
                    加进养护计划
                  </Button>
                )}
              </div>
              <div className="small">{r.message}</div>
            </div>
            )
          })}
        </div>
      )}

      {result.unknownCold.length > 0 ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          另有 {result.unknownCold.length} 株的物种没填「耐寒」温度，判断不了：
          {result.unknownCold.join('、')}
        </div>
      ) : null}

      {/*
        把实际用的坐标摆出来。用户反馈过「位置不够精准」——
        与其解释预报有多粗，不如让他看见取的是哪个点，
        再决定要不要到「设置 → 养护位置」填精确经纬度。
      */}
      {result.places.length > 0 ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          预报点：
          {result.places
            .map(
              (p) =>
                `${p.label || p.name}（${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}）` +
                `${p.level === 'district' ? ' · 已到区县' : ' · 只到市'}`
            )
            .join('、')}
          <br />
          {/*
            精度那句话要跟着实际情况走。
            早期版本写死了「城市尺度」，可配了和风之后地名是能到区县的 ——
            写死的话就成了另一句不实的话。
          */}
          {result.places.some((p) => p.level === 'district')
            ? '位置已精确到你填的区县。天气本身仍是网格预报，和你家院子可能还有几度出入。'
            : '这是网格预报，城市尺度，和你家院子可能有几度出入。到「设置 → 养护位置」填区县（或直接填经纬度）会更准。'}
        </div>
      ) : null}

      <div className="row tight" style={{ marginTop: 8 }}>
        <Button size="small" onClick={onRefresh} disabled={busy}>
          {busy ? '刷新中…' : '重新获取'}
        </Button>
        {/* 这里**不能写死**，配了和风就不是 Open-Meteo 了 */}
        <span className="small muted">
          {result.providerLabel ? `数据来自 ${result.providerLabel}` : '天气数据'}，只在打开这一页时请求一次
          {result.requestsToday > 0 ? `　·　今天已请求 ${result.requestsToday} 次` : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * 任务卡片上显示绑定的配方。
 *
 * **定义在模块层，不是组件内部。** 组件内定义会让每次渲染都产生一个新的
 * 函数标识，React 认为子树换了类型就整个重挂载 —— 之前笔记输入框打不进字
 * 就是这个原因。这个组件目前只是静态展示，但同样的坑不该再踩第二次。
 */
function TaskRecipe({
  recipeId,
  recipes,
  materials
}: {
  recipeId: number
  recipes: RecipeListItem[]
  materials: Material[]
}): ReactNode {
  const rec = recipes.find((r) => r.id === recipeId)
  if (!rec) return <div className="small muted">📋 配方已删除</div>
  const parts = rec.items.map((it) => {
    const label = it.name ?? materials.find((m) => m.id === it.materialId)?.name ?? '材料'
    return it.ratioPart && it.ratioPart !== 1 ? `${label} ${it.ratioPart} 份` : label
  })
  return (
    <div className="task-recipe">
      <span className="task-recipe-name">📋 {rec.name}</span>
      {parts.length > 0 ? <span className="muted"> {parts.join(' · ')}</span> : null}
    </div>
  )
}
const URGENCY_TONE: Record<CareUrgency, 'safety' | 'warn' | 'info' | 'muted' | 'ok'> = {
  overdue: 'safety',
  due: 'warn',
  soon: 'info',
  later: 'muted',
  closed: 'ok'
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const last = new Date(year, month, 0).getDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

export function CarePage({ onCareChanged }: { onCareChanged?: () => void }): ReactNode {
  const toast = useToast()
  const today = todayIso()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [plantFilter, setPlantFilter] = useState('')
  const [tab, setTab] = useState<'todo' | 'calendar' | 'logs'>('todo')
  const [tasks, setTasks] = useState<CareTaskListItem[]>([])
  const [overdue, setOverdue] = useState<CareTaskListItem[]>([])
  const [overview, setOverview] = useState<CareOverview | null>(null)
  const [logs, setLogs] = useState<CareLog[]>([])
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [speciesNames, setSpeciesNames] = useState<string[]>([])
  /** 任务上要显示绑定的配方，所以把配方与材料一起取回来（都是几十条量级） */
  const [recipes, setRecipes] = useState<RecipeListItem[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  /**
   * 天气预警。
   *
   * 这是应用里唯一会往外发请求的功能，所以刻意做成**按需拉取**：
   * 只有打开养护计划页时才问一次，而且后端在没有养护位置填城市时
   * 会直接返回 configured:false —— 不填城市就是完全离线。
   */
  const [weather, setWeather] = useState<WeatherWarningResult | null>(null)
  const [weatherBusy, setWeatherBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<CareTask | 'new' | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [noteText, setNoteText] = useState('')
  /** 从月历点进来的任务：滚动并高亮一下，否则用户不知道跳到了哪里 */
  const [highlight, setHighlight] = useState<number | null>(null)
  /** 从月历空白日点「＋」新增任务时的预设日期 */
  const [draftDate, setDraftDate] = useState<string | undefined>(undefined)
  /** 每株植物的物候阶段 */
  const [plantPhases, setPlantPhases] = useState<Record<number, PlantPhaseInfo>>({})
  const [phaseTarget, setPhaseTarget] = useState<{ id: number; name: string } | null>(null)
  const [phaseNote, setPhaseNote] = useState('')

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  /**
   * 已经加进计划里的天气任务。
   *
   * 从任务列表**推导**而不是自己记一份状态：完成 / 删除 / 撤销之后
   * 列表会重新加载，这里跟着就对了，不会出现「任务删了按钮还写着已加入」。
   */
  const addedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const t of [...tasks, ...overdue]) {
      if (t.status === 'pending' && t.plantId !== null) set.add(weatherTaskKey(t.plantId, t.dueDate, t.title))
    }
    return set
  }, [tasks, overdue])

  /**
   * 取天气预警。
   *
   * 刻意放在 reload 之外：任务刷新频繁（完成一条就刷），
   * 天气没必要跟着刷 —— 后端有 3 小时缓存兜底，但连请求都不该发。
   */
  const loadWeather = useCallback(
    async (force = false) => {
      setWeatherBusy(true)
      try {
        setWeather(await window.api.weather.assess(force))
      } catch {
        // 天气取不到不该影响这个页面 —— 它是锦上添花，不是主线
        setWeather(null)
      } finally {
        setWeatherBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    void loadWeather(false)
  }, [loadWeather])

  /**
   * 把一条天气风险变成任务。
   *
   * **只在你点按钮时才写数据。** 预警本身永远不自动建任务 ——
   * 和 AI 草稿一样，它只提议，不替你做决定。
   */
  const createTaskFromRisk = async (risk: WeatherRiskItem): Promise<void> => {
    const what = risk.kind === 'frost' ? '防冻' : '防暑'
    const action =
      risk.kind === 'frost'
        ? '搬到避风处或室内；不能搬的用无纺布/旧床单罩住，别用塑料袋闷。降温当天浇透一次水（湿土比干土保温）。'
        : '避开正午浇水，改到清晨或傍晚；遮阳网或搬到半阴处；高温期间停施水溶肥。'
    const title = `${what}：${risk.plantName}`
    /*
     * 先查重。
     *
     * 第一版没有这一步：用户点了 4 次就建出 4 条一模一样的任务
     *（同植株、同日期、同标题）。按钮点下去没有任何反馈，
     * 用户自然会怀疑「到底加上没有」然后再点一次 —— 所以两件事都要做：
     * 这里挡住重复，界面上把已加入的状态显示出来。
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
        detail: `${risk.message}\n${action}\n〔依据天气预警，${risk.date}〕`,
        dueDate: risk.date,
        windowDays: 2,
        priority: risk.severity === 'severe' ? 1 : 2,
        source: 'manual'
      })
      toast.push('已加入养护计划', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '创建任务失败', 'error')
    }
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const plantId = plantFilter ? Number(plantFilter) : undefined
      const [monthTasks, allOpen, ov, logList, plantList, speciesList, recipeList, materialList] = await Promise.all([
        window.api.care.tasks({ from: bounds.from, to: bounds.to, plantId }),
        window.api.care.tasks({ status: 'open', plantId }),
        window.api.care.overview(year),
        window.api.care.logs(plantId, 100),
        window.api.plants.list({ limit: 500 }),
        window.api.species.list({ limit: 500 }),
        // 任务卡片要显示绑定的配方，所以一起取
        window.api.recipes.list().catch(() => []),
        window.api.materials.list().catch(() => [])
      ])
      setTasks(monthTasks)
      // 逾期任务可能落在任意更早的月份，必须单独取，否则翻页就「看不见」了
      setOverdue(allOpen.filter((t) => urgencyOf(t, today) === 'overdue'))
      setOverview(ov)
      setLogs(logList)
      setPlants(
        plantList.items.map((p) => ({
          id: p.id,
          label: `${p.nickname}${p.species ? `（${p.species.commonName}）` : ''}`
        }))
      )
      setSpeciesNames(speciesList.items.map((s) => s.commonName))
      // 配方取不到不该让整页报错（用户可能一个配方都没有）
      setRecipes(recipeList ?? [])
      setMaterials(materialList ?? [])
      {
        const infos = await Promise.all(plantList.items.map((p) => window.api.care.plantPhase(p.id)))
        setPlantPhases(Object.fromEntries(infos.map((i) => [i.plantId, i])))
      }
      // 侧栏角标和这里的统计是同一份数据，一起刷新才不会出现
      //「页面上写着该做 0、侧栏还挂着红点」这种自相矛盾
      onCareChanged?.()
    } catch (error) {
      toast.push(`加载养护计划失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [bounds.from, bounds.to, plantFilter, year, today, toast, onCareChanged])

  useEffect(() => {
    void reload()
  }, [reload])

  const generate = async (): Promise<void> => {
    try {
      const result = await window.api.care.generateAll(year)
      toast.push(
        result.created > 0
          ? `已为 ${result.plants} 株植物生成 ${result.created} 项任务（保留已有 ${result.kept} 项）`
          : `计划已是最新：${result.plants} 株植物，${result.kept} 项任务无需变动`,
        'success'
      )
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '生成失败', 'error')
    }
  }

  const act = async (id: number, action: 'complete' | 'skip' | 'reopen', note?: string): Promise<void> => {
    setBusyId(id)
    try {
      if (action === 'complete') await window.api.care.completeTask(id, note ?? null)
      else if (action === 'skip') await window.api.care.skipTask(id, note ?? null)
      else await window.api.care.reopenTask(id)
      setNoteFor(null)
      setNoteText('')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '操作失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 标记植株阶段。
   *
   * 标完要重新生成 —— 限定阶段的规则会随之生效或失效，
   * 不重新生成的话任务列表和实际阶段就对不上了。
   */
  const applyPhase = async (plantId: number, phase: CarePhase | null): Promise<void> => {
    try {
      await window.api.care.setPlantPhase(plantId, phase, phaseNote.trim() || null)
      setPhaseTarget(null)
      setPhaseNote('')
      const generated = await window.api.care.generate(plantId, year)
      toast.push(
        phase
          ? `已标记为「${CARE_PHASE_LABELS[phase]}」，计划已更新（新建 ${generated.created} 项）`
          : '已清除阶段标记，计划已更新',
        'success'
      )
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '标记失败', 'error')
    }
  }

  const removeTask = async (task: CareTaskListItem): Promise<void> => {    if (!window.confirm(`确定删除任务「${task.title}」吗？`)) return
    try {
      await window.api.care.removeTask(task.id)
      toast.push('已删除', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  // ---- 分组 ----
  const isDone = (t: CareTaskListItem): boolean => t.status !== 'pending'
  const overdueSet = new Set(overdue.map((t) => t.id))
  const groups = useMemo(() => {
    const pending = tasks.filter((t) => !isDone(t) && !overdueSet.has(t.id))
    const byUrgency = (u: CareUrgency): CareTaskListItem[] =>
      pending.filter((t) => urgencyOf(t, today) === u).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    return {
      overdue,
      due: byUrgency('due'),
      soon: byUrgency('soon'),
      later: byUrgency('later'),
      closed: tasks.filter(isDone)
    }
  }, [tasks, overdue, overdueSet, today])

  const monthSummary = summarizeTasks(tasks, today)

  /**
   * 任务行 / 分组。
   *
   * 这两个是**普通函数**，必须直接调用 `taskRow(task)`，
   * 不能写成 `<TaskRow task={t} />` —— 它们定义在 CarePage 内部，
   * 每次重渲染都是新的函数对象。React 按类型标识比较元素，
   * 用 JSX 组件语法会让它认为类型变了，从而卸载并重建整棵子树。
   * 后果很具体：备注输入框每敲一个字符就被销毁重建、焦点丢失，
   * 表现为「输入不了东西」。
   */
  const taskRow = (task: CareTaskListItem): ReactNode => {
    const urgency = urgencyOf(task, today)
    const closed = task.status !== 'pending'
    return (
      <div className={"task-row" + (highlight === task.id ? " highlighted" : "")}>
        <span className="task-icon">{CARE_ACTION_ICONS[task.actionType]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row tight" style={{ alignItems: 'center' }}>
            <b>{task.title}</b>
            <Badge tone={URGENCY_TONE[urgency]}>
              {closed
                ? task.status === 'done'
                  ? '已完成'
                  : '已跳过'
                : `${CARE_URGENCY_LABELS[urgency]} · ${dueDescription(task, today)}`}
            </Badge>
            {task.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
            {task.source === 'manual' ? <Badge tone="muted">手动</Badge> : null}
          </div>
          <div className="small muted">
            {task.dueDate}
            {task.plantName ? ` · ${task.plantName}` : ''}
            {task.speciesName ? ` · ${task.speciesName}` : ''}
            {` · ${CARE_ACTION_LABELS[task.actionType]}`}
            {task.windowDays > 0 ? ` · 时间窗 ±${task.windowDays} 天` : ''}
          </div>
          {task.detail ? <div className="small">{task.detail}</div> : null}
          {/*
            绑了配方的规则，任务上直接列出材料清单 ——
            做的时候不用再翻回规则库查「羊粪放多少」。
            按 id 现查，所以配方改了名字这里会跟着变。
          */}
          {task.recipeId ? <TaskRecipe recipeId={task.recipeId} recipes={recipes} materials={materials} /> : null}
          {task.completedNote ? <div className="small muted">备注：{task.completedNote}</div> : null}

          {noteFor === task.id ? (
            <div className="row tight" style={{ marginTop: 6 }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={noteText}
                  onChange={setNoteText}
                  placeholder="记一句当时的情况（可留空）"
                  autoFocus
                />
              </div>
              <Button size="small" variant="primary" onClick={() => void act(task.id, 'complete', noteText)}>
                确认完成
              </Button>
              <Button size="small" variant="ghost" onClick={() => setNoteFor(null)}>
                取消
              </Button>
            </div>
          ) : null}
        </div>

        <div className="row tight" style={{ flexWrap: 'nowrap' }}>
          {closed ? (
            <>
              <Button size="small" disabled={busyId === task.id} onClick={() => void act(task.id, 'reopen')}>
                撤销
              </Button>
              <Button size="small" variant="ghost" onClick={() => void removeTask(task)}>
                删除
              </Button>
            </>
          ) : (
            <>
              <Button
                size="small"
                variant="primary"
                disabled={busyId === task.id}
                onClick={() => {
                  setNoteFor(task.id)
                  setNoteText('')
                }}
              >
                完成
              </Button>
              <Button size="small" disabled={busyId === task.id} onClick={() => void act(task.id, 'skip')}>
                跳过
              </Button>
              <Button size="small" variant="ghost" onClick={() => setEditing(task)}>
                编辑
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  const taskGroup = (title: string, list: CareTaskListItem[], tone?: string): ReactNode => {
    if (list.length === 0) return null
    return (
      <div style={{ marginBottom: 14 }} key={title}>
        <div className="section-title">
          {title}
          {tone ? <Badge tone={tone as 'safety'}>{list.length}</Badge> : <span className="small muted">{list.length} 项</span>}
        </div>
        {list.map((t) => (
          <Fragment key={t.id}>{taskRow(t)}</Fragment>
        ))}
      </div>
    )
  }

  return (
    <div className="content-inner">
      <div className="row" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'nowrap' }}>
        <Button size="small" onClick={() => (month === 1 ? (setMonth(12), setYear(year - 1)) : setMonth(month - 1))}>
          ‹
        </Button>
        <b style={{ minWidth: 108, textAlign: 'center' }}>
          {year} 年 {month} 月
        </b>
        <Button size="small" onClick={() => (month === 12 ? (setMonth(1), setYear(year + 1)) : setMonth(month + 1))}>
          ›
        </Button>
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            const d = new Date()
            setYear(d.getFullYear())
            setMonth(d.getMonth() + 1)
          }}
        >
          回到今天
        </Button>

        <div style={{ width: 190 }}>
          <SelectInput
            value={plantFilter}
            onChange={setPlantFilter}
            options={[{ value: '', label: '全部植株' }, ...plants.map((p) => ({ value: String(p.id), label: p.label }))]}
          />
        </div>
        <span className="spacer" />
        <Button size="small" onClick={() => setShowRules(true)}>
          规则库（{overview?.rules ?? 0}）
        </Button>
        <Button size="small" onClick={() => void generate()}>
          生成 / 更新计划
        </Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          ＋ 新增任务
        </Button>
      </div>

      <Panel>
        <div className="row" style={{ marginBottom: 4 }}>
          <Badge tone="safety">逾期 {overview?.overdue ?? 0}</Badge>
          <Badge tone="warn">该做 {overview?.due ?? 0}</Badge>
          <Badge tone="ok">本年已完成 {overview?.done ?? 0}</Badge>
          <Badge tone="muted">本年待办 {overview?.pending ?? 0}</Badge>
          <span className="spacer" />
          <span className="small muted">
            本月 {monthSummary.total} 项 · 完成 {monthSummary.done} · 待办 {monthSummary.pending}
          </span>
        </div>

        <div className="row tight" style={{ marginTop: 8 }}>
          <Button size="small" variant={tab === 'todo' ? 'primary' : 'ghost'} onClick={() => setTab('todo')}>
            待办
          </Button>
          <Button size="small" variant={tab === 'calendar' ? 'primary' : 'ghost'} onClick={() => setTab('calendar')}>
            月历
          </Button>
          <Button size="small" variant={tab === 'logs' ? 'primary' : 'ghost'} onClick={() => setTab('logs')}>
            养护日志（{logs.length}）
          </Button>
        </div>
      </Panel>

      {overview && overview.plantsWithoutTasks > 0 ? (
        <Panel flat>
          <Notice tone="info">
            还有 <b>{overview.plantsWithoutTasks}</b> 株植物没有 {year} 年的计划。
            点右上角「生成 / 更新计划」，会按规则库和每株的物种自动排出全年该做的事。
            <b>已打过勾的任务不会被覆盖。</b>
          </Notice>
        </Panel>
      ) : null}

      {/*
        物候阶段。它是「观察到的状态」而不是月份 —— 同一个月里，
        南阳台的可能已经现蕾，北窗台的还没动。所以放在待办页最上面，
        由你看到什么就标什么；标了之后限定阶段的规则会立刻跟着变。
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
          天气预警
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
              阶段决定「什么时候停」：追肥规则限定在生长期时，休眠期就自动不提醒了
            </span>
          }
        >
          植株阶段
        </SectionTitle>
        {plants.length === 0 ? (
          <div className="small muted">还没有植株。</div>
        ) : (
          <div className="phase-list">
            {plants.map((p) => {
              const info = plantPhases[p.id]
              const phase = info?.phase ?? null
              const age = phaseAgeDays(info?.changedAt)
              return (
                <div key={p.id} className="phase-row">
                  <span style={{ flex: 1, minWidth: 0 }}>{p.label}</span>
                  {phase ? (
                    <>
                      <Badge tone="ok">
                        {CARE_PHASE_ICONS[phase]} {CARE_PHASE_LABELS[phase]}
                      </Badge>
                      {/*
                        阶段是人工标记的、不会自动过期。像缓苗期这种临时状态，
                        标完容易忘记改回来 —— 那株植物就会一直不施主肥。
                        把天数摆出来，是提醒你回头重看。
                      */}
                      {age !== null ? (
                        <span
                          className={`small ${age >= 45 ? 'phase-age stale' : 'muted'}`}
                          title={`标记于 ${info?.changedAt?.slice(0, 10) ?? ''}`}
                        >
                          已 {age} 天{age >= 45 ? '，要不要重新看看？' : ''}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <Badge tone="muted">未标记</Badge>
                  )}
                  <Button size="small" onClick={() => setPhaseTarget({ id: p.id, name: p.label })}>
                    {phase ? '改阶段' : '标记'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {loading ? (
        <Panel>
          <Spinner label="加载中…" />
        </Panel>
      ) : tab === 'todo' ? (
        <Panel>
          <SectionTitle right={<span className="small muted">{plants.length} 株植物</span>}>
            {year} 年 {month} 月
          </SectionTitle>
          {groups.overdue.length === 0 &&
          groups.due.length === 0 &&
          groups.soon.length === 0 &&
          groups.later.length === 0 &&
          groups.closed.length === 0 ? (
            <EmptyState
              icon="🗓"
              title="这个月还没有安排"
              hint={
                overview && overview.rules > 0
                  ? '点「生成 / 更新计划」，按规则库自动排出这个月该做的事；也可以自己加一条。'
                  : '规则库还是空的，先到「规则库」里加几条，或者直接手动加任务。'
              }
              action={
                <Button variant="primary" onClick={() => void generate()}>
                  生成计划
                </Button>
              }
            />
          ) : (
            <>
              {taskGroup('已过期', groups.overdue, 'safety')}
              {taskGroup('该做了', groups.due, 'warn')}
              {taskGroup('快到了', groups.soon)}
              {taskGroup('这个月晚些', groups.later)}
              {taskGroup('已完成 / 已跳过', groups.closed)}
            </>
          )}
        </Panel>
      ) : tab === 'calendar' ? (
        <Panel>
          <SectionTitle right={<span className="small muted">点任务可跳到待办列表处理</span>}>
            {year} 年 {month} 月
          </SectionTitle>
          <CareCalendar
            year={year}
            month={month}
            tasks={tasks}
            onPickTask={(t) => {
              // 跳到待办并高亮：月历负责「看清节奏」，处理动作回到列表
              setTab('todo')
              setHighlight(t.id)
            }}
            onPickDay={(date) => {
              setEditing('new')
              setDraftDate(date)
            }}
          />
        </Panel>
      ) : (
        <Panel>
          <SectionTitle>养护日志</SectionTitle>
          {logs.length === 0 ? (
            {/*
              原来这句写的是「也可以随时手动记一笔」—— 可界面上**没有那个入口**
              （care:log.add 通道有实现、preload 也暴露了，就是没人接）。
              邀请用户做一件做不到的事，比不说更糟。
              接线是更好的修法，在接上之前先把这句去掉。
            */}
            <EmptyState icon="📓" title="还没有记录" hint="完成任务时会自动写一条日志。" />
          ) : (
            <div className="log-timeline">
              {logs.map((log) => {
                const plant = plants.find((p) => p.id === log.plantId)
                return (
                  <div key={log.id} className="log-item">
                    <div className="log-date">{log.logDate}</div>
                    <div style={{ flex: 1 }}>
                      <div>
                        <Badge tone="info">
                          {log.kind === 'phase' ? '🌿 阶段' : (CARE_ACTION_LABELS[log.kind as 'water'] ?? log.kind)}
                        </Badge>
                        {plant ? <span className="small muted">{plant.label}</span> : null}
                      </div>
                      {log.content ? <div className="small">{log.content}</div> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>
      )}

      {editing ? (
        <CareTaskDialog
          task={editing === 'new' ? null : editing}
          plants={plants}
          defaultDate={draftDate ?? `${year}-${String(month).padStart(2, '0')}-01`}
          onClose={() => {
            setEditing(null)
            setDraftDate(undefined)
          }}
          onSaved={() => {
            setEditing(null)
            setDraftDate(undefined)
            setHighlight(null)
            void reload()
          }}
        />
      ) : null}

      {showRules ? <CareRuleManager speciesNames={speciesNames} onClose={() => setShowRules(false)} /> : null}

      {phaseTarget ? (
        <Modal
          title={`标记阶段 · ${phaseTarget.name}`}
          onClose={() => {
            setPhaseTarget(null)
            setPhaseNote('')
          }}
          footer={
            <>
              <span className="spacer" />
              <Button
                onClick={() => {
                  setPhaseTarget(null)
                  setPhaseNote('')
                }}
              >
                取消
              </Button>
            </>
          }
        >
          <div className="content-inner">
            <Notice tone="info">
              阶段是<b>你观察到的状态</b>，不是从日期推算的 —— 同一个月里，
              南阳台的可能已经现蕾，北窗台的还没动。标记之后，
              限定阶段的规则会立刻跟着生效或停止。
            </Notice>
            {phaseAgeDays(plantPhases[phaseTarget.id]?.changedAt) !== null ? (
              <Notice tone="warn">
                当前标记是 <b>{CARE_PHASE_ICONS[plantPhases[phaseTarget.id]?.phase as CarePhase]}</b>
                <b>{CARE_PHASE_LABELS[plantPhases[phaseTarget.id]?.phase as CarePhase]}</b>，
                已经 <b>{phaseAgeDays(plantPhases[phaseTarget.id]?.changedAt)}</b> 天了。
                阶段不会自己过期 —— 如果植株的状态已经变了，记得在这里改过来。
              </Notice>
            ) : null}
            <Field label="记一句（会写进养护日志，可留空）">
              <TextInput value={phaseNote} onChange={setPhaseNote} placeholder="例如：看到花苞了" />
            </Field>
            <div className="phase-choices">
              {CARE_PHASE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`phase-choice${plantPhases[phaseTarget.id]?.phase === opt.value ? ' on' : ''}`}
                  onClick={() => void applyPhase(phaseTarget.id, opt.value as CarePhase)}
                >
                  <b>
                    {CARE_PHASE_ICONS[opt.value as CarePhase]} {CARE_PHASE_LABELS[opt.value as CarePhase]}
                  </b>
                  <span className="small muted">{CARE_PHASE_HINTS[opt.value as CarePhase]}</span>
                </button>
              ))}
            </div>
            {plantPhases[phaseTarget.id]?.phase ? (
              <div className="row" style={{ marginTop: 10 }}>
                <Button onClick={() => void applyPhase(phaseTarget.id, null)}>清除阶段标记</Button>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {/* 动作类型图例：让图标不至于全靠猜 */}
      <div className="small muted" style={{ marginTop: 10 }}>
        图例：
        {CARE_ACTION_OPTIONS.map((o) => (
          <span key={o.value} style={{ marginLeft: 8 }}>
            {o.label}
          </span>
        ))}
      </div>
    </div>
  )
}
