/**
 * 天气图标预览：把像素图标渲成一张对照图，用眼睛检查「一眼分不分得出」。
 *
 * 用法：node scripts/icon-preview.mjs
 *
 * 产出：
 *   docs/weather-icons.html   可直接用浏览器打开，能放大看
 *   .cache/weather-icons.png  同一页面的截图，不用开浏览器
 *
 * **为什么要有这个工具**
 *
 * 形状对不对，看网格数据是看不出来的。上一版给雨 / 雪 / 雷 / 阴都用了同一朵
 * 16px 灰云，只在云下差几个像素 —— 数据上「四种图标各不相同」，
 * 缩略图里却糊成一团。这类问题只有在真实像素尺寸下看才发现得了。
 *
 * 对照图里同时放**改动前（git HEAD）和改动后**：改图标之前先跑一次，
 * 改完再跑，两版并排才有说服力。HEAD 里没有这个文件时自动跳过那一行。
 *
 * **踩过的三个坑**（写下来免得重犯）
 *
 *   1. 必须走 `cmd /c` 才能等到 Electron 退出 —— 它是 GUI 子系统程序，
 *      PowerShell 的 `&` 调用不会等它，`$LASTEXITCODE` 会是空的
 *   2. `ELECTRON_RUN_AS_NODE` 要清掉，否则 Electron 以 Node 模式启动，
 *      窗口根本不开（这个变量在某些终端里会被自动注入）
 *   3. 项目路径里带空格（ai开发\stardew valley），Chromium 解析命令行参数时
 *      会出岔子，所以 HTML 先落到系统临时目录再加载
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICON_SRC = 'src/core/weatherIcon.ts'

/** 把一段 TS 源码编译进独立目录并 require 出来（新旧两版要能同时存在）。 */
function loadSource(source, dirName) {
  const dir = join(root, '.cache', dirName)
  mkdirSync(dir, { recursive: true })
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const file = join(dir, 'weatherIcon.js')
  writeFileSync(file, js, 'utf-8')
  delete require.cache[require.resolve(file)]
  return require(file)
}

/** 从 git HEAD 取旧版；拿不到就返回 null（第一次加这个文件时就是这样）。 */
function loadOld() {
  try {
    const source = execFileSync('git', ['show', `HEAD:${ICON_SRC}`], { cwd: root, encoding: 'utf-8' })
    return loadSource(source, 'icon-preview-old')
  } catch {
    return null
  }
}

const newMod = loadSource(readFileSync(join(root, ICON_SRC), 'utf-8'), 'icon-preview-new')
const oldMod = loadOld()

const KINDS = ['clear', 'cloudy', 'overcast', 'rain', 'snow', 'storm', 'fog']
const LABELS = { clear: '晴', cloudy: '多云', overcast: '阴', rain: '雨', snow: '雪', storm: '雷', fog: '雾' }

/** 一个图标的 SVG。crispEdges 关掉抗锯齿，像素才是方的。 */
function svgOf(mod, kind, size) {
  const art = mod.buildWeatherIcon(kind)
  if (!art) return '<span>·</span>'
  const rects = []
  art.grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      if (ch === '.') {
        x += 1
        continue
      }
      let w = 1
      while (x + w < row.length && row[x + w] === ch) w += 1
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${art.palette[ch]}"/>`)
      x += w
    }
  })
  const n = mod.WEATHER_ICON_SIZE
  return `<svg viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

const CARD = '#f4ecd8' // 应用里天气卡片的底色 —— 辨识度必须在这个底色上成立

function rowOf(mod, size, note) {
  const cells = KINDS.map(
    (k) => `<div class="cell"><div class="icon">${svgOf(mod, k, size)}</div><div class="name">${LABELS[k]}</div></div>`
  ).join('')
  return `<div class="row"><div class="rowhead">${note}</div><div class="cells">${cells}</div></div>`
}

const rows = [
  oldMod ? rowOf(oldMod, 16, '改动前 · 横条里的实际尺寸 16px') : '',
  oldMod ? rowOf(oldMod, 20, '改动前 · 同样放大到 20px') : '',
  rowOf(newMod, 16, '现在 · 横条旧尺寸 16px'),
  rowOf(newMod, 20, '现在 · 横条新尺寸 20px'),
  rowOf(newMod, 34, '现在 · 当天大图标 34px')
].filter(Boolean)

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>天气图标对照</title>
<style>
  body { margin:0; padding:20px; background:#fff; font-family:"Microsoft YaHei",system-ui,sans-serif; color:#333; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { font-size:12px; color:#777; margin-bottom:18px; }
  .row { margin-bottom:16px; }
  .rowhead { font-size:12px; color:#555; margin-bottom:6px; font-weight:700; }
  .cells { display:flex; background:${CARD}; padding:10px 0; border-radius:6px; }
  .cell { width:64px; text-align:center; }
  .icon { height:40px; display:flex; align-items:center; justify-content:center; }
  .name { font-size:11px; color:#6b5a3a; margin-top:2px; }
  .legend { font-size:12px; color:#666; margin-top:20px; line-height:1.7; }
  .legend code { background:#f0f0f0; padding:0 4px; border-radius:3px; }
</style></head><body>
<h1>天气图标对照</h1>
<div class="sub">底色是应用里天气卡片的米色 ${CARD}。每行图标的大小就是标出来的那个像素数。</div>
${rows.join('\n')}
<div class="legend">
  怎么看：<b>横着比</b>（同一行里雨 / 雪 / 雷能否一眼分开），<b>竖着比</b>（同一个图标在 16 / 20 / 34 下差多少）。<br>
  形状全部由 <code>${ICON_SRC}</code> 用代码画出，仓库里没有图片资源。
</div>
</body></html>`

mkdirSync(join(root, 'docs'), { recursive: true })
mkdirSync(join(root, '.cache'), { recursive: true })
writeFileSync(join(root, 'docs', 'weather-icons.html'), html, 'utf-8')
console.log(`对照页：docs/weather-icons.html${oldMod ? '（含改动前的对照）' : '（HEAD 里还没有这个文件，只画了当前版本）'}`)

/*
 * 截图。HTML 落到系统临时目录（避开路径里的空格），
 * 再用 cmd /c 等 Electron 跑完。
 */
const stage = join(tmpdir(), `sproutbook-icon-preview-${process.pid}`)
mkdirSync(stage, { recursive: true })
const stagedHtml = join(stage, 'icons.html')
writeFileSync(stagedHtml, html, 'utf-8')

const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const shotScript = join(stage, 'shot.cjs')
writeFileSync(
  shotScript,
  `const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const out = process.env.ICON_PREVIEW_OUT
const url = process.env.ICON_PREVIEW_URL
setTimeout(() => { console.error('[icon-preview] 超时'); app.exit(2) }, 20000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 900, show: false })
  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 900))
  // 按内容实际高度收窗口，否则底部会留一大片白
  const h = await win.webContents.executeJavaScript('document.body.scrollHeight')
  const w = await win.webContents.executeJavaScript('document.body.scrollWidth')
  win.setContentSize(Math.ceil(w), Math.ceil(h))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  const png = img.toPNG()
  if (!png || png.length === 0) { console.error('[icon-preview] 截图为空'); app.exit(1); return }
  writeFileSync(out, png)
  console.log('[icon-preview] ' + img.getSize().width + 'x' + img.getSize().height + ' -> ' + out)
  app.exit(0)
})
`,
  'utf-8'
)

const outPng = join(root, '.cache', 'weather-icons.png')
const env = { ...process.env, ICON_PREVIEW_OUT: outPng, ICON_PREVIEW_URL: pathToFileURL(stagedHtml).href }
delete env.ELECTRON_RUN_AS_NODE

/*
 * 走 cmd /c 是为了**等 Electron 退出**（GUI 子系统程序，直接 spawn 不会等）。
 * 参数不自己加引号 —— Node 会替含空格的参数转义，手写一层会变成双重引号。
 */
const r = spawnSync('cmd', ['/c', electron, '--force-device-scale-factor=2', shotScript], {
  cwd: root,
  stdio: 'inherit',
  env
})
if (r.status !== 0) {
  console.error(`截图失败（退出码 ${r.status ?? 'null'}）—— 对照页已经写出，可以直接用浏览器打开看`)
  process.exit(1)
}
