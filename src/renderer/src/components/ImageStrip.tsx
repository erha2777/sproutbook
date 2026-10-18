/**
 * 图片管理条：上传（系统文件对话框）、预览、删除。
 * 图片文件由主进程复制进 userData/images，数据库只存文件名。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImageRecord } from '@core/types'
import { imageUrl } from '../lib/util'
import { Button, Spinner, cx, useToast } from './ui'
import { ImageSearchModal } from './ImageSearchModal'

export interface ImageStripProps {
  owner: { plantId?: number; speciesId?: number }
  disabled?: boolean
  /** 删除后回调，便于外层刷新封面 */
  onChanged?: () => void
  /**
   * 封面相关：传了 `onSetCover` 才启用。
   * 点缩略图 = 设为封面（再点一次取消），选中的那张右下角有「封面」角标。
   */
  coverId?: number | null
  onSetCover?: (imageId: number | null) => void
  /** 「网上找图」的预填搜索词（物种名 / 昵称） */
  searchHint?: string
}

export function ImageStrip({ owner, disabled, onChanged, coverId, onSetCover, searchHint }: ImageStripProps): ReactNode {
  const toast = useToast()
  const [images, setImages] = useState<ImageRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 「网上找图」弹窗 */
  const [searchOpen, setSearchOpen] = useState(false)

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

  /**
   * 从图片地址导入。
   *
   * 为什么是「粘贴链接」而不是「AI 自动找图」：配置的聊天模型（deepseek-chat）
   * 是纯文本的，拿不到图片；图片搜索 / 生成服务又都各自要 key。
   * 粘贴链接是零依赖的兜底：浏览器里能看到的图，右键「复制图片地址」就能进来。
   */
  const importByUrl = async (): Promise<void> => {
    const url = window.prompt(
      '粘贴图片地址（http / https）\n\n在浏览器里右键图片 →「复制图片地址」，然后粘贴到这里。'
    )
    if (!url || !url.trim()) return
    setBusy(true)
    try {
      await window.api.images.importUrl(owner, url.trim())
      toast.push('已从链接导入 1 张图片', 'success')
      await load()
      onChanged?.()
    } catch (error) {
      toast.push(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 网上找图：挑中一张就下载入库（和链接导入同一条下载管线）。
   */
  const importFromSearch = async (url: string): Promise<void> => {
    setBusy(true)
    try {
      await window.api.images.importUrl(owner, url)
      toast.push('已导入 1 张图片', 'success')
      await load()
      onChanged?.()
    } catch (error) {
      toast.push(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="image-strip">
      {images.map((image) => {
        const url = imageUrl(image.thumbPath ?? image.path)
        const isCover = onSetCover !== undefined && coverId === image.id
        return (
          <div
            className={`image-thumb${isCover ? ' is-cover' : ''}${onSetCover ? ' pickable' : ''}`}
            key={image.id}
            onClick={onSetCover ? () => onSetCover(isCover ? null : image.id) : undefined}
            title={onSetCover ? (isCover ? '点一下取消封面，回到默认' : '点一下用这张当封面') : undefined}
          >
            {url ? <img src={url} alt={image.caption ?? '植物图片'} /> : null}
            {isCover ? <span className="image-cover-badge">封面</span> : null}
            {!disabled ? (
              <button className="del" onClick={(event) => { event.stopPropagation(); void remove(image) }} disabled={busy} title="删除这张图片">
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

      {!disabled ? (
        <button className={cx('image-add')} onClick={() => void importByUrl()} disabled={busy} title="粘贴图片地址导入">
          {busy ? <Spinner /> : <span style={{ fontSize: 18 }}>🔗</span>}
          <span>链接导入</span>
        </button>
      ) : null}

      {!disabled ? (
        <button className={cx('image-add')} onClick={() => setSearchOpen(true)} disabled={busy} title="按名称在必应图片里搜">
          {busy ? <Spinner /> : <span style={{ fontSize: 18 }}>🔍</span>}
          <span>网上找图</span>
        </button>
      ) : null}

      {onSetCover && images.length > 0 ? (
        <div className="small muted" style={{ flexBasis: '100%' }}>
          封面：{coverId ? '已选一张照片' : '默认（最早导入的一张）'}
          {coverId ? (
            <Button size="small" variant="ghost" onClick={() => onSetCover(null)}>
              恢复默认
            </Button>
          ) : (
            <span> · 点照片可设成封面</span>
          )}
        </div>
      ) : null}

      {images.length === 0 && disabled ? <span className="small muted">暂无图片</span> : null}
      {loading ? <Spinner label="读取中" /> : null}

      {searchOpen ? (
        <ImageSearchModal
          initialQuery={searchHint}
          onClose={() => setSearchOpen(false)}
          onPick={(url) => {
            setSearchOpen(false)
            void importFromSearch(url)
          }}
        />
      ) : null}
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
