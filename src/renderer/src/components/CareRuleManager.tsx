/**
 * 养护规则库管理。
 *
 * 规则是「哪个月该做什么」的知识，不是排期 —— 所以这里只填月份区间，
 * 不填具体日期。生成任务时会自动展开成每月一条并带上时间窗。
 */

import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareActionType, CarePhase, CareRule } from '@core/types'
import {
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  CARE_PHASE_HINTS,
  CARE_PHASE_ICONS,
  CARE_PHASE_LABELS,
  CARE_PHASE_OPTIONS,
  UNIVERSAL_SPECIES_KEY,
  monthsCovered
} from '@core/care'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextArea, TextInput, useToast } from './ui'

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))

interface Draft {
  id?: number
  speciesKey: string
  monthFrom: string
  monthTo: string
  repeatDays: string
  /** 每行一个轮换步骤 */
  rotationText: string
  /** 限定生效的阶段；空＝按月份生效 */
  phases: CarePhase[]
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
  repeatDays: '',
  rotationText: '',
  phases: [],
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
      const rotation = draft.rotationText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      await window.api.care.saveRule({
        id: draft.id,
        speciesKey: draft.speciesKey.trim() || UNIVERSAL_SPECIES_KEY,
        hemisphere: 'N',
        climateZone: null,
        monthFrom: Number(draft.monthFrom),
        monthTo: draft.monthTo ? Number(draft.monthTo) : null,
        repeatDays: draft.repeatDays.trim() ? Number(draft.repeatDays) : null,
        rotation: rotation.length > 0 ? rotation : null,
        activePhases: draft.phases.length > 0 ? draft.phases : null,
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

  /** 从一条规则生成编辑草稿。 */
  const draftFrom = (rule: CareRule): Draft => ({
    id: rule.id,
    speciesKey: rule.speciesKey,
    monthFrom: String(rule.monthFrom),
    monthTo: rule.monthTo === null ? '' : String(rule.monthTo),
    repeatDays: rule.repeatDays === null ? '' : String(rule.repeatDays),
    rotationText: (rule.rotation ?? []).join('\n'),
    phases: rule.activePhases ?? [],
    actionType: rule.actionType,
    title: rule.title,
    detail: rule.detail ?? '',
    priority: String(rule.priority),
    verified: rule.verified
  })

  /**
   * 规则表单。
   *
   * 抽成函数是因为它有两个落点：新增时出现在列表上方（按钮就在那儿），
   * 编辑时**就地展开在那一行下面** —— 原来编辑表单固定渲染在顶部，
   * 点列表下方的「编辑」得先往上滚才看得到，改完再滚回来找那条规则。
   */
  const ruleForm = (): ReactNode => {
    if (!draft) return null
    const phasesActive = draft.phases.length > 0
    return (
      <Panel flat>
        <SectionTitle
          right={
            draft.id ? (
              <Button size="small" variant="ghost" onClick={() => setDraft(null)}>
                收起
              </Button>
            ) : null
          }
        >
          {draft.id ? '编辑规则' : '新增规则'}
        </SectionTitle>
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
          <Field
            label={phasesActive ? '起始月份（已忽略）' : '起始月份'}
            help={phasesActive ? '下面勾了生效阶段，月份就不再参与判断。保留数值只是为了取消阶段勾选后能恢复。' : undefined}
          >
            <SelectInput value={draft.monthFrom} onChange={(v) => setDraft({ ...draft, monthFrom: v })} options={MONTH_OPTIONS} />
          </Field>
          <Field label={phasesActive ? '结束月份（已忽略）' : '结束月份'} help={phasesActive ? undefined : '留空表示只在这一件事发生在起始月。'}>
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

        {/*
          限定生效阶段 = 「停用」的实现方式：
          把追肥规则限定在生长期/花芽分化期，休眠期它就自动不生效了。
        */}
        <Field
          label="限定生效阶段"
          help="不勾＝按上面的月份生效。勾了就忽略月份，只在植株处于所选阶段时生效 —— 这就是「什么时候停」的做法。"
        >
          <div className="row tight" style={{ flexWrap: 'wrap' }}>
            {CARE_PHASE_OPTIONS.map((opt) => {
              const on = draft.phases.includes(opt.value as CarePhase)
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`tag-toggle${on ? ' on' : ''}`}
                  title={CARE_PHASE_HINTS[opt.value as CarePhase]}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      phases: on ? draft.phases.filter((p) => p !== opt.value) : [...draft.phases, opt.value as CarePhase]
                    })
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </Field>
        {phasesActive ? (
          <Notice tone="warn">
            这条规则只在植株被标记为
            <b>{draft.phases.map((p) => CARE_PHASE_LABELS[p]).join(' 或 ')}</b>
            时生效，且<b>不再看月份</b>。植株没标记阶段时它不会产生任何任务。
          </Notice>
        ) : (
          <div className="small muted" style={{ marginBottom: 8 }}>
            覆盖月份：
            {monthsCovered({ monthFrom: Number(draft.monthFrom), monthTo: draft.monthTo ? Number(draft.monthTo) : null })
              .map((m) => `${m}月`)
              .join('、') || '—'}
          </div>
        )}

        <div className="form-grid">
          <Field label="重复间隔（天）" help="留空＝区间内每月一条。填 7~10 这类值可表达「每 7~10 天一轮」的真实节奏。">
            <TextInput
              value={draft.repeatDays}
              onChange={(v) => setDraft({ ...draft, repeatDays: v })}
              placeholder="留空＝每月一次"
            />
          </Field>
          <Field label="轮换步骤" help="每行一个，生成任务时按顺序循环。留空则不做轮换。">
            <TextArea
              value={draft.rotationText}
              onChange={(v) => setDraft({ ...draft, rotationText: v })}
              rows={3}
              placeholder={'花多多1号\n海藻精\n腐植酸水溶肥'}
            />
          </Field>
        </div>
        <Field label="说明">
          <TextInput value={draft.detail} onChange={(v) => setDraft({ ...draft, detail: v })} placeholder="具体怎么做…" />
        </Field>

        <div className="row">
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button onClick={() => setDraft(null)}>取消</Button>
        </div>
      </Panel>
    )
  }

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

        {/* 新增的表单留在上方：触发它的按钮就在这里 */}
        {draft && !draft.id ? ruleForm() : (
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
                <th style={{ width: 120 }}>适用于</th>
                <th style={{ width: 118 }}>生效时机</th>
                <th style={{ width: 74 }}>动作</th>
                <th>内容</th>
                <th style={{ width: 50 }}>优先级</th>
                {/* 窄了「编辑 / 删除」会折成两行，看着像两个独立操作 */}
                <th style={{ width: 132 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const phased = rule.activePhases !== null && rule.activePhases.length > 0
                return (
                  <Fragment key={rule.id}>
                    <tr>
                      <td className="small">
                        {rule.speciesKey === UNIVERSAL_SPECIES_KEY ? (
                          <Badge tone="info">通用</Badge>
                        ) : (
                          <b>{rule.speciesKey}</b>
                        )}
                      </td>
                      {/*
                        限定阶段的规则会忽略月份，这时再显示「3~6 月」是误导 ——
                        直接显示阶段，并注明月份不生效。
                      */}
                      <td className="small">
                        {phased ? (
                          <div className="row tight" style={{ flexWrap: 'wrap' }}>
                            {rule.activePhases?.map((p) => (
                              <Badge key={p} tone="ok">
                                {CARE_PHASE_ICONS[p]} {CARE_PHASE_LABELS[p]}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <>{monthsCovered(rule).join('/')} 月</>
                        )}
                        {rule.repeatDays ? <div className="muted">每 {rule.repeatDays} 天</div> : null}
                        {phased ? (
                          <div className="muted" title={`规则里写的是 ${monthsCovered(rule).join('/')} 月，但限定生效阶段后不再参与判断`}>
                            不看月份
                          </div>
                        ) : null}
                      </td>
                      <td className="small">{CARE_ACTION_LABELS[rule.actionType]}</td>
                      <td>
                        <b>{rule.title}</b>
                        {rule.detail ? <div className="small muted">{rule.detail}</div> : null}
                        {rule.rotation && rule.rotation.length > 0 ? (
                          <div className="small muted">轮换：{rule.rotation.join(' → ')}</div>
                        ) : null}
                        {!rule.verified ? <Badge tone="ai">未核实</Badge> : null}
                      </td>
                      <td className="small">{rule.priority}</td>
                      <td>
                        <div className="row tight">
                          <Button
                            size="small"
                            onClick={() => setDraft(draft?.id === rule.id ? null : draftFrom(rule))}
                          >
                            {draft?.id === rule.id ? '收起' : '编辑'}
                          </Button>
                          <Button size="small" variant="ghost" onClick={() => void remove(rule)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {/* 编辑表单就地展开在这一行下面，不用来回滚 */}
                    {draft?.id === rule.id ? (
                      <tr className="rule-edit-row">
                        <td colSpan={6}>{ruleForm()}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
