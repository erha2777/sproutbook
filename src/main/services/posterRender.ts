/**
 * 把海报 HTML 渲染成 PNG。
 *
 * 为什么要开一个隐藏窗口：排版（换行、省略、弹性布局）交给 Chromium 最省事，
 * 手写 canvas 坐标既难调、又要自己处理字体度量。窗口 `show: false` 但
 * `paintWhenInitiallyHidden` 默认 true，所以 capturePage 能拿到完整画面。
 *
 * 用临时文件而不是 data: URL：海报里要内联几张 base64 照片，几 MB 的
 * data URL 在 `loadURL` 上不可靠；临时文件没有长度上限，用完就删。
 */

import { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RenderOptions {
  width: number
  height: number
  /** 等图片解码 + 布局稳定的额外等待（毫秒） */
  settleMs?: number
}

export async function renderHtmlToPng(html: string, options: RenderOptions): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'sproutbook-poster-'))
  const file = join(dir, 'poster.html')
  writeFileSync(file, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: options.width,
    height: options.height,
    useContentSize: true,
    frame: false,
    backgroundColor: '#f7e7c6',
    webPreferences: {
      backgroundThrottling: false,
      // 海报是自己拼的静态 HTML，不需要 node / preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    await win.loadFile(file)

    // 等所有图片解码完：照片是 base64 内联的，不等它们会截到空白框
    await win.webContents
      .executeJavaScript(
        `Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)`
      )
      .catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 220))

    /*
     * 截图尺寸用**实测视口**，不用传入的 1080×1440。
     *
     * Windows 会把窗口高度钳在工作区以内（实测请求 1440 只拿到 1392），
     * 海报是 100vh 铺满的，按传入尺寸截会多出/裁掉一条边。
     */
    const size = (await win.webContents.executeJavaScript(
      '({ width: Math.round(document.documentElement.clientWidth), height: Math.round(document.documentElement.clientHeight) })'
    )) as { width: number; height: number }

    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: Math.min(size.width || options.width, options.width),
      height: Math.min(size.height || options.height, options.height)
    })
    return image.toPNG()
  } finally {
    win.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
