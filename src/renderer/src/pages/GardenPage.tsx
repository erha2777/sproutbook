/**
 * 花园页 —— 植株列表、搜索、筛选、统计。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, PlantStatus } from '@core/types'
import type { PlantListItem, PlantListItemStats } from '@shared/api'
import { PLANT_STATUS_ICONS, PLANT_STATUS_LABELS, PLANT_STATUS_OPTIONS, currentMonth, imageUrl } from '../lib/util'
import { Badge, Button, EmptyState, Modal, Panel, SectionTitle, SelectInput, Spinner, TextInput, cx, useDebounced, useToast } from '../components/ui'
import { PlantEditorModal } from './PlantEditor'

export function GardenPage({ onGoSpecies }: { onGoSpecies: () => void }): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<PlantListItem[]>([])
  const [stats, setStats] = useState<PlantListItemStats | null>(null)
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | PlantStatus>('')
  const [envId, setEnvId] = useState<string>('')
  const [editing, setEditing] = useState<PlantListItem | 'new' | null>(null)

  const debouncedQuery = useDebounced(query)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [list, stat, envs] = await Promise.all([
        window.api.plants.list({
          query: debouncedQuery || undefined,
          status: status || undefined,
          envId: envId ? Number(envId) : undefined
        }),
        window.api.plants.stats(currentMonth()),
        window.api.env.list()
      ])
      setItems(list.items)
      setStats(stat)
      setEnvironments(envs)
    } catch (error) {
      toast.push(`加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, status, envId, toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const envOptions = useMemo(
    () => [{ value: '', label: '全部位置' }, ...environments.map((e) => ({ value: String(e.id), label: e.name }))],
    [environments]
  )

  const statusOptions = useMemo(
    () => [{ value: '', label: '全部状态' }, ...PLANT_STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))],
    []
  )

  return (
    <>
      <div className="content-inner">
        {stats ? (
          <div className="row">
            <div className="stat-tile">
              <div className="num">{stats.total}</div>
              <div className="label">在养植株</div>
            </div>
            <div className="stat-tile">
              <div className="num" style={{ color: 'var(--green-dark)' }}>
                {stats.bloomingThisMonth}
              </div>
              <div className="label">{currentMonth()} 月开花</div>
            </div>
            <div className="stat-tile">
              <div className="num">{environments.length}</div>
              <div className="label">养护位置</div>
            </div>
            <div className="stat-tile" style={{ flex: 1, minWidth: 220 }}>
              <div className="label" style={{ marginBottom: 6 }}>
                位置分布
              </div>
              {stats.byEnv.length === 0 ? (
                <div className="small muted">还没有植株</div>
              ) : (
                stats.byEnv.map((row) => (
                  <div className="bar-row" key={`${row.envId ?? 'none'}`}>
                    <span className="ellipsis">{row.envName}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{ width: `${stats.total ? (row.count / stats.total) * 100 : 0}%` }}
                      />
                    </span>
                    <span style={{ textAlign: 'right' }}>{row.count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        <Panel>
          <div className="row">
            <div style={{ flex: 1, minWidth: 200 }}>
              <TextInput value={query} onChange={setQuery} placeholder="搜索昵称、物种、备注…" />
            </div>
            <div style={{ width: 160 }}>
              <SelectInput value={status} onChange={(v) => setStatus(v as '' | PlantStatus)} options={statusOptions} />
            </div>
            <div style={{ width: 170 }}>
              <SelectInput value={envId} onChange={setEnvId} options={envOptions} />
            </div>
            {(query || status || envId) && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  setQuery('')
                  setStatus('')
                  setEnvId('')
                }}
              >
                清空筛选
              </Button>
            )}
            <span className="spacer" />
            <Button variant="primary" onClick={() => setEditing('new')}>
              ＋ 新增植株
            </Button>
          </div>
        </Panel>

        {loading ? (
          <Panel>
            <Spinner label="加载中…" />
          </Panel>
        ) : items.length === 0 ? (
          <Panel>
            <EmptyState
              icon="🪴"
              title={query || status || envId ? '没有符合条件的植株' : '花园里还没有植物'}
              hint={
                query || status || envId
                  ? '试试放宽筛选条件。'
                  : '先到「物种库」录入一种植物，再回到这里添加你实际养的那一株。'
              }
              action={
                <div className="row">
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    直接新增植株
                  </Button>
                  <Button onClick={onGoSpecies}>去物种库</Button>
                </div>
              }
            />
          </Panel>
        ) : (
          <>
            <SectionTitle right={<span className="small muted">共 {items.length} 株</span>}>我的植物</SectionTitle>
            <div className="card-grid">
              {items.map((plant) => (
                <PlantCard key={plant.id} plant={plant} onClick={() => setEditing(plant)} />
              ))}
            </div>
          </>
        )}
      </div>

      {editing ? (
        <PlantEditorModal
          plant={editing === 'new' ? null : editing}
          environments={environments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : null}
    </>
  )
}

function PlantCard({ plant, onClick }: { plant: PlantListItem; onClick: () => void }): ReactNode {
  const url = imageUrl(plant.coverThumb)
  const speciesName = plant.species?.commonName ?? '未关联物种'
  return (
    <div className="pixel-card" onClick={onClick} title="点击编辑">
      <div className="card-thumb">
        {url ? <img src={url} alt={plant.nickname} /> : <span className="placeholder">{PLANT_STATUS_ICONS[plant.status]}</span>}
      </div>
      <div className="card-body">
        <div className="card-title">{plant.nickname}</div>
        <div className="card-sub">{speciesName}</div>
        <div className="card-meta">
          <Badge tone={plant.status === 'sick' ? 'warn' : plant.status === 'dead' ? 'safety' : 'ok'}>
            {PLANT_STATUS_LABELS[plant.status]}
          </Badge>
          {plant.envName ? <Badge tone="info">{plant.envName}</Badge> : <Badge tone="muted">未分配位置</Badge>}
          {plant.acquiredAt ? <Badge tone="muted">{plant.acquiredAt}</Badge> : null}
        </div>
      </div>
    </div>
  )
}
