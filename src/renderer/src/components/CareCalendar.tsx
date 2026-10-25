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
   * 时间窗 → 横向条。
   *
   * 原来是把「时间窗内可做」的待办逐日画成虚标标签：一条 10-15~10-31 的任务，
   * 会在 17 个格子里各出现一次，整月看起来像刷屏（用户截图就是这样）。
   * 现在改成**一条横线**：从到期日画到窗口结束，跨格子连续，端点收圆。
   *
   * 同规则同标题的多株合并成一条，`×N` 是株数。
   */
  const toneOf = (status: CareTaskStatus, urgency: CareUrgency): string => {
    if (status === 'done') return 'done'
    if (status === 'skipped') return 'skipped'
    if (urgency === 'overdue') return 'overdue'
    if (urgency === 'due') return 'due'
    return 'pending'
  }

  const spanBars = useMemo(() => {
    const monthStart = `${year}-${pad(month)}-01`
    const monthEnd = `${year}-${pad(month)}-${pad(days)}`
    const byKey = new Map<string, { title: string; from: string; to: string; count: number; tone: string }>()
    for (const t of tasks) {
      if (t.status !== 'pending') continue
      const end = windowRange(t).to
      if (end <= t.dueDate) continue
      const from = t.dueDate > monthStart ? t.dueDate : monthStart
      const to = end < monthEnd ? end : monthEnd
      if (to < monthStart || from > monthEnd) continue
      const key = `${t.ruleId ?? 'manual'}|${t.title}`
      const hit = byKey.get(key)
      const tone = toneOf(t.status, urgencyOf(t, today))
      if (hit) {
        hit.count += 1
        if (from < hit.from) hit.from = from
        if (to > hit.to) hit.to = to
      } else {
        byKey.set(key, { title: t.title, from, to, count: 1, tone })
      }
    }
    // 日期 → 覆盖它的条
    const byDate = new Map<string, Array<{ key: string; title: string; count: number; seg: 'start' | 'mid' | 'end' | 'both'; tone: string }>>()
    for (const [key, bar] of byKey) {
      for (let cursor = bar.from; cursor <= bar.to; cursor = addDays(cursor, 1)) {
        const seg = cursor === bar.from && cursor === bar.to ? 'both' : cursor === bar.from ? 'start' : cursor === bar.to ? 'end' : 'mid'
        const list = byDate.get(cursor) ?? []
        list.push({ key, title: bar.title, count: bar.count, seg, tone: bar.tone })
        byDate.set(cursor, list)
      }
    }
    const out = new Map<string, Array<{ key: string; title: string; count: number; seg: 'start' | 'mid' | 'end' | 'both'; tone: string }>>()
    for (const [date, list] of byDate) {
      // 起点排前面：同一个格子里先画正在开始的那条
      out.set(date, list.sort((a, b) => (a.seg === 'start' ? -1 : 0) - (b.seg === 'start' ? -1 : 0)))
    }
    return out
  }, [tasks, year, month, days, today])

  /** 跨天任务的 key：这些不在到期日画小标签，改由时间条表示，免得同一天出现两次 */
  const spanKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const list of spanBars.values()) for (const bar of list) keys.add(bar.key)
    return keys
  }, [spanBars])

  const cells: Array<{ date: string | null; day: number | null }> = []
  for (let i = 0; i < leading; i++) cells.push({ date: null, day: null })
  for (let d = 1; d <= days; d++) cells.push({ date: `${year}-${pad(month)}-${pad(d)}`, day: d })
  // 补齐到整周，格子宽度才一致
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null })

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
          const bars = spanBars.get(date) ?? []
          const due = (dueByDate.get(date) ?? []).filter(
            ({ task }) => !spanKeys.has(`${task.ruleId ?? 'manual'}|${task.title}`)
          )
          const isToday = date === today
          const isSelected = date === selectedDate
          // 到期标签最多 2 个；时间条最多 2 条（再多只体现在 tooltip 里，格子不再堆文字）
          const shownDue = due.slice(0, 2)
          const shownBars = bars.slice(0, 2)
          const dueCount = due.reduce((sum, c) => sum + c.count, 0)
          const carriedCount = bars.reduce((sum, b) => sum + b.count, 0)
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
              </div>
              {shownBars.length > 0 ? (
                <div className="cal-spans">
                  {shownBars.map((bar) => (
                    <div
                      key={`span-${bar.key}`}
                      className={`cal-span ${bar.tone} seg-${bar.seg}`}
                      title={`${bar.title}${bar.count > 1 ? `（${bar.count} 株）` : ''}：时间窗内可做`}
                    >
                      {bar.seg === 'start' || bar.seg === 'both' ? (
                        <span className="cal-span-label">
                          {bar.title}
                          {bar.count > 1 ? ` ×${bar.count}` : ''}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
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
        <span className="cal-bar-sample" /> 时间窗（可做至结束日）
        <span style={{ marginLeft: 10 }}>点日期看当天计划，点任务可查看 / 编辑</span>
      </div>
    </div>
  )
}
