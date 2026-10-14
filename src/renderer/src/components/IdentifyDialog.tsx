/**
 * 识图对话框：选一张照片 → 模型给出候选 → 你点选是哪个。
 *
 * ## 只负责「认出名字」，不负责填字段
 *
 * 选定候选之后把名字交给 SpeciesEditor，由**现有的 AI 补全流程**
 * 去生成字段草稿。这样「草稿 → 逐字段勾选 → 写入」那条路的规矩
 * （永不自动写、安全字段强制人工核实）一个字都不用改，也不可能被绕过。
 *
 * ## 为什么要显示「依据」和「置信度」
 *
 * 植物识别本身不可靠。把模型的理由摆出来（「心形叶、攀援」），
 * 用户一眼就能看出它是不是在瞎猜 —— 只给一个名字的话，
 * 用户只能选择信或不信，没有判断的依据。
 *
 * 定义在模块层，不是 SpeciesEditor 内部：组件内定义会让每次渲染
 * 产生新的函数标识，React 视为换了类型就重挂子树。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Field, Modal, Notice, Panel, Spinner, TextArea, cx } from './ui'
import type { AiIdentifyCandidate, AiIdentifyResult } from '@shared/api'

/**
 * 层级标签。
 *
 * 光看 level 会闹矛盾：第三候选标的是「只到属」，可它同时给了一个**种名**
 * （Hippeastrum puniceum）—— 读起来像自相矛盾。
 *
 * 模型的意思其实是「属是确定的，那个种名只是属内的猜测」。
 * 所以这里结合**有没有给名字**来判断措辞：
 *   只到属 + 有名字 → 属内备选（属确定，种名存疑）
 *   只到属 + 没名字 → 只到属
 */
export interface IdentifyDialogProps {
  open: boolean
  /** 可选的补充线索，例如「叶子有点发黄」 */
  busy: boolean
  result: AiIdentifyResult | null
  onIdentify: (hint: string) => void
  onPick: (candidate: AiIdentifyCandidate) => void
  onClose: () => void
}

function levelLabel(c: AiIdentifyCandidate): { text: string; hint: string } | null {
  if (c.level === 'cultivar') return { text: '到品种', hint: '能确定是哪个园艺品种' }
  if (c.level === 'species') return { text: '到种', hint: '知道是什么种，但认不出具体品种' }
  if (c.level === 'genus') {
    return c.scientificName
      ? { text: '属内备选', hint: '属是确定的；那个种名只是属内的猜测，把握不大' }
      : { text: '只到属', hint: '只确定到属，说不出是哪个种' }
  }
  return null
}

function confidenceLabel(c: number): string {
  if (c >= 0.75) return '比较有把握'
  if (c >= 0.45) return '可能是'
  return '仅供参考'
}

export function IdentifyDialog({
  open,
  busy,
  result,
  onIdentify,
  onPick,
  onClose
}: IdentifyDialogProps): ReactNode {
  const [hint, setHint] = useState('')

  if (!open) return null

  const candidates = result?.candidates ?? []

  return (
    <Modal title="从照片识别植物" onClose={onClose}>
      <div className="content-inner">
        <Notice tone="info">
          选一张植物照片，模型会给出最可能的几个候选。
          <b>它只负责认品种</b>，认出之后由 AI 补全去填那些字段 ——
          草稿仍然要你逐项勾选才会写入。
        </Notice>

        <Field label="补充线索（可选）" help="例如「叶片有白斑」「刚买的小苗」。有花有果时说一句会更准。">
          <TextArea value={hint} onChange={setHint} rows={2} placeholder="可不填" />
        </Field>

        <div className="row tight">
          <Button variant="primary" onClick={() => onIdentify(hint)} disabled={busy}>
            {busy ? '识别中…' : '选择本地图片并识别'}
          </Button>
          <span className="small muted">支持 PNG / JPG / WebP / BMP；会先缩到长边 1024 再发</span>
        </div>

        {busy ? <Spinner label="正在看这张照片…" /> : null}

        {!busy && result ? (
          <>
            {result.sourceName ? (
              <div className="small muted" style={{ marginTop: 8 }}>
                图片来源：{result.sourceName}
                {result.model ? `　·　模型：${result.model}` : ''}
              </div>
            ) : null}

            {result.message ? <Notice tone="warn">{result.message}</Notice> : null}

            {candidates.length === 0 && !result.message ? (
              /*
               * 这里原来写死了「多半是这张照片看不清特征，换个角度再拍」——
               * **那是在替服务端编原因。** 没给出候选可能是照片确实看不清，
               * 也可能是模型没按格式返回。用户按那句话去反复重拍，
               * 而问题可能根本不在照片上。
               *
               * 现在把模型的原话摆出来，让用户自己看一眼判断。
               */
              <Notice tone="warn">
                模型没给出候选。可能是这张照片看不清特征，也可能是它没按格式回答。
                {result.raw ? (
                  <>
                    <br />
                    模型的原话：<span className="small muted">{result.raw.slice(0, 300)}</span>
                  </>
                ) : null}
                <br />
                <b>可以先看看上面那句话再决定要不要重拍</b>，或者直接手填名称。
              </Notice>
            ) : null}

            {candidates.length > 0 ? (
              <div className="identify-list">
                {candidates.map((c, i) => (
                  <Panel key={`${c.name}-${i}`}>
                    <div className="row" style={{ alignItems: 'baseline' }}>
                      <b style={{ fontSize: 15 }}>{c.name}</b>
                      {/*
                        品种名单独显示。认出「是朱顶红」不难，认出「是哪个品种」很难 ——
                        两件事分开摆，用户才知道模型走到了哪一步。
                      */}
                      {c.cultivar ? <span className="identify-cultivar">{c.cultivar}</span> : null}
                      <span className="small muted">{c.scientificName ?? ''}</span>
                      <span style={{ flex: 1 }} />
                      {(() => {
                        const lv = levelLabel(c)
                        if (!lv) return null
                        return (
                          <span className={`identify-level lv-${c.level}`} title={lv.hint}>
                            {lv.text}
                          </span>
                        )
                      })()}
                      <span className={cx('small', c.confidence >= 0.75 ? '' : 'muted')}>
                        {confidenceLabel(c.confidence)} {Math.round(c.confidence * 100)}%
                      </span>
                    </div>
                    {c.reason ? <div className="small muted">{c.reason}</div> : null}
                    <div style={{ marginTop: 6 }}>
                      <Button size="small" onClick={() => onPick(c)}>
                        就是它，用这个名字补全
                      </Button>
                    </div>
                  </Panel>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
