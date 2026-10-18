/**
 * 养护计划页。
 *
 * 这一页只做两件事：**看这个月的节奏**，和**看某一天安排了什么**。
 *
 * 演变过程（别改回去）：
 * - 1.8.0 把「当天待办 + 天气预警」拆到「今日」页
 * - 1.8.2 把执行动作（完成 / 跳过）收口到今日页，这一页只留查看 / 编辑 / 删除
 * - 1.8.3 撤掉「全部待办」列表：它与月历重复，而且跨月长列表反而看不清
 *   这个月发生了什么。改成**点月历里的某一天，下面列出当天的全部计划**。
 *   养护日志也搬出去成了独立页面。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareTask, Material, RecipeListItem } from '@core/types'
import type { CareOverview, CareTaskListItem } from '@shared/api'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  dueDescription,
  pendingBuckets,
  summarizeTasks,
  todayIso,
  weekdayLabel
} from '@core/care'
import { Badge, Button, EmptyState, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareRuleManager } from '../components/CareRuleManager'
import { CareCalendar } from '../components/CareCalendar'
import { CareTaskRow } from '../components/CareTaskRow'

/** 四个统计筛选的标题。列表面板和空态提示共用，免得两处各写一份。 */
const STAT_FILTER_TITLES: Record<'overdue' | 'due' | 'done' | 'open', string> = {
  overdue: '已过期',
  due: '该做了',
  done: '已完成',
  open: '未完成'
}

/**
 * 任务状态的标记文案与配色。
 *
 * 清理弹窗里**每一条都要带上**：删掉一段范围时用户必须一眼看清
 * 自己要删的是待办还是做过的记录 —— 后者不可逆。
 */
const TASK_STATUS_TAG: Record<'pending' | 'done' | 'skipped', { label: string; tone: 'muted' | 'ok' | 'warn' }> = {
  pending: { label: '待办', tone: 'muted' },
  done: { label: '已完成', tone: 'ok' },
  skipped: { label: '已跳过', tone: 'warn' }
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const last = new Date(year, month, 0).getDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

export function CarePage({
  onCareChanged,
  onGoGarden
}: {
  onCareChanged?: () => void
  /** 去「我的花园」—— 生成计划已经挪到那一株身上了 */
  onGoGarden?: () => void
}): ReactNode {
  const toast = useToast()
  const today = todayIso()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [plantFilter, setPlantFilter] = useState('')
  /** 当月任务：月历和「当天计划」都用这一份 */
  const [tasks, setTasks] = useState<CareTaskListItem[]>([])
  /** 全部未完成任务：统计徽章用这一份，口径与今日页一致 */
  const [allOpen, setAllOpen] = useState<CareTaskListItem[]>([])
  const [overview, setOverview] = useState<CareOverview | null>(null)
  /**
   * 月历里选中了哪一天。
   *
   * 默认选中今天 —— 打开就能看到「今天安排了什么」；
   * 翻到别的月份时清空（那一天不在这个月里，硬留着只会显示错的东西）。
   */
  const [day, setDay] = useState<string | null>(today)
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [speciesNames, setSpeciesNames] = useState<string[]>([])
  /** 任务上要显示绑定的配方，所以把配方与材料一起取回来（都是几十条量级） */
  const [recipes, setRecipes] = useState<RecipeListItem[] | null>(null)
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<CareTask | 'new' | null>(null)
  const [showRules, setShowRules] = useState(false)
  /** 从月历点进来的任务：滚动并高亮一下，否则用户不知道点中了哪一条 */
  const [highlight, setHighlight] = useState<number | null>(null)
  /** 任务行 DOM，用来把高亮的那条滚进视野 */
  const taskRefs = useRef(new Map<number, HTMLDivElement>())
  /**
   * 统计数字的筛选。
   *
   * 这几个数字原来只是 Badge —— 点不动，用户没法从「逾期 0」走到对应的任务。
   * 现在点一下弹窗列出那批任务。
   */
  const [statFilter, setStatFilter] = useState<'overdue' | 'due' | 'done' | 'open' | null>(null)
  /**
   * 清理计划。
   *
   * 生成计划是**按年**的，误点一下就排出整年 —— 用户不小心生成了下一年之后
   * 只能一条条删（135 条根本删不动）。所以给一个批量出口。
   *
   * 只删待办：已完成 / 已跳过是做过的记录，清理「计划」不该抹掉历史。
   */
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeYear, setPurgeYear] = useState(now.getFullYear())
  /** null = 整年；1~12 = 只看那个月 */
  const [purgeMonth, setPurgeMonth] = useState<number | null>(null)
  const [purgeTasks, setPurgeTasks] = useState<CareTaskListItem[]>([])
  const [purgeLoading, setPurgeLoading] = useState(false)
  const [purgeBusy, setPurgeBusy] = useState(false)
  /** 新增任务时的预设日期（默认跟随选中的那天） */
  const [draftDate, setDraftDate] = useState<string | undefined>(undefined)

  /** 正在看的是不是今天所在的月份。只影响「回到今天」按钮的状态 */
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  /** 选中的那天真的属于当前显示的月份吗（翻月后旧选择要作废） */
  const dayInMonth =
    day !== null && day.startsWith(`${year}-${String(month).padStart(2, '0')}-`) ? day : null

  /** 当天的全部计划：待办 / 已完成 / 已跳过都在里面 —— 「当天所有计划」 */
  const dayTasks = useMemo(
    () => (dayInMonth ? tasks.filter((t) => t.dueDate === dayInMonth) : []),
    [tasks, dayInMonth]
  )

  /** 翻月：清掉日期选择，免得显示上个月的那一天 */
  const shiftMonth = (delta: number): void => {
    const next = new Date(year, month - 1 + delta, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth() + 1)
    setDay(null)
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const plantId = plantFilter ? Number(plantFilter) : undefined
      const [monthTasks, allOpen, ov, plantList, speciesList, recipeList, materialList] = await Promise.all([
        window.api.care.tasks({ from: bounds.from, to: bounds.to, plantId }),
        window.api.care.tasks({ status: 'open', plantId }),
        window.api.care.overview(year),
        window.api.plants.list({ limit: 500 }),
        window.api.species.list({ limit: 500 }),
        /*
         * 任务卡片要显示绑定的配方，所以一起取。
         *
         * **失败时给 null，不要给 []** —— 空数组会让 TaskRecipe 断言
         * 「配方已删除」，用户就会去重建一份其实还在的配方。
         * 而且 .catch 吞在最内层时 Promise.all 不会 reject，
         * 外层 catch 不触发，连一句报错都没有，页面看起来完全正常。
         */
        window.api.recipes.list().catch(() => null),
        window.api.materials.list().catch(() => null)
      ])
      setTasks(monthTasks)
      /*
       * 逾期任务可能落在任意更早的月份，也有时间窗已开、到期日在下个月的任务 ——
       * 所以「全部未完成」必须单独取，不能从当月任务里筛。
       */
      setAllOpen(allOpen)
      setOverview(ov)
      setPlants(
        plantList.items.map((p) => ({
          id: p.id,
          label: `${p.nickname}${p.species ? `（${p.species.commonName}）` : ''}`
        }))
      )
      setSpeciesNames(speciesList.items.map((s) => s.commonName))
      // 配方取不到不该让整页报错（用户可能一个配方都没有）
      setRecipes(recipeList)
      setMaterials(materialList)
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

  /*
   * 这里原来有 generate()（一键为所有植株排全年）和 act()（完成 / 跳过 / 撤销）。
   *
   * - 生成挪到「我的花园」里**按株**生成：这株刚加进来、这株改了阶段，
   *   都是这一株自己的事，没理由顺手把别人全排一遍。
   * - 完成 / 跳过挪到「今日」页：执行动作只留一个入口，这一页只管看和改。
   */

  /**
   * 打开「清理计划」：把那一年的任务全取回来，之后筛选都在本地做（数据量很小）。
   */
  const openPurge = async (): Promise<void> => {
    setPurgeOpen(true)
    setPurgeMonth(null)
    setPurgeLoading(true)
    try {
      const ov = await window.api.care.overview(purgeYear)
      setPurgeTasks(ov.yearTasks)
    } catch (error) {
      toast.push(`读取 ${purgeYear} 年任务失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
      setPurgeTasks([])
    } finally {
      setPurgeLoading(false)
    }
  }

  const switchPurgeYear = async (nextYear: number): Promise<void> => {
    setPurgeYear(nextYear)
    setPurgeLoading(true)
    try {
      const ov = await window.api.care.overview(nextYear)
      setPurgeTasks(ov.yearTasks)
    } catch {
      setPurgeTasks([])
    } finally {
      setPurgeLoading(false)
    }
  }

  /** 会被删掉的那批：范围内的**全部**状态（待办 / 已完成 / 已跳过都要能删） */
  const purgeTargets = useMemo(() => {
    const prefix = purgeMonth === null ? `${purgeYear}-` : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-`
    return purgeTasks.filter((t) => t.dueDate.startsWith(prefix))
  }, [purgeTasks, purgeYear, purgeMonth])

  /** 按状态分组计数 —— 确认前要把「删掉几条做过的记录」摆到明面上 */
  const purgeCounts = useMemo(() => {
    const c = { pending: 0, done: 0, skipped: 0 }
    for (const t of purgeTargets) c[t.status]++
    return c
  }, [purgeTargets])

  const runPurge = async (): Promise<void> => {
    if (purgeTargets.length === 0) return
    const scope = purgeMonth === null ? `${purgeYear} 年全年` : `${purgeYear} 年 ${purgeMonth} 月`
    setPurgeBusy(true)
    try {
      const from = purgeMonth === null ? `${purgeYear}-01-01` : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-01`
      const lastDay = new Date(purgeYear, purgeMonth ?? 12, 0).getDate()
      const to =
        purgeMonth === null
          ? `${purgeYear}-12-31`
          : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      const r = await window.api.care.purgeTasks({ from, to })
      // 各状态分开报：删了几条做过的记录是要说清楚的
      const parts = (['pending', 'done', 'skipped'] as const)
        .filter((s) => r.byStatus[s] > 0)
        .map((s) => `${TASK_STATUS_TAG[s].label} ${r.byStatus[s]} 条`)
      toast.push(
        `已从${scope}删除 ${r.deleted} 条任务${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}。养护日志不受影响，仍然保留`,
        'success'
      )
      setPurgeOpen(false)
      await reload()
    } catch (error) {
      toast.push(`清理失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setPurgeBusy(false)
    }
  }

  const removeTask = async (task: CareTaskListItem): Promise<void> => {
    if (!window.confirm(`确定删除任务「${task.title}」吗？`)) return
    try {
      await window.api.care.removeTask(task.id)
      toast.push('已删除', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  // ---- 分组 ----
  /**
   * 全部未完成任务，按紧急度分组。
   *
   * **和今日页同一个函数、同一份数据**（`care:tasks` + `pendingBuckets`）。
   * 之前这一页是「当月任务 + 另外补逾期」，于是同一天会出现
   * 「今日 该做 10 / 养护计划 该做了 6」—— 差的是时间窗已开、
   * 到期日在下个月的那几条。两边各自都算得通，用户看到的就是数字不对。
   */
  const groups = useMemo(() => pendingBuckets(allOpen, today), [allOpen, today])

  /** 全部未完成（含逾期与「已进入时间窗」），统计里的「未完成」用的就是它 */
  const openRows = useMemo(
    () => [...groups.overdue, ...groups.due, ...groups.early, ...groups.soon, ...groups.later],
    [groups]
  )

  /** 选中月份的任务汇总，只在月历上方出现 */
  const monthSummary = summarizeTasks(tasks, today)

  /**
   * 本年已完成。
   *
   * **只数 status='done'**，不连 skipped 一起算 —— 列表按「已完成 / 已跳过」
   * 合并分组的老习惯，会让徽章比库里实际 done 多出几条。
   */
  const completedThisYear = useMemo(
    () => (overview?.yearTasks ?? []).filter((t) => t.status === 'done'),
    [overview]
  )

  /** 统计弹窗要显示的那批任务（和徽章数字同源） */
  const statRows: CareTaskListItem[] = !statFilter
    ? []
    : statFilter === 'overdue'
      ? groups.overdue
      : statFilter === 'due'
        ? groups.due
        : statFilter === 'done'
          ? completedThisYear
          : openRows

  /**
   * 任务行。
   *
   * 行本身在 components/CareTaskRow —— 今日页也要用同一份。
   * 这里给 `manage` 模式：只有查看 / 编辑 / 删除，没有完成和跳过。
   */
  const renderRow = (t: CareTaskListItem): ReactNode => (
    <CareTaskRow
      key={t.id}
      task={t}
      today={today}
      mode="manage"
      highlighted={highlight === t.id}
      recipes={recipes}
      materials={materials}
      registerRef={(el) => {
        if (el) taskRefs.current.set(t.id, el)
        else taskRefs.current.delete(t.id)
      }}
      onEdit={(task) => setEditing(task)}
      onDelete={(task) => void removeTask(task)}
    />
  )

  /**
   * 把高亮的那条任务滚进视野。
   *
   * 原来只加了 `highlighted` 类名，**从来没滚动过** —— 那行如果在视口外，
   * 点完月历里的任务什么都不会发生，看起来像没生效。
   */
  useEffect(() => {
    if (highlight === null) return
    const el = taskRefs.current.get(highlight)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 高亮留一会儿再褪掉，让人来得及看见是哪一条
    const timer = setTimeout(() => setHighlight(null), 2600)
    return () => clearTimeout(timer)
  }, [highlight])

  return (
    <div className="content-inner">
      {/*
        月份导航在月历面板里（这一页就剩月历 + 当天计划）。
        日期选择也不再放在页头：它只影响下面的「当天计划」。
      */}
      <div className="row" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'nowrap' }}>
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
        {/* 误生成整年计划时的出口 —— 135 条没法一条条删 */}
        <Button size="small" onClick={() => void openPurge()}>
          清理计划
        </Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          ＋ 新增任务
        </Button>
      </div>

      <Panel>
        <div className="row" style={{ marginBottom: 4 }}>
          {/*
            四个数字：点一下就筛出那批任务。

            **口径与今日页完全一致**（全部未完成任务 + core 的 pendingBuckets）：
            逾期和该做在两个页面必须是同一个数，否则用户会认为哪边算错了。
            「本年已完成」是唯一按年算的 —— 它本来就属于历史，不参与今日的判断。
          */}
          {(
            [
              { key: 'overdue', label: '逾期', n: groups.overdue.length, tone: 'safety', on: '#8a3a30' },
              { key: 'due', label: '该做', n: groups.due.length, tone: 'warn', on: '#9a6410' },
              { key: 'done', label: '本年已完成', n: completedThisYear.length, tone: 'ok', on: '#3f7a2a' },
              { key: 'open', label: '未完成', n: openRows.length, tone: 'muted', on: '#6b5a3a' }
            ] as const
          ).map((item) => {
            const on = statFilter === item.key
            return (
              <button
                key={item.key}
                type="button"
                className={`pixel-badge ${item.tone} stat-filter${on ? ' on' : ''}`}
                /*
                 * 选中态的底色用**内联样式**：.pixel-badge.safety 之类的 tone 规则
                 * 优先级比 .stat-filter.on 高，写在 CSS 里会被压掉。
                 */
                style={on ? { background: item.on, color: '#fff', borderColor: '#fff' } : undefined}
                title={`查看${item.label}的任务`}
                onClick={() => setStatFilter(on ? null : item.key)}
              >
                {item.label} {item.n}
              </button>
            )
          })}
        </div>
      </Panel>

      {overview && overview.plantsWithoutTasks > 0 ? (
        <Panel flat>
          <Notice tone="info">
            还有 <b>{overview.plantsWithoutTasks}</b> 株植物没有 {year} 年的计划。
            到「我的花园」里选中那株，点「生成计划」就会按规则库排出它全年该做的事。
            <b>已打过勾的任务不会被覆盖。</b>
            {onGoGarden ? (
              <div className="row" style={{ marginTop: 6 }}>
                <Button size="small" onClick={onGoGarden}>
                  去我的花园
                </Button>
              </div>
            ) : null}
          </Notice>
        </Panel>
      ) : null}

      {/*
        这里原来有一整块「植株阶段」列表：每株一行，显示阶段、已标记多少天、改阶段按钮。

        用户反馈它和「我的花园」重复，而且占地方 —— 说得对：
        花园页选中一株就能看到阶段、天数，也能就地改，
        这一块整段都是重复信息，还把任务列表挤到了下面。

        天数没有丢，搬到了花园页那一株的「物候阶段」旁边
        （同一个 phaseAgeDays）。改阶段的入口也还在：花园里点一株即可。

        「改阶段」弹窗保留 —— 那里显示「已经 N 天了」是给**正在做这个决定的人**
        看的，和列表里罗列给所有人看是两回事。
      */}

      {loading ? (
        <Panel>
          <Spinner label="加载中…" />
        </Panel>
      ) : (
        <div className="plan-split">
          <Panel className="plan-calendar">
            <div className="row" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
              <Button size="small" onClick={() => shiftMonth(-1)}>
                ‹
              </Button>
              <b style={{ minWidth: 108, textAlign: 'center' }}>
                {year} 年 {month} 月
              </b>
              <Button size="small" onClick={() => shiftMonth(1)}>
                ›
              </Button>
              {/*
                「回到今天」用**默认实心样式**，不用 ghost。
                ghost 是背景、边框全透明 + 弱化文字，放在这片蓝色画布上几乎看不见
                （用户截图圈出来说「太不显眼」）。它两边都是深色描边的按钮框，
                这个也该是同一档。
              */}
              <Button
                size="small"
                disabled={isCurrentMonth}
                title={isCurrentMonth ? '已经在今天所在的月份了' : '回到今天所在的月份'}
                onClick={() => {
                  const d = new Date()
                  setYear(d.getFullYear())
                  setMonth(d.getMonth() + 1)
                  setDay(today)
                }}
              >
                {isCurrentMonth ? '已是今天' : '回到今天'}
              </Button>
              <span className="spacer" />
              <span className="small muted">
                本月 {monthSummary.total} 项 · 完成 {monthSummary.done} · 待办 {monthSummary.pending}
              </span>
            </div>
            <CareCalendar
              year={year}
              month={month}
              tasks={tasks}
              selectedDate={dayInMonth}
              onPickTask={(t) => {
                // 点任务 = 选中它所在的那一天，并高亮这一条
                setDay(t.dueDate)
                setHighlight(t.id)
              }}
              onPickDay={(date) => setDay(date)}
            />
          </Panel>

          {/*
            当天计划。
            「这个月排了些什么」看月历，「这一天到底要做什么」看这里 ——
            原来那个跨月的「全部待办」列表和月历重复，46 条翻起来也找不到今天。

            放在月历右边而不是下面：点完一天不用滚动就能看到结果。
            窗口窄（约 1000px 以下）时会自动换行堆叠。
          */}
          <Panel className="plan-day">
            <SectionTitle
              right={dayInMonth ? <span className="small muted">共 {dayTasks.length} 项</span> : null}
            >
              {dayInMonth
                ? `${Number(dayInMonth.slice(5, 7))} 月 ${Number(dayInMonth.slice(8))} 日 · ${weekdayLabel(dayInMonth)}`
                : '当天计划'}
            </SectionTitle>
            {!dayInMonth ? (
              <EmptyState
                icon="🗓"
                title="点月历里的某一天"
                hint="那一天安排了什么会列在这里，可以直接查看 / 编辑 / 删除。"
              />
            ) : dayTasks.length === 0 ? (
              <EmptyState
                icon="🌿"
                title="这一天还没有安排"
                hint="可以给这天单独加一条；年度计划到「我的花园」里选中那株生成。"
                action={
                  <Button
                    onClick={() => {
                      setEditing('new')
                      setDraftDate(dayInMonth)
                    }}
                  >
                    给这天加一条
                  </Button>
                }
              />
            ) : (
              <>
                {dayTasks.map(renderRow)}
                <div className="row tight" style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing('new')
                      setDraftDate(dayInMonth)
                    }}
                  >
                    给这天加一条
                  </Button>
                  <span className="small muted">完成与跳过在「今日」页</span>
                </div>
              </>
            )}
          </Panel>
        </div>
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

      {showRules ? (
        <CareRuleManager
          speciesNames={speciesNames}
          onClose={() => setShowRules(false)}
          onChanged={() => void reload()}
        />
      ) : null}

      {/*
        统计弹窗。
        用户的要求：这几个数字用弹窗看，不要改动主列表。

        口径和徽章一致：逾期 / 该做 / 未完成都是**全部未完成**里算出来的，
        只有「本年已完成」按年 —— 所以标题里不再写「YYYY 年」。
      */}
      {statFilter ? (
        <Modal
          title={STAT_FILTER_TITLES[statFilter]}
          onClose={() => setStatFilter(null)}
          headerExtra={<span className="small muted">共 {statRows.length} 项</span>}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setStatFilter(null)}>关闭</Button>
            </>
          }
        >
          {statRows.length === 0 ? (
            <div className="small muted">没有「{STAT_FILTER_TITLES[statFilter]}」的任务。</div>
          ) : (
            statRows.map((t) => (
              <div key={t.id} className="stat-task">
                <div className="row tight" style={{ alignItems: 'center' }}>
                  <span className="task-icon">{CARE_ACTION_ICONS[t.actionType]}</span>
                  <b>{t.title}</b>
                  <Badge tone={t.status === 'done' ? 'ok' : t.status === 'skipped' ? 'muted' : 'warn'}>
                    {t.status === 'done' ? '已完成' : t.status === 'skipped' ? '已跳过' : dueDescription(t, today)}
                  </Badge>
                  {t.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
                </div>
                <div className="small muted">
                  {t.dueDate}
                  {t.plantName ? ` · ${t.plantName}` : ''}
                  {` · ${CARE_ACTION_LABELS[t.actionType]}`}
                </div>
                {t.completedNote ? <div className="small muted">备注：{t.completedNote}</div> : null}
              </div>
            ))
          )}
        </Modal>
      ) : null}

      {/*
        清理计划。

        生成是按年的：误点一下「生成 / 更新计划」就排出整年，
        而删除只能一条一条来。用户误建了 2027 年（135 条）之后没有任何出口。
      */}
      {purgeOpen ? (
        <Modal
          title="清理计划"
          onClose={() => setPurgeOpen(false)}
          headerExtra={
            <span className="small muted">三种状态都能删；养护日志不受影响</span>
          }
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setPurgeOpen(false)}>取消</Button>
              <Button variant="danger" disabled={purgeBusy || purgeTargets.length === 0} onClick={() => void runPurge()}>
                {purgeBusy ? '正在删除…' : `删除这 ${purgeTargets.length} 条`}
              </Button>
            </>
          }
        >
          <div className="row tight" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="small">范围：</span>
            <div style={{ width: 120 }}>
              <SelectInput
                value={String(purgeYear)}
                onChange={(v) => void switchPurgeYear(Number(v))}
                options={[year - 1, year, year + 1, year + 2].map((y) => ({
                  value: String(y),
                  label: `${y} 年`
                }))}
              />
            </div>
            <Button
              size="small"
              variant={purgeMonth === null ? 'primary' : undefined}
              onClick={() => setPurgeMonth(null)}
            >
              全年
            </Button>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <Button
                key={m}
                size="small"
                variant={purgeMonth === m ? 'primary' : undefined}
                onClick={() => setPurgeMonth(m)}
              >
                {m} 月
              </Button>
            ))}
          </div>

          {purgeLoading ? (
            <Spinner label="读取中…" />
          ) : purgeTargets.length === 0 ? (
            <div className="small muted">
              {purgeYear} 年{purgeMonth === null ? '' : ` ${purgeMonth} 月`}没有任务，不需要清理。
            </div>
          ) : (
            <>
              {/*
                按状态汇总，再做逐条预览。
                删掉「已完成」是不可逆的，所以既要总数也要每条的状态标记 ——
                只给一个总数就按下去，用户不知道自己在删什么。
              */}
              <div className="small" style={{ marginBottom: 6 }}>
                下面这 <b>{purgeTargets.length}</b> 条会被删除：
                {(['pending', 'done', 'skipped'] as const)
                  .filter((s) => purgeCounts[s] > 0)
                  .map((s) => (
                    <span key={s} style={{ marginLeft: 8 }}>
                      <Badge tone={TASK_STATUS_TAG[s].tone}>
                        {TASK_STATUS_TAG[s].label} {purgeCounts[s]}
                      </Badge>
                    </span>
                  ))}
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {purgeTargets.slice(0, 200).map((t) => (
                  <div key={t.id} className="stat-task">
                    <div className="row tight" style={{ alignItems: 'center' }}>
                      <span className="task-icon">{CARE_ACTION_ICONS[t.actionType]}</span>
                      <b>{t.title}</b>
                      {/* 每条都带上状态标记：待办 / 已完成 / 已跳过 */}
                      <Badge tone={TASK_STATUS_TAG[t.status].tone}>{TASK_STATUS_TAG[t.status].label}</Badge>
                      {t.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
                    </div>
                    <div className="small muted">
                      {t.dueDate}
                      {t.plantName ? ` · ${t.plantName}` : ''}
                      {` · ${CARE_ACTION_LABELS[t.actionType]}`}
                    </div>
                  </div>
                ))}
                {purgeTargets.length > 200 ? (
                  <div className="small muted">……以及另外 {purgeTargets.length - 200} 条</div>
                ) : null}
              </div>
            </>
          )}
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
