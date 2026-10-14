/**
 * 植株编辑弹窗（实例层）。
 *
 * 与物种编辑的区别：这里只填「我这一株」的信息 —— 昵称、位置、状态、入手日期、备注。
 * 物种级的百科信息在物种库统一维护，避免同一物种养多株时重复劳动。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, FieldDefinition, PlantStatus } from '@core/types'
import type { PlantListItem, SpeciesListItem } from '@shared/api'
import { PLANT_STATUS_ICONS, PLANT_STATUS_LABELS } from '../lib/util'
import { Badge, Button, Field, Modal, Notice, Panel, TextInput, useToast } from '../components/ui'
import { DynamicForm } from '../components/DynamicForm'
import type { FieldContext, FormValues } from '../components/DynamicForm'
import { ImageStrip } from '../components/ImageStrip'

export interface PlantEditorModalProps {
  plant: PlantListItem | null
  environments: Environment[]
  /** 预选物种（例如从物种库「添加一株」进来）。当前还没有入口调用，留给那个流程。 */
  presetSpeciesId?: number
  onClose: () => void
  onSaved: (plantId: number) => void
}

export function PlantEditorModal({
  plant,
  environments,
  presetSpeciesId,
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

  /*
   * 图片区是否可用，取决于这株植物在库里有没有 id。
   *
   * 这里原本是一个 state（`savedId` + `setSavedId`），本意是「保存后不关弹窗，
   * 接着就能加图片」，但保存成功时从来没有调用过 setSavedId，
   * 而调用方的 onSaved 又会直接关掉弹窗 —— 于是那份状态和对应的分支
   * 永远走不到，且一旦将来真的让弹窗不关，第二次保存会因为没有 id 而
   * 再插一条重复植株。改成从 plant 直接派生，语义清楚也不会有这个隐患。
   */
  const savedId = plant?.id ?? null

  /**
   * 「所属物种 / 养护位置 / 状态」现在是**模板字段**（relation / select），
   * 和其它字段一样由 DynamicForm 渲染，值也走同一套 values。
   *
   * 这里保留从 values 读取是为了两处仍然需要它们的逻辑：
   *  - speciesId：未关联物种时显示「就地新建物种」面板
   *  - 其余字段只负责展示，实际落库由 values → 列 的映射完成
   *
   * 注意不能用 `values.env_id ?? plant?.envId`：用户显式清空时值是 null，
   * `??` 会把它当成「没设置」而回退到原值，导致清不掉。
   */
  const pick = <T,>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback)

  const speciesId = pick<number | null>('species_id', plant?.speciesId ?? presetSpeciesId ?? null)

  /**
   * 模板字段的候选项。
   * relation 类型自己不知道「养护位置有哪些」，select 也不知道 growing 该显示成什么，
   * 这些语义只有渲染层掌握，所以在这里注入。
   */
  const fieldContext: FieldContext = useMemo(
    () => ({
      relations: {
        environments: environments.map((e) => ({ id: e.id, label: e.name })),
        species: speciesList.map((s) => ({
          id: s.id,
          label: s.scientificName ? `${s.commonName}（${s.scientificName}）` : s.commonName
        }))
      },
      labels: Object.fromEntries(
        (Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]).map((k) => [
          k,
          `${PLANT_STATUS_ICONS[k]} ${PLANT_STATUS_LABELS[k]}`
        ])
      )
    }),
    [environments, speciesList]
  )

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
          // 系统列不写在 attributes 里，必须逐个补上
          initial.species_id = plant.speciesId
          initial.env_id = plant.envId
          initial.status = plant.status
          if (plant.acquiredAt) initial.acquired_at = plant.acquiredAt
          if (plant.potSize) initial.pot_size = plant.potSize
        } else {
          for (const def of fieldDefs) {
            if (def.defaultValue !== null && def.defaultValue !== undefined) initial[def.key] = def.defaultValue
          }
          if (presetSpeciesId) initial.species_id = presetSpeciesId
          if (!('status' in initial)) initial.status = 'growing'
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
      setValue('species_id', result.species.id)
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
        // speciesId / envId / status 不再单独传：它们已是模板字段，
        // 统一走 values → splitAttributes → 列 的路径，避免两条写入路径打架。
        // 备注同理，走模板字段 plant_notes。
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
                  const ok = await window.api.plants.remove(plant.id)
      // 底层如实返回「有没有真的删到」——不要再无条件说成功
      if (!ok) {
        toast.push('这株植物已经不在了。', 'error')
        onClose()
        return
      }
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
        {/*
          只有「昵称」在这里单独渲染（它是必填的第一项，且校验错误要单独显示）。
          「所属物种 / 养护位置 / 状态」以及盆径、日期、备注全部由模板驱动渲染 ——
          这样它们才能像其它字段一样调整位置、改标签、换分组。
        */}
        <div className="form-grid">
          <Field label="昵称" required error={errors.nickname}>
            <TextInput
              value={typeof values.nickname === 'string' ? values.nickname : ''}
              onChange={(v) => setValue('nickname', v)}
              placeholder="例如：阳台那盆月季"
              invalid={Boolean(errors.nickname)}
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
            </div>
            {/*
              这句话原来写的是「或在**右上角**下拉框里从已有 N 个物种中选择」——
              可右上角根本没有物种下拉框，真正的「所属物种」在**下面**的表单里。
              一句把人支使到不存在的地方的话，用户只会得出「已有的物种不能选」。

              问题从来不是缺一个列表（下面那个 relation 字段本来就能选，
              而且它是模板字段，改标签、排序都跟着走），而是指错了地方。
              所以只把位置说对，不再另起一份选择器。
            */}
            {speciesList.length > 0 ? (
              <div className="small muted" style={{ marginTop: 6 }}>
                已经在库里的（共 {speciesList.length} 个），到下面的「<b>所属物种</b>」里选；
                这里只在库里**没有**这个物种时用来新建。
              </div>
            ) : null}
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
        {/*
          只排除「昵称」—— 它在最上面单独渲染。
          这里曾经还排除了 acquired_at，导致「入手 / 播种日期」在界面上
          根本没有输入框（模板里有这个字段，但表单里永远看不到）。
          模板字段就该怎么定义就怎么显示，不要在这里偷偷过滤。
        */}
        <DynamicForm
          defs={defs.filter((d) => d.key !== 'nickname')}
          values={values}
          errors={errors}
          onChange={setValue}
          context={fieldContext}
        />

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
