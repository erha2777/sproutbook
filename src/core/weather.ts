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
 */
export function assessWeatherRisks(
  plants: WeatherRiskInput[],
  forecast: DailyTemp[]
): WeatherRisk[] {
  const out: WeatherRisk[] = []

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
            `${p.placeName ?? '这株'}最低 ${fmt(day.tempMin)}，` +
            `低于它能扛的 ${fmt(cold)}` +
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
            `${p.placeName ?? '这株'}最高 ${fmt(day.tempMax)}，` +
            `达到它能扛的 ${fmt(heat)} 上限，超出 ${fmt(margin)}。`
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
