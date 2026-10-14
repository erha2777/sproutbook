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

interface FetchOutcome<T> {
  data: T | null
  /** HTTP 状态码。0 表示连接根本没建立起来 */
  status: number
  /** 连接层失败的原因（DNS、超时、证书…） */
  transportError: string | null
  /** 响应体前几百个字符。失败时**必须留着** —— 服务端往往在里面说清楚了原因 */
  bodyPreview: string
}

/**
 * 带状态码的取 JSON。
 *
 * 之所以要带状态码：出问题时必须能分清「网络连不上」和
 * 「连上了但和风说你的 key 不对」—— 这两种情况的处理方式完全不同。
 */
async function fetchJsonDetailed<T>(url: string): Promise<FetchOutcome<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    /*
     * **不管成功失败都读 body。**
     *
     * 第一版在 !response.ok 时直接返回 null，然后在报错里断言「返回的不是 JSON」——
     * 可它根本没看过 body。而服务端的 403 往往带着 JSON 把原因写得清清楚楚
     *（和风就是 {"error":{"title":"Invalid Host",...}}）。
     * 不读就下结论，等于把用户往错的方向指。
     */
    const text = await response.text().catch(() => '')
    let parsed: T | null = null
    try {
      parsed = JSON.parse(text) as T
    } catch {
      parsed = null
    }
    return {
      data: parsed,
      status: response.status,
      transportError: null,
      bodyPreview: text.slice(0, 300)
    }
  } catch (error) {
    // 断网、超时、DNS 失败一律当作「没数据」，绝不往上抛 —— 天气是锦上添花
    return {
      data: null,
      status: 0,
      transportError: error instanceof Error ? error.message : String(error),
      bodyPreview: ''
    }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  return (await fetchJsonDetailed<T>(url)).data
}

/**
 * 和风的错误码 → 人话。
 *
 * 这些码是**必须区分开**的：403 要去查 key 和 Host，404 才是地名的问题。
 * 第一版把它们都吞成「查不到这个地名」，用户会去改完全无关的地方。
 */
const QWEATHER_ERRORS: Record<string, string> = {
  '204': '这个地点没有数据',
  '400': '请求参数有误（多半是 API Host 填错了）',
  '401': '认证失败：API Key 不对，或这个 Key 不属于这个 Host',
  '402': '超过访问次数或余额不足',
  '403': '无权限：检查 API Host 是否填成了控制台地址，或 Key 没开通 GeoAPI',
  '404': '查询的数据不存在',
  '429': '请求过于频繁，稍后再试',
  '500': '和风服务器错误'
}

export interface LookupOutcome {
  geo: GeoResult | null
  /** 和风返回的业务码，诊断时原样显示 */
  code: string | null
  /** 人话解释。成功时为 null */
  error: string | null
}

/**
 * 和风的城市搜索（带诊断）。
 *
 * `adm` 参数按上级行政区过滤 —— 「某市」全国有四个（湖南/山西/江苏），
 * 不传这个就会指到别的省去。
 */
export async function qweatherLookupDetailed(
  config: WeatherConfig,
  query: LocationQuery
): Promise<LookupOutcome> {
  if (!config.qweatherHost) return { geo: null, code: null, error: '还没填 API Host' }
  if (!config.qweatherKey) return { geo: null, code: null, error: '还没填 API Key' }

  const wanted = (query.district ?? '').trim() || (query.city ?? '').trim()
  if (!wanted) return { geo: null, code: null, error: '没有要查的地名' }

  const params = new URLSearchParams({
    location: wanted,
    number: '10',
    lang: 'zh',
    key: config.qweatherKey
  })
  const adm = (query.province ?? '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, '').trim()
  if (adm) params.set('adm', adm)

  const url = `https://${config.qweatherHost}/geo/v2/city/lookup?${params.toString()}`
  const outcome = await fetchJsonDetailed<{ code?: string; location?: QWeatherLocation[] }>(url)

  if (outcome.transportError) {
    return { geo: null, code: null, error: `连不上 ${config.qweatherHost}：${outcome.transportError.slice(0, 60)}` }
  }
  if (outcome.status === 0) {
    return { geo: null, code: null, error: `连不上 ${config.qweatherHost}` }
  }

  const data = outcome.data
  if (!data) {
    /*
     * 状态不是 2xx，或者 body 不是 JSON。
     * 这时候**把 body 原文摆出来** —— 服务端一般已经说清楚了，
     * 我替它转述只会再错一次。
     */
    const preview = outcome.bodyPreview.replace(/\s+/g, ' ').trim()
    return {
      geo: null,
      code: null,
      error: preview
        ? `HTTP ${outcome.status}，返回内容：${preview}`
        : `HTTP ${outcome.status}，响应体是空的`
    }
  }

  // 新版错误体：{"error":{"status":403,"title":"...","detail":"..."}}
  const errBody = (data as { error?: { title?: string; detail?: string } }).error
  if (errBody) {
    return {
      geo: null,
      code: String(errBody.title ?? ''),
      error: `和风返回 ${errBody.title ?? '错误'}：${errBody.detail ?? ''}`
    }
  }

  const code = data.code ?? null
  if (code !== '200') {
    const known = code ? QWEATHER_ERRORS[code] : null
    return {
      geo: null,
      code,
      error: known ? `和风返回 ${code}：${known}` : `和风返回了未知状态码 ${code ?? '（空）'}（HTTP ${outcome.status}）`
    }
  }

  const list = data.location ?? []
  if (list.length === 0) {
    return { geo: null, code, error: `和风认得这个 Host 和 Key，但查不到「${wanted}」这个地名` }
  }

  const cityName = (query.city ?? '').trim()
  const pick =
    list.find((x) => cityName && (x.adm2 ?? '') === cityName) ??
    list.find((x) => (x.name ?? '') === wanted) ??
    list[0]

  const lat = Number(pick.lat)
  const lon = Number(pick.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { geo: null, code, error: `和风返回了「${pick.name ?? '?'}」但坐标解析不出来` }
  }

  const level: GeoResult['level'] = (pick.name ?? '') === wanted && (pick.adm2 ?? '') !== '' ? 'district' : 'city'
  return {
    geo: {
      label: [pick.country, pick.adm1, pick.adm2, pick.name].filter(Boolean).join(' · '),
      latitude: lat,
      longitude: lon,
      locationId: pick.id ?? null,
      level,
      provider: 'qweather'
    },
    code,
    error: null
  }
}

/** 取天气时只关心成不成，诊断信息丢掉。 */
export async function qweatherLookup(config: WeatherConfig, query: LocationQuery): Promise<GeoResult | null> {
  return (await qweatherLookupDetailed(config, query)).geo
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
