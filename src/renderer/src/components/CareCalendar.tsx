/**
 * 月历网格。
 *
 * 这一页是「月历 + 当天计划」两层：月历回答「这个月哪几天扎堆、哪段空着」，
 * 点某一天之后，下面的「当天计划」回答「这天到底要做什么」。
 *
 * 所以整格都是热区（不只是日期数字），选中态要一眼看得出来 ——
 * 之前只有空白格子里的一个「＋」能点，等于把「看某天」做成了隐藏功能。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { CareTaskStatus } from '@core/types'
import type { CareTaskListItem } from '@shared/api'
import { addDays, urgencyOf, todayIso, windowRange } from '@core/care'
import type { CareUrgency } from '@core/care'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 该月第一天是周几（周一为 0）与总天数。 */
function monthLayout(year: number, month: number): { leading: number; days: number } {
  const first = new Date(year, month - 1, 1)
  // JS 里 0 是周日，这里换成「周一为 0」
  const jsDay = first.getDay()
  return { leading: (jsDay + 6) % 7, days: new Date(year, month, 0).getDate() }
}

export function CareCalendar({
  year,
  month,
  tasks,
  selectedDate,
  onPickTask,
  onPickDay,
  onPickCarriedTask
}: {
  year: number
  month: number
  tasks: CareTaskListItem[]
  /** 当前选中的那一天（YYYY-MM-DD），用来画选中框 */
  selectedDate?: string | null
  onPickTask: (task: CareTaskListItem) => void
  /** 点某一天：下面列出当天的全部计划 */
  onPickDay: (date: string) => void
  /**
   * 点「时间窗内可做」的虚标任务：**选中当前这天**，而不是跳回它的到期日。
   *
   * 不传时退化成 onPickTask（回到到期日）。
   */
  onPickCarriedTask?: (task: CareTaskListItem, date: string) => void
}): ReactNode {
  const today = todayIso()
  const { leading, days } = useMemo(() => monthLayout(year, month), [year, month])

  /**
   * 日期 → 当天到期的任务（按 `ruleId + title` 合并计数）。
   *
   * 一条规则给七株生成七条任务，格子里不该出现七行一模一样的标签 ——
   * 显示「×7」就够，具体哪一株点开看右侧当天列表。
   */
  const dueByDate = useMemo(() => {
    const flat = new Map<string, Map<string, { task: CareTaskListItem; count: number }>>()
    for (const t of tasks) {
      const key = `${t.ruleId ?? 'manual'}|${t.title}`
      const dayMap = flat.get(t.dueDate) ?? new Map<string, { task: CareTaskListItem; count: number }>()
      const hit = dayMap.get(key)
      if (hit) hit.count++
      else dayMap.set(key, { task: t, count: 1 })
      flat.set(t.dueDate, dayMap)
    }
    const out = new Map<string, Array<{ task: CareTaskListItem; count: number }>>()
    for (const [date, dayMap] of flat) out.set(date, [...dayMap.values()])
    return out
  }, [tasks])

  /**
   * 日期 → 时间窗覆盖这天、但到期日更早的**待办**（按规则/标题合并计数）。
   *
   * 用户要求「日历上也要显示」：10/1 的任务可做期到 10/31，
   * 那 10/18 这一格也该让人看见它还挂着 —— 用虚标样式区分「今天到期」。
   *
   * 这里**按 `ruleId + title` 去重**再显示「×N」：七株的任务如果每格都画七个
   * 一样的虚标，整月日历就没法看了。要点具体哪一株，点开后右侧当天列表里有。
   */
  const carriedByDate = useMemo(() => {
    const byDate = new Map<string, Map<string, { task: CareTaskListItem; count: number }>>()
    const monthStart = `${year}-${pad(month)}-01`
    const monthEnd = `${year}-${pad(month)}-${pad(days)}`
    for (const t of tasks) {
      if (t.status !== 'pending') continue
      const end = windowRange(t).to
      if (end <= t.dueDate) continue
      const from = addDays(t.dueDate, 1) > monthStart ? addDays(t.dueDate, 1) : monthStart
      const to = end < monthEnd ? end : monthEnd
      const key = `${t.ruleId ?? 'manual'}|${t.title}`
      for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
        const dayMap = byDate.get(cursor) ?? new Map<string, { task: CareTaskListItem; count: number }>()
        const hit = dayMap.get(key)
        if (hit) hit.count++
        else dayMap.set(key, { task: t, count: 1 })
        byDate.set(cursor, dayMap)
      }
    }
    const out = new Map<string, Array<{ task: CareTaskListItem; count: number }>>()
    for (const [date, dayMap] of byDate) out.set(date, [...dayMap.values()])
    return out
  }, [tasks, year, month, days])

  const cells: Array<{ date: string | null; day: number | null }> = []
  for (let i = 0; i < leading; i++) cells.push({ date: null, day: null })
  for (let d = 1; d <= days; d++) cells.push({ date: `${year}-${pad(month)}-${pad(d)}`, day: d })
  // 补齐到整周，格子宽度才一致
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null })

  const toneOf = (status: CareTaskStatus, urgency: CareUrgency): string => {
    if (status === 'done') return 'done'
    if (status === 'skipped') return 'skipped'
    if (urgency === 'overdue') return 'overdue'
    if (urgency === 'due') return 'due'
    return 'pending'
  }

  return (
    <div className="care-calendar">
      <div className="cal-head">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-head-cell">
            {w}
          </div>
        ))}
      </div>
      <div className="cal-body">
        {cells.map((cell, i) => {
          const date = cell.date
          if (!date) return <div key={`empty-${i}`} className="cal-cell empty" />
          const due = dueByDate.get(date) ?? []
          const carried = carriedByDate.get(date) ?? []
          const isToday = date === today
          const isSelected = date === selectedDate
          /*
           * 一格最多 3 个标签：到期优先，但**给「时间窗内」留一格** ——
           * 否则当天的计划和可补做的计划一起挤，窗口内的永远被挤掉。
           */
          const dueSlots = carried.length > 0 ? 2 : 3
          const shownDue = due.slice(0, dueSlots)
          const shownCarried = carried.slice(0, 3 - shownDue.length)
          const dueCount = due.reduce((sum, c) => sum + c.count, 0)
          const carriedCount = carried.reduce((sum, c) => sum + c.count, 0)
          const hidden =
            dueCount +
            carriedCount -
            shownDue.reduce((sum, c) => sum + c.count, 0) -
            shownCarried.reduce((sum, c) => sum + c.count, 0)
          const title =
            `${date}：${dueCount} 项到期` +
            (carriedCount > 0 ? `，${carriedCount} 项时间窗内可做` : '') +
            '。点一下看当天的计划'
          return (
            <div
              key={date}
              className={`cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
              title={title}
              onClick={() => onPickDay(date)}
            >
              <div className="cal-day">
                <span>{cell.day}</span>
              </div>
              <div className="cal-tasks">
                {shownDue.map(({ task: t, count }) => (
                  <button
                    key={`due-${t.ruleId ?? t.id}-${t.title}`}
                    className={`cal-chip ${toneOf(t.status, urgencyOf(t, today))}`}
                    title={`${t.title}${count > 1 ? `（${count} 株）` : ''}${t.plantName ? ` · ${t.plantName}` : ''}`}
                    onClick={(event) => {
                      // 点任务只选中那天 + 高亮那条，别再冒泡成「点空白处」
                      event.stopPropagation()
                      onPickTask(t)
                    }}
                  >
                    <span className="cal-chip-title">{t.title}</span>
                    {count > 1 ? <span className="cal-chip-count">×{count}</span> : null}
                  </button>
                ))}
                {shownCarried.map(({ task: t, count }) => (
                  <button
                    key={`carried-${t.ruleId ?? t.id}-${t.title}`}
                    className="cal-chip carried"
                    title={`时间窗内可做：${t.title}（${count} 株，最早到期 ${t.dueDate}）`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (onPickCarriedTask) onPickCarriedTask(t, date)
                      else onPickTask(t)
                    }}
                  >
                    <span className="cal-chip-title">{t.title}</span>
                    {count > 1 ? <span className="cal-chip-count">×{count}</span> : null}
                  </button>
                ))}
                {hidden > 0 ? <div className="cal-more">还有 {hidden} 项</div> : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className="cal-legend small muted">
        图例：
        <span className="cal-dot overdue" /> 已过期
        <span className="cal-dot due" /> 该做了
        <span className="cal-dot pending" /> 计划中
        <span className="cal-dot done" /> 已完成
        <span className="cal-dot skipped" /> 已跳过
        <span className="cal-dot carried" /> 时间窗内可做
        <span style={{ marginLeft: 10 }}>点日期看当天计划，点任务可查看 / 编辑</span>
      </div>
    </div>
  )
}
