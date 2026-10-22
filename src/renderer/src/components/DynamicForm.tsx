/**
 * 动态表单 —— 完全由 field_definitions 驱动。
 *
 * 这是「可编辑模板」在界面上的体现：用户在模板页加一个字段，
 * 这里立刻多出一个输入项，不需要改任何前端代码。
 */

import type { ReactNode } from 'react'
import type { FieldDefinition, FieldValue, NumberRange } from '@core/types'
import { normalizeMonths } from '@core/fieldTypes'
import { isFieldVisible } from '@core/attributes'
import { CheckChips, Checkbox, Field, MonthSetInput, NumberRangeInput, SearchSelect, SelectInput, TagInput, TextArea, TextInput, Badge, cx } from './ui'

export type FormValues = Record<string, unknown>

/**
 * 渲染字段时需要的外部上下文。
 *
 * 模板字段是「数据」，但有些字段的候选项来自别处：
 *  - relation 字段需要目标实体的列表（养护位置、物种库…）
 *  - select 的选项有时存的是键（如 growing），需要映射成给人看的文字
 * 这些不适合塞进 field_definitions，所以由调用方按需传入。
 */
export interface FieldContext {
  /** 按 relationTarget 索引的可选项 */
  relations?: Record<string, Array<{ id: number; label: string }>>
  /** 值 → 显示名。只影响显示，不影响存储 */
  labels?: Record<string, string>
  /** 按字段 key 给出「已有值」建议（仍允许自由输入），如植株分类 */
  suggestions?: Record<string, string[]>
}

interface FieldValueInputProps {
  def: FieldDefinition
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  invalid?: boolean
  context?: FieldContext
}

function FieldValueInput({ def, value, onChange, disabled, invalid, context }: FieldValueInputProps): ReactNode {
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
          // 选项可能存的是键（growing），按 labels 映射成给人看的文字
          options={(def.options ?? []).map((o) => ({ value: o, label: context?.labels?.[o] ?? o }))}
        />
      )

    case 'relation': {
      const options = (def.relationTarget ? context?.relations?.[def.relationTarget] : undefined) ?? []
      const mapped = options.map((o) => ({ value: String(o.id), label: o.label }))
      /*
       * 物种动辄几十上百条，用可搜索下拉；位置一般只有几个，保持原生下拉更省事。
       */
      if (def.relationTarget === 'species') {
        return (
          <SearchSelect
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(v) => onChange(v === '' ? null : Number(v))}
            placeholder={options.length === 0 ? '（暂无可选项）' : '点这里搜索物种…'}
            emptyHint="没有匹配的物种，换个关键字试试"
            invalid={invalid}
            disabled={disabled || options.length === 0}
            options={mapped}
          />
        )
      }
      return (
        <SelectInput
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(v) => onChange(v === '' ? null : Number(v))}
          placeholder={options.length === 0 ? '（暂无可选项）' : '（未关联）'}
          invalid={invalid}
          disabled={disabled || options.length === 0}
          options={mapped}
        />
      )
    }

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
        <MonthSetInput
          // 老数据可能是 {from,to}，normalizeMonths 一并接受
          value={normalizeMonths(value)}
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
    default: {
      /*
       * 文本字段也可以给"已有值"建议（如植株分类）。
       * 仍然允许自由输入 —— 建议只是省打字，不是白名单：
       * 第一次写「月季类」的时候它还不存在，不能因此拦着不让填。
       */
      const suggestions = context?.suggestions?.[def.key]
      if (suggestions && suggestions.length > 0) {
        return (
          <SearchSelect
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => onChange(v === '' ? null : v)}
            placeholder={def.helpText ?? '可以直接输入新的'}
            emptyHint="没有匹配的，按 Enter 用你输入的内容"
            invalid={invalid}
            disabled={disabled}
            allowCustom
            options={suggestions.map((s) => ({ value: s, label: s }))}
          />
        )
      }
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
  /** relation 候选列表与 select 显示名映射 */
  context?: FieldContext
}

export function DynamicForm({
  defs,
  values,
  errors = {},
  onChange,
  disabled,
  excludeKeys = [],
  onlyGroups,
  context
}: DynamicFormProps): ReactNode {
  /*
   * 按显示条件过滤。
   *
   * 只隐藏、不清值 —— 选了盆栽填好盆径、改成地栽再改回盆栽，盆径还在。
   * 清值会让用户在两个选项之间来回切一下就把数据弄丢，那比多留一个隐藏字段糟得多。
   *
   * 这里是两个编辑器（物种 / 植株）唯一的字段渲染入口，所以改一处就够。
   */
  const active = defs.filter(
    (d) => !d.archivedAt && !excludeKeys.includes(d.key) && isFieldVisible(d, values as Record<string, FieldValue>)
  )

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
                  context={context}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
