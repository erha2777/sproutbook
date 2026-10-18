/**
 * 养护日志页。
 *
 * 从「养护计划」里抽出来的独立页面。原因：日志是**一条时间线**，
 * 它和「这个月排了什么」是两种东西 —— 混在一个页面的 tab 里，
 * 既占位置，又总是被当成计划的附属品。日志其实回答的是
 * 「这株植物经历过什么」，翻它的人往往是在回顾，而不是在排计划。
 *
 * 完成任务时会自动写一条；也可以手动记一笔（比如换盆、发现虫害）。
 * 删除不可恢复，所以每条都要确认。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog } from '@core/types'
import { CARE_ACTION_OPTIONS, logKindLabel } from '@core/care'
import { Badge, Button, EmptyState, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import type { PlantOption } from '../components/CareTaskDialog'

export function LogsPage(): ReactNode {
  const toast = useToast()
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [logs, setLogs] = useState<CareLog[]>([])
  const [loading, setLoading] = useState(true)
  /** 选中的植株：既是筛选条件，也是「记一笔」的目标 */
  const [plantId, setPlantId] = useState('')
  const [kind, setKind] = useState('note')
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.plants.list({ limit: 500 })
        setPlants(
          list.items.map((p) => ({
            id: p.id,
            label: `${p.nickname}${p.species ? `（${p.species.commonName}）` : ''}`
          }))
        )
      } catch {
        // 植株列表取不到不耽误看日志（日志里也会显示已有的植物名）
      }
    })()
  }, [])

  /**
   * 拉日志。
   *
   * 筛选收在这里，是因为原来只有「记一笔」之后会刷新 ——
   * 下拉框换了植株列表纹丝不动，用户看到的就是「切换没用」。
   */
  const load = useCallback(async (filter: string): Promise<void> => {
    try {
      setLogs(await window.api.care.logs(filter ? Number(filter) : undefined, 100))
    } catch {
      // 日志取不到不该让整页报错，空列表 + 空态已经够了
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(plantId)
  }, [load, plantId])

  const addManualLog = async (): Promise<void> => {
    const id = plantId ? Number(plantId) : null
    const content = draft.trim()
    if (id === null || !content) {
      toast.push('先在左边选一株植物，再写一句做了什么', 'error')
      return
    }
    try {
      await window.api.care.addLog({ plantId: id, content, kind })
      setDraft('')
      await load(plantId)
      toast.push('已记一笔', 'success')
    } catch (error) {
      toast.push(`记录失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const removeLog = async (log: CareLog): Promise<void> => {
    const what = log.content ? `「${log.content}」` : `这条${log.logDate}的记录`
    if (!window.confirm(`确定删除养护日志 ${what} 吗？删除后无法恢复。`)) return
    try {
      const ok = await window.api.care.removeLog(log.id)
      if (!ok) {
        // 影响 0 行 = 这条已经不在了，如实说，不报「已删除」
        toast.push('这条日志已经不在了，可能已在别处删过', 'error')
      } else {
        toast.push('已删除', 'success')
      }
      await load(plantId)
    } catch (error) {
      toast.push(`删除失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  return (
    <div className="content-inner">
      <Panel>
        <SectionTitle right={<span className="small muted">{plantId ? `已完成 ${logs.length} 条` : `最近 ${logs.length} 条`}</span>}>
          养护日志
        </SectionTitle>

        {/* 手动记一笔：空态里写着「也可以随时手动记一笔」，入口就在这里 */}
        <div className="row tight" style={{ marginBottom: 8 }}>
          <div style={{ width: 200 }}>
            <SelectInput
              value={plantId}
              onChange={setPlantId}
              placeholder="选一株植物…"
              options={[{ value: '', label: '全部植株' }, ...plants.map((pl) => ({ value: String(pl.id), label: pl.label }))]}
            />
          </div>
          <div style={{ width: 140 }}>
            {/* 类型可选：手动记的也能带上「浇水 / 施肥 / 观察记录」这类标签 */}
            <SelectInput
              value={kind}
              onChange={setKind}
              options={[
                ...CARE_ACTION_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
                // 'note' 不是动作类型（CareActionType 里没有它），但它确实是日志的 kind
                { value: 'note', label: '📝 记录' }
              ]}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextInput
              value={draft}
              onChange={setDraft}
              placeholder="记一句做了什么，例如「换了盆，土是泥炭 5 : 珍珠岩 3」"
            />
          </div>
          <Button onClick={() => void addManualLog()} disabled={!plantId || !draft.trim()}>
            记一笔
          </Button>
        </div>

        {loading ? (
          <Spinner label="加载中…" />
        ) : logs.length === 0 ? (
          <EmptyState
            icon="📓"
            title={plantId ? '这株还没有记录' : '还没有记录'}
            hint="完成任务时会自动写一条日志；也可以在上面手动记一笔。"
          />
        ) : (
          <div className="log-timeline">
            {logs.map((log) => {
              const plant = plants.find((p) => p.id === log.plantId)
              return (
                <div key={log.id} className="log-item">
                  <div className="log-date">{log.logDate}</div>
                  <div style={{ flex: 1 }}>
                    <div>
                      {/*
                        走 logKindLabel 而不是 CARE_ACTION_LABELS[kind] ?? kind ——
                        后者在遇到 'note'（后端没给 kind 时的默认值）时
                        **会把英文键名直接显示出来**，用户截图里的 note 就是这么来的。
                      */}
                      <Badge tone="info">{logKindLabel(log.kind)}</Badge>
                      {plant ? <span className="small muted">{plant.label}</span> : null}
                    </div>
                    {log.content ? <div className="small">{log.content}</div> : null}
                  </div>
                  {/*
                    删除按钮：不用 ghost —— ghost 无背景无边框，
                    在浅米色的日志行上「删除」两个字太淡了，看不见。
                    外面包一层是为了让它垂直居中（.log-item 是 align-items:flex-start）
                  */}
                  <div style={{ alignSelf: 'center' }}>
                    <Button size="small" title="删除这条日志（不可恢复）" onClick={() => void removeLog(log)}>
                      删除
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}
