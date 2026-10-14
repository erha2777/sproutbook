/**
 * 天气数据源 —— 两个实现，一套调用方式。
 *
 * ## 为什么要有第二个源
 *
 * Open-Meteo 免费、不用 key，本来是首选。但它是瑞士的全球模型，
 * **中国的区县库收录不全**：实测「某县县」0 条结果，而「邻县」「邻市」
 * 却查得到。这不是「支不支持县」，是**不可靠** —— 用户没法预知哪个能中。
 *
 * 和风天气做的是中国市场，区县级城市库是它的基本功，
 * 而且 GeoAPI 直接返回经纬度。
 *
 * ## 底线：不配 key 的人照样能用
 *
 * 没配和风的 key 就继续走 Open-Meteo。这不是「降级」，
 * 是两条等价的路 —— 一条免注册但中国区县不准，一条要注册但准。
 */

import type { Db } from '../db/connection'
import { getSetting, setSetting } from '../db/repo/misc'
import type { DailyTemp } from '../../core/weather'

export type WeatherProviderId = 'open-meteo' | 'qweather'

export const PROVIDER_LABELS: Record<WeatherProviderId, string> = {
  'open-meteo': 'Open-Meteo（免注册）',
  qweather: '和风天气（需 API Key）'
}

/** API Host 存在设置表里 —— 它不是秘密，本身就出现在请求 URL 中。 */
export const QWEATHER_HOST_KEY = 'weather.qweatherHost'
export const QWEATHER_KEY_KEY = 'weather.provider'
export const SELECTED_PROVIDER_KEY = 'weather.providerId'

const TIMEOUT_MS = 9000

export interface WeatherConfig {
  provider: WeatherProviderId
  /** 和风的专属 API Host，形如 h2a9cf3mhs.xy.qweatherapi.com */
  qweatherHost: string
  /** 从钥匙串取，不落库 */
  qweatherKey: string | null
  /** 能不能真的用和风：有 host 也有 key */
  qweatherReady: boolean
}

/**
 * 读出天气配置。
 *
 * **key 是传进来的，不在这里读钥匙串。**
 * 原因很实际：secrets.ts 依赖 electron 的 safeStorage，
 * 而自检是脱离 Electron 跑的 —— 在这里读钥匙串会让整个自检崩掉
 *（第一次就崩在 app.getPath 上）。依赖方向也该是这样：
 * 服务只管用 key，谁来提供由上层决定。
 */
export function readWeatherConfig(db: Db, qweatherKey: string | null = null): WeatherConfig {
  const saved = getSetting<string>(db, SELECTED_PROVIDER_KEY, '')
  const provider: WeatherProviderId = saved === 'qweather' ? 'qweather' : 'open-meteo'
  const qweatherHost = (getSetting<string>(db, QWEATHER_HOST_KEY, '') ?? '').trim()
  return {
    provider,
    qweatherHost,
    qweatherKey,
    qweatherReady: qweatherHost !== '' && (qweatherKey ?? '') !== ''
  }
}

export function saveWeatherConfig(db: Db, patch: { provider?: WeatherProviderId; qweatherHost?: string }): void {
  if (patch.provider) setSetting(db, SELECTED_PROVIDER_KEY, patch.provider)
  if (patch.qweatherHost !== undefined) setSetting(db, QWEATHER_HOST_KEY, patch.qweatherHost.trim())
}

// ---------------------------------------------------------------------------
// 地点解析
// ---------------------------------------------------------------------------

export interface GeoResult {
  /** 显示用，例如「中国 · 湖南 · 某市 · 某县」 */
  label: string
  latitude: number
  longitude: number
  /** 和风的 LocationID。取天气要用它 */
  locationId: string | null
  /**
   * 解析到了哪一级。
   * 界面上要如实说明 —— 「精确到区县」和「只到市」是两回事。
   */
  level: 'city' | 'district'
  /** 实际用的是哪个数据源 */
  provider: WeatherProviderId
}

export interface LocationQuery {
  province?: string | null
  city?: string | null
  /** 区/县/县级市。只有和风认这一级 */
  district?: string | null
}

interface QWeatherLocation {
  name?: string
  id?: string
  lat?: string
  lon?: string
  adm1?: string
  adm2?: string
  country?: string
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    // 断网、超时、DNS 失败一律当作「没数据」，绝不往上抛 —— 天气是锦上添花
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 和风的城市搜索。
 *
 * `adm` 参数按上级行政区过滤 —— 「某市」全国有四个（湖南/山西/江苏），
 * 不传这个就会指到别的省去。
 */
export async function qweatherLookup(
  config: WeatherConfig,
  query: LocationQuery
): Promise<GeoResult | null> {
  if (!config.qweatherReady) return null
  const wanted = (query.district ?? '').trim() || (query.city ?? '').trim()
  if (!wanted) return null

  const params = new URLSearchParams({
    location: wanted,
    number: '10',
    lang: 'zh',
    key: config.qweatherKey ?? ''
  })
  // adm 用省名（去掉「省/市/自治区」这类后缀，和风的 adm 是简称）
  const adm = (query.province ?? '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, '').trim()
  if (adm) params.set('adm', adm)

  const data = await fetchJson<{ code?: string; location?: QWeatherLocation[] }>(
    `https://${config.qweatherHost}/geo/v2/city/lookup?${params.toString()}`
  )
  // 和风的 code 是字符串："200" 才是成功
  if (!data || data.code !== '200' || !data.location?.length) return null

  const list = data.location
  const cityName = (query.city ?? '').trim()
  /*
   * 优先挑「名字里带区县，或者上级是我们要的那个市」的结果。
   * 光按第一个取会在重名时指错地方 —— 这和 Open-Meteo 那边是同一个坑。
   */
  const pick =
    list.find((x) => cityName && (x.adm2 ?? '') === cityName) ??
    list.find((x) => (x.name ?? '') === wanted) ??
    list[0]

  const lat = Number(pick.lat)
  const lon = Number(pick.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  // 名字和要查的一致、且带上级市，说明解析到了具体那一级
  const level: GeoResult['level'] = (pick.name ?? '') === wanted && (pick.adm2 ?? '') !== '' ? 'district' : 'city'

  return {
    label: [pick.country, pick.adm1, pick.adm2, pick.name].filter(Boolean).join(' · '),
    latitude: lat,
    longitude: lon,
    locationId: pick.id ?? null,
    level,
    provider: 'qweather'
  }
}

/** Open-Meteo 的地理编码。只到市级 —— 区县名字它多半认不出来。 */
export async function openMeteoLookup(query: LocationQuery): Promise<GeoResult | null> {
  const wanted = (query.city ?? '').trim()
  if (!wanted) return null

  const data = await fetchJson<{
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }>
  }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(wanted)}&count=10&language=zh&format=json`)
  if (!data?.results?.length) return null

  const adm = (query.province ?? '').replace(/省|市|自治区|特别行政区/g, '').trim()
  const pick =
    (adm
      ? data.results.find((r) => (r.admin1 ?? '').includes(adm) || adm.includes((r.admin1 ?? '').replace(/省|市/g, '')))
      : null) ?? data.results[0]

  return {
    label: [pick.country, pick.admin1, pick.name].filter(Boolean).join(' · '),
    latitude: pick.latitude,
    longitude: pick.longitude,
    locationId: null,
    level: 'city',
    provider: 'open-meteo'
  }
}

/**
 * 按配置解析地点。
 *
 * 顺序有讲究：**配了和风就先试和风**（它能到区县），失败再退 Open-Meteo。
 * 反过来的话，和风能解析出的区县永远轮不到。
 */
export async function lookupLocation(config: WeatherConfig, query: LocationQuery): Promise<GeoResult | null> {
  if (config.provider === 'qweather' && config.qweatherReady) {
    const hit = await qweatherLookup(config, query)
    if (hit) return hit
  }
  return openMeteoLookup(query)
}

// ---------------------------------------------------------------------------
// 取预报
// ---------------------------------------------------------------------------

interface QWeatherDaily {
  fxDate?: string
  tempMax?: string
  tempMin?: string
}

/**
 * 取未来几天的预报。
 *
 * 两个源的返回结构完全不同，但这里都归一成 DailyTemp[] ——
 * 上层的风险判断（core/weather.ts）只认这一种形状，
 * 换数据源不该动到判断逻辑。
 */
export async function fetchDaily(
  config: WeatherConfig,
  geo: GeoResult,
  days = 7
): Promise<DailyTemp[] | null> {
  if (geo.provider === 'qweather' && config.qweatherReady && geo.locationId) {
    const data = await fetchJson<{ code?: string; daily?: QWeatherDaily[] }>(
      `https://${config.qweatherHost}/v7/weather/${days === 3 ? '3d' : '7d'}?location=${encodeURIComponent(geo.locationId)}&key=${encodeURIComponent(config.qweatherKey ?? '')}`
    )
    if (data?.code === '200' && data.daily?.length) {
      const out: DailyTemp[] = []
      for (const d of data.daily) {
        const min = Number(d.tempMin)
        const max = Number(d.tempMax)
        // 缺项就跳过，不用 0 顶替 —— 那会凭空造出一场 0℃ 的寒潮
        if (!d.fxDate || !Number.isFinite(min) || !Number.isFinite(max)) continue
        out.push({ date: d.fxDate, tempMin: min, tempMax: max })
      }
      if (out.length > 0) return out
    }
    // 和风失败了就往下走 Open-Meteo，别让用户这次什么都看不到
  }

  const data = await fetchJson<{
    daily?: { time?: string[]; temperature_2m_min?: number[]; temperature_2m_max?: number[] }
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
      `&daily=temperature_2m_min,temperature_2m_max&forecast_days=${days}&timezone=auto`
  )
  const time = data?.daily?.time ?? []
  const mins = data?.daily?.temperature_2m_min ?? []
  const maxs = data?.daily?.temperature_2m_max ?? []
  const out: DailyTemp[] = []
  for (let i = 0; i < time.length; i++) {
    const tempMin = mins[i]
    const tempMax = maxs[i]
    if (typeof tempMin !== 'number' || typeof tempMax !== 'number') continue
    out.push({ date: time[i], tempMin, tempMax })
  }
  return out.length > 0 ? out : null
}
