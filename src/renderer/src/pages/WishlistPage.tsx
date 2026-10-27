/**
 * 种草清单。
 *
 * 「想买但还没买」的植物：名字 / 店铺 / 价格 / 链接 / 简介 + 一张图。
 *
 * 刻意**不做成植株**：这些还没有状态、没有位置，也不该出现在花园和养护提醒里。
 * 分成两块数据看起来啰嗦，但把"想买"和"在养"混在一起的代价更大
 * （花园里会多出一堆"还没买"的苗，今日待办也会给它们排浇水）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { WishInput, WishItem } from '@core/types'
import { imageUrl } from '../lib/util'
import { ImageStrip } from '../components/ImageStrip'
import { Button, EmptyState, Modal, Notice, Panel, SectionTitle, Spinner, TextArea, TextInput, useToast } from '../components/ui'

interface Draft {
  id?: number
  name: string
  shop: string
  price: string
  url: string
  note: string
}

const EMPTY_DRAFT: Draft = { name: '', shop: '', price: '', url: '', note: '' }

export function WishlistPage(): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<WishItem[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  /** 正在编辑的条目（有了 id 才能挂图片） */
  const [savedId, setSavedId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setItems(await window.api.wishlist.list())
    } catch (error) {
      toast.push(`读取种草清单失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const openNew = (): void => {
    setDraft({ ...EMPTY_DRAFT })
    setSavedId(null)
  }

  const openEdit = (item: WishItem): void => {
    setDraft({
      id: item.id,
      name: item.name,
      shop: item.shop ?? '',
      price: item.price === null ? '' : String(item.price),
      url: item.url ?? '',
      note: item.note ?? ''
    })
    setSavedId(item.id)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) {
      toast.push('植物名不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      const input: WishInput = {
        id: draft.id,
        name: draft.name.trim(),
        shop: draft.shop.trim() || null,
        price: draft.price.trim() === '' ? null : Number(draft.price),
        url: draft.url.trim() || null,
        note: draft.note.trim() || null
      }
      if (input.price !== null && !Number.isFinite(input.price)) {
        toast.push('价格要填数字', 'error')
        return
      }
      const saved = await window.api.wishlist.save(input)
      await load()
      // 存完就关：用户点「保存」的意思就是"这条好了"
      setDraft(null)
      toast.push(`已保存「${saved.name}」`, 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: WishItem): Promise<void> => {
    if (!window.confirm(`从清单里删掉「${item.name}」？图片会一起删掉。`)) return
    try {
      await window.api.wishlist.remove(item.id)
      await load()
      toast.push('已删除', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  const openLink = async (url: string): Promise<void> => {
    try {
      await window.api.app.openExternal(url)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '打不开这个链接', 'error')
    }
  }

  return (
    <div className="content-inner">
      <Panel>
        <SectionTitle
          right={
            <span className="row tight" style={{ alignItems: 'center' }}>
              <span className="small muted">共 {items.length} 条</span>
              <Button variant="primary" size="small" onClick={openNew}>
                + 种一棵草
              </Button>
            </span>
          }
        >
          种草清单
        </SectionTitle>
        <p className="small muted" style={{ marginTop: 0 }}>
          想买、还没买的植物。记下名字、店铺、价格和链接，等手上有空位了再翻出来。
        </p>

        {loading ? (
          <Spinner label="加载中…" />
        ) : items.length === 0 ? (
          <EmptyState
            icon="wish"
            title="清单还是空的"
            hint="刷到心动的品种就记一笔：名字、店铺、价格、链接，外加一张图。"
            action={<Button onClick={openNew}>记一棵想种的</Button>}
          />
        ) : (
          <div className="wish-grid">
            {items.map((item) => (
              <div key={item.id} className="wish-card">
                <div className="wish-cover">
                  {item.coverThumb || item.coverImageId ? (
                    <img src={imageUrl(item.coverThumb) ?? undefined} alt={item.name} />
                  ) : (
                    <span className="wish-cover-empty">还没图</span>
                  )}
                </div>
                <div className="wish-body">
                  <div className="wish-name">{item.name}</div>
                  <div className="wish-meta small muted">
                    {item.shop ? <span>{item.shop}</span> : null}
                    {item.price !== null ? <span className="wish-price">¥{item.price}</span> : null}
                  </div>
                  {item.note ? <div className="wish-note small">{item.note}</div> : null}
                  <div className="row tight wish-actions">
                    {item.url ? (
                      <Button size="small" variant="ghost" onClick={() => void openLink(item.url as string)}>
                        打开链接
                      </Button>
                    ) : null}
                    <span className="spacer" />
                    <Button size="small" variant="ghost" onClick={() => openEdit(item)}>
                      编辑
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => void remove(item)}>
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {draft ? (
        <Modal
          title={draft.id ? '编辑种草记录' : '种一棵草'}
          onClose={() => setDraft(null)}
          footer={
            <>
              <span className="small muted">保存后直接关闭；想加图片，再点这条的「编辑」</span>
              <span className="spacer" />
              <Button onClick={() => setDraft(null)}>取消</Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </>
          }
        >
          <div className="content-inner">
            <label className="field">
              <span className="field-label">
                植物名 <i className="req">*</i>
              </span>
              <TextInput
                value={draft.name}
                onChange={(v) => setDraft({ ...draft, name: v })}
                placeholder="例如：无尽夏「新娘」"
              />
            </label>
            <label className="field">
              <span className="field-label">店铺名</span>
              <TextInput
                value={draft.shop}
                onChange={(v) => setDraft({ ...draft, shop: v })}
                placeholder="哪家店 / 哪位花友"
              />
            </label>
            <label className="field">
              <span className="field-label">价格（元）</span>
              <TextInput
                value={draft.price}
                onChange={(v) => setDraft({ ...draft, price: v })}
                placeholder="29.9"
              />
            </label>
            <label className="field">
              <span className="field-label">链接</span>
              <TextInput
                value={draft.url}
                onChange={(v) => setDraft({ ...draft, url: v })}
                placeholder="https://…"
              />
            </label>
            <label className="field">
              <span className="field-label">简介</span>
              <TextArea
                value={draft.note}
                onChange={(v) => setDraft({ ...draft, note: v })}
                rows={4}
                placeholder="为什么想种、花期、难度、占多大地方…"
              />
            </label>

            {/*
              图片必须挂在**已保存**的记录上（images.wishlist_id 需要真实 id），
              所以新条目先保存再加图；这里如实告诉用户。
            */}
            {savedId !== null ? (
              <ImageStrip
                owner={{ wishlistId: savedId }}
                onChanged={() => void load()}
                searchHint={draft.name}
              />
            ) : (
              <Notice tone="info">新建的记录保存后会关闭弹窗；再点「编辑」就能加图片。</Notice>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
