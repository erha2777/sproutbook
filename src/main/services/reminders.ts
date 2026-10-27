/**
 * 到期提醒：今天有多少事要做，值不值得弹一条系统通知。
 *
 * 纯计算放这里（可被自检覆盖）；真正弹通知、建托盘、点开窗口留给主进程入口，
 * 免得这层依赖 Electron API。
 */

import type { Db } from '../db/connection'
import { listCareTasks } from '../db/repo/care'
import { pendingBuckets, todayIso } from '../../core/care'

export interface ReminderSettings {
  /** 每天提醒开不开 */
  enabled: boolean
  /** 提醒时间 HH:mm（当天过了这个点才弹，免得凌晨打断） */
  time: string
  /** 上次弹过的日期（YYYY-MM-DD）；同一天只弹一次 */
  last: string | null
}

export interface PendingSummary {
  /** 已过期条数 */
  overdue: number
  /** 今天该做条数 */
  due: number
  /** 两者之和（就是界面角标那个数） */
  total: number
  /** 头几条标题，写进通知正文 */
  titles: string[]
}

const DEFAULT_TIME = '09:00'

export interface ReminderPrefs {
  enabled: boolean
  time: string
  /** 关闭窗口时留在托盘 */
  tray: boolean
  /** 开机自启 */
  autoLaunch: boolean
}

export function readPrefs(get: <T>(key: string, fallback: T) => T): ReminderPrefs {
  return {
    enabled: get<boolean>('remind.enabled', true),
    time: readReminderSettings(get).time,
    tray: get<boolean>('tray.enabled', true),
    autoLaunch: get<boolean>('app.autoLaunch', false)
  }
}

export function readReminderSettings(
  get: <T>(key: string, fallback: T) => T
): ReminderSettings {
  const time = get<string>('remind.time', DEFAULT_TIME)
  return {
    enabled: get<boolean>('remind.enabled', true),
    time: /^\d{1,2}:\d{2}$/.test(time) ? time : DEFAULT_TIME,
    last: get<string | null>('remind.last', null)
  }
}

/** 和界面角标同一个口径：全部未完成任务 → 已过期 + 该做 */
export function summarizePending(db: Db, today = todayIso()): PendingSummary {
  const open = listCareTasks(db, { status: 'open' })
  const buckets = pendingBuckets(open, today)
  const rows = [...buckets.overdue, ...buckets.due]
  return {
    overdue: buckets.overdue.length,
    due: buckets.due.length,
    total: rows.length,
    titles: rows.slice(0, 3).map((t) => t.title)
  }
}

/**
 * 现在该弹吗。
 *
 * 四个条件缺一不可：开着、今天没弹过、有活要干、已经过了设定的时间。
 * 「过了时间才弹」是有意的 —— 早上 9 点前弹「今天该浇水」，人还没起床去浇水；
 * 而应用如果 9 点之后才打开，第一次检查就会补上这条提醒。
 */
export function shouldRemind(
  settings: ReminderSettings,
  summary: PendingSummary,
  now: Date = new Date()
): boolean {
  if (!settings.enabled) return false
  if (summary.total === 0) return false
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (settings.last === today) return false
  const [h, m] = settings.time.split(':').map(Number)
  const minutesNow = now.getHours() * 60 + now.getMinutes()
  return minutesNow >= (h || 0) * 60 + (m || 0)
}

export function buildReminderText(summary: PendingSummary): { title: string; body: string } {
  const head =
    summary.overdue > 0 ? `今天有 ${summary.total} 件事（${summary.overdue} 件已过期）` : `今天有 ${summary.total} 件事要做`
  const list = summary.titles.join('、')
  return {
    title: head,
    body: list ? `${list}${summary.total > summary.titles.length ? '…' : ''}\n点开看看` : '点开看看'
  }
}
