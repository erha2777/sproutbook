/**
 * AI 草稿审核对话框。
 *
 * 这是 AI 功能最重要的一个界面：AI 的结果**永远不直接落库**，
 * 必须在这里逐字段确认。安全字段（毒性等）额外高亮提醒。
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiAutofillResult, FieldDefinition } from '@core/types'
import { formatFieldValue } from '@core/fieldTypes'
import { Badge, Button, Modal, Notice, cx } from './ui'

export interface AiDraftDialogProps {
  result: AiAutofillResult
  defs: FieldDefinition[]
  onApply: (selectedKeys: string[], values: Record<string, unknown>) => void
  onClose: () => void
}

export function AiDraftDialog({ result, defs, onApply, onClose }: AiDraftDialogProps): ReactNode {
  const defMap = useMemo(() => new Map(defs.map((d) => [d.key, d])), [defs])

  // 默认勾选：置信度尚可、且不是「低置信度的安全字段」
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const draft of result.drafts) {
      if (draft.needsReview && draft.confidence < 0.6) continue
      initial.add(draft.fieldKey)
    }
    return initial
  })

  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const safetyCount = result.drafts.filter((d) => d.needsReview).length

  const apply = (): void => {
    const values: Record<string, unknown> = {}
    for (const draft of result.drafts) {
      if (selected.has(draft.fieldKey)) values[draft.fieldKey] = draft.value
    }
    onApply([...selected], values)
  }

  return (
    <Modal
      title={`AI 补全草稿 · ${result.speciesName}`}
      onClose={onClose}
      headerExtra={<Badge tone="ai">模型 {result.model ?? '未知'}</Badge>}
      footer={
        <>
          <span className="small muted">
            已选 <b>{selected.size}</b> / {result.drafts.length} 项
          </span>
          <span className="spacer" />
          <Button size="small" onClick={() => setSelected(new Set(result.drafts.map((d) => d.fieldKey)))}>
            全选
          </Button>
          <Button
            size="small"
            onClick={() => setSelected(new Set(result.drafts.filter((d) => d.confidence >= 0.8).map((d) => d.fieldKey)))}
          >
            仅高置信度
          </Button>
          <Button size="small" onClick={() => setSelected(new Set())}>
            全不选
          </Button>
          <Button variant="primary" onClick={apply} disabled={selected.size === 0}>
            应用所选 {selected.size} 项
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <Notice tone="info">{result.message}</Notice>

        {safetyCount > 0 ? (
          <Notice tone="warn">
            其中 <b>{safetyCount}</b> 项是<b>安全相关字段</b>（毒性、有毒部位、急救等）。
            AI 在这类信息上可能出错，请务必对照可靠资料核实后再保存 —— 应用不会替你自动确认。
          </Notice>
        ) : null}

        <div>
          {result.drafts.map((draft) => {
            const def = defMap.get(draft.fieldKey)
            const on = selected.has(draft.fieldKey)
            return (
              <div key={draft.fieldKey} className={cx('draft-row')}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(draft.fieldKey)}
                  style={{ width: 18, height: 18, accentColor: 'var(--green)', marginTop: 4, cursor: 'pointer' }}
                />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{draft.label}</div>
                  <div className="row tight" style={{ marginTop: 3 }}>
                    <span className="confidence-bar" title={`置信度 ${(draft.confidence * 100).toFixed(0)}%`}>
                      <span
                        style={{
                          width: `${Math.round(draft.confidence * 100)}%`,
                          background: draft.confidence >= 0.8 ? 'var(--green)' : draft.confidence >= 0.6 ? 'var(--gold)' : 'var(--red)'
                        }}
                      />
                    </span>
                    <span className="small muted">{(draft.confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div>
                  <div className="row tight">
                    {def ? <Badge tone="muted">{def.type}</Badge> : null}
                    {draft.needsReview ? <Badge tone="safety">需核实</Badge> : null}
                    {draft.willOverwrite ? <Badge tone="warn">将覆盖</Badge> : null}
                  </div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {def ? formatFieldValue(def, draft.value) : JSON.stringify(draft.value)}
                  </div>
                  {draft.willOverwrite && draft.currentValue !== null && def ? (
                    <div className="draft-current">当前值：{formatFieldValue(def, draft.currentValue)}</div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

        {result.raw ? (
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              查看模型原始输出（解析失败时用于排查）
            </summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
              {result.raw}
            </pre>
          </details>
        ) : null}
      </div>
    </Modal>
  )
}
