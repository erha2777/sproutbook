/**
 * 设置页的「提醒与启动」。
 *
 * 三件事：
 *  1. 每天到点提醒今天有什么要做（系统通知，点开直达「今日」）
 *  2. 关窗口后留在托盘（否则应用一关就再也提醒不到）
 *  3. 开机自启（可选）
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ReminderPrefs } from '@shared/api'
import { Button, Checkbox, Notice, Spinner, TextInput, useToast } from './ui'

const EMPTY: ReminderPrefs = { enabled: true, time: '09:00', tray: true, autoLaunch: false }

export function ReminderSettings(): ReactNode {
  const toast = useToast()
  const [prefs, setPrefs] = useState<ReminderPrefs | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.app
      .reminderPrefs()
      .then(setPrefs)
      .catch(() => setPrefs(EMPTY))
  }, [])

  const patch = async (next: Partial<ReminderPrefs>): Promise<void> => {
    if (!prefs) return
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    setSaving(true)
    try {
      setPrefs(await window.api.app.setReminderPrefs(next))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
      setPrefs(prefs)
    } finally {
      setSaving(false)
    }
  }

  if (!prefs) return <Spinner label="读取设置…" />

  return (
    <div className="content-inner">
      <Checkbox
        checked={prefs.enabled}
        onChange={(v) => void patch({ enabled: v })}
        label="每天提醒我到期的养护任务（应用运行时生效）"
      />

      <div className="row tight" style={{ alignItems: 'center' }}>
        <span className="small muted">提醒时间</span>
        <div style={{ width: 110 }}>
          <TextInput
            value={prefs.time}
            onChange={(v) => {
              // 只接受 HH:mm，边输边存会把半截值写进设置
              if (/^\d{1,2}:\d{2}$/.test(v)) void patch({ time: v })
              else setPrefs({ ...prefs, time: v })
            }}
            placeholder="09:00"
          />
        </div>
        <span className="small muted">到点才弹；早于这个时间不会打扰</span>
      </div>

      <Checkbox
        checked={prefs.tray}
        onChange={(v) => void patch({ tray: v })}
        label="关闭窗口时留在托盘（这样关掉后仍会提醒）"
      />
      <Checkbox
        checked={prefs.autoLaunch}
        onChange={(v) => void patch({ autoLaunch: v })}
        label="开机时自动启动"
      />

      <div className="row tight" style={{ alignItems: 'center' }}>
        <Button
          size="small"
          disabled={saving}
          onClick={() => {
            void window.api.app
              .testReminder()
              .then((r) => {
                if (r.result === 'sent') {
                  toast.push(
                    `已发送测试通知（今天 ${r.count} 件待办）—— 没看到就去系统通知中心看看是否被拦截`,
                    'success'
                  )
                } else if (r.result === 'dev') {
                  toast.push('开发预览里不弹系统通知；打包版（桌面快捷方式启动）才有', 'error')
                } else {
                  toast.push('系统不支持通知', 'error')
                }
              })
              .catch((error) => toast.push(error instanceof Error ? error.message : '发送失败', 'error'))
          }}
        >
          发一条测试通知
        </Button>
        <span className="small muted">Windows 的「专注助手 / 通知权限」会把通知拦掉，用它确认</span>
      </div>

      <Notice tone="info">
        提醒只在应用运行时发。想让关掉窗口后也能收到，请把上面的「关闭窗口时留在托盘」打开 ——
        应用会在托盘里待命，到点照样提醒。
        <br />
        免安装版的系统通知<b>点它不一定能跳转</b>（Windows 便携应用的激活限制）。
        平时要进来，点<b>托盘图标</b>，或首页那条「今天还有 N 件养护要做」的横幅即可。
      </Notice>
    </div>
  )
}
