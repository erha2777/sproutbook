/**
 * 天气预警面板。
 *
 * 四种状态各有各的话要说，尤其是「没配置」那一种 ——
 * 用户需要知道**不填城市就不会联网**，而不是以为功能坏了。
 *
 * 这个组件原来定义在 CarePage 里。1.8.0 把「当日待办 + 天气预警」拆成
 * 独立的「今日」页之后，两端只剩下一个使用者（今日页），但**仍然放在
 * components/ 里**：它是纯展示组件、不持有页面状态，和养护计划的任务列表
 * 没有关系；留在页面文件里会让那个文件继续膨胀，也不利于以后复用。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { WeatherRiskItem, WeatherWarningResult } from '@shared/api'
import { adviseToday, SEVERITY_LABELS, WEATHER_KIND_LABELS } from '@core/weather'
import { Button, Modal } from './ui'
import { WeatherIcon } from './WeatherIcon'

/**
 * 天气任务的身份：同一株 + 同一天 + 同一个标题就算同一条。
 *
 * 抽成模块层函数是为了让**建之前的查重**和**按钮的禁用态**
 * 用同一个定义 —— 两处各写一遍迟早会漂移，然后就是「按钮说已加入、
 * 点了却又建一条」这种自相矛盾。
 */
export function weatherTaskKey(plantId: number, date: string, title: string): string {
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

export function WeatherPanel({
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
