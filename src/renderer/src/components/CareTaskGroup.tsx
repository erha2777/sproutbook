/**
 * 分组块：**同一条规则、同一天、同一个标题**的任务放在一起显示。
 *
 * 只负责「讲清楚这是同一件事」：标题、日期、可做期、紧急度、共几株、
 * 说明与绑定的配方 —— 只写一次。里面的每一株仍然由调用方渲染成独立一行
 * （今日页：完成 / 跳过；养护计划：查看 / 编辑 / 删除）。
 *
 * 为什么不做「合并成一条、批量完成」：日志（以后还有照片）是按株记的，
 * 合并会丢掉粒度。这条是用户明确纠正过的，别再改回去。
 */

import type { ReactNode } from 'react'
import type { Material, RecipeListItem } from '@core/types'
import type { CareTaskListItem } from '@shared/api'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_URGENCY_LABELS,
  dueDescription,
  urgencyOf,
  windowRange
} from '@core/care'
import { Badge } from './ui'
import { TaskRecipe, URGENCY_TONE } from './CareTaskRow'

export function CareTaskGroup({
  tasks,
  today,
  recipes,
  materials,
  children
}: {
  tasks: CareTaskListItem[]
  today: string
  recipes: RecipeListItem[] | null
  materials: Material[] | null
  children: ReactNode
}): ReactNode {
  const first = tasks[0]
  const pending = tasks.filter((t) => t.status === 'pending')
  const done = tasks.filter((t) => t.status === 'done').length
  const skipped = tasks.filter((t) => t.status === 'skipped').length

  const urgency = urgencyOf(first, today)
  const dueText = dueDescription(first, today)
  const label = CARE_URGENCY_LABELS[urgency]
  const badgeText = dueText.startsWith(label) ? dueText : `${label} · ${dueText}`

  return (
    <div className="task-group">
      <div className="task-group-head">
        <span className="task-icon">{CARE_ACTION_ICONS[first.actionType]}</span>
        <b>{first.title}</b>
        {/* 还有没做的：显示紧急度（同一组日期相同，一条就够） */}
        {pending.length > 0 ? <Badge tone={URGENCY_TONE[urgency]}>{badgeText}</Badge> : null}
        {first.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
        {done > 0 ? <Badge tone="ok">已完成 {done}</Badge> : null}
        {skipped > 0 ? <Badge tone="muted">已跳过 {skipped}</Badge> : null}
        <Badge tone="muted">共 {tasks.length} 株</Badge>
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
      <div className="task-group-body">{children}</div>
    </div>
  )
}
