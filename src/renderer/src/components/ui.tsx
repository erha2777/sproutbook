/**
 * 通用像素风 UI 组件。
 * 刻意保持极简：不引入 UI 框架，全部用受控组件 + 原生元素。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { formatMonthSet, normalizeMonths } from '@core/fieldTypes'
import { PixelIcon } from './PixelIcon'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// 基础容器
// ---------------------------------------------------------------------------

export function Panel({ children, className, flat }: { children: ReactNode; className?: string; flat?: boolean }): ReactNode {
  return <div className={cx('pixel-panel', flat && 'flat', className)}>{children}</div>
}

export function Sign({ children }: { children: ReactNode }): ReactNode {
  return <div className="pixel-sign">{children}</div>
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <h3 className="section-title">
      <span>{children}</span>
      <span className="spacer" />
      {right}
    </h3>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'safety' | 'ai' | 'ok' | 'warn' | 'info' | 'muted' }): ReactNode {
  return <span className={cx('pixel-badge', tone)}>{children}</span>
}

const NOTICE_GLYPH: Record<string, string> = { danger: '×', warn: '!', ok: '✓', info: 'i' }

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'danger' | 'ok' }): ReactNode {
  return (
    <div className={cx('notice', tone)}>
      <span className={cx('notice-glyph', tone)}>{NOTICE_GLYPH[tone]}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

/**
 * 空状态。
 *
 * `icon` 是 PixelIcon 的名字（`garden` / `calendar` / `journal` …），不再收 emoji ——
 * 彩色圆角 emoji 放在木框和像素图标中间太出戏。
 */
export function EmptyState({ icon = 'garden', title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="empty-state">
      <div className="big">
        <PixelIcon name={icon} size={46} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
      {hint ? <div className="small" style={{ maxWidth: 460 }}>{hint}</div> : null}
      {action}
    </div>
  )
}

/**
 * 读取失败时的占位。
 *
 * ## 为什么不能沿用 EmptyState
 *
 * 「加载失败」和「确实没有数据」在界面上长得一样，但意思完全相反：
 * 前者是"我不知道你有没有数据"，后者是"你确实没有"。
 *
 * 原来四个页面（花园 / 物种库 / 模板 / 配方）失败时都只弹一条 toast，
 * 然后 `finally { setLoading(false) }`，页面主体照旧显示
 * **「花园里还没有植物」+ 一个「新增」按钮** —— toast 几秒后消失，
 * 留下的是那句关于数据的断言。**用户会以为数据丢了，然后重复录入。**
 *
 * 所以这里显示的是"读不出来"，并且给一个重试入口，
 * **绝不给「新增」的主按钮** —— 那等于在鼓励用户往一个可能只是读不到的库里再写一份。
 */
export function LoadFailure({
  what,
  detail,
  onRetry
}: {
  /** 读不出来的是什么，例如「植株列表」 */
  what: string
  detail?: string | null
  onRetry?: () => void
}): ReactNode {
  return (
    <Panel>
      <EmptyState
        icon="warn"
        title={`${what}读取失败`}
        hint={
          `这不是「没有数据」，而是没读到 —— 你的数据可能还在。` +
          (detail ? `（${detail}）` : '')
        }
        action={
          onRetry ? (
            <Button variant="primary" onClick={onRetry}>
              重试
            </Button>
          ) : null
        }
      />
    </Panel>
  )
}
export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <span className="row tight" style={{ gap: 7 }}>
      <span className="spinner" />
      {label ? <span className="small">{label}</span> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'normal' | 'small'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}

export function Button({ children, onClick, variant = 'default', size = 'normal', disabled, title, type = 'button' }: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      className={cx('pixel-btn', variant !== 'default' && variant, size === 'small' && 'small')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// 表单控件
// ---------------------------------------------------------------------------

export function Field({
  label,
  help,
  error,
  required,
  wide,
  badges,
  children
}: {
  label: string
  help?: string | null
  error?: string | null
  required?: boolean
  wide?: boolean
  badges?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div className={cx('field', wide && 'wide')}>
      <label className="field-label">
        <span>
          {label}
          {required ? <span className="required-star"> *</span> : null}
        </span>
        {badges}
      </label>
      {children}
      {help ? <div className="field-help">{help}</div> : null}
      {error ? <div className="field-error">{error}</div> : null}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  type = 'text',
  autoFocus
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  type?: string
  /** 呈现后就聚焦。用于「点了按钮才出现、出现就是为了让你打字」的输入框 */
  autoFocus?: boolean
}): ReactNode {
  return (
    <input
      className={cx('pixel-input', invalid && 'invalid')}
      value={value}
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    />
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows,
  invalid,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  invalid?: boolean
  disabled?: boolean
}): ReactNode {
  return (
    <textarea
      className={cx('pixel-textarea', invalid && 'invalid')}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
    />
  )
}

export function SelectInput({
  value,
  onChange,
  options,
  placeholder,
  invalid,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
}): ReactNode {
  return (
    <select
      className={cx('pixel-select', invalid && 'invalid')}
      value={value}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
}): ReactNode {
  return (
    <label className="checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label ? <span>{label}</span> : null}
    </label>
  )
}

export function CheckChips({
  values,
  onChange,
  options,
  disabled
}: {
  values: string[]
  onChange: (values: string[]) => void
  options: string[]
  disabled?: boolean
}): ReactNode {
  const toggle = (option: string): void => {
    if (disabled) return
    onChange(values.includes(option) ? values.filter((v) => v !== option) : [...values, option])
  }
  return (
    <div className="check-grid">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={cx('check-chip', values.includes(option) && 'on')}
          onClick={() => toggle(option)}
          disabled={disabled}
        >
          {values.includes(option) ? '✓ ' : ''}
          {option}
        </button>
      ))}
    </div>
  )
}

/** 自由多值输入：回车或逗号确认，可逐个删除。 */
export function TagInput({
  values,
  onChange,
  placeholder,
  disabled
}: {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  disabled?: boolean
}): ReactNode {
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    const parts = draft
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) {
      setDraft('')
      return
    }
    const next = Array.from(new Set([...values, ...parts]))
    onChange(next)
    setDraft('')
  }

  return (
    <div className="row tight" style={{ alignItems: 'center' }}>
      {values.map((v) => (
        <span key={v} className="pixel-tag">
          {v}
          <button
            type="button"
            className="pixel-btn ghost small"
            style={{ padding: '0 3px', fontSize: 11 }}
            onClick={() => onChange(values.filter((x) => x !== v))}
            disabled={disabled}
            title="移除"
          >
            ✕
          </button>
        </span>
      ))}
      <input
        className="pixel-input"
        style={{ width: 168 }}
        value={draft}
        placeholder={placeholder ?? '输入后回车'}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

/**
 * 月份选择器：点哪个月就切换哪个月，可以选任意多段。
 *
 * 之所以不是「选起点 + 选终点」：很多植物一年开两次
 * （月季 4~6 月 + 9~11 月），夏天和冬天各休眠一次的也不少，
 * 单个连续区间根本表达不了。区间只是本控件的一种用法，不是限制。
 */
export function MonthSetInput({
  value,
  onChange,
  disabled
}: {
  value: number[] | null
  onChange: (value: number[] | null) => void
  disabled?: boolean
}): ReactNode {
  const active = useMemo(() => normalizeMonths(value), [value])

  const toggle = (month: number): void => {
    if (disabled) return
    const next = active.includes(month)
      ? active.filter((m) => m !== month)
      : [...active, month].sort((a, b) => a - b)
    onChange(next.length > 0 ? next : null)
  }

  return (
    <div className="month-picker">
      <div className="month-strip">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <button
            key={m}
            type="button"
            disabled={disabled}
            className={cx('month-cell', active.includes(m) && 'in-range')}
            onClick={() => toggle(m)}
            title={`点击切换 ${m} 月`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="row tight">
        <span className="small muted">{active.length > 0 ? formatMonthSet(active) : '未设置'}</span>
        <span className="spacer" />
        <Button
          size="small"
          variant="ghost"
          onClick={() => onChange(Array.from({ length: 12 }, (_, i) => i + 1))}
          disabled={disabled}
          title="选择全部 12 个月"
        >
          全年
        </Button>
        {active.length > 0 ? (
          <Button size="small" variant="ghost" onClick={() => onChange(null)} disabled={disabled}>
            清除
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** 数值区间（如光照 6~8 小时）。 */
export function NumberRangeInput({
  value,
  onChange,
  unit,
  min,
  max,
  disabled
}: {
  value: { min: number | null; max: number | null } | null
  onChange: (value: { min: number | null; max: number | null } | null) => void
  unit?: string | null
  min?: number
  max?: number
  disabled?: boolean
}): ReactNode {
  const set = (key: 'min' | 'max', raw: string): void => {
    const parsed = raw.trim() === '' ? null : Number(raw)
    const next = { min: value?.min ?? null, max: value?.max ?? null, [key]: Number.isFinite(parsed as number) ? parsed : null }
    if (next.min === null && next.max === null) onChange(null)
    else onChange(next)
  }

  return (
    <div className="row tight" style={{ flexWrap: 'nowrap' }}>
      <input
        className="pixel-input"
        style={{ width: 82 }}
        type="number"
        step="any"
        min={min}
        max={max}
        value={value?.min ?? ''}
        disabled={disabled}
        onChange={(e) => set('min', e.target.value)}
        placeholder="最小"
      />
      <span className="muted">~</span>
      <input
        className="pixel-input"
        style={{ width: 82 }}
        type="number"
        step="any"
        min={min}
        max={max}
        value={value?.max ?? ''}
        disabled={disabled}
        onChange={(e) => set('max', e.target.value)}
        placeholder="最大"
      />
      {unit ? <span className="small muted">{unit}</span> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

export function Modal({
  title,
  children,
  footer,
  onClose,
  narrow,
  headerExtra
}: {
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  narrow?: boolean
  headerExtra?: ReactNode
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={cx('pixel-frame', 'modal', narrow && 'narrow')}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          {headerExtra}
          <Button size="small" variant="ghost" onClick={onClose} title="关闭">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 提示
// ---------------------------------------------------------------------------

export interface ToastItem {
  id: number
  message: string
  tone: 'info' | 'error' | 'success'
}

interface ToastContextValue {
  push: (message: string, tone?: ToastItem['tone']) => void
}

const ToastContext = createContext<ToastContextValue>({ push: () => undefined })

export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const push = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = ++counter.current
    setItems((prev) => [...prev, { id, message, tone }])
    // 错误信息留久一点，避免用户没看清就消失
    const ttl = tone === 'error' ? 8000 : 3600
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), ttl)
  }, [])

  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {items.map((item) => (
          <div key={item.id} className={cx('toast', item.tone === 'error' && 'error', item.tone === 'success' && 'success')}>
            <span className={cx('notice-glyph', item.tone === 'error' ? 'danger' : item.tone === 'success' ? 'ok' : 'info')}>
              {item.tone === 'error' ? '×' : item.tone === 'success' ? '✓' : 'i'}
            </span>
            <span style={{ flex: 1 }}>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** 输入防抖，用于搜索框，避免每敲一个字就打一次数据库。 */
export function useDebounced<T>(value: T, delay = 260): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}
