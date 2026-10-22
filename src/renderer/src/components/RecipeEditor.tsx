/**
 * 配方编辑弹窗。
 *
 * 界面上的两个重点：
 *  1. **实时摘要**：边填边显示「泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2」，
 *     比例写错了一眼就能看出来。
 *  2. **用量换算**：输入份数立刻算出每样材料要多少 ——
 *     这是配方的实际用途（「配 10 盆要各买多少」），不放在保存之后。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Material, MaterialKind, RecipeItem, RecipeListItem } from '@core/types'
import { MATERIAL_KIND_OPTIONS, RECIPE_KIND_SUGGESTIONS, scaleRecipe, summarizeRecipe, validateRecipe } from '@core/recipes'
import { Badge, Button, Field, Modal, Notice, SelectInput, TextArea, TextInput, useToast } from './ui'

/** 草稿条目：数值字段在编辑期保持字符串，避免「输到一半被转成数字」。 */
interface DraftItem {
  key: string
  materialId: number | null
  name: string
  ratioPart: string
  amount: string
  unit: string
  note: string
}

let seq = 0
function blankItem(): DraftItem {
  seq += 1
  return { key: `item-${seq}`, materialId: null, name: '', ratioPart: '', amount: '', unit: '', note: '' }
}

const NEW_MATERIAL = '__new__'
const MANUAL = '__manual__'

function toDraft(item: RecipeItem): DraftItem {
  seq += 1
  return {
    key: `item-${seq}`,
    materialId: item.materialId,
    name: item.name ?? '',
    ratioPart: item.ratioPart === null ? '' : String(item.ratioPart),
    amount: item.amount === null ? '' : String(item.amount),
    unit: item.unit ?? '',
    note: item.note ?? ''
  }
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function RecipeEditor({
  recipe,
  onClose,
  onSaved
}: {
  recipe: RecipeListItem | null
  onClose: () => void
  onSaved: () => void
}): ReactNode {
  const toast = useToast()
  const [name, setName] = useState(recipe?.name ?? '')
  const [kind, setKind] = useState(recipe?.kind ?? '配土')
  const [note, setNote] = useState(recipe?.note ?? '')
  const [available, setAvailable] = useState(recipe?.available ?? false)
  const [items, setItems] = useState<DraftItem[]>(recipe ? recipe.items.map(toDraft) : [blankItem()])
  const [materials, setMaterials] = useState<Material[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [portions, setPortions] = useState('1')

  /** 正在为哪个条目新建材料（item.key），以及新建表单的内容 */
  const [newFor, setNewFor] = useState<string | null>(null)
  const [newMat, setNewMat] = useState({ name: '', kind: 'substrate' as MaterialKind, unit: '' })

  const reloadMaterials = useCallback(async () => {
    try {
      setMaterials((await window.api.materials.list()).sort((a, b) =>
        `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`, 'zh')
      ))
    } catch (error) {
      toast.push(`加载材料库失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }, [toast])

  useEffect(() => {
    void reloadMaterials()
  }, [reloadMaterials])

  const materialNames = useMemo(() => new Map(materials.map((m) => [m.id, m.name])), [materials])

  /** 供摘要与换算使用的领域条目（把草稿里的字符串转成数值） */
  const domainItems: RecipeItem[] = useMemo(
    () =>
      items.map((it, index) => ({
        materialId: it.materialId,
        name: it.name.trim() || null,
        ratioPart: numOrNull(it.ratioPart),
        amount: numOrNull(it.amount),
        unit: it.unit.trim() || null,
        note: it.note.trim() || null,
        sortOrder: index
      })),
    [items]
  )

  const summary = summarizeRecipe(domainItems, materialNames)
  const scaled = scaleRecipe(domainItems, Number(portions) || 1, materialNames)

  const patch = (key: string, next: Partial<DraftItem>): void => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...next } : it)))
    setErrors({})
  }

  const materialOptions = (): Array<{ value: string; label: string }> => [
    { value: MANUAL, label: '（手填名称）' },
    ...MATERIAL_KIND_OPTIONS.flatMap((k) =>
      materials.filter((m) => m.kind === k.value).map((m) => ({ value: String(m.id), label: `${m.name}` }))
    ),
    { value: NEW_MATERIAL, label: '＋ 新建材料…' }
  ]

  const onMaterialChange = (item: DraftItem, value: string): void => {
    if (value === NEW_MATERIAL) {
      setNewFor(item.key)
      setNewMat({ name: '', kind: 'substrate', unit: '' })
      return
    }
    if (value === MANUAL) {
      patch(item.key, { materialId: null })
      return
    }
    const id = Number(value)
    const material = materials.find((m) => m.id === id)
    // 选中材料时顺手把它登记的常用单位带过来，省一次输入
    patch(item.key, { materialId: id, name: '', unit: item.unit.trim() || material?.unit || '' })
  }

  const createMaterial = async (itemKey: string): Promise<void> => {
    if (!newMat.name.trim()) {
      toast.push('材料名称不能为空', 'error')
      return
    }
    try {
      const created = await window.api.materials.save({
        name: newMat.name.trim(),
        kind: newMat.kind,
        unit: newMat.unit.trim() || null,
        stock: null,
        price: null,
        note: null
      })
      setMaterials((prev) => [...prev, created])
      patch(itemKey, { materialId: created.id, name: '', unit: created.unit ?? '' })
      setNewFor(null)
      toast.push(`已新增材料「${created.name}」`, 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '新建材料失败', 'error')
    }
  }

  const submit = async (): Promise<void> => {
    // 先在本地校验一遍，错误能立刻标到对应条目上，不必等一次往返
    const localErrors = validateRecipe({
      name,
      items: domainItems.map((i) => ({
        materialId: i.materialId,
        name: i.name,
        ratioPart: i.ratioPart,
        amount: i.amount
      }))
    })
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors)
      toast.push('请补全标红的条目', 'error')
      return
    }

    setSaving(true)
    try {
      const result = await window.api.recipes.save({
        id: recipe?.id,
        name: name.trim(),
        kind: kind.trim() || '配土',
        note: note.trim() || null,
        available,
        items: domainItems
      })
      if (Object.keys(result.errors).length > 0) {
        setErrors(result.errors)
        toast.push(Object.values(result.errors)[0], 'error')
        return
      }
      toast.push(recipe ? '配方已更新' : '配方已创建', 'success')
      onSaved()
    } catch (error) {
      toast.push(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={recipe ? `编辑配方 · ${recipe.name}` : '新增配方'}
      onClose={onClose}
      footer={
        <>
          <span className="small muted">摘要：{summary}</span>
          <span className="spacer" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="form-grid">
          <Field label="配方名称" required error={errors.name}>
            <TextInput value={name} onChange={setName} placeholder="例如：通用观叶配土" invalid={Boolean(errors.name)} />
          </Field>
          <Field label="类型" help="自由填写，也可以直接用下面的建议值。">
            <TextInput value={kind} onChange={setKind} placeholder="配土" />
          </Field>
        </div>

        <div className="row tight" style={{ marginTop: -6, marginBottom: 10 }}>
          <span className="small muted">常用类型：</span>
          {RECIPE_KIND_SUGGESTIONS.map((k) => (
            <Button key={k} size="small" variant={kind === k ? 'primary' : 'ghost'} onClick={() => setKind(k)}>
              {k}
            </Button>
          ))}
        </div>

        <Field label="说明">
          <TextArea value={note} onChange={setNote} rows={2} placeholder="什么时候用、有什么注意点…" />
        </Field>

        {/*
          「可使用」是**手动标记**：材料齐了、现在就能配，就勾上。
          不从库存自动推算 —— 配方是配比，一次做多少由人定，自动判断只会猜错。
        */}
        <div className="row tight" style={{ marginTop: 6 }}>
          <label className="check-row">
            <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> 现在可以使用
            （材料齐了）
          </label>
        </div>

        <div className="section-title">
          材料
          <span className="small muted" style={{ fontWeight: 400, marginLeft: 6 }}>
            比例填「份」，用量填数量和单位；两者填一个就行
          </span>
        </div>

        {/* 表头必须和数据行用同一套列宽，否则标题和输入框对不上 */}
        <div className="row tight small muted" style={{ marginBottom: 4, flexWrap: 'nowrap' }}>
          <div style={{ width: 190 }}>材料</div>
          <div style={{ width: 150 }}>或手填名称</div>
          <div style={{ width: 78 }}>比例（份）</div>
          <div style={{ width: 88 }}>用量</div>
          <div style={{ width: 74 }}>单位</div>
          <div style={{ flex: 1 }}>备注</div>
          <div style={{ width: 30 }} />
        </div>

        {items.map((item, index) => {
          const itemError = errors[String(index)]
          return (
            <div key={item.key} style={{ marginBottom: 6 }}>
              <div className="row tight" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                <div style={{ width: 190 }}>
                  <SelectInput
                    value={item.materialId === null ? MANUAL : String(item.materialId)}
                    onChange={(v) => onMaterialChange(item, v)}
                    options={materialOptions()}
                    invalid={Boolean(itemError)}
                  />
                </div>

                {item.materialId === null ? (
                  <div style={{ width: 150 }}>
                    <TextInput
                      value={item.name}
                      onChange={(v) => patch(item.key, { name: v })}
                      placeholder="库外材料名"
                      invalid={Boolean(itemError)}
                    />
                  </div>
                ) : (
                  <div style={{ width: 150 }} />
                )}

                <div style={{ width: 78 }}>
                  <TextInput value={item.ratioPart} onChange={(v) => patch(item.key, { ratioPart: v })} placeholder="5" />
                </div>
                <div style={{ width: 88 }}>
                  <TextInput value={item.amount} onChange={(v) => patch(item.key, { amount: v })} placeholder="20" />
                </div>
                <div style={{ width: 74 }}>
                  <TextInput value={item.unit} onChange={(v) => patch(item.key, { unit: v })} placeholder="克" />
                </div>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <TextInput value={item.note} onChange={(v) => patch(item.key, { note: v })} placeholder="可选" />
                </div>
                <Button
                  size="small"
                  variant="ghost"
                  title="删除这一条"
                  disabled={items.length === 1}
                  onClick={() => setItems((prev) => prev.filter((it) => it.key !== item.key))}
                >
                  ×
                </Button>
              </div>

              {itemError ? (
                <div className="small" style={{ color: '#7a1f14' }}>
                  {itemError}
                </div>
              ) : null}

              {newFor === item.key ? (
                <div className="row tight" style={{ marginTop: 6, padding: 8, background: 'var(--wood-panel-light)' }}>
                  <div style={{ width: 170 }}>
                    <TextInput
                      value={newMat.name}
                      onChange={(v) => setNewMat((s) => ({ ...s, name: v }))}
                      placeholder="新材料名称"
                    />
                  </div>
                  <div style={{ width: 130 }}>
                    <SelectInput
                      value={newMat.kind}
                      onChange={(v) => setNewMat((s) => ({ ...s, kind: v as MaterialKind }))}
                      options={MATERIAL_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  </div>
                  <div style={{ width: 90 }}>
                    <TextInput
                      value={newMat.unit}
                      onChange={(v) => setNewMat((s) => ({ ...s, unit: v }))}
                      placeholder="单位"
                    />
                  </div>
                  <Button size="small" variant="primary" onClick={() => void createMaterial(item.key)}>
                    保存材料
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => setNewFor(null)}>
                    取消
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}

        <div className="row" style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            ＋ 添加材料
          </Button>
        </div>

        <div style={{ marginTop: 14 }}>
          <Notice tone="info">
            <b>摘要</b>：{summary}
          </Notice>
        </div>

        <div className="section-title">用量换算</div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 120 }}>
            <Field label="份数">
              <TextInput value={portions} onChange={setPortions} placeholder="1" />
            </Field>
          </div>
          <div className="small muted" style={{ paddingBottom: 8 }}>
            1 份 = 这个配方本身。配 10 盆就填 10。
          </div>
        </div>
        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          {scaled.map((s, i) => (
            <span key={i} className="pixel-tag" title={s.note ?? undefined}>
              {s.name}
              <Badge tone="ok">{s.text}</Badge>
            </span>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          材料库共 {materials.length} 种
          {MATERIAL_KIND_OPTIONS.map((o) => (
            <span key={o.value}>
              {' · '}
              {o.label} {materials.filter((m) => m.kind === o.value).length}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}
