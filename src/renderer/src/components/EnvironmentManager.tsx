/**
 * 养护位置管理。
 *
 * 之前只有首次启动种子写入的 4 个预设位置，界面上没有任何入口可以新增或修改 ——
 * IPC（env:list / env:save / env:delete）其实早就写好了，只是缺这一层。
 *
 * 位置档案不只是个标签：它决定了
 *   - 光照匹配（物种需要的光照时长 vs 这里实际的直射时长）
 *   - 天气预警（需要城市或经纬度 + 是否防冻）
 * 所以这里把光照和气候字段都开放出来。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, EnvironmentInput, LightLevel } from '@core/types'
import { ENV_KIND_LABELS, LIGHT_LEVEL_LABELS } from '../lib/util'
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from './ui'

const KIND_OPTIONS = Object.entries(ENV_KIND_LABELS).map(([value, label]) => ({ value, label }))
const LIGHT_OPTIONS = Object.entries(LIGHT_LEVEL_LABELS).map(([value, label]) => ({ value, label }))

export function EnvironmentManager({ onChanged }: { onChanged?: () => void }): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<Environment[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Environment | 'new' | null>(null)
  const [usage, setUsage] = useState<number | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await window.api.env.list(true))
      const plants = await window.api.plants.list({ limit: 1 })
      setUsage(plants.total)
    } catch (error) {
      toast.push(`加载养护位置失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const remove = async (env: Environment): Promise<void> => {
    if (!window.confirm(`确定删除养护位置「${env.name}」吗？\n引用它的植株会变成「未分配位置」，不会丢失。`)) return
    try {
      await window.api.env.remove(env.id)
      toast.push('已删除', 'success')
      await reload()
      onChanged?.()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  return (
    <Panel>
      <SectionTitle
        right={
          <Button variant="primary" size="small" onClick={() => setEditing('new')}>
            ＋ 新增位置
          </Button>
        }
      >
        养护位置
      </SectionTitle>

      <div className="content-inner">
        <Notice tone="info">
          位置不只是个标签：<b>实际直射光照时长</b>会用来和物种的光照需求做匹配度提示，
          <b>城市 / 经纬度</b>与<b>是否防冻</b>是<b>天气预警</b>的输入。你养的每一株植物都可以指定一个位置。
        </Notice>

        {loading ? (
          <Spinner label="加载中…" />
        ) : items.length === 0 ? (
          <EmptyState
            icon="📍"
            title="还没有养护位置"
            hint="至少建一个，比如「南向阳台」，之后新增植株时就能选它。"
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                新增第一个位置
              </Button>
            }
          />
        ) : (
          <table className="pixel-table">
            <thead>
              <tr>
                <th>名称</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 90 }}>光照</th>
                <th style={{ width: 96 }}>直射时长</th>
                <th style={{ width: 150 }}>气候</th>
                <th style={{ width: 120 }}>状态</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((env) => (
                <tr key={env.id} style={{ opacity: env.archivedAt ? 0.5 : 1 }}>
                  <td>
                    <b>{env.name}</b>
                    {env.archivedAt ? <Badge tone="muted">已归档</Badge> : null}
                  </td>
                  <td className="small">{ENV_KIND_LABELS[env.kind] ?? env.kind}</td>
                  <td className="small">{env.lightLevel ? (LIGHT_LEVEL_LABELS[env.lightLevel] ?? env.lightLevel) : '—'}</td>
                  <td className="small">{env.lightHours === null ? '—' : `${env.lightHours} 小时`}</td>
                  <td className="small">
                    {[env.province, env.city, env.district].filter(Boolean).join(' · ') || '—'}
                    {env.lat !== null && env.lon !== null ? (
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {env.lat.toFixed(3)}, {env.lon.toFixed(3)}
                      </div>
                    ) : null}
                  </td>
                  <td className="small">
                    {env.canHeat ? <Badge tone="warn">可加温</Badge> : null}
                    {env.frostProtected ? <Badge tone="info">防冻</Badge> : null}
                    {!env.canHeat && !env.frostProtected ? <span className="muted">露天</span> : null}
                  </td>
                  <td>
                    <div className="row tight">
                      <Button size="small" onClick={() => setEditing(env)}>
                        编辑
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => void remove(env)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {usage !== null ? (
          <div className="small muted">当前共有 {usage} 株植物，可在「我的花园」里为它们指定位置。</div>
        ) : null}
      </div>

      {editing ? (
        <EnvironmentEditorModal
          env={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
            onChanged?.()
          }}
        />
      ) : null}
    </Panel>
  )
}

function EnvironmentEditorModal({
  env,
  onClose,
  onSaved
}: {
  env: Environment | null
  onClose: () => void
  onSaved: () => void
}): ReactNode {
  const toast = useToast()
  const [name, setName] = useState(env?.name ?? '')
  const [kind, setKind] = useState(env?.kind ?? 'balcony')
  const [lightLevel, setLightLevel] = useState<string>(env?.lightLevel ?? 'full_sun')
  const [lightHours, setLightHours] = useState(env?.lightHours === null || env?.lightHours === undefined ? '' : String(env.lightHours))
  const [province, setProvince] = useState(env?.province ?? '')
  const [city, setCity] = useState(env?.city ?? '')
  const [district, setDistrict] = useState(env?.district ?? '')
  const [lat, setLat] = useState(env?.lat === null || env?.lat === undefined ? '' : String(env.lat))
  const [lon, setLon] = useState(env?.lon === null || env?.lon === undefined ? '' : String(env.lon))
  const [canHeat, setCanHeat] = useState(env?.canHeat ?? false)
  const [frostProtected, setFrostProtected] = useState(env?.frostProtected ?? false)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      toast.push('请填写位置名称', 'error')
      return
    }
    const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))

    const input: EnvironmentInput = {
      id: env?.id,
      name: name.trim(),
      kind,
      lightLevel: (lightLevel || null) as LightLevel | null,
      lightHours: num(lightHours),
      climateZone: env?.climateZone ?? null,
      province: province.trim() || null,
      city: city.trim() || null,
      district: district.trim() || null,
      lat: num(lat),
      lon: num(lon),
      canHeat,
      frostProtected,
      sortOrder: env?.sortOrder ?? 99
    }

    setSaving(true)
    try {
      await window.api.env.save(input)
      toast.push(env ? '位置已更新' : '位置已创建', 'success')
      onSaved()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={env ? `编辑养护位置 · ${env.name}` : '新增养护位置'}
      onClose={onClose}
      footer={
        <>
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
          <Field label="名称" required help="例如：南向阳台、书房窗台、小区花园。">
            <TextInput value={name} onChange={setName} placeholder="南向阳台" />
          </Field>

          <Field label="类型">
            <SelectInput value={kind} onChange={(v) => setKind(v as Environment['kind'])} options={KIND_OPTIONS} />
          </Field>

          <Field label="光照等级" help="用于和物种的「生长环境」需求做匹配。">
            <SelectInput value={lightLevel} onChange={setLightLevel} options={LIGHT_OPTIONS} />
          </Field>

          <Field label="每日直射时长" help="单位小时。会和物种的「光照时长」需求对比，提示是否放错位置。">
            <TextInput value={lightHours} onChange={setLightHours} placeholder="6" />
          </Field>

          <Field label="省份（可选）">
            <TextInput value={province} onChange={setProvince} placeholder="浙江" />
          </Field>

          <Field
            label="城市（可选）"
            help="城市或经纬度任一填好，就能做霜冻预警。手填的经纬度优先级最高。"
          >
            <TextInput value={city} onChange={setCity} placeholder="某市" />
          </Field>

          {/*
            区县这一级只有配了和风天气的 key 才真正影响坐标。
            Open-Meteo 认不出中国的区县（某县县查不到，邻县却查得到），
            所以这里如实说明，而不是让用户以为填了就一定更准。
          */}
          <Field
            label="区 / 县（可选）"
            help="例如「某县县」。只有在「设置 → 天气数据源」配好和风天气的 key 之后，这一级才会真正影响坐标；否则仅作记录，坐标仍落在市一级。"
          >
            <TextInput value={district} onChange={setDistrict} placeholder="某县县" />
          </Field>

          <Field label="纬度（可选）">
            <TextInput value={lat} onChange={setLat} placeholder="30.27" />
          </Field>

          <Field label="经度（可选）">
            <TextInput value={lon} onChange={setLon} placeholder="120.15" />
          </Field>
        </div>

        <div className="row">
          <label className="checkline">
            <input type="checkbox" checked={canHeat} onChange={(e) => setCanHeat(e.target.checked)} />
            冬天可以加温（暖气 / 加热垫）
          </label>
          <label className="checkline">
            <input type="checkbox" checked={frostProtected} onChange={(e) => setFrostProtected(e.target.checked)} />
            能防冻（室内 / 有遮挡）
          </label>
        </div>

        <Notice tone="info">
          这两个开关会参与将来的养护提醒：露天且不能加温的位置，会在低温来临前优先被提示。
        </Notice>
      </div>
    </Modal>
  )
}
