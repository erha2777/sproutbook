/**
 * 月历网格。
 *
 * 与「待办」列表是两种视角，不是替代关系：
 *  - 列表回答「我现在该做什么」（逾期置顶，跨月份）
 *  - 月历回答「这个月的节奏是怎样的」（哪几天扎堆、哪段空着）
 *
 * 所以同一批任务在两处都要出现，但排序与分组完全不同。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { CareTaskStatus } from '@core/types'
import type { CareTaskListItem } from '@shared/api'
import { CARE_ACTION_ICONS, urgencyOf, todayIso } from '@core/care'
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
  onPickTask,
  onPickDay
}: {
  year: number
  month: number
  tasks: CareTaskListItem[]
  onPickTask: (task: CareTaskListItem) => void
  /** 点空白日期时回调，用于「这天加一件事」 */
  onPickDay: (date: string) => void
}): ReactNode {
  const today = todayIso()
  const { leading, days } = useMemo(() => monthLayout(year, month), [year, month])

  /** 日期 → 当天的任务 */
  const byDate = useMemo(() => {
    const map = new Map<string, CareTaskListItem[]>()
    for (const t of tasks) {
      const list = map.get(t.dueDate) ?? []
      list.push(t)
      map.set(t.dueDate, list)
    }
    return map
  }, [tasks])

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
          if (!cell.date) return <div key={`empty-${i}`} className="cal-cell empty" />
          const list = byDate.get(cell.date) ?? []
          const isToday = cell.date === today
          return (
            <div key={cell.date} className={`cal-cell${isToday ? ' today' : ''}`}>
              <div className="cal-day">
                <span>{cell.day}</span>
                {list.length === 0 ? (
                  <button
                    className="cal-add"
                    title={`在 ${cell.date} 加一件事`}
                    onClick={() => onPickDay(cell.date as string)}
                  >
                    ＋
                  </button>
                ) : null}
              </div>
              <div className="cal-tasks">
                {list.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    className={`cal-chip ${toneOf(t.status, urgencyOf(t, today))}`}
                    title={`${t.title}${t.plantName ? ` · ${t.plantName}` : ''}`}
                    onClick={() => onPickTask(t)}
                  >
                    {CARE_ACTION_ICONS[t.actionType]} {t.title}
                  </button>
                ))}
                {list.length > 3 ? <div className="cal-more">还有 {list.length - 3} 项</div> : null}
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
        <span style={{ marginLeft: 10 }}>点任务可跳到待办列表处理</span>
      </div>
    </div>
  )
}
