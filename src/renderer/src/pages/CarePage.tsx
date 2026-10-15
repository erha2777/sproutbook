/**
 * 养护计划页。
 *
 * 信息组织上做了一个选择：**先按紧急度，再按月份**。
 * 纯粹的月历很好看，但「上个月忘做的事」会被翻页翻掉——
 * 而那恰恰是最需要被提醒的。所以逾期任务永远置顶，
 * 月份只用来筛选「这个月原本要做什么」。
 */

import { WeatherIcon } from '../components/WeatherIcon'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareLog, CareTask, Material, RecipeListItem } from '@core/types'
import type { CareOverview, CareTaskListItem, WeatherRiskItem, WeatherWarningResult } from '@shared/api'
import { adviseToday, WEATHER_KIND_LABELS, suggestTask, SEVERITY_LABELS } from '@core/weather'
import {
  CARE_ACTION_ICONS,
  CARE_ACTION_LABELS,
  CARE_ACTION_OPTIONS,
  CARE_URGENCY_LABELS,
  dueDescription,
  summarizeTasks,
  todayIso,
  urgencyOf
} from '@core/care'
import type { CareUrgency } from '@core/care'
import { Badge, Button, EmptyState, Modal, Notice, Panel, SectionTitle, SelectInput, Spinner, TextInput, useToast } from '../components/ui'
import { CareTaskDialog } from '../components/CareTaskDialog'
import type { PlantOption } from '../components/CareTaskDialog'
import { CareRuleManager } from '../components/CareRuleManager'
import { CareCalendar } from '../components/CareCalendar'

/**
 * 天气预警面板。
 *
 * 四种状态各有各的话要说，尤其是「没配置」那一种 ——
 * 用户需要知道**不填城市就不会联网**，而不是以为功能坏了。
 *
 * 定义在模块层而不是 CarePage 内部：组件内定义会让每次渲染产生新的函数标识，
 * React 视为换了类型就整个重挂子树（之前笔记输入框打不进字就是这个原因）。
 */
/**
 * 天气任务的身份：同一株 + 同一天 + 同一个标题就算同一条。
 *
 * 抽成模块层函数是为了让**建之前的查重**和**按钮的禁用态**
 * 用同一个定义 —— 两处各写一遍迟早会漂移，然后就是「按钮说已加入、
 * 点了却又建一条」这种自相矛盾。
 */
/** 四个统计筛选的标题。列表面板和空态提示共用，免得两处各写一份。 */
const STAT_FILTER_TITLES: Record<'overdue' | 'due' | 'done' | 'open', string> = {
  overdue: '已过期',
  due: '该做了',
  done: '已完成',
  open: '未完成'
}

function weatherTaskKey(plantId: number, date: string, title: string): string {
  return `${plantId}|${date}|${title}`
}

/**
 * 'YYYY-MM-DD' → 周四。
 *
 * 用 Date.UTC 解析：new Date('2026-10-15') 会按 UTC 解释，
 * 在东八区取出 getDay() 会差一天 —— 星期几错一天比不显示更糟。
 */
function weekdayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()] ?? ''
}

function WeatherPanel({
  result,
  addedKeys,
  busy,
  onRefresh,
  onCreateTask
}: {
  result: WeatherWarningResult | null
  /** 已经加进计划的任务身份，用来把按钮变成禁用态 */
  addedKeys: Set<string>
  busy: boolean
  onRefresh: () => void
  onCreateTask: (risk: WeatherRiskItem) => void | Promise<void>
}): ReactNode {
  /*
   * **hook 必须放在早退之前。**
   *
   * 下面几行是 `if (busy && !result) return ...` —— 在那之后再 useState
   * 就是「条件 hook」，React 会直接报错。我第一版打算把它放在
   * `const risks = ...` 旁边，那是个会崩的位置。
   */
  const [showFuture, setShowFuture] = useState(false)

  if (busy && !result) return <div className="small muted">正在查看天气…</div>
  if (!result) return <div className="small muted">暂时拿不到天气数据。</div>

  if (!result.configured) {
    return (
      <div className="small muted">
        还没有养护位置填过城市，所以<b>没有联网</b>。
        到「设置 → 养护位置」给露天的位置填上城市（比如「某市」），
        这里就会按那儿的实际天气提醒你防冻、防暑。
        <div style={{ marginTop: 4 }}>
          判断依据是每个物种的「耐寒 / 耐热」温度，以及这个位置能不能防冻、能不能加温。
        </div>
      </div>
    )
  }

  const risks = result.risks

  /*
   * **风险按当天 / 未来分组。**
   *
   * 面板聚焦当天，所以这里只留今天的提醒；未来几天的收进「未来天气」弹窗 ——
   * 但**不藏起来**：按钮上会标明还有几条，否则用户会以为没有别的提醒了。
   */
  const todayIso = result.places[0]?.hours[0]?.time.slice(0, 10) ?? null
  const todayRisks = todayIso ? risks.filter((r) => r.date === todayIso) : risks
  const futureRisks = todayIso ? risks.filter((r) => r.date !== todayIso) : []

  /**
   * 当天建议。**只看今天，和温度阈值无关** ——
   * 那是风险提示的事（「这株能不能扛住」），这条讲的是「今天该做什么」。
   */
  const advice = adviseToday(result.places[0]?.hours ?? [], result.places[0]?.days?.[0] ?? null)

  return (
    <div>
      {result.error ? <div className="small muted">⚠ {result.error}（下面可能是缓存的数据）</div> : null}

      {/*
        当天 + 未来 24 小时，放在最上面。

        原来的面板上来就是「31℃ 超出 1℃」这种**结论**，用户反而不知道
        今天什么天气 —— 有人拿和风页面来问「为什么温度不一样」，
        其实是因为那边大字写的是**此刻**（20°），而这里只有**后天**的最高温。

        **先摆原貌，再讲判断。**
      */}
      {result.places.map((place) => {
        const hours = place.hours ?? []
        if (hours.length === 0) return null
        /*
         * 当前这一小时：取第一个不早于现在的；都早于现在就退回第一个。
         * 不做时区换算 —— 数据源已经按 timezone=auto 给了本地时间。
         */
        const nowKey = new Date().toISOString().slice(0, 13)
        const at = hours.findIndex((h) => h.time.slice(0, 13) >= nowKey)
        const cur = hours[at < 0 ? 0 : at]
        const todayIso = cur.time.slice(0, 10)
        const today = (place.days ?? []).find((d) => d.date === todayIso)

        return (
          <div className="weather-today" key={`today-${place.name}-${place.latitude}`}>
            <div className="weather-today-main">
              <span className="weather-today-icon">
                <WeatherIcon kind={cur.kind} size={34} />
              </span>
              <span className="weather-today-temp">{Math.round(cur.temp)}°</span>
              <div>
                <div className="weather-today-kind">
                  {cur.kind ? WEATHER_KIND_LABELS[cur.kind as keyof typeof WEATHER_KIND_LABELS] : '天气未知'}
                  {cur.pop !== null && cur.pop >= 20 ? `　降水 ${cur.pop}%` : ''}
                </div>
                <div className="small muted">
                  {place.label || place.name}
                  {today ? `　今天 ${Math.round(today.tempMin)}° ~ ${Math.round(today.tempMax)}°` : ''}
                </div>
                {/*
                  当天建议。**这是行动，不是判断** ——
                  风险提示算的是「这株能不能扛住」，天然指向未来某一天；
                  而「今天要不要收盆、要不要避开正午浇水」是关于今天的。
                */}
                {advice ? (
                  <div className={`weather-advice tone-${advice.tone}`}>
                    <b>{advice.title}</b> —— {advice.detail}
                  </div>
                ) : null}
              </div>
            </div>

            {/* 未来 24 小时。横排放不下就横向滚动，不折行 */}
            <div className="weather-hours">
              {hours.slice(0, 24).map((h) => (
                <div className="weather-hour" key={h.time}>
                  <span className="weather-hour-time">{h.time.slice(11, 16)}</span>
                  <span className="weather-hour-icon">
                    {/* 20 而不是 16 —— 格宽本来就有 40px，16 时雨雪的差别被压没了 */}
                    <WeatherIcon kind={h.kind} size={20} />
                  </span>
                  <span className="weather-hour-temp">{Math.round(h.temp)}°</span>
                  <span className="weather-hour-pop">{h.pop !== null && h.pop >= 20 ? `${h.pop}%` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/*
        未来几天的天气。

        **这些数据一直都在。** fetchDaily 取回 7 天的 date/tempMin/tempMax，
        却只拿去做风险判断，画面上一个字都不露 —— 于是用户看到的只有
        「超出 1℃」这种结论，反而不知道这几天到底什么天气。

        有人拿和风页面来问「为什么温度不一样」：其实一模一样，
        只是那边大字写的是**此刻**（20°），而这里只有一个**后天**的最高温（31℃）。
        两个不同的东西放在一起比，当然像对不上。

        所以先把原貌摆出来，再讲判断。

        **未来天气挪进弹窗** —— 面板聚焦当天。
        但按钮上标明还有几条提醒：**不能把未来的信息藏起来让人以为没有了。**
      */}
      <div className="row tight" style={{ marginTop: 6 }}>
        <Button size="small" onClick={() => setShowFuture(true)}>
          未来天气{futureRisks.length > 0 ? `（另有 ${futureRisks.length} 条提醒）` : ''}
        </Button>
      </div>

      {showFuture ? (
        <Modal title="未来天气" onClose={() => setShowFuture(false)}>
          <div className="content-inner">
            {futureRisks.length > 0 ? (
              <div className="weather-risks" style={{ marginBottom: 10 }}>
                {futureRisks.map((r) => (
                  <div key={`${r.kind}-${r.plantId}-${r.date}`} className={`weather-risk sev-${r.severity}`}>
                    <div className="weather-risk-head">
                      <span className={`weather-badge sev-${r.severity}`}>
                        {r.kind === 'frost' ? '❄' : '☀'} {SEVERITY_LABELS[r.severity]}
                      </span>
                      <b>{r.plantName}</b>
                      <span className="muted small">{r.date}</span>
                      <span style={{ flex: 1 }} />
                      {addedKeys.has(
                        weatherTaskKey(r.plantId, r.date, `${r.kind === 'frost' ? '防冻' : '防暑'}：${r.plantName}`)
                      ) ? (
                        <span className="small muted">✓ 已在养护计划里</span>
                      ) : (
                        <Button size="small" onClick={() => void onCreateTask(r)}>
                          加进养护计划
                        </Button>
                      )}
                    </div>
                    <div className="small">{r.message}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="small muted" style={{ marginBottom: 10 }}>
                未来几天没有超出任何植株承受范围的天气。
              </div>
            )}

            {result.places.length > 0 ? (
              <div className="weather-days">
          {result.places.map((place) => {
            /*
             * 温度条的刻度要**跨所有天共用**，否则每天的条一样长，
             * 看不出哪天更冷 —— 那就白画了。
             */
            const all = (place.days ?? []).flatMap((d) => [d.tempMin, d.tempMax])
            const lo = Math.min(...all)
            const hi = Math.max(...all)
            const span = hi - lo || 1
            const pct = (v: number): number => ((v - lo) / span) * 100

            return (
              <div key={`${place.name}-${place.latitude}`} style={{ marginBottom: 8 }}>
                <div className="small muted" style={{ marginBottom: 3 }}>
                  {place.label || place.name}
                  {place.provider === 'qweather' ? ' · 和风天气' : ' · Open-Meteo'}
                </div>
                <div className="weather-day-list">
                  {(place.days ?? []).map((d) => {
                    // 这一天的风险（可能不止一株）
                    const hits = result.risks.filter((r) => r.date === d.date)
                    return (
                      <div className="weather-day" key={d.date}>
                        <span className="weather-day-date">{d.date.slice(5)}</span>
                        <span className="weather-day-week">{weekdayLabel(d.date)}</span>
                        <span className="weather-day-temp">{Math.round(d.tempMin)}°</span>
                        <span className="weather-day-bar">
                          <span
                            className="weather-day-fill"
                            style={{
                              left: `${pct(d.tempMin)}%`,
                              width: `${Math.max(pct(d.tempMax) - pct(d.tempMin), 2)}%`
                            }}
                          />
                        </span>
                        <span className="weather-day-temp">{Math.round(d.tempMax)}°</span>
                        <span className="weather-day-risk">
                          {hits.length > 0 ? (
                            <span className={`weather-badge sev-${hits[0].severity}`}>
                              {hits[0].kind === 'frost' ? '❄' : '☀'} {hits.map((h) => h.plantName).join('、')}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {todayRisks.length === 0 && futureRisks.length === 0 ? (
        <div className="small muted">
          未来几天{result.places.length > 0 ? `（${result.places.map((p) => p.label || p.name).join('、')}）` : ''}
          没有超出任何植株的承受范围。
        </div>
      ) : (
        <div className="weather-risks">
          {todayRisks.map((r) => {
            const added = addedKeys.has(
              weatherTaskKey(r.plantId, r.date, `${r.kind === 'frost' ? '防冻' : '防暑'}：${r.plantName}`)
            )
            return (
            <div key={`${r.kind}-${r.plantId}`} className={`weather-risk sev-${r.severity}`}>
              <div className="weather-risk-head">
                <span className={`weather-badge sev-${r.severity}`}>
                  {r.kind === 'frost' ? '❄' : '☀'} {SEVERITY_LABELS[r.severity]}
                </span>
                <b>{r.plantName}</b>
                <span className="muted small">{r.date}</span>
                <span style={{ flex: 1 }} />
                {added ? (
                  <span className="small muted">✓ 已在养护计划里</span>
                ) : (
                  <Button size="small" onClick={() => void onCreateTask(r)}>
                    加进养护计划
                  </Button>
                )}
              </div>
              <div className="small">{r.message}</div>
            </div>
            )
          })}
        </div>
      )}

      {result.unknownCold.length > 0 ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          另有 {result.unknownCold.length} 株的物种没填「耐寒」温度，判断不了：
          {result.unknownCold.join('、')}
        </div>
      ) : null}

      {/*
        把实际用的坐标摆出来。用户反馈过「位置不够精准」——
        与其解释预报有多粗，不如让他看见取的是哪个点，
        再决定要不要到「设置 → 养护位置」填精确经纬度。
      */}
      {result.places.length > 0 ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          预报点：
          {result.places
            .map(
              (p) =>
                `${p.label || p.name}（${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}）` +
                `${p.level === 'district' ? ' · 已到区县' : ' · 只到市'}`
            )
            .join('、')}
          <br />
          {/*
            精度那句话要跟着实际情况走。
            早期版本写死了「城市尺度」，可配了和风之后地名是能到区县的 ——
            写死的话就成了另一句不实的话。
          */}
          {result.places.some((p) => p.level === 'district')
            ? '位置已精确到你填的区县。天气本身仍是网格预报，和你家院子可能还有几度出入。'
            : '这是网格预报，城市尺度，和你家院子可能有几度出入。到「设置 → 养护位置」填区县（或直接填经纬度）会更准。'}
        </div>
      ) : null}

      <div className="row tight" style={{ marginTop: 8 }}>
        <Button size="small" onClick={onRefresh} disabled={busy}>
          {busy ? '刷新中…' : '重新获取'}
        </Button>
        {/*
          这里**不能写死，也不能从配置推导** ——
          和风失败时会静默退回 Open-Meteo，providerLabel 要用实际来源。
        */}
        <span className="small muted">
          {result.providerLabel ? `数据来自 ${result.providerLabel}` : '天气数据'}，只在打开这一页时请求一次
          {result.requestsToday > 0 ? `　·　今天已请求 ${result.requestsToday} 次` : ''}
        </span>
      </div>
      {/*
        换源了就要说出来。
        不然用户看到「数据来自和风天气 · 已到区县」，会拿它去信一份其实是
        Open-Meteo 市级网格的预报 —— 而设置页恰好教人「填经纬度会更准」，
        正好触发这条假来源。
      */}
      {result.fallbackReason ? (
        <div className="small" style={{ marginTop: 4, color: '#8a6a3a' }}>
          ⚠ 和风天气这次没用上（{result.fallbackReason}），这份预报实际来自 {result.providerLabel}，精度按市级算。
        </div>
      ) : null}
    </div>
  )
}

/**
 * 任务卡片上显示绑定的配方。
 *
 * **定义在模块层，不是组件内部。** 组件内定义会让每次渲染都产生一个新的
 * 函数标识，React 认为子树换了类型就整个重挂载 —— 之前笔记输入框打不进字
 * 就是这个原因。这个组件目前只是静态展示，但同样的坑不该再踩第二次。
 */
function TaskRecipe({
  recipeId,
  recipes,
  materials
}: {
  recipeId: number
  /**
   * 配方列表。**null 表示没取到**，和「取到了但是空的」不是一回事 ——
   * 混为一谈的话，一次加载失败会让每张任务卡都断言「配方已删除」，
   * 用户就会去重建一份其实还在的配方。
   */
  recipes: RecipeListItem[] | null
  materials: Material[] | null
}): ReactNode {
  if (recipes === null) {
    return <div className="small muted">📋 配方未能读取（列表加载失败，配方本身可能还在）</div>
  }
  const rec = recipes.find((r) => r.id === recipeId)
  if (!rec) return <div className="small muted">📋 配方已删除</div>
  const parts = rec.items.map((it) => {
    const label = it.name ?? materials?.find((m) => m.id === it.materialId)?.name ?? '材料'
    return it.ratioPart && it.ratioPart !== 1 ? `${label} ${it.ratioPart} 份` : label
  })
  return (
    <div className="task-recipe">
      <span className="task-recipe-name">📋 {rec.name}</span>
      {parts.length > 0 ? <span className="muted"> {parts.join(' · ')}</span> : null}
    </div>
  )
}
const URGENCY_TONE: Record<CareUrgency, 'safety' | 'warn' | 'info' | 'muted' | 'ok'> = {
  overdue: 'safety',
  due: 'warn',
  soon: 'info',
  later: 'muted',
  closed: 'ok'
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const last = new Date(year, month, 0).getDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

export function CarePage({ onCareChanged }: { onCareChanged?: () => void }): ReactNode {
  const toast = useToast()
  const today = todayIso()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [plantFilter, setPlantFilter] = useState('')
  const [tab, setTab] = useState<'todo' | 'calendar' | 'logs'>('todo')
  const [tasks, setTasks] = useState<CareTaskListItem[]>([])
  const [overdue, setOverdue] = useState<CareTaskListItem[]>([])
  const [overview, setOverview] = useState<CareOverview | null>(null)
  const [logs, setLogs] = useState<CareLog[]>([])
  /** 手动记一笔：选了哪株、写了什么 */
  const [logPlantId, setLogPlantId] = useState('')
  const [logDraft, setLogDraft] = useState('')
  const [plants, setPlants] = useState<PlantOption[]>([])
  const [speciesNames, setSpeciesNames] = useState<string[]>([])
  /** 任务上要显示绑定的配方，所以把配方与材料一起取回来（都是几十条量级） */
  const [recipes, setRecipes] = useState<RecipeListItem[] | null>(null)
  const [materials, setMaterials] = useState<Material[] | null>(null)
  /**
   * 天气预警。
   *
   * 这是应用里唯一会往外发请求的功能，所以刻意做成**按需拉取**：
   * 只有打开养护计划页时才问一次，而且后端在没有养护位置填城市时
   * 会直接返回 configured:false —— 不填城市就是完全离线。
   */
  const [weather, setWeather] = useState<WeatherWarningResult | null>(null)
  const [weatherBusy, setWeatherBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<CareTask | 'new' | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [noteText, setNoteText] = useState('')
  /** 从月历点进来的任务：滚动并高亮一下，否则用户不知道跳到了哪里 */
  const [highlight, setHighlight] = useState<number | null>(null)
  /** 任务行 DOM，用来把高亮的那条滚进视野 */
  const taskRefs = useRef(new Map<number, HTMLDivElement>())
  /**
   * 统计数字的筛选。
   *
   * 这四个数字原来只是 Badge —— 点不动，用户没法从「逾期 0」走到对应的列表。
   * 现在点一下就地筛出那批任务。
   */
  const [statFilter, setStatFilter] = useState<'overdue' | 'due' | 'done' | 'open' | null>(null)
  /**
   * 清理计划。
   *
   * 生成计划是**按年**的，误点一下就排出整年 —— 用户不小心生成了下一年之后
   * 只能一条条删（135 条根本删不动）。所以给一个批量出口。
   *
   * 只删待办：已完成 / 已跳过是做过的记录，清理「计划」不该抹掉历史。
   */
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeYear, setPurgeYear] = useState(now.getFullYear())
  /** null = 整年；1~12 = 只看那个月 */
  const [purgeMonth, setPurgeMonth] = useState<number | null>(null)
  const [purgeTasks, setPurgeTasks] = useState<CareTaskListItem[]>([])
  const [purgeLoading, setPurgeLoading] = useState(false)
  const [purgeBusy, setPurgeBusy] = useState(false)
  /** 从月历空白日点「＋」新增任务时的预设日期 */
  const [draftDate, setDraftDate] = useState<string | undefined>(undefined)

  /** 正在看的是不是今天所在的月份。天气面板只在这时候显示 */
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  /**
   * 已经加进计划里的天气任务。
   *
   * 从任务列表**推导**而不是自己记一份状态：完成 / 删除 / 撤销之后
   * 列表会重新加载，这里跟着就对了，不会出现「任务删了按钮还写着已加入」。
   */
  const addedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const t of [...tasks, ...overdue]) {
      if (t.status === 'pending' && t.plantId !== null) set.add(weatherTaskKey(t.plantId, t.dueDate, t.title))
    }
    return set
  }, [tasks, overdue])

  /**
   * 取天气预警。
   *
   * 刻意放在 reload 之外：任务刷新频繁（完成一条就刷），
   * 天气没必要跟着刷 —— 后端有 3 小时缓存兜底，但连请求都不该发。
   */
  const loadWeather = useCallback(
    async (force = false) => {
      setWeatherBusy(true)
      try {
        setWeather(await window.api.weather.assess(force))
      } catch {
        // 天气取不到不该影响这个页面 —— 它是锦上添花，不是主线
        setWeather(null)
      } finally {
        setWeatherBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    void loadWeather(false)
  }, [loadWeather])

  /**
   * 把一条天气风险变成任务。
   *
   * **只在你点按钮时才写数据。** 预警本身永远不自动建任务 ——
   * 和 AI 草稿一样，它只提议，不替你做决定。
   */
  /**
   * 手动记一笔养护日志。
   *
   * care:log.add 这个通道一直存在、preload 也暴露了，**就是界面没接** ——
   * 而日志空态原本还写着「也可以随时手动记一笔」。
   * **邀请用户做一件做不到的事，比不说更糟。** 与其删那句话，不如把路接上。
   */
  const addManualLog = async (): Promise<void> => {
    const plantId = logPlantId ? Number(logPlantId) : null
    const content = logDraft.trim()
    if (plantId === null || !content) {
      toast.push('先选一株植物，再写一句做了什么', 'error')
      return
    }
    try {
      await window.api.care.addLog({ plantId, content })
      setLogDraft('')
      setLogs(await window.api.care.logs(logPlantId ? plantId : undefined, 100))
      toast.push('已记一笔', 'success')
    } catch (error) {
      toast.push(`记录失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const createTaskFromRisk = async (risk: WeatherRiskItem): Promise<void> => {
    /*
     * 文案从 core 拿，**不再在这里抄一份**。
     *
     * 这里原本有一份逐字副本，而且**已经漂移了**：
     * core 说「降温**前**当天浇透一次水」，副本少了「前」字。
     * 两处写同一件事、改了一处 —— 这轮审计在 suggestTask / buildSearchBlob /
     * LEVEL_LABELS / PROVIDER_LABELS 上抓到的是同一个毛病。
     *
     * 合成一份还有个附带好处：那些「该怎么做」的话现在被自检覆盖到了
     *（原来只有 core 版被自检引用，而线上跑的是没被覆盖的副本）。
     */
    const { title, detail } = suggestTask(risk)
    /*
     * 先查重。
     *
     * 第一版没有这一步：用户点了 4 次就建出 4 条一模一样的任务
     *（同植株、同日期、同标题）。按钮点下去没有任何反馈，
     * 用户自然会怀疑「到底加上没有」然后再点一次 —— 所以两件事都要做：
     * 这里挡住重复，界面上把已加入的状态显示出来。
     */
    const key = weatherTaskKey(risk.plantId, risk.date, title)
    if (addedKeys.has(key)) {
      toast.push('这条已经在养护计划里了', 'info')
      return
    }
    try {
      await window.api.care.createTask({
        plantId: risk.plantId,
        actionType: risk.kind === 'frost' ? 'protect' : 'water',
        title,
        detail,
        dueDate: risk.date,
        windowDays: 2,
        priority: risk.severity === 'severe' ? 1 : 2,
        source: 'manual'
      })
      toast.push('已加入养护计划', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '创建任务失败', 'error')
    }
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const plantId = plantFilter ? Number(plantFilter) : undefined
      const [monthTasks, allOpen, ov, logList, plantList, speciesList, recipeList, materialList] = await Promise.all([
        window.api.care.tasks({ from: bounds.from, to: bounds.to, plantId }),
        window.api.care.tasks({ status: 'open', plantId }),
        window.api.care.overview(year),
        window.api.care.logs(plantId, 100),
        window.api.plants.list({ limit: 500 }),
        window.api.species.list({ limit: 500 }),
        /*
         * 任务卡片要显示绑定的配方，所以一起取。
         *
         * **失败时给 null，不要给 []** —— 空数组会让 TaskRecipe 断言
         * 「配方已删除」，用户就会去重建一份其实还在的配方。
         * 而且 .catch 吞在最内层时 Promise.all 不会 reject，
         * 外层 catch 不触发，连一句报错都没有，页面看起来完全正常。
         */
        window.api.recipes.list().catch(() => null),
        window.api.materials.list().catch(() => null)
      ])
      setTasks(monthTasks)
      // 逾期任务可能落在任意更早的月份，必须单独取，否则翻页就「看不见」了
      setOverdue(allOpen.filter((t) => urgencyOf(t, today) === 'overdue'))
      setOverview(ov)
      setLogs(logList)
      setPlants(
        plantList.items.map((p) => ({
          id: p.id,
          label: `${p.nickname}${p.species ? `（${p.species.commonName}）` : ''}`
        }))
      )
      setSpeciesNames(speciesList.items.map((s) => s.commonName))
      // 配方取不到不该让整页报错（用户可能一个配方都没有）
      setRecipes(recipeList)
      setMaterials(materialList)
      // 侧栏角标和这里的统计是同一份数据，一起刷新才不会出现
      //「页面上写着该做 0、侧栏还挂着红点」这种自相矛盾
      onCareChanged?.()
    } catch (error) {
      toast.push(`加载养护计划失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [bounds.from, bounds.to, plantFilter, year, today, toast, onCareChanged])

  useEffect(() => {
    void reload()
  }, [reload])

  const generate = async (): Promise<void> => {
    try {
      const result = await window.api.care.generateAll(year)
      toast.push(
        result.created > 0
          ? `已为 ${result.plants} 株植物生成 ${result.created} 项任务（保留已有 ${result.kept} 项）`
          : `计划已是最新：${result.plants} 株植物，${result.kept} 项任务无需变动`,
        'success'
      )
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '生成失败', 'error')
    }
  }

  const act = async (id: number, action: 'complete' | 'skip' | 'reopen', note?: string): Promise<void> => {
    setBusyId(id)
    try {
      if (action === 'complete') await window.api.care.completeTask(id, note ?? null)
      else if (action === 'skip') await window.api.care.skipTask(id, note ?? null)
      else await window.api.care.reopenTask(id)
      setNoteFor(null)
      setNoteText('')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '操作失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 打开「清理计划」：把那一年的任务全取回来，之后筛选都在本地做（数据量很小）。
   */
  const openPurge = async (): Promise<void> => {
    setPurgeOpen(true)
    setPurgeMonth(null)
    setPurgeLoading(true)
    try {
      const ov = await window.api.care.overview(purgeYear)
      setPurgeTasks(ov.yearTasks)
    } catch (error) {
      toast.push(`读取 ${purgeYear} 年任务失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
      setPurgeTasks([])
    } finally {
      setPurgeLoading(false)
    }
  }

  const switchPurgeYear = async (nextYear: number): Promise<void> => {
    setPurgeYear(nextYear)
    setPurgeLoading(true)
    try {
      const ov = await window.api.care.overview(nextYear)
      setPurgeTasks(ov.yearTasks)
    } catch {
      setPurgeTasks([])
    } finally {
      setPurgeLoading(false)
    }
  }

  /** 会被删掉的那批：范围内、且还没做的 */
  const purgeTargets = useMemo(() => {
    const prefix = purgeMonth === null ? `${purgeYear}-` : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-`
    return purgeTasks.filter((t) => t.status === 'pending' && t.dueDate.startsWith(prefix))
  }, [purgeTasks, purgeYear, purgeMonth])

  const runPurge = async (): Promise<void> => {
    if (purgeTargets.length === 0) return
    const scope = purgeMonth === null ? `${purgeYear} 年全年` : `${purgeYear} 年 ${purgeMonth} 月`
    setPurgeBusy(true)
    try {
      const from = purgeMonth === null ? `${purgeYear}-01-01` : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-01`
      const lastDay = new Date(purgeYear, purgeMonth ?? 12, 0).getDate()
      const to =
        purgeMonth === null
          ? `${purgeYear}-12-31`
          : `${purgeYear}-${String(purgeMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      const r = await window.api.care.purgeTasks({ from, to })
      toast.push(
        `已从${scope}删除 ${r.deleted} 条待办${r.kept > 0 ? `，保留 ${r.kept} 条已完成/已跳过的记录` : ''}`,
        'success'
      )
      setPurgeOpen(false)
      await reload()
    } catch (error) {
      toast.push(`清理失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    } finally {
      setPurgeBusy(false)
    }
  }

  const removeTask = async (task: CareTaskListItem): Promise<void> => {
    if (!window.confirm(`确定删除任务「${task.title}」吗？`)) return
    try {
      await window.api.care.removeTask(task.id)
      toast.push('已删除', 'success')
      await reload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  // ---- 分组 ----
  const isDone = (t: CareTaskListItem): boolean => t.status !== 'pending'
  const overdueSet = new Set(overdue.map((t) => t.id))
  const groups = useMemo(() => {
    const pending = tasks.filter((t) => !isDone(t) && !overdueSet.has(t.id))
    const byUrgency = (u: CareUrgency): CareTaskListItem[] =>
      pending.filter((t) => urgencyOf(t, today) === u).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const due = byUrgency('due')
    const soon = byUrgency('soon')
    const later = byUrgency('later')
    return {
      overdue,
      due,
      soon,
      later,
      /** 全部未完成（含逾期）—— 「本年待办 N」点进去看的就是这一批 */
      open: [...overdue, ...due, ...soon, ...later],
      closed: tasks.filter(isDone)
    }
  }, [tasks, overdue, overdueSet, today])

  const monthSummary = summarizeTasks(tasks, today)

  /**
   * **全年**口径的分组。
   *
   * 上面那四个统计数字本来就是全年的（careOverview 查的是 01-01~12-31），
   * 而 groups 基于当月任务 —— 直接拿 groups 去「查看」全年数字，
   * 会出现写着 24、点进去只有 10 的情况。
   *
   * 所以筛选走这一份：数字和列表同源。
   */
  const yearGroups = useMemo(() => {
    const list = overview?.yearTasks ?? []
    const open = list.filter((t) => t.status === 'pending')
    const byUrgency = (u: CareUrgency): CareTaskListItem[] =>
      open.filter((t) => urgencyOf(t, today) === u).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    return {
      overdue: byUrgency('overdue'),
      due: byUrgency('due'),
      /*
       * 「本年已完成」要**只数 status='done'**，不能连 skipped 一起算。
       *
       * summarizeTasks 里 done 和 skipped 是分开的两个计数，
       * 而任务列表按「已完成 / 已跳过」合并分组 —— 照抄那个习惯，
       * 徽章上的数字就会比原来多出「已跳过」那几个，
       * 用户看到「已完成 10」而库里只有 7 条 done，会以为数据错了。
       * 口径以统计为准，列表标题也跟着分开写。
       */
      completed: list.filter((t) => t.status === 'done'),
      open
    }
  }, [overview, today])

  /** 统计弹窗要显示的那批任务（全年口径，和徽章数字同源） */
  const statRows: CareTaskListItem[] = !statFilter
    ? []
    : statFilter === 'overdue'
      ? yearGroups.overdue
      : statFilter === 'due'
        ? yearGroups.due
        : statFilter === 'done'
          ? yearGroups.completed
          : yearGroups.open

  /**
   * 任务行 / 分组。
   *
   * 这两个是**普通函数**，必须直接调用 `taskRow(task)`，
   * 不能写成 `<TaskRow task={t} />` —— 它们定义在 CarePage 内部，
   * 每次重渲染都是新的函数对象。React 按类型标识比较元素，
   * 用 JSX 组件语法会让它认为类型变了，从而卸载并重建整棵子树。
   * 后果很具体：备注输入框每敲一个字符就被销毁重建、焦点丢失，
   * 表现为「输入不了东西」。
   */
  const taskRow = (task: CareTaskListItem): ReactNode => {
    const urgency = urgencyOf(task, today)
    const closed = task.status !== 'pending'
    return (
      <div
        className={"task-row" + (highlight === task.id ? " highlighted" : "")}
        ref={(el) => {
          if (el) taskRefs.current.set(task.id, el)
          else taskRefs.current.delete(task.id)
        }}
      >
        <span className="task-icon">{CARE_ACTION_ICONS[task.actionType]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row tight" style={{ alignItems: 'center' }}>
            <b>{task.title}</b>
            <Badge tone={URGENCY_TONE[urgency]}>
              {closed
                ? task.status === 'done'
                  ? '已完成'
                  : '已跳过'
                : `${CARE_URGENCY_LABELS[urgency]} · ${dueDescription(task, today)}`}
            </Badge>
            {task.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
            {task.source === 'manual' ? <Badge tone="muted">手动</Badge> : null}
          </div>
          <div className="small muted">
            {task.dueDate}
            {task.plantName ? ` · ${task.plantName}` : ''}
            {task.speciesName ? ` · ${task.speciesName}` : ''}
            {` · ${CARE_ACTION_LABELS[task.actionType]}`}
            {task.windowDays > 0 ? ` · 时间窗 ±${task.windowDays} 天` : ''}
          </div>
          {task.detail ? <div className="small">{task.detail}</div> : null}
          {/*
            绑了配方的规则，任务上直接列出材料清单 ——
            做的时候不用再翻回规则库查「羊粪放多少」。
            按 id 现查，所以配方改了名字这里会跟着变。
          */}
          {task.recipeId ? <TaskRecipe recipeId={task.recipeId} recipes={recipes} materials={materials} /> : null}
          {task.completedNote ? <div className="small muted">备注：{task.completedNote}</div> : null}

          {noteFor === task.id ? (
            <div className="row tight" style={{ marginTop: 6 }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={noteText}
                  onChange={setNoteText}
                  placeholder="记一句当时的情况（可留空）"
                  autoFocus
                />
              </div>
              <Button size="small" variant="primary" onClick={() => void act(task.id, 'complete', noteText)}>
                确认完成
              </Button>
              <Button size="small" variant="ghost" onClick={() => setNoteFor(null)}>
                取消
              </Button>
            </div>
          ) : null}
        </div>

        <div className="row tight" style={{ flexWrap: 'nowrap' }}>
          {closed ? (
            <>
              <Button size="small" disabled={busyId === task.id} onClick={() => void act(task.id, 'reopen')}>
                撤销
              </Button>
              <Button size="small" variant="ghost" onClick={() => void removeTask(task)}>
                删除
              </Button>
            </>
          ) : (
            <>
              <Button
                size="small"
                variant="primary"
                disabled={busyId === task.id}
                onClick={() => {
                  setNoteFor(task.id)
                  setNoteText('')
                }}
              >
                完成
              </Button>
              <Button size="small" disabled={busyId === task.id} onClick={() => void act(task.id, 'skip')}>
                跳过
              </Button>
              <Button size="small" variant="ghost" onClick={() => setEditing(task)}>
                编辑
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  /**
   * 把高亮的那条任务滚进视野。
   *
   * 原来只加了 `highlighted` 类名，**从来没滚动过** —— 那行如果在视口外，
   * 点完月历里的任务什么都不会发生，看起来像没生效。
   */
  useEffect(() => {
    if (highlight === null) return
    const el = taskRefs.current.get(highlight)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 高亮留一会儿再褪掉，让人来得及看见是哪一条
    const timer = setTimeout(() => setHighlight(null), 2600)
    return () => clearTimeout(timer)
  }, [highlight])

  const taskGroup = (title: string, list: CareTaskListItem[], tone?: string): ReactNode => {
    if (list.length === 0) return null
    return (
      <div style={{ marginBottom: 14 }} key={title}>
        <div className="section-title">
          {title}
          {tone ? <Badge tone={tone as 'safety'}>{list.length}</Badge> : <span className="small muted">{list.length} 项</span>}
        </div>
        {list.map((t) => (
          <Fragment key={t.id}>{taskRow(t)}</Fragment>
        ))}
      </div>
    )
  }

  return (
    <div className="content-inner">
      <div className="row" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'nowrap' }}>
        <Button size="small" onClick={() => (month === 1 ? (setMonth(12), setYear(year - 1)) : setMonth(month - 1))}>
          ‹
        </Button>
        <b style={{ minWidth: 108, textAlign: 'center' }}>
          {year} 年 {month} 月
        </b>
        <Button size="small" onClick={() => (month === 12 ? (setMonth(1), setYear(year + 1)) : setMonth(month + 1))}>
          ›
        </Button>
        {/*
          「回到今天」用**默认实心样式**，不用 ghost。
          ghost 是背景、边框全透明 + 弱化文字，放在这片蓝色画布上几乎看不见
          （用户截图圈出来说「太不显眼」）。它两边都是深色描边的按钮框，
          这个也该是同一档。
        */}
        <Button
          size="small"
          disabled={isCurrentMonth}
          title={isCurrentMonth ? '已经在今天所在的月份了' : '回到今天所在的月份'}
          onClick={() => {
            const d = new Date()
            setYear(d.getFullYear())
            setMonth(d.getMonth() + 1)
          }}
        >
          {isCurrentMonth ? '已是今天' : '回到今天'}
        </Button>

        <div style={{ width: 190 }}>
          <SelectInput
            value={plantFilter}
            onChange={setPlantFilter}
            options={[{ value: '', label: '全部植株' }, ...plants.map((p) => ({ value: String(p.id), label: p.label }))]}
          />
        </div>
        <span className="spacer" />
        <Button size="small" onClick={() => setShowRules(true)}>
          规则库（{overview?.rules ?? 0}）
        </Button>
        <Button size="small" onClick={() => void generate()}>
          生成 / 更新计划
        </Button>
        {/* 误生成整年计划时的出口 —— 135 条没法一条条删 */}
        <Button size="small" onClick={() => void openPurge()}>
          清理计划
        </Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          ＋ 新增任务
        </Button>
      </div>

      <Panel>
        <div className="row" style={{ marginBottom: 4 }}>
          {/*
            这四个原来是纯 Badge —— 点不动，用户没法从「逾期 0」走到对应列表。
            现在点一下就筛出那批任务（**全年口径**，和数字同源）。

            数字改用 yearGroups 而不是 overview：两者一致，但 yearGroups 是
            从实际列表算出来的，筛选结果和显示数字永远对得上。
          */}
          {(
            [
              { key: 'overdue', label: '逾期', n: yearGroups.overdue.length, tone: 'safety', on: '#8a3a30' },
              { key: 'due', label: '该做', n: yearGroups.due.length, tone: 'warn', on: '#9a6410' },
              { key: 'done', label: '本年已完成', n: yearGroups.completed.length, tone: 'ok', on: '#3f7a2a' },
              { key: 'open', label: '本年待办', n: yearGroups.open.length, tone: 'muted', on: '#6b5a3a' }
            ] as const
          ).map((item) => {
            const on = statFilter === item.key
            return (
              <button
                key={item.key}
                type="button"
                className={`pixel-badge ${item.tone} stat-filter${on ? ' on' : ''}`}
                /*
                 * 选中态的底色用**内联样式**：.pixel-badge.safety 之类的 tone 规则
                 * 优先级比 .stat-filter.on 高，写在 CSS 里会被压掉。
                 */
                style={on ? { background: item.on, color: '#fff', borderColor: '#fff' } : undefined}
                title={`查看${item.label}的任务（全年）`}
                onClick={() => setStatFilter(on ? null : item.key)}
              >
                {item.label} {item.n}
              </button>
            )
          })}
          <span className="spacer" />
          <span className="small muted">
            本月 {monthSummary.total} 项 · 完成 {monthSummary.done} · 待办 {monthSummary.pending}
          </span>
        </div>

        <div className="row tight" style={{ marginTop: 8 }}>
          <Button size="small" variant={tab === 'todo' ? 'primary' : 'ghost'} onClick={() => setTab('todo')}>
            待办
          </Button>
          <Button size="small" variant={tab === 'calendar' ? 'primary' : 'ghost'} onClick={() => setTab('calendar')}>
            月历
          </Button>
          <Button size="small" variant={tab === 'logs' ? 'primary' : 'ghost'} onClick={() => setTab('logs')}>
            养护日志（{logs.length}）
          </Button>
        </div>
      </Panel>

      {overview && overview.plantsWithoutTasks > 0 ? (
        <Panel flat>
          <Notice tone="info">
            还有 <b>{overview.plantsWithoutTasks}</b> 株植物没有 {year} 年的计划。
            点右上角「生成 / 更新计划」，会按规则库和每株的物种自动排出全年该做的事。
            <b>已打过勾的任务不会被覆盖。</b>
          </Notice>
        </Panel>
      ) : null}

      {/*
        物候阶段。它是「观察到的状态」而不是月份 —— 同一个月里，
        南阳台的可能已经现蕾，北窗台的还没动。所以放在待办页最上面，
        由你看到什么就标什么；标了之后限定阶段的规则会立刻跟着变。
      */}
      {/*
        天气预警**只在当月显示**。

        它是「当天该注意什么」，翻到 11 月、12 月时看的是那个月的任务，
        这块留在那儿只是挡路 —— 而且很容易被误读成「那个月的天气」。
        所以不提供手动展开/收起：不是当月就不显示，整块让位给任务列表。

        数据仍然是挂载时拉一次，翻月不会重新请求（只有 7 天预报，
        翻到 11 月也答不出 11 月的天气，重新请求没有意义）。
      */}
      {isCurrentMonth ? (
        <Panel>
          <SectionTitle
            right={
              <span className="small muted">
                {weatherBusy
                  ? '正在查看…'
                  : weather?.fetchedAt
                    ? `数据时间 ${new Date(weather.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                    : ''}
              </span>
            }
          >
            天气预警 <span className="small muted">（当天 · {today}）</span>
          </SectionTitle>
          <WeatherPanel
            result={weather}
            addedKeys={addedKeys}
            busy={weatherBusy}
            onRefresh={() => void loadWeather(true)}
            onCreateTask={createTaskFromRisk}
          />
        </Panel>
      ) : null}

      {/*
        这里原来有一整块「植株阶段」列表：每株一行，显示阶段、已标记多少天、改阶段按钮。

        用户反馈它和「我的花园」重复，而且占地方 —— 说得对：
        花园页选中一株就能看到阶段、天数，也能就地改，
        这一块整段都是重复信息，还把任务列表挤到了下面。

        天数没有丢，搬到了花园页那一株的「物候阶段」旁边
        （同一个 phaseAgeDays）。改阶段的入口也还在：花园里点一株即可。

        「改阶段」弹窗保留 —— 那里显示「已经 N 天了」是给**正在做这个决定的人**
        看的，和列表里罗列给所有人看是两回事。
      */}

      {loading ? (
        <Panel>
          <Spinner label="加载中…" />
        </Panel>
      ) : tab === 'todo' ? (
        <Panel>
          <SectionTitle right={<span className="small muted">{plants.length} 株植物</span>}>
            {year} 年 {month} 月
          </SectionTitle>
          {groups.overdue.length === 0 &&
          groups.due.length === 0 &&
          groups.soon.length === 0 &&
          groups.later.length === 0 &&
          groups.closed.length === 0 ? (
            <EmptyState
              icon="🗓"
              title="这个月还没有安排"
              hint={
                overview && overview.rules > 0
                  ? '点「生成 / 更新计划」，按规则库自动排出这个月该做的事；也可以自己加一条。'
                  : '规则库还是空的，先到「规则库」里加几条，或者直接手动加任务。'
              }
              action={
                <Button variant="primary" onClick={() => void generate()}>
                  生成计划
                </Button>
              }
            />
          ) : (
            <>
              {taskGroup('已过期', groups.overdue, 'safety')}
              {taskGroup('该做了', groups.due, 'warn')}
              {taskGroup('快到了', groups.soon)}
              {taskGroup('这个月晚些', groups.later)}
              {taskGroup('已完成 / 已跳过', groups.closed)}
            </>
          )}
        </Panel>
      ) : tab === 'calendar' ? (
        <Panel>
          <SectionTitle right={<span className="small muted">点任务可跳到待办列表处理</span>}>
            {year} 年 {month} 月
          </SectionTitle>
          <CareCalendar
            year={year}
            month={month}
            tasks={tasks}
            onPickTask={(t) => {
              // 跳到待办并高亮：月历负责「看清节奏」，处理动作回到列表
              setTab('todo')
              setHighlight(t.id)
            }}
            onPickDay={(date) => {
              setEditing('new')
              setDraftDate(date)
            }}
          />
        </Panel>
      ) : (
        <Panel>
          <SectionTitle>养护日志</SectionTitle>
          {/* 手动记一笔。原来空态写着「也可以随时手动记一笔」却没有入口，现在真给了。 */}
          <div className="row tight" style={{ marginBottom: 8 }}>
            <div style={{ width: 180 }}>
              <SelectInput
                value={logPlantId}
                onChange={setLogPlantId}
                placeholder="选一株植物…"
                options={plants.map((pl) => ({ value: String(pl.id), label: pl.label }))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextInput
                value={logDraft}
                onChange={setLogDraft}
                placeholder="记一句做了什么，例如「换了盆，土是泥炭 5 : 珍珠岩 3」"
              />
            </div>
            <Button onClick={() => void addManualLog()} disabled={!logPlantId || !logDraft.trim()}>
              记一笔
            </Button>
          </div>
          {logs.length === 0 ? (
            <EmptyState icon="📓" title="还没有记录" hint="完成任务时会自动写一条日志；也可以在上面手动记一笔。" />
          ) : (
            <div className="log-timeline">
              {logs.map((log) => {
                const plant = plants.find((p) => p.id === log.plantId)
                return (
                  <div key={log.id} className="log-item">
                    <div className="log-date">{log.logDate}</div>
                    <div style={{ flex: 1 }}>
                      <div>
                        <Badge tone="info">
                          {log.kind === 'phase' ? '🌿 阶段' : (CARE_ACTION_LABELS[log.kind as 'water'] ?? log.kind)}
                        </Badge>
                        {plant ? <span className="small muted">{plant.label}</span> : null}
                      </div>
                      {log.content ? <div className="small">{log.content}</div> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>
      )}

      {editing ? (
        <CareTaskDialog
          task={editing === 'new' ? null : editing}
          plants={plants}
          defaultDate={draftDate ?? `${year}-${String(month).padStart(2, '0')}-01`}
          onClose={() => {
            setEditing(null)
            setDraftDate(undefined)
          }}
          onSaved={() => {
            setEditing(null)
            setDraftDate(undefined)
            setHighlight(null)
            void reload()
          }}
        />
      ) : null}

      {showRules ? <CareRuleManager speciesNames={speciesNames} onClose={() => setShowRules(false)} /> : null}

      {/*
        统计弹窗。
        用户的要求：这四个数字用弹窗看，不要改动主列表。

        内容走的是 **往年全年** 口径（那四个数字本来就是全年的），
        所以标题里把范围和条数都写出来，免得和下面的当月列表混淆。
      */}
      {statFilter ? (
        <Modal
          title={`${year} 年 · ${STAT_FILTER_TITLES[statFilter]}`}
          onClose={() => setStatFilter(null)}
          headerExtra={<span className="small muted">共 {statRows.length} 项（全年）</span>}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setStatFilter(null)}>关闭</Button>
            </>
          }
        >
          {statRows.length === 0 ? (
            <div className="small muted">没有「{STAT_FILTER_TITLES[statFilter]}」的任务。</div>
          ) : (
            statRows.map((t) => (
              <div key={t.id} className="stat-task">
                <div className="row tight" style={{ alignItems: 'center' }}>
                  <span className="task-icon">{CARE_ACTION_ICONS[t.actionType]}</span>
                  <b>{t.title}</b>
                  <Badge tone={t.status === 'done' ? 'ok' : t.status === 'skipped' ? 'muted' : 'warn'}>
                    {t.status === 'done' ? '已完成' : t.status === 'skipped' ? '已跳过' : dueDescription(t, today)}
                  </Badge>
                  {t.priority === 1 ? <Badge tone="safety">高优先</Badge> : null}
                </div>
                <div className="small muted">
                  {t.dueDate}
                  {t.plantName ? ` · ${t.plantName}` : ''}
                  {` · ${CARE_ACTION_LABELS[t.actionType]}`}
                </div>
                {t.completedNote ? <div className="small muted">备注：{t.completedNote}</div> : null}
              </div>
            ))
          )}
        </Modal>
      ) : null}

      {/*
        清理计划。

        生成是按年的：误点一下「生成 / 更新计划」就排出整年，
        而删除只能一条一条来。用户误建了 2027 年（135 条）之后没有任何出口。
      */}
      {purgeOpen ? (
        <Modal
          title="清理计划"
          onClose={() => setPurgeOpen(false)}
          headerExtra={<span className="small muted">只删待办，已完成 / 已跳过的会保留</span>}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setPurgeOpen(false)}>取消</Button>
              <Button variant="danger" disabled={purgeBusy || purgeTargets.length === 0} onClick={() => void runPurge()}>
                {purgeBusy ? '正在删除…' : `删除这 ${purgeTargets.length} 条`}
              </Button>
            </>
          }
        >
          <div className="row tight" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="small">范围：</span>
            <div style={{ width: 120 }}>
              <SelectInput
                value={String(purgeYear)}
                onChange={(v) => void switchPurgeYear(Number(v))}
                options={[year - 1, year, year + 1, year + 2].map((y) => ({
                  value: String(y),
                  label: `${y} 年`
                }))}
              />
            </div>
            <Button
              size="small"
              variant={purgeMonth === null ? 'primary' : undefined}
              onClick={() => setPurgeMonth(null)}
            >
              全年
            </Button>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <Button
                key={m}
                size="small"
                variant={purgeMonth === m ? 'primary' : undefined}
                onClick={() => setPurgeMonth(m)}
              >
                {m} 月
              </Button>
            ))}
          </div>

          {purgeLoading ? (
            <Spinner label="读取中…" />
          ) : purgeTargets.length === 0 ? (
            <div className="small muted">
              {purgeYear} 年{purgeMonth === null ? '' : ` ${purgeMonth} 月`}没有待办任务，不需要清理。
            </div>
          ) : (
            <>
              <div className="small muted" style={{ marginBottom: 6 }}>
                下面这 {purgeTargets.length} 条会被删除：
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {purgeTargets.slice(0, 200).map((t) => (
                  <div key={t.id} className="stat-task">
                    <div className="row tight" style={{ alignItems: 'center' }}>
                      <span className="task-icon">{CARE_ACTION_ICONS[t.actionType]}</span>
                      <b>{t.title}</b>
                      <Badge tone="muted">{dueDescription(t, today)}</Badge>
                    </div>
                    <div className="small muted">
                      {t.dueDate}
                      {t.plantName ? ` · ${t.plantName}` : ''}
                    </div>
                  </div>
                ))}
                {purgeTargets.length > 200 ? (
                  <div className="small muted">……以及另外 {purgeTargets.length - 200} 条</div>
                ) : null}
              </div>
            </>
          )}
        </Modal>
      ) : null}

      {/* 动作类型图例：让图标不至于全靠猜 */}      <div className="small muted" style={{ marginTop: 10 }}>
        图例：
        {CARE_ACTION_OPTIONS.map((o) => (
          <span key={o.value} style={{ marginLeft: 8 }}>
            {o.label}
          </span>
        ))}
      </div>
    </div>
  )
}
