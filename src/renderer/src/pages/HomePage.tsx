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

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PixelIcon } from '../components/PixelIcon'

export function HomePage({
  onGarden,
  onSpecies,
  onCare,
  onQuit,
  onSettings,
  carePending,
  version,
  soundOn,
  onToggleSound,
  backdrops = []
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
  /** 私有背景图：在首页背后缓慢飘动（来自 <userData>/textures 的其余图片） */
  backdrops?: string[]
}): ReactNode {
  /*
   * 「巡视地图」：每张截图铺满窗口，镜头在图上缓慢平移（Ken Burns 式运镜），
   * 每隔一段时间淡入下一张。只有一张图时不切，只平移。
   *
   * 每张图分到 4 套运镜中的一套（左上→右下 / 右下→左上 / 左下→右上 / 右上→左下），
   * 时长和缩放略有差异，看起来不像同一个循环。
   */
  const layers = useMemo(
    () =>
      backdrops.map((url, index) => {
        const rand = (seed: number): number => {
          const x = Math.sin((index + 1) * 91.7 + seed * 37.3) * 10000
          return x - Math.floor(x)
        }
        const variant = ['a', 'b', 'c', 'd'][index % 4]
        const zoom = 1.26 + rand(1) * 0.14
        const duration = 34 + rand(2) * 12 // 34~46s 巡一遍
        const delay = -rand(3) * 20
        return {
          key: `map-${index}`,
          style: {
            backgroundImage: `url("${url}")`,
            animationName: `map-pan-${variant}`,
            animationDuration: `${duration}s`,
            animationDelay: `${delay}s`,
            ['--map-zoom' as string]: `${zoom}`
          } as CSSProperties
        }
      }),
    [backdrops]
  )

  // 多张图时轮流淡入
  const [activeLayer, setActiveLayer] = useState(0)
  useEffect(() => {
    if (layers.length <= 1) return
    const timer = window.setInterval(() => {
      setActiveLayer((current) => (current + 1) % layers.length)
    }, 26000)
    return () => window.clearInterval(timer)
  }, [layers.length])

  return (
    <div className="home">
      {layers.length > 0 ? (
        <div className="home-backdrops" aria-hidden>
          {layers.map((layer, index) => (
            <div
              key={layer.key}
              className={`map-layer${index === activeLayer ? ' on' : ''}`}
              style={layer.style}
            />
          ))}
        </div>
      ) : null}
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
      <button
        type="button"
        className="home-gear home-sound"
        title={soundOn ? '关闭音效' : '开启音效'}
        aria-label={soundOn ? '关闭音效' : '开启音效'}
        onClick={onToggleSound}
      >
        <PixelIcon name={soundOn ? 'sound' : 'mute'} size={24} />
      </button>
      <div className="home-version">{version ? `v${version}` : ''}</div>
    </div>
  )
}
