/**
 * 物种库页 —— 百科式知识层，可搜索、按科筛选、按开花月份筛选。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SpeciesListItem } from '@shared/api'
import { currentMonth, imageUrl } from '../lib/util'
import { LoadFailure, Badge, Button, EmptyState, Panel, SectionTitle, SelectInput, Spinner, TextInput, useDebounced, useToast } from '../components/ui'

export function SpeciesPage({
  onEdit,
  onCreate,
  onOpenTemplates
}: {
  onEdit: (id: number) => void
  onCreate: () => void
  /** 物种信息模板（从首页挪进「物种库」） */
  onOpenTemplates?: () => void
}): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<SpeciesListItem[]>([])
  const [families, setFamilies] = useState<Array<{ family: string; count: number }>>([])
  /** 读取失败的原因。和「确实没有数据」是两回事，不能都显示成空态 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('')
  const [bloomingOnly, setBloomingOnly] = useState(false)

  const debouncedQuery = useDebounced(query)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [list, fam] = await Promise.all([
        window.api.species.list({
          query: debouncedQuery || undefined,
          family: family || undefined,
          bloomMonth: bloomingOnly ? currentMonth() : undefined
        }),
        window.api.species.families()
      ])
      setLoadError(null)
      setItems(list.items)
      setFamilies(fam)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误'
      setLoadError(msg)
      toast.push(`${msg}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, family, bloomingOnly, toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const familyOptions = useMemo(
    () => [{ value: '', label: `全部科（${families.length}）` }, ...families.map((f) => ({ value: f.family, label: `${f.family}（${f.count}）` }))],
    [families]
  )

  const filtered = useMemo(() => items, [items])

  return (
    <div className="content-inner">
      <Panel>
        <div className="row">
          <div style={{ flex: 1, minWidth: 200 }}>
            <TextInput value={query} onChange={setQuery} placeholder="搜索名称、别名、学名、科…" />
          </div>
          <div style={{ width: 190 }}>
            <SelectInput value={family} onChange={setFamily} options={familyOptions} />
          </div>
          <Button
            variant={bloomingOnly ? 'primary' : 'default'}
            onClick={() => setBloomingOnly((v) => !v)}
            title={`只看 ${currentMonth()} 月开花的植物`}
          >
            🌸 {currentMonth()} 月开花
          </Button>
          {query || family || bloomingOnly ? (
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setQuery('')
                setFamily('')
                setBloomingOnly(false)
              }}
            >
              清空
            </Button>
          ) : null}
          <span className="spacer" />
          {/* 物种信息模板挪进了「物种库」——原来在侧栏是一个独立页 */}
          {onOpenTemplates ? (
            <Button size="small" onClick={onOpenTemplates} title="决定「植物信息」里有哪些项目">
              🧩 信息模板
            </Button>
          ) : null}
          <Button variant="primary" onClick={onCreate}>
            ＋ 新增物种
          </Button>
        </div>
      </Panel>

      {loading ? (
        <Panel>
          <Spinner label="加载中…" />
        </Panel>
      ) : loadError ? (
        <LoadFailure what="物种库" detail={loadError} onRetry={() => void reload()} />
      ) : filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon="📖"
            title={query || family || bloomingOnly ? '没有符合条件的物种' : '物种库还是空的'}
            hint="物种库保存的是植物的「百科信息」：科属、毒性、耐寒、花期等。新增后可以给多株植物共用，也可以用 AI 自动补全。"
            action={
              <Button variant="primary" onClick={onCreate}>
                新增第一个物种
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          <SectionTitle right={<span className="small muted">共 {filtered.length} 种</span>}>物种库</SectionTitle>
          <div className="card-grid">
            {filtered.map((species) => (
              <SpeciesCard key={species.id} species={species} onClick={() => onEdit(species.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SpeciesCard({ species, onClick }: { species: SpeciesListItem; onClick: () => void }): ReactNode {
  const url = imageUrl(species.coverThumb)
  const toxicity = species.attributes.toxicity_level
  const isToxic = toxicity === '有毒' || toxicity === '剧毒'
  const bloom = species.attributes.bloom_months
  // 只统计安全字段：非安全字段不需要核实，挂个角标只会制造噪声
  const pendingReview = species.pendingSafetyFields

  return (
    <div className="pixel-card" onClick={onClick} title="点击编辑">
      <div className="card-thumb">
        {url ? <img src={url} alt={species.commonName} /> : <span className="placeholder">🌿</span>}
      </div>
      <div className="card-body">
        <div className="card-title">{species.commonName}</div>
        <div className="card-sub">{species.scientificName ?? '—'}</div>
        <div className="card-meta">
          {species.family ? <Badge tone="info">{species.family}</Badge> : <Badge tone="muted">未填科</Badge>}
          {isToxic ? <Badge tone="safety">☠ {String(toxicity)}</Badge> : null}
          {bloom ? <Badge tone="ok">花期</Badge> : null}
          {species.plantCount > 0 ? <Badge tone="muted">养了 {species.plantCount} 株</Badge> : null}
          {pendingReview.length > 0 ? (
            <Badge tone="safety">安全字段待核实 {pendingReview.length}</Badge>
          ) : null}
        </div>
      </div>
    </div>
  )
}
