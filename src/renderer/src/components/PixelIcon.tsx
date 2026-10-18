/**
 * 像素图标：16×16 的字符网格，直接渲染成 SVG 小方块。
 *
 * 为什么不用图标字体/图片：
 *  - 图片资源会和「一个资源文件都没有」的约定打架；
 *  - 图标字体在像素风里容易糊；
 *  - 网格写法改起来直观，加一个图标就是加几行字符串。
 *
 * 颜色用单字符代号，见 PALETTE。
 */

import type { ReactNode } from 'react'

const PALETTE: Record<string, string> = {
  k: '#4a2608', // 深棕描边
  o: '#c98a45', // 木头
  O: '#8a5423', // 深木
  w: '#fff6e0', // 纸/高光
  g: '#7ec850', // 亮绿
  G: '#4c8f2e', // 深绿
  b: '#5ab6e8', // 水
  B: '#2f7fb8', // 深水
  r: '#d9563f', // 红棕
  y: '#ffd166' // 黄
}

const ICONS: Record<string, string[]> = {
  // 一株盆栽：树冠 + 花盆
  garden: [
    '................',
    '.......gg.......',
    '....gggggggg....',
    '...gGggggggGg...',
    '..gGggggggggGg..',
    '..gGggggggggGg..',
    '...gGggggggGg...',
    '....gggggggg....',
    '.......OO.......',
    '.......OO.......',
    '...oooooooooo...',
    '...okwwwwwwko...',
    '....okwwwwko....',
    '.....oooooo.....',
    '................',
    '................'
  ],
  // 一本摊开的书
  species: [
    '................',
    '..kkkkkkkkkkkk..',
    '..kwwwwwwwwwwk..',
    '..kwrrrrrrrrwk..',
    '..kwwwwwwwwwwk..',
    '..kwrrrrrrrrwk..',
    '..kwwwwwwwwwwk..',
    '..kwwwwwwwwwwk..',
    '..kwrrrrrrrrwk..',
    '..kwwwwwwwwwwk..',
    '..kkkkkkkkkkkk..',
    '................',
    '................',
    '................',
    '................',
    '................'
  ],
  // 一滴水（养护）
  care: [
    '................',
    '.......bb.......',
    '......bbbb......',
    '.....bbbbbb.....',
    '....bbbwwbbb....',
    '....bbbwwbbb....',
    '...bbbbbbbbbb...',
    '...bbbbbbbbbb...',
    '....bbbbbbbb....',
    '.....bbbbbb.....',
    '......bbbb......',
    '.......bb.......',
    '................',
    '................',
    '................',
    '................'
  ],
  // 一扇门（退出）
  exit: [
    '................',
    '....kkkkkkkk....',
    '....kwwwwwwk....',
    '....kwkkkkwk....',
    '....kwk..kwk....',
    '....kwk..kwk....',
    '....kwk..kwk....',
    '....kwk..kwk....',
    '....kwk..kwk....',
    '....kwk..kwk....',
    '....kwwwwwwk....',
    '....kkkkkkkk....',
    '................',
    '................',
    '................',
    '................'
  ],
  // 齿轮（设置）
  gear: [
    '................',
    '......kkkk......',
    '....kk.oo.kk....',
    '....k..oo..k....',
    '..kkk.oooo.kkk..',
    '..k..oooooo..k..',
    '..k.ooo..ooo.k..',
    '..k.ooo..ooo.k..',
    '..k..oooooo..k..',
    '..kkk.oooo.kkk..',
    '....k..oo..k....',
    '....kk.oo.kk....',
    '......kkkk......',
    '................',
    '................',
    '................'
  ],
  // 喇叭开
  sound: [
    '................',
    '.......kk.......',
    '......kook......',
    '.....koook..y...',
    '....kooook.y.y..',
    '....kooook..y...',
    '....kooook..y...',
    '.....koook.y.y..',
    '......kook..y...',
    '.......kk.......',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................'
  ],
  // 喇叭关（加一道斜杠）
  mute: [
    '................',
    '.......kk.......',
    '......kook......',
    '.....koook......',
    '....kooook......',
    '....kooook......',
    '....kooook......',
    '.....koook......',
    '......kook......',
    '.......kk.......',
    '.....r...r......',
    '......r.r.......',
    '.......r........',
    '................',
    '................',
    '................'
  ]
}

export function PixelIcon({
  name,
  size = 22,
  className
}: {
  name: keyof typeof ICONS | string
  size?: number
  className?: string
}): ReactNode {
  const rows = ICONS[name] ?? []
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden
      focusable="false"
    >
      {rows.flatMap((row, y) =>
        [...row].map((ch, x) =>
          ch === '.' || !PALETTE[ch] ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={PALETTE[ch]} />
          )
        )
      )}
    </svg>
  )
}
