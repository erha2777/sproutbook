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

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

/*
 * 图标覆盖：<userData>/textures/icons/<name>.png（或开发期仓库 textures/icons/）。
 * 有同名图片就用图片，没有就用下面的字符网格画。图片不进仓库，版权素材只在本机生效。
 */
let overrideUrls: Record<string, string> = {}
const listeners = new Set<() => void>()

export function setIconUrls(map: Record<string, string> | undefined): void {
  overrideUrls = map ?? {}
  for (const notify of listeners) notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useIconUrl(name: string): string | undefined {
  return useSyncExternalStore(subscribe, () => overrideUrls[name])
}

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
  // 地图图钉（位置）
  pin: [
    '................',
    '.....kkkkkk.....',
    '....krrrrrrk....',
    '...krrrrrrrrk...',
    '...krrwwwwrrk...',
    '...krrwwwwrrk...',
    '...krrrrrrrrk...',
    '....krrrrrrk....',
    '.....krrrrk.....',
    '......krrk......',
    '.......kk.......',
    '................',
    '................',
    '................',
    '................',
    '................'
  ],
  // 警示三角
  warn: [
    '................',
    '.......kk.......',
    '......kyyk......',
    '......kyyk......',
    '.....kyyyyk.....',
    '.....kykyyk.....',
    '....kyykyyyk....',
    '....kyykyyyk....',
    '...kyyykyyyyk...',
    '...kyyyyyyyyk...',
    '..kyyyyyyyyyyk..',
    '..kkkkkkkkkkkk..',
    '................',
    '................',
    '................',
    '................'
  ],  // 太阳（今日）：黄色实心 + 深棕描边，放在绿色选中底上也看得清
  sun: [
    '................',
    '.......kk.......',
    '.......kk.......',
    '..k....kk....k..',
    '...k..kkkk..k...',
    '....kkkkkkkk....',
    '...kkyyyyyykk...',
    '..kkyyyyyyyykk..',
    '..kkyyyyyyyykk..',
    '...kkyyyyyykk...',
    '....kkkkkkkk....',
    '...k..kkkk..k...',
    '..k....kk....k..',
    '.......kk.......',
    '.......kk.......',
    '................'
  ],
  // 日历（养护计划）
  calendar: [
    '................',
    '....k......k....',
    '..kkkkkkkkkkkk..',
    '..krrrrrrrrrrk..',
    '..krrrrrrrrrrk..',
    '..kwwwwwwwwwwk..',
    '..kwkkwkkwkkwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkwkkwkkwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkwkkwkkwk..',
    '..kwwwwwwwwwwk..',
    '..kkkkkkkkkkkk..',
    '................',
    '................',
    '................'
  ],
  // 本子（养护日志）
  journal: [
    '................',
    '..kkkkkkkkkkkk..',
    '..kOOOOOOOOOOk..',
    '..kOwwwwwwwwOk..',
    '..kOwkkkkkkwOk..',
    '..kOwwwwwwwwOk..',
    '..kOwkkkkkkwOk..',
    '..kOwwwwwwwwOk..',
    '..kOwkkkkkkwOk..',
    '..kOwwwwwwwwOk..',
    '..kOOOOOOOOOOk..',
    '..kkkkkkkkkkkk..',
    '................',
    '................',
    '................',
    '................'
  ],
  // 药水瓶（配方）
  flask: [
    '................',
    '......kkkk......',
    '......kwwk......',
    '......kwwk......',
    '......kwwk......',
    '.....kwwwwk.....',
    '....kwwwwwwk....',
    '...kwwwwwwwwk...',
    '...kwggggggwk...',
    '...kwGGGGGGwk...',
    '...kwggggggwk...',
    '...kwwwwwwwwk...',
    '...kkkkkkkkkk...',
    '................',
    '................',
    '................'
  ],
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
    '....kk.OO.kk....',
    '....k..OO..k....',
    '..kkk.OOOO.kkk..',
    '..k..OOOOOO..k..',
    '..k.OOO..OOO.k..',
    '..k.OOO..OOO.k..',
    '..k..OOOOOO..k..',
    '..kkk.OOOO.kkk..',
    '....k..OO..k....',
    '....kk.OO.kk....',
    '......kkkk......',
    '................',
    '................',
    '................'
  ],
  // 喇叭开：浅色喇叭体 + 深棕描边 —— 挂在背景上（左上角 HUD、雪地、树影）都看得清
  sound: [
    '................',
    '.......kk.......',
    '......kwwk......',
    '.....kwwwk......',
    '....kwwwwk..y...',
    '....kwwwwk.y.y..',
    '....kwwwwk.y.y..',
    '....kwwwwk.y.y..',
    '....kwwwwk..y...',
    '.....kwwwk......',
    '......kwwk......',
    '.......kk.......',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................'
  ],
  // 喇叭关：同款喇叭 + 右边一个红色小叉
  mute: [
    '................',
    '.......kk.......',
    '......kwwk......',
    '.....kwwwk......',
    '....kwwwwk......',
    '....kwwwwk.r.r..',
    '....kwwwwk..r...',
    '....kwwwwk.r.r..',
    '....kwwwwk......',
    '.....kwwwk......',
    '......kwwk......',
    '.......kk.......',
    '................',
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
  const override = useIconUrl(name)
  if (override) {
    return (
      <img
        className={className}
        src={override}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        style={{ imageRendering: 'pixelated', objectFit: 'contain' }}
      />
    )
  }
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
