/**
 * 天气数据来源 —— Open-Meteo。
 *
 * 选它的原因很实际：**免费、不用注册、不用 API key**。
 * 这个应用的其他网络功能（AI）要用户自己填 key，天气不该也加一道门槛。
 *
 * ## 离线原则
 *
 * 这个应用原本 100% 离线，接天气是第一次往外发请求。所以定了一条硬规则：
 * **没填城市的养护位置，一个字节都不发出去**。
 * 用户不填城市，它就还是那个纯离线应用 —— 这不是「降级」，是等价的选择。
 *
 * ## 失败要安静
 *
 * 天气取不到不该让任何页面报错。断网、超时、接口改版，
 * 一律返回 null，界面照常显示，只是没有预警。
 */

import type { Db } from '../db/connection'
import {
  GEOCODE_CACHE_KEY,
  countRequest,
  readUsage,
  fetchDaily,
  lookupLocation,
  readWeatherConfig,
  type DailyFetch,
  type GeoResult,
  type WeatherConfig,
  type WeatherProviderId
} from './weather-providers'
import { getSetting, setSetting, listEnvironments } from '../db/repo/misc'
import { listPlants } from '../db/repo/plants'
import { listSpecies } from '../db/repo/species'
import {
  assessWeatherRisks,
  summarizeRisks,
  unjudgeable
} from '../../core/weather'
import type { DailyTemp, HourlyWeather, WeatherRisk, WeatherRiskInput } from '../../core/weather'


/** 强制刷新（用户点「重新获取」）的最小间隔。防止连点烧掉免费额度。 */
const FORCE_COOLDOWN_MS = 60 * 1000

/** 缓存多久。预报一天更新几次就够，没必要每次开页面都请求。 */
const CACHE_TTL_MS = 3 * 60 * 60 * 1000

const CACHE_KEY = 'weather.forecastCache'

export interface GeoPoint {
  latitude: number
  longitude: number
  /** 接口返回的规范地名，用来显示「取到的是哪里」 */
  label: string
}

export interface ForecastResult {
  point: GeoPoint
  days: DailyTemp[]
  /** 未来 24 小时 */
  hours: HourlyWeather[]
  /**
   * 这份预报**实际**是谁给的。
   *
   * 不能从配置推导 —— 和风失败时会静默退回 Open-Meteo，
   * 按配置写就会谎报来源，而设置页恰好教用户「填经纬度会更准」。
   */
  provider: WeatherProviderId
  /** 换源的原因。用的就是配置里选的那个源时为 null */
  fallbackReason: string | null
  /** 取回的时间（ISO），界面用来显示「几点的数据」 */
  fetchedAt: string
}

interface CacheEntry extends ForecastResult {
  key: string
  at: number
}

/**
 * 取预报，按坐标缓存 3 小时。
 *
 * 缓存键是**坐标**而不是数据源：换源之后同一个点的预报还是会重新取
 *（因为换了 provider 缓存里那条可能来自旧源），所以缓存里记了 provider，
 * 对不上就重新取。
 */
export async function getForecast(
  db: Db,
  config: WeatherConfig,
  point: GeoResult,
  force = false
): Promise<ForecastResult | null> {
  const key = `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`
  const cache = getSetting<Record<string, CacheEntry>>(db, CACHE_KEY, {})
  const hit = cache[key]
  const sameSource = hit?.provider === point.provider
  /*
   * **老缓存里没有 hours。**
   *
   * 逐时是后加的字段，之前写进去的缓存条目没有它。新界面读 place.hours.length
   * 会直接崩（Cannot read properties of undefined）—— 真崩过一次。
   *
   * 所以把「缺 hours」当作过期：重新取一次，顺便把逐时补上。
   * 但**取不到就退回老数据** —— 至少还有逐日，别让用户什么都看不到。
   */
  const staleShape = hit !== undefined && !Array.isArray(hit.hours)
  if (hit && sameSource && !staleShape) {
    const age = Date.now() - hit.at
    /*
     * force（用户点了「重新获取」）也**至少隔 60 秒**才真的重新请求。
     *
     * 这是给免费额度上的保险：数据源按天限量，而这个按钮绕过缓存，
     * 连点几下就是几次调用。60 秒内的数据本来也没有实质差别，
     * 挡掉的只是误触和连点。
     */
    if (age < CACHE_TTL_MS && (!force || age < FORCE_COOLDOWN_MS)) return hit
  }

  countRequest(db)
  const fetched = await fetchDaily(config, point)
  if (!fetched) {
    // 重取失败：宁可给一份没有逐时的旧预报，也别让用户什么都看不到
    return hit ? { ...hit, hours: hit.hours ?? [] } : null
  }

  const entry: CacheEntry = {
    key,
    at: Date.now(),
    point: { latitude: point.latitude, longitude: point.longitude, label: point.label },
    days: fetched.days,
    hours: fetched.hours,
    // 记的是**这次实际用的源**，不是配置里的那个 —— 换源时要如实说出来
    provider: fetched.provider,
    fallbackReason: fetched.fallbackReason,
    fetchedAt: new Date().toISOString()
  }
  cache[key] = entry
  setSetting(db, CACHE_KEY, cache)
  return entry
}

/** 清掉天气缓存。用户在设置里手动刷新时用。 */
export function clearWeatherCache(db: Db): void {
  setSetting(db, CACHE_KEY, {})
  // 地名缓存一起清 —— 用户点「重新获取」多半是觉得哪里不对，地名也该重来
  setSetting(db, GEOCODE_CACHE_KEY, {})
}

// ---------------------------------------------------------------------------
// 把「哪株植物、在哪儿、那地方未来几天什么天气」拼起来
// ---------------------------------------------------------------------------

export interface WeatherWarningResult {
  /** 这次**实际**用的是哪个数据源，界面要说明白 */
  providerLabel: string
  /**
   * 换源的原因（和风失败 / 没有 locationId / 配置不全）。
   * 用的就是配置里选的那个源时为 null。
   *
   * **换源了就要说出来** —— 用户拿「已到区县」去信这份预报是会出事的。
   */
  fallbackReason: string | null
  /** 今天向数据源发了几次请求。和风免费额度有限，摆出来让用户看得见 */
  requestsToday: number
  /**
   * 有没有任何一个养护位置填了城市。
   * **为 false 时一个字节都没发出去** —— 界面要如实这么告诉用户。
   */
  configured: boolean
  /** 参与判断的地点（按地点去重，同一地点只请求一次） */
  places: Array<{
    name: string
    label: string
    latitude: number
    longitude: number
    days: DailyTemp[]
    /** 未来 24 小时。取不到时是空数组，界面据此决定要不要画那条横条 */
    hours: HourlyWeather[]
    /** 精确到区县还是只到市 —— 界面上要如实说 */
    level: 'city' | 'district'
    provider: string
  }>
  /** 收拢后的风险，每株每种一条 */
  risks: WeatherRisk[]
  /** 逐天的明细，界面展开时用 */
  daily: WeatherRisk[]
  /** 因为物种没填耐寒温度而判断不了的植株 */
  unknownCold: string[]
  /** 因为物种没填耐热温度而判断不了的植株 */
  unknownHeat: string[]
  /** 取到数据的时间；没联网时为 null */
  fetchedAt: string | null
  /** 联网失败的原因（只在真的尝试过之后才有） */
  error: string | null
}

/**
 * 一次问清：哪些植株有天气风险。
 *
 * 流程：植株 → 物种（耐寒/耐热）→ 养护位置（城市/经纬度/能否防冻）。
 * 地点相同只请求一次；**没有任何地点填城市就直接返回，不发请求**。
 */
export async function assessPlantsWeather(
  db: Db,
  force = false,
  /** 和风的 API Key。由调用方（IPC 层）从钥匙串取出后传进来 */
  qweatherKey: string | null = null
): Promise<WeatherWarningResult> {
  const empty: WeatherWarningResult = {
    configured: false,
    providerLabel: '',
    fallbackReason: null,
    requestsToday: 0,
    places: [],
    risks: [],
    daily: [],
    unknownCold: [],
    unknownHeat: [],
    fetchedAt: null,
    error: null
  }

  const config = readWeatherConfig(db, qweatherKey)

  const plants = listPlants(db, { limit: 1000 }).items.filter((p) => p.status !== 'gifted')
  const environments = listEnvironments(db)
  const envById = new Map(environments.map((e) => [e.id, e]))
  const speciesById = new Map(listSpecies(db, { limit: 1000 }).items.map((s) => [s.id, s]))

  /*
   * 有城市、或者有经纬度，才算「配置过」。
   * 经纬度可以直接用；只有城市名时先地理编码。
   */
  const located = environments.filter((e) => (e.city ?? '').trim() || (e.lat !== null && e.lon !== null))
  if (located.length === 0) return empty

  const places: WeatherWarningResult['places'] = []
  /** 环境 id → 该地点的逐日预报。同一地点只请求一次。 */
  /** 这次所有地点**实际**用的源。第一个成功的地点定下来就不再变 */
  let actualProvider: WeatherProviderId | null = null
  /** 换源的原因。没换源时为 null */
  let fallbackReason: string | null = null

  const daysByEnvId = new Map<number, DailyTemp[]>()
  /** 每个环境对应的预报点显示名，例如「中国 · 湖南 · 某市」 */
  const daysLabel = new Map<number, string>()
  let fetchedAt: string | null = null
  let error: string | null = null

  // 坐标相同的地点（比如「南向阳台」和「露台」都填了同一个城市）只请求一次
  const daysByPoint = new Map<string, DailyFetch>()

  for (const env of located) {
    /*
     * 手填的经纬度**永远优先**：那是用户自己确认过的点，比任何地理编码都准。
     * 只有没填时才去解析地名。
     */
    let point: GeoResult | null =
      env.lat !== null && env.lon !== null
        ? {
            latitude: env.lat,
            longitude: env.lon,
            label: [env.province, env.city, env.district].filter(Boolean).join(' · ') || env.name,
            locationId: null,
            level: 'city',
            provider: config.provider
          }
        : null

    if (!point) {
      /*
       * 解析顺序在 lookupLocation 里：配了和风就先试和风（能到区县），
       * 失败再退 Open-Meteo。反过来的话，和风能解析出的区县永远轮不到。
       */
      point = await lookupLocation(db, config, {
        province: env.province,
        city: env.city,
        district: env.district
      })
      if (!point) {
        error = error ?? `没能定位「${env.district || env.city || env.name}」`
        continue
      }
      /*
       * **不把解析结果写回档案。**
       *
       * 原来这里有一句 UPDATE environments SET lat/lon —— 想法是「下次不用再查，
       * 也让用户看得见用的是哪个坐标」。但它抢了用户的决定权：
       *
       *   用户清空经纬度，是在表达「别用那个点，请按区县名重新解析」；
       *   结果一打开养护计划就被写回某市市中心 —— 怎么清都清不掉。
       *
       * 而且它把两种完全不同的语义塞进了同一格：手填的坐标（用户的明确指定）
       * 和自动解析的结果（我的猜测）。现在 lat/lon 只表示前者，猜测一律不留痕。
       *
       * 「看得见用的是哪个坐标」由天气面板负责，那里本来就列出了预报点和坐标，
       * 不需要拿用户的数据去当告示板。
       */
    }

    const pointKey = `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`
    /*
     * **这里是 DailyFetch 和 DailyTemp[] 的分界。**
     *
     * daysByPoint 存的是完整的 DailyFetch（要留着"这份是谁给的"），
     * 从下面这一行往后一律只传数组 —— 风险评估那一层不关心来源。
     * 上次改这处来回打转，就是因为没先划清这条线。
     */
    let forecast = daysByPoint.get(pointKey)
    if (!forecast) {
      forecast = (await getForecast(db, config, point, force)) ?? undefined
      if (!forecast) {
        error = error ?? '没能取到天气预报'
        continue
      }
      daysByPoint.set(pointKey, forecast)
      places.push({
        name: env.name,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        days: forecast.days,
        // 逐时。取不到时是空数组，界面据此决定要不要画那条横条
        hours: forecast.hours,
        // 精度要摆在明面上：区县级和市级是两回事
        level: point.level,
        /*
         * **数据源用实际的那个**，不是配置里的。
         * 和风失败时会退回 Open-Meteo，按配置写就会谎报来源和精度 ——
         * 而设置页恰好教用户「填经纬度会更准」，正好触发这条假来源。
         */
        provider: forecast.provider
      })
      /*
       * 换源了就要说出来。同一次评估里所有地点走同一套配置，来源一致，
       * 所以第一个成功的地点定下来就不再变。
       */
      if (actualProvider === null) {
        actualProvider = forecast.provider
        fallbackReason = forecast.fallbackReason
      }
      fetchedAt = new Date().toISOString()
    }
    daysByEnvId.set(env.id, forecast.days)
    daysLabel.set(env.id, point.label || env.name)
  }

  if (daysByEnvId.size === 0) return { ...empty, configured: true, error }

  // 组装判断输入：每株 + 它所在的养护位置 + 那个位置的预报
  const inputs: WeatherRiskInput[] = []
  const daysByPlant = new Map<number, DailyTemp[]>()
  /** 每株对应的预报点标签 —— 提示语要把温度归给它，而不是归给院子 */
  const labelByPlant = new Map<number, string>()
  for (const plant of plants) {
    if (plant.envId === null) continue
    const env = envById.get(plant.envId)
    const days = daysByEnvId.get(plant.envId)
    if (!env || !days) continue
    const species = plant.species ? speciesById.get(plant.species.id) : undefined
    const attrs = (species?.attributes ?? {}) as Record<string, unknown>
    inputs.push({
      plantId: plant.id,
      plantName: plant.nickname,
      speciesName: plant.species?.commonName ?? null,
      placeName: env.name,
      coldHardiness: readNumberOrNull(attrs.cold_hardiness),
      heatTolerance: readNumberOrNull(attrs.heat_tolerance),
      frostProtected: env.frostProtected,
      canHeat: env.canHeat
    })
    daysByPlant.set(plant.id, days)
    labelByPlant.set(plant.id, daysLabel.get(plant.envId) ?? '')
  }

  const daily: WeatherRisk[] = []
  for (const input of inputs) {
    const days = daysByPlant.get(input.plantId)
    if (days) daily.push(...assessWeatherRisks([input], days, labelByPlant.get(input.plantId)))
  }

  return {
    configured: true,
    /*
     * **用实际的数据源，不是配置里的。**
     *
     * 和风失败时会静默退回 Open-Meteo，按配置写就会在换源时谎报来源和精度 ——
     * 用户会拿「数据来自和风天气 · 已到区县」去信这份预报。
     * actualProvider 由上面第一个成功的地点定下来。
     */
    providerLabel: (actualProvider ?? config.provider) === 'qweather' ? '和风天气' : 'Open-Meteo',
    fallbackReason,
    requestsToday: readUsage(db).count,
    places: places.map((p) => ({
      name: p.name,
      label: p.label,
      latitude: p.latitude,
      longitude: p.longitude,
      days: p.days,
      hours: p.hours,
      level: p.level,
      provider: p.provider
    })),
    risks: summarizeRisks(daily),
    daily,
    unknownCold: unjudgeable(inputs, 'frost').map((p) => p.plantName),
    unknownHeat: unjudgeable(inputs, 'heat').map((p) => p.plantName),
    fetchedAt,
    error
  }
}

/** 属性里的数字。空串和坏值都当作没填 —— Number('') 是 0，不能直接用。 */
function readNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
