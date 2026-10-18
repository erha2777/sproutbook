/**
 * 「网上找图」弹窗：搜必应图片 → 预览 → 挑一张入库。
 *
 * 为什么不让 AI 直接给图：chat 模型没有联网工具，给不出真实图片地址；
 * 图片搜索/生成服务又要各自的 key。这里由**应用**去搜、由**用户**挑，
 * 不依赖 key，也不怕模型编造一个不存在的图。
 *
 * 缩略图是 data URL —— 渲染层 CSP 只放行 `self / plantimg: / data: / blob:`，
 * 远程 https 图片会被拦，所以主进程先下载再转 data URL 给这里用。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { WebImageCandidate } from '@shared/api'
import { Button, Modal, Notice, TextInput } from './ui'

export function ImageSearchModal({
  initialQuery,
  onClose,
  onPick
}: {
  /** 预填的搜索词（物种名 / 昵称）；有值就直接搜一次 */
  initialQuery?: string
  onClose: () => void
  /** 用户挑中一张：把原图地址交回去，由调用方下载入库 */
  onPick: (url: string) => void
}): ReactNode {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [items, setItems] = useState<WebImageCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async (keyword?: string): Promise<void> => {
    const q = (keyword ?? query).trim()
    if (!q) return
    setBusy(true)
    setError(null)
    try {
      setItems(await window.api.images.search(q))
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败')
      setItems([])
    } finally {
      setBusy(false)
    }
  }

  /*
   * 带了预填词就直接搜一次 —— 「网上找图」点进来就该看到候选，
   * 而不是再逼用户按一次「搜索」。
   */
  useEffect(() => {
    if (initialQuery && initialQuery.trim()) void search(initialQuery)
    // 只在打开时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal
      title="网上找图"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">挑一张会下载到本机（文件存在用户目录）</span>
          <span className="spacer" />
          <Button onClick={onClose}>取消</Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="row tight">
          <div style={{ flex: 1 }}>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="物种名 / 俗名，例如 月季"
              autoFocus
            />
          </div>
          <Button variant="primary" onClick={() => void search()} disabled={busy || !query.trim()}>
            {busy ? '搜索中…' : '搜索'}
          </Button>
        </div>
        <div className="small muted">图片来自必应图片搜索；挑中的那张才会下载，没挑不会占空间。</div>

        {error ? <Notice tone="warn">{error}</Notice> : null}

        {items && items.length > 0 ? (
          <div className="web-image-grid">
            {items.map((item) => (
              <button
                key={item.url}
                type="button"
                className="web-image-cell"
                title={item.title ?? '用这张'}
                onClick={() => onPick(item.url)}
              >
                <img src={item.thumb} alt="" />
              </button>
            ))}
          </div>
        ) : null}

        {items !== null && items.length === 0 && !busy && !error ? (
          <div className="small muted">没搜到，换个名称再试。</div>
        ) : null}
      </div>
    </Modal>
  )
}
