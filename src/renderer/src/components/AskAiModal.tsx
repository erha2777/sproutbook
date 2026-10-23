/**
 * 「问问 AI」弹窗：选一株 + 问一个问题，模型基于**这一株的全部档案**回答。
 *
 * 和「AI 补全」不同，这里不写任何字段 —— 纯问答。
 *
 * 照片：可以勾选这一株的图片（植株相册 + 养护记录里的），随问题一起发给模型。
 * 只勾了文字不勾图也能问 —— 模型看不看图，取决于有没有勾。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog, ImageRecord } from '@core/types'
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

/** 一次最多带 8 张：再多既贵又没必要，模型也看不过来（和主进程的上限一致） */
const MAX_PHOTOS = 8

/** 候选照片：可能是植株相册里的，也可能是某条养护记录里的 */
interface PhotoOption {
  id: number
  path: string
  thumbPath: string | null
  /** 来自哪里：相册 / 某天的养护记录 */
  from: string
}

function photoSrc(photo: { path: string; thumbPath: string | null }): string {
  return `plantimg://local/${encodeURIComponent(photo.thumbPath ?? photo.path)}`
}

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
  /** 这一株能带的照片（相册 + 养护记录），以及勾中的 id */
  const [photos, setPhotos] = useState<PhotoOption[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [loadingPhotos, setLoadingPhotos] = useState(false)

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

  /* 换植株时重新拉它的照片（相册 + 最近的养护记录），并清空勾选 */
  useEffect(() => {
    const id = Number(plantId)
    if (!plantId || !Number.isFinite(id)) {
      setPhotos([])
      setPicked([])
      return
    }
    let alive = true
    setLoadingPhotos(true)
    void (async () => {
      try {
        const [album, logs] = await Promise.all([
          window.api.images.list({ plantId: id }),
          window.api.care.logs(id, 100)
        ])
        if (!alive) return
        const fromAlbum: PhotoOption[] = (album as ImageRecord[]).map((img) => ({
          id: img.id,
          path: img.path,
          thumbPath: img.thumbPath,
          from: '植株相册'
        }))
        const fromLogs: PhotoOption[] = (logs as CareLog[])
          .filter((log) => log.images.length > 0)
          .flatMap((log) =>
            log.images.map((img) => ({
              id: img.id,
              path: img.path,
              thumbPath: img.thumbPath,
              from: `养护记录 ${log.logDate}`
            }))
          )
        setPhotos([...fromAlbum, ...fromLogs])
        setPicked([])
      } catch {
        if (alive) setPhotos([])
      } finally {
        if (alive) setLoadingPhotos(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [plantId])

  const togglePhoto = (id: number): void => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_PHOTOS) {
        toast.push(`一次最多带 ${MAX_PHOTOS} 张照片`, 'error')
        return prev
      }
      return [...prev, id]
    })
  }

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
        question: question.trim(),
        imageIds: picked
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
            会把这一株的档案（物种、位置、状态、阶段、未完成任务、最近日志）
            {picked.length > 0 ? `和 ${picked.length} 张照片` : ''}一起发给你配置的 AI 服务。
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

        {plantId ? (
          <Field
            label={`带上照片（选填，最多 ${MAX_PHOTOS} 张${picked.length > 0 ? `，已选 ${picked.length}` : ''}）`}
            help="勾两张叶子的近照、一张整盆照，模型能判断的东西多得多。不勾也能问。"
          >
            {loadingPhotos ? (
              <Spinner label="正在读取照片…" />
            ) : photos.length === 0 ? (
              <div className="small muted">这一株还没有照片（相册和养护记录里都没有）。</div>
            ) : (
              <div className="ask-ai-photos">
                {photos.map((photo) => {
                  const on = picked.includes(photo.id)
                  return (
                    <button
                      key={photo.id}
                      type="button"
                      className={`ask-ai-photo${on ? ' on' : ''}`}
                      title={on ? `取消选择（${photo.from}）` : `选这张（${photo.from}）`}
                      onClick={() => togglePhoto(photo.id)}
                      disabled={asking}
                    >
                      <img src={photoSrc(photo)} alt="" />
                      <span className="ask-ai-photo-from">{photo.from}</span>
                      {on ? <span className="ask-ai-photo-check">✓</span> : null}
                    </button>
                  )
                })}
              </div>
            )}
          </Field>
        ) : null}

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
