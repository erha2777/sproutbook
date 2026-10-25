/**
 * 顶部状态条（和四个 tab 同一行，靠右）。
 *
 * 只显示三件事：今天几号星期几、今天天气、还有几件待办。
 * 数据来源都是现成的：
 *  - 日期：本地时间
 *  - 天气：`weather:assess`（主进程有缓存，短时间重复调不会真的发请求）
 *  - 待办数：App 里已经在维护的 `carePending`（就是「养护」tab 上那个角标）
 *
 * 三块都可以点，点了跳到对应页面 —— 让这条不只是装饰。
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { WeatherKind, WeatherWarningResult } from '../../../shared/api'

const KIND_LABEL: Record<WeatherKind, string> = {
  clear: '晴',
  cloudy: '多云',
  overcast: '阴',
  rain: '雨',
  snow: '雪',
  storm: '雷雨',
  fog: '雾'
}

const KIND_ICON: Record<WeatherKind, string> = {
  clear: '☀️',
  cloudy: '⛅',
  overcast: '☁️',
  rain: '🌧️',
  snow: '❄️',
  storm: '⛈️',
  fog: '🌫️'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地日期 → `2026-10-19 · 周日` */
function todayLabel(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${WEEKDAYS[d.getDay()] ?? ''}`
}

export function TopHud({
  pending,
  onGoWeather,
  onGoToday,
  className
}: {
  pending: number
  onGoWeather: () => void
  /** 点「今日待办」= 去今日页（那里才是今天要做的事） */
  onGoToday: () => void
  /** 非养护页用 `top-hud-float` 浮在右上角 */
  className?: string
}): ReactNode {
  const [weather, setWeather] = useState<WeatherWarningResult | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.weather
        // force=false：主进程有当日缓存，这里只读，不会额外消耗配额
        .assess(false)
        .then((r) => {
          if (alive) setWeather(r)
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 10 * 60 * 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const place = weather?.places[0] ?? null
  const today = place?.days[0] ?? null
  const kind = place?.hours[0]?.kind ?? null
  const weatherText =
    place && today
      ? `${kind ? (KIND_ICON[kind] ?? '') + ' ' + (KIND_LABEL[kind] ?? '') : '天气'} ${today.tempMin}~${today.tempMax}°`
      : null

  return (
    <div className={className ? `top-hud ${className}` : 'top-hud'}>
      <span className="top-hud-date">{todayLabel()}</span>
      {weatherText ? (
        <button type="button" className="top-hud-item" onClick={onGoWeather} title="看今天的天气">
          {weatherText}
        </button>
      ) : null}
      <button
        type="button"
        className="top-hud-item"
        onClick={onGoToday}
        title={pending > 0 ? `今天还有 ${pending} 件待办，点开看今天要做什么` : '今天没有待办'}
      >
        今日待办 <b className="top-hud-badge">{pending}</b>
      </button>
    </div>
  )
}
