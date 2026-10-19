import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button, Notice, Panel, ToastProvider, cx, useToast } from './components/ui'
import { TitleBar } from './components/TitleBar'
import { Backdrop } from './components/Backdrop'
import { THEME_BACKDROP, resolveBackdrops } from '@core/media'
import { PixelIcon, setIconUrls } from './components/PixelIcon'
import { TopHud } from './components/TopHud'
import { GardenPage } from './pages/GardenPage'
import { SpeciesPage } from './pages/SpeciesPage'
import { SpeciesEditor } from './pages/SpeciesEditor'
import { TemplatesPage } from './pages/TemplatesPage'
import { SettingsPage } from './pages/SettingsPage'
import { RecipesPage } from './pages/RecipesPage'
import { CarePage } from './pages/CarePage'
import { TodayPage } from './pages/TodayPage'
import { LogsPage } from './pages/LogsPage'
import { HomePage } from './pages/HomePage'
import { isSfxOn, setSfx, sfx } from './lib/sfx'
import { pendingBuckets, todayIso } from '@core/care'

type CareTab = 'today' | 'plans' | 'logs' | 'recipes'

type Route =
  | { name: 'home' }
  | { name: 'garden' }
  | { name: 'species' }
  | { name: 'species-edit'; id: number | null }
  | { name: 'care'; tab: CareTab }
  | { name: 'templates'; owner: 'species' | 'plant' }
  | { name: 'settings' }

/** 养护子页（首页「养护」进去后的四个 tab） */
const CARE_TABS: Array<{ key: CareTab; icon: string; label: string }> = [
  { key: 'today', icon: 'sun', label: '今日' },
  { key: 'plans', icon: 'calendar', label: '养护计划' },
  { key: 'logs', icon: 'journal', label: '养护日志' },
  { key: 'recipes', icon: 'flask', label: '配方' }
]

const HASH_TO_ROUTE: Record<string, Route['name']> = {
  home: 'home',
  garden: 'garden',
  species: 'species',
  care: 'care',
  templates: 'templates',
  settings: 'settings'
}

/**
 * 从 URL hash 还原当前页面。
 * 这样刷新不会跳回首页，也让「界面自检」可以逐页截图。
 *
 * 旧链接（#/today、#/plans、#/logs、#/recipes）继续能用 —— 它们现在归到
 * 「养护」的对应 tab 下，书签和自检脚本不会失效。
 */
function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  if (raw === 'today' || raw === 'plans' || raw === 'logs' || raw === 'recipes') {
    return { name: 'care', tab: raw }
  }
  if (raw === 'templates') return { name: 'templates', owner: 'species' }
  if (raw === 'home' || raw === '') return { name: 'home' }
  const name = HASH_TO_ROUTE[raw]
  if (name === 'care') return { name: 'care', tab: 'today' }
  if (name === 'templates') return { name: 'templates', owner: 'species' }
  return name ? ({ name } as Route) : { name: 'home' }
}

function hashForRoute(route: Route): string {
  if (route.name === 'species-edit') return '#/species'
  if (route.name === 'care') return `#/${route.tab}`
  if (route.name === 'templates') return '#/templates'
  return `#/${route.name}`
}


export default function App(): ReactNode {
  return (
    <ToastProvider>
      <Sky />
      <Shell />
    </ToastProvider>
  )
}

/** 参考图里的蓝天白云背景。纯 CSS，不用任何图片资源。 */
function Sky(): ReactNode {
  return (
    <div className="sky" aria-hidden>
      <div className="sky-sun" />
      <div className="sky-stars" />
      <div className="cloud c1" />
      <div className="cloud c2" />
      <div className="cloud c3" />
      <div className="cloud c4" />
      <div className="cloud c5" />
      <div className="cloud c6" />
      <div className="cloud c7" />
      <div className="ground" />
    </div>
  )
}

function Shell(): ReactNode {
  const toast = useToast()
  const [route, setRoute] = useState<Route>(routeFromHash)
  /** 界面音效开关：默认开，首页喇叭图标可关 */
  const [soundOn, setSoundOn] = useState(isSfxOn)
  /** 私有背景图：首页背后缓慢飘动的截图 */
  /** 主题自带的背景（theme.json 的 backgrounds） */
  const [baseBackdrops, setBaseBackdrops] = useState<string[]>([])
  /** 用户自己上传的背景图（名字用于匹配偏好） */
  const [uploadedBackdrops, setUploadedBackdrops] = useState<Array<{ name: string; url: string }>>([])
  /** 选中的背景文件名；null = 全部轮播 */
  const [backdropPref, setBackdropPref] = useState<string | null>(null)
  /** 设置页改了音乐/背景后，靠这个计数重跑加载 */
  const [mediaVersion, setMediaVersion] = useState(0)
  /** 正在播放的私有背景音乐（没有就是 null） */
  const [musicName, setMusicName] = useState<string | null>(null)
  const [musicPlaying, setMusicPlaying] = useState(false)
  /**
   * 背景音乐（私有）：<userData>/textures/music 下的音频，循环播放。
   * 和音效共用一个静音开关（soundOn）。
   */
  const audioRef = useRef<HTMLAudioElement | null>(null)

  /**
   * 兼容模式首启提示。
   *
   * 触发条件：当前进程是用 --no-sandbox 启动的（说明用户只能靠启动器运行），
   * 但桌面上还没有兼容模式快捷方式。这时主动提示一键创建，
   * 用户就不用自己去设置页里找了。
   */
  const [compatHint, setCompatHint] = useState(false)

  /** 版本号从主进程读，避免界面写死后与 package.json 脱节 */
  const [appVersion, setAppVersion] = useState<string | null>(null)

  /** 侧栏角标：已过期 + 该做了的养护任务数 */
  const [carePending, setCarePending] = useState(0)

  /**
   * 重新取角标数量。
   *
   * 这个数字必须能被刷新 —— 第一版只在挂载时取一次，于是打完勾、
   * 页面上明明显示「逾期 0、该做 0」，侧栏那个红点还挂着，看着像没生效。
   *
   * **口径和今日页完全一致**：取全部未完成任务，按 core 的 pendingBuckets
   * 数「已过期 + 该做」。原先用 careOverview（只统计本年、按到期日筛），
   * 会出现「侧栏 12、今日 10、养护计划 6」三个数字并存的情况。
   */
  const refreshCareBadge = useCallback(async () => {
    try {
      const open = await window.api.care.tasks({ status: 'open' })
      const buckets = pendingBuckets(open, todayIso())
      setCarePending(buckets.overdue.length + buckets.due.length)
    } catch {
      // 养护表还没就绪时静默跳过，不因为角标影响启动
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setAppVersion((await window.api.app.info()).version)
      } catch {
        // 拿不到就不显示版本号，不影响使用
      }
    })()
  }, [])

  useEffect(() => {
    void refreshCareBadge()
  }, [refreshCareBadge, route.name])

  useEffect(() => {
    void (async () => {
      try {
        if (window.localStorage.getItem('sproutbook.compatHintDismissed') === '1') return
        const status = await window.api.sandbox.status()
        if (status.disabled && status.canCreateShortcut && !status.shortcuts.some((s) => s.exists)) {
          setCompatHint(true)
        }
      } catch {
        // 拿不到状态就不提示，绝不因为提示逻辑影响启动
      }
    })()
  }, [])

  // 路由 → hash 同步，并支持浏览器前进/后退
  useEffect(() => {
    const target = hashForRoute(route)
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target)
    }
  }, [route])

  useEffect(() => {
    const onHashChange = (): void => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  /*
   * 全局点击音效。
   * 捕获阶段监听，按钮自己的 onClick 改了什么状态都不影响判断；
   * 只对 <button> 生效，输入框、下拉、卡片不响。
   */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      const button = target?.closest('button')
      if (!button || button.disabled) return
      const label = button.textContent?.trim() ?? ''
      if (label === '完成') sfx('success')
      else sfx('click')
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  /*
   * 私有字体（可选）：<userData>/fonts 里放了字体就换成它。
   *
   * 为什么不打包进 assets：HZK / IPix 这类字体的字模版权不清晰，
   * 放进公开仓库有风险。放 userData 只有本机生效，仓库与 CI 都不受影响。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { custom } = await window.api.app.fonts()
        if (!custom || cancelled) return
        const face = new FontFace('Sproutbook Custom', `url(${custom})`)
        await face.load()
        document.fonts.add(face)
        document.documentElement.style.setProperty(
          '--ui-font',
          `'Sproutbook Custom', 'Fusion Pixel', 'Microsoft YaHei', 'PingFang SC', sans-serif`
        )
      } catch {
        // 字体坏了就当没装，继续用默认像素字体
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * data URL → blob URL。
   *
   * 为什么不用 data URL 直接写进 CSS 变量：大图（2MB+ base64）作为自定义属性
   * 会被浏览器截断/丢弃，背景图就"静默不显示"；blob URL 只有几十个字符，稳。
   */
  const dataUrlToObjectUrl = (dataUrl: string): string | null => {
    try {
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return null
      const mime = /data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? 'image/png'
      const binary = atob(dataUrl.slice(comma + 1))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return URL.createObjectURL(new Blob([bytes], { type: mime }))
    } catch {
      return null
    }
  }

  // 首页/内页用不同的背景压暗程度
  useEffect(() => {
    document.documentElement.classList.toggle('is-home', route.name === 'home')
  }, [route.name])

  /*
   * 私有素材（可选）：<userData>/textures 里有图片就套上。
   * 星露谷 wiki 的图是版权素材，不能随仓库分发 —— 只在本机生效。
   */
  useEffect(() => {
    void (async () => {
      try {
        const { slots, slices, backgrounds, icons } = await window.api.app.textures()
        if (backgrounds.length > 0) setBaseBackdrops(backgrounds)
        setIconUrls(icons)
        const root = document.documentElement
        const vars: Array<[string, string, string]> = [
          ['home-bg', '--tex-home-bg', 'tex-home'],
          ['sign', '--tex-sign', 'tex-sign'],
          ['button', '--tex-button', 'tex-button'],
          ['panel', '--tex-panel', 'tex-panel'],
          ['cloud', '--tex-cloud', 'tex-cloud']
        ]
        const blobUrls: Record<string, string> = {}
        for (const [slot, cssVar, cls] of vars) {
          const raw = slots[slot]
          if (!raw) continue
          const url = dataUrlToObjectUrl(raw) ?? raw
          blobUrls[slot] = url
          root.style.setProperty(cssVar, `url("${url}")`)
          root.classList.add(cls)
          const slice = slices?.[slot]
          if (slice) {
            // border-image-slice 只认数字，单位由 CSS 里 calc(*1px) 补
            const [t, r, b, l] = Array.isArray(slice) ? slice : [slice, slice, slice, slice]
            root.style.setProperty(`--tex-${slot}-slice`, String(t))
            root.style.setProperty(`--tex-${slot}-slice-t`, String(t))
            root.style.setProperty(`--tex-${slot}-slice-r`, String(r))
            root.style.setProperty(`--tex-${slot}-slice-b`, String(b))
            root.style.setProperty(`--tex-${slot}-slice-l`, String(l))
            root.classList.add(`tex-${slot}-slice`)
          }
        }
        /*
         * 木牌是整张图，比例各不相同 —— 读一下真实宽高写进 CSS 变量，
         * 让牌子的 aspect-ratio 跟着图走，别把图拉扁。
         */
        if (blobUrls.sign) {
          const probe = new Image()
          probe.onload = () => {
            if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
              root.style.setProperty('--tex-sign-ratio', String(probe.naturalWidth / probe.naturalHeight))
            }
          }
          probe.src = blobUrls.sign
        }
      } catch {
        // 素材读不到就用画出来的默认外观
      }
    })()
  }, [])

  /*
   * 背景音乐：播放设置里选中的那首（没选就用第一首），循环，音量 0.3。
   * 设置页换了歌会通过 sproutbook:media 事件触发重跑（见下面的 mediaVersion）。
   */
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const [tracks, prefs] = await Promise.all([window.api.app.music(), window.api.app.mediaPrefs()])
        if (disposed || tracks.length === 0) return
        const track = tracks.find((t) => t.name === prefs.musicTrack) ?? tracks[0]
        setMusicName(track.name)
        const audio = new Audio(track.url)
        audio.loop = true
        audio.volume = 0.3
        audioRef.current = audio
        if (!isSfxOn()) return
        try {
          await audio.play()
          setMusicPlaying(true)
        } catch {
          const resume = (): void => {
            if (isSfxOn()) void audio.play().then(() => setMusicPlaying(true)).catch(() => undefined)
            window.removeEventListener('pointerdown', resume)
          }
          window.addEventListener('pointerdown', resume, { once: true })
        }
      } catch {
        // 没有音乐就安静地放着
      }
    })()
    return () => {
      disposed = true
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [mediaVersion])


  /*
   * 设置页改了音乐/背景之后，用 window 事件通知这里重跑加载。
   * 比引入全局状态轻：只有一个"变了"的信号，数据还是各自去取。
   */
  useEffect(() => {
    const reload = (): void => setMediaVersion((v) => v + 1)
    window.addEventListener('sproutbook:media', reload)
    return () => window.removeEventListener('sproutbook:media', reload)
  }, [])

  // 用户自己放的背景图 + 选中的是哪一张
  //
  // 用 allSettled：这两个请求一个失败不该把另一个也拖下水 ——
  // 之前 Promise.all 一起 reject 时，偏好和列表同时丢掉，背景直接变回默认，看着像"背景没了"。
  useEffect(() => {
    void (async () => {
      const [list, prefs] = await Promise.allSettled([window.api.app.backdrops(), window.api.app.mediaPrefs()])
      if (list.status === 'fulfilled') setUploadedBackdrops(list.value)
      if (prefs.status === 'fulfilled') setBackdropPref(prefs.value.backdrop)
    })()
  }, [mediaVersion])

  /*
   * 选中的那张如果不在列表里（扫描失败、文件刚被占用），单独问一次它的 URL。
   * 再拿不到就退回"全部轮播" —— 宁可显示别的，也不能因为解析不出来让背景一片空白。
   */
  const [directBackdrop, setDirectBackdrop] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!backdropPref || backdropPref === THEME_BACKDROP || uploadedBackdrops.some((b) => b.name === backdropPref)) {
      setDirectBackdrop(null)
      return () => {
        alive = false
      }
    }
    void window.api.app
      .backdropUrl(backdropPref)
      .then((url) => {
        if (alive) setDirectBackdrop(url)
      })
      .catch(() => {
        if (alive) setDirectBackdrop(null)
      })
    return () => {
      alive = false
    }
  }, [backdropPref, uploadedBackdrops])

  /* 实际用于渲染的背景：选主题 / 选某一张 / 全部轮播 */
  const backdrops = useMemo(
    () => resolveBackdrops(baseBackdrops, uploadedBackdrops, backdropPref, directBackdrop),
    [baseBackdrops, uploadedBackdrops, backdropPref, directBackdrop]
  )
  // 静音开关同时控制背景音乐
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (soundOn) void audio.play().then(() => setMusicPlaying(true)).catch(() => undefined)
    else {
      audio.pause()
      setMusicPlaying(false)
    }
  }, [soundOn])

  // 首次进入时做一次环境自检，把明显的问题尽早告诉用户
  useEffect(() => {
    void (async () => {
      try {
        const paths = await window.api.app.paths()
        if (!paths.encryptionAvailable) {
          toast.push('系统钥匙串不可用：API Key 将以明文保存在本机，请注意不要在共享电脑上使用。', 'error')
        }
      } catch {
        // 拿不到路径不阻断使用
      }
    })()
  }, [toast])

  /*
   * 全局声音开关：固定在窗口左上角，所有分区都能按（原来只在首页左下角）。
   * 和右上角的最小化/最大化一左一右，位置对称。
   */
  const toggleSound = (): void => {
    const next = !soundOn
    setSoundOn(next)
    setSfx(next)
    if (next) sfx('success')
  }
  const soundToggle = (
    <button
      type="button"
      className="home-gear global-sound"
      title={soundOn ? '关闭声音（音效 + 背景音乐）' : '开启声音（音效 + 背景音乐）'}
      aria-label={soundOn ? '关闭声音' : '开启声音'}
      onClick={toggleSound}
    >
      <PixelIcon name={soundOn ? 'sound' : 'mute'} size={24} />
    </button>
  )

  /*
   * 首页是**标题画面**，不套导航：它把应用收成四个入口。
   * 其余页面**没有横向导航**，只靠右下角的「← 后退」回首页再换分区
   * （和参考图一致：分区里不摆一排入口）。
   */
  if (route.name === 'home') {
    return (
      <div className="app-frame">
        <Backdrop images={backdrops} />
        <TitleBar />
        <HomePage
          version={appVersion}
          carePending={carePending}
          onGarden={() => setRoute({ name: 'garden' })}
          onSpecies={() => setRoute({ name: 'species' })}
          onCare={() => setRoute({ name: 'care', tab: 'today' })}
          onQuit={() => void window.api.app.quit()}
          onSettings={() => setRoute({ name: 'settings' })}
          musicName={musicName}
          musicPlaying={musicPlaying}
        />
        {soundToggle}
      </div>
    )
  }

  /**
   * 后退去哪：
   *  - 物种编辑 → 物种库
   *  - 信息模板 → 来源分区（植株→花园 / 物种→物种库）
   *  - 其它 → 首页
   */
  const goBack = (): void => {
    if (route.name === 'species-edit') setRoute({ name: 'species' })
    else if (route.name === 'templates') {
      setRoute(route.owner === 'plant' ? { name: 'garden' } : { name: 'species' })
    } else setRoute({ name: 'home' })
  }

  return (
    <div className="app-frame">
      {/* 所有页面共用同一层私有背景（巡视地图） */}
      <Backdrop images={backdrops} />
      {/* 无边框窗口的自制标题栏：拖动 + 最小化 / 最大化 / 关闭 */}
      <TitleBar />
      {soundToggle}
      <div className="page-shell">
      <main className="main">
        {/* 所有分区共用同一条顶行：养护区左边是 tab，其他区只有右边的 HUD。
            结构一致，切页时框不会上下跳 */}
        <div className="page-topbar">
          {route.name === 'care' ? (
            <div className="care-tabs">
              {CARE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={cx('care-tab', route.tab === tab.key && 'on')}
                  onClick={() => setRoute({ name: 'care', tab: tab.key })}
                >
                  <PixelIcon name={tab.icon} size={17} /> {tab.label}
                </button>
              ))}
            </div>
          ) : null}
          <TopHud
            pending={carePending}
            onGoWeather={() => setRoute({ name: 'care', tab: 'today' })}
            onGoPlans={() => setRoute({ name: 'care', tab: 'plans' })}
          />
        </div>
        {compatHint ? (
          <div style={{ padding: '0 0 2px' }}>
            <Notice tone="warn">
              你正在用<b>兼容模式</b>启动（命令行带了 <span className="mono">--no-sandbox</span>），
              说明这台机器上 Chromium 沙箱无法初始化，直接双击 exe 会没反应。
              <br />
              要不要在桌面创建一个快捷方式？以后<b>直接双击图标</b>就能打开，不用启动器、不用管理员权限。
              <div className="row" style={{ marginTop: 9 }}>
                <Button
                  variant="primary"
                  size="small"
                  onClick={async () => {
                    try {
                      const result = await window.api.sandbox.createShortcut('desktop')
                      setCompatHint(false)
                      toast.push(`已创建：${result.created.path}`, 'success')
                    } catch (error) {
                      toast.push(error instanceof Error ? error.message : '创建失败', 'error')
                    }
                  }}
                >
                  创建桌面快捷方式
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    window.localStorage.setItem('sproutbook.compatHintDismissed', '1')
                    setCompatHint(false)
                  }}
                >
                  不再提示
                </Button>
              </div>
            </Notice>
          </div>
        ) : null}

        {/*
          养护：四个 tab 放在**滚动区外面**，所以永远钉在顶部；
          只有下面的页面内容滚。用 sticky 也能做，但滚动容器一有内边距
          就会漏出一条「滚过去的内容」，结构上分开最稳。
        */}
        {route.name === 'care' ? (
          <div className="content">
            <PageErrorBoundary resetKey={`care:${route.tab}`}>
                {route.tab === 'today' ? (
                  <TodayPage
                    onCareChanged={refreshCareBadge}
                    onGoPlans={() => setRoute({ name: 'care', tab: 'plans' })}
                  />
                ) : null}
                {route.tab === 'plans' ? (
                  <CarePage onCareChanged={refreshCareBadge} onGoGarden={() => setRoute({ name: 'garden' })} />
                ) : null}
                {route.tab === 'logs' ? <LogsPage /> : null}
                {route.tab === 'recipes' ? <RecipesPage /> : null}
              </PageErrorBoundary>
          </div>
        ) : (
        <div className="content">
          <PageErrorBoundary resetKey={route.name}>
          {route.name === 'garden' ? (
            <GardenPage
              onGoSpecies={() => setRoute({ name: 'species' })}
              onOpenTemplates={() => setRoute({ name: 'templates', owner: 'plant' })}
            />
          ) : null}

          {route.name === 'species' ? (
            <SpeciesPage
              onEdit={(id) => setRoute({ name: 'species-edit', id })}
              onCreate={() => setRoute({ name: 'species-edit', id: null })}
              onOpenTemplates={() => setRoute({ name: 'templates', owner: 'species' })}
            />
          ) : null}

          {route.name === 'species-edit' ? (
            <SpeciesEditor
              speciesId={route.id}
              onBack={() => setRoute({ name: 'species' })}
              onSaved={() => undefined}
            />
          ) : null}

          {route.name === 'templates' ? (
            <TemplatesPage
              initialOwner={route.owner}
              onBack={() => setRoute(route.owner === 'plant' ? { name: 'garden' } : { name: 'species' })}
            />
          ) : null}
          {route.name === 'settings' ? <SettingsPage /> : null}
          </PageErrorBoundary>
        </div>
        )}
      </main>
      {/* 分区页没有导航条：右下角「← 后退」回首页再换分区 */}
      <button type="button" className="back-btn" onClick={goBack} title="返回上一页 / 首页">
        ← 后退
      </button>
      </div>
    </div>
  )
}

/**
 * 页面级错误边界。
 *
 * 桌面应用最糟糕的失败方式是「白屏」：窗口还在、进程还活着，
 * 但用户看到一片空白，既不知道出了什么事，也没有任何自救手段。
 * 之前没有错误边界，任何页面在渲染期抛错都会导致整个界面消失。
 *
 * 这里兜住错误，给出人话说明 + 重新加载按钮，并把技术细节打到控制台。
 * 切换路由时自动复位，避免一个页面出错后整个应用卡在错误页上。
 */
class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] 页面渲染失败:', error, info.componentStack)
  }

  override componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <CenteredMessage>
          <h2 style={{ marginTop: 0 }}>这个页面出错了</h2>
          <p className="small muted">你的数据没有受影响，都在本机。可以重新加载再试，或切换到别的页面。</p>
          <pre
            className="mono small"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto' }}
          >
            {this.state.error.message}
          </pre>
        </CenteredMessage>
      )
    }
    return this.props.children
  }
}

/** 居中提示容器：用于错误边界等「整页替代」场景。 */
export function CenteredMessage({ children }: { children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <Panel>
        <div className="content-inner">
          {children}
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </div>
      </Panel>
    </div>
  )
}
