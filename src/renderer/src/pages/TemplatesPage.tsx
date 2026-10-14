/**
 * 模板页 —— 信息模板的编辑器。
 *
 * 「可以编辑模板，用以新增信息」这条需求就落在这里：
 * 字段是数据而不是代码，加一个字段立刻在所有表单里生效。
 *
 * 安全约束（界面上也要讲清楚）：
 *  - 系统字段不可删除、不可改类型
 *  - 已被数据使用的字段只能归档，不能物理删除
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FieldDefinition, FieldOwner, FieldType, RelationTarget } from '@core/types'
import { RELATION_TARGETS } from '@core/types'
import { FIELD_TYPES } from '@core/fieldTypes'
import type { FieldUsageSummary } from '@shared/api'
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextArea, TextInput, cx, useToast } from '../components/ui'

export function TemplatesPage(): ReactNode {
  const toast = useToast()
  const [owner, setOwner] = useState<FieldOwner>('species')
  const [rows, setRows] = useState<FieldUsageSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<FieldUsageSummary | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await window.api.fields.usage(owner))
    } catch (error) {
      toast.push(`加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [owner, toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const visible = useMemo(() => rows.filter((r) => showArchived || !r.field.archivedAt), [rows, showArchived])

  const move = async (index: number, delta: number): Promise<void> => {
    const target = index + delta
    if (target < 0 || target >= visible.length) return
    const next = [...visible]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    try {
      await window.api.fields.reorder(
        owner,
        next.map((r) => r.field.id)
      )
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '排序失败', 'error')
    }
  }

  const setArchived = async (row: FieldUsageSummary, archived: boolean): Promise<void> => {
    try {
      await window.api.fields.setArchived(row.field.id, archived)
      toast.push(archived ? '已归档（数据保留）' : '已恢复', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '操作失败', 'error')
    }
  }

  const remove = async (row: FieldUsageSummary): Promise<void> => {
    if (!window.confirm(`确定永久删除字段「${row.field.label}」吗？此操作不可撤销。`)) return
    try {
      await window.api.fields.remove(row.field.id)
      toast.push('字段已删除', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  return (
    <div className="content-inner">
      <Panel>
        <div className="row">
          <div className="tabs" style={{ border: 'none' }}>
            <button className={cx('tab', owner === 'species' && 'active')} onClick={() => setOwner('species')}>
              物种信息模板
            </button>
            <button className={cx('tab', owner === 'plant' && 'active')} onClick={() => setOwner('plant')}>
              植株信息模板
            </button>
          </div>
          <span className="spacer" />
          <label className="checkline small">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            显示已归档
          </label>
          <Button variant="primary" onClick={() => setCreating(true)}>
            ＋ 新增字段
          </Button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          这里决定「植物信息」里有哪些项目。新增字段后，编辑页面会立刻出现对应输入框，不需要改代码。
        </div>
      </Panel>

      <Panel>
        {loading ? (
          <Spinner label="加载中…" />
        ) : visible.length === 0 ? (
          <EmptyState icon="🧩" title="还没有字段" hint="点击右上角「新增字段」开始定制你的信息模板。" />
        ) : (
          <table className="pixel-table">
            <thead>
              <tr>
                <th style={{ width: 88 }}>排序</th>
                <th>字段</th>
                <th style={{ width: 96 }}>类型</th>
                <th style={{ width: 82 }}>分组</th>
                <th style={{ width: 96 }}>已填记录</th>
                <th style={{ width: 172 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => {
                const f = row.field
                return (
                  <tr key={f.id} style={{ opacity: f.archivedAt ? 0.5 : 1 }}>
                    <td>
                      <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                        <Button size="small" variant="ghost" onClick={() => void move(index, -1)} disabled={index === 0} title="上移">
                          ▲
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => void move(index, 1)}
                          disabled={index === visible.length - 1}
                          title="下移"
                        >
                          ▼
                        </Button>
                      </div>
                    </td>
                    <td>
                      <div className="row tight">
                        <b>{f.label}</b>
                        {f.isRequired ? <Badge tone="warn">必填</Badge> : null}
                        {f.isSafety ? <Badge tone="safety">安全</Badge> : null}
                        {f.isSystem ? <Badge tone="muted">系统</Badge> : null}
                        {f.archivedAt ? <Badge tone="muted">已归档</Badge> : null}
                      </div>
                      <div className="small muted mono">
                        {f.key}
                        {f.unit ? ` · 单位 ${f.unit}` : ''}
                        {f.options && f.options.length > 0 ? ` · ${f.options.length} 个选项` : ''}
                      </div>
                      {f.helpText ? <div className="small muted">{f.helpText}</div> : null}
                    </td>
                    <td className="small">{FIELD_TYPES.find((t) => t.type === f.type)?.label ?? f.type}</td>
                    <td className="small">{f.groupName}</td>
                    <td className="small">{row.usage}</td>
                    <td>
                      <div className="row tight">
                        <Button size="small" onClick={() => setEditing(row)}>
                          编辑
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => void setArchived(row, !f.archivedAt)}>
                          {f.archivedAt ? '恢复' : '归档'}
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => void remove(row)}
                          disabled={f.isSystem || row.usage > 0}
                          title={f.isSystem ? '系统字段不可删除' : row.usage > 0 ? '已有数据使用，只能归档' : '永久删除'}
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {creating ? (
        <FieldEditorModal
          owner={owner}
          existing={rows.map((r) => r.field)}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void reload()
          }}
        />
      ) : null}

      {editing ? (
        <FieldEditorModal
          owner={owner}
          field={editing.field}
          usage={editing.usage}
          existing={rows.map((r) => r.field)}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : null}
    </div>
  )
}

function FieldEditorModal({
  owner,
  field,
  usage = 0,
  existing,
  onClose,
  onDone
}: {
  owner: FieldOwner
  field?: FieldDefinition
  usage?: number
  existing: FieldDefinition[]
  onClose: () => void
  onDone: () => void
}): ReactNode {
  const toast = useToast()
  const isEdit = Boolean(field)

  const [key, setKey] = useState(field?.key ?? '')
  const [label, setLabel] = useState(field?.label ?? '')
  const [groupName, setGroupName] = useState(field?.groupName ?? '其他')
  const [type, setType] = useState<FieldType>(field?.type ?? 'text')
  const [unit, setUnit] = useState(field?.unit ?? '')
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join('\n'))
  const [helpText, setHelpText] = useState(field?.helpText ?? '')
  const [isRequired, setIsRequired] = useState(field?.isRequired ?? false)
  const [isSafety, setIsSafety] = useState(field?.isSafety ?? false)
  const [relationTarget, setRelationTargetState] = useState<RelationTarget>(field?.relationTarget ?? 'environments')
  const [saving, setSaving] = useState(false)

  const needsOptions = type === 'select' || type === 'multiselect'
  const needsRelation = type === 'relation'
  const groups = useMemo(() => {
    const set = new Set(existing.map((f) => f.groupName))
    set.add('基础')
    set.add('形态')
    set.add('习性')
    set.add('养护')
    set.add('安全')
    set.add('其他')
    return [...set]
  }, [existing])

  const submit = async (): Promise<void> => {
    if (!label.trim()) {
      toast.push('请填写字段名称', 'error')
      return
    }
    const options = needsOptions
      ? optionsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : null

    setSaving(true)
    try {
      if (isEdit && field) {
        await window.api.fields.update(field.id, {
          label: label.trim(),
          groupName,
          type,
          unit: unit.trim() || null,
          options,
          helpText: helpText.trim() || null,
          isRequired,
          isSafety,
          relationTarget: needsRelation ? relationTarget : null
        })
        toast.push('字段已更新', 'success')
      } else {
        await window.api.fields.create({
          ownerKind: owner,
          key: key.trim(),
          label: label.trim(),
          groupName,
          type,
          unit: unit.trim() || null,
          options,
          helpText: helpText.trim() || null,
          isRequired,
          isSafety,
          relationTarget: needsRelation ? relationTarget : null
        })
        toast.push('字段已创建', 'success')
      }
      onDone()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={isEdit ? `编辑字段 · ${field?.label}` : '新增字段'}
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
        {isEdit && usage > 0 && type !== field?.type ? (
          <Notice tone="danger">
            该字段已有 <b>{usage}</b> 条记录填写过。改变类型后，旧数据可能无法按新类型解析（会显示为空或被拒绝）。
            如果不确定，建议新建一个字段而不是改类型。
          </Notice>
        ) : null}

        <div className="form-grid">
          <Field label="字段名称" required help="显示给用户看的中文名。">
            <TextInput value={label} onChange={setLabel} placeholder="例如：耐旱性" />
          </Field>

          <Field
            label="字段标识"
            required
            help={isEdit ? '创建后不可修改（改了等于丢掉已有数据）。' : '英文小写字母、数字、下划线。'}
          >
            <TextInput
              value={key}
              onChange={setKey}
              placeholder="例如：drought_tolerance"
              disabled={isEdit}
            />
          </Field>

          <Field label="类型" required help={FIELD_TYPES.find((t) => t.type === type)?.hint}>
            <SelectInput
              value={type}
              onChange={(v) => setType(v as FieldType)}
              options={FIELD_TYPES.map((t) => ({ value: t.type, label: `${t.label} — ${t.hint}` }))}
              disabled={field?.isSystem}
            />
          </Field>

          <Field label="分组" required help="决定它出现在编辑页的哪一块。">
            <SelectInput
              value={groupName}
              onChange={setGroupName}
              options={groups.map((g) => ({ value: g, label: g }))}
            />
          </Field>

          <Field label="单位（可选）" help="数字类型会显示在输入框右侧。">
            <TextInput value={unit} onChange={setUnit} placeholder="例如：℃ / 天 / cm" />
          </Field>

          <Field label="说明文字（可选）" wide>
            <TextInput value={helpText} onChange={setHelpText} placeholder="显示在输入框下方的小字提示" />
          </Field>

          {needsOptions ? (
            <Field label="可选项" wide help="每行一个选项。">
              <TextArea value={optionsText} onChange={setOptionsText} rows={5} placeholder={'无毒\n微毒\n有毒\n剧毒'} />
            </Field>
          ) : null}

          {needsRelation ? (
            <Field label="关联到" wide help="字段值会存对方记录的 ID。例如「养护位置」关联到位置档案。">
              <SelectInput
                value={relationTarget}
                onChange={(v) => setRelationTargetState(v as RelationTarget)}
                options={RELATION_TARGETS.map((t) => ({ value: t.value, label: t.label }))}
              />
            </Field>
          ) : null}
        </div>

        <div className="row">
          <label className="checkline">
            <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
            必填
          </label>
          <label className="checkline">
            <input type="checkbox" checked={isSafety} onChange={(e) => setIsSafety(e.target.checked)} />
            安全相关字段（AI 填充后必须人工核实）
          </label>
        </div>

        {!isEdit ? (
          <Notice tone="info">
            字段标识一旦创建就不可更改，请确认拼写。建议用英文小写下划线，例如 <span className="mono">drought_tolerance</span>。
          </Notice>
        ) : null}
      </div>
    </Modal>
  )
}
