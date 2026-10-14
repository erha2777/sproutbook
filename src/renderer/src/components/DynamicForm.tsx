/**
 * 动态表单 —— 完全由 field_definitions 驱动。
 *
 * 这是「可编辑模板」在界面上的体现：用户在模板页加一个字段，
 * 这里立刻多出一个输入项，不需要改任何前端代码。
 */

import type { ReactNode } from 'react'
import type { FieldDefinition, FieldValue, MonthRange, NumberRange } from '@core/types'
import { CheckChips, Checkbox, Field, MonthRangeInput, NumberRangeInput, SelectInput, TagInput, TextArea, TextInput, Badge, cx } from './ui'

export type FormValues = Record<string, unknown>

interface FieldValueInputProps {
  def: FieldDefinition
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  invalid?: boolean
}

function FieldValueInput({ def, value, onChange, disabled, invalid }: FieldValueInputProps): ReactNode {
  switch (def.type) {
    case 'longtext':
      return (
        <TextArea
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          placeholder={def.helpText ?? ''}
          rows={3}
          disabled={disabled}
          invalid={invalid}
        />
      )

    case 'number':
      return (
        <div className="row tight" style={{ flexWrap: 'nowrap' }}>
          <input
            className={cx('pixel-input', invalid && 'invalid')}
            type="number"
            step="any"
            disabled={disabled}
            value={value === null || value === undefined || value === '' ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
          {def.unit ? <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{def.unit}</span> : null}
        </div>
      )

    case 'bool':
      return (
        <Checkbox
          checked={value === true}
          onChange={(checked) => onChange(checked)}
          label={value === true ? '是' : '否'}
        />
      )

    case 'select':
      return (
        <SelectInput
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v === '' ? null : v)}
          placeholder="（未设置）"
          invalid={invalid}
          disabled={disabled}
          options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      )

    case 'multiselect':
      return (
        <CheckChips
          values={Array.isArray(value) ? (value as string[]) : []}
          onChange={(v) => onChange(v.length ? v : null)}
          options={def.options ?? []}
          disabled={disabled}
        />
      )

    case 'tags':
      return (
        <TagInput
          values={Array.isArray(value) ? (value as string[]) : []}
          onChange={(v) => onChange(v.length ? v : null)}
          disabled={disabled}
        />
      )

    case 'month_range':
      return (
        <MonthRangeInput
          value={isMonthRange(value) ? value : null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )

    case 'hours_range':
      return (
        <NumberRangeInput
          value={isNumberRange(value) ? value : null}
          onChange={(v) => onChange(v)}
          unit={def.unit}
          min={0}
          disabled={disabled}
        />
      )

    case 'date':
      return (
        <input
          className={cx('pixel-input', invalid && 'invalid')}
          type="date"
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      )

    case 'image':
      return (
        <div className="small muted" style={{ padding: '6px 0' }}>
          图片请在下方「图片」区域上传管理
        </div>
      )

    case 'link':
    default:
      return (
        <TextInput
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v === '' ? null : v)}
          placeholder={def.helpText ?? ''}
          disabled={disabled}
          invalid={invalid}
        />
      )
  }
}

function isMonthRange(value: unknown): value is MonthRange {
  return Boolean(value) && typeof value === 'object' && 'from' in (value as object) && 'to' in (value as object)
}

function isNumberRange(value: unknown): value is NumberRange {
  return Boolean(value) && typeof value === 'object' && ('min' in (value as object) || 'max' in (value as object))
}

// ---------------------------------------------------------------------------

export interface DynamicFormProps {
  defs: FieldDefinition[]
  values: FormValues
  errors?: Record<string, string>
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
  /** 需要放在别处单独渲染的字段 key（例如图片由专门的图片区管理） */
  excludeKeys?: string[]
  /** 只渲染该分组内的字段；不传则渲染全部分组 */
  onlyGroups?: string[]
}

export function DynamicForm({
  defs,
  values,
  errors = {},
  onChange,
  disabled,
  excludeKeys = [],
  onlyGroups
}: DynamicFormProps): ReactNode {
  const active = defs.filter((d) => !d.archivedAt && !excludeKeys.includes(d.key))

  // 按 groupName 归组，保持定义顺序
  const groups: Array<{ name: string; fields: FieldDefinition[] }> = []
  for (const def of active) {
    if (onlyGroups && !onlyGroups.includes(def.groupName)) continue
    let group = groups.find((g) => g.name === def.groupName)
    if (!group) {
      group = { name: def.groupName, fields: [] }
      groups.push(group)
    }
    group.fields.push(def)
  }

  if (groups.length === 0) {
    return <div className="muted small">当前模板没有任何字段，请到「模板」页添加。</div>
  }

  return (
    <div className="content-inner">
      {groups.map((group) => (
        <div key={group.name}>
          <div className="section-title">
            <span>{group.name}</span>
            <span className="badge muted small muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
              {group.fields.length} 项
            </span>
          </div>
          <div className="form-grid">
            {group.fields.map((def) => (
              <Field
                key={def.key}
                label={def.label}
                help={def.helpText}
                error={errors[def.key] ?? null}
                required={def.isRequired}
                wide={def.type === 'longtext' || def.type === 'multiselect' || def.type === 'month_range'}
                badges={
                  <>
                    {def.isSafety ? <Badge tone="safety">安全字段</Badge> : null}
                    {def.isSystem ? <Badge tone="muted">系统</Badge> : null}
                  </>
                }
              >
                <FieldValueInput
                  def={def}
                  value={values[def.key]}
                  onChange={(v) => onChange(def.key, v)}
                  disabled={disabled}
                  invalid={Boolean(errors[def.key])}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 把领域对象上的属性整理成表单值（补上系统列的当前值）。 */
export function toFormValues(attributes: Record<string, FieldValue>, columns: Record<string, unknown>): FormValues {
  const out: FormValues = { ...attributes }
  for (const [key, value] of Object.entries(columns)) {
    if (value === undefined || value === null) continue
    out[key] = value
  }
  return out
}
