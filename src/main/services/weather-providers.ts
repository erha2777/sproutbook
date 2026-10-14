/**
 * 天气数据源 —— 两个实现，一套调用方式。
 *
 * ## 为什么要有第二个源
 *
 * Open-Meteo 免费、不用 key，本来是首选。但它是瑞士的全球模型，
 * **中国的区县库收录不全**：实测「湘阴县」0 条结果，而「华容县」「汨罗市」
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

/** API Host 存在设置表里 —— 它不是秘密，本身就出现在请求 URL 中。 */
export const QWEATHER_HOST_KEY = 'weather.qweatherHost'
/** 地名解析结果的缓存。地名不会变，解析一次就够 */
export const GEOCODE_CACHE_KEY = 'weather.geocodeCache'
/** 当天向数据源发了几次请求。和风免费额度有限，这个数字要给用户看见 */
export const USAGE_KEY = 'weather.usage'
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
// 用量记账
// ---------------------------------------------------------------------------

export interface WeatherUsage {
  /** YYYY-MM-DD（本地日期） */
  date: string
  count: number
}

/**
 * 记一次对外请求。
 *
 * 和风的免费额度是按天的（用户提到每天一千次左右），而天气判断本身很省
 *（有 3 小时缓存），真正会烧额度的是「重新获取」被连点。
 * 把数字摆在界面上，用户自己就能发现异常。
 */
export function countRequest(db: Db): number {
  const today = new Date().toISOString().slice(0, 10)
  const usage = getSetting<WeatherUsage>(db, USAGE_KEY, { date: today, count: 0 })
  const next: WeatherUsage = usage.date === today ? { date: today, count: usage.count + 1 } : { date: today, count: 1 }
  setSetting(db, USAGE_KEY, next)
  return next.count
}

export function readUsage(db: Db): WeatherUsage {
  const today = new Date().toISOString().slice(0, 10)
  const usage = getSetting<WeatherUsage>(db, USAGE_KEY, { date: today, count: 0 })
  return usage.date === today ? usage : { date: today, count: 0 }
}

// ---------------------------------------------------------------------------
// 地点解析
// ---------------------------------------------------------------------------

export interface GeoResult {
  /** 显示用，例如「中国 · 湖南 · 岳阳 · 湘阴」 */
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

/**
 * 和风的英文错误标题 → **该去改什么**。
 *
 * 光把英文原文转给用户等于让他自己去查。这些错都是配置问题，
 * 每一种都有明确的去处，那就直接说去处。
 */
const QWEATHER_ERROR_ADVICE: Record<string, string> = {
  /*
   * 这一个标题覆盖**两种**限制，别只看一种就下结论。
   *
   * 我第一版只写了「安全限制」（IP / Referer），结果用户踩的是
   * 「API 限制 → 指定数据」里没勾 GeoAPI —— 照那个提示去改会改错地方。
   * 所以两种都列出来，并且把更常见的「没勾 GeoAPI」放前面。
   */
  'Security Restriction':
    '凭据的「API 限制」或「安全限制」挡住了这个请求。两种都查一下：' +
    '① 控制台 → 凭据 → API 限制：如果选了「指定数据」，确认 **GeoAPI** 在勾选列表里（定位地名正是靠它）；' +
    '② 控制台 → 设置 → 安全限制：如果开了 IP / Referer 白名单，改成「不限制」——' +
    '桌面应用不发 Referer，白名单一定拦；IP 白名单也会因为家里宽带换 IP 而失效。',
  'Invalid Host': 'API Host 填错了。到控制台 → 设置 里复制你自己的那串，注意别带 https:// 前缀。',
  Unauthorized: '凭据无效。检查 API Key 是否复制完整（前后别带空格），或它是否属于这个 API Host。',
  /*
   * 403 和 429 各有**两种**含义，而且和风的公告明确说了
   * 「超过每日请求量限制后返回 403 或 429」——
   * 只写「Host 填错了」的话，用户额度用完时会去改一个完全正确的东西。
   */
  Forbidden:
    '两种可能：① 这个凭据没有访问 GeoAPI 的权限（到控制台给它勾上）；' +
    '② 当天的请求量用完了。和风对 API KEY 限 1000 次/天（2027-02-01 起生效），' +
    '用 JWT 认证则无限制。超额后继续猛发请求可能被封 IP，先停下来。',
  'Invalid Parameter': '请求参数有误，多半是 API Host 里混进了多余字符。',
  'Too Many Requests':
    '两种可能：① 调用太频繁，过一会儿再试；' +
    '② 当天的请求量用完了（API KEY 限 1000 次/天）。超额后继续猛发可能被封 IP，先停下来。',
  'Invalid Token': '凭据无效，重新复制一次 API Key。'
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
 * `adm` 参数按上级行政区过滤 —— 「岳阳」全国有四个（湖南/山西/江苏），
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
    const title = String(errBody.title ?? '')
    const advice = QWEATHER_ERROR_ADVICE[title]
    return {
      geo: null,
      code: title,
      error: advice
        ? `和风拒绝了这个请求（${title}）——${advice}`
        : `和风返回 ${title || '错误'}：${errBody.detail ?? ''}`
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
 * 按配置解析地点，结果缓存起来。
 *
 * ## 顺序：配了和风就先试和风
 *
 * 它能到区县。反过来的话，和风能解析出的区县永远轮不到。
 * 和风失败时退 Open-Meteo，不让用户这次什么都看不到。
 *
 * ## 缓存键里为什么要带「实际会用哪个源」
 *
 * 用户先不配 key 用了几天（缓存的都是 Open-Meteo 的市级结果），
 * 后来补上和风的 key —— 如果键里不带源，就会一直吃那份旧的市级缓存，
 * 配了也白配。带上源之后，配置一变键就变，自然重新解析。
 */
export async function lookupLocation(
  db: Db,
  config: WeatherConfig,
  query: LocationQuery
): Promise<GeoResult | null> {
  // 「实际会用哪个源」而不是「用户选了哪个」—— 配了和风但没配齐时实际是 Open-Meteo
  const source: WeatherProviderId = config.provider === 'qweather' && config.qweatherReady ? 'qweather' : 'open-meteo'
  const key = [source, query.province ?? '', query.city ?? '', query.district ?? ''].join('|')

  const cache = getSetting<Record<string, GeoResult>>(db, GEOCODE_CACHE_KEY, {})
  const hit = cache[key]
  if (hit) return hit

  countRequest(db)
  const result = source === 'qweather' ? await qweatherLookup(config, query) : await openMeteoLookup(query)
  // 失败**不缓存** —— 网络抖一下不该让这个地名永久失效
  if (result) {
    cache[key] = result
    setSetting(db, GEOCODE_CACHE_KEY, cache)
  }
  return result
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
/**
 * 取每日温度的结果。
 *
 * ## 为什么还要回一个「实际用了哪个源」
 *
 * 和风失败时会**静默退回 Open-Meteo**（别让用户这次什么都看不到）。
 * 调用方如果按配置去写「数据来自和风天气」，就会在换源时**谎报来源和精度** ——
 * 而设置页恰好教用户「填经纬度会更准」，正好触发这条假来源。
 *
 * **配置里选了什么，和这次实际用了什么，是两件事。**
 */
export interface DailyFetch {
  days: DailyTemp[]
  /** 这次**实际**用的数据源，不是配置里的那个 */
  provider: WeatherProviderId
  /** 和风被跳过的原因。实际用了和风时为 null */
  fallbackReason: string | null
}

/**
 * 为什么这次用不上和风？——**纯函数，可以脱机自检**。
 *
 * 抽出来是因为这段判断原本埋在联网的 fetchDaily 里，自检碰不到它。
 * 而它决定的正是「界面要不要告诉用户换源了」——
 * 一段只有真联网才跑得到的逻辑，等于没有回归保护。
 *
 * @param qweatherData 真的请求过和风时的响应体；没请求就传 undefined
 * @returns null 表示和风可用（或用户本来就没选它），否则是给用户看的原因
 */
export function qweatherSkipReason(
  config: WeatherConfig,
  geo: Pick<GeoResult, 'provider' | 'locationId'>,
  qweatherData?: { code?: string; daily?: unknown[] } | null
): string | null {
  const tried = geo.provider === 'qweather' && config.qweatherReady && Boolean(geo.locationId)

  if (tried) {
    // 走到这里说明请求过了但没拿到可用数据
    if (qweatherData?.code === '200' && qweatherData.daily?.length) return null
    /*
     * code === '200' 但没有逐日数据：**不能说「和风返回 200」** ——
     * 那读起来像成功，用户根本不知道出了什么事。
     * 200 只代表请求通了，不代表里面有东西。
     */
    if (qweatherData?.code === '200') return '和风请求成功，但返回的数据里没有可用的逐日预报'
    return qweatherData?.code ? `和风返回 ${qweatherData.code}` : '和风没有返回可用的数据'
  }

  // 压根没尝试 —— 只有用户选了和风才需要解释
  if (config.provider !== 'qweather') return null
  return geo.locationId ? '和风配置不完整' : '这个地点没有和风的 locationId（多半是手填的经纬度）'
}

export async function fetchDaily(
  config: WeatherConfig,
  geo: GeoResult,
  days = 7
): Promise<DailyFetch | null> {
  let fallbackReason: string | null = null

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
      if (out.length > 0) return { days: out, provider: 'qweather', fallbackReason: null }
    }
    /*
     * 和风失败了就往下走 Open-Meteo，别让用户这次什么都看不到。
     * 但**要记住为什么** —— 界面上得说出来，不能假装什么都没发生。
     */
    fallbackReason = qweatherSkipReason(config, geo, data)
  } else if (config.provider === 'qweather') {
    fallbackReason = qweatherSkipReason(config, geo)
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
  return out.length > 0 ? { days: out, provider: 'open-meteo', fallbackReason } : null
}
