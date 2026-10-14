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
  /** 物种性状：叶形 / 叶色 / 花形 / 株幅。让同株型的植物也能区分开 */
  style?: SpriteStyle
  /** 栽种方式（盆栽/地栽/水培/附生板），决定底座。留空则按株型给默认值 */
  cultivation?: string | null
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

/** 土面所在的行：往下就是花盆/地面/水面。 */
const GROUND_Y = 13

// ---------------------------------------------------------------------------
// 物种性状：让同株型的植物也能区分开
// ---------------------------------------------------------------------------

/*
 * 起因是用户的反馈：**株型只有 9 种，同株型的植物长得一模一样** ——
 * 月季和薄荷都是草本，画出来分不出谁是谁，没有物种本身的样子。
 *
 * 解法还是「加参数，不画贴图」：株型决定骨架，这几个性状决定长相。
 * 9 株型 × 9 叶形 × 6 叶色 × 6 花形 × 3 株幅，组合够用了。
 */

export const LEAF_SHAPE_OPTIONS = ['卵形', '披针', '剑形', '带状', '心形', '掌状', '羽状', '针形', '圆形'] as const
export const FOLIAGE_COLOR_OPTIONS = ['深绿', '中绿', '浅绿', '灰绿', '紫红', '花叶'] as const
export const FLOWER_FORM_OPTIONS = ['单瓣', '重瓣', '穗状', '头状', '钟形', '蝶形'] as const
export const SPREAD_OPTIONS = ['紧凑', '中等', '开张'] as const

export const FOLIAGE_COLOR_HEX: Record<string, string> = {
  深绿: '#3f7a22',
  中绿: '#5fa832',
  浅绿: '#8cc85a',
  灰绿: '#8aa08a',
  紫红: '#8a4a6a',
  花叶: '#7ab84a'
}

/** 花叶（斑叶）要两种颜色交替才像，靠这个标记。 */
export function isVariegated(color: string | null | undefined): boolean {
  return (color ?? '').trim() === '花叶'
}

/** 叶色的实际十六进制。认不出就用中绿。 */
export function foliageHex(color: string | null | undefined): string {
  const key = (color ?? '').trim()
  return FOLIAGE_COLOR_HEX[key] ?? FOLIAGE_COLOR_HEX.中绿
}

export interface SpriteStyle {
  leafShape?: string | null
  foliageColor?: string | null
  flowerForm?: string | null
  spread?: string | null
}

/** 叶子往外伸几个像素。株幅决定张开程度。 */
function spreadBonus(spread: string | null | undefined): number {
  switch ((spread ?? '').trim()) {
    case '开张':
      return 1
    case '紧凑':
      return -1
    default:
      return 0
  }
}

/**
 * 画一片叶子。
 *
 * 形状不同，像素排布就不同 —— 这是「物种长相」差异最大的来源：
 * 剑形（鸢尾、朱顶红）是一根斜刺，圆形（铜钱草）是个小圆饼，
 * 掌状（天竺葵）像张开的手，针形（松）只有一条线。
 */
function drawLeaf(c: Canvas, x: number, y: number, dir: 1 | -1, len: number, shape: string, spread = 0): void {
  const L = Math.max(1, len + spread)
  const put = (dx: number, dy: number, key: string): void => c.px(x + dir * dx, y + dy, key)

  switch ((shape ?? '').trim()) {
    case '针形':
      // 一条线，几乎不占面积
      for (let i = 1; i <= L; i++) put(i, -Math.round(i * 0.35), 'g')
      break

    case '剑形':
      // 斜着刺出去，中段加亮
      for (let i = 1; i <= L; i++) {
        put(i, -Math.round(i * 0.3), i > 1 && i < L ? 'G' : 'g')
      }
      break

    case '带状':
      // 直上直下、不收缩，像朱顶红那种
      for (let i = 1; i <= L; i++) {
        put(i, 0, 'g')
        if (i % 3 === 2) put(i, 1, 'd')
      }
      break

    case '披针':
      // 两头尖中间宽
      for (let i = 1; i <= L; i++) {
        const w = i > 1 && i < L ? 1 : 0
        put(i, 0, 'g')
        if (w) put(i, -1, 'G')
      }
      break

    case '心形':
      // 三格宽、根部有个小缺口
      for (let i = 0; i <= L; i++) put(i, 0, 'g')
      put(1, -1, 'G')
      put(2, -1, 'g')
      put(2, 1, 'd')
      break

    case '掌状':
      // 像张开的手：三条短指
      for (let i = 1; i <= Math.max(1, Math.floor(L / 2)); i++) {
        put(i, -1, 'g')
        put(i + 1, 0, 'G')
        put(i, 1, 'g')
      }
      break

    case '羽状':
      // 主轴 + 两侧小叶
      for (let i = 1; i <= L; i++) {
        put(i, 0, 'd')
        if (i % 2 === 1) {
          put(i, -1, 'g')
          put(i, 1, 'g')
        }
      }
      break

    case '圆形':
      // 小圆饼
      put(1, 0, 'G')
      put(2, -1, 'g')
      put(2, 0, 'G')
      put(2, 1, 'g')
      break

    default: {
      // 卵形：最普通的一种，两格半宽
      for (let i = 1; i <= L; i++) put(i, 0, 'g')
      put(1, -1, 'G')
      put(2, 1, 'd')
      break
    }
  }
}

// ---------------------------------------------------------------------------
// 栽种方式 → 底座
// ---------------------------------------------------------------------------

export type SpriteBase = 'pot' | 'ground' | 'water' | 'board'

/**
 * 植株的栽种方式。
 *
 * 之前底座是**写死在株型里**的：乔木→地面、水生→水面、其余→花盆。
 * 于是一盆盆栽的乔木也画在地里、地栽的月季也画在盆里 —— 这是明确画错，
 * 而且「怎么种」是植株的属性，不是物种的属性：同一株薄荷，
 * 你可以种在盆里也可以种在地里。
 */
export const CULTIVATION_OPTIONS = ['盆栽', '地栽', '水培', '附生板'] as const

export const CULTIVATION_BASE: Record<string, SpriteBase> = {
  盆栽: 'pot',
  地栽: 'ground',
  水培: 'water',
  附生板: 'board'
}

/**
 * 取底座。
 *
 * 没填栽种方式时退回株型的天然底座：水生植物（睡莲、铜钱草）默认在水里，
 * 其余默认盆栽 —— 这个应用的用户大多是阳台/窗台养花，
 * 盆栽是更常见的默认，而且用户随时可以改成地栽。
 */
export function baseForCultivation(cultivation: string | null | undefined, habit?: string | null): SpriteBase {
  const key = (cultivation ?? '').trim()
  if (CULTIVATION_BASE[key]) return CULTIVATION_BASE[key]
  return habit === '水生' ? 'water' : 'pot'
}

function drawBase(c: Canvas, base: SpriteBase): void {
  switch (base) {
    case 'pot':
      c.rect(4, GROUND_Y, 8, 2, 'p')
      c.rect(4, GROUND_Y, 8, 1, 'P')
      c.px(4, GROUND_Y + 1, 'P')
      c.px(11, GROUND_Y + 1, 'P')
      break
    case 'ground':
      c.rect(2, GROUND_Y, 12, 3, 'S')
      c.rect(2, GROUND_Y, 12, 1, 's')
      break
    case 'water':
      // 水面 + 一圈玻璃口的暗示，和纯地栽区分开
      c.rect(2, GROUND_Y, 12, 3, 'w')
      c.rect(2, GROUND_Y, 12, 1, 'W')
      c.px(2, GROUND_Y + 2, 'W')
      c.px(13, GROUND_Y + 2, 'W')
      break
    case 'board':
      // 附生板：一块树皮，植物长在上面
      c.rect(3, GROUND_Y - 1, 10, 3, 't')
      c.rect(3, GROUND_Y - 1, 10, 1, 'T')
      c.px(4, GROUND_Y + 1, 'T')
      c.px(11, GROUND_Y + 1, 'T')
      break
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
const SHAPES: Record<SpriteHabit, (c: Canvas, look: GrowthLook, base: SpriteBase, style: SpriteStyle) => void> = {
  /** 草本：一根细茎，对生叶 */
  草本(c, look, base, style) {
    drawBase(c, base)
    const top = GROUND_Y - 1 - look.stem
    c.vline(7, top, GROUND_Y - 1, 'b')
    const sp = spreadBonus(style.spread)
    for (let i = 0; i < look.leaves; i++) {
      const y = GROUND_Y - 2 - i * 2
      if (y <= top + 1) break
      // 叶形决定这一对叶子长什么样 —— 草本之间的差异几乎全在这里
      drawLeaf(c, 7, y, -1, 2 + Math.floor(look.leaves / 2), style.leafShape ?? '', sp)
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 8, top - 1, look.flower)
  },

  /** 灌木：短主干 + 一蓬叶子 */
  灌木(c, look, base, _style) {
    drawBase(c, base)
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
  乔木(c, look, base, _style) {
    drawBase(c, base)
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
  藤本(c, look, base, style) {
    drawBase(c, base)
    const top = GROUND_Y - 1 - look.stem
    let x = 8
    for (let y = GROUND_Y - 1; y >= top; y--) {
      c.px(x, y, 'b')
      // 每三格往左偏一次，做出攀爬的弯度
      if ((GROUND_Y - y) % 3 === 0 && x > 4) x--
      if ((GROUND_Y - y) % 2 === 0) {
        drawLeaf(c, x, y, -1, 2, style.leafShape ?? '', spreadBonus(style.spread))
        drawLeaf(c, x, y - 1, 1, 1, style.leafShape ?? '')
      }
    }
    if (look.flower !== 'none') drawFlower(c, x, top - 1, look.flower)
  },

  /** 多肉：低矮莲座，一层层往外摊 */
  多肉(c, look, base, _style) {
    drawBase(c, base)
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
  球根(c, look, base, style) {
    drawBase(c, base)
    c.rect(6, GROUND_Y - 1, 3, 2, 'p')
    const blades = Math.max(1, Math.min(4, look.leaves + 1))
    /*
     * 球根类（朱顶红、郁金香、风信子）的叶片**就是它的长相**，
     * 所以这里必须真的按叶形画，不能只加个叶尖高光 ——
     * 第一版偷懒只判断了「带状」，自检里「球根也受叶形影响」立刻红了。
     *
     * 第一版偷懒只判了「带状」，自检里那条立刻红了。
     */
    const shape = (style.leafShape ?? '').trim()
    const wide = shape === '圆形' || shape === '卵形' || shape === '心形' || shape === '掌状'
    const taper = shape === '剑形' || shape === '披针'
    const thin = shape === '针形'
    for (let i = 0; i < blades; i++) {
      const dx = i - Math.floor(blades / 2)
      const h = Math.max(1, (thin ? look.stem - 2 : look.stem) - Math.abs(dx))
      for (let k = 0; k < h; k++) {
        c.px(8 + dx, GROUND_Y - 2 - k, k > h - 2 ? 'G' : 'g')
        // 圆叶类长宽一些，剑叶类往上收，针叶只有一条线
        if (wide && k < h - 2) c.px(8 + dx + (dx >= 0 ? 1 : -1), GROUND_Y - 2 - k, 'G')
        if (taper && k > h / 2) c.px(8 + dx + (dx >= 0 ? 1 : -1), GROUND_Y - 2 - k, 'd')
      }
      if (shape === '带状') c.px(8 + dx, GROUND_Y - 2 - h, 'G')
    }
    if (look.flower !== 'none') drawFlower(c, 8, GROUND_Y - 3 - look.stem, look.flower)
  },

  /** 水生：浮叶 + 立出水面的花。底座由栽种方式决定（睡莲默认水培） */
  水生(c, look, base, _style) {
    drawBase(c, base)
    c.rect(5, GROUND_Y - 1, 4, 1, 'g') // 浮叶
    c.px(4, GROUND_Y - 1, 'G')
    c.px(9, GROUND_Y - 1, 'G')
    if (look.stem > 3) c.vline(9, GROUND_Y - look.stem, GROUND_Y - 2, 'b')
    if (look.flower !== 'none') drawFlower(c, 9, GROUND_Y - look.stem - 3, look.flower)
  },

  /** 蕨类：一根主轴，两侧羽状小叶 */
  蕨类(c, look, base, style) {
    drawBase(c, base)
    const top = GROUND_Y - 1 - look.stem
    c.vline(7, top, GROUND_Y - 1, 'b')
    for (let y = GROUND_Y - 2; y >= top; y -= 2) {
      drawLeaf(c, 7, y, -1, 2, style.leafShape ?? '', spreadBonus(style.spread))
    }
    c.mirror()
    if (look.flower !== 'none') drawFlower(c, 8, top - 1, look.flower)
  },

  /** 附生：一截木头，叶子贴在木头上 */
  附生(c, look, base, style) {
    drawBase(c, base)
    const top = GROUND_Y - 1 - Math.max(3, look.stem)
    c.rect(7, top, 1, GROUND_Y - top - 1, 't')
    c.px(5, top + 2, 'T')
    for (let i = 0; i < Math.max(1, look.leaves); i++) {
      const y = top + 1 + i * 2
      drawLeaf(c, 7, y, -1, 2, style.leafShape ?? '', spreadBonus(style.spread))
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
  const base = baseForCultivation(options.cultivation, habit)
  const c = new Canvas()

  SHAPES[habit](c, look, base, options.style ?? {})

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
