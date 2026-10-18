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
import type { CareLog, CareLogImage, ImageRecord } from '@core/types'
import { CARE_ACTION_OPTIONS, logKindLabel } from '@core/care'
import { Badge, Button, EmptyState, Modal, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import type { PlantOption } from '../components/CareTaskDialog'

/**
 * 照片文件走 `plantimg://` 自定义协议（main 里注册，只读 images 目录）。
 * 数据库里存的是文件名，所以这里只做 URL 编码。
 */
function imageSrc(image: { path: string; thumbPath: string | null }): string {
  return `plantimg://local/${encodeURIComponent(image.thumbPath ?? image.path)}`
}

/** 点开看大图时用原图，不用缩略图 */
function imageFull(image: { path: string; thumbPath: string | null }): string {
  return `plantimg://local/${encodeURIComponent(image.path)}`
}

export function LogsPage(): ReactNode {
  const toast = useToast()
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [logs, setLogs] = useState<CareLog[]>([])
  const [loading, setLoading] = useState(true)
  /** 选中的植株：既是筛选条件，也是「记一笔」的目标 */
  const [plantId, setPlantId] = useState('')
  const [kind, setKind] = useState('note')
  const [draft, setDraft] = useState('')
  /** 已经导入、但还没随这条记录保存的照片 */
  const [picked, setPicked] = useState<ImageRecord[]>([])
  /** 预览大图 */
  const [preview, setPreview] = useState<CareLogImage | null>(null)
  /** 正在编辑的日志 id（null = 没有在编辑） */
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editKind, setEditKind] = useState('note')
  const [editDate, setEditDate] = useState('')
  const [editText, setEditText] = useState('')
  const [editAdd, setEditAdd] = useState<ImageRecord[]>([])
  const [editRemove, setEditRemove] = useState<number[]>([])

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

  /** 选照片：导入到用户数据目录，返回的 id 保存时挂到日志上 */
  const pickImages = async (): Promise<void> => {
    try {
      const res = await window.api.images.pick({})
      if (res.canceled) return
      if (res.failures && res.failures.length > 0) {
        toast.push(`有 ${res.failures.length} 张没能导入：${res.failures[0]}`, 'error')
      }
      if (res.imported.length > 0) {
        setPicked((prev) => [...prev, ...res.imported])
      }
    } catch (error) {
      toast.push(`选照片失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  /** 还没保存就反悔：把刚导入的文件也删掉，别在 images 里留孤儿 */
  const dropPicked = async (image: ImageRecord): Promise<void> => {
    setPicked((prev) => prev.filter((p) => p.id !== image.id))
    try {
      await window.api.images.remove(image.id)
    } catch {
      // 文件删不掉不影响记录本身
    }
  }

  const addManualLog = async (): Promise<void> => {
    const id = plantId ? Number(plantId) : null
    const content = draft.trim()
    if (id === null || (!content && picked.length === 0)) {
      toast.push('先在左边选一株植物，再写一句做了什么（或至少放一张照片）', 'error')
      return
    }
    try {
      await window.api.care.addLog({
        plantId: id,
        content,
        kind,
        imageIds: picked.map((p) => p.id)
      })
      setDraft('')
      setPicked([])
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

  /*
   * 编辑一条已有记录。
   *
   * 照片分两条路：编辑期间新选的（editAdd，先导入、保存时挂上），
   * 以及标记要摘掉的旧照片（editRemove，保存时才真正删除文件）。
   * 取消编辑要把 editAdd 里的文件清掉，不然会攒孤儿。
   */
  const startEdit = (log: CareLog): void => {
    setEditingId(log.id)
    setEditKind(log.kind)
    setEditDate(log.logDate)
    setEditText(log.content ?? '')
    setEditAdd([])
    setEditRemove([])
  }

  const cancelEdit = (): void => {
    for (const image of editAdd) void window.api.images.remove(image.id).catch(() => undefined)
    setEditingId(null)
    setEditAdd([])
    setEditRemove([])
  }

  const pickEditPhotos = async (): Promise<void> => {
    try {
      const res = await window.api.images.pick({})
      if (res.canceled) return
      if (res.failures && res.failures.length > 0) {
        toast.push(`有 ${res.failures.length} 张没能导入：${res.failures[0]}`, 'error')
      }
      if (res.imported.length > 0) setEditAdd((prev) => [...prev, ...res.imported])
    } catch (error) {
      toast.push(`选照片失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editingId === null) return
    try {
      const updated = await window.api.care.updateLog(editingId, {
        kind: editKind,
        logDate: editDate,
        content: editText.trim() ? editText.trim() : null,
        addImageIds: editAdd.map((i) => i.id),
        removeImageIds: editRemove
      })
      if (!updated) {
        toast.push('这条日志已经不在了，可能已在别处删过', 'error')
      } else {
        toast.push('已保存', 'success')
      }
      setEditingId(null)
      setEditAdd([])
      setEditRemove([])
      await load(plantId)
    } catch (error) {
      toast.push(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  return (
    <div className="content-inner">
      <Panel className="sticky-head">
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
          <Button onClick={() => void pickImages()} title="给这条记录配照片">
            📷 照片
          </Button>
          <Button
            onClick={() => void addManualLog()}
            disabled={!plantId || (!draft.trim() && picked.length === 0)}
          >
            记一笔
          </Button>
        </div>

        {/* 还没保存的照片：可以逐张撤掉（撤掉会连文件一起删） */}
        {picked.length > 0 ? (
          <div className="log-images" style={{ marginBottom: 8 }}>
            {picked.map((image) => (
              <div key={image.id} className="log-image-cell">
                <img className="log-image" src={imageSrc(image)} alt="" />
                <button
                  type="button"
                  className="log-image-remove"
                  title="不放进这条记录"
                  onClick={() => void dropPicked(image)}
                >
                  ×
                </button>
              </div>
            ))}
            <span className="small muted">会随这条记录一起保存（{picked.length} 张）</span>
          </div>
        ) : null}

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
              const editing = editingId === log.id
              return (
                <div key={log.id} className="log-item">
                  <div className="log-date">{editing ? editDate || log.logDate : log.logDate}</div>
                  <div style={{ flex: 1 }}>
                    {editing ? (
                      <>
                        <div className="row tight" style={{ marginBottom: 6 }}>
                          <div style={{ width: 140 }}>
                            <SelectInput
                              value={editKind}
                              onChange={setEditKind}
                              options={[
                                ...CARE_ACTION_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
                                { value: 'note', label: '📝 记录' }
                              ]}
                            />
                          </div>
                          <div style={{ width: 140 }}>
                            <TextInput value={editDate} onChange={setEditDate} placeholder="2026-10-18" />
                          </div>
                          <div style={{ flex: 1 }}>
                            <TextInput
                              value={editText}
                              onChange={setEditText}
                              placeholder="这条记录写了什么（可留空）"
                            />
                          </div>
                          <Button size="small" onClick={() => void pickEditPhotos()}>
                            📷 照片
                          </Button>
                          <Button size="small" variant="primary" onClick={() => void saveEdit()}>
                            保存
                          </Button>
                          <Button size="small" variant="ghost" onClick={cancelEdit}>
                            取消
                          </Button>
                        </div>

                        {/*
                          照片编辑：
                          - 原图里没被标记删除的照常显示，点 × 只是**标记**，保存后才真删
                          - 编辑期间新选的直接显示，点 × 会连文件一起删
                        */}
                        {(() => {
                          const kept = log.images.filter((img) => !editRemove.includes(img.id))
                          if (kept.length === 0 && editAdd.length === 0) return null
                          return (
                            <div className="log-images">
                              {kept.map((image) => (
                                <div key={image.id} className="log-image-cell">
                                  <img className="log-image" src={imageSrc(image)} alt="" />
                                  <button
                                    type="button"
                                    className="log-image-remove"
                                    title="保存后删掉这张照片"
                                    onClick={() => setEditRemove((prev) => [...prev, image.id])}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                              {editAdd.map((image) => (
                                <div key={`add-${image.id}`} className="log-image-cell">
                                  <img className="log-image" src={imageSrc(image)} alt="" />
                                  <button
                                    type="button"
                                    className="log-image-remove"
                                    title="不添加这张（文件会一起删掉）"
                                    onClick={() => {
                                      setEditAdd((prev) => prev.filter((i) => i.id !== image.id))
                                      void window.api.images.remove(image.id).catch(() => undefined)
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                              <span className="small muted">保存后生效</span>
                            </div>
                          )
                        })()}
                      </>
                    ) : (
                      <>
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
                        {log.images.length > 0 ? (
                          <div className="log-images">
                            {log.images.map((image) => (
                              <button
                                key={image.id}
                                type="button"
                                className="log-image-cell"
                                title="点开看大图"
                                onClick={() => setPreview(image)}
                              >
                                <img className="log-image" src={imageSrc(image)} alt="" />
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                  {/*
                    删除按钮：不用 ghost —— ghost 无背景无边框，
                    在浅米色的日志行上「删除」两个字太淡了，看不见。
                    外面包一层是为了让它垂直居中（.log-item 是 align-items:flex-start）
                  */}
                  {editing ? null : (
                    <div className="row tight" style={{ alignSelf: 'center' }}>
                      <Button size="small" title="编辑这条记录" onClick={() => startEdit(log)}>
                        编辑
                      </Button>
                      <Button size="small" title="删除这条日志（不可恢复）" onClick={() => void removeLog(log)}>
                        删除
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {/* 大图预览：缩略图看细节不够，点开看原图 */}
      {preview ? (
        <Modal title="照片" onClose={() => setPreview(null)} footer={<Button onClick={() => setPreview(null)}>关闭</Button>}>
          <img className="log-image-full" src={imageFull(preview)} alt="" />
        </Modal>
      ) : null}
    </div>
  )
}
