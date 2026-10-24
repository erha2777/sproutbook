/**
 * 全年养护指南的「格式模板」管理。
 *
 * 模板 = 一段追加到提示词里的额外要求（「每月只写 1~2 条」「重点写病虫害」这种）。
 * 放在设置页，是因为它和对 AI 的其它配置是同一类东西；编辑植株时只负责挑一个。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareGuideTemplate } from '@core/careGuide'
import { Button, Notice, TextInput, useToast } from './ui'

export function CareGuideTemplates(): ReactNode {
  const toast = useToast()
  const [templates, setTemplates] = useState<CareGuideTemplate[]>([])
  const [activeId, setActiveId] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.careGuide.templates()
      setTemplates(r.templates)
      setActiveId(r.activeId)
      setDirty(false)
    } catch {
      // 读不到就空着
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (id: string, p: Partial<CareGuideTemplate>): void => {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)))
    setDirty(true)
  }

  const addTemplate = (): void => {
    setTemplates((prev) => [
      ...prev,
      { id: `t-${Date.now()}`, name: `新模板 ${prev.length + 1}`, instruction: '' }
    ])
    setDirty(true)
  }

  const removeTemplate = (id: string): void => {
    if (templates.length <= 1) {
      toast.push('至少留一个模板', 'error')
      return
    }
    setTemplates((prev) => prev.filter((t) => t.id !== id))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.careGuide.saveTemplates(templates)
      setTemplates(r.templates)
      setActiveId(r.activeId)
      setDirty(false)
      toast.push('模板已保存', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const setActive = async (id: string): Promise<void> => {
    setActiveId(id)
    try {
      await window.api.careGuide.setActive(id)
    } catch {
      // 存不上就下次再说，界面上的选中已经变了
    }
  }

  return (
    <div className="content-inner">
      <Notice tone="info">
        生成全年养护指南时，「格式模板」里的要求会追加到提示词后面。默认用哪一个，在编辑植株的指南区也能改。
      </Notice>

      {templates.map((t) => (
        <div key={t.id} className="care-guide-template">
          <div className="row tight" style={{ marginBottom: 4 }}>
            <label className="row tight" style={{ gap: 4 }}>
              <input
                type="radio"
                name="care-guide-template"
                checked={activeId === t.id}
                onChange={() => void setActive(t.id)}
                title="设为默认模板"
              />
              <span className="small muted">默认</span>
            </label>
            <div style={{ width: 180 }}>
              <TextInput value={t.name} onChange={(v) => patch(t.id, { name: v })} placeholder="模板名" />
            </div>
            <span className="spacer" />
            <Button size="small" variant="ghost" onClick={() => removeTemplate(t.id)}>
              删除
            </Button>
          </div>
          <textarea
            className="pixel-input"
            rows={2}
            value={t.instruction}
            placeholder="追加到提示词里的额外要求，例如「每月只写 1~2 条最关键的」"
            onChange={(e) => patch(t.id, { instruction: e.target.value })}
          />
        </div>
      ))}

      <div className="row tight" style={{ marginTop: 8 }}>
        <Button size="small" onClick={addTemplate}>
          ＋ 新增模板
        </Button>
        <span className="spacer" />
        <Button size="small" variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? '保存中…' : dirty ? '保存模板' : '已保存'}
        </Button>
      </div>
    </div>
  )
}
