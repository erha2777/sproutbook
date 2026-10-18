/**
 * 养护任务的新增 / 编辑弹窗。
 *
 * 时间窗（±N 天）是这里最需要解释的一个字段：任务不是死线，
 * 「这周内做都行」比「必须在 6 月 10 日做」更符合养花的实际。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareTask } from '@core/types'
import { CARE_ACTION_OPTIONS, addDays, todayIso } from '@core/care'
import { Button, Field, Modal, Notice, SelectInput, TextArea, TextInput, useToast } from './ui'

export interface PlantOption {
  id: number
  label: string
}

export function CareTaskDialog({
  task,
  plants,
  defaultDate,
  onClose,
  onSaved
}: {
  /** 传 null 表示新增 */
  task: CareTask | null
  plants: PlantOption[]
  defaultDate?: string
  onClose: () => void
  onSaved: () => void
}): ReactNode {
  const toast = useToast()
  const [plantId, setPlantId] = useState<string>(task?.plantId ? String(task.plantId) : (plants[0] ? String(plants[0].id) : ''))
  const [actionType, setActionType] = useState(task?.actionType ?? 'observe')
  const [title, setTitle] = useState(task?.title ?? '')
  const [detail, setDetail] = useState(task?.detail ?? '')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? defaultDate ?? todayIso())
  const [windowDays, setWindowDays] = useState(String(task?.windowDays ?? 3))
  const [priority, setPriority] = useState(String(task?.priority ?? 2))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // 切换动作类型时，如果标题还是空的或就是上一个动作的默认名，顺手补一个
    if (title.trim()) return
    const label = CARE_ACTION_OPTIONS.find((o) => o.value === actionType)?.label ?? ''
    setTitle(label.replace(/^\S+\s/, ''))
    // 只在标题为空时联动，避免覆盖用户已经写好的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionType])

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      toast.push('请填写任务标题', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = {
        plantId: plantId ? Number(plantId) : null,
        actionType,
        title: title.trim(),
        detail: detail.trim() || null,
        dueDate,
        windowDays: Number(windowDays) || 0,
        priority: Number(priority) || 2
      }
      if (task) await window.api.care.updateTask(task.id, payload)
      else await window.api.care.createTask(payload)
      toast.push(task ? '任务已更新' : '任务已添加', 'success')
      onSaved()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  /*
   * 窗口从**到期日当天**开始，往后延续 N 天（不再是 ±N）——
   * 提前不会变成「该做了」，过期前都还有宽限。
   */
  const win = { from: dueDate, to: addDays(dueDate, Number(windowDays) || 0) }

  return (
    <Modal
      title={task ? '编辑养护任务' : '新增养护任务'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="form-grid">
          <Field label="任务标题" required>
            <TextInput value={title} onChange={setTitle} placeholder="例如：给月季追肥" />
          </Field>
          <Field label="动作类型">
            <SelectInput
              value={actionType}
              onChange={(v) => setActionType(v as CareTask['actionType'])}
              options={CARE_ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
          <Field label="哪一株" help="留空表示不针对特定植株（例如给整个阳台消毒）。">
            <SelectInput
              value={plantId}
              onChange={setPlantId}
              placeholder="（不指定）"
              options={[{ value: '', label: '（不指定）' }, ...plants.map((p) => ({ value: String(p.id), label: p.label }))]}
            />
          </Field>
          <Field label="计划日期">
            <TextInput value={dueDate} onChange={setDueDate} placeholder="2026-06-15" />
          </Field>
          <Field label="宽限（天）" help="到期之后还能拖几天都算准时。窗口从到期日当天开始，不会提前变红。日常养护建议 3~7 天。">
            <TextInput value={windowDays} onChange={setWindowDays} placeholder="3" />
          </Field>
          <Field label="优先级" help="数字越小越优先，1 最高。">
            <SelectInput
              value={priority}
              onChange={setPriority}
              options={[
                { value: '1', label: '1 · 高（关系到死活）' },
                { value: '2', label: '2 · 中（常规养护）' },
                { value: '3', label: '3 · 低（有空再说）' }
              ]}
            />
          </Field>
        </div>

        <Field label="说明">
          <TextArea value={detail} onChange={setDetail} rows={2} placeholder="具体怎么做、注意什么…" />
        </Field>

        <Notice tone="info">
          这件事的可做区间是 <b>{win.from}</b> ~ <b>{win.to}</b>。
          区间内任何时候打勾都算准时，超过末端才会标成「已过期」。
        </Notice>
      </div>
    </Modal>
  )
}
