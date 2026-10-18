/**
 * 养护计划页。
 *
 * 信息组织上做了一个选择：**先按紧急度，再按月份**。
 * 纯粹的月历很好看，但「上个月忘做的事」会被翻页翻掉——
 * 而那恰恰是最需要被提醒的。所以逾期任务永远置顶，
 * 月份只用来筛选「这个月原本要做什么」。
 *
 * 1.8.0 起「当天待办」和「天气预警」搬到了独立的「今日」页：
 * 这一页负责**整月与全年**的计划视图，今日页负责**今天**该做什么。
 * 两块数据同源（care:tasks），只是口径不同。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog, CareTask, Material, RecipeListItem } from '@core/types'
import type { CareOverview, CareTaskListItem } from '@shared/api'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  dueDescription,
  logKindLabel,
  summarizeTasks,
  todayIso,
  urgencyOf
} from '@core/care'
import type { CareUrgency } from '@core/care'
import { Badge, Button, EmptyState, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareRuleManager } from '../components/CareRuleManager'
import { CareCalendar } from '../components/CareCalendar'
import { CareTaskRow, TaskGroup } from '../components/CareTaskRow'

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
  /** 手动记一笔：选了哪株、写了什么 */
  const [logPlantId, setLogPlantId] = useState('')
  const [logDraft, setLogDraft] = useState('')
  /** 手动记一笔时的类型。原来固定落成 'note'，用户没得选 —— 也就带不上标签 */
  const [logKind, setLogKind] = useState('note')
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [speciesNames, setSpeciesNames] = useState<string[]>([])
  /** 任务上要显示绑定的配方，所以把配方与材料一起取回来（都是几十条量级） */
  const [recipes, setRecipes] = useState<RecipeListItem[] | null>(null)
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<CareTask | 'new' | null>(null)
  const [showRules, setShowRules] = useState(false)
  /** 从月历点进来的任务：滚动并高亮一下，否则用户不知道跳到了哪里 */
  const [highlight, setHighlight] = useState<number | null>(null)
  /** 任务行 DOM，用来把高亮的那条滚进视野 */
  const taskRefs = useRef(new Map<number, HTMLDivElement>())
  /**
   * 统计数字的筛选。
   *
   * 这四个数字原来只是 Badge —— 点不动，用户没法从「逾期 0」走到对应的列表。
   * 现在点一下就地筛出那批任务。
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
  /** 从月历空白日点「＋」新增任务时的预设日期 */
  const [draftDate, setDraftDate] = useState<string | undefined>(undefined)

  /** 正在看的是不是今天所在的月份。只影响「回到今天」按钮的状态 */
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  /**
   * 手动记一笔养护日志。
   *
   * care:log.add 这个通道一直存在、preload 也暴露了，**就是界面没接** ——
   * 而日志空态原本还写着「也可以随时手动记一笔」。
   * **邀请用户做一件做不到的事，比不说更糟。** 与其删那句话，不如把路接上。
   */
  const addManualLog = async (): Promise<void> => {
    const plantId = logPlantId ? Number(logPlantId) : null
    const content = logDraft.trim()
    if (plantId === null || !content) {
      toast.push('先选一株植物，再写一句做了什么', 'error')
      return
    }
    try {
      await window.api.care.addLog({ plantId, content, kind: logKind })
      setLogDraft('')
      setLogs(await window.api.care.logs(logPlantId ? plantId : undefined, 100))
      toast.push('已记一笔', 'success')
    } catch (error) {
      toast.push(`记录失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  /**
   * 切换植株时重新拉日志。
   *
   * 原来只有 `addManualLog` 里调 `setLogs` —— 也就是说**下拉框换了植株，
   * 列表纹丝不动**，用户看到的就是「切换没用」。
   * 加载逻辑收到这里，记完一笔也会自动跟着走。
   */
  useEffect(() => {
    let alive = true
    void window.api.care
      .logs(logPlantId ? Number(logPlantId) : undefined, 100)
      .then((rows) => {
        if (alive) setLogs(rows)
      })
      .catch(() => {
        // 日志取不到不该让整页报错，空列表 + 上面的加载失败提示已经够了
        if (alive) setLogs([])
      })
    return () => {
      alive = false
    }
  }, [logPlantId])

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
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '操作失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

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

  /**
   * 删除一条养护日志。
   *
   * 日志删了就没了（不像任务还能重新生成），所以**要确认**。
   * 完成后自动写入的日志同样可删 —— 误操作留下的记录也在这里清。
   */
  const removeLog = async (log: CareLog): Promise<void> => {
    const what = log.content ? `「${log.content}」` : `这条${log.logDate}的记录`
    if (!window.confirm(`确定删除养护日志 ${what} 吗？删除后无法恢复。`)) return
    try {
      const ok = await window.api.care.removeLog(log.id)
      if (!ok) {
        // 影响 0 行 = 这条已经不在了，如实说，不报「已删除」
        toast.push('这条日志已经不在了，可能已在别处删过', 'error')
      } else {
        toast.push('已删除', 'success')
      }
      await reload()
    } catch (error) {
      toast.push(`删除失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
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
  const isDone = (t: CareTaskListItem): boolean => t.status !== 'pending'
  const overdueSet = new Set(overdue.map((t) => t.id))
  const groups = useMemo(() => {
    const pending = tasks.filter((t) => !isDone(t) && !overdueSet.has(t.id))
    const byUrgency = (u: CareUrgency): CareTaskListItem[] =>
      pending.filter((t) => urgencyOf(t, today) === u).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const due = byUrgency('due')
    const soon = byUrgency('soon')
    const later = byUrgency('later')
    return {
      overdue,
      due,
      soon,
      later,
      /** 全部未完成（含逾期）—— 「本年待办 N」点进去看的就是这一批 */
      open: [...overdue, ...due, ...soon, ...later],
      closed: tasks.filter(isDone)
    }
  }, [tasks, overdue, overdueSet, today])

  const monthSummary = summarizeTasks(tasks, today)

  /**
   * **全年**口径的分组。
   *
   * 上面那四个统计数字本来就是全年的（careOverview 查的是 01-01~12-31），
   * 而 groups 基于当月任务 —— 直接拿 groups 去「查看」全年数字，
   * 会出现写着 24、点进去只有 10 的情况。
   *
   * 所以筛选走这一份：数字和列表同源。
   */
  const yearGroups = useMemo(() => {
    const list = overview?.yearTasks ?? []
    const open = list.filter((t) => t.status === 'pending')
    const byUrgency = (u: CareUrgency): CareTaskListItem[] =>
      open.filter((t) => urgencyOf(t, today) === u).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    return {
      overdue: byUrgency('overdue'),
      due: byUrgency('due'),
      /*
       * 「本年已完成」要**只数 status='done'**，不能连 skipped 一起算。
       *
       * summarizeTasks 里 done 和 skipped 是分开的两个计数，
       * 而任务列表按「已完成 / 已跳过」合并分组 —— 照抄那个习惯，
       * 徽章上的数字就会比原来多出「已跳过」那几个，
       * 用户看到「已完成 10」而库里只有 7 条 done，会以为数据错了。
       * 口径以统计为准，列表标题也跟着分开写。
       */
      completed: list.filter((t) => t.status === 'done'),
      open
    }
  }, [overview, today])

  /** 统计弹窗要显示的那批任务（全年口径，和徽章数字同源） */
  const statRows: CareTaskListItem[] = !statFilter
    ? []
    : statFilter === 'overdue'
      ? yearGroups.overdue
      : statFilter === 'due'
        ? yearGroups.due
        : statFilter === 'done'
          ? yearGroups.completed
          : yearGroups.open

  /**
   * 任务行。
   *
   * 行本身在 components/CareTaskRow —— 今日页也要用同一份。
   * 这里只把页面状态接上去：高亮（从月历跳过来）、忙态、写完刷新。
   */
  const renderRow = (t: CareTaskListItem): ReactNode => (
    <CareTaskRow
      key={t.id}
      task={t}
      today={today}
      busy={busyId === t.id}
      highlighted={highlight === t.id}
      recipes={recipes}
      materials={materials}
      registerRef={(el) => {
        if (el) taskRefs.current.set(t.id, el)
        else taskRefs.current.delete(t.id)
      }}
      onComplete={(task, note) => void act(task.id, 'complete', note)}
      onSkip={(task) => void act(task.id, 'skip')}
      onReopen={(task) => void act(task.id, 'reopen')}
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
          }}
        >
          {isCurrentMonth ? '已是今天' : '回到今天'}
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
            这四个原来是纯 Badge —— 点不动，用户没法从「逾期 0」走到对应列表。
            现在点一下就筛出那批任务（**全年口径**，和数字同源）。

            数字改用 yearGroups 而不是 overview：两者一致，但 yearGroups 是
            从实际列表算出来的，筛选结果和显示数字永远对得上。
          */}
          {(
            [
              { key: 'overdue', label: '逾期', n: yearGroups.overdue.length, tone: 'safety', on: '#8a3a30' },
              { key: 'due', label: '该做', n: yearGroups.due.length, tone: 'warn', on: '#9a6410' },
              { key: 'done', label: '本年已完成', n: yearGroups.completed.length, tone: 'ok', on: '#3f7a2a' },
              { key: 'open', label: '本年待办', n: yearGroups.open.length, tone: 'muted', on: '#6b5a3a' }
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
                title={`查看${item.label}的任务（全年）`}
                onClick={() => setStatFilter(on ? null : item.key)}
              >
                {item.label} {item.n}
              </button>
            )
          })}
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
              <TaskGroup title="已过期" count={groups.overdue.length} tone="safety">
                {groups.overdue.map(renderRow)}
              </TaskGroup>
              <TaskGroup title="该做了" count={groups.due.length} tone="warn">
                {groups.due.map(renderRow)}
              </TaskGroup>
              <TaskGroup title="快到了" count={groups.soon.length}>
                {groups.soon.map(renderRow)}
              </TaskGroup>
              <TaskGroup title="这个月晚些" count={groups.later.length}>
                {groups.later.map(renderRow)}
              </TaskGroup>
              <TaskGroup title="已完成 / 已跳过" count={groups.closed.length}>
                {groups.closed.map(renderRow)}
              </TaskGroup>
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
          {/* 手动记一笔。原来空态写着「也可以随时手动记一笔」却没有入口，现在真给了。 */}
          <div className="row tight" style={{ marginBottom: 8 }}>
            <div style={{ width: 180 }}>
              <SelectInput
                value={logPlantId}
                onChange={setLogPlantId}
                placeholder="选一株植物…"
                options={plants.map((pl) => ({ value: String(pl.id), label: pl.label }))}
              />
            </div>
            <div style={{ width: 140 }}>
              {/* 类型可选：手动记的也能带上「浇水 / 施肥 / 观察记录」这类标签 */}
              <SelectInput
                value={logKind}
                onChange={setLogKind}
                options={[
                  ...CARE_ACTION_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
                  // 'note' 不是动作类型（CareActionType 里没有它），但它确实是日志的 kind
                  { value: 'note', label: '📝 记录' }
                ]}
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextInput
                value={logDraft}
                onChange={setLogDraft}
                placeholder="记一句做了什么，例如「换了盆，土是泥炭 5 : 珍珠岩 3」"
              />
            </div>
            <Button onClick={() => void addManualLog()} disabled={!logPlantId || !logDraft.trim()}>
              记一笔
            </Button>
          </div>
          {logs.length === 0 ? (
            <EmptyState icon="📓" title="还没有记录" hint="完成任务时会自动写一条日志；也可以在上面手动记一笔。" />
          ) : (
            <div className="log-timeline">
              {logs.map((log) => {
                const plant = plants.find((p) => p.id === log.plantId)
                return (
                  <div key={log.id} className="log-item">
                    <div className="log-date">{log.logDate}</div>
                    <div style={{ flex: 1 }}>
                      <div>
                        {/*
                          走 logKindLabel 而不是 CARE_ACTION_LABELS[kind] ?? kind ——
                          后者在遇到 'note'（后端没给 kind 时的默认值）时
                          **会把英文键名直接显示出来**，用户截图里的 note 就是这么来的。
                        */}
                        <Badge tone="info">{logKindLabel(log.kind)}</Badge>
                        {plant ? <span className="small muted">{plant.label}</span> : null}
                      </div>
                      {log.content ? <div className="small">{log.content}</div> : null}
                    </div>
                    {/*
                      删除按钮：不用 ghost —— ghost 无背景无边框，
                      在浅米色的日志行上「删除」两个字太淡了，看不见。
                      外面包一层是为了让它垂直居中（.log-item 是 align-items:flex-start）
                    */}
                    <div style={{ alignSelf: 'center' }}>
                      <Button size="small" title="删除这条日志（不可恢复）" onClick={() => void removeLog(log)}>
                        删除
                      </Button>
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

      {/*
        统计弹窗。
        用户的要求：这四个数字用弹窗看，不要改动主列表。

        内容走的是 **往年全年** 口径（那四个数字本来就是全年的），
        所以标题里把范围和条数都写出来，免得和下面的当月列表混淆。
      */}
      {statFilter ? (
        <Modal
          title={`${year} 年 · ${STAT_FILTER_TITLES[statFilter]}`}
          onClose={() => setStatFilter(null)}
          headerExtra={<span className="small muted">共 {statRows.length} 项（全年）</span>}
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
