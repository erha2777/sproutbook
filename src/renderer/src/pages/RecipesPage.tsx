/**
 * 配方页：配土、肥料、药剂的配法。
 *
 * 与「信息模板」的区别：模板管的是**一株植物有哪些字段**，
 * 配方管的是**几样东西按什么比例混**。所以这里的主角是条目表与比例摘要。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { RecipeListItem } from '@core/types'
import { LoadFailure, Badge, Button, EmptyState, Notice, Panel, SectionTitle, SelectInput, Spinner, useDebounced, useToast } from '../components/ui'
import { RecipeEditor } from '../components/RecipeEditor'
import { MaterialManager } from '../components/MaterialManager'

export function RecipesPage(): ReactNode {
  const toast = useToast()
  const [items, setItems] = useState<RecipeListItem[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [stats, setStats] = useState({ materials: 0, recipes: 0 })
  /** 读取失败的原因。和「确实没有数据」是两回事，不能都显示成空态 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<RecipeListItem | 'new' | null>(null)
  const [managingMaterials, setManagingMaterials] = useState(false)
  const debouncedQuery = useDebounced(query, 220)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [list, kindList, s] = await Promise.all([
        window.api.recipes.list({ query: debouncedQuery || undefined, kind: kind || undefined, includeArchived: showArchived }),
        window.api.recipes.kinds(),
        window.api.recipes.stats()
      ])
      setLoadError(null)
      setItems(list)
      setKinds(kindList)
      setStats(s)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误'
      setLoadError(msg)
      toast.push(`${msg}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, kind, showArchived, toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const kindOptions = useMemo(
    () => [{ value: '', label: '全部类型' }, ...kinds.map((k) => ({ value: k, label: k }))],
    [kinds]
  )

  const archive = async (recipe: RecipeListItem): Promise<void> => {
    if (!window.confirm(`确定归档配方「${recipe.name}」吗？归档后不再出现在列表里，可以再恢复。`)) return
    try {
      await window.api.recipes.archive(recipe.id)
      toast.push('已归档（勾选「显示已归档」可以找回）', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '归档失败', 'error')
    }
  }

  const restore = async (recipe: RecipeListItem): Promise<void> => {
    try {
      await window.api.recipes.restore(recipe.id)
      toast.push('已恢复', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '恢复失败', 'error')
    }
  }

  return (
    <div className="content-inner">
      <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div style={{ width: 240 }}>
          <input
            className="pixel-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索配方名、材料…"
          />
        </div>
        <div style={{ width: 150 }}>
          <SelectInput value={kind} onChange={setKind} options={kindOptions} />
        </div>
        <label className="checkline">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示已归档
        </label>
        <span className="spacer" />
        <Button size="small" onClick={() => setManagingMaterials(true)}>
          材料库（{stats.materials}）
        </Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          ＋ 新增配方
        </Button>
      </div>

      <Panel>
        <SectionTitle
          right={
            <span className="small muted">
              共 {items.length} 个配方 · {stats.materials} 种材料
            </span>
          }
        >
          配方
        </SectionTitle>

        {loading ? (
          <Spinner label="加载中…" />
        ) : loadError ? (
          <LoadFailure what="配方库" detail={loadError} onRetry={() => void reload()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="🧪"
            title={debouncedQuery || kind ? '没有匹配的配方' : '还没有配方'}
            hint={
              debouncedQuery || kind
                ? '换个关键词，或把类型筛选改成「全部类型」。'
                : '把常用的配土比例、施肥浓度记下来，以后照方抓药。'
            }
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                新增第一个配方
              </Button>
            }
          />
        ) : (
          <div className="card-grid recipe-grid">
            {items.map((recipe) => (
              // 整张卡片可点=编辑，和花园、物种库的卡片保持一致
              <div
                key={recipe.id}
                className="pixel-card"
                onClick={() => setEditing(recipe)}
                title="点击编辑"
              >
                <div className="card-body">
                  <div className="card-title">
                    {recipe.name}
                    {recipe.archivedAt ? <Badge tone="muted">已归档</Badge> : null}
                  </div>
                  <div className="card-meta">
                    <Badge tone="info">{recipe.kind}</Badge>
                    <Badge tone="muted">{recipe.items.length} 种材料</Badge>
                  </div>
                  <div className="small" style={{ margin: '8px 0', lineHeight: 1.7 }}>
                    {recipe.summary}
                  </div>
                  {recipe.note ? <div className="small muted">{recipe.note}</div> : null}
                  {/* 卡片本身是「编辑」，里面的按钮要阻止冒泡，否则点归档会顺带打开编辑 */}
                  <div className="row tight" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                    <Button size="small" onClick={() => setEditing(recipe)}>
                      编辑
                    </Button>
                    {recipe.archivedAt ? (
                      <Button size="small" variant="ghost" onClick={() => void restore(recipe)}>
                        恢复
                      </Button>
                    ) : (
                      <Button size="small" variant="ghost" onClick={() => void archive(recipe)}>
                        归档
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {stats.recipes === 0 && !loading ? (
        <Panel flat>
          <Notice tone="info">
            配方可以只写比例（泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2），也可以写绝对用量（缓释肥 20 克 / 盆）。
            编辑时右下角能按份数换算用量 —— 想知道「配 10 盆各要多少」就填 10。
          </Notice>
        </Panel>
      ) : null}

      {editing ? (
        <RecipeEditor
          recipe={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : null}

      {managingMaterials ? (
        <MaterialManager onClose={() => setManagingMaterials(false)} onChanged={() => void reload()} />
      ) : null}
    </div>
  )
}
