/**
 * 合并任务行：**同一条规则、同一天、同一个标题**的多个植株任务合成一行。
 *
 * 为什么合并：一条「秋季补肥」规则管着七株，今日页就出现七行只差植株名字的卡片。
 * 用户真正做的时候是「今天把这几盆都补一遍」，不是一个植株一个页面地勾。
 * 所以合并成一行，行里列出植株，可以勾选哪些做完了（默认全选），
 * 再一次性完成 —— 每条任务仍然各自落库，日志也是每株一条。
 *
 * 只用于「今日」页（执行动作的地方）。养护计划那边是查看 / 编辑 / 删除，
 * 仍然按单条任务显示。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Material, RecipeListItem } from '@core/types'
import type { CareTaskListItem } from '@shared/api'
import { CARE_ACTION_ICONS, CARE_ACTION_LABELS, CARE_URGENCY_LABELS, dueDescription, urgencyOf, windowRange } from '@core/care'
import { Badge, Button, TextInput } from './ui'
import { TaskRecipe } from './CareTaskRow'

const URGENCY_TONE: Record<string, 'safety' | 'warn' | 'info' | 'muted' | 'ok'> = {
  overdue: 'safety',
  due: 'warn',
  soon: 'info',
  later: 'muted',
  closed: 'ok'
}

export function MergedCareTaskRow({
  tasks,
  today,
  busy,
  recipes,
  materials,
  onComplete,
  onSkip
}: {
  tasks: CareTaskListItem[]
  today: string
  busy?: boolean
  recipes: RecipeListItem[] | null
  materials: Material[] | null
  /** 完成选中的那几条（note 会写给每一条） */
  onComplete: (selected: CareTaskListItem[], note: string) => void
  /** 跳过选中的那几条 */
  onSkip: (selected: CareTaskListItem[]) => void
}): ReactNode {
  const first = tasks[0]
  const urgency = urgencyOf(first, today)
  const dueText = dueDescription(first, today)
  const badgeText = dueText.startsWith(CARE_URGENCY_LABELS[urgency])
    ? dueText
    : `${CARE_URGENCY_LABELS[urgency]} · ${dueText}`

  /** 勾选的植株（默认全选：一次把这几盆都做完是最常见的操作） */
  const [selected, setSelected] = useState<Set<number>>(() => new Set(tasks.map((t) => t.id)))
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState('')

  /*
   * 完成后列表会重新加载，这一组剩下的任务可能变少 ——
   * 把选择收敛到仍然存在的那些，避免选中一个已经不存在的 id。
   */
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(tasks.map((t) => t.id))
      const next = new Set<number>()
      for (const id of prev) if (alive.has(id)) next.add(id)
      // 新出现的（极少见）默认不选，等用户自己点
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next
    })
  }, [tasks])

  const picked = tasks.filter((t) => selected.has(t.id))
  const allPicked = picked.length === tasks.length

  const toggle = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected(allPicked ? new Set() : new Set(tasks.map((t) => t.id)))
  }

  return (
    <div className="task-row">
      <span className="task-icon">{CARE_ACTION_ICONS[first.actionType]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row tight" style={{ alignItems: 'center' }}>
          <b>{first.title}</b>
          <Badge tone={URGENCY_TONE[urgency]}>{badgeText}</Badge>
          {first.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
          <Badge tone="muted">共 {tasks.length} 株</Badge>
        </div>
        <div className="small muted">
          {first.dueDate}
          {` · ${CARE_ACTION_LABELS[first.actionType]}`}
          {first.windowDays > 0 ? ` · 可做至 ${windowRange(first).to}` : ''}
        </div>
        {first.detail ? <div className="small">{first.detail}</div> : null}
        {first.recipeId ? <TaskRecipe recipeId={first.recipeId} recipes={recipes} materials={materials} /> : null}

        {/* 植株多选：默认全选，点一下取消那一株 */}
        <div className="row tight" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`pick-chip${allPicked ? ' on' : ''}`}
            onClick={toggleAll}
            title={allPicked ? '全部取消' : '全部选中'}
          >
            {allPicked ? '☑' : '☐'} 全部
          </button>
          {tasks.map((t) => {
            const on = selected.has(t.id)
            return (
              <button
                key={t.id}
                type="button"
                className={`pick-chip${on ? ' on' : ''}`}
                title={on ? '取消选择这一株' : '选中这一株'}
                onClick={() => toggle(t.id)}
              >
                {on ? '☑' : '☐'} {t.plantName ?? t.speciesName ?? `任务 #${t.id}`}
              </button>
            )
          })}
        </div>

        {confirming ? (
          <div className="row tight" style={{ marginTop: 6 }}>
            <div style={{ flex: 1 }}>
              <TextInput
                value={note}
                onChange={setNote}
                placeholder="给选中的这几条记一句（可留空）"
                autoFocus
              />
            </div>
            <Button
              size="small"
              variant="primary"
              disabled={picked.length === 0}
              onClick={() => {
                setConfirming(false)
                onComplete(picked, note)
                setNote('')
              }}
            >
              确认完成 {picked.length} 条
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setConfirming(false)
                setNote('')
              }}
            >
              取消
            </Button>
          </div>
        ) : null}
      </div>

      <div className="row tight" style={{ flexWrap: 'nowrap' }}>
        <Button
          size="small"
          variant="primary"
          disabled={busy || picked.length === 0 || confirming}
          onClick={() => setConfirming(true)}
        >
          完成
        </Button>
        <Button
          size="small"
          disabled={busy || picked.length === 0 || confirming}
          onClick={() => onSkip(picked)}
        >
          跳过
        </Button>
      </div>
    </div>
  )
}
