/**
 * 物种编辑页 —— 模板驱动的完整表单 + AI 自动补全（草稿 → 确认 → 落库）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiAutofillResult, FieldDefinition } from '@core/types'
import type { SpeciesListItem } from '@shared/api'
import { makeRequestId } from '../lib/util'
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, SectionTitle, Sign, Spinner, TextInput, cx, useToast } from '../components/ui'
import { DynamicForm } from '../components/DynamicForm'
import type { FormValues } from '../components/DynamicForm'
import { AiDraftDialog } from '../components/AiDraftDialog'
import { ImageStripWithHint } from '../components/ImageStrip'

export interface SpeciesEditorProps {
  speciesId: number | null
  onBack: () => void
  onSaved: (id: number) => void
}

export function SpeciesEditor({ speciesId, onBack, onSaved }: SpeciesEditorProps): ReactNode {
  const toast = useToast()
  const [defs, setDefs] = useState<FieldDefinition[]>([])
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [species, setSpecies] = useState<SpeciesListItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [currentId, setCurrentId] = useState<number | null>(speciesId)

  // AI 相关
  const [aiAvailable, setAiAvailable] = useState<{ hasKey: boolean; model: string }>({ hasKey: false, model: '' })
  const [showHints, setShowHints] = useState(false)
  const [hints, setHints] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiRequestId, setAiRequestId] = useState<string | null>(null)
  const [aiResult, setAiResult] = useState<AiAutofillResult | null>(null)
  /** 本次会话里由 AI 填入的字段及其置信度，保存时用于标记「待核实」 */
  const [aiFilled, setAiFilled] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [fieldDefs, settings] = await Promise.all([window.api.fields.list('species'), window.api.ai.getSettings()])
      setDefs(fieldDefs)
      setAiAvailable({ hasKey: settings.hasApiKey, model: settings.chatModel })

      if (speciesId !== null) {
        const data = await window.api.species.get(speciesId)
        if (!data) {
          toast.push('该物种不存在或已被删除', 'error')
          onBack()
          return
        }
        setSpecies(data)
        const initial: FormValues = { ...data.attributes }
        initial.common_name = data.commonName
        initial.scientific_name = data.scientificName ?? ''
        initial.family = data.family ?? ''
        initial.genus = data.genus ?? ''
        initial.aliases = data.aliases
        setValues(initial)
      } else {
        const initial: FormValues = {}
        for (const def of fieldDefs) {
          if (def.defaultValue !== null && def.defaultValue !== undefined) initial[def.key] = def.defaultValue
        }
        setValues(initial)
      }
    } catch (error) {
      toast.push(`加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [speciesId, toast, onBack])

  useEffect(() => {
    void load()
  }, [load])

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const plantName = typeof values.common_name === 'string' ? values.common_name.trim() : ''

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const aiFields = Object.entries(aiFilled).map(([key, confidence]) => ({ key, confidence }))
      const result = await window.api.species.save({
        id: currentId ?? undefined,
        values,
        aiFields: aiFields.length > 0 ? aiFields : undefined
      })
      if (Object.keys(result.errors).length > 0) {
        setErrors(result.errors)
        toast.push('有必填项或格式问题，请检查标红的字段', 'error')
        return
      }
      setCurrentId(result.species.id)
      setSpecies(result.species)
      setAiFilled({})
      if (result.pendingReview.length > 0) {
        toast.push(
          `已保存。有 ${result.pendingReview.length} 个安全字段来自 AI，已标记为「待核实」，请对照资料确认。`,
          'success'
        )
      } else {
        toast.push('已保存', 'success')
      }
      onSaved(result.species.id)
    } catch (error) {
      toast.push(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const runAutofill = async (): Promise<void> => {
    setShowHints(false)
    const requestId = makeRequestId()
    setAiRequestId(requestId)
    setAiBusy(true)
    try {
      const result = await window.api.ai.autofill({
        requestId,
        plantName,
        hints: hints.trim() || undefined,
        existing: values
      })
      if (!result.ok && result.drafts.length === 0) {
        toast.push(result.message, 'error')
        return
      }
      setAiResult(result)
    } catch (error) {
      toast.push(`AI 调用失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setAiBusy(false)
      setAiRequestId(null)
    }
  }

  const applyDrafts = (keys: string[], draftValues: Record<string, unknown>): void => {
    const confidence: Record<string, number> = {}
    for (const draft of aiResult?.drafts ?? []) {
      if (keys.includes(draft.fieldKey)) confidence[draft.fieldKey] = draft.confidence
    }
    setValues((prev) => ({ ...prev, ...draftValues }))
    setAiFilled((prev) => ({ ...prev, ...confidence }))
    setAiResult(null)
    toast.push(`已填入 ${keys.length} 个字段。检查后再点保存。`, 'success')
  }

  const verifySafety = async (): Promise<void> => {
    if (currentId === null) {
      toast.push('请先保存，再标记核实', 'error')
      return
    }
    const safetyKeys = defs.filter((d) => d.isSafety).map((d) => d.key)
    try {
      await window.api.species.verify(currentId, safetyKeys)
      const refreshed = await window.api.species.get(currentId)
      setSpecies(refreshed)
      toast.push('已标记安全字段为「已核实」', 'success')
    } catch (error) {
      toast.push(`标记失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const safetyPending = useMemo(() => {
    if (!species) return [] as string[]
    return Object.keys(species.confidence).filter((k) => !species.verifiedFields.includes(k))
  }, [species])

  if (loading) {
    return (
      <Panel>
        <Spinner label="加载中…" />
      </Panel>
    )
  }

  return (
    <div className="content-inner">
      <Panel>
        <div className="row">
          <Button onClick={onBack}>← 返回列表</Button>
          <Sign>{currentId === null ? '新增物种' : plantName || '未命名'}</Sign>
          <span className="spacer" />
          {aiBusy ? (
            <>
              <Spinner label="AI 生成中…" />
              <Button
                size="small"
                variant="danger"
                onClick={() => {
                  if (aiRequestId) void window.api.ai.cancel(aiRequestId)
                }}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => setShowHints(true)}
              disabled={!plantName || !aiAvailable.hasKey || !aiAvailable.model}
              title={
                !aiAvailable.hasKey
                  ? '尚未配置 API Key，请到「设置 → AI」'
                  : !aiAvailable.model
                    ? '尚未配置对话模型'
                    : !plantName
                      ? '请先填写植物名称'
                      : '用 AI 生成字段草稿'
              }
            >
              ✨ AI 补全信息
            </Button>
          )}
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>

        {!aiAvailable.hasKey ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="info">
              没有配置 AI 也能正常使用全部功能 —— AI 只是用来省去查资料的时间。
              想启用请到「设置 → AI」填写 API Key 与模型。
            </Notice>
          </div>
        ) : null}

        {safetyPending.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">
              有 <b>{safetyPending.length}</b> 个安全相关字段是 AI 填写的，尚未人工核实。请对照可靠资料确认后再点
              <Button size="small" variant="ghost" onClick={() => void verifySafety()}>
                标记为已核实
              </Button>
            </Notice>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <SectionTitle>植物信息</SectionTitle>
        <DynamicForm defs={defs} values={values} errors={errors} onChange={setValue} excludeKeys={['aliases_hint']} />
      </Panel>

      <Panel>
        <SectionTitle>图片</SectionTitle>
        <ImageStripWithHint
          owner={currentId !== null ? { speciesId: currentId } : {}}
          disabled={currentId === null}
          hint={currentId === null ? '保存后即可添加图片。' : undefined}
        />
      </Panel>

      {currentId !== null ? (
        <Panel>
          <SectionTitle>危险操作</SectionTitle>
          <div className="row">
            <Button
              variant="danger"
              onClick={async () => {
                if (!window.confirm(`确定要删除物种「${plantName}」吗？`)) return
                try {
                  await window.api.species.remove(currentId)
                  toast.push('已删除', 'success')
                  onBack()
                } catch (error) {
                  toast.push(error instanceof Error ? error.message : '删除失败', 'error')
                }
              }}
            >
              删除该物种
            </Button>
            <span className="small muted">
              若还有植株引用它，删除会被拒绝 —— 这是防止误删的保护。
            </span>
          </div>
        </Panel>
      ) : null}

      {showHints ? (
        <Modal
          title="AI 补全 · 补充线索"
          onClose={() => setShowHints(false)}
          narrow
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setShowHints(false)}>取消</Button>
              <Button variant="primary" onClick={() => void runAutofill()}>
                开始生成
              </Button>
            </>
          }
        >
          <div className="content-inner">
            <Notice tone="info">
              将根据「<b>{plantName}</b>」生成信息草稿。补充线索能明显提高准确率，尤其是同名异物较多的名字。
            </Notice>
            <Field label="补充线索（可选）" help="例如：产地、用途、株型、你在哪里买的、叶片特征。">
              <TextInput
                value={hints}
                onChange={setHints}
                placeholder="例如：常见的切花月季，灌木，四季开花，南方阳台盆栽"
              />
            </Field>
            <div className="small muted">
              生成结果会先显示为草稿供你逐项确认，<b>不会自动写入</b>。安全字段（毒性等）需要你人工核实。
            </div>
          </div>
        </Modal>
      ) : null}

      {aiResult ? (
        <AiDraftDialog result={aiResult} defs={defs} onApply={applyDrafts} onClose={() => setAiResult(null)} />
      ) : null}

      {species && Object.keys(species.confidence).length > 0 ? (
        <Panel flat>
          <SectionTitle>AI 字段来源记录</SectionTitle>
          <div className="row tight">
            {Object.entries(species.confidence).map(([key, confidence]) => {
              const def = defs.find((d) => d.key === key)
              const verified = species.verifiedFields.includes(key)
              return (
                <span key={key} className={cx('pixel-tag')} title={`置信度 ${(Number(confidence) * 100).toFixed(0)}%`}>
                  {def?.label ?? key}
                  <Badge tone={verified ? 'ok' : 'ai'}>{verified ? '已核实' : '待核实'}</Badge>
                </span>
              )
            })}
          </div>
        </Panel>
      ) : null}
    </div>
  )
}

export function SpeciesEditorEmpty(): ReactNode {
  return (
    <Panel>
      <EmptyState title="未选择物种" hint="请从物种库选择一个条目。" />
    </Panel>
  )
}
