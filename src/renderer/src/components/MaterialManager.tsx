/**
 * 物品库管理弹窗。
 *
 * 物品是配方的砖头：先把「泥炭、珍珠岩、缓释肥」这些登记好单位和分类，
 * 配方里就能直接选，不用每次手打。但也不强制 —— 配方条目允许写库外的临时物品名。
 *
 * 编辑方式：**在表格行里就地改**。
 * 早先是把表单放在表格上方，点一行编辑就得到上面填 —— 眼睛和手要来回跳，
 * 改完还得回头找是哪一行；现在点「编辑」那一行自己变成输入框。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImageRecord, Material, MaterialKind } from '@core/types'
import { MATERIAL_KIND_LABELS, MATERIAL_KIND_OPTIONS } from '@core/recipes'
import { imageUrl } from '../lib/util'
import { Badge, Button, Modal, Notice, SelectInput, Spinner, TextInput, useToast } from './ui'
import { ImageViewer } from './ImageViewer'

interface Draft {
  id?: number
  name: string
  kind: MaterialKind
  unit: string
  /** 已有数量：输入框里是字符串，保存时再转数字 */
  stock: string
  /** 单价（元 / 单位） */
  price: string
  note: string
}

const BLANK: Draft = { name: '', kind: 'substrate', unit: '', stock: '', price: '', note: '' }

export function MaterialManager({
  onClose,
  onChanged
}: {
  onClose: () => void
  onChanged: () => void
}): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<Material[]>([])
  const [usage, setUsage] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  /** 正在编辑的那一行（id 为空 = 新增）；null = 没有在编辑 */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  /** 大图查看（物品的照片，按 owner 现取原图列表） */
  const [viewer, setViewer] = useState<{ images: ImageRecord[]; index: number } | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.materials.list()
      setItems(list)
      // 每个物品被多少配方引用 —— 删除前要让人看见
      const counts: Record<number, number> = {}
      for (const m of list) counts[m.id] = await window.api.materials.usage(m.id)
      setUsage(counts)
    } catch (error) {
      toast.push(`加载物品库失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) {
      toast.push('物品名称不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      const stock = draft.stock.trim() === '' ? null : Number(draft.stock)
      if (stock !== null && !Number.isFinite(stock)) {
        toast.push('已有数量要填数字（可以留空）', 'error')
        return
      }
      const price = draft.price.trim() === '' ? null : Number(draft.price)
      if (price !== null && !Number.isFinite(price)) {
        toast.push('单价要填数字（可以留空）', 'error')
        return
      }
      await window.api.materials.save({
        id: draft.id,
        name: draft.name.trim(),
        kind: draft.kind,
        unit: draft.unit.trim() || null,
        stock,
        price,
        note: draft.note.trim() || null
      })
      toast.push(draft.id ? '物品已更新' : '物品已新增（现在可以给它加照片了）', 'success')
      setDraft(null)
      await reload()
      onChanged()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (m: Material): Promise<void> => {
    const used = usage[m.id] ?? 0
    if (used > 0) {
      toast.push(`「${m.name}」被 ${used} 个配方使用，不能删除`, 'error')
      return
    }
    if (!window.confirm(`确定删除物品「${m.name}」吗？`)) return
    try {
      const ok = await window.api.materials.remove(m.id)
      await reload()
      toast.push(ok ? '已删除' : '这个物品已经不在了。列表已刷新。', ok ? 'success' : 'error')
      onChanged()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  /** 传一张照片（第一张就是它的"长相"；换图 = 先删旧的再传） */
  const uploadPhoto = async (m: Material): Promise<void> => {
    try {
      const res = await window.api.images.pick({ materialId: m.id })
      if (res.failures && res.failures.length > 0) {
        toast.push(`有 ${res.failures.length} 张没能导入：${res.failures[0]}`, 'error')
      }
      if (!res.canceled && res.imported.length === 0 && (res.failures?.length ?? 0) === 0) {
        // 选了文件却一张都没进来：说出来，别让人以为按钮坏了
        toast.push('没有导入任何图片，换一张试试', 'error')
      }
      if (res.imported.length > 0) await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '上传失败', 'error')
    }
  }

  const removePhoto = async (m: Material): Promise<void> => {
    if (!m.imageId) return
    if (!window.confirm(`删除「${m.name}」的照片？文件也会一起删掉。`)) return
    try {
      await window.api.images.remove(m.imageId)
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  /** 打开物品照片的大图（images 表里存着原图，缩略图不能直接看） */
  const openViewer = async (m: Material): Promise<void> => {
    try {
      const images = await window.api.images.list({ materialId: m.id })
      if (images.length > 0) setViewer({ images, index: 0 })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '打不开这张图', 'error')
    }
  }

  /** 一行变成输入框（编辑已有，或新增时插在最上面） */
  const editRow = (m: Material): void => {
    setDraft({
      id: m.id,
      name: m.name,
      kind: m.kind,
      unit: m.unit ?? '',
      stock: m.stock === null ? '' : String(m.stock),
      price: m.price === null ? '' : String(m.price),
      note: m.note ?? ''
    })
  }

  const cellInput = (value: string, onChange: (v: string) => void, placeholder?: string): ReactNode => (
    <TextInput value={value} onChange={onChange} placeholder={placeholder} />
  )

  return (
    <Modal
      title="物品库"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">共 {items.length} 种物品</span>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <Notice tone="info">
          这里登记常用物品、单位、库存和照片，配方里就能直接选。被配方用到的物品<b>不能删除</b> ——
          否则配方里那一条会变成「未命名物品」，你就不知道原来放的是什么了。
        </Notice>

        <div className="row tight" style={{ marginTop: 10, marginBottom: 6 }}>
          <Button
            variant="primary"
            size="small"
            onClick={() => setDraft({ ...BLANK })}
            disabled={draft !== null && draft.id === undefined}
          >
            ＋ 新增物品
          </Button>
          {draft && draft.id === undefined ? <span className="small muted">在上面那行填好，点「保存」</span> : null}
          <span className="spacer" />
          <span className="small muted">点「编辑」直接在行里改</span>
        </div>

        {loading ? (
          <Spinner label="加载中…" />
        ) : (
          <table className="pixel-table">
            <thead>
              <tr>
                <th style={{ width: 64 }}>照片</th>
                <th>名称</th>
                <th style={{ width: 100 }}>分类</th>
                <th style={{ width: 76 }}>单位</th>
                <th style={{ width: 84 }}>已有</th>
                <th style={{ width: 84 }}>单价</th>
                <th style={{ width: 96 }}>用于配方</th>
                <th>备注</th>
                <th style={{ width: 158 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {/* 新增：插在表格最上面，跟已有行同一个形状 */}
              {draft && draft.id === undefined ? (
                <tr className="material-row-editing">
                  <td className="small muted">保存后</td>
                  <td>{cellInput(draft.name, (v) => setDraft({ ...draft, name: v }), '例如：珍珠岩')}</td>
                  <td>
                    <SelectInput
                      value={draft.kind}
                      onChange={(v) => setDraft({ ...draft, kind: v as MaterialKind })}
                      options={MATERIAL_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  </td>
                  <td>{cellInput(draft.unit, (v) => setDraft({ ...draft, unit: v }), '份')}</td>
                  <td>{cellInput(draft.stock, (v) => setDraft({ ...draft, stock: v }), '可选')}</td>
                  <td>{cellInput(draft.price, (v) => setDraft({ ...draft, price: v }), '可选')}</td>
                  <td className="small muted">—</td>
                  <td>{cellInput(draft.note, (v) => setDraft({ ...draft, note: v }), '可选')}</td>
                  <td>
                    <div className="row tight">
                      <Button size="small" variant="primary" onClick={() => void save()} disabled={saving}>
                        {saving ? '…' : '保存'}
                      </Button>
                      <Button size="small" onClick={() => setDraft(null)}>
                        取消
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : null}

              {items.length === 0 && !(draft && draft.id === undefined) ? (
                <tr>
                  <td colSpan={9} className="small muted">
                    还没有物品。也可以直接在配方里写物品名（选「手填名称」），不登记也能用。
                  </td>
                </tr>
              ) : null}

              {items.map((m) =>
                draft && draft.id === m.id ? (
                  <tr key={m.id} className="material-row-editing">
                    <td className="small muted">—</td>
                    <td>{cellInput(draft.name, (v) => setDraft({ ...draft, name: v }))}</td>
                    <td>
                      <SelectInput
                        value={draft.kind}
                        onChange={(v) => setDraft({ ...draft, kind: v as MaterialKind })}
                        options={MATERIAL_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      />
                    </td>
                    <td>{cellInput(draft.unit, (v) => setDraft({ ...draft, unit: v }), '份')}</td>
                    <td>{cellInput(draft.stock, (v) => setDraft({ ...draft, stock: v }), '可选')}</td>
                    <td>{cellInput(draft.price, (v) => setDraft({ ...draft, price: v }), '可选')}</td>
                    <td className="small">
                      {usage[m.id] ? <Badge tone="info">{usage[m.id]} 个</Badge> : <span className="muted">未使用</span>}
                    </td>
                    <td>{cellInput(draft.note, (v) => setDraft({ ...draft, note: v }), '可选')}</td>
                    <td>
                      <div className="row tight">
                        <Button size="small" variant="primary" onClick={() => void save()} disabled={saving}>
                          {saving ? '…' : '保存'}
                        </Button>
                        <Button size="small" onClick={() => setDraft(null)}>
                          取消
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={m.id}>
                    <td>
                      <div className="material-photo">
                        {m.imageThumb ? (
                          <img
                            src={imageUrl(m.imageThumb) ?? ''}
                            alt={m.name}
                            title="点开看大图"
                            style={{ cursor: 'zoom-in' }}
                            onClick={() => void openViewer(m)}
                          />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <b>{m.name}</b>
                    </td>
                    <td className="small">{MATERIAL_KIND_LABELS[m.kind] ?? m.kind}</td>
                    <td className="small">{m.unit ?? '份'}</td>
                    <td className="small">{m.stock === null ? <span className="muted">—</span> : m.stock}</td>
                    <td className="small">{m.price === null ? <span className="muted">—</span> : `¥${m.price}`}</td>
                    <td className="small">
                      {usage[m.id] ? <Badge tone="info">{usage[m.id]} 个</Badge> : <span className="muted">未使用</span>}
                    </td>
                    <td className="small muted">{m.note ?? ''}</td>
                    <td>
                      <div className="row tight">
                        <Button size="small" onClick={() => editRow(m)}>
                          编辑
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => void remove(m)}>
                          删除
                        </Button>
                      </div>
                      <div className="row tight" style={{ marginTop: 4 }}>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => void uploadPhoto(m)}
                          title={m.imageThumb ? '换一张照片' : '给它拍一张 / 传一张'}
                        >
                          {m.imageThumb ? '换图' : '📷 照片'}
                        </Button>
                        {m.imageThumb ? (
                          <Button size="small" variant="ghost" onClick={() => void removePhoto(m)} title="删掉照片">
                            ×图
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>

      {viewer ? (
        <ImageViewer
          title="物品照片"
          images={viewer.images}
          index={viewer.index}
          onIndex={(i) => setViewer({ ...viewer, index: i })}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </Modal>
  )
}
