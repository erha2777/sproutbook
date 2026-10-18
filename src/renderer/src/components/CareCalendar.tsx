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
  selectedDate,
  onPickTask,
  onPickDay
}: {
  year: number
  month: number
  tasks: CareTaskListItem[]
  /** 当前选中的那一天（YYYY-MM-DD），用来画选中框 */
  selectedDate?: string | null
  onPickTask: (task: CareTaskListItem) => void
  /** 点某一天：下面列出当天的全部计划 */
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
          const date = cell.date
          if (!date) return <div key={`empty-${i}`} className="cal-cell empty" />
          const list = byDate.get(date) ?? []
          const isToday = date === today
          const isSelected = date === selectedDate
          return (
            <div
              key={date}
              className={`cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
              title={`${date}：${list.length} 项。点一下看当天的计划`}
              onClick={() => onPickDay(date)}
            >
              <div className="cal-day">
                <span>{cell.day}</span>
              </div>
              <div className="cal-tasks">
                {list.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    className={`cal-chip ${toneOf(t.status, urgencyOf(t, today))}`}
                    title={`${t.title}${t.plantName ? ` · ${t.plantName}` : ''}`}
                    onClick={(event) => {
                      // 点任务只选中那天 + 高亮那条，别再冒泡成「点空白处」
                      event.stopPropagation()
                      onPickTask(t)
                    }}
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
        <span style={{ marginLeft: 10 }}>点日期看当天计划，点任务可查看 / 编辑</span>
      </div>
    </div>
  )
}
