/**
 * 导出「单株全年养护计划」为独立 HTML。
 *
 * 为什么是 HTML 而不是 PDF / 图片：
 *  - 不引依赖（PDF 要渲染进程或第三方库），主进程拼字符串就能生成；
 *  - 单文件、内联样式，双击就能看，也能直接打印成 PDF（页面已做 @media print）；
 *  - 手机上打开也自适应。
 *
 * 这里只负责「数据 → 字符串」，不碰数据库、不碰文件系统 —— 好测。
 */

import { CARE_ACTION_LABELS } from './care'
import type { CareActionType, CareTaskStatus } from './types'

export interface CarePlanHtmlTask {
  actionType: CareActionType
  title: string
  detail: string | null
  /** YYYY-MM-DD */
  dueDate: string
  /** 时间窗 ±N 天 */
  windowDays: number
  status: CareTaskStatus
}

export interface CarePlanHtmlInput {
  plantName: string
  speciesName: string | null
  /** 封面图（`data:` URI）；没有就不显示 */
  coverDataUrl?: string | null
  year: number
  tasks: CarePlanHtmlTask[]
  /** 生成时间，只用于页脚 */
  generatedAt: Date
}

const STATUS_LABEL: Record<CareTaskStatus, string> = {
  pending: '待办',
  done: '已完成',
  skipped: '已跳过'
}

/** 动作类型的配色（徽章底色 + 文字色） */
const ACTION_COLOR: Record<CareActionType, { bg: string; fg: string }> = {
  water: { bg: '#d6ecf9', fg: '#1f5c86' },
  fertilize: { bg: '#f7e6b8', fg: '#7a5310' },
  prune: { bg: '#e8dcf2', fg: '#5b3a7a' },
  repot: { bg: '#ecd9c4', fg: '#7a4a1e' },
  pest: { bg: '#f7dcd2', fg: '#8a3a1c' },
  protect: { bg: '#dbe8f5', fg: '#2c4f7a' },
  observe: { bg: '#e2f0d6', fg: '#3f6b24' },
  other: { bg: '#e9e2d6', fg: '#6b5a44' }
}

const STATUS_COLOR: Record<CareTaskStatus, string> = {
  pending: '#b8860b',
  done: '#3f8f2a',
  skipped: '#8a8a8a'
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `2026-10-19` → `10-19` */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[2]}-${m[3]}` : iso
}

export function buildCarePlanHtml(input: CarePlanHtmlInput): string {
  const { plantName, speciesName, coverDataUrl, year, tasks, generatedAt } = input
  const sorted = [...tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  const byMonth: CarePlanHtmlTask[][] = Array.from({ length: 12 }, () => [])
  for (const task of sorted) {
    const month = Number(task.dueDate.slice(5, 7))
    if (month >= 1 && month <= 12) byMonth[month - 1].push(task)
  }

  const done = sorted.filter((t) => t.status === 'done').length
  const skipped = sorted.filter((t) => t.status === 'skipped').length
  const pending = sorted.length - done - skipped

  const actionCount = new Map<CareActionType, number>()
  for (const task of sorted) actionCount.set(task.actionType, (actionCount.get(task.actionType) ?? 0) + 1)
  const actionChips = [...actionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const color = ACTION_COLOR[type]
      return `<span class="chip" style="background:${color.bg};color:${color.fg}">${esc(
        CARE_ACTION_LABELS[type]
      )} <b>${count}</b></span>`
    })
    .join('')

  // 顶部 12 格的年度密度条：一眼看出哪几个月忙
  const maxPerMonth = Math.max(1, ...byMonth.map((m) => m.length))
  const density = byMonth
    .map((list, i) => {
      const ratio = list.length / maxPerMonth
      const height = 6 + Math.round(ratio * 30)
      const tone = list.length === 0 ? '#e6d3b6' : '#c98a45'
      return `<div class="bar" title="${i + 1} 月：${list.length} 项">
        <i style="height:${height}px;background:${tone}"></i><span>${i + 1}</span>
      </div>`
    })
    .join('')

  const months = byMonth
    .map((list, i) => {
      const rows =
        list.length === 0
          ? '<li class="empty">本月无安排</li>'
          : list
              .map((task) => {
                const color = ACTION_COLOR[task.actionType]
                const statusColor = STATUS_COLOR[task.status]
                const windowHint = task.windowDays > 0 ? `±${task.windowDays} 天窗口` : ''
                return `<li class="task">
            <span class="date">${pad2(i + 1)}-${esc(shortDate(task.dueDate).slice(3))}</span>
            <span class="chip" style="background:${color.bg};color:${color.fg}">${esc(
              CARE_ACTION_LABELS[task.actionType]
            )}</span>
            <span class="title">${esc(task.title)}${
              windowHint ? `<i class="window">${windowHint}</i>` : ''
            }</span>
            <span class="status" style="color:${statusColor}">${STATUS_LABEL[task.status]}</span>
            ${task.detail ? `<span class="detail">${esc(task.detail)}</span>` : ''}
          </li>`
              })
              .join('')
      return `<section class="month${list.length === 0 ? ' is-empty' : ''}">
        <h2>${i + 1} 月<span class="count">${list.length} 项</span></h2>
        <ul>${rows}</ul>
      </section>`
    })
    .join('')

  const subtitle = speciesName ? `${esc(speciesName)} · ${year} 年养护计划` : `${year} 年养护计划`
  const stamp = `${generatedAt.getFullYear()}-${pad2(generatedAt.getMonth() + 1)}-${pad2(generatedAt.getDate())} ${pad2(
    generatedAt.getHours()
  )}:${pad2(generatedAt.getMinutes())}`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plantName)} · ${year} 年养护计划</title>
<style>
  :root {
    --ink: #4a2a12;
    --muted: #8a6a4a;
    --line: #d9bd93;
    --paper: #fff7e6;
    --wood: #c98a45;
    --wood-dark: #8a5423;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 20px 40px;
    background: #f3e2c7;
    color: var(--ink);
    font: 14px/1.65 "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header {
    display: flex;
    gap: 18px;
    align-items: flex-start;
    background: var(--paper);
    border: 3px solid var(--wood-dark);
    box-shadow: 0 6px 0 rgba(90, 55, 20, .18);
    padding: 20px 24px 18px;
  }
  .hd-main { flex: 1; min-width: 0; }
  .cover {
    flex: none;
    width: 132px;
    height: 132px;
    object-fit: cover;
    background: #fff;
    border: 3px solid var(--wood-dark);
  }
  h1 { margin: 0; font-size: 26px; letter-spacing: .5px; }
  .sub { margin-top: 4px; color: var(--muted); font-size: 13px; }
  .stamp { float: right; color: var(--muted); font-size: 12px; margin-top: 6px; }

  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 0; }
  .stat {
    flex: 1 1 120px; background: #fffdf6; border: 2px solid var(--line);
    padding: 8px 12px; text-align: center;
  }
  .stat b { display: block; font-size: 22px; line-height: 1.2; }
  .stat span { color: var(--muted); font-size: 12px; }
  .stat.done b { color: #3f8f2a; }
  .stat.pending b { color: #b8860b; }
  .stat.skipped b { color: #8a8a8a; }

  .panel { background: var(--paper); border: 3px solid var(--wood-dark); padding: 16px 20px; margin-top: 18px; }
  .panel h2 { font-size: 15px; margin: 0 0 10px; }

  .density { display: flex; align-items: flex-end; gap: 6px; height: 48px; }
  .density .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
  .density .bar i { display: block; width: 100%; border-radius: 0; }
  .density .bar span { font-size: 10px; color: var(--muted); }

  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .chip { display: inline-block; padding: 1px 7px; font-size: 12px; border: 1px solid rgba(0,0,0,.12); white-space: nowrap; }
  .chip b { font-weight: 700; }

  .months { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; margin-top: 18px; }
  .month { background: var(--paper); border: 2px solid var(--line); padding: 12px 14px; break-inside: avoid; page-break-inside: avoid; }
  .month h2 { font-size: 14px; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 2px dashed var(--line); display: flex; justify-content: space-between; }
  .month .count { color: var(--muted); font-weight: 400; font-size: 12px; }
  .month.is-empty { opacity: .62; }
  .month ul { list-style: none; margin: 0; padding: 0; }
  .month li.task {
    display: grid; grid-template-columns: 46px auto 1fr auto; align-items: baseline;
    column-gap: 8px; row-gap: 2px; padding: 5px 0; border-bottom: 1px dotted var(--line);
  }
  .month li.task:last-child { border-bottom: 0; }
  .month li.empty { color: var(--muted); font-size: 12px; padding: 4px 0; }
  .date { color: var(--muted); font-variant-numeric: tabular-nums; }
  .title { min-width: 0; word-break: break-word; }
  .window { color: var(--muted); font-size: 11px; font-style: normal; margin-left: 6px; white-space: nowrap; }
  .status { font-size: 12px; text-align: right; }
  .detail { grid-column: 1 / -1; color: var(--muted); font-size: 12px; padding-left: 52px; }

  footer { margin-top: 22px; color: var(--muted); font-size: 12px; text-align: center; }

  @media print {
    body { background: #fff; padding: 0; }
    header, .panel, .month { box-shadow: none; }
    .months { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    ${coverDataUrl ? `<img class="cover" alt="${esc(plantName)} 封面" src="${coverDataUrl}">` : ''}
    <div class="hd-main">
      <div class="stamp">导出于 ${stamp}</div>
      <h1>${esc(plantName)}</h1>
      <div class="sub">${subtitle}</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${sorted.length}</b><span>全年任务</span></div>
      <div class="stat done"><b>${done}</b><span>已完成</span></div>
      <div class="stat pending"><b>${pending}</b><span>待办</span></div>
      <div class="stat skipped"><b>${skipped}</b><span>已跳过</span></div>
    </div>
  </header>

  <div class="panel">
    <h2>每月密度</h2>
    <div class="density">${density}</div>
    <div class="chips">${actionChips || '<span class="chip">这一年还没有任何任务</span>'}</div>
  </div>

  <div class="months">${months}</div>

  <footer>由 Sproutbook 导出 · ${stamp} · 共 ${sorted.length} 项任务</footer>
</div>
</body>
</html>`
}
