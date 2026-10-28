/**
 * 种草适配分析弹窗。
 *
 * 三块：选位置 + 选品类 → AI 打分 → 结果（总分 / 优缺点 / 维度分 / 建议）。
 * 结果可以由用户决定是否保存到这条种草记录（保存后下次直接看，不必再花钱）。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Environment, WishAnalysis, WishCategory, WishItem } from '@core/types'
import { scoreTone } from '@core/wishAnalysis'
import { Button, Modal, Notice, SelectInput, Spinner, useToast } from './ui'

const CATEGORY_OPTIONS: Array<{ value: WishCategory; label: string }> = [
  { value: 'rose', label: '月季（含抗病 / 耐性细分）' },
  { value: 'hydrangea', label: '绣球' },
  { value: 'bougainvillea', label: '三角梅' },
  { value: 'other', label: '其他' }
]

export function WishAnalysisModal({
  item,
  onClose,
  onSaved
}: {
  item: WishItem
  onClose: () => void
  onSaved: (next: WishItem) => void
}): ReactNode {
  const toast = useToast()
  const [envs, setEnvs] = useState<Environment[]>([])
  const [locationId, setLocationId] = useState<string>('')
  const [category, setCategory] = useState<WishCategory>('rose')
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<WishAnalysis | null>(item.analysis ?? null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 进行中的请求 id：用于「取消」 */
  const [requestId, setRequestId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.env
      .list()
      .then(setEnvs)
      .catch(() => setEnvs([]))
  }, [])

  const envOptions = useMemo(
    () => [
      { value: '', label: '不指定位置（只看品种本身）' },
      ...envs.map((e) => ({ value: String(e.id), label: `${e.name}${e.city ? ` · ${e.city}` : ''}` }))
    ],
    [envs]
  )

  const run = async (): Promise<void> => {
    const id = `wish-${item.id}-${Date.now()}`
    setRequestId(id)
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.ai.wishAnalysis({
        requestId: id,
        wishId: item.id,
        locationId: locationId ? Number(locationId) : null,
        category
      })
      if (!r.ok || !r.analysis) {
        setError(r.message ?? '分析失败')
        return
      }
      setAnalysis(r.analysis)
    } catch (error) {
      setError(error instanceof Error ? error.message : '分析失败')
    } finally {
      setBusy(false)
      setRequestId(null)
    }
  }

  const persist = async (): Promise<void> => {
    if (!analysis) return
    setSaving(true)
    try {
      onSaved(await window.api.wishlist.saveAnalysis(item.id, analysis))
      toast.push('已保存分析结果', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`AI 适配分析 · ${item.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="small muted">
            {analysis
              ? `分析于 ${new Date(analysis.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${
                  analysis.model ? ` · ${analysis.model}` : ''
                }`
              : '分析结果不会自动保存'}
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={() => void persist()} disabled={!analysis || saving}>
            {saving ? '保存中…' : analysis && item.analysis ? '覆盖已保存的分析' : '保存到这条'}
          </Button>
          {busy ? (
            <Button
              onClick={() => {
                if (requestId) void window.api.ai.cancel(requestId)
              }}
            >
              取消分析
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? '分析中…' : analysis ? '重新分析' : '开始分析'}
          </Button>
        </>
      }
    >
      <div className="content-inner">
        <div className="row tight" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <span className="field-label">打算种在哪</span>
            <SelectInput value={locationId} onChange={setLocationId} options={envOptions} />
          </label>
          <label className="field" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <span className="field-label">按哪一类分析</span>
            <SelectInput
              value={category}
              onChange={(v) => setCategory(v as WishCategory)}
              options={CATEGORY_OPTIONS}
            />
          </label>
        </div>

        <p className="small muted" style={{ margin: 0 }}>
          月季会额外看黑斑、白粉、霜霉等抗病性，以及耐雨淋 / 耐晒 / 耐阴 / 长势 / 复花 / 直立性；
          其它品类按光照、气候、养护省心度等通用维度打分。
        </p>

        {busy ? <Spinner label="AI 正在评估…（通常 20~60 秒，慢的话可以点右下角取消）" /> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        {analysis && !busy ? <AnalysisView analysis={analysis} /> : null}
      </div>
    </Modal>
  )
}

function AnalysisView({ analysis }: { analysis: WishAnalysis }): ReactNode {
  const tone = scoreTone(analysis.score)
  return (
    <div className="wish-analysis">
      <div className="wish-score-row">
        <div className={`wish-score ${tone}`}>
          {analysis.score}
          <span className="wish-score-unit">/100</span>
        </div>
        <div className="wish-verdict">
          <div className="wish-verdict-text">{analysis.verdict}</div>
          <div className="small muted">
            {analysis.locationName ? `位置：${analysis.locationName}` : '未指定位置'} ·{' '}
            {analysis.category === 'rose' ? '月季专项' : '通用评估'}
          </div>
        </div>
      </div>

      <div className="wish-lists">
        <div>
          <div className="wish-list-title good">优点</div>
          <ul className="wish-list">
            {analysis.pros.map((p, i) => (
              <li key={`pro-${i}`}>{p}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="wish-list-title bad">缺点 / 风险</div>
          <ul className="wish-list">
            {analysis.cons.map((c, i) => (
              <li key={`con-${i}`}>{c}</li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <div className="wish-list-title">分项评分</div>
        {analysis.dims.map((d) => (
          <div key={d.key} className="wish-dim">
            <span className="wish-dim-label">{d.label}</span>
            <span className="wish-dim-bar">
              <span className={`wish-dim-fill ${scoreTone(d.score)}`} style={{ width: `${d.score}%` }} />
            </span>
            <span className="wish-dim-score">{d.score}</span>
            <span className="wish-dim-comment small muted">{d.comment}</span>
          </div>
        ))}
      </div>

      {analysis.tips.length > 0 ? (
        <div>
          <div className="wish-list-title">针对这个位置的建议</div>
          <ul className="wish-list">
            {analysis.tips.map((t, i) => (
              <li key={`tip-${i}`}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
