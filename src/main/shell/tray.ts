/**
 * 托盘图标与菜单。
 *
 * 单独一个模块是为了让 IPC 那一层能直接开关托盘（设置里切换"关闭窗口时留在托盘"），
 * 而不用反过来 import 主入口、制造循环依赖。
 */

import { app, Menu, Tray } from 'electron'
import type { NativeImage } from 'electron'

let tray: Tray | null = null
let icon: NativeImage | null = null
let hooks: { onOpen: () => void; getPending: () => number } | null = null

export function initTray(options: {
  icon: NativeImage | null
  onOpen: () => void
  getPending: () => number
}): void {
  icon = options.icon
  hooks = { onOpen: options.onOpen, getPending: options.getPending }
}

function buildMenu(): Menu {
  const pending = hooks?.getPending() ?? 0
  return Menu.buildFromTemplate([
    { label: pending > 0 ? `今日待办 ${pending} 件` : '今天没有待办', enabled: false },
    { type: 'separator' },
    { label: '打开 Sproutbook', click: () => hooks?.onOpen() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

/** 菜单里的待办数要跟着变：任务打勾之后托盘菜单不该还挂着旧数字 */
export function refreshTrayMenu(): void {
  if (tray) tray.setContextMenu(buildMenu())
}

export function setTrayVisible(visible: boolean): void {
  if (visible) {
    if (tray) return
    // 没有图标时别硬建：Windows 上会得到一个空白托盘格
    const image = icon && !icon.isEmpty() ? icon.resize({ width: 16, height: 16 }) : null
    if (!image) return
    tray = new Tray(image)
    tray.setToolTip('Sproutbook')
    tray.setContextMenu(buildMenu())
    tray.on('click', () => hooks?.onOpen())
    return
  }
  tray?.destroy()
  tray = null
}

export function isTrayVisible(): boolean {
  return tray !== null
}

/** 主入口拿到窗口图标后交过来，托盘和窗口用同一张 */
export function rememberTrayIcon(image: NativeImage | null): void {
  icon = image
}

export function getTrayIcon(): NativeImage | null {
  return icon
}

export function trayIconAvailable(): boolean {
  return Boolean(icon && !icon.isEmpty())
}
