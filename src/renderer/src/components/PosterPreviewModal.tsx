/**
 * 海报预览弹窗。
 *
 * 先看图、再决定存哪 —— 直接弹保存框的话，用户存完打开才发现是一张信息不全的图
 * （比如植株没填位置、这个月没有任务）。
 *
 * 预览图是先渲染好的 PNG 转成 data URL，token 留在主进程内存里；
 * 点「保存」才弹保存框，关闭弹窗不写任何文件。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PosterRequest } from '@shared/api'
import { Button, Modal, Notice, Spinner, useToast } from './ui'

interface PreviewState {
  loading: boolean
  error: string | null
  token: string | null
  dataUrl: string | null
  bytes: number
}

export function PosterPreviewModal({
  request,
  onClose,
  onSaved,
  title = '海报预览'
}: {
  request: PosterRequest
  onClose: () => void
  onSaved?: (path: string) => void
  title?: string
}): ReactNode {
  const toast = useToast()
  const [state, setState] = useState<PreviewState>({
    loading: true,
    error: null,
    token: null,
    dataUrl: null,
    bytes: 0
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    setState({ loading: true, error: null, token: null, dataUrl: null, bytes: 0 })
    void window.api.poster
      .preview(request)
      .then((r) => {
        if (!alive) return
        setState({ loading: false, error: null, token: r.token, dataUrl: r.dataUrl, bytes: r.bytes })
      })
      .catch((error) => {
        if (!alive) return
        setState({
          loading: false,
          error: error instanceof Error ? error.message : '生成海报失败',
          token: null,
          dataUrl: null,
          bytes: 0
        })
      })
    return () => {
      alive = false
    }
    // request 每次打开都是新对象，按 kind + 关键 id 比较就够了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.kind, (request as { plantId?: number }).plantId, (request as { year?: number }).year, (request as { month?: number }).month])

  const save = async (): Promise<void> => {
    if (!state.token) return
    setSaving(true)
    try {
      const r = await window.api.poster.save(state.token)
      if (r.canceled) return
      onSaved?.(r.path ?? '')
      toast.push(`海报已保存：${r.path ?? ''}`, 'success')
      onClose()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="small muted">
            {state.bytes > 0 ? `PNG · ${Math.round(state.bytes / 1024)} KB · 1080 宽` : '还没有生成'}
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!state.token || saving}>
            {saving ? '保存中…' : '保存到…'}
          </Button>
        </>
      }
    >
      <div className="poster-preview">
        {state.loading ? <Spinner label="正在生成海报…（几秒）" /> : null}
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {state.dataUrl ? <img src={state.dataUrl} alt="海报预览" /> : null}
      </div>
    </Modal>
  )
}
