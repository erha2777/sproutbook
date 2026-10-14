/**
 * 养护规则库管理。
 *
 * 规则是「哪个月该做什么」的知识，不是排期 —— 所以这里只填月份区间，
 * 不填具体日期。生成任务时会自动展开成每月一条并带上时间窗。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  isUniversalRule,
  monthsCovered
} from '@core/care'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextArea, TextInput, useToast } from './ui'

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))

interface Draft {
  id?: number
  /** 适用的物种名。含 '*' 表示所有植物 */
  speciesKeys: string[]
  monthFrom: string
  monthTo: string
  repeatDays: string
  /**
   * 跨月区间里只做一次。
   * 原来「10~11 月」会生成两条任务，但底肥一季只埋一次 ——
   * 那时只能把区间收窄到单月绕过，规则本身表达不了「这个窗口里做一次就够」。
   */
  oncePerWindow: boolean
  /** 绑定的配方 id（字符串形式便于 select），空＝没有材料清单 */
  recipeId: string
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
  speciesKeys: [UNIVERSAL_SPECIES_KEY],
  monthFrom: '3',
  monthTo: '',
  repeatDays: '',
  oncePerWindow: false,
  recipeId: '',
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
  /** 手填的物种名（库里还没有的那些） */
  const [newSpecies, setNewSpecies] = useState('')
  /**
   * 可以绑到规则上的配方。
   *
   * 目前用户的配方库是空的 —— 这不是错误状态，配方是可选的，
   * 没配方时规则照旧只靠正文说明。选了配方，任务上就会直接显示材料清单。
   */
  const [recipes, setRecipes] = useState<Array<{ id: number; name: string; kind: string }>>([])
  /** 就地展开的表单行：展开后要滚进视野，否则点靠底部的规则时表单在屏幕外 */
  const formRowRef = useRef<HTMLTableRowElement | null>(null)

  useEffect(() => {
    if (!draft?.id) return
    // block:'nearest' 只滚最小距离，不会把用户已经看到的内容顶走
    formRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [draft?.id])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await window.api.care.rules())
      // 配方列表单独取；取不到也不该让整页报错（用户可能一个配方都没有）
      try {
        const list = await window.api.recipes.list()
        setRecipes(list.map((r) => ({ id: r.id, name: r.name, kind: r.kind })))
      } catch {
        setRecipes([])
      }
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
        speciesKeys: draft.speciesKeys.length > 0 ? draft.speciesKeys : [UNIVERSAL_SPECIES_KEY],
        hemisphere: 'N',
        climateZone: null,
        monthFrom: Number(draft.monthFrom),
        monthTo: draft.monthTo ? Number(draft.monthTo) : null,
        repeatDays: draft.repeatDays.trim() ? Number(draft.repeatDays) : null,
        oncePerWindow: draft.oncePerWindow,
        recipeId: draft.recipeId ? Number(draft.recipeId) : null,
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

  /** 从一条规则生成编辑草稿。 */
  const draftFrom = (rule: CareRule): Draft => ({
    id: rule.id,
    speciesKeys: rule.speciesKeys,
    monthFrom: String(rule.monthFrom),
    monthTo: rule.monthTo === null ? '' : String(rule.monthTo),
    repeatDays: rule.repeatDays === null ? '' : String(rule.repeatDays),
    oncePerWindow: rule.oncePerWindow,
    recipeId: rule.recipeId === null ? '' : String(rule.recipeId),
    rotationText: (rule.rotation ?? []).join('\n'),
    phases: rule.activePhases ?? [],
    actionType: rule.actionType,
    title: rule.title,
    detail: rule.detail ?? '',
    priority: String(rule.priority),
    verified: rule.verified
  })

  /**
   * 可选的物种名：库里的 + 这条规则已经选上的。
   *
   * 后者很重要 —— 用户参考里的绣球、杜鹃、蓝莓现在还没建物种，
   * 如果只能从库里选，这些规则根本没法录。所以下面还留了手填入口。
   */
  const selectableSpecies = (draft: Draft): string[] => {
    const set = new Set<string>([...speciesNames, ...draft.speciesKeys.filter((k) => k !== UNIVERSAL_SPECIES_KEY)])
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }

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
    const universalOn = draft.speciesKeys.includes(UNIVERSAL_SPECIES_KEY)
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
          <Field label="动作">
            <SelectInput
              value={draft.actionType}
              onChange={(v) => setDraft({ ...draft, actionType: v as CareActionType })}
              options={CARE_ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
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

        {/*
          适用物种支持多选。真实的底肥方案里多个物种共用一套配比
          （「绣球、无花果、月季」一套），单值会逼出「一物种一条规则」，
          改一次配比要改好几处。
        */}
        <Field
          label="适用于"
          help="可以同时选多个物种 —— 共用同一套做法的植物不必各建一条规则。"
        >
          <div className="row tight" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`pick-chip wide${universalOn ? ' on' : ''}`}
              onClick={() => setDraft({ ...draft, speciesKeys: universalOn ? [] : [UNIVERSAL_SPECIES_KEY] })}
            >
              🌍 所有植物
            </button>
          </div>
          {!universalOn ? (
            <>
              <div className="row tight" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                {selectableSpecies(draft).map((name) => {
                  const on = draft.speciesKeys.includes(name)
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`pick-chip${on ? ' on' : ''}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          speciesKeys: on ? draft.speciesKeys.filter((k) => k !== name) : [...draft.speciesKeys, name]
                        })
                      }
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
              <div className="row tight" style={{ marginTop: 6 }}>
                <div style={{ flex: 1 }}>
                  <TextInput
                    value={newSpecies}
                    onChange={setNewSpecies}
                    placeholder="物种还没建？直接输入名字，例如「绣球」"
                  />
                </div>
                <Button
                  disabled={!newSpecies.trim()}
                  onClick={() => {
                    const name = newSpecies.trim()
                    if (!name) return
                    setDraft({
                      ...draft,
                      speciesKeys: draft.speciesKeys.includes(name) ? draft.speciesKeys : [...draft.speciesKeys, name]
                    })
                    setNewSpecies('')
                  }}
                >
                  添加
                </Button>
              </div>
            </>
          ) : null}
        </Field>
        {/* 摘要一行：小字号下只靠颜色分辨选中与否太吃力 */}
        <div className="small" style={{ marginBottom: 8 }}>
          这条规则将作用于：
          <b>{universalOn ? '所有植物' : draft.speciesKeys.length > 0 ? draft.speciesKeys.join('、') : '（还没选）'}</b>
        </div>
        {!universalOn && draft.speciesKeys.length === 0 ? (
          <Notice tone="warn">还没有选任何物种 —— 这条规则不会对任何植物生效。</Notice>
        ) : null}

        <div className="form-grid">
          <Field
            label={phasesActive ? '起始月份（已忽略）' : '起始月份'}
            help={phasesActive ? '下面勾了生效阶段，月份就不再参与判断。保留数值只是为了取消阶段勾选后能恢复。' : undefined}
          >
            <SelectInput value={draft.monthFrom} onChange={(v) => setDraft({ ...draft, monthFrom: v })} options={MONTH_OPTIONS} />
          </Field>
          <Field
            label={phasesActive ? '结束月份（已忽略）' : '结束月份'}
            help={phasesActive ? undefined : '留空表示只在这一件事发生在起始月。'}
          >
            <SelectInput
              value={draft.monthTo}
              onChange={(v) => setDraft({ ...draft, monthTo: v })}
              placeholder="（仅起始月）"
              options={[{ value: '', label: '（仅起始月）' }, ...MONTH_OPTIONS]}
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
                  className={`pick-chip${on ? ' on' : ''}`}
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
          {/*
            频率用「一次」这个说法而不是「只做一次」：
            规则本来就分「每月一条」「每 N 天一轮」「这一段里做一次」三种，
            三者摆在一起才看得懂在选什么。
          */}
          <Field
            label="多久做一次"
            help="「这段里一次」= 跨月区间只生成一条任务（底肥这类一季只做一次的事）；「每隔 N 天」适合浇水、打药这类节奏。"
          >
            <SelectInput
              value={draft.repeatDays.trim() ? 'every' : draft.oncePerWindow ? 'once' : 'monthly'}
              onChange={(v) => {
                if (v === 'every') setDraft({ ...draft, oncePerWindow: false, repeatDays: draft.repeatDays || '7' })
                else if (v === 'once') setDraft({ ...draft, oncePerWindow: true, repeatDays: '' })
                else setDraft({ ...draft, oncePerWindow: false, repeatDays: '' })
              }}
              options={[
                { value: 'monthly', label: '区间内每月一次' },
                { value: 'once', label: '整段里只做一次' },
                { value: 'every', label: '每隔 N 天' }
              ]}
            />
          </Field>
          {draft.repeatDays.trim() ? (
            <Field label="间隔天数" help="7~10 天是大多数追肥的真实节奏。相邻两次不会共用判定窗口。">
              <TextInput
                value={draft.repeatDays}
                onChange={(v) => setDraft({ ...draft, repeatDays: v })}
                placeholder="7"
              />
            </Field>
          ) : null}
          <Field
            label="绑定配方"
            help={
              recipes.length === 0
                ? '配方库还是空的。到「配方」页建一个（比如「月季底肥 = 羊粪 + 骨粉」），这里就能选了。'
                : '绑上之后，生成的任务会直接列出材料清单，不用再去翻正文。'
            }
          >
            <SelectInput
              value={draft.recipeId}
              onChange={(v) => setDraft({ ...draft, recipeId: v })}
              placeholder="（不绑定）"
              options={[{ value: '', label: '（不绑定）' }, ...recipes.map((r) => ({ value: String(r.id), label: `${r.name}（${r.kind}）` }))]}
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
                        {isUniversalRule(rule.speciesKeys) ? (
                          <Badge tone="info">🌍 所有植物</Badge>
                        ) : (
                          <div className="row tight" style={{ flexWrap: 'wrap' }}>
                            {rule.speciesKeys.map((k) => (
                              <Badge key={k} tone="muted">
                                {k}
                              </Badge>
                            ))}
                          </div>
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
                        {rule.repeatDays ? (
                          <div className="muted">每 {rule.repeatDays} 天</div>
                        ) : rule.oncePerWindow ? (
                          <div className="muted" title="跨月区间只生成一条任务，落在窗口开头">
                            整段只做一次
                          </div>
                        ) : null}
                        {rule.recipeId ? (
                          <div className="muted" title="生成的任务会直接列出这份配方">
                            📋 {recipes.find((r) => r.id === rule.recipeId)?.name ?? `配方 #${rule.recipeId}`}
                          </div>
                        ) : null}
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
                      <tr className="rule-edit-row" ref={formRowRef}>
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
