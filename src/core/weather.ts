/**
 * 天气风险判断 —— 纯函数，不碰网络。
 *
 * 设计要点：**这个应用原本完全离线**，接天气是第一个网络依赖。
 * 所以判断逻辑单独放在 core 层：网络只负责取回一组温度，
 * 「谁怕冷、谁怕热、要不要提醒」全部在这里决定，可被自检完整覆盖。
 *
 * 另一条底线：**数据不全就不猜**。
 * 物种没填耐寒温度时，不按「大概怕冷」去提醒 —— 宁可少提醒，
 * 这和养护规则里「没标记阶段就不生成阶段任务」是同一个立场。
 */

export type WeatherRiskKind = 'frost' | 'heat'

/** 预报里的一天。只留判断需要的两个温度。 */
/** 中性的天气类型。两个数据源各自的编码在边界上翻译成它。 */
export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'snow' | 'storm' | 'fog'

/**
 * 逐时天气。
 *
 * 「今天要不要浇水 / 要不要搬进屋」看的是**接下来这几小时**，
 * 不是后天的日最高温。
 *
 * WMO 编码（Open-Meteo）和和风图标号是**两套**体系，所以这里只存
 * 中性的 kind，由 wmoToKind / qweatherIconToKind 在边界上翻译 ——
 * 界面就不必到处判断「这条是哪个源给的」。
 */
export interface HourlyWeather {
  /** ISO 本地时间，例如 2026-10-15T14:00 */
  time: string
  temp: number
  kind: WeatherKind | null
  /** 降水概率 0~100。源没给就是 null */
  pop: number | null
}

export interface DailyTemp {
  /** YYYY-MM-DD */
  date: string
  /** 当日最低气温 ℃ */
  tempMin: number
  /** 当日最高气温 ℃ */
  tempMax: number
}

export interface WeatherRiskInput {
  plantId: number
  plantName: string
  speciesName: string | null
  /** 养护位置的名字，用来说明「在哪」 */
  placeName: string | null
  /** 物种的耐寒温度（℃）。越低越耐寒。没填则不做霜冻判断 */
  coldHardiness: number | null
  /** 物种的耐热温度（℃）。没填则不做高温判断 */
  heatTolerance: number | null
  /** 养护位置能不能防冻（室内 / 有遮挡） */
  frostProtected: boolean
  /** 养护位置能不能加温 */
  canHeat: boolean
}

export interface WeatherRisk {
  kind: WeatherRiskKind
  plantId: number
  plantName: string
  speciesName: string | null
  date: string
  /** 预报的那个温度 */
  forecastTemp: number
  /** 这株实际能扛到的温度（已按养护位置调整） */
  tolerance: number
  /** 超出承受范围多少度。恒为正数 */
  margin: number
  severity: RiskSeverity
  /** 一句人话，直接显示给用户 */
  message: string
}

export type RiskSeverity = 'watch' | 'warn' | 'severe'

export const SEVERITY_LABELS: Record<RiskSeverity, string> = {
  watch: '留意',
  warn: '要处理',
  severe: '紧急'
}

/**
 * 能防冻的位置相当于多扛几度。
 *
 * 这不是精确物理量 —— 阳台内侧和露天院子差多少度，取决于朝向和封闭程度。
 * 给 5℃ 是个保守的估计：它足以让「室内那盆」不因为寒潮报一次没必要的警，
 * 又不至于把露天的也一起豁免掉。真需要精确到度，用户可以自己改物种的耐寒温度。
 */
export const FROST_PROTECTED_BONUS = 5

/** 能加温的位置同理，但加温通常只在极端天气开，所以给得少一些。 */
export const CAN_HEAT_BONUS = 3

/**
 * WMO 天气编码 → 中性的天气类型。
 *
 * Open-Meteo 返回的是 WMO 编码（0=晴、3=阴、61=小雨、95=雷暴…），
 * 和风返回的是它自己的图标号 —— 两套完全不同的体系。
 *
 * **在这里翻译成一套中性的**，界面就只管按 kind 画图标，
 * 不用到处判断「这条数据是哪个源给的」。这正是上一轮
 * providerLabel 谎报的同一个教训：**来源的差异要在边界上收口**。
 */
export function wmoToKind(code: number | null | undefined): WeatherKind | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null
  if (code === 0) return 'clear'
  if (code <= 2) return 'cloudy'
  if (code === 3) return 'overcast'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'rain' // 毛毛雨/冻雨
  if (code >= 61 && code <= 67) return 'rain' // 雨
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain' // 阵雨
  if (code >= 85 && code <= 86) return 'snow' // 阵雪
  /*
   * WMO 的雷暴是 95/96/99 —— **必须有上界**。
   * 写成 `code >= 95` 的话，任何大数字（9999、脏数据）都会变成「雷暴」，
   * 于是一条坏数据就能在界面上画出一个雷雨图标。自检抓到过这一点。
   */
  if (code >= 95 && code <= 99) return 'storm'
  return null
}

/** 和风的图标号 → 中性的天气类型。分档依据和风图标表的区段。 */
export function qweatherIconToKind(icon: number | null | undefined): WeatherKind | null {
  if (icon === null || icon === undefined || !Number.isFinite(icon)) return null
  if (icon === 100) return 'clear'
  if (icon === 101 || icon === 102 || icon === 103) return 'cloudy'
  if (icon === 104) return 'overcast'
  /*
   * **150–153 是同一批天气的夜间版**（150 晴、151 多云、152 少云、153 晴间多云）。
   *
   * 漏掉它们的后果很直观：24 小时横条跨了夜里那几个小时，
   * 于是那几格全是「天气未知」—— 而夜里恰恰是用户最关心要不要搬进屋的时候。
   * 白天/夜间在**养护判断上没有区别**，所以映射到同一个 kind。
   */
  if (icon === 150) return 'clear'
  if (icon === 151 || icon === 152 || icon === 153) return 'cloudy'
  if (icon >= 300 && icon <= 399) return 'rain' // 各类雨（含 350/351 夜间阵雨）
  if (icon >= 400 && icon <= 499) return 'snow' // 各类雪（含 456/457 夜间）
  if (icon >= 500 && icon <= 515) return 'fog' // 雾霾
  if (icon >= 900) return 'clear' // 晴热/寒冷，归到最接近的
  return null
}

/** 界面用的图标。放 core 是为了让自检能覆盖它（界面层测不到）。 */
export const WEATHER_KIND_ICONS: Record<WeatherKind, string> = {
  clear: '☀',
  cloudy: '⛅',
  overcast: '☁',
  rain: '🌧',
  snow: '🌨',
  storm: '⛈',
  fog: '🌫'
}

export const WEATHER_KIND_LABELS: Record<WeatherKind, string> = {
  clear: '晴',
  cloudy: '多云',
  overcast: '阴',
  rain: '雨',
  snow: '雪',
  storm: '雷雨',
  fog: '雾'
}

export function severityOf(margin: number): RiskSeverity {
  if (margin <= 2) return 'watch'
  if (margin <= 5) return 'warn'
  return 'severe'
}

/**
 * 这株在它所在的位置上，**室外降到几度**才会受影响。
 *
 * 注意方向：防冻的意思是「植株感受到的温度比室外高」——
 * 所以室外可以更冷，阈值要**减**掉防护的加成。
 *
 * 第一版写成了加，含义就变成了「有防护反而更怕冷」，
 * 自检里「能防冻的位置不再报霜冻」立刻红了。符号写反在这类换算里
 * 不会报错、只会安静地给出相反的结论，所以这里必须写清楚。
 */
export function effectiveColdThreshold(
  coldHardiness: number | null,
  place: { frostProtected: boolean; canHeat: boolean }
): number | null {
  if (coldHardiness === null || !Number.isFinite(coldHardiness)) return null
  let bonus = 0
  if (place.frostProtected) bonus += FROST_PROTECTED_BONUS
  if (place.canHeat) bonus += CAN_HEAT_BONUS
  return coldHardiness - bonus
}

/**
 * 这株在它所在的位置上，**室外升到几度**就会受影响。
 *
 * 不做任何调整：模板里的两个位置字段（能不能防冻、能不能加温）都是**御寒**用的，
 * 没有对应的「能不能降温」。硬拿「能防冻」去推断「室内更闷热」是没有依据的联想，
 * 宁可如实按物种的耐热温度判断。
 */
export function effectiveHeatThreshold(heatTolerance: number | null): number | null {
  if (heatTolerance === null || !Number.isFinite(heatTolerance)) return null
  return heatTolerance
}

function fmt(temp: number): string {
  return `${temp > 0 ? '' : ''}${Math.round(temp * 10) / 10}℃`
}

/**
 * 逐株、逐天判断风险。
 *
 * 只返回**真的越界**的那些：预报没到物种承受范围就不产生任何条目，
 * 界面上也就不会有「一切正常」的噪音。
 *
 * ## 措辞上的一处讲究
 *
 * `forecastLabel` 是**预报取自哪里**（比如「湖南 · 某市」），
 * `placeName` 是**这株植物放在哪**（比如「前院（东南136°）」）。两者必须分开说。
 *
 * 第一版把预报温度直接安在植株的位置上（「前院（东南136°）最高 31.2℃」），
 * 读起来像是院子里的实测值 —— 但那是某市市中心那个格点的预报。
 * 城市尺度的网格数据和实际院子可能差几度（热岛、地形、朝向都不在内）。
 * 把不确定的东西说成确定的，比不说还糟。
 */
export function assessWeatherRisks(
  plants: WeatherRiskInput[],
  forecast: DailyTemp[],
  forecastLabel?: string | null
): WeatherRisk[] {
  const out: WeatherRisk[] = []
  const where = forecastLabel?.trim() ? forecastLabel.trim() : '预报点'

  for (const p of plants) {
    const place = { frostProtected: p.frostProtected, canHeat: p.canHeat }
    // 阈值是「室外降到/升到几度才出事」，不是植株本身的承受温度 —— 方向别搞反
    const cold = effectiveColdThreshold(p.coldHardiness, place)
    const heat = effectiveHeatThreshold(p.heatTolerance)

    for (const day of forecast) {
      if (cold !== null && Number.isFinite(day.tempMin) && day.tempMin <= cold) {
        const margin = cold - day.tempMin
        out.push({
          kind: 'frost',
          plantId: p.plantId,
          plantName: p.plantName,
          speciesName: p.speciesName,
          date: day.date,
          forecastTemp: day.tempMin,
          tolerance: cold,
          margin,
          severity: severityOf(margin),
          message:
            `${where}预报最低 ${fmt(day.tempMin)}` +
            (p.placeName ? `，${p.placeName}这株能扛到 ${fmt(cold)}` : `，它能扛到 ${fmt(cold)}`) +
            (p.frostProtected || p.canHeat ? '（已按养护位置调整）' : '') +
            `，超出 ${fmt(margin)}。`
        })
      }

      if (heat !== null && Number.isFinite(day.tempMax) && day.tempMax >= heat) {
        const margin = day.tempMax - heat
        out.push({
          kind: 'heat',
          plantId: p.plantId,
          plantName: p.plantName,
          speciesName: p.speciesName,
          date: day.date,
          forecastTemp: day.tempMax,
          tolerance: heat,
          margin,
          severity: severityOf(margin),
          message:
            `${where}预报最高 ${fmt(day.tempMax)}` +
            (p.placeName ? `，${p.placeName}这株能扛到 ${fmt(heat)} 上限` : `，它能扛到 ${fmt(heat)} 上限`) +
            `，超出 ${fmt(margin)}。`
        })
      }
    }
  }

  // 最严重的排前面；同级别按日期，早的在前
  const rank: Record<RiskSeverity, number> = { severe: 0, warn: 1, watch: 2 }
  return out.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.date.localeCompare(b.date) || a.plantName.localeCompare(b.plantName)
  )
}

/**
 * 哪些植株因为缺数据而判断不了。
 *
 * 单独返回而不是塞进风险列表：它们不是风险，是**待补的信息** ——
 * 混在一起会让「有 3 条警告」看起来比实际严重。
 */
export function unjudgeable(
  plants: WeatherRiskInput[],
  kind: WeatherRiskKind
): WeatherRiskInput[] {
  return plants.filter((p) => (kind === 'frost' ? p.coldHardiness : p.heatTolerance) === null)
}

/** 一株一天只留最严重的那条，避免同一株被同一个寒潮刷屏。 */
export function dedupeByKindAndDay(risks: WeatherRisk[]): WeatherRisk[] {
  const seen = new Map<string, WeatherRisk>()
  for (const r of risks) {
    const key = `${r.kind}|${r.plantId}|${r.date}`
    const prev = seen.get(key)
    if (!prev || r.margin > prev.margin) seen.set(key, r)
  }
  return [...seen.values()]
}

/**
 * 把逐天的风险收成「每株每种风险一条」，用最严重的那天做代表。
 * 界面上要的是「这株要防冻」，而不是连着七天的七条。
 */
export function summarizeRisks(risks: WeatherRisk[]): WeatherRisk[] {
  const best = new Map<string, WeatherRisk>()
  for (const r of risks) {
    const key = `${r.kind}|${r.plantId}`
    const prev = best.get(key)
    if (!prev || r.margin > prev.margin) best.set(key, r)
  }
  const rank: Record<RiskSeverity, number> = { severe: 0, warn: 1, watch: 2 }
  return [...best.values()].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.date.localeCompare(b.date) || a.plantName.localeCompare(b.plantName)
  )
}

/** 建议创建的任务标题与内容。用户点了按钮才会用到。 */
export function suggestTask(risk: WeatherRisk): { title: string; detail: string } {
  const what = risk.kind === 'frost' ? '防冻' : '防暑'
  const action =
    risk.kind === 'frost'
      ? '搬到避风处或室内；不能搬的用无纺布/旧床单罩住，别用塑料袋闷。降温前当天浇透一次水（湿土比干土保温）。'
      : '避开正午浇水，改到清晨或傍晚；遮阳网或搬到半阴处；高温期间停施水溶肥。'
  return {
    title: `${what}：${risk.plantName}`,
    detail: `${risk.message}\n${action}\n〔依据天气预警，${risk.date}〕`
  }
}
