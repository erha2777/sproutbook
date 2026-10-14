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
  fetchDaily,
  lookupLocation,
  readWeatherConfig,
  type GeoResult,
  type WeatherConfig
} from './weather-providers'
import { getSetting, setSetting, listEnvironments } from '../db/repo/misc'
import { listPlants } from '../db/repo/plants'
import { listSpecies } from '../db/repo/species'
import {
  assessWeatherRisks,
  summarizeRisks,
  unjudgeable
} from '../../core/weather'
import type { DailyTemp, WeatherRisk, WeatherRiskInput } from '../../core/weather'

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

/** 缓存多久。预报一天更新几次就够，没必要每次开页面都请求。 */
const CACHE_TTL_MS = 3 * 60 * 60 * 1000
const TIMEOUT_MS = 8000

const CACHE_KEY = 'weather.forecastCache'
const GEOCODE_KEY = 'weather.geocodeCache'

export interface GeoPoint {
  latitude: number
  longitude: number
  /** 接口返回的规范地名，用来显示「取到的是哪里」 */
  label: string
}

export interface ForecastResult {
  point: GeoPoint
  days: DailyTemp[]
  /** 取回的时间（ISO），界面用来显示「几点的数据」 */
  fetchedAt: string
}

interface CacheEntry extends ForecastResult {
  key: string
  at: number
}

/** 带超时的 fetch。超时和网络错误都当成「没有」处理，不往上抛。 */
async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    // 断网、DNS 失败、超时、证书问题 —— 全部安静地当作没有数据
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 城市名 → 经纬度。
 *
 * 解析结果会缓存进设置表：城市不会变，没必要每次开页面都查一遍。
 * 用户手动填了经纬度时**根本不会走到这里**。
 */
export async function geocode(db: Db, city: string, province?: string | null): Promise<GeoPoint | null> {
  const name = city.trim()
  if (!name) return null

  const cache = getSetting<Record<string, GeoPoint>>(db, GEOCODE_KEY, {})
  const cacheKey = `${province ?? ''}|${name}`
  const hit = cache[cacheKey]
  if (hit) return hit

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=5&language=zh&format=json`
  const data = await fetchJson<{
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }>
  }>(url)
  if (!data?.results?.length) return null

  /*
   * 有省份就优先选省份对得上的那个。
   * 「某市」这类地名在国内有重名，光按第一个结果取会指到别的省去 ——
   * 而用户是填了省份的，那就该用上。
   */
  const wantProvince = (province ?? '').trim()
  const pick =
    (wantProvince ? data.results.find((r) => (r.admin1 ?? '').includes(wantProvince) || wantProvince.includes(r.admin1 ?? '')) : null) ??
    data.results[0]

  const point: GeoPoint = {
    latitude: pick.latitude,
    longitude: pick.longitude,
    label: [pick.country, pick.admin1, pick.name].filter(Boolean).join(' · ')
  }
  cache[cacheKey] = point
  setSetting(db, GEOCODE_KEY, cache)
  return point
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
): Promise<DailyTemp[] | null> {
  const key = `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`
  const cache = getSetting<Record<string, CacheEntry>>(db, CACHE_KEY, {})
  const hit = cache[key]
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS && (hit as CacheEntry & { provider?: string }).provider === point.provider) {
    return hit.days
  }

  const days = await fetchDaily(config, point)
  if (!days) return null

  cache[key] = { key, at: Date.now(), point: { latitude: point.latitude, longitude: point.longitude, label: point.label }, days, fetchedAt: new Date().toISOString() } as CacheEntry
  ;(cache[key] as CacheEntry & { provider?: string }).provider = point.provider
  setSetting(db, CACHE_KEY, cache)
  return days
}

/** 清掉天气缓存。用户在设置里手动刷新时用。 */
export function clearWeatherCache(db: Db): void {
  setSetting(db, CACHE_KEY, {})
}

// ---------------------------------------------------------------------------
// 把「哪株植物、在哪儿、那地方未来几天什么天气」拼起来
// ---------------------------------------------------------------------------

export interface WeatherWarningResult {
  /** 这次实际用的是哪个数据源，界面要说明白 */
  providerLabel: string
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
  const daysByEnvId = new Map<number, DailyTemp[]>()
  /** 每个环境对应的预报点显示名，例如「中国 · 湖南 · 某市」 */
  const daysLabel = new Map<number, string>()
  let fetchedAt: string | null = null
  let error: string | null = null

  // 坐标相同的地点（比如「南向阳台」和「露台」都填了同一个城市）只请求一次
  const daysByPoint = new Map<string, DailyTemp[]>()

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
      point = await lookupLocation(config, {
        province: env.province,
        city: env.city,
        district: env.district
      })
      if (!point) {
        error = error ?? `没能定位「${env.district || env.city || env.name}」`
        continue
      }
      // 定位成功就写回档案：下次不用再查，也让用户看得见用的是哪个坐标
      db.run('UPDATE environments SET lat = ?, lon = ? WHERE id = ?', point.latitude, point.longitude, env.id)
    }

    const pointKey = `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`
    let days = daysByPoint.get(pointKey)
    if (!days) {
      const fetched = await getForecast(db, config, point, force)
      if (!fetched) {
        error = error ?? '没能取到天气预报'
        continue
      }
      days = fetched
      daysByPoint.set(pointKey, days)
      places.push({
        name: env.name,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        days,
        // 精度要摆在明面上：区县级和市级是两回事
        level: point.level,
        provider: point.provider
      })
      fetchedAt = new Date().toISOString()
    }
    daysByEnvId.set(env.id, days)
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
    providerLabel: config.provider === 'qweather' && config.qweatherReady ? '和风天气' : 'Open-Meteo',
    places: places.map((p) => ({
      name: p.name,
      label: p.label,
      latitude: p.latitude,
      longitude: p.longitude,
      days: p.days,
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
