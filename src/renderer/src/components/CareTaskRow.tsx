/**
 * 养护任务的一行 + 分组标题。
 *
 * 抽出来的原因很具体：1.8.0 之后「养护计划」和「今日」两个页面都要显示任务行。
 * 这个仓库已经为「双份实现」付过代价 —— core 与 CarePage 各有一份 suggestTask，
 * 线上跑的那份少了一个「前」字，而自检一直在测没人用的那份。
 * 所以任务行的按钮、徽章、时间窗文案只留这一处。
 *
 * ⚠️ 关于行内状态：备注输入框的开关放在组件内部（原来在 CarePage 里）。
 * 任务完成 / 跳过后这里会自己把输入框收起来 —— 否则行还在（只是变成已关闭），
 * 备注框会一直挂在那儿。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareTaskListItem } from '@shared/api'
import type { Material, RecipeListItem } from '@core/types'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_URGENCY_LABELS,
  dueDescription,
  urgencyOf,
  windowRange
} from '@core/care'
import type { CareUrgency } from '@core/care'
import { Badge, Button, TextInput } from './ui'

type BadgeTone = 'safety' | 'ai' | 'ok' | 'warn' | 'info' | 'muted'

const URGENCY_TONE: Record<CareUrgency, BadgeTone> = {
  overdue: 'safety',
  due: 'warn',
  soon: 'info',
  later: 'muted',
  closed: 'ok'
}

/**
 * 任务卡片上显示绑定的配方。
 *
 * **定义在模块层，不是组件内部。** 组件内定义会让每次渲染都产生一个新的
 * 函数标识，React 认为子树换了类型就整个重挂载 —— 之前笔记输入框打不进字
 * 就是这个原因。这个组件目前只是静态展示，但同样的坑不该再踩第二次。
 */
export function TaskRecipe({  recipeId,
  recipes,
  materials
}: {
  recipeId: number
  /**
   * 配方列表。**null 表示没取到**，和「取到了但是空的」不是一回事 ——
   * 混为一谈的话，一次加载失败会让每张任务卡都断言「配方已删除」，
   * 用户就会去重建一份其实还在的配方。
   */
  recipes: RecipeListItem[] | null
  materials: Material[] | null
}): ReactNode {
  if (recipes === null) {
    return <div className="small muted">📋 配方未能读取（列表加载失败，配方本身可能还在）</div>
  }
  const rec = recipes.find((r) => r.id === recipeId)
  if (!rec) return <div className="small muted">📋 配方已删除</div>
  const parts = rec.items.map((it) => {
    const label = it.name ?? materials?.find((m) => m.id === it.materialId)?.name ?? '材料'
    return it.ratioPart && it.ratioPart !== 1 ? `${label} ${it.ratioPart} 份` : label
  })
  return (
    <div className="task-recipe">
      <span className="task-recipe-name">📋 {rec.name}</span>
      {parts.length > 0 ? <span className="muted"> {parts.join(' · ')}</span> : null}
    </div>
  )
}

export interface CareTaskRowProps {
  task: CareTaskListItem
  /** 今天（YYYY-MM-DD），用来算紧急度与「还剩几天」 */
  today: string
  /** 这一行的操作正在进行中，按钮要禁用 */
  busy?: boolean
  /** 从月历跳过来时高亮一下，让人看得见是哪一条 */
  highlighted?: boolean
  /**
   * 这一行能做什么。
   *
   * - `act`（默认）：今日页用。完成 / 跳过 / 撤销 —— 「执行」在这一页。
   * - `manage`：养护计划用。只给**查看 / 编辑 / 删除** —— 计划页负责排和改，
   *   执行动作统一收到今日页，免得同一个任务两个地方两套按钮。
   */
  mode?: 'act' | 'manage'
  recipes: RecipeListItem[] | null
  materials: Material[] | null
  /** 把这一行的 DOM 交给页面（跳转后要 scrollIntoView） */
  registerRef?: (el: HTMLDivElement | null) => void
  onComplete?: (task: CareTaskListItem, note: string) => void
  onSkip?: (task: CareTaskListItem) => void
  onReopen?: (task: CareTaskListItem) => void
  onEdit: (task: CareTaskListItem) => void
  onDelete: (task: CareTaskListItem) => void
}

export function CareTaskRow({
  task,
  today,
  busy = false,
  highlighted = false,
  mode = 'act',
  recipes,
  materials,
  registerRef,
  onComplete,
  onSkip,
  onReopen,
  onEdit,
  onDelete
}: CareTaskRowProps): ReactNode {
  const closed = task.status !== 'pending'
  const urgency = urgencyOf(task, today)
  /*
   * dueDescription 在逾期时本身就以「已过期」开头，再拼一次标签就成了
   * 「已过期 · 已过期 26 天」。只有两者不重复时才拼。
   */
  const urgencyLabel = CARE_URGENCY_LABELS[urgency]
  const dueText = dueDescription(task, today)
  const badgeText = dueText.startsWith(urgencyLabel) ? dueText : `${urgencyLabel} · ${dueText}`
  /** 可执行到哪天 —— 窗口现在是「到期日 → 到期日 + 宽限」 */
  const windowEnd = windowRange(task).to

  /** 备注输入框：点「完成」先展开，确认后才真写 */
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')

  /*
   * 任务被标成完成 / 跳过后（包括在别处撤销又完成），
   * 这一行还挂在 DOM 里，只是换了个分组 —— 输入框必须收起来，
   * 否则「已完成」旁边永远开着一个输入框。
   */
  useEffect(() => {
    if (closed) {
      setNoteOpen(false)
      setNote('')
    }
  }, [closed])

  return (
    <div
      className={"task-row" + (highlighted ? " highlighted" : "")}
      ref={(el) => registerRef?.(el)}
    >
      <span className="task-icon">{CARE_ACTION_ICONS[task.actionType]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row tight" style={{ alignItems: 'center' }}>
          <b>{task.title}</b>
          <Badge tone={URGENCY_TONE[urgency]}>
            {closed
              ? task.status === 'done'
                ? '已完成'
                : '已跳过'
              : badgeText}
          </Badge>
          {task.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
          {task.source === 'manual' ? <Badge tone="muted">手动</Badge> : null}
        </div>
        <div className="small muted">
          {task.dueDate}
          {task.plantName ? ` · ${task.plantName}` : ''}
          {task.speciesName ? ` · ${task.speciesName}` : ''}
          {` · ${CARE_ACTION_LABELS[task.actionType]}`}
          {task.windowDays > 0 ? ` · 可做至 ${windowEnd}` : ''}
        </div>
        {task.detail ? <div className="small">{task.detail}</div> : null}
        {/*
          绑了配方的规则，任务上直接列出材料清单 ——
          做的时候不用再翻回规则库查「羊粪放多少」。
          按 id 现查，所以配方改了名字这里会跟着变。
        */}
        {task.recipeId ? <TaskRecipe recipeId={task.recipeId} recipes={recipes} materials={materials} /> : null}
        {task.completedNote ? <div className="small muted">备注：{task.completedNote}</div> : null}

        {noteOpen && mode === 'act' ? (
          <div className="row tight" style={{ marginTop: 6 }}>
            <div style={{ flex: 1 }}>
              <TextInput value={note} onChange={setNote} placeholder="记一句当时的情况（可留空）" autoFocus />
            </div>
            <Button
              size="small"
              variant="primary"
              onClick={() => {
                setNoteOpen(false)
                onComplete?.(task, note)
              }}
            >
              确认完成
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setNoteOpen(false)
                setNote('')
              }}
            >
              取消
            </Button>
          </div>
        ) : null}
      </div>

      <div className="row tight" style={{ flexWrap: 'nowrap' }}>
        {mode === 'manage' ? (
          <>
            {/* 计划页只做「看 / 改 / 删」：完成和跳过是执行业务，归今日页 */}
            <Button size="small" variant="ghost" onClick={() => onEdit(task)}>
              编辑
            </Button>
            <Button size="small" variant="ghost" onClick={() => onDelete(task)}>
              删除
            </Button>
          </>
        ) : closed ? (
          <>
            <Button size="small" disabled={busy} onClick={() => onReopen?.(task)}>
              撤销
            </Button>
            <Button size="small" variant="ghost" onClick={() => onDelete(task)}>
              删除
            </Button>
          </>
        ) : (
          <>
            <Button
              size="small"
              variant="primary"
              disabled={busy}
              onClick={() => {
                setNoteOpen(true)
                setNote('')
              }}
            >
              完成
            </Button>
            <Button size="small" disabled={busy} onClick={() => onSkip?.(task)}>
              跳过
            </Button>
            <Button size="small" variant="ghost" onClick={() => onEdit(task)}>
              编辑
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 任务分组标题 + 若干行。
 *
 * `count` 单独传而不是从 children 数：children 可能是过滤后的数组，
 * 数 children 需要 React.Children.count，而这里本来就是从数组渲染的。
 */
export function TaskGroup({
  title,
  count,
  tone,
  children
}: {
  title: string
  count: number
  tone?: BadgeTone
  children: ReactNode
}): ReactNode {
  if (count === 0) return null
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="section-title">
        {title}
        {tone ? <Badge tone={tone}>{count}</Badge> : <span className="small muted">{count} 项</span>}
      </div>
      {children}
    </div>
  )
}
