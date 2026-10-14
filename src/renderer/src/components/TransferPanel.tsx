/**
 * 导入导出面板。
 *
 * 本地优先的应用必须能进能出 —— 否则用户的数据只能靠复制 SQLite 文件才能带走，
 * 这与「数据全在你自己电脑上」的承诺是矛盾的。所以这个面板不是可选项。
 *
 * 导入走「先预览、再确认」两步：文件是用户从别处拿来的，列名对不对、
 * 有没有必填缺失、会不会造出一堆重名，都必须让人先看见再落库。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TransferKind, TransferPreview, TransferResult } from '@shared/api'
import { Badge, Button, Field, Modal, Notice, Panel, SectionTitle, SelectInput, useToast } from './ui'

const KIND_LABEL: Record<TransferKind, string> = { species: '物种库', plants: '我的植株' }

export function TransferPanel(): ReactNode {
  const toast = useToast()
  const [counts, setCounts] = useState<Record<TransferKind, number>>({ species: 0, plants: 0 })
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<TransferPreview | null>(null)

  const reload = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([window.api.species.list({ limit: 1 }), window.api.plants.list({ limit: 1 })])
      setCounts({ species: s.total, plants: p.total })
    } catch {
      // 拿不到数量不影响导出本身
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const runExport = async (kind: TransferKind, format: 'csv' | 'json'): Promise<void> => {
    setBusy(`export-${kind}-${format}`)
    try {
      const result = await window.api.transfer.export(kind, format)
      if (result.canceled) return
      toast.push(`已导出 ${result.count} 条到 ${result.path ?? ''}`, 'success')
    } catch (error) {
      toast.push(`导出失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const runImport = async (kind: TransferKind): Promise<void> => {
    setBusy(`import-${kind}`)
    try {
      const result = await window.api.transfer.previewImport(kind)
      if (result) setPreview(result)
    } catch (error) {
      toast.push(`读取文件失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel>
      <SectionTitle>导入导出</SectionTitle>
      <div className="content-inner">
        <Notice tone="info">
          你的数据本来就存在本机，但「存在本机」不等于「拿得走」。
          导出给你一份可以用 Excel 打开或备份到别处的文件；导入支持本应用导出的
          CSV / JSON，写入前会先给你看一遍。
        </Notice>

        {(['species', 'plants'] as TransferKind[]).map((kind) => (
          <div key={kind} style={{ marginTop: 14 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <b>{KIND_LABEL[kind]}</b>
              <Badge tone="muted">{counts[kind]} 条</Badge>
              <span className="spacer" />
              <Button
                size="small"
                disabled={busy !== null || counts[kind] === 0}
                onClick={() => void runExport(kind, 'csv')}
              >
                {busy === `export-${kind}-csv` ? '导出中…' : '导出 CSV'}
              </Button>
              <Button
                size="small"
                disabled={busy !== null || counts[kind] === 0}
                onClick={() => void runExport(kind, 'json')}
              >
                {busy === `export-${kind}-json` ? '导出中…' : '导出 JSON'}
              </Button>
              <Button size="small" variant="primary" disabled={busy !== null} onClick={() => void runImport(kind)}>
                {busy === `import-${kind}` ? '读取中…' : `导入到${KIND_LABEL[kind]}`}
              </Button>
            </div>
          </div>
        ))}

        <div className="small muted" style={{ marginTop: 14, lineHeight: 1.8 }}>
          <div>
            <b>CSV</b>：列名是界面上的中文标签，适合用 Excel 编辑；多值字段用英文逗号分隔。
          </div>
          <div>
            <b>JSON</b>：键是字段标识，另带一份字段定义，适合程序处理或长期归档。
          </div>
          <div>
            两种格式都可以互相导入。导入时按<b>列名</b>匹配字段，改过模板也能对上；
            「所属物种」「养护位置」导出的是<b>名字</b>而不是数据库 ID，换台电脑也能用。
          </div>
        </div>
      </div>

      {preview ? (
        <ImportDialog
          preview={preview}
          onClose={() => {
            void window.api.transfer.discardImport(preview.token)
            setPreview(null)
          }}
          onDone={() => {
            setPreview(null)
            void reload()
          }}
        />
      ) : null}
    </Panel>
  )
}

// ---------------------------------------------------------------------------

function ImportDialog({
  preview,
  onClose,
  onDone
}: {
  preview: TransferPreview
  onClose: () => void
  onDone: () => void
}): ReactNode {
  const toast = useToast()
  const [updateExisting, setUpdateExisting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<TransferResult | null>(null)

  const unmatched = preview.mapping.filter((m) => !m.fieldKey)

  const submit = async (): Promise<void> => {
    setImporting(true)
    try {
      const r = await window.api.transfer.applyImport(preview.token, { updateExisting, createMissing: true })
      setResult(r)
      toast.push(
        `导入完成：新增 ${r.imported}、更新 ${r.updated}、跳过 ${r.skipped}${r.failed > 0 ? `、失败 ${r.failed}` : ''}`,
        r.failed > 0 ? 'error' : 'success'
      )
    } catch (error) {
      toast.push(`导入失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      title={`导入${KIND_LABEL[preview.kind]} · ${preview.fileName}`}
      onClose={onClose}
      footer={
        result ? (
          <>
            <span className="spacer" />
            <Button variant="primary" onClick={onDone}>
              完成
            </Button>
          </>
        ) : (
          <>
            <span className="small muted">
              共 {preview.total} 行 · 可导入 {preview.ready} · 重名 {preview.duplicates}
              {preview.issues.length > 0 ? ` · 有问题 ${preview.issues.length}` : ''}
            </span>
            <span className="spacer" />
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={importing || preview.total === 0}>
              {importing ? '导入中…' : `确认导入 ${preview.total} 行`}
            </Button>
          </>
        )
      }
    >
      <div className="content-inner">
        {result ? (
          <ResultView result={result} />
        ) : (
          <>
            <Notice tone={preview.issues.length > 0 ? 'warn' : 'info'}>
              识别为 <b>{preview.format.toUpperCase()}</b> 文件，共 <b>{preview.total}</b> 行。
              列名已按字段名自动匹配，<b>{preview.mapping.length - unmatched.length}</b> 列对上、
              <b>{unmatched.length}</b> 列忽略。
            </Notice>

            {unmatched.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  以下列在模板里找不到对应字段，会被忽略：
                </div>
                <div className="row tight">
                  {unmatched.map((m) => (
                    <span key={m.header} className="pixel-tag">
                      {m.header}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {preview.willCreate.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn">
                  文件里这些关联对象在库里还不存在，导入时会<b>自动新建</b>（只填名称，之后再补全）：
                  <div className="row tight" style={{ marginTop: 6 }}>
                    {preview.willCreate.map((w) => (
                      <span key={w} className="pixel-tag">
                        {w}
                      </span>
                    ))}
                  </div>
                </Notice>
              </div>
            ) : null}

            {preview.issues.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="danger">
                  有 <b>{preview.issues.length}</b> 处问题，这些行会被跳过：
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                    {preview.issues.slice(0, 8).map((i, idx) => (
                      <li key={idx} className="small">
                        第 {i.row} 行：{i.message}
                      </li>
                    ))}
                  </ul>
                </Notice>
              </div>
            ) : null}

            <div style={{ marginTop: 12 }}>
              <Field label="遇到同名记录">
                <SelectInput
                  value={updateExisting ? 'update' : 'skip'}
                  onChange={(v) => setUpdateExisting(v === 'update')}
                  options={[
                    { value: 'skip', label: '跳过（保留库里已有的）' },
                    { value: 'update', label: '覆盖更新（用文件里的值）' }
                  ]}
                />
              </Field>
            </div>

            <div className="section-title">数据预览（前 {preview.samples.length} 行）</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="pixel-table">
                <thead>
                  <tr>
                    {preview.headers.slice(0, 8).map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.samples.map((row, i) => (
                    <tr key={i}>
                      {row.slice(0, 8).map((cell, j) => (
                        <td key={j} className="small">
                          {cell.length > 40 ? `${cell.slice(0, 40)}…` : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.headers.length > 8 ? (
              <div className="small muted">只显示前 8 列，共 {preview.headers.length} 列。</div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

function ResultView({ result }: { result: TransferResult }): ReactNode {
  return (
    <>
      <Notice tone={result.failed > 0 ? 'warn' : 'ok'}>
        导入完成：新增 <b>{result.imported}</b> 条，更新 <b>{result.updated}</b> 条，跳过{' '}
        <b>{result.skipped}</b> 条
        {result.failed > 0 ? (
          <>
            ，失败 <b>{result.failed}</b> 条
          </>
        ) : null}
        。
      </Notice>

      {result.created.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            自动新建了 {result.created.length} 个关联对象：
          </div>
          <div className="row tight">
            {result.created.map((c) => (
              <span key={c} className="pixel-tag">
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {result.errors.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="danger">
            以下行没能导入：
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {result.errors.slice(0, 10).map((e, i) => (
                <li key={i} className="small">
                  第 {e.row} 行：{e.message}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <div className="small muted" style={{ marginTop: 10 }}>
        导入的数据可以直接在「物种库」和「我的花园」里看到。
      </div>
    </>
  )
}
