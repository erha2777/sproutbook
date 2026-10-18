/**
 * 物种编辑页 —— 模板驱动的完整表单 + AI 自动补全（草稿 → 确认 → 落库）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiAutofillResult, FieldDefinition } from '@core/types'
import type { AiIdentifyResult, SpeciesListItem } from '@shared/api'
import { makeRequestId } from '../lib/util'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, Sign, Spinner, TextInput, cx, useToast } from '../components/ui'
import { DynamicForm } from '../components/DynamicForm'
import type { FormValues } from '../components/DynamicForm'
import { AiDraftDialog } from '../components/AiDraftDialog'
import { IdentifyDialog } from '../components/IdentifyDialog'
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
  /** 识图对话框。它只认品种，认出来之后接着走下面那条 AI 补全 */
  const [showIdentify, setShowIdentify] = useState(false)
  const [identifyBusy, setIdentifyBusy] = useState(false)
  const [identifyResult, setIdentifyResult] = useState<AiIdentifyResult | null>(null)
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

  /**
   * 选一张本地图片去识别。
   *
   * 用 identifyFile 而不是 identify：识图最该用的地方是**录入新物种**，
   * 那时相册里还没有这张图。文件对话框在主进程弹，界面不碰路径。
   */
  const runIdentify = async (hint: string): Promise<void> => {
    const requestId = makeRequestId()
    setAiRequestId(requestId)
    setIdentifyBusy(true)
    try {
      const result = await window.api.ai.identifyFile({ requestId, hint: hint.trim() || undefined })
      // 用户取消选择不算错误，别弹一个红条吓人
      if (!result.ok && result.message === '没有选择图片。') return
      setIdentifyResult(result)
    } catch (error) {
      setIdentifyResult({
        ok: false,
        candidates: [],
        message: error instanceof Error ? error.message : '识别失败',
        model: null
      })
    } finally {
      setIdentifyBusy(false)
      setAiRequestId(null)
    }
  }

  /**
   * 选定候选：填上名字，**接着跑现有的 AI 补全**。
   *
   * 这一步是整个设计的关键 —— 识图只负责「认出是什么」，
   * 认出来之后交给原有那条「草稿 → 逐字段勾选 → 写入」的路。
   * 那条路的规矩（永不自动写、安全字段强制人工确认）一个字都不用改。
   */
  const pickCandidate = async (candidate: { name: string; scientificName: string | null }): Promise<void> => {
    setShowIdentify(false)
    setValue('common_name', candidate.name)
    // 学名一起带上，比只给中文名准得多
    const clue = candidate.scientificName ? `${candidate.name}（${candidate.scientificName}）` : candidate.name
    await runAutofillFor(clue)
  }

  const runAutofill = async (): Promise<void> => {
    await runAutofillFor(plantName)
  }

  const runAutofillFor = async (name: string): Promise<void> => {
    setShowHints(false)
    const requestId = makeRequestId()
    setAiRequestId(requestId)
    setAiBusy(true)
    try {
      const result = await window.api.ai.autofill({
        requestId,
        // 用传进来的名字，不是输入框的当前值 ——
        // 识图选完候选时 setPlantName 还没生效，读 state 会拿到旧值
        plantName: name,
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

  /**
   * 标记或撤回核实。
   *
   * 之前的实现有个真 bug：它只会标记 `isSafety` 的字段，
   * 于是 AI 填的其它字段永远停在「待核实」，用户点多少次都没用。
   * 现在接受任意字段集合，并且支持撤回 —— 核实是人的判断，点错了必须能反悔。
   */
  const setVerified = async (keys: string[], verified: boolean): Promise<void> => {
    if (currentId === null) {
      toast.push('请先保存，再标记核实', 'error')
      return
    }
    if (keys.length === 0) return
    try {
      await window.api.species.verify(currentId, keys, verified)
      // 重新拉一次：verify 返回的是 Species，而页面状态是带封面/计数的 SpeciesListItem
      setSpecies(await window.api.species.get(currentId))
      toast.push(
        verified ? `已标记 ${keys.length} 个字段为「已核实」` : `已撤回 ${keys.length} 个字段的核实`,
        'success'
      )
    } catch (error) {
      toast.push(`操作失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  /**
   * AI 填过、尚未人工核实的**安全**字段。
   *
   * 只有安全字段需要核实。学名、科属这类填错了也不会有危险，
   * 让它们一直挂着「待核实」只会把真正的风险淹没在噪声里。
   * 非安全字段仍然记录在「AI 字段来源记录」里，只是不带核实状态 ——
   * 来源可追溯，但不要求逐项签字。
   */
  const pendingSafety = useMemo(() => {
    if (!species) return [] as string[]
    return Object.keys(species.confidence).filter(
      (k) => !species.verifiedFields.includes(k) && defs.find((d) => d.key === k)?.isSafety
    )
  }, [species, defs])

  /**
   * AI 填过的安全字段**总数**，用作待核实数量的分母。
   *
   * 只报「还有 N 个没核实」会产生歧义：「有 1 个安全相关字段是 AI 填写的，
   * 尚未核实」既能读成「还剩 1 个」，也能读成「一共就 1 个」。
   * 把分母一起说出来就不会误会了。
   */
  const aiSafetyTotal = useMemo(() => {
    if (!species) return 0
    return Object.keys(species.confidence).filter((k) => defs.find((d) => d.key === k)?.isSafety).length
  }, [species, defs])

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
            <>
              <Button
                onClick={() => {
                  setIdentifyResult(null)
                  setShowIdentify(true)
                }}
                disabled={!aiAvailable.hasKey || !aiAvailable.model}
                title={
                  !aiAvailable.hasKey
                    ? '尚未配置 API Key，请到「设置 → AI」'
                    : !aiAvailable.model
                      ? '尚未配置模型'
                      : '选一张照片，让模型认出是什么'
                }
              >
                📷 从照片识别
              </Button>
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
            </>
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

        {pendingSafety.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">
              {/*
                区分「还剩 N 个」和「一共就 N 个」：
                只写「有 N 个安全相关字段尚未核实」会被读成后者，
                而实际常见的情况是前者（已经核实过一部分了）。
              */}
              {pendingSafety.length === aiSafetyTotal ? (
                <>
                  有 <b>{aiSafetyTotal}</b> 个安全相关字段是 AI 填写的，目前一个都还没核实。
                </>
              ) : (
                <>
                  AI 一共填了 <b>{aiSafetyTotal}</b> 个安全相关字段，其中 <b>{aiSafetyTotal - pendingSafety.length}</b>{' '}
                  个已核实，还剩 <b>{pendingSafety.length}</b> 个没核实。
                </>
              )}
              请对照可靠资料确认后再标记 —— 这类信息填错的后果和学名写错完全不是一回事。
              <div className="row tight" style={{ marginTop: 9 }}>
                <Button variant="primary" size="small" onClick={() => void setVerified(pendingSafety, true)}>
                  ✓ 标记这 {pendingSafety.length} 个字段为已核实
                </Button>
                <span className="small muted">也可以在下方「AI 字段来源记录」里逐个点击标记。</span>
              </div>
            </Notice>
          </div>
        ) : species && aiSafetyTotal > 0 ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="ok">
              AI 填写的 <b>{aiSafetyTotal}</b> 个安全相关字段都已人工核实。其余 AI 填入的字段属于普通信息，只作来源记录，不要求逐项确认。
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
          searchHint={typeof values.common_name === 'string' ? values.common_name : undefined}
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

      {/* 识图对话框独立于补全结果 —— 它是先发生的，不该挂在 aiResult 上 */}
      <IdentifyDialog
        open={showIdentify}
        busy={identifyBusy}
        result={identifyResult}
        onIdentify={(hint) => void runIdentify(hint)}
        onPick={(c) => void pickCandidate(c)}
        onClose={() => setShowIdentify(false)}
      />

      {aiResult ? (
        <AiDraftDialog result={aiResult} defs={defs} onApply={applyDrafts} onClose={() => setAiResult(null)} />
      ) : null}

      {species && Object.keys(species.confidence).length > 0 ? (
        <Panel flat>
          <SectionTitle
            right={
              pendingSafety.length > 0 ? (
                <Button size="small" onClick={() => void setVerified(pendingSafety, true)}>
                  核实剩余 {pendingSafety.length} 个
                </Button>
              ) : (
                <Badge tone="ok">安全字段已核实</Badge>
              )
            }
          >
            AI 字段来源记录
          </SectionTitle>
          <div className="small muted" style={{ marginBottom: 8 }}>
            记录每个字段是不是 AI 填的、置信度多少。<b>只有带</b> <Badge tone="safety">安全</Badge>{' '}
            <b>的字段需要人工核实</b>（点标签即可标记或撤回）；其余属于普通信息，填错也不会有危险，只作来源可追溯。
          </div>
          <div className="row tight">
            {Object.entries(species.confidence).map(([key, confidence]) => {
              const def = defs.find((d) => d.key === key)
              const label = def?.label ?? key
              const isSafety = Boolean(def?.isSafety)
              const verified = species.verifiedFields.includes(key)
              const pct = `${(Number(confidence) * 100).toFixed(0)}%`

              // 非安全字段：只展示来源与置信度，不参与核实
              if (!isSafety) {
                return (
                  <span key={key} className="pixel-tag" title={`${label}｜AI 填写，置信度 ${pct}`}>
                    {label}
                    <Badge tone="muted">{pct}</Badge>
                  </span>
                )
              }

              return (
                <button
                  key={key}
                  type="button"
                  className={cx('pixel-tag', 'tag-toggle', verified && 'verified')}
                  title={`${label}｜安全字段｜AI 置信度 ${pct}｜点击${verified ? '撤回核实' : '标记为已核实'}`}
                  onClick={() => void setVerified([key], !verified)}
                >
                  {label}
                  <Badge tone="safety">安全</Badge>
                  <Badge tone={verified ? 'ok' : 'ai'}>{verified ? '✓ 已核实' : '待核实'}</Badge>
                </button>
              )
            })}
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
