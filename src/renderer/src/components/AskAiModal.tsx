/**
 * 「问问 AI」弹窗：选一株 + 问一个问题，模型基于**这一株的全部档案**回答。
 *
 * 和「AI 补全」不同，这里不写任何字段 —— 纯问答。所以界面只有：
 * 选植株 → 写问题（或点一个常见问题）→ 看答案。
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlantListItem } from '@shared/api'
import { Button, Field, Modal, Notice, Spinner, TextArea, useToast } from './ui'
import { SearchSelect } from './ui'

/** 常见问题：省得每次想措辞 */
const PRESETS = [
  '现在该不该施肥？',
  '什么时候该换盆 / 翻盆？',
  '叶子发黄可能是什么原因？',
  '这个状态正常吗？接下来要做什么？'
]

export function AskAiModal({
  plants,
  onClose
}: {
  plants: PlantListItem[]
  onClose: () => void
}): ReactNode {
  const toast = useToast()
  const [plantId, setPlantId] = useState<string>('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const options = useMemo(
    () =>
      plants
        .filter((p) => p.status !== 'gifted')
        .map((p) => ({
          value: String(p.id),
          label: p.species?.commonName ? `${p.nickname}（${p.species.commonName}）` : p.nickname
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'zh')),
    [plants]
  )

  const ask = async (): Promise<void> => {
    if (!plantId) {
      toast.push('先选一株植物', 'error')
      return
    }
    if (!question.trim()) {
      toast.push('先写一个问题', 'error')
      return
    }
    setAsking(true)
    setError(null)
    setAnswer(null)
    try {
      const result = await window.api.ai.askPlant({
        requestId: `ask-${Date.now()}`,
        plantId: Number(plantId),
        question: question.trim()
      })
      if (result.ok) {
        setAnswer(result.answer)
      } else {
        setError(result.message ?? 'AI 没有返回内容。')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '提问失败')
    } finally {
      setAsking(false)
    }
  }

  return (
    <Modal
      title="问问 AI"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">
            会把这一株的档案（物种、位置、状态、阶段、未完成任务、最近日志）一起发给你配置的 AI 服务。
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={() => void ask()} disabled={asking}>
            {asking ? '正在问…' : '提问'}
          </Button>
        </>
      }
    >
      <div className="content-inner ask-ai">
        <Field label="问哪一株" required>
          <SearchSelect
            value={plantId}
            onChange={(v) => {
              setPlantId(v)
              setAnswer(null)
              setError(null)
            }}
            options={options}
            placeholder="输入昵称 / 物种名筛选…"
            emptyHint="没有匹配的植株"
          />
        </Field>

        <Field label="你的问题" help="可以点下面的常见问题，也可以自己写。">
          <TextArea value={question} onChange={setQuestion} rows={3} placeholder="例如：这盆现在要不要换盆？" />
        </Field>

        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map((preset) => (
            <Button key={preset} size="small" onClick={() => setQuestion(preset)} disabled={asking}>
              {preset}
            </Button>
          ))}
        </div>

        {asking ? (
          <Spinner label="正在读这一株的档案并组织回答…" />
        ) : error ? (
          <Notice tone="danger">{error}</Notice>
        ) : answer ? (
          <div className="ask-ai-answer">
            <div className="small muted" style={{ marginBottom: 6 }}>
              回答
            </div>
            <div className="ask-ai-text">{answer}</div>
          </div>
        ) : (
          <div className="small muted">选一株、写下问题，点「提问」。</div>
        )}
      </div>
    </Modal>
  )
}
