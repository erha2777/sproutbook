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
  describeEffectiveHeight,
  effectiveHeight,
  growthLook,
  readMonthSet,
  sizeScaleFor
} from '@core/growth'
import {
  CARE_ACTION_ICONS,
  CARE_PHASE_HINTS,
  CARE_PHASE_ICONS,
  CARE_PHASE_LABELS,
  CARE_PHASE_OPTIONS,
  dueDescription,
  phaseAgeDays,
  urgencyOf
} from '@core/care'
import type { CarePhase } from '@core/types'
import { flowerColorForSpecies } from '@core/sprite'
import { PLANT_STATUS_ICONS, PLANT_STATUS_LABELS, PLANT_STATUS_OPTIONS, currentMonth, imageUrl } from '../lib/util'
import { todayIso } from '@core/care'
import { PlantSprite } from '../components/PlantSprite'
import { Badge, Button, EmptyState, LoadFailure, Panel, SectionTitle, SelectInput, Spinner, TextInput, useDebounced, useToast } from '../components/ui'
import { PlantEditorModal } from './PlantEditor'


/** 地块里精灵的最大边长（比例 1.0 时）。比格子略小，留出边距。 */
const PLOT_SPRITE_MAX = 78

export function GardenPage({ onGoSpecies }: { onGoSpecies: () => void }): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<PlantListItem[]>([])
  const [stats, setStats] = useState<PlantListItemStats | null>(null)
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [speciesList, setSpeciesList] = useState<Species[]>([])
  /** 每株最近一条待办，场景里直接标出来「这盆该做什么」 */
  const [nextTask, setNextTask] = useState<Record<number, CareTaskListItem>>({})
  const [phases, setPhases] = useState<Record<number, PlantPhaseInfo>>({})
  /** 读取失败的原因。和「确实没有数据」是两回事 —— 不能都显示成空态 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | PlantStatus>('')
  const [envId, setEnvId] = useState<string>('')
  const [view, setView] = useState<'scene' | 'list'>('scene')
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
      setLoadError(null)
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
      const msg = error instanceof Error ? error.message : '未知错误'
      // 记下来，页面主体要显示「读取失败」而不是「还没有植物」
      setLoadError(msg)
      toast.push(`加载失败：${msg}`, 'error')
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

  /**
   * 一株植物在花园里长什么样，需要哪些输入。
   *
   * 注意两类属性的来源不同：株型、成株高度、花期、花色是**物种**的
   * （同品种共有）；栽种方式是**植株**的 —— 同一株薄荷，你可以种盆里
   * 也可以种地里，这不是品种决定的。
   */
  const growthOf = useCallback(
    (plant: PlantListItem) => {
      const sp = plant.species ? speciesById.get(plant.species.id) : undefined
      const attrs = sp?.attributes ?? {}
      const own = plant.attributes ?? {}
      const habitRaw = attrs.growth_habit
      const cultivationRaw = own.cultivation
      const habit = typeof habitRaw === 'string' ? habitRaw : null
      /*
       * 大小：实测 > 推算 > 物种上限。
       * 「成株高度」是这品种能长多大，不是这株现在多大 ——
       * 一株刚买的乔木苗和一株养了十年的，不该画成一样大。
       */
      const heightInput = {
        actualHeight: own.actual_height_cm,
        matureHeight: attrs.mature_height,
        ageYears: own.age_years,
        habit
      }
      const height = effectiveHeight(heightInput)
      return {
        habit,
        cultivation: typeof cultivationRaw === 'string' ? cultivationRaw : null,
        bloomMonths: readMonthSet(attrs.bloom_months),
        dormancyMonths: readMonthSet(attrs.dormancy_months),
        // 物种填了花色就用真的，没填退回按名字散列
        flowerColor: flowerColorForSpecies(attrs as Record<string, unknown>, plant.species?.commonName),
        /** 用来算显示高度的厘米数 */
        heightCm: height.cm,
        /** 物种性状：同株型的植物靠它区分 */
        spriteStyle: {
          leafShape: typeof attrs.leaf_shape === 'string' ? attrs.leaf_shape : null,
          foliageColor: typeof attrs.foliage_color === 'string' ? attrs.foliage_color : null,
          flowerForm: typeof attrs.flower_form === 'string' ? attrs.flower_form : null,
          spread: typeof attrs.spread === 'string' ? attrs.spread : null
        },
        /** 带依据的一句话，例如「65 cm（按成株高度 × 苗龄推算）」 */
        heightText: describeEffectiveHeight(heightInput)
      }
    },
    [speciesById]
  )

  /** 送人的植株不留在花园里 —— 它已经不在你这儿了。 */
  const gardenItems = useMemo(() => items.filter((p) => p.status !== 'gifted'), [items])
  /** 正在给哪一株生成计划（按钮显示「生成中…」） */
  const [generating, setGenerating] = useState<number | null>(null)

  /**
   * 刷新某一株的「下一件事」。
   *
   * 生成计划 / 改阶段之后都要走一次：不重取的话，卡片上会挂着一条
   * 已经不该做（或还没出现）的任务。
   */
  const refreshNextTask = useCallback(async (plantId: number): Promise<void> => {
    const open = await window.api.care.tasks({ status: 'open' })
    const mine = open.filter((t) => t.plantId === plantId).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    setNextTask((prev) => {
      const next = { ...prev }
      if (mine[0]) next[plantId] = mine[0]
      else delete next[plantId]
      return next
    })
  }, [])

  /**
   * 给**这一株**单独生成 / 更新年度计划。
   *
   * 生成计划原来在「养护计划」页，一个按钮把所有植株排一遍。用户要的是按株来：
   * 这株刚加进来、这株改了阶段，都是这一株自己的事，没理由顺手动别人的计划。
   * 接口 `care:generate(plantId, year)` 一直都在（标记阶段时已经在用），只是没有入口。
   */
  const generateForPlant = async (plant: PlantListItem): Promise<void> => {
    setGenerating(plant.id)
    try {
      const year = new Date().getFullYear()
      const r = await window.api.care.generate(plant.id, year)
      toast.push(
        r.created > 0
          ? `已为「${plant.nickname}」生成 ${r.created} 项任务（保留已有 ${r.kept} 项）`
          : `「${plant.nickname}」的 ${year} 年计划已是最新（${r.kept} 项无需变动）`,
        'success'
      )
      await refreshNextTask(plant.id)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '生成计划失败', 'error')
    } finally {
      setGenerating(null)
    }
  }

  /**
   * 就地标记物候阶段。
   *
   * 和养护计划页那个「标记阶段」做的是同一件事，包括**标记完立刻重新生成任务** ——
   * 限定该阶段的规则（缓苗 / 暴雨后救苗）不必再手动建，标完就出现在待办里。
   * 这才是「事件触发」的意思：事件（转缓苗期）一发生，该做的事自己冒出来。
   *
   * 原来这里只写了一句「到『养护计划』页标记后，这里会更准」——
   * 又是指着别处说话。事情就在这一株身上，就地做就行了。
   */
  const markPhase = async (plantId: number, phase: CarePhase | null): Promise<void> => {
    try {
      const info = await window.api.care.setPlantPhase(plantId, phase, null)
      setPhases((prev) => ({ ...prev, [plantId]: info }))
      // 重新生成任务：阶段一变，限定该阶段的规则就该生效/失效
      await window.api.care.generate(plantId, new Date().getFullYear())
      // 「下一件事」也要跟着刷新（阶段一变就可能有新任务，或旧任务失效）
      await refreshNextTask(plantId)
      toast.push(phase ? `已标记为「${CARE_PHASE_LABELS[phase]}」，相关任务已重新生成` : '已清除阶段标记', 'success')
    } catch (error) {
      toast.push(`标记失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  /**
   * 「现状」块：阶段与依据、物候标记、下一件事、按株生成计划。
   *
   * 它跟着**编辑弹窗**一起出现 —— 原来详情是另一个弹窗，看阶段和改信息
   * 要来回切两个框。合并以后「看这一株」和「改这一株」是同一个地方。
   */
  const renderDetail = (plant: PlantListItem): ReactNode => {
    const g = growthOf(plant)
    const info = phases[plant.id]
    // 手动标记的阶段持续了几天（和养护计划页用的是同一个纯函数）
    const age = phaseAgeDays(info?.changedAt)
    const result = deriveGrowthStage({
      status: plant.status,
      phase: info?.phase ?? null,
      bloomMonths: g.bloomMonths,
      dormancyMonths: g.dormancyMonths,
      acquiredAt: plant.acquiredAt,
      today: todayIso()
    })
    const task = nextTask[plant.id]
    return (
      <div>
        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          <Badge tone="ok">🌱 {GROWTH_STAGE_LABELS[result.stage]}</Badge>
          <span className="small muted">
            {GROWTH_SOURCE_LABELS[result.source]} —— {result.reason}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {plant.species?.commonName ?? '未关联物种'}
          {g.habit ? ` · ${g.habit}` : ''}
          {` · ${g.heightText}`}
          {plant.envName ? ` · ${plant.envName}` : ''}
          {` · ${PLANT_STATUS_ICONS[plant.status]} ${PLANT_STATUS_LABELS[plant.status]}`}
        </div>
        <div style={{ marginTop: 8 }}>
          <div className="small" style={{ marginBottom: 4 }}>
            物候阶段：
            {info?.phase ? (
              <>
                <b>
                  {' '}
                  {CARE_PHASE_ICONS[info.phase]} {CARE_PHASE_LABELS[info.phase]}
                </b>
                {age !== null ? (
                  <span
                    className={`small ${age >= 45 ? 'phase-age stale' : 'muted'}`}
                    title={`标记于 ${info?.changedAt?.slice(0, 10) ?? ''}`}
                  >
                    {' '}
                    已 {age} 天{age >= 45 ? '，要不要重新看看？' : ''}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="muted"> 还没标记（标记后，限定该阶段的规则才会生效）</span>
            )}
          </div>
          <div className="row tight" style={{ flexWrap: 'wrap' }}>
            {CARE_PHASE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                size="small"
                variant={info?.phase === opt.value ? 'primary' : undefined}
                onClick={() => void markPhase(plant.id, opt.value as CarePhase)}
                title={CARE_PHASE_HINTS[opt.value as CarePhase]}
              >
                {CARE_PHASE_ICONS[opt.value as CarePhase]} {CARE_PHASE_LABELS[opt.value as CarePhase]}
              </Button>
            ))}
            {info?.phase ? (
              <Button
                size="small"
                onClick={() => void markPhase(plant.id, null)}
                title="清除标记。限定阶段的规则会随之失效"
              >
                清除
              </Button>
            ) : null}
          </div>
        </div>
        <div className="row tight" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="small">
            {task ? (
              <>
                下一件事：<b>{task.title}</b>（{task.dueDate} · {dueDescription(task, todayIso())}）
              </>
            ) : (
              <span className="muted">暂时没有待办</span>
            )}
          </span>
          <span className="spacer" />
          {/*
            按株生成计划就在这一株身上。
            放在「养护计划」页时，用户要排这一株得先离开花园、
            再按一个会动到所有植株的按钮 —— 两件都不对。
          */}
          <Button
            size="small"
            disabled={generating === plant.id}
            title="按规则库为这一株排出全年该做的事（已打勾的不会被覆盖）"
            onClick={() => void generateForPlant(plant)}
          >
            {generating === plant.id ? '生成中…' : '生成计划'}
          </Button>
        </div>
      </div>
    )
  }

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
        ) : loadError ? (
          <LoadFailure what="植株列表" detail={loadError} onRetry={() => void reload()} />
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
              right={<span className="small muted">共 {gardenItems.length} 株 · 点一株看详情 / 编辑</span>}
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
                    className="garden-plot"
                    onClick={() => setEditing(plant)}
                    title={`${plant.nickname} · 点开看详情 / 编辑`}
                  >
                    {/* 高度固定、底部对齐：格子整齐，尺寸又能读出大小差别 */}
                    <div className="plot-stage-area">
                      <PlantSprite
                        habit={g.habit}
                        look={growthLook(result.stage)}
                        cultivation={g.cultivation}
                      spriteStyle={g.spriteStyle}
                        flowerColor={g.flowerColor}
                        size={Math.round(PLOT_SPRITE_MAX * sizeScaleFor(g.heightCm))}
                      />
                    </div>
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


      </div>

      {editing ? (
        <PlantEditorModal
          plant={editing === 'new' ? null : editing}
          environments={environments}
          detail={editing === 'new' ? null : renderDetail(editing)}
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
    <div className="pixel-card" onClick={onClick} title="点开看详情 / 编辑">
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
