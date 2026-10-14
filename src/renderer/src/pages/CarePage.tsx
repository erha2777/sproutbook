/**
 * 养护计划页。
 *
 * 信息组织上做了一个选择：**先按紧急度，再按月份**。
 * 纯粹的月历很好看，但「上个月忘做的事」会被翻页翻掉——
 * 而那恰恰是最需要被提醒的。所以逾期任务永远置顶，
 * 月份只用来筛选「这个月原本要做什么」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog, CareTask } from '@core/types'
import type { CareOverview, CareTaskListItem } from '@shared/api'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  CARE_URGENCY_LABELS,
  dueDescription,
  summarizeTasks,
  todayIso,
  urgencyOf
} from '@core/care'
import type { CareUrgency } from '@core/care'
import { Badge, Button, EmptyState, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareRuleManager } from '../components/CareRuleManager'

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

export function CarePage(): ReactNode {
  const toast = useToast()
  const today = todayIso()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [plantFilter, setPlantFilter] = useState('')
  const [tab, setTab] = useState<'todo' | 'logs'>('todo')
  const [tasks, setTasks] = useState<CareTaskListItem[]>([])
  const [overdue, setOverdue] = useState<CareTaskListItem[]>([])
  const [overview, setOverview] = useState<CareOverview | null>(null)
  const [logs, setLogs] = useState<CareLog[]>([])
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [speciesNames, setSpeciesNames] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<CareTask | 'new' | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [noteText, setNoteText] = useState('')

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const plantId = plantFilter ? Number(plantFilter) : undefined
      const [monthTasks, allOpen, ov, logList, plantList, speciesList] = await Promise.all([
        window.api.care.tasks({ from: bounds.from, to: bounds.to, plantId }),
        window.api.care.tasks({ status: 'open', plantId }),
        window.api.care.overview(year),
        window.api.care.logs(plantId, 100),
        window.api.plants.list({ limit: 500 }),
        window.api.species.list({ limit: 500 })
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
    } catch (error) {
      toast.push(`加载养护计划失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [bounds.from, bounds.to, plantFilter, year, today, toast])

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
    return {
      overdue,
      due: byUrgency('due'),
      soon: byUrgency('soon'),
      later: byUrgency('later'),
      closed: tasks.filter(isDone)
    }
  }, [tasks, overdue, overdueSet, today])

  const monthSummary = summarizeTasks(tasks, today)

  const TaskRow = ({ task }: { task: CareTaskListItem }): ReactNode => {
    const urgency = urgencyOf(task, today)
    const closed = task.status !== 'pending'
    return (
      <div className="task-row">
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
          {task.completedNote ? <div className="small muted">备注：{task.completedNote}</div> : null}

          {noteFor === task.id ? (
            <div className="row tight" style={{ marginTop: 6 }}>
              <div style={{ flex: 1 }}>
                <TextInput value={noteText} onChange={setNoteText} placeholder="记一句当时的情况（可留空）" />
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

  const Group = ({ title, list, tone }: { title: string; list: CareTaskListItem[]; tone?: string }): ReactNode => {
    if (list.length === 0) return null
    return (
      <div style={{ marginBottom: 14 }}>
        <div className="section-title">
          {title}
          {tone ? <Badge tone={tone as 'safety'}>{list.length}</Badge> : <span className="small muted">{list.length} 项</span>}
        </div>
        {list.map((t) => (
          <TaskRow key={t.id} task={t} />
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
              <Group title="已过期" list={groups.overdue} tone="safety" />
              <Group title="该做了" list={groups.due} tone="warn" />
              <Group title="快到了" list={groups.soon} />
              <Group title="这个月晚些" list={groups.later} />
              <Group title="已完成 / 已跳过" list={groups.closed} />
            </>
          )}
        </Panel>
      ) : (
        <Panel>
          <SectionTitle>养护日志</SectionTitle>
          {logs.length === 0 ? (
            <EmptyState icon="📓" title="还没有记录" hint="完成任务时会自动写一条日志；也可以随时手动记一笔。" />
          ) : (
            <div className="log-timeline">
              {logs.map((log) => {
                const plant = plants.find((p) => p.id === log.plantId)
                return (
                  <div key={log.id} className="log-item">
                    <div className="log-date">{log.logDate}</div>
                    <div style={{ flex: 1 }}>
                      <div>
                        <Badge tone="info">{CARE_ACTION_LABELS[log.kind as 'water'] ?? log.kind}</Badge>
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
          defaultDate={`${year}-${String(month).padStart(2, '0')}-01`}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : null}

      {showRules ? <CareRuleManager speciesNames={speciesNames} onClose={() => setShowRules(false)} /> : null}

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
