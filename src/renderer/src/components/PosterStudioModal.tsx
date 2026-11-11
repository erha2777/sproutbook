/**
 * 海报工作室：选内容、选版式、选配色，先生成预览再决定保存。
 *
 * 为什么不做成一键导出：「分享海报」原来固定只出「这一株的档案」，
 * 但想分享的东西不一样 —— 有人想看整段成长过程（时间轴），
 * 有人只想把开花那几天的照片拼成一张（拼贴），有人要换深色背景。
 * 所以入口统一收到这里：默认值跟着点进来的位置走，改不改由你。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PosterRequest } from '@shared/api'
import type { PlantListItem } from '@shared/api'
import { Button, Modal, Notice, SelectInput, Spinner, TextInput, useToast } from './ui'

type Kind = 'plant' | 'growth' | 'collage' | 'plan' | 'log'

const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'plant', label: '整株档案（封面 + 最近养护）' },
  { value: 'growth', label: '成长时间轴（照片按日期排）' },
  { value: 'collage', label: '图片拼贴（挑一段时间的照片）' },
  { value: 'plan', label: '本月养护计划' },
  { value: 'log', label: '最近养护记录' }
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

export interface PosterStudioDefaults {
  kind: Kind
  plantId?: number
  year?: number
  month?: number
  limit?: number
}

export function PosterStudioModal({
  defaults,
  onClose
}: {
  defaults: PosterStudioDefaults
  onClose: () => void
}): ReactNode {
  const toast = useToast()
  const [kind, setKind] = useState<Kind>(defaults.kind)
  const [plants, setPlants] = useState<PlantListItem[]>([])
  const [plantId, setPlantId] = useState<string>(defaults.plantId ? String(defaults.plantId) : '')
  const [theme, setTheme] = useState<'paper' | 'night' | 'garden'>('paper')
  const [layout, setLayout] = useState<'grid' | 'timeline'>('grid')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [maxPhotos, setMaxPhotos] = useState('6')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')

  const [preview, setPreview] = useState<{ token: string; dataUrl: string; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.plants
      .list()
      .then((result) => {
        const rows = result.items
        setPlants(rows)
        // 从某一株点进来的已经带了 id；没有就默认第一株
        setPlantId((current) => current || (rows[0] ? String(rows[0].id) : ''))
      })
      .catch(() => setPlants([]))
  }, [])

  /** 日期范围 / 张数只对「照片类」海报有意义 */
  const showsRange = kind === 'growth' || kind === 'collage'
  const photoCount = kind === 'growth' ? '6' : layout === 'grid' ? maxPhotos : '6'

  const request = useMemo<PosterRequest | null>(() => {
    const base = { theme, title: title.trim() || undefined, subtitle: subtitle.trim() || undefined }
    if (kind === 'plant') {
      return plantId ? { ...base, kind, plantId: Number(plantId) } : null
    }
    if (kind === 'growth' || kind === 'collage') {
      if (!plantId) return null
      return {
        ...base,
        kind,
        plantId: Number(plantId),
        from: from || undefined,
        to: to || undefined,
        maxPhotos: Number(photoCount) || undefined,
        layout: kind === 'collage' ? layout : 'timeline'
      }
    }
    if (kind === 'plan') {
      return {
        ...base,
        kind,
        year: defaults.year ?? new Date().getFullYear(),
        month: defaults.month ?? new Date().getMonth() + 1,
        plantId: plantId ? Number(plantId) : undefined
      }
    }
    return { ...base, kind: 'log', limit: defaults.limit ?? 5 }
  }, [kind, plantId, theme, layout, from, to, photoCount, title, subtitle, defaults])

  const generate = async (): Promise<void> => {
    if (!request) {
      toast.push('先选一株植物', 'error')
      return
    }
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
            {preview ? `PNG · ${Math.round(preview.bytes / 1024)} KB · 1080 宽` : '调整选项后先生成预览'}
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
          {kind !== 'log' ? (
            <label className="field" style={{ minWidth: 200, flex: '1 1 200px' }}>
              <span className="field-label">植株{kind === 'plan' ? '（空 = 全部）' : ''}</span>
              <SelectInput
                value={plantId}
                onChange={(v) => {
                  setPlantId(v)
                  setPreview(null)
                }}
                options={[
                  ...(kind === 'plan' ? [{ value: '', label: '全部植株' }] : []),
                  ...plants.map((pl) => ({ value: String(pl.id), label: pl.nickname }))
                ]}
              />
            </label>
          ) : null}
          <label className="field" style={{ minWidth: 150, flex: '0 1 160px' }}>
            <span className="field-label">配色</span>
            <SelectInput value={theme} onChange={(v) => setTheme(v as typeof theme)} options={THEME_OPTIONS} />
          </label>
        </div>

        {showsRange ? (
          <div className="row tight" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field">
              <span className="field-label">起始日期（可空）</span>
              <TextInput value={from} onChange={setFrom} placeholder="2026-04-01" />
            </label>
            <label className="field">
              <span className="field-label">结束日期（可空）</span>
              <TextInput value={to} onChange={setTo} placeholder="2026-06-30" />
            </label>
            <label className="field" style={{ width: 130 }}>
              <span className="field-label">照片数量</span>
                <SelectInput
                  value={photoCount}
                  onChange={(v) => {
                    setMaxPhotos(v)
                    setPreview(null)
                  }}
                  options={[
                    { value: '4', label: '4 张' },
                    { value: '6', label: '6 张' },
                    { value: '9', label: '9 张' }
                  ]}
              />
            </label>
            {kind === 'collage' ? (
              <label className="field" style={{ width: 180 }}>
                <span className="field-label">版式</span>
                <SelectInput
                  value={layout}
                  onChange={(v) => setLayout(v as typeof layout)}
                  options={LAYOUT_OPTIONS}
                />
              </label>
            ) : null}
          </div>
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

        <p className="small muted" style={{ margin: 0 }}>
          时间轴按养护记录日期排序；拼贴只放这段时间里的照片。日期留空 = 全部。
        </p>

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
