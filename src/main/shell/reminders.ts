/**
 * 每天一次的到期提醒。
 *
 * 为什么必须做：任务是"到日子才想起来"的东西，可应用不打开就什么都看不到 ——
 * 这是整个应用里唯一"不做就一直漏事"的缺口。
 *
 * 策略刻意保守：
 *  - 一天最多一条（`remind.last` 记日期）
 *  - 只在设定时间之后弹（默认 09:00；应用晚开就在第一次检查时补上）
 *  - 没有待办就不弹，也不写 last（免得"今天已经提醒过了"把真正的提醒吞掉）
 */

import { Notification, app } from 'electron'
import type { NativeImage } from 'electron'
import type { Db } from '../db/connection'
import { getSetting, setSetting } from '../db/repo/misc'
import {
  buildReminderText,
  readReminderSettings,
  shouldRemind,
  summarizePending
} from '../services/reminders'

/** 5 分钟看一次：够及时，又不至于让主进程一直忙 */
const CHECK_INTERVAL = 5 * 60 * 1000
/** 启动后等一会儿再弹：别和窗口出现、皮肤加载抢时间 */
const FIRST_CHECK_DELAY = 8000

let timer: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let icon: NativeImage | null = null

/**
 * 弹一条通知；点它就把窗口叫出来并跳到「今日」。
 *
 * **开发预览里不弹**：未打包时 Windows 没有注册 AppUserModelID / 开始菜单快捷方式，
 * 点击通知会去启动一个"裸的 electron.exe"（没有 app 路径）—— 用户看到的是一张
 * Electron 欢迎页，而不是 Sproutbook。打包版有正常的 exe 与快捷方式，点击会走
 * 单实例逻辑把已有窗口提到前台。
 */
export function showPendingNotification(db: Db, options: { onOpen: () => void; force?: boolean }): boolean {
  const summary = summarizePending(db)
  if (!options.force && summary.total === 0) return false
  const text = options.force && summary.total === 0
    ? { title: '提醒测试', body: '系统通知是通的。到日子会在这里提醒你今天该做什么。' }
    : buildReminderText(summary)

  if (!app.isPackaged) {
    console.log('[reminders] 开发预览不弹系统通知（打包版才有）：', text.title, text.body.replace(/\n/g, ' '))
    return false
  }
  if (!Notification.isSupported()) return false
  const note = new Notification({
    title: text.title,
    body: text.body,
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    silent: false
  })
  note.on('click', () => options.onOpen())
  note.show()
  return true
}

/** 到点就提醒。返回是否真的弹了（测试 / 自检用） */
export function checkAndRemind(db: Db, onOpen: () => void, now: Date = new Date()): boolean {
  const settings = readReminderSettings(<T,>(key: string, fallback: T): T =>
    getSetting<T>(db, key, fallback)
  )
  const summary = summarizePending(db)
  if (!shouldRemind(settings, summary, now)) return false
  const shown = showPendingNotification(db, { onOpen })
  if (shown) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    setSetting(db, 'remind.last', today)
  }
  return shown
}

export function startReminderLoop(options: {
  db: Db
  icon: NativeImage | null
  onOpen: () => void
  /** 每次检查完回调一次（刷新托盘菜单上的待办数） */
  onChecked?: () => void
}): void {
  icon = options.icon
  stopReminderLoop()

  /*
   * **不设自定义 AppUserModelID。**
   *
   * 设了以后任务栏会按这个 ID 去找「已安装的应用身份 + 图标」；
   * 免安装版（win-unpacked）没有对应注册项，于是退回 Electron 的默认原子图标。
   * 用默认身份时任务栏直接取 exe 的图标 —— 就是我们要的植物图标。
   */

  const tick = (): void => {
    try {
      checkAndRemind(options.db, options.onOpen)
      options.onChecked?.()
    } catch (error) {
      // 提醒失败不该影响应用本身
      console.error('[reminders] 检查提醒时出错:', error)
    }
  }
  firstTimer = setTimeout(tick, FIRST_CHECK_DELAY)
  timer = setInterval(tick, CHECK_INTERVAL)
}

export function stopReminderLoop(): void {
  if (firstTimer) clearTimeout(firstTimer)
  if (timer) clearInterval(timer)
  firstTimer = null
  timer = null
}
