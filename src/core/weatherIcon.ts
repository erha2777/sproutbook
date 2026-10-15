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
  /*
   * 雨的云比阴天更暗 —— 这是**第三层区分**（前两层是云的位置和降水形状）。
   * 缩略图里颜色差异比形状差异更先被眼睛抓住。
   */
  u: '#8b939d', // 雨的云
  U: '#6b737d', // 雨的云·暗部
  /* 雪的云刻意**比雨更浅**：浅云 + 白花，整张图偏亮 */
  k: '#b9bfc7', // 雪的云
  K: '#99a1aa', // 雪的云·暗部
  r: '#3f78c4', // 雨（加深过 —— 原来的 #5b8fd0 在米色背景上偏淡）
  w: '#ffffff', // 雪
  y: '#f5d33c', // 闪电
  Y: '#fff3b0', // 闪电边缘的高光，让闪电更跳
  f: '#b8c0c8', // 雾
  F: '#98a2ac' // 雾的暗部，避免三层灰糊成一块
}

/**
 * 支持的天气种类。
 *
 * 导出它是为了让自检能**遍历全部种类** —— 而不是我手写一份列表，
 * 那样新增种类时自检会静默漏掉（这个项目已经吃过「覆盖不到」的亏）。
 */
export const WEATHER_ICON_KINDS = ['clear', 'cloudy', 'overcast', 'rain', 'snow', 'storm', 'fog'] as const

export type WeatherIconKind = (typeof WEATHER_ICON_KINDS)[number]

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

/**
 * 一条横线。用来画雾。
 *
 * 雾刻意**不用云** —— 直接用 `rect` 铺块状，缩略图里会和「阴」的云糊在一起。
 * 三条长度不同、粗细交替的横线，形状上和云是完全不同的东西。
 */
function hline(g: string[][], y: number, x0: number, x1: number, key: string): void {
  for (let x = x0; x <= x1; x++) px(g, x, y, key)
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
  disc(g, cx - 1, cy - 1, Math.max(0, r - 2), 'S')
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

/**
 * 云：三个交叠的圆 + 一条平底。
 *
 * `bottom` 是**下边界（不含）**。雨 / 雪 / 雷传一个较小的值把云压扁，
 * 腾出来的行给降水用 —— 原来云一律占 7 行（2~8），
 * 底下的雨丝只剩 3 行可画，缩到 16px 就分不出是雨还是雪。
 *
 * `scale` 放大云体。阴天要的是「铺满整张图」，同一朵云直接铺会偏小。
 *
 * 颜色由调用方给：阴天用 `g`/`G`，雨用更暗的 `u`/`U`，雪用更浅的 `k`/`K`。
 */
function drawCloud(
  g: string[][],
  cx: number,
  cy: number,
  colors: { body: string; shade: string; light: string },
  bottom = WEATHER_ICON_SIZE,
  scale = 1
): void {
  const put = (x: number, y: number, key: string): void => {
    if (y >= bottom) return
    px(g, x, y, key)
  }
  const disc2 = (dcx: number, dcy: number, r: number, key: string): void => {
    const rr = r * scale
    for (let y = 0; y < WEATHER_ICON_SIZE; y++) {
      for (let x = 0; x < WEATHER_ICON_SIZE; x++) {
        const dx = x - dcx
        const dy = y - dcy
        if (dx * dx + dy * dy <= rr * rr) put(x, y, key)
      }
    }
  }

  disc2(cx - 3 * scale, cy, 2.6, colors.body)
  disc2(cx, cy - 1.5 * scale, 3.4, colors.body)
  disc2(cx + 3.4 * scale, cy + 0.4 * scale, 2.4, colors.body)
  const half = Math.round(5 * scale)
  for (let dx = -half; dx <= half - 1; dx++) {
    put(cx + dx, cy + Math.round(1 * scale), colors.body)
    put(cx + dx, cy + Math.round(2 * scale), colors.shade)
    /*
     * 再补一行 —— 只铺两行的话，中间那个圆（cy-1.5）够不着底边，
     * 云底中间会**漏出一个洞**。第三行用 shade 收口，洞补上。
     */
    if (dx >= -half + 1 && dx <= half - 2) put(cx + dx, cy + Math.round(3 * scale), colors.shade)
  }
  // 顶上一小块高光
  disc2(cx - 0.5, cy - 2.5 * scale, 1.8, colors.light)
}

/** 一片雪花：中心 + 四臂，两格长。比一个点像雪，比手绘十字更紧凑。 */
function drawSnowflake(g: string[][], cx: number, cy: number, key: string): void {
  const dots: Array<[number, number]> = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ]
  for (const [dx, dy] of dots) px(g, cx + dx, cy + dy, key)
}

/**
 * 闪电：一条粗折线。
 *
 * 原来是 1px 宽的三段，缩到 16px 就断成几颗黄点。
 * 现在每个「台阶」都是 2 行 2 列，折线连得起来，宽度也够显眼。
 *
 * 形状按行硬编码：斜折线用参数算会得到锯齿，手写反而更准。
 */
function drawBolt(g: string[][], top: number, left = 6): void {
  /*
   * 每行固定 3 个像素宽、左边界逐行右移一格 —— 一条真正的斜向折线。
   *
   * 试过两种错的：
   *   - 每行等宽、不位移 -> 34px 下糊成一坨方块
   *   - 有的行缩回左边 -> 看着像贴了几个并排的方块
   * 关键是**每一行都要比上一行更靠右**。
   */
  const rows = ['yyy', 'yyy', 'yyy', 'yyy', '.yy', '.yy', '..yy', '..yy']
  rows.forEach((row, dy) => {
    let last = -1
    for (let dx = 0; dx < row.length; dx++) if (row[dx] === 'y') last = dx

    for (let dx = 0; dx <= last; dx++) {
      if (row[dx] !== 'y') continue
      const x = left + dx
      const y = top + dy
      px(g, x, y, 'y')
      /*
       * 外缘再补一层浅黄。
       * 只加宽的话闪电会变成一坨方块，加高光才有「发光」的感觉，
       * 也让它在灰云前面跳出来。
       */
      if (dx === 0) px(g, x - 1, y, 'Y')
      if (dx === last) px(g, x + 1, y, 'Y')
    }
  })
}

/** 三套云的颜色：阴天、雨、雪。雪最浅、雨最暗，缩略图里一眼能分出天气大类。 */
const CLOUD_OVERCAST = { body: 'g', shade: 'G', light: 'g' }
const CLOUD_RAIN = { body: 'u', shade: 'U', light: 'u' }
const CLOUD_SNOW = { body: 'k', shade: 'K', light: 'k' }
const CLOUD_WHITE = { body: 'c', shade: 'C', light: 'c' }

const BUILDERS: Record<string, () => string[][]> = {
  clear: () => {
    const g = blank()
    // 太阳占满画布高度的一半以上，做成「一看就是晴天」的强形状
    drawSun(g, 8, 8, 4.2)
    return g
  },

  cloudy: () => {
    const g = blank()
    // 太阳从左上露出，云压在右下 —— 两者都要看得见
    drawSun(g, 5, 5, 2.9)
    drawCloud(g, 9, 10, CLOUD_WHITE)
    return g
  },

  overcast: () => {
    const g = blank()
    /*
     * 两朵同色的云叠出厚度 —— 一朵在缩略图里太单薄，看着像「多云少了太阳」。
     * **刻意不用白色**：白色在米色背景上等于没有，阴天必须是整片灰。
     *
     * 位置压得比「多云」低：阴天是**铺满整张图**的一片，
     * 悬在中间会显得头重脚轻。
     */
    drawCloud(g, 6, 6, CLOUD_OVERCAST, WEATHER_ICON_SIZE, 1.2)
    drawCloud(g, 9, 10, CLOUD_OVERCAST, WEATHER_ICON_SIZE, 1.05)
    return g
  },

  rain: () => {
    const g = blank()
    // 云压到第 7 行为止，下面 8 行全部留给雨丝
    drawCloud(g, 8, 5, CLOUD_RAIN, 7)
    /*
     * 三条竖雨丝。**长度必须错开** ——
     * 一样长的话底边会排成一条直线，整张图看着像栅栏。
     * 中间最长，右边最短，视线才往下走。
     */
    for (let y = 8; y <= 14; y++) px(g, 4, y, 'r')
    for (let y = 7; y <= 14; y++) px(g, 8, y, 'r')
    for (let y = 9; y <= 12; y++) px(g, 12, y, 'r')
    return g
  },

  snow: () => {
    const g = blank()
    drawCloud(g, 8, 5, CLOUD_SNOW, 7)
    /*
     * 两片完整雪花 + 三点碎雪。
     * 雪花铺满 8~14 行（云腾出来的空间要用掉），碎雪让画面不呆板。
     */
    drawSnowflake(g, 4, 10, 'w')
    drawSnowflake(g, 12, 12, 'w')
    px(g, 8, 9, 'w')
    px(g, 7, 14, 'w')
    px(g, 11, 8, 'w')
    return g
  },

  storm: () => {
    const g = blank()
    // 雷的云用**最深**的一档，闪电才跳得出来
    drawCloud(g, 8, 5, CLOUD_RAIN, 7)
    drawBolt(g, 7)
    return g
  },
  fog: () => {
    const g = blank()
    // 三条线，粗细交替；和「阴」的块状云是完全不同的形状
    hline(g, 5, 3, 12, 'f')
    hline(g, 9, 2, 13, 'F')
    hline(g, 13, 4, 11, 'f')
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
