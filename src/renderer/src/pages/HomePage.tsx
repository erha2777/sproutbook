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
import { PixelIcon } from '../components/PixelIcon'

export function HomePage({
  onGarden,
  onSpecies,
  onCare,
  onQuit,
  onSettings,
  carePending,
  version
}: {
  onGarden: () => void
  onSpecies: () => void
  onCare: () => void
  onQuit: () => void
  onSettings: () => void
  /** 养护里「逾期 + 该做」的数量，挂在「养护」按钮上 */
  carePending: number
  version: string | null
}): ReactNode {
  return (
    <div className="home">
      <div className="home-sign">
        {/* 四个角饰：像旧木牌上的包角铁片 */}
        <i className="sign-corner tl" aria-hidden />
        <i className="sign-corner tr" aria-hidden />
        <i className="sign-corner bl" aria-hidden />
        <i className="sign-corner br" aria-hidden />
        <div className="home-sign-inner">
          <div className="home-title">Sproutbook</div>
          <div className="home-subtitle">植物养护管理</div>
        </div>
      </div>

      <div className="home-menu">
        <button type="button" className="home-btn" onClick={onGarden}>
          <span>我的花园</span>
          <b><PixelIcon name="garden" size={26} /></b>
        </button>
        <button type="button" className="home-btn" onClick={onSpecies}>
          <span>物种库</span>
          <b><PixelIcon name="species" size={26} /></b>
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
          <b><PixelIcon name="care" size={26} /></b>
        </button>
        <button type="button" className="home-btn" onClick={onQuit}>
          <span>退出</span>
          <b><PixelIcon name="exit" size={26} /></b>
        </button>
      </div>

      <button type="button" className="home-gear" title="设置" aria-label="设置" onClick={onSettings}>
        <PixelIcon name="gear" size={24} />
      </button>

      {/*
        首页原来右下角还有一个「♪ 曲名」的静态标签。加了右上角那颗可点的音乐按钮之后
        两处都在报同一首歌，看着像两个播放器 —— 去掉这处，音乐只留能操作的那一处。
      */}
      <div className="home-version">{version ? `v${version}` : ''}</div>
    </div>
  )
}
