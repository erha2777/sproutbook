/**
 * 分享海报：把数据拼成一张 1080 宽的长图。
 *
 * 为什么是「拼 HTML 再截图」而不是 canvas 直接画：
 *  - 排版（换行、省略、flex 布局）交给浏览器，比手写坐标稳；
 *  - 截图在隐藏窗口里做，和界面用的是同一套字体，风格一致；
 *  - 这一层仍然只是「数据 → 字符串」，纯函数，能自检。
 *
 * 内容形态（layout）：
 *  - `hero`     一张大图 + 统计 + 清单（单株档案 / 月计划 / 日志默认）
 *  - `grid`     图片拼贴（2 列，带日期角标）—— 挑一段开花期做九宫格
 *  - `timeline` 成长时间轴（左图右文，按日期排列）
 *
 * 配色（theme）：`paper` 纸黄（默认）、`night` 夜蓝、`garden` 草木绿。
 * 都是同一套结构换几个颜色变量，不加图片素材。
 */

import { CARE_ACTION_LABELS } from './care'
import type { CareActionType } from './types'

export type PosterKind = 'plant' | 'plan' | 'log' | 'growth' | 'collage'
export type PosterTheme = 'paper' | 'night' | 'garden'
export type PosterLayout = 'hero' | 'grid' | 'timeline'

export interface PosterStat {
  label: string
  value: string
}

export interface PosterSection {
  title: string
  lines: string[]
}

/** 拼贴 / 时间轴里的一张图 */
export interface PosterPhoto {
  /** data: URL */
  url: string
  /** 角标，一般是日期（`10-24`） */
  caption?: string | null
}

export interface PosterInput {
  kind: PosterKind
  /** 大标题：植株名 / 2026 年 11 月 养护计划 / 最近养护记录 / 成长记录 */
  title: string
  /** 标题下的一行说明：物种 · 位置 / 时间范围 */
  subtitle: string | null
  /** 主图（data: URL），只有 hero 版式用 */
  hero: string | null
  stats: PosterStat[]
  sections: PosterSection[]
  /** 底部小图（data: URL），最多 4 张，只有 hero 版式用 */
  thumbs?: string[]
  /** 拼贴 / 时间轴的照片，最多 9 张 */
  photos?: PosterPhoto[]
  theme?: PosterTheme
  layout?: PosterLayout
  /** 页脚说明，例如「生成于 2026-11-11」 */
  footer: string
  /** 品牌行，默认 Sproutbook */
  brand?: string
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 截断长文本。
 *
 * 海报是固定画布，行数必须可控 —— 一段 300 字的日志会把后面所有内容顶出去，
 * 截图时被裁掉一半，看起来像坏了。宁可显示「…」。
 */
export function clampText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`
}

const ACTION_TAG: Record<CareActionType, string> = CARE_ACTION_LABELS

function isActionType(value: string): value is CareActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_TAG, value)
}

/** 把动作类型转成人能读的标签；不认识的（自定义 kind）原样返回 */
export function actionLabel(kind: string): string {
  return isActionType(kind) ? ACTION_TAG[kind] : kind || '记录'
}

interface ThemeTokens {
  paper: string
  ink: string
  inkSoft: string
  outline: string
  frame2: string
  accent: string
  card: string
  heroBg: string
}

const THEMES: Record<PosterTheme, ThemeTokens> = {
  paper: {
    paper: '#f7e7c6',
    ink: '#3a2a1a',
    inkSoft: '#7c5f3e',
    outline: '#6b4a2a',
    frame2: '#b97a3c',
    accent: '#b4632a',
    card: '#fffaf0',
    heroBg: '#d9c6a2'
  },
  night: {
    paper: '#1d2738',
    ink: '#eef2f8',
    inkSoft: '#a9b6c9',
    outline: '#0d131d',
    frame2: '#4d6a8f',
    accent: '#e0b25c',
    card: '#26344a',
    heroBg: '#2b3a52'
  },
  garden: {
    paper: '#eef3e2',
    ink: '#2f3a23',
    inkSoft: '#5f6d47',
    outline: '#4d5c35',
    frame2: '#8aa35a',
    accent: '#6f8f3a',
    card: '#f8fbf0',
    heroBg: '#cdd9b4'
  }
}

function themeCss(theme: PosterTheme): string {
  const t = THEMES[theme]
  return `
  :root { --paper: ${t.paper}; --ink: ${t.ink}; --ink-soft: ${t.inkSoft}; --outline: ${t.outline}; --frame2: ${t.frame2}; --accent: ${t.accent}; --card: ${t.card}; --hero-bg: ${t.heroBg}; }`
}

const LAYOUT_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    /*
     * 不写死 1080×1440：Windows 会把窗口高度钳在工作区以内（实测请求 1440 只给到 1392），
     * 写死就会在底部被裁掉一截。这里让画布铺满真实视口，截图按实测尺寸取，
     * 换台机器也不会裁切。
     */
    width: 100%; height: 100%; overflow: hidden;
    font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body { background: var(--paper); color: var(--ink); }
  .poster {
    position: relative;
    width: 100%; height: 100%; overflow: hidden;
    padding: 46px 52px 40px;
    display: flex; flex-direction: column; gap: 22px;
    background:
      radial-gradient(1200px 600px at 50% -20%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 60%),
      repeating-linear-gradient(0deg, rgba(120,86,48,.045) 0 2px, rgba(120,86,48,0) 2px 5px),
      var(--paper);
    border: 14px solid var(--outline);
    box-shadow: inset 0 0 0 4px var(--frame2), inset 0 0 0 8px var(--paper);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-size: 20px; letter-spacing: 2px; color: var(--ink-soft); font-weight: 700;
  }
  .brand .dot { width: 10px; height: 10px; background: var(--accent); box-shadow: 0 0 0 3px rgba(125,154,63,.25); }
  h1 {
    font-size: 54px; line-height: 1.15; font-weight: 800; letter-spacing: 1px;
    color: var(--ink);
    text-shadow: 0 2px 0 rgba(255,255,255,.18);
    word-break: break-word;
  }
  .sub { font-size: 22px; color: var(--ink-soft); margin-top: 4px; }
  .hero-wrap { flex: 1 1 auto; min-height: 300px; max-height: 760px; display: flex; }
  .hero {
    width: 100%; height: 100%; flex: 1;
    border: 6px solid var(--outline); background: var(--hero-bg);
    box-shadow: 0 6px 0 rgba(0,0,0,.18);
    overflow: hidden;
  }
  .hero img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .stats { display: flex; gap: 12px; flex: none; }
  .stat {
    flex: 1; padding: 12px 14px; background: var(--card);
    border: 4px solid var(--outline); box-shadow: 0 4px 0 rgba(0,0,0,.16);
    text-align: center;
  }
  .stat .v { font-size: 30px; font-weight: 800; color: var(--ink); }
  .stat .l { font-size: 16px; color: var(--ink-soft); margin-top: 2px; }
  .poster[data-nophoto] .body-block { flex: 1 1 auto; justify-content: center; }
  .body-block { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
  section h2 {
    font-size: 22px; color: var(--outline); font-weight: 800;
    padding-bottom: 4px; border-bottom: 3px dashed rgba(127,127,127,.35);
    margin-bottom: 6px;
  }
  section ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  section li { font-size: 19px; line-height: 1.35; color: var(--ink); display: flex; gap: 8px; }
  section li::before { content: '•'; color: var(--accent); font-weight: 800; }
  .thumbs { display: flex; gap: 10px; flex: none; }
  .thumbs .t { flex: 1; height: 150px; border: 4px solid var(--outline); overflow: hidden; background: var(--hero-bg); }
  .thumbs img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* 拼贴：两列网格，带日期角标 */
  .grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid.n3 { grid-template-columns: repeat(3, 1fr); }
  .grid .cell {
    position: relative; overflow: hidden; background: var(--hero-bg);
    border: 5px solid var(--outline); box-shadow: 0 5px 0 rgba(0,0,0,.16);
  }
  .grid .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .grid .cap {
    position: absolute; left: 0; bottom: 0; padding: 2px 8px;
    font-size: 15px; font-weight: 700; color: #fff;
    background: rgba(0,0,0,.55); letter-spacing: .5px;
  }
  /* 时间轴：左图右文 */
  .timeline { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .tl-row { display: flex; gap: 14px; align-items: stretch; flex: 1 1 0; min-height: 0; }
  .tl-img {
    width: 200px; height: 100%; flex: none; overflow: hidden;
    border: 4px solid var(--outline); background: var(--hero-bg);
  }
  .tl-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tl-text { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; }
  .tl-date { font-size: 20px; font-weight: 800; color: var(--accent); }
  .tl-line { font-size: 17px; color: var(--ink); line-height: 1.3; }

  footer {
    flex: none; display: flex; align-items: center; justify-content: space-between;
    font-size: 16px; color: var(--ink-soft); border-top: 3px solid rgba(127,127,127,.3);
    padding-top: 10px;
  }
  footer .mark { font-weight: 800; letter-spacing: 1px; color: var(--outline); }
`

function renderStats(stats: PosterStat[]): string {
  if (stats.length === 0) return ''
  const cells = stats
    .slice(0, 4)
    .map(
      (s) =>
        `<div class="stat"><div class="v">${esc(clampText(s.value, 14))}</div><div class="l">${esc(s.label)}</div></div>`
    )
    .join('')
  return `<div class="stats">${cells}</div>`
}

function renderSections(sections: PosterSection[]): string {
  const blocks = sections
    .filter((s) => s.lines.length > 0)
    .slice(0, 4)
    .map(
      (s) =>
        `<section><h2>${esc(s.title)}</h2><ul>${s.lines
          .slice(0, 8)
          .map((line) => `<li><span>${esc(clampText(line, 80))}</span></li>`)
          .join('')}</ul></section>`
    )
    .join('')
  return `<div class="body-block">${blocks}</div>`
}

function renderThumbs(thumbs: string[]): string {
  if (thumbs.length === 0) return ''
  const cells = thumbs
    .slice(0, 4)
    .map((url) => `<div class="t"><img src="${url}" alt="" /></div>`)
    .join('')
  return `<div class="thumbs">${cells}</div>`
}

function renderGrid(photos: PosterPhoto[]): string {
  const cells = photos
    .slice(0, 9)
    .map(
      (p) =>
        `<div class="cell"><img src="${p.url}" alt="" />${
          p.caption ? `<span class="cap">${esc(clampText(p.caption, 16))}</span>` : ''
        }</div>`
    )
    .join('')
  return `<div class="grid${photos.length > 4 ? ' n3' : ''}">${cells}</div>`
}

function renderTimeline(photos: PosterPhoto[], sections: PosterSection[]): string {
  const rows = photos
    .slice(0, 6)
    .map(
      (p) =>
        `<div class="tl-row"><div class="tl-img"><img src="${p.url}" alt="" /></div>` +
        `<div class="tl-text"><div class="tl-date">${esc(p.caption ?? '')}</div>` +
        `<div class="tl-line">${esc(clampText(sections[0]?.lines[photos.indexOf(p)] ?? '', 46))}</div></div></div>`
    )
    .join('')
  return `<div class="timeline">${rows}</div>`
}

export function buildPosterHtml(input: PosterInput): string {
  const brand = input.brand ?? 'Sproutbook · 植物手账'
  const theme = input.theme ?? 'paper'
  const layout: PosterLayout = input.layout ?? (input.photos && input.photos.length > 0 ? 'grid' : 'hero')
  const photos = input.photos ?? []

  /*
   * 没有主图就整块不出现：计划 / 日志海报本来就没有封面，
   * 留一个「还没有照片」的空框只会让人觉得导出失败。
   */
  const hero =
    layout === 'hero' && input.hero
      ? `<div class="hero-wrap"><div class="hero"><img src="${input.hero}" alt="" /></div></div>`
      : ''

  const body =
    layout === 'grid'
      ? renderGrid(photos)
      : layout === 'timeline'
        ? renderTimeline(photos, input.sections)
        : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(input.title)}</title>
<style>${themeCss(theme)}${LAYOUT_CSS}</style>
</head>
<body>
  <div class="poster" data-kind="${input.kind}" data-layout="${layout}"${input.hero ? '' : ' data-nophoto'}>
    <div class="brand"><span class="dot"></span>${esc(brand)}</div>
    <div>
      <h1>${esc(clampText(input.title, 26))}</h1>
      ${input.subtitle ? `<div class="sub">${esc(clampText(input.subtitle, 60))}</div>` : ''}
    </div>
    ${hero}
    ${renderStats(input.stats)}
    ${body}
    ${layout === 'hero' ? renderSections(input.sections) : ''}
    ${layout === 'hero' ? renderThumbs(input.thumbs ?? []) : ''}
    <footer><span>${esc(clampText(input.footer, 60))}</span><span class="mark">Sproutbook</span></footer>
  </div>
</body>
</html>`
}

export const POSTER_WIDTH = 1080
export const POSTER_HEIGHT = 1440
