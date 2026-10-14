/**
 * 程序化像素美术。
 *
 * 为什么不用手绘贴图：9 种株型 × 8 个生长阶段 = 72 张，
 * 画不完、也维护不动（改一个颜色要改 72 个文件）。
 * 改成「株型决定形状，阶段决定参数」——株型是 9 个形状函数，
 * 阶段只给「茎多高、几对叶、有没有花、枯到什么程度」，
 * 两者在 16×16 的像素网格上拼出来。
 *
 * 输出是「字符网格 + 调色板」而不是图片：渲染层把每个非透明格
 * 画成一个 <rect>，矢量、可缩放、可换色（花色跟着物种走），
 * 也不用往仓库里塞二进制资源。
 */

import type { GrowthLook } from './growth'

export const SPRITE_SIZE = 16

/** 每行一个字符串，字符是调色板键；'.' 表示透明。 */
export type PixelGrid = string[]

export type SpriteHabit =
  | '草本'
  | '灌木'
  | '乔木'
  | '藤本'
  | '多肉'
  | '球根'
  | '水生'
  | '蕨类'
  | '附生'

export const SPRITE_HABITS: SpriteHabit[] = ['草本', '灌木', '乔木', '藤本', '多肉', '球根', '水生', '蕨类', '附生']

/** 认不出的株型按草本处理 —— 不知道种的是什么，至少别画不出来。 */
export function normalizeHabit(value: string | null | undefined): SpriteHabit {
  return SPRITE_HABITS.includes(value as SpriteHabit) ? (value as SpriteHabit) : '草本'
}

export interface SpriteOptions {
  habit: string | null | undefined
  look: GrowthLook
  /** 花色。跟着物种走，同一片花园才有层次 */
  flowerColor?: string
  /** 叶色。默认是常用绿 */
  leafColor?: string
}

// ---------------------------------------------------------------------------
// 花色
// ---------------------------------------------------------------------------

/**
 * 物种模板里的「花色」可选值。
 *
 * 用中文色名而不是让人填十六进制：养花的人说「粉色」，
 * 不会说「#e86a8a」。模板的 select 字段和这里的映射共用同一份列表，
 * 加一个颜色只要改这里。
 */
export const FLOWER_COLOR_OPTIONS = ['红', '粉', '黄', '白', '紫', '蓝', '橙', '绿', '复色'] as const

export const FLOWER_COLOR_HEX: Record<string, string> = {
  红: '#d84040',
  粉: '#e86a8a',
  黄: '#f0c040',
  白: '#f2ede0',
  紫: '#a060d0',
  蓝: '#7090e0',
  橙: '#e08040',
  绿: '#88c060',
  复色: '#d860a8'
}

/**
 * 取一个物种该用什么花色。
 *
 * 优先用物种属性里的「花色」；没填就按物种名散列取一个 ——
 * 整片花园用同一种花太死板，散列至少保证同名同色、
 * 不会每次刷新都换。返回值总是合法的十六进制。
 */
export function flowerColorForSpecies(attrs: Record<string, unknown> | null | undefined, fallbackName?: string | null): string {
  const raw = attrs?.flower_color
  if (typeof raw === 'string') {
    const key = raw.trim()
    if (FLOWER_COLOR_HEX[key]) return FLOWER_COLOR_HEX[key]
    // 直接填了十六进制也认
    if (/^#[0-9a-fA-F]{6}$/.test(key)) return key.toLowerCase()
  }
  const s = fallbackName ?? ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return FLOWER_COLOR_OPTIONS.map((k) => FLOWER_COLOR_HEX[k])[h % FLOWER_COLOR_OPTIONS.length]
}

// ---------------------------------------------------------------------------
// 调色板
// ---------------------------------------------------------------------------

const BASE_PALETTE: Record<string, string> = {
  S: '#6b4a2f', // 土（暗）
  s: '#8a6240', // 土（亮）
  p: '#b5623c', // 盆
  P: '#d98a5f', // 盆（高光）
  b: '#5a7a34', // 茎
  B: '#6f9440', // 茎（亮）
  w: '#4a90c2', // 水
  W: '#7ab8e0', // 水（亮）
  t: '#7a5c3a', // 木头 / 树皮
  T: '#9a7a52' // 木头（亮）
}

/** 把颜色按比例混向目标色。枯萎靠它把绿一点点染成枯黄。 */
export function mixColor(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const [r1, g1, b1] = parse(from)
  const [r2, g2, b2] = parse(to)
  const k = Math.max(0, Math.min(1, t))
  const to2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  return `#${to2(r1 + (r2 - r1) * k)}${to2(g1 + (g2 - g1) * k)}${to2(b1 + (b2 - b1) * k)}`
}

const WITHER_TO = '#a8895c'

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

class Canvas {
  private grid: string[][]

  constructor() {
    this.grid = Array.from({ length: SPRITE_SIZE }, () => Array<string>(SPRITE_SIZE).fill('.'))
  }

  /** 越界的点直接丢掉：形状函数不必自己防越界，省得每处都写判断。 */
  px(x: number, y: number, key: string): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || xi >= SPRITE_SIZE || yi < 0 || yi >= SPRITE_SIZE) return
    this.grid[yi][xi] = key
  }

  rect(x: number, y: number, w: number, h: number, key: string): void {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.px(x + dx, y + dy, key)
  }

  /** 竖线，用于主茎。 */
  vline(x: number, y0: number, y1: number, key: string): void {
    const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0]
    for (let y = a; y <= b; y++) this.px(x, y, key)
  }

  /**
   * 把**左半边**镜像到右半边。
   *
   * 约定：形状函数只画 x ≤ 7 的左半边和中心列，右半边交给这里。
   * 第一版写反了（右→左），而右边是空的，等于没执行 ——
   * 结果所有植物都只长半边，预览图上一眼就看出来了。
   */
  mirror(): void {
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE / 2; x++) {
        const key = this.grid[y][x]
        if (key !== '.') this.grid[y][SPRITE_SIZE - 1 - x] = key
      }
    }
  }

  toGrid(): PixelGrid {
    return this.grid.map((row) => row.join(''))
  }
}

/** 土面所在的行：往下就是花盆/地面。 */
const GROUND_Y = 13

function drawSoil(c: Canvas, pot: boolean): void {
  if (pot) {
    c.rect(4, GROUND_Y, 8, 2, 'p')
    c.rect(4, GROUND_Y, 8, 1, 'P')
    c.px(4, GROUND_Y + 1, 'P')
    c.px(11, GROUND_Y + 1, 'P')
  } else {
    c.rect(2, GROUND_Y, 12, 3, 'S')
    c.rect(2, GROUND_Y, 12, 1, 's')
  }
}

// ---------------------------------------------------------------------------
// 九种株型
// ---------------------------------------------------------------------------

/**
 * 在指定位置画一朵花。
 *
 * 抽出来是因为第一版只有多肉/球根/水生自己画了花，
 * 草本、灌木、乔木、藤本、蕨类、附生**永远不开花** ——
 * 花园里最该有看头的阶段反而是空的。
 */
function drawFlower(c: Canvas, x: number, y: number, kind: GrowthLook['flower']): void {
  if (kind === 'none') return
  if (kind === 'bud') {
    // 花苞：顶上一粒，颜色偏叶绿
    c.px(x, y, 'f')
    c.px(x - 1, y, 'f')
  } else {
    // 开花：三格宽两层，中间一点亮色，16×16 下这已经够醒目
    c.rect(x - 1, y - 1, 3, 2, 'f')
    c.px(x, y - 1, 'F')
    c.px(x - 1, y + 1, 'd')
  }
}

/**
 * 各株型的形状函数。
 *
 * 约定：从 (8, GROUND_Y-1) 往上生长。对称的株型只画**左半边**，
 * 由 mirror() 补右半边；藤本和水生是不对称的，自己画完整。
 */
const SHAPES: Record<SpriteHabit, (c: Canvas, look: GrowthLook) => void> = {
  /** 草本：一根细茎，对生叶 */
  草本(c, look) {
    drawSoil(c, true)
    const top = GROUND_Y - 1 - look.stem
    c.vline(7, top, GROUND_Y - 1, 'b')
    for (let i = 0; i < look.leaves; i++) {
      const y = GROUND_Y - 2 - i * 2
      if (y <= top) break
      c.px(6, y, 'g')
      c.px(5, y - 1, 'g')
      c.px(6, y + 1, look.wither > 0.5 ? 'g' : 'G')
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 8, top - 1, look.flower)
  },

  /** 灌木：短主干 + 一蓬叶子 */
  灌木(c, look) {
    drawSoil(c, true)
    const top = GROUND_Y - 1 - look.stem
    c.rect(7, top + 3, 1, GROUND_Y - top - 3, 't')
    // 蓬：从下往上收窄
    const rx = 3 + Math.min(2, Math.floor(look.leaves / 2))
    for (let dy = 0; dy < 5; dy++) {
      const y = top + dy
      const w = Math.max(1, rx - Math.abs(dy - 2))
      c.rect(7 - w + 1, y, w, 1, dy % 2 === 0 ? 'g' : 'd')
    }
    c.px(5, top + 1, 'G')
    c.mirror()
    if (look.flower !== 'none') {
      drawFlower(c, 4, top + 1, look.flower)
      drawFlower(c, 11, top + 3, look.flower)
    }
  },

  /** 乔木：主干 + 圆树冠 */
  乔木(c, look) {
    drawSoil(c, false)
    const top = GROUND_Y - 1 - look.stem
    c.rect(7, top + 3, 1, GROUND_Y - top - 3, 't')
    c.px(6, top + 6, 'T')
    const canopyTop = Math.max(0, top - 1)
    for (let dy = 0; dy < 6; dy++) {
      const w = [2, 3, 4, 4, 3, 2][dy]
      c.rect(8 - w, canopyTop + dy, w, 1, dy < 2 ? 'G' : 'g')
    }
    c.mirror()
    if (look.flower !== 'none') {
      drawFlower(c, 4, canopyTop + 2, look.flower)
      drawFlower(c, 11, canopyTop + 3, look.flower)
    }
  },

  /** 藤本：细长茎带点弯。不对称，不镜像 */
  藤本(c, look) {
    drawSoil(c, true)
    const top = GROUND_Y - 1 - look.stem
    let x = 8
    for (let y = GROUND_Y - 1; y >= top; y--) {
      c.px(x, y, 'b')
      // 每三格往左偏一次，做出攀爬的弯度
      if ((GROUND_Y - y) % 3 === 0 && x > 4) x--
      if ((GROUND_Y - y) % 2 === 0) {
        c.px(x - 1, y, 'g')
        c.px(x + 1, y - 1, 'd')
      }
    }
    if (look.flower !== 'none') drawFlower(c, x, top - 1, look.flower)
  },

  /** 多肉：低矮莲座，一层层往外摊 */
  多肉(c, look) {
    drawSoil(c, true)
    const layers = Math.max(1, Math.min(3, Math.ceil(look.stem / 3)))
    for (let i = 0; i < layers; i++) {
      const y = GROUND_Y - 1 - i
      const w = layers - i + 1
      c.rect(8 - w, y, w, 1, i === layers - 1 ? 'G' : 'g')
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 8, GROUND_Y - layers - 3, look.flower)
  },

  /** 球根：土面一个球，抽出几片带状叶 */
  球根(c, look) {
    drawSoil(c, true)
    c.rect(6, GROUND_Y - 1, 3, 2, 'p')
    const blades = Math.max(1, Math.min(4, look.leaves + 1))
    for (let i = 0; i < blades; i++) {
      const dx = i - Math.floor(blades / 2)
      const h = Math.max(1, look.stem - Math.abs(dx))
      for (let k = 0; k < h; k++) c.px(8 + dx, GROUND_Y - 2 - k, k > h - 2 ? 'G' : 'g')
    }
    if (look.flower !== 'none') drawFlower(c, 8, GROUND_Y - 3 - look.stem, look.flower)
  },

  /** 水生：水面 + 浮叶 + 立出水面的花。不对称，不镜像 */
  水生(c, look) {
    c.rect(1, GROUND_Y, 14, 3, 'w')
    c.rect(1, GROUND_Y, 14, 1, 'W')
    c.rect(5, GROUND_Y - 1, 4, 1, 'g') // 浮叶
    c.px(4, GROUND_Y - 1, 'G')
    c.px(9, GROUND_Y - 1, 'G')
    if (look.stem > 3) c.vline(9, GROUND_Y - look.stem, GROUND_Y - 2, 'b')
    if (look.flower !== 'none') drawFlower(c, 9, GROUND_Y - look.stem - 3, look.flower)
  },

  /** 蕨类：一根主轴，两侧羽状小叶 */
  蕨类(c, look) {
    drawSoil(c, true)
    const top = GROUND_Y - 1 - look.stem
    c.vline(7, top, GROUND_Y - 1, 'b')
    for (let y = GROUND_Y - 2; y >= top; y -= 2) {
      c.px(6, y, 'g')
      c.px(5, y, 'd')
      c.px(6, y - 1, 'G')
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 8, top - 1, look.flower)
  },

  /** 附生：一截木头，叶子贴在木头上 */
  附生(c, look) {
    drawSoil(c, true)
    const top = GROUND_Y - 1 - Math.max(3, look.stem)
    c.rect(7, top, 1, GROUND_Y - top - 1, 't')
    c.px(5, top + 2, 'T')
    for (let i = 0; i < Math.max(1, look.leaves); i++) {
      const y = top + 1 + i * 2
      c.px(6, y, 'g')
      c.px(5, y - 1, 'G')
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 4, top + 1, look.flower)
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface BuiltSprite {
  grid: PixelGrid
  palette: Record<string, string>
}

export function buildPlantSprite(options: SpriteOptions): BuiltSprite {
  const habit = normalizeHabit(options.habit)
  const look = options.look
  const c = new Canvas()

  SHAPES[habit](c, look)

  // 种子阶段：只画土，露一点芽
  if (look.stem === 0 && look.leaves === 0 && !look.bare) {
    c.px(8, GROUND_Y - 1, 'G')
    c.px(8, GROUND_Y - 2, 'g')
  }

  const leaf = options.leafColor ?? '#5fa832'
  const flower = options.flowerColor ?? '#e86a8a'
  const wither = look.wither

  const palette: Record<string, string> = {
    ...BASE_PALETTE,
    // 枯萎时绿色整体染向枯黄，茎也一起变
    g: mixColor(leaf, WITHER_TO, wither),
    G: mixColor(mixColor(leaf, '#ffffff', 0.25), WITHER_TO, wither),
    d: mixColor(mixColor(leaf, '#000000', 0.25), WITHER_TO, wither),
    b: mixColor('#5a7a34', WITHER_TO, wither),
    B: mixColor('#6f9440', WITHER_TO, wither),
    f: look.flower === 'bud' ? mixColor(flower, '#5a7a34', 0.45) : flower,
    F: mixColor(flower, '#ffffff', 0.3),
    // 休眠时土色也发干
    s: mixColor('#8a6240', WITHER_TO, wither * 0.5)
  }

  return { grid: c.toGrid(), palette }
}

/** 统计非透明像素数。用于自检「这个阶段确实画出了东西」。 */
export function countPixels(grid: PixelGrid): number {
  let n = 0
  for (const row of grid) for (const ch of row) if (ch !== '.') n++
  return n
}
