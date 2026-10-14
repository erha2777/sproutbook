/**
 * 图片管理条：上传（系统文件对话框）、预览、删除。
 * 图片文件由主进程复制进 userData/images，数据库只存文件名。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImageRecord } from '@core/types'
import { imageUrl } from '../lib/util'
import { Button, Spinner, cx, useToast } from './ui'

export interface ImageStripProps {
  owner: { plantId?: number; speciesId?: number }
  disabled?: boolean
  /** 删除后回调，便于外层刷新封面 */
  onChanged?: () => void
}

export function ImageStrip({ owner, disabled, onChanged }: ImageStripProps): ReactNode {
  const toast = useToast()
  const [images, setImages] = useState<ImageRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const ownerKey = `${owner.plantId ?? ''}:${owner.speciesId ?? ''}`

  const load = useCallback(async () => {
    if (!owner.plantId && !owner.speciesId) {
      setImages([])
      return
    }
    setLoading(true)
    try {
      setImages(await window.api.images.list(owner))
    } catch (error) {
      toast.push(`读取图片失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
    // owner 是每次渲染新建的对象，用 ownerKey 作为依赖避免无限循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, toast])

  useEffect(() => {
    void load()
  }, [load])

  const pick = async (): Promise<void> => {
    if (!owner.plantId && !owner.speciesId) {
      toast.push('请先保存记录，再添加图片', 'error')
      return
    }
    setBusy(true)
    try {
      const result = await window.api.images.pick(owner)
      if (!result.canceled) {
        if (result.imported.length > 0) toast.push(`已导入 ${result.imported.length} 张图片`, 'success')
        if (result.failures && result.failures.length > 0) {
          toast.push(`${result.failures.length} 张导入失败：${result.failures[0]}`, 'error')
        }
        await load()
        onChanged?.()
      }
    } catch (error) {
      toast.push(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (image: ImageRecord): Promise<void> => {
    setBusy(true)
    try {
      await window.api.images.remove(image.id)
      await load()
      onChanged?.()
    } catch (error) {
      toast.push(`删除失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="image-strip">
      {images.map((image) => {
        const url = imageUrl(image.thumbPath ?? image.path)
        return (
          <div className="image-thumb" key={image.id}>
            {url ? <img src={url} alt={image.caption ?? '植物图片'} /> : null}
            {!disabled ? (
              <button className="del" onClick={() => void remove(image)} disabled={busy} title="删除这张图片">
                ✕
              </button>
            ) : null}
          </div>
        )
      })}

      {!disabled ? (
        <button className={cx('image-add')} onClick={() => void pick()} disabled={busy}>
          {busy ? <Spinner /> : <span style={{ fontSize: 24 }}>＋</span>}
          <span>添加图片</span>
        </button>
      ) : null}

      {images.length === 0 && disabled ? <span className="small muted">暂无图片</span> : null}
      {loading ? <Spinner label="读取中" /> : null}
    </div>
  )
}

export function ImageStripWithHint(props: ImageStripProps & { hint?: string }): ReactNode {
  return (
    <div className="content-inner">
      {props.hint ? <div className="small muted">{props.hint}</div> : null}
      <ImageStrip {...props} />
      <div className="small muted">
        图片保存在本机用户目录，数据库只记录文件名；建议单张不超过 40MB。
      </div>
      <div>
        <Button size="small" variant="ghost" onClick={() => void window.api.app.openImagesDir()}>
          打开图片文件夹
        </Button>
      </div>
    </div>
  )
}
