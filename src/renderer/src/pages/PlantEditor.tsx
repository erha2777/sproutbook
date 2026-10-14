/**
 * 植株编辑弹窗（实例层）。
 *
 * 与物种编辑的区别：这里只填「我这一株」的信息 —— 昵称、位置、状态、入手日期、备注。
 * 物种级的百科信息在物种库统一维护，避免同一物种养多株时重复劳动。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, FieldDefinition, PlantStatus } from '@core/types'
import type { PlantListItem, SpeciesListItem } from '@shared/api'
import { PLANT_STATUS_OPTIONS } from '../lib/util'
import { Badge, Button, Field, Modal, Notice, Panel, SelectInput, TextArea, TextInput, useToast } from '../components/ui'
import { DynamicForm } from '../components/DynamicForm'
import type { FormValues } from '../components/DynamicForm'
import { ImageStrip } from '../components/ImageStrip'

export interface PlantEditorModalProps {
  plant: PlantListItem | null
  environments: Environment[]
  /** 预选物种（例如从物种库「添加一株」进来） */
  presetSpeciesId?: number
  presetSpeciesName?: string
  onClose: () => void
  onSaved: (plantId: number) => void
}

export function PlantEditorModal({
  plant,
  environments,
  presetSpeciesId,
  presetSpeciesName,
  onClose,
  onSaved
}: PlantEditorModalProps): ReactNode {
  const toast = useToast()
  const [defs, setDefs] = useState<FieldDefinition[]>([])
  const [speciesList, setSpeciesList] = useState<SpeciesListItem[]>([])
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [speciesQuery, setSpeciesQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<number | null>(plant?.id ?? null)

  const speciesId = (values.__speciesId as number | null | undefined) ?? plant?.speciesId ?? presetSpeciesId ?? null
  const envId = (values.__envId as number | null | undefined) ?? plant?.envId ?? null
  const status = ((values.__status as PlantStatus | undefined) ?? plant?.status ?? 'growing') as PlantStatus
  const notes = (values.__notes as string | undefined) ?? plant?.notes ?? ''

  useEffect(() => {
    void (async () => {
      try {
        const [fieldDefs, species] = await Promise.all([
          window.api.fields.list('plant'),
          window.api.species.list({ limit: 500 })
        ])
        setDefs(fieldDefs)
        setSpeciesList(species.items)

        const initial: FormValues = {}
        if (plant) {
          Object.assign(initial, plant.attributes)
          initial.nickname = plant.nickname
          if (plant.acquiredAt) initial.acquired_at = plant.acquiredAt
          if (plant.potSize) initial.pot_size = plant.potSize
        } else {
          for (const def of fieldDefs) {
            if (def.defaultValue !== null && def.defaultValue !== undefined) initial[def.key] = def.defaultValue
          }
        }
        setValues(initial)
      } catch (error) {
        toast.push(`加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
      }
    })()
  }, [plant, toast])

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const createSpecies = async (): Promise<void> => {
    const name = speciesQuery.trim()
    if (!name) return
    try {
      const result = await window.api.species.save({ values: { common_name: name }, origin: 'manual' })
      if (Object.keys(result.errors).length > 0) {
        toast.push(Object.values(result.errors)[0], 'error')
        return
      }
      setSpeciesList((prev) => [result.species, ...prev])
      setValue('__speciesId', result.species.id)
      setSpeciesQuery('')
      toast.push(`已创建物种「${name}」，可稍后到物种库补充详细信息`, 'success')
    } catch (error) {
      toast.push(`创建失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.api.plants.save({
        id: plant?.id,
        speciesId,
        envId,
        status,
        notes,
        nickname: typeof values.nickname === 'string' ? values.nickname : '',
        values
      })
      if (Object.keys(result.errors).length > 0) {
        setErrors(result.errors)
        toast.push('有必填项或格式问题，请检查标红的字段', 'error')
        return
      }
      if (!result.plant) {
        toast.push('保存失败', 'error')
        return
      }
      toast.push('已保存', 'success')
      onSaved(result.plant.id)
    } catch (error) {
      toast.push(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const currentSpecies = speciesList.find((s) => s.id === speciesId) ?? null
  const filteredSpecies = speciesQuery.trim()
    ? speciesList.filter((s) => s.commonName.toLowerCase().includes(speciesQuery.trim().toLowerCase())).slice(0, 40)
    : speciesList.slice(0, 40)

  return (
    <Modal
      title={plant ? `编辑植株 · ${plant.nickname}` : '新增植株'}
      onClose={onClose}
      footer={
        <>
          {plant ? (
            <Button
              variant="danger"
              size="small"
              onClick={async () => {
                if (!window.confirm(`确定要移除「${plant.nickname}」吗？记录会被归档，不会立即物理删除。`)) return
                try {
                  await window.api.plants.remove(plant.id)
                  toast.push('已移除', 'success')
                  onSaved(plant.id)
                } catch (error) {
                  toast.push(`移除失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
                }
              }}
            >
              移除植株
            </Button>
          ) : null}
          <span className="spacer" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="form-grid">
          <Field label="昵称" required error={errors.nickname}>
            <TextInput
              value={typeof values.nickname === 'string' ? values.nickname : ''}
              onChange={(v) => setValue('nickname', v)}
              placeholder="例如：阳台那盆月季"
              invalid={Boolean(errors.nickname)}
            />
          </Field>

          <Field label="所属物种" help="物种信息在物种库统一维护，多株同类可共用。">
            <SelectInput
              value={speciesId ? String(speciesId) : ''}
              onChange={(v) => setValue('__speciesId', v ? Number(v) : null)}
              placeholder="（未关联）"
              options={speciesList.map((s) => ({
                value: String(s.id),
                label: s.scientificName ? `${s.commonName}（${s.scientificName}）` : s.commonName
              }))}
            />
          </Field>

          <Field label="养护位置" help="位置档案决定了将来的光照匹配与霜冻预警。">
            <SelectInput
              value={envId ? String(envId) : ''}
              onChange={(v) => setValue('__envId', v ? Number(v) : null)}
              placeholder="（未分配）"
              options={environments.map((e) => ({ value: String(e.id), label: e.name }))}
            />
          </Field>

          <Field label="状态">
            <SelectInput
              value={status}
              onChange={(v) => setValue('__status', v as PlantStatus)}
              options={PLANT_STATUS_OPTIONS}
            />
          </Field>
        </div>

        {/* 找不到物种时，就地新建，避免打断录入流程 */}
        {!speciesId ? (
          <Panel flat>
            <div className="small" style={{ fontWeight: 700, marginBottom: 7 }}>
              没找到对应的物种？直接新建一个：
            </div>
            <div className="row">
              <div style={{ width: 220 }}>
                <TextInput value={speciesQuery} onChange={setSpeciesQuery} placeholder="输入植物名称，如 月季" />
              </div>
              <Button size="small" onClick={() => void createSpecies()} disabled={!speciesQuery.trim()}>
                新建物种「{speciesQuery.trim() || '…'}」
              </Button>
              {filteredSpecies.length > 0 ? (
                <span className="small muted">或在右上角下拉框里从已有 {speciesList.length} 个物种中选择</span>
              ) : null}
            </div>
          </Panel>
        ) : currentSpecies ? (
          <Notice tone="info">
            已关联物种 <b>{currentSpecies.commonName}</b>
            {currentSpecies.family ? ` · ${currentSpecies.family}` : ''}
            {currentSpecies.scientificName ? ` · ${currentSpecies.scientificName}` : ''}
            <span className="small muted">　（物种的科、毒、耐寒等信息请到物种库编辑）</span>
          </Notice>
        ) : null}

        <div className="section-title">本株信息</div>
        <DynamicForm
          defs={defs.filter((d) => d.key !== 'nickname' && d.key !== 'acquired_at')}
          values={values}
          errors={errors}
          onChange={setValue}
        />

        <div className="section-title">本株备注</div>
        <TextArea value={notes} onChange={(v) => setValue('__notes', v)} placeholder="记录这株的特殊情况…" rows={3} />

        <div className="section-title">
          图片
          {savedId === null ? <Badge tone="warn">保存后才能添加图片</Badge> : null}
        </div>
        <ImageStrip
          owner={savedId !== null ? { plantId: savedId } : {}}
          disabled={savedId === null}
          onChanged={() => undefined}
        />
      </div>
    </Modal>
  )
}
