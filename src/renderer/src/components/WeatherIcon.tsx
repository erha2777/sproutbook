/**
 * 把像素天气图标画成 SVG。
 *
 * 和 PlantSprite 走同一条路：网格 + 调色板 → 合并成横条 → 一批 rect。
 * **样式也共用 .plant-sprite 那套**（关掉抗锯齿），像素才是方的。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { WEATHER_ICON_SIZE, buildWeatherIcon } from '@core/weatherIcon'
import { mergeRuns } from './PlantSprite'

export function WeatherIcon({
  kind,
  size = 16,
  title
}: {
  kind: string | null | undefined
  /** 渲染边长（像素）。网格始终是 16×16，这里只放大 */
  size?: number
  title?: string
}): ReactNode {
  const art = useMemo(() => buildWeatherIcon(kind), [kind])
  const runs = useMemo(() => (art ? mergeRuns(art.grid) : []), [art])

  /*
   * 认不出的天气**不硬画一个问号** —— 那会让人以为图标坏了。
   * 给一个中性占位点，和纯文本里的「·」一致。
   */
  if (!art) {
    return (
      <span
        className="weather-icon-missing"
        style={{ width: size, height: size, lineHeight: `${size}px` }}
        title={title}
      >
        ·
      </span>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${WEATHER_ICON_SIZE} ${WEATHER_ICON_SIZE}`}
      width={size}
      height={size}
      // 关掉抗锯齿，像素才是方的
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
      style={{ display: 'block', flex: 'none' }}
    >
      {title ? <title>{title}</title> : null}
      {runs.map((r) => (
        <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={art.palette[r.key] ?? '#000'} />
      ))}
    </svg>
  )
}
