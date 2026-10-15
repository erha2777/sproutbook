/**
 * 像素天气图标。
 *
 * ## 为什么不用 emoji
 *
 * 原来是 🌧 ⛅ ☀ 这些 emoji。问题有三个：
 *
 *   1. **每个系统的字形不一样** —— Windows / macOS / Linux 上粗细、留白、
 *      甚至配色都不同，同一个界面在不同机器上长得不像一个应用
 *   2. **和花园视图的风格不搭** —— 那边是 16×16 的像素画，这边是彩色 emoji
 *   3. **大小对不齐** —— emoji 的字形有自己的行高和基线，横条里高低不齐
 *
 * 和花园视图一样**用代码画**：仓库里不加任何图片资源，颜色和形状都在这里。
 *
 * 网格和调色板的形式与 sprite.ts 完全一致，渲染端用同一个 mergeRuns。
 */

import type { PixelGrid } from './sprite'

export const WEATHER_ICON_SIZE = 16

export interface WeatherIconArt {
  grid: PixelGrid
  /** 字符 → 颜色。'.' 是透明 */
  palette: Record<string, string>
}

const PALETTE: Record<string, string> = {
  s: '#f2c14e', // 太阳主体
  S: '#ffe08a', // 太阳高光
  c: '#f6f3ea', // 云的高光
  C: '#dcd6c6', // 云的中间调
  g: '#9aa3ad', // 阴天的灰
  G: '#7c848d', // 阴天的暗部
  r: '#5b8fd0', // 雨
  w: '#ffffff', // 雪
  y: '#f5d33c', // 闪电
  f: '#b8c0c8' // 雾
}

/** 一张空白画布，越界写入直接丢掉 —— 形状函数不必自己防越界。 */
function blank(): string[][] {
  return Array.from({ length: WEATHER_ICON_SIZE }, () => Array<string>(WEATHER_ICON_SIZE).fill('.'))
}

function px(g: string[][], x: number, y: number, key: string): void {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi < 0 || xi >= WEATHER_ICON_SIZE || yi < 0 || yi >= WEATHER_ICON_SIZE) return
  g[yi][xi] = key
}

function rect(g: string[][], x: number, y: number, w: number, h: number, key: string): void {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) px(g, x + dx, y + dy, key)
}

/** 实心圆。用距离判断，比手写每一行可靠。 */
function disc(g: string[][], cx: number, cy: number, r: number, key: string): void {
  for (let y = 0; y < WEATHER_ICON_SIZE; y++) {
    for (let x = 0; x < WEATHER_ICON_SIZE; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) px(g, x, y, key)
    }
  }
}

/** 太阳：圆盘 + 八根光芒。 */
function drawSun(g: string[][], cx: number, cy: number, r: number): void {
  disc(g, cx, cy, r, 's')
  // 左上一小块高光，让圆盘不显得死板
  disc(g, cx - 1, cy - 1, r - 2, 'S')
  const rays: Array<[number, number]> = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ]
  for (const [dx, dy] of rays) {
    px(g, cx + dx * (r + 1), cy + dy * (r + 1), 's')
    // 斜向的光芒短一点，否则四角太长
    if (dx !== 0 && dy !== 0) continue
    px(g, cx + dx * (r + 2), cy + dy * (r + 2), 's')
  }
}

/** 云：三个交叠的圆 + 一条平底。 */
function drawCloud(g: string[][], cx: number, cy: number, gray = false): void {
  const body = gray ? 'g' : 'c'
  const shade = gray ? 'G' : 'C'
  disc(g, cx - 3, cy, 2.6, body)
  disc(g, cx, cy - 1.5, 3.4, body)
  disc(g, cx + 3.4, cy + 0.4, 2.4, body)
  rect(g, cx - 5, cy + 1, 10, 2, body)
  // 底部压暗一行，云才有厚度
  rect(g, cx - 5, cy + 2, 10, 1, shade)
  // 顶上一小块高光
  disc(g, cx - 0.5, cy - 2.5, 1.8, gray ? 'g' : 'c')
}

const BUILDERS: Record<string, () => string[][]> = {
  clear: () => {
    const g = blank()
    drawSun(g, 8, 8, 3.4)
    return g
  },

  cloudy: () => {
    const g = blank()
    // 太阳从云后露出半边
    drawSun(g, 5, 5, 2.6)
    drawCloud(g, 9, 9)
    return g
  },

  overcast: () => {
    const g = blank()
    drawCloud(g, 7, 7, true)
    // 后面再压一层浅色的，显厚
    drawCloud(g, 9, 10)
    return g
  },

  rain: () => {
    const g = blank()
    drawCloud(g, 8, 6, true)
    // 三列雨滴，长短错开
    const drops: Array<[number, number]> = [
      [5, 11],
      [8, 10],
      [11, 12]
    ]
    for (const [x, y] of drops) {
      px(g, x, y, 'r')
      px(g, x, y + 1, 'r')
    }
    px(g, 8, 13, 'r')
    return g
  },

  snow: () => {
    const g = blank()
    drawCloud(g, 8, 6, true)
    // 雪花画成小十字，比单个点更像雪
    const flakes: Array<[number, number]> = [
      [5, 11],
      [8, 12],
      [11, 10]
    ]
    for (const [x, y] of flakes) {
      px(g, x, y, 'w')
      px(g, x - 1, y, 'w')
      px(g, x + 1, y, 'w')
      px(g, x, y - 1, 'w')
      px(g, x, y + 1, 'w')
    }
    return g
  },

  storm: () => {
    const g = blank()
    drawCloud(g, 8, 6, true)
    // 闪电：一条折线，上宽下尖
    rect(g, 8, 10, 3, 1, 'y')
    px(g, 8, 11, 'y')
    px(g, 7, 12, 'y')
    rect(g, 6, 13, 2, 1, 'y')
    px(g, 6, 12, 'y')
    return g
  },

  fog: () => {
    const g = blank()
    // 四条横线，长度错开 —— 整齐的横线看着像表格
    rect(g, 3, 5, 10, 1, 'f')
    rect(g, 5, 8, 8, 1, 'f')
    rect(g, 2, 11, 11, 1, 'f')
    rect(g, 6, 13, 7, 1, 'f')
    return g
  }
}

/**
 * 画一个天气图标。认不出的 kind 返回 null —— **不硬画一个问号**，
 * 界面那边会退回一个占位符，那样至少不会假装有信息。
 */
export function buildWeatherIcon(kind: string | null | undefined): WeatherIconArt | null {
  if (!kind) return null
  const build = BUILDERS[kind]
  if (!build) return null
  return { grid: build().map((row) => row.join('')), palette: PALETTE }
}
