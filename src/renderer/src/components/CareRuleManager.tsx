/**
 * 养护规则库管理。
 *
 * 规则是「哪个月该做什么」的知识，不是排期 —— 所以这里只填月份区间，
 * 不填具体日期。生成任务时会自动展开成每月一条并带上时间窗。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareActionType, CareRule } from '@core/types'
import { CARE_ACTION_LABELS, CARE_ACTION_OPTIONS, UNIVERSAL_SPECIES_KEY, monthsCovered } from '@core/care'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from './ui'

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))

interface Draft {
  id?: number
  speciesKey: string
  monthFrom: string
  monthTo: string
  actionType: CareActionType
  title: string
  detail: string
  priority: string
  verified: boolean
}

const BLANK: Draft = {
  speciesKey: UNIVERSAL_SPECIES_KEY,
  monthFrom: '3',
  monthTo: '',
  actionType: 'fertilize',
  title: '',
  detail: '',
  priority: '2',
  verified: true
}

export function CareRuleManager({
  speciesNames,
  onClose
}: {
  speciesNames: string[]
  onClose: () => void
}): ReactNode {
  const toast = useToast()
  const [rules, setRules] = useState<CareRule[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await window.api.care.rules())
    } catch (error) {
      toast.push(`加载规则失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.title.trim()) {
      toast.push('请填写规则标题', 'error')
      return
    }
    setSaving(true)
    try {
      await window.api.care.saveRule({
        id: draft.id,
        speciesKey: draft.speciesKey.trim() || UNIVERSAL_SPECIES_KEY,
        hemisphere: 'N',
        climateZone: null,
        monthFrom: Number(draft.monthFrom),
        monthTo: draft.monthTo ? Number(draft.monthTo) : null,
        actionType: draft.actionType,
        title: draft.title.trim(),
        detail: draft.detail.trim() || null,
        priority: Number(draft.priority) || 2,
        source: 'manual',
        verified: draft.verified
      })
      toast.push(draft.id ? '规则已更新' : '规则已添加', 'success')
      setDraft(null)
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (rule: CareRule): Promise<void> => {
    if (!window.confirm(`确定删除规则「${rule.title}」吗？\n已经生成的任务不受影响，下次生成时不再产生这条。`)) return
    try {
      await window.api.care.removeRule(rule.id)
      toast.push('已删除', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  const speciesOptions = [
    { value: UNIVERSAL_SPECIES_KEY, label: '通用（所有植物）' },
    ...speciesNames.map((n) => ({ value: n, label: n }))
  ]

  return (
    <Modal
      title="养护规则库"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">共 {rules.length} 条规则</span>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <Notice tone="info">
          规则只写<b>哪个月做什么</b>，不写具体哪天 —— 哪天有空、天气如何，是排期时再决定的事。
          生成任务时会自动展开成每月一条，并给一个时间窗。改规则<b>不会</b>动到你已经打过勾的任务。
        </Notice>

        {draft ? (
          <Panel flat>
            <SectionTitle>{draft.id ? '编辑规则' : '新增规则'}</SectionTitle>
            <div className="form-grid">
              <Field label="适用于" help="通用规则对所有植物生效；也可以绑定到某个物种名。">
                <SelectInput value={draft.speciesKey} onChange={(v) => setDraft({ ...draft, speciesKey: v })} options={speciesOptions} />
              </Field>
              <Field label="动作">
                <SelectInput
                  value={draft.actionType}
                  onChange={(v) => setDraft({ ...draft, actionType: v as CareActionType })}
                  options={CARE_ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </Field>
              <Field label="起始月份">
                <SelectInput value={draft.monthFrom} onChange={(v) => setDraft({ ...draft, monthFrom: v })} options={MONTH_OPTIONS} />
              </Field>
              <Field label="结束月份" help="留空表示只在这一件事发生在起始月。">
                <SelectInput
                  value={draft.monthTo}
                  onChange={(v) => setDraft({ ...draft, monthTo: v })}
                  placeholder="（仅起始月）"
                  options={[{ value: '', label: '（仅起始月）' }, ...MONTH_OPTIONS]}
                />
              </Field>
              <Field label="优先级" help="数字越小越优先。">
                <SelectInput
                  value={draft.priority}
                  onChange={(v) => setDraft({ ...draft, priority: v })}
                  options={[
                    { value: '1', label: '1 · 高（关系到死活）' },
                    { value: '2', label: '2 · 中（常规养护）' },
                    { value: '3', label: '3 · 低（有空再说）' }
                  ]}
                />
              </Field>
            </div>
            <Field label="标题" required>
              <TextInput value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} placeholder="例如：春季追肥" />
            </Field>
            <Field label="说明">
              <TextInput value={draft.detail} onChange={(v) => setDraft({ ...draft, detail: v })} placeholder="具体怎么做…" />
            </Field>
            <div className="small muted" style={{ marginBottom: 8 }}>
              覆盖月份：
              {monthsCovered({ monthFrom: Number(draft.monthFrom), monthTo: draft.monthTo ? Number(draft.monthTo) : null })
                .map((m) => `${m}月`)
                .join('、') || '—'}
            </div>
            <div className="row">
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
              <Button onClick={() => setDraft(null)}>取消</Button>
            </div>
          </Panel>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <Button variant="primary" size="small" onClick={() => setDraft({ ...BLANK })}>
              ＋ 新增规则
            </Button>
          </div>
        )}

        {loading ? (
          <Spinner label="加载中…" />
        ) : (
          <table className="pixel-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 130 }}>适用于</th>
                <th style={{ width: 90 }}>月份</th>
                <th style={{ width: 90 }}>动作</th>
                <th>内容</th>
                <th style={{ width: 60 }}>优先级</th>
                <th style={{ width: 110 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="small">
                    {rule.speciesKey === UNIVERSAL_SPECIES_KEY ? (
                      <Badge tone="info">通用</Badge>
                    ) : (
                      <b>{rule.speciesKey}</b>
                    )}
                  </td>
                  <td className="small">{monthsCovered(rule).map((m) => m).join('/')} 月</td>
                  <td className="small">{CARE_ACTION_LABELS[rule.actionType]}</td>
                  <td>
                    <b>{rule.title}</b>
                    {rule.detail ? <div className="small muted">{rule.detail}</div> : null}
                    {!rule.verified ? <Badge tone="ai">未核实</Badge> : null}
                  </td>
                  <td className="small">{rule.priority}</td>
                  <td>
                    <div className="row tight">
                      <Button
                        size="small"
                        onClick={() =>
                          setDraft({
                            id: rule.id,
                            speciesKey: rule.speciesKey,
                            monthFrom: String(rule.monthFrom),
                            monthTo: rule.monthTo === null ? '' : String(rule.monthTo),
                            actionType: rule.actionType,
                            title: rule.title,
                            detail: rule.detail ?? '',
                            priority: String(rule.priority),
                            verified: rule.verified
                          })
                        }
                      >
                        编辑
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => void remove(rule)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
