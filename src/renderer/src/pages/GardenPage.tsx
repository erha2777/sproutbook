/**
 * 花园页 —— 植株管理。
 *
 * 两种视图，不是替代关系：
 *  - **花园**：一眼看到每株长到哪一步了、哪盆该浇水了。回答「我的花园现在什么样」
 *  - **列表**：搜索、筛选、批量管理。回答「我要找某一株」
 *
 * 场景里的每株都是用 `src/core/sprite.ts` 现画的像素图，
 * 形状由物种的株型决定，大小和颜色由生长阶段决定。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, PlantStatus, Species } from '@core/types'
import type { CareTaskListItem, PlantListItem, PlantListItemStats, PlantPhaseInfo } from '@shared/api'
import {
  GROWTH_SOURCE_LABELS,
  GROWTH_STAGE_LABELS,
  deriveGrowthStage,
  growthLook,
  readMonthSet
} from '@core/growth'
import { CARE_ACTION_ICONS, CARE_PHASE_ICONS, CARE_PHASE_LABELS, dueDescription, urgencyOf } from '@core/care'
import { flowerColorForSpecies } from '@core/sprite'
import { PLANT_STATUS_ICONS, PLANT_STATUS_LABELS, PLANT_STATUS_OPTIONS, currentMonth, imageUrl } from '../lib/util'
import { todayIso } from '@core/care'
import { PlantSprite } from '../components/PlantSprite'
import { Badge, Button, EmptyState, Panel, SectionTitle, SelectInput, Spinner, TextInput, useDebounced, useToast } from '../components/ui'
import { PlantEditorModal } from './PlantEditor'


export function GardenPage({ onGoSpecies }: { onGoSpecies: () => void }): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<PlantListItem[]>([])
  const [stats, setStats] = useState<PlantListItemStats | null>(null)
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [speciesList, setSpeciesList] = useState<Species[]>([])
  /** 每株最近一条待办，场景里直接标出来「这盆该做什么」 */
  const [nextTask, setNextTask] = useState<Record<number, CareTaskListItem>>({})
  const [phases, setPhases] = useState<Record<number, PlantPhaseInfo>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | PlantStatus>('')
  const [envId, setEnvId] = useState<string>('')
  const [view, setView] = useState<'scene' | 'list'>('scene')
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<PlantListItem | 'new' | null>(null)

  const debouncedQuery = useDebounced(query)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [list, stat, envs, species, openTasks] = await Promise.all([
        window.api.plants.list({
          query: debouncedQuery || undefined,
          status: status || undefined,
          envId: envId ? Number(envId) : undefined
        }),
        window.api.plants.stats(currentMonth()),
        window.api.env.list(),
        window.api.species.list({ limit: 500 }),
        window.api.care.tasks({ status: 'open' })
      ])
      setItems(list.items)
      setStats(stat)
      setEnvironments(envs)
      setSpeciesList(species.items)

      // 每株只留最近的一条待办：地块上放不下更多，也没必要
      const byPlant: Record<number, CareTaskListItem> = {}
      for (const t of openTasks) {
        if (t.plantId === null) continue
        const cur = byPlant[t.plantId]
        const rank = { overdue: 0, due: 1, soon: 2, later: 3, closed: 4 }
        if (!cur || rank[urgencyOf(t, todayIso())] < rank[urgencyOf(cur, todayIso())]) byPlant[t.plantId] = t
      }
      setNextTask(byPlant)

      const infos = await Promise.all(list.items.map((p) => window.api.care.plantPhase(p.id)))
      setPhases(Object.fromEntries(infos.map((i) => [i.plantId, i])))
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

  /** 物种 id → 生长相关的属性 */
  const speciesById = useMemo(() => new Map(speciesList.map((s) => [s.id, s])), [speciesList])

  const growthOf = useCallback(
    (plant: PlantListItem) => {
      const sp = plant.species ? speciesById.get(plant.species.id) : undefined
      const attrs = sp?.attributes ?? {}
      const habitRaw = attrs.growth_habit
      return {
        habit: typeof habitRaw === 'string' ? habitRaw : null,
        bloomMonths: readMonthSet(attrs.bloom_months),
        dormancyMonths: readMonthSet(attrs.dormancy_months),
        // 物种填了花色就用真的，没填退回按名字散列
        flowerColor: flowerColorForSpecies(attrs as Record<string, unknown>, plant.species?.commonName)
      }
    },
    [speciesById]
  )

  /** 送人的植株不留在花园里 —— 它已经不在你这儿了。 */
  const gardenItems = useMemo(() => items.filter((p) => p.status !== 'gifted'), [items])

  const selectedPlant = gardenItems.find((p) => p.id === selected) ?? null

  const patch = (p: Partial<{ query: string; status: '' | PlantStatus; envId: string }>): void => {
    if (p.query !== undefined) setQuery(p.query)
    if (p.status !== undefined) setStatus(p.status)
    if (p.envId !== undefined) setEnvId(p.envId)
  }

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
              <div className="num">{stats.bloomingThisMonth}</div>
              <div className="label">本月开花</div>
            </div>
            <div className="stat-tile">
              <div className="num">{stats.byEnv.length}</div>
              <div className="label">养护位置</div>
            </div>
            <div className="stat-tile">
              <div className="num">{stats.byFamily.length}</div>
              <div className="label">涉及科属</div>
            </div>
          </div>
        ) : null}

        <Panel>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div style={{ width: 190 }}>
              <TextInput value={query} onChange={(v) => patch({ query: v })} placeholder="搜索昵称 / 物种 / 别名…" />
            </div>
            <div style={{ width: 158 }}>
              <SelectInput value={status} onChange={(v) => patch({ status: v as '' | PlantStatus })} options={statusOptions} />
            </div>
            <div style={{ width: 158 }}>
              <SelectInput value={envId} onChange={(v) => patch({ envId: v })} options={envOptions} />
            </div>
            <span className="spacer" />
            {/*
              视图切换用分段控件，而不是两个主按钮。
              原来激活的那个用的是主操作色（和「＋新增植株」一样的绿），
              读起来像「点我会发生什么」；于是「已经在这个视图」时点下去
              毫无反应，看起来就像坏了。现在选中态是「你在这里」的样子。
            */}
            <span className="small muted">视图</span>
            <div className="view-tabs">
              <button
                className={`view-tab${view === 'scene' ? ' on' : ''}`}
                onClick={() => setView('scene')}
                title="用像素图看每株长到哪一步"
              >
                🌿 花园
              </button>
              <button
                className={`view-tab${view === 'list' ? ' on' : ''}`}
                onClick={() => setView('list')}
                title="搜索、筛选、批量管理"
              >
                ▦ 列表
              </button>
            </div>
            <Button variant="primary" onClick={() => setEditing('new')}>
              ＋ 新增植株
            </Button>
          </div>
        </Panel>

        {loading ? (
          <Panel>
            <Spinner label="加载中…" />
          </Panel>
        ) : gardenItems.length === 0 ? (
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
        ) : view === 'scene' ? (
          <Panel>
            <SectionTitle
              right={<span className="small muted">共 {gardenItems.length} 株 · 点一株看它在什么阶段</span>}
            >
              我的花园
            </SectionTitle>
            <div className="garden-scene">
              {gardenItems.map((plant) => {
                const g = growthOf(plant)
                const phase = phases[plant.id]?.phase ?? null
                const result = deriveGrowthStage({
                  status: plant.status,
                  phase,
                  bloomMonths: g.bloomMonths,
                  dormancyMonths: g.dormancyMonths,
                  acquiredAt: plant.acquiredAt,
                  today: todayIso()
                })
                const task = nextTask[plant.id]
                return (
                  <button
                    key={plant.id}
                    className={`garden-plot${selected === plant.id ? ' selected' : ''}`}
                    onClick={() => setSelected(selected === plant.id ? null : plant.id)}
                    title={`${plant.nickname} · ${GROWTH_STAGE_LABELS[result.stage]}`}
                  >
                    <PlantSprite
                      habit={g.habit}
                      look={growthLook(result.stage)}
                      flowerColor={g.flowerColor}
                      size={58}
                    />
                    <div className="plot-name ellipsis">{plant.nickname}</div>
                    <div className="plot-stage">{GROWTH_STAGE_LABELS[result.stage]}</div>
                    {task ? (
                      <div className={`plot-task ${urgencyOf(task, todayIso())}`}>
                        {CARE_ACTION_ICONS[task.actionType]} {task.title}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
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

        {/* 选中某株后的详情：把「为什么是这个阶段」讲清楚 */}
        {selectedPlant
          ? (() => {
              const g = growthOf(selectedPlant)
              const info = phases[selectedPlant.id]
              const result = deriveGrowthStage({
                status: selectedPlant.status,
                phase: info?.phase ?? null,
                bloomMonths: g.bloomMonths,
                dormancyMonths: g.dormancyMonths,
                acquiredAt: selectedPlant.acquiredAt,
                today: todayIso()
              })
              const task = nextTask[selectedPlant.id]
              return (
                <Panel>
                  <SectionTitle
                    right={
                      <Button size="small" onClick={() => setEditing(selectedPlant)}>
                        编辑这株
                      </Button>
                    }
                  >
                    {selectedPlant.nickname}
                  </SectionTitle>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <PlantSprite
                      habit={g.habit}
                      look={growthLook(result.stage)}
                      flowerColor={g.flowerColor}
                      size={96}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row tight" style={{ flexWrap: 'wrap' }}>
                        <Badge tone="ok">🌱 {GROWTH_STAGE_LABELS[result.stage]}</Badge>
                        <span className="small muted">
                          {GROWTH_SOURCE_LABELS[result.source]} —— {result.reason}
                        </span>
                      </div>
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {selectedPlant.species?.commonName ?? '未关联物种'}
                        {g.habit ? ` · ${g.habit}` : ''}
                        {selectedPlant.envName ? ` · ${selectedPlant.envName}` : ''}
                        {` · ${PLANT_STATUS_ICONS[selectedPlant.status]} ${PLANT_STATUS_LABELS[selectedPlant.status]}`}
                      </div>
                      {info?.phase ? (
                        <div className="small" style={{ marginTop: 4 }}>
                          你标记的阶段：{CARE_PHASE_ICONS[info.phase]} {CARE_PHASE_LABELS[info.phase]}
                        </div>
                      ) : (
                        <div className="small muted" style={{ marginTop: 4 }}>
                          还没标记物候阶段 —— 到「养护计划」页标记后，这里会更准。
                        </div>
                      )}
                      <div className="small" style={{ marginTop: 4 }}>
                        {task ? (
                          <>
                            下一件事：<b>{task.title}</b>（{task.dueDate} · {dueDescription(task, todayIso())}）
                          </>
                        ) : (
                          <span className="muted">暂时没有待办</span>
                        )}
                      </div>
                    </div>
                  </div>
                </Panel>
              )
            })()
          : null}
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
