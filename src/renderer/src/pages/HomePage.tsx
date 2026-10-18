/**
 * 首页 / 标题页。
 *
 * 参考星露谷的标题画面：天空 + 木牌 + 四个大按钮。
 * 这一页是**启动器**，不参与应用内的页面导航 —— 它把整个应用收成四个入口：
 * 我的花园 / 物种库 / 养护 / 退出。
 *
 * 进去以后**没有侧栏**，靠顶部一条横栏在分区间切换（`TopNav`）；
 * 设置没有单独占一个主按钮：它是低频操作，做成左下角的齿轮（和参考图一致）。
 */

import type { ReactNode } from 'react'

export function HomePage({
  onGarden,
  onSpecies,
  onCare,
  onQuit,
  onSettings,
  carePending,
  version,
  soundOn,
  onToggleSound
}: {
  onGarden: () => void
  onSpecies: () => void
  onCare: () => void
  onQuit: () => void
  onSettings: () => void
  /** 养护里「逾期 + 该做」的数量，挂在「养护」按钮上 */
  carePending: number
  version: string | null
  /** 界面音效开关（存 localStorage） */
  soundOn: boolean
  onToggleSound: () => void
}): ReactNode {
  return (
    <div className="home">
      <div className="home-sign">
        <div className="home-sign-inner">
          <div className="home-title">Sproutbook</div>
          <div className="home-subtitle">植物养护管理</div>
        </div>
      </div>

      <div className="home-menu">
        <button type="button" className="home-btn" onClick={onGarden}>
          <span>我的花园</span>
          <b>🌿</b>
        </button>
        <button type="button" className="home-btn" onClick={onSpecies}>
          <span>物种库</span>
          <b>📖</b>
        </button>
        <button type="button" className="home-btn" onClick={onCare}>
          <span>
            养护
            {carePending > 0 ? (
              <i className="home-badge" title={`${carePending} 件事需要处理`}>
                {carePending}
              </i>
            ) : null}
          </span>
          <b>🌱</b>
        </button>
        <button type="button" className="home-btn" onClick={onQuit}>
          <span>退出</span>
          <b>✕</b>
        </button>
      </div>

      <button type="button" className="home-gear" title="设置" onClick={onSettings}>
        ⚙
      </button>
      <button
        type="button"
        className="home-gear home-sound"
        title={soundOn ? '关闭音效' : '开启音效'}
        aria-label={soundOn ? '关闭音效' : '开启音效'}
        onClick={onToggleSound}
      >
        {soundOn ? '🔊' : '🔇'}
      </button>
      <div className="home-version">{version ? `v${version}` : ''}</div>
    </div>
  )
}
