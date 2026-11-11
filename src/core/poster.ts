/**
 * 分享海报：把一株植物 / 一个月的计划 / 最近日志拼成一张 1080×1440 的图。
 *
 * 为什么是「拼 HTML 再截图」而不是用 canvas 直接画：
 *  - 排版（换行、省略、flex 排版）交给浏览器，比手写坐标稳得多；
 *  - 截图在隐藏窗口里做，和界面用的是同一套字体与像素边框，风格一致；
 *  - 这一层仍然只是「数据 → 字符串」，纯函数，能自检。
 *
 * 版式固定 3:4（1080×1440），发朋友圈 / 小红书都正好。
 */

import { CARE_ACTION_LABELS } from './care'
import type { CareActionType } from './types'

export type PosterKind = 'plant' | 'plan' | 'log'

export interface PosterStat {
  label: string
  value: string
}

export interface PosterSection {
  title: string
  lines: string[]
}

export interface PosterInput {
  kind: PosterKind
  /** 大标题：植株名 / 2026 年 11 月 养护计划 / 最近养护记录 */
  title: string
  /** 标题下的一行说明：物种 · 位置 / 时间范围 */
  subtitle: string | null
  /** 主图（data: URL） */
  hero: string | null
  stats: PosterStat[]
  sections: PosterSection[]
  /** 底部小图（data: URL），最多 4 张 */
  thumbs: string[]
  /** 页脚说明，例如「生成于 2026-11-11」 */
  footer: string
  /** 品牌行，默认 Sproutbook */
  brand?: string
}

const WIDTH = 1080
const HEIGHT = 1440

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

const STYLE = `
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
  body {
    background: #f7e7c6;
    color: #3a2a1a;
  }
  .poster {
    position: relative;
    width: 100%; height: 100%; overflow: hidden;
    padding: 46px 52px 40px;
    display: flex; flex-direction: column; gap: 22px;
    background:
      radial-gradient(1200px 600px at 50% -20%, #fff6e0 0%, rgba(255,246,224,0) 60%),
      repeating-linear-gradient(0deg, rgba(120,86,48,.045) 0 2px, rgba(120,86,48,0) 2px 5px),
      #f7e7c6;
    border: 14px solid #6b4a2a;
    box-shadow: inset 0 0 0 4px #b97a3c, inset 0 0 0 8px #f7e7c6;
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-size: 20px; letter-spacing: 2px; color: #8a6a44; font-weight: 700;
  }
  .brand .dot { width: 10px; height: 10px; background: #7d9a3f; box-shadow: 0 0 0 3px rgba(125,154,63,.25); }
  h1 {
    font-size: 56px; line-height: 1.15; font-weight: 800; letter-spacing: 1px;
    color: #4a3218;
    text-shadow: 0 2px 0 #fff3d6, 0 4px 0 rgba(120,86,48,.18);
    word-break: break-word;
  }
  .sub { font-size: 22px; color: #7c5f3e; margin-top: 4px; }
  .hero-wrap { flex: 1 1 auto; min-height: 300px; max-height: 760px; display: flex; }
  .hero {
    width: 100%; height: 100%; flex: 1;
    border: 6px solid #6b4a2a; background: #d9c6a2;
    box-shadow: 0 6px 0 rgba(107,74,42,.25);
    overflow: hidden;
  }
  .hero img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .hero.empty { display: flex; align-items: center; justify-content: center; font-size: 24px; color: #8a6a44; }
  .stats { display: flex; gap: 12px; flex: none; }
  .stat {
    flex: 1; padding: 12px 14px; background: #fffaf0;
    border: 4px solid #6b4a2a; box-shadow: 0 4px 0 rgba(107,74,42,.22);
    text-align: center;
  }
  .stat .v { font-size: 30px; font-weight: 800; color: #4a3218; }
  .stat .l { font-size: 16px; color: #8a6a44; margin-top: 2px; }
  .poster[data-nophoto] .body-block { flex: 1 1 auto; justify-content: center; }
  .body-block { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
  section h2 {
    font-size: 22px; color: #6b4a2a; font-weight: 800;
    padding-bottom: 4px; border-bottom: 3px dashed rgba(107,74,42,.35);
    margin-bottom: 6px;
  }
  section ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  section li { font-size: 19px; line-height: 1.35; color: #4a3a26; display: flex; gap: 8px; }
  section li::before { content: '•'; color: #b4632a; font-weight: 800; }
  .thumbs { display: flex; gap: 10px; flex: none; }
  .thumbs .t { flex: 1; height: 150px; border: 4px solid #6b4a2a; overflow: hidden; background: #d9c6a2; }
  .thumbs img { width: 100%; height: 100%; object-fit: cover; display: block; }
  footer {
    flex: none; display: flex; align-items: center; justify-content: space-between;
    font-size: 16px; color: #8a6a44; border-top: 3px solid rgba(107,74,42,.3);
    padding-top: 10px;
  }
  footer .mark { font-weight: 800; letter-spacing: 1px; color: #6b4a2a; }
`

function renderStats(stats: PosterStat[]): string {
  if (stats.length === 0) return ''
  const cells = stats
    .slice(0, 4)
    .map((s) => `<div class="stat"><div class="v">${esc(clampText(s.value, 14))}</div><div class="l">${esc(s.label)}</div></div>`)
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

export function buildPosterHtml(input: PosterInput): string {
  const brand = input.brand ?? 'Sproutbook · 植物手账'
  /*
   * 没有主图就整块不出现：计划 / 日志海报本来就没有封面，
   * 留一个「还没有照片」的空框只会让人觉得导出失败。
   */
  const hero = input.hero
    ? `<div class="hero-wrap"><div class="hero"><img src="${input.hero}" alt="" /></div></div>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="poster" data-kind="${input.kind}"${input.hero ? '' : ' data-nophoto'}>
    <div class="brand"><span class="dot"></span>${esc(brand)}</div>
    <div>
      <h1>${esc(clampText(input.title, 26))}</h1>
      ${input.subtitle ? `<div class="sub">${esc(clampText(input.subtitle, 60))}</div>` : ''}
    </div>
    ${hero}
    ${renderStats(input.stats)}
    ${renderSections(input.sections)}
    ${renderThumbs(input.thumbs)}
    <footer><span>${esc(clampText(input.footer, 60))}</span><span class="mark">Sproutbook</span></footer>
  </div>
</body>
</html>`
}

export const POSTER_WIDTH = WIDTH
export const POSTER_HEIGHT = HEIGHT
