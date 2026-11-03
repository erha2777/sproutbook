/**
 * 大图查看器：点缩略图弹出来看原图，支持左右翻页、Esc 关闭。
 *
 * 养护日志原来那个「弹个 Modal 放一张图」的样子就挺好，这里把它做成了通用件，
 * 顺带补上翻页 —— 一株十几张图，看完一张要关掉再点下一张太累。
 *
 * 键盘：←/→ 翻页、Esc 关闭；点背景空白处也关。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Button } from './ui'

function fullSrc(image: { path: string }): string {
  // 逐段编码：路径里现在是 年-月/归属/文件名，整段编码会把 / 变成 %2F
  const rel = image.path.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/')
  return `plantimg://local/${rel}`
}

export interface ViewerImage {
  id: number
  path: string
  thumbPath: string | null
  caption?: string | null
}

export interface ImageViewerProps {
  images: ViewerImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  title?: string
  /** 底部动作（设为封面 / 删除…），拿得到当前这张 */
  actions?: (image: ViewerImage, index: number) => ReactNode
}

export function ImageViewer({ images, index, onIndex, onClose, title = '照片', actions }: ImageViewerProps): ReactNode {
  const count = images.length
  const safeIndex = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1)
  const current = images[safeIndex]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onIndex((safeIndex - 1 + count) % count)
      else if (event.key === 'ArrowRight') onIndex((safeIndex + 1) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onIndex, safeIndex, count])

  if (!current) return null

  /*
   * 走 portal 挂到 body 上：这个查看器既会在弹窗里用（物品库、植株编辑），
   * 也会在页面里用（养护日志）。弹窗有 transform，会让 fixed 逃不出它的盒子 ——
   * 不 portal 的话大图只能盖住弹窗那一块。
   */
  return createPortal(
    <div
      className="image-viewer"
      role="dialog"
      aria-label={title}
      onClick={(event) => {
        // 只有点到背景（不是图 / 按钮）才关，免得点翻页时手一抖就关了
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-viewer-head">
        <span className="image-viewer-title">{title}</span>
        <span className="image-viewer-count">
          {count > 1 ? `${safeIndex + 1} / ${count}` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="image-viewer-close" onClick={onClose} title="关闭（Esc）">
          ×
        </button>
      </div>

      <div className="image-viewer-stage">
        {count > 1 ? (
          <button
            type="button"
            className="image-viewer-nav prev"
            onClick={() => onIndex((safeIndex - 1 + count) % count)}
            title="上一张（←）"
          >
            ‹
          </button>
        ) : null}
        <img key={current.id} className="image-viewer-img" src={fullSrc(current)} alt={current.caption ?? title} />
        {count > 1 ? (
          <button
            type="button"
            className="image-viewer-nav next"
            onClick={() => onIndex((safeIndex + 1) % count)}
            title="下一张（→）"
          >
            ›
          </button>
        ) : null}
      </div>

      <div className="image-viewer-foot">
        {current.caption ? <span className="small muted">{current.caption}</span> : null}
        <span className="spacer" />
        {/*
         * 找文件用：图片按 年-月/归属 分目录后，有时就是想把它拖出去 / 复制给别人。
         * 用 showItemInFolder 会直接选中这张图，不用翻了再找。
         */}
        <Button
          onClick={() => {
            void window.api.app.revealImage(current.path).then((ok) => {
              if (!ok) window.alert('找不到这张图片的文件（可能已经被移动或删除）')
            })
          }}
          title="在资源管理器里选中这张图"
        >
          打开所在文件夹
        </Button>
        {actions ? actions(current, safeIndex) : null}
        <Button onClick={onClose}>关闭</Button>
      </div>
    </div>,
    document.body
  )
}
