/**
 * 海报工作室：选内容、配文字、**自己挑照片**，先生成预览再保存。
 *
 * 只有「某一株」这一个入口 —— 海报讲的是这株植物的故事，所以不需要再选植株。
 * 照片可以按日期缩范围，也可以在缩略图里一张张勾：时间轴按日期排，
 * 拼贴只放勾选的这几张。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PosterPhotoOption, PosterRequest } from '@shared/api'
import { Button, Modal, Notice, SelectInput, Spinner, TextInput, useToast } from './ui'

type Kind = 'plant' | 'growth' | 'collage' | 'plan' | 'log'

const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'plant', label: '整株档案（封面 + 最近养护）' },
  { value: 'growth', label: '成长时间轴（照片按日期排）' },
  { value: 'collage', label: '图片拼贴（自己挑照片）' },
  { value: 'plan', label: '这一株的本月计划' },
  { value: 'log', label: '这一株的最近记录' }
]

const THEME_OPTIONS = [
  { value: 'paper', label: '纸黄（默认）' },
  { value: 'night', label: '夜蓝' },
  { value: 'garden', label: '草木绿' }
]

const LAYOUT_OPTIONS = [
  { value: 'grid', label: '网格拼贴' },
  { value: 'timeline', label: '时间轴（左图右文）' }
]

const MAX_PHOTOS = 9

export function PosterStudioModal({
  plantId,
  year,
  month,
  onClose
}: {
  plantId: number
  year?: number
  month?: number
  onClose: () => void
}): ReactNode {
  const toast = useToast()
  const [kind, setKind] = useState<Kind>('plant')
  const [theme, setTheme] = useState<'paper' | 'night' | 'garden'>('paper')
  const [layout, setLayout] = useState<'grid' | 'timeline'>('grid')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')

  const [photos, setPhotos] = useState<PosterPhotoOption[]>([])
  const [photosLoading, setPhotosLoading] = useState(false)
  /** 勾选的照片 id，**选择顺序**就是时间轴/拼贴的排序 */
  const [selected, setSelected] = useState<number[]>([])

  const [preview, setPreview] = useState<{ token: string; dataUrl: string; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usesPhotos = kind === 'growth' || kind === 'collage'

  // 照片列表：日期范围只是缩小候选，勾选才是真正的选择
  useEffect(() => {
    if (!usesPhotos) return
    let alive = true
    setPhotosLoading(true)
    void window.api.poster
      .photos(plantId, { from: from || undefined, to: to || undefined })
      .then((rows) => {
        if (!alive) return
        setPhotos(rows)
        // 换了范围后，原来勾的不在新列表里就去掉
        setSelected((prev) => prev.filter((id) => rows.some((row) => row.id === id)))
      })
      .catch(() => {
        if (alive) setPhotos([])
      })
      .finally(() => {
        if (alive) setPhotosLoading(false)
      })
    return () => {
      alive = false
    }
  }, [usesPhotos, plantId, from, to])

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])
  const chosen = selected.map((id) => byId.get(id)).filter((p): p is PosterPhotoOption => Boolean(p))

  const toggle = (id: number): void => {
    setPreview(null)
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_PHOTOS) {
        toast.push(`最多选 ${MAX_PHOTOS} 张`, 'error')
        return prev
      }
      return [...prev, id]
    })
  }

  const request = useMemo<PosterRequest | null>(() => {
    const base = { theme, title: title.trim() || undefined, subtitle: subtitle.trim() || undefined }
    if (kind === 'plant') return { ...base, kind, plantId }
    if (usesPhotos) {
      return {
        ...base,
        kind: kind as 'growth' | 'collage',
        plantId,
        from: from || undefined,
        to: to || undefined,
        maxPhotos: chosen.length || undefined,
        layout: kind === 'collage' ? layout : 'timeline',
        // 勾了就按勾的顺序；没勾就让主进程按日期取最近的
        imageIds: chosen.length > 0 ? chosen.map((p) => p.id) : undefined
      }
    }
    if (kind === 'plan') {
      return {
        ...base,
        kind,
        year: year ?? new Date().getFullYear(),
        month: month ?? new Date().getMonth() + 1,
        plantId
      }
    }
    return { ...base, kind: 'log', limit: 5, plantId }
  }, [kind, plantId, theme, layout, from, to, chosen, title, subtitle, year, month, usesPhotos])

  const generate = async (): Promise<void> => {
    if (!request) return
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const r = await window.api.poster.preview(request)
      setPreview({ token: r.token, dataUrl: r.dataUrl, bytes: r.bytes })
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成海报失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!preview) return
    setSaving(true)
    try {
      const r = await window.api.poster.save(preview.token)
      if (r.canceled) return
      toast.push(`海报已保存：${r.path ?? ''}`, 'success')
      onClose()
    } catch (e) {
      toast.push(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="分享海报"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">
            {preview ? `PNG · ${Math.round(preview.bytes / 1024)} KB · 1080 宽` : '选好照片后先生成预览'}
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={() => void generate()} disabled={busy}>
            {busy ? '生成中…' : preview ? '重新生成' : '生成预览'}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!preview || saving}>
            {saving ? '保存中…' : '保存到…'}
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="row tight" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 240, flex: '1 1 240px' }}>
            <span className="field-label">内容</span>
            <SelectInput
              value={kind}
              onChange={(v) => {
                setKind(v as Kind)
                setPreview(null)
              }}
              options={KIND_OPTIONS}
            />
          </label>
          <label className="field" style={{ minWidth: 150, flex: '0 1 160px' }}>
            <span className="field-label">配色</span>
            <SelectInput value={theme} onChange={(v) => setTheme(v as typeof theme)} options={THEME_OPTIONS} />
          </label>
          {kind === 'collage' ? (
            <label className="field" style={{ width: 180 }}>
              <span className="field-label">版式</span>
              <SelectInput value={layout} onChange={(v) => setLayout(v as typeof layout)} options={LAYOUT_OPTIONS} />
            </label>
          ) : null}
        </div>

        {usesPhotos ? (
          <>
            <div className="row tight" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field">
                <span className="field-label">筛选起始日期（可空）</span>
                <TextInput value={from} onChange={setFrom} placeholder="2026-04-01" />
              </label>
              <label className="field">
                <span className="field-label">筛选结束日期（可空）</span>
                <TextInput value={to} onChange={setTo} placeholder="2026-06-30" />
              </label>
              <span className="small muted" style={{ paddingBottom: 6 }}>
                日期只是缩小下面的候选；勾选才算数
              </span>
            </div>

            <div className="row tight" style={{ alignItems: 'center' }}>
              <span className="small muted">
                已选 {chosen.length} 张{chosen.length === 0 ? '（不勾就自动取最近几张）' : ''}
              </span>
              <span className="spacer" />
              <Button
                size="small"
                onClick={() => {
                  setPreview(null)
                  // 列表是「新 → 旧」，最近几张就是开头这几张
                  setSelected(photos.slice(0, MAX_PHOTOS).map((p) => p.id))
                }}
                disabled={photos.length === 0}
              >
                选最近 {MAX_PHOTOS} 张
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setPreview(null)
                  setSelected([])
                }}
                disabled={chosen.length === 0}
              >
                清空
              </Button>
            </div>

            {photosLoading ? (
              <Spinner label="读取照片…" />
            ) : photos.length === 0 ? (
              <Notice tone="info">这一株在这段时间里还没有照片，换个日期范围或者先去上传几张。</Notice>
            ) : (
              <div className="poster-pick">
                {photos.map((p) => {
                  const order = selected.indexOf(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`poster-pick-item${order >= 0 ? ' picked' : ''}`}
                      title={`${p.date}${p.content ? ` · ${p.content}` : ''}`}
                      onClick={() => toggle(p.id)}
                    >
                      <img src={p.thumb} alt="" />
                      <span className="poster-pick-date">{p.date.slice(5)}</span>
                      {order >= 0 ? <span className="poster-pick-order">{order + 1}</span> : null}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        ) : null}

        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 240px' }}>
            <span className="field-label">标题（可空）</span>
            <TextInput value={title} onChange={setTitle} placeholder="留空用默认标题" />
          </label>
          <label className="field" style={{ flex: '1 1 240px' }}>
            <span className="field-label">副标题（可空）</span>
            <TextInput value={subtitle} onChange={setSubtitle} placeholder="留空用默认副标题" />
          </label>
        </div>

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {busy ? <Spinner label="正在生成海报…（几秒）" /> : null}
        {preview ? (
          <div className="poster-preview">
            <img src={preview.dataUrl} alt="海报预览" />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
