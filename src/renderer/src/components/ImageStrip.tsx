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
import { ImageViewer } from './ImageViewer'

export interface ImageStripProps {
  owner: { plantId?: number; speciesId?: number; environmentId?: number; wishlistId?: number }
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
  /**
   * 植株编辑器用：把**物种图库**的图也列出来（只读、不能删）。
   * 点一张 = 借它当这株的封面（存 cover_image_id，不复制文件）。
   */
  speciesId?: number | null
}

export function ImageStrip({
  owner,
  disabled,
  onChanged,
  coverId,
  onSetCover,
  searchHint,
  speciesId
}: ImageStripProps): ReactNode {
  const toast = useToast()
  const [images, setImages] = useState<ImageRecord[]>([])
  const [busy, setBusy] = useState(false)
  /** 「网上找图」弹窗 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 所属物种的图片（只读，可借来当封面） */
  const [speciesImages, setSpeciesImages] = useState<ImageRecord[]>([])
  /** 大图查看：看哪一组的第几张 */
  const [viewer, setViewer] = useState<{ images: ImageRecord[]; index: number } | null>(null)

  useEffect(() => {
    if (!speciesId) {
      setSpeciesImages([])
      return
    }
    let alive = true
    void window.api.images
      .list({ speciesId })
      .then((list) => {
        if (alive) setSpeciesImages(list)
      })
      .catch(() => {
        if (alive) setSpeciesImages([])
      })
    return () => {
      alive = false
    }
  }, [speciesId])

  const ownerKey = [owner.plantId ?? "", owner.speciesId ?? "", owner.environmentId ?? ""].join(":")

  const load = useCallback(async () => {
    if (!owner.plantId && !owner.speciesId && !owner.environmentId) {
      setImages([])
      return
    }
    try {
      setImages(await window.api.images.list(owner))
    } catch (error) {
      toast.push(`读取图片失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
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
            onClick={() => setViewer({ images, index: images.indexOf(image) })}
            title="点开看大图"
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

      {onSetCover && (images.length > 0 || speciesImages.length > 0) ? (
        <div className="small muted" style={{ flexBasis: '100%' }}>
          封面：{coverId ? '已选一张照片' : '默认（自己的图优先，没有就借物种的第一张）'}
          {coverId ? (
            <Button size="small" variant="ghost" onClick={() => onSetCover(null)}>
              恢复默认
            </Button>
          ) : (
            <span> · 点照片看大图，大图里可以设为封面</span>
          )}
        </div>
      ) : null}

      {images.length === 0 && disabled ? <span className="small muted">暂无图片</span> : null}

      {/*
        物种图库：只读展示，点一张就借它当封面（不复制文件、不能删）。
        同物种的花长得一样，一株株传图太啰嗦；想用自己拍的照片再走上面三个入口。
      */}
      {speciesImages.length > 0 && onSetCover ? (
        <div className="species-strip">
          <div className="small muted species-strip-title">
            物种图片（只读 · 点开看大图，大图里可以借来当封面）
          </div>
          <div className="image-strip">
            {speciesImages.map((image) => {
              const url = imageUrl(image.thumbPath ?? image.path)
              const borrowed = coverId === image.id
              return (
                <div
                  key={image.id}
                  className={cx('image-thumb', 'pickable', borrowed && 'is-cover')}
                  onClick={() => setViewer({ images: speciesImages, index: speciesImages.indexOf(image) })}
                  title="点开看大图（大图里可以借来当封面）"
                >
                  {url ? <img src={url} alt={image.caption ?? '物种图片'} /> : null}
                  <span className="species-tag">物种</span>
                  {borrowed ? <span className="image-cover-badge">封面</span> : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {viewer ? (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndex={(i) => setViewer({ ...viewer, index: i })}
          onClose={() => setViewer(null)}
          actions={
            onSetCover
              ? (image) => {
                  const on = coverId === image.id
                  return (
                    <Button
                      size="small"
                      variant={on ? 'default' : 'primary'}
                      onClick={() => onSetCover(on ? null : image.id)}
                    >
                      {on ? '取消封面' : '设为封面'}
                    </Button>
                  )
                }
              : undefined
          }
        />
      ) : null}

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
