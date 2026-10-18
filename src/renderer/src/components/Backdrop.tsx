/**
 * 私有截图背景：「巡视地图」。
 *
 * 之前只在首页内部渲染；现在提到应用最外层，所有页面共用同一层背景，
 * 切页面时镜头继续走，不会重新开始。
 *
 * 每张图铺满窗口，`background-position` 从一角扫到对角（alternate 扫回来），
 * 多张时按 26 秒一轮淡入切换。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CSSProperties } from 'react'

export function Backdrop({ images }: { images: string[] }): ReactNode {
  const layers = useMemo(
    () =>
      images.map((url, index) => {
        const rand = (seed: number): number => {
          const x = Math.sin((index + 1) * 91.7 + seed * 37.3) * 10000
          return x - Math.floor(x)
        }
        const variant = ['a', 'b', 'c', 'd'][index % 4]
        const duration = 60 + rand(1) * 24
        const delay = -rand(3) * 30
        return {
          key: `map-${index}`,
          style: {
            backgroundImage: `url("${url}")`,
            animationName: `map-sweep-${variant}`,
            animationDuration: `${duration}s`,
            animationDelay: `${delay}s`
          } as CSSProperties
        }
      }),
    [images]
  )

  const [active, setActive] = useState(0)
  useEffect(() => {
    if (layers.length <= 1) return
    const timer = window.setInterval(() => {
      setActive((current) => (current + 1) % layers.length)
    }, 26000)
    return () => window.clearInterval(timer)
  }, [layers.length])

  if (layers.length === 0) return null

  return (
    <div className="app-backdrops" aria-hidden>
      {layers.map((layer, index) => (
        <div key={layer.key} className={`map-layer${index === active ? ' on' : ''}`} style={layer.style} />
      ))}
    </div>
  )
}
