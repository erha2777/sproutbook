/**
 * 把像素网格画成 SVG。
 *
 * 用 SVG 而不是图片文件：矢量、任意缩放不糊、颜色跟着数据走
 * （花色按物种、叶色按健康度），而且不用往仓库里塞 72 张 PNG。
 *
 * 画之前会把同色的连续格子合并成一条长矩形 —— 一个精灵大约 300 个
 * 非透明像素，逐个画就是 300 个 <rect>；一屏 20 株就是 6000 个节点。
 * 合并之后通常只剩四分之一。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { GrowthLook } from '@core/growth'
import { SPRITE_SIZE, buildPlantSprite } from '@core/sprite'
import type { PixelGrid } from '@core/sprite'

interface Run {
  x: number
  y: number
  w: number
  key: string
}

/** 把每行里同色的连续格子合并。 */
export function mergeRuns(grid: PixelGrid): Run[] {
  const runs: Run[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const key = row[x]
      if (key === '.') {
        x++
        continue
      }
      let w = 1
      while (x + w < row.length && row[x + w] === key) w++
      runs.push({ x, y, w, key })
      x += w
    }
  })
  return runs
}

export function PlantSprite({
  habit,
  look,
  flowerColor,
  leafColor,
  size = 64,
  title
}: {
  habit: string | null | undefined
  look: GrowthLook
  flowerColor?: string
  leafColor?: string
  /** 渲染边长（像素）。网格始终是 16×16，这里只放大 */
  size?: number
  title?: string
}): ReactNode {
  const built = useMemo(
    () => buildPlantSprite({ habit, look, flowerColor, leafColor }),
    // look 是每次新建的对象，逐字段比较，否则 useMemo 等于没有
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habit, flowerColor, leafColor, look.stem, look.leaves, look.flower, look.wither, look.bare]
  )
  const runs = useMemo(() => mergeRuns(built.grid), [built.grid])

  return (
    <svg
      className="plant-sprite"
      viewBox={`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`}
      width={size}
      height={size}
      // 关掉抗锯齿，像素才是方的
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {runs.map((r) => (
        <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={built.palette[r.key] ?? '#000'} />
      ))}
    </svg>
  )
}
