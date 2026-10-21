/**
 * 材料库管理弹窗。
 *
 * 材料是配方的砖头：先把「泥炭、珍珠岩、缓释肥」这些登记好单位和分类，
 * 配方里就能直接选，不用每次手打。但也不强制 —— 配方条目允许写库外的临时材料名。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Material, MaterialKind } from '@core/types'
import { MATERIAL_KIND_LABELS, MATERIAL_KIND_OPTIONS } from '@core/recipes'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from './ui'

interface Draft {
  id?: number
  name: string
  kind: MaterialKind
  unit: string
  /** 已有数量：输入框里是字符串，保存时再转数字 */
  stock: string
  note: string
}

const BLANK: Draft = { name: '', kind: 'substrate', unit: '', stock: '', note: '' }

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
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.materials.list()
      setItems(list)
      // 每个材料被多少配方引用 —— 删除前要让人看见
      const counts: Record<number, number> = {}
      for (const m of list) counts[m.id] = await window.api.materials.usage(m.id)
      setUsage(counts)
    } catch (error) {
      toast.push(`加载材料库失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
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
      toast.push('材料名称不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      const stock = draft.stock.trim() === '' ? null : Number(draft.stock)
      if (stock !== null && !Number.isFinite(stock)) {
        toast.push('已有数量要填数字（可以留空）', 'error')
        return
      }
      await window.api.materials.save({
        id: draft.id,
        name: draft.name.trim(),
        kind: draft.kind,
        unit: draft.unit.trim() || null,
        stock,
        note: draft.note.trim() || null
      })
      toast.push(draft.id ? '材料已更新' : '材料已新增', 'success')
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
    if (!window.confirm(`确定删除材料「${m.name}」吗？`)) return
    try {
      const ok = await window.api.materials.remove(m.id)
      await reload()
      toast.push(ok ? '已删除' : '这个材料已经不在了。列表已刷新。', ok ? 'success' : 'error')
      onChanged()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  return (
    <Modal
      title="材料库"
      onClose={onClose}
      footer={
        <>
          <span className="small muted">共 {items.length} 种材料</span>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <Notice tone="info">
          这里登记常用材料与单位，配方里就能直接选。被配方用到的材料<b>不能删除</b> ——
          否则配方里那一条会变成「未命名材料」，你就不知道原来放的是什么了。
        </Notice>

        {draft ? (
          <Panel flat>
            <SectionTitle>{draft.id ? '编辑材料' : '新增材料'}</SectionTitle>
            <div className="form-grid">
              <Field label="名称" required>
                <TextInput
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                  placeholder="例如：珍珠岩"
                />
              </Field>
              <Field label="分类">
                <SelectInput
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v as MaterialKind })}
                  options={MATERIAL_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </Field>
              <Field label="常用单位" help="留空表示按「份」计。">
                <TextInput value={draft.unit} onChange={(v) => setDraft({ ...draft, unit: v })} placeholder="升" />
              </Field>
              <Field
                label="已有数量"
                help={`现在手头大概还有多少（单位同「常用单位」）。留空 = 没记。${draft.unit ? `填数字即可，如 12.5 ${draft.unit}` : '填数字即可，如 20'}`}
              >
                <TextInput
                  value={draft.stock}
                  onChange={(v) => setDraft({ ...draft, stock: v })}
                  placeholder="可选"
                />
              </Field>
              <Field label="备注">
                <TextInput value={draft.note} onChange={(v) => setDraft({ ...draft, note: v })} placeholder="可选" />
              </Field>
            </div>
            <div className="row">
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
              <Button onClick={() => setDraft(null)}>取消</Button>
            </div>
          </Panel>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <Button variant="primary" size="small" onClick={() => setDraft({ ...BLANK })}>
              ＋ 新增材料
            </Button>
          </div>
        )}

        {loading ? (
          <Spinner label="加载中…" />
        ) : items.length === 0 ? (
          <div className="small muted" style={{ marginTop: 12 }}>
            还没有材料。也可以直接在配方里写材料名（选「手填名称」），不登记也能用。
          </div>
        ) : (
          <table className="pixel-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>名称</th>
                <th style={{ width: 90 }}>分类</th>
                <th style={{ width: 80 }}>单位</th>
                <th style={{ width: 90 }}>已有</th>
                <th style={{ width: 100 }}>用于配方</th>
                <th>备注</th>
                <th style={{ width: 110 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name}</b>
                  </td>
                  <td className="small">{MATERIAL_KIND_LABELS[m.kind] ?? m.kind}</td>
                  <td className="small">{m.unit ?? '份'}</td>
                  <td className="small">{m.stock === null ? <span className="muted">—</span> : m.stock}</td>
                  <td className="small">
                    {usage[m.id] ? <Badge tone="info">{usage[m.id]} 个</Badge> : <span className="muted">未使用</span>}
                  </td>
                  <td className="small muted">{m.note ?? ''}</td>
                  <td>
                    <div className="row tight">
                      <Button
                        size="small"
                        onClick={() =>
                          setDraft({
                            id: m.id,
                            name: m.name,
                            kind: m.kind,
                            unit: m.unit ?? '',
                            stock: m.stock === null ? '' : String(m.stock),
                            note: m.note ?? ''
                          })
                        }
                      >
                        编辑
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => void remove(m)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
