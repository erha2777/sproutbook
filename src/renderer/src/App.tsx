import { Component, useCallback, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button, Notice, Panel, Sign, ToastProvider, cx, useToast } from './components/ui'
import { TitleBar } from './components/TitleBar'
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

/** 侧栏：首页 + 三个入口 + 设置。养护下面的四页在页内用 tab 切。 */
const NAV: Array<{ key: 'home' | 'garden' | 'species' | 'care' | 'settings'; icon: string; label: string }> = [
  { key: 'home', icon: '🏠', label: '首页' },
  { key: 'garden', icon: '🪴', label: '我的花园' },
  { key: 'species', icon: '📖', label: '物种库' },
  { key: 'care', icon: '🌱', label: '养护' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

/** 养护子页（首页「养护」进去后的四个 tab） */
const CARE_TABS: Array<{ key: CareTab; icon: string; label: string }> = [
  { key: 'today', icon: '🌤️', label: '今日' },
  { key: 'plans', icon: '📅', label: '养护计划' },
  { key: 'logs', icon: '📓', label: '养护日志' },
  { key: 'recipes', icon: '🧪', label: '配方' }
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
      <div className="cloud c1" />
      <div className="cloud c2" />
      <div className="cloud c3" />
      <div className="cloud c4" />
    </div>
  )
}

function Shell(): ReactNode {
  const toast = useToast()
  const [route, setRoute] = useState<Route>(routeFromHash)
  const [speciesCount, setSpeciesCount] = useState<number | null>(null)
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

  const refreshCounts = useCallback(async () => {
    try {
      const list = await window.api.species.list({ limit: 1 })
      setSpeciesCount(list.total)
    } catch {
      setSpeciesCount(null)
    }
  }, [])

  useEffect(() => {
    void refreshCounts()
  }, [refreshCounts, route])

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

  const activeNav: 'home' | 'garden' | 'species' | 'care' | 'settings' =
    route.name === 'species-edit'
      ? 'species'
      : route.name === 'templates'
        ? route.owner === 'plant'
          ? 'garden'
          : 'species'
        : route.name

  /*
   * 首页是**标题画面**，不套侧栏：它把应用收成四个入口。
   * 其余页面照旧用侧栏，方便在分区之间跳。
   */
  if (route.name === 'home') {
    return (
      <div className="app-frame">
        <TitleBar />
        <HomePage
          version={appVersion}
          carePending={carePending}
          onGarden={() => setRoute({ name: 'garden' })}
          onSpecies={() => setRoute({ name: 'species' })}
          onCare={() => setRoute({ name: 'care', tab: 'today' })}
          onQuit={() => void window.api.app.quit()}
          onSettings={() => setRoute({ name: 'settings' })}
        />
      </div>
    )
  }

  return (
    <div className="app-frame">
      {/* 无边框窗口的自制标题栏：拖动 + 最小化 / 最大化 / 关闭 */}
      <TitleBar />
      <div className="app-shell">
      <aside className="sidebar">
        <Panel className="nav">
          <div style={{ textAlign: 'center', padding: '4px 0 8px' }}>
            <Sign>Sproutbook</Sign>
          </div>
          {NAV.map((item) => (
            <button
              key={item.key}
              className={cx('nav-item', activeNav === item.key && 'active')}
              onClick={() => {
                if (item.key === 'care') setRoute({ name: 'care', tab: 'today' })
                else setRoute({ name: item.key } as Route)
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.key === 'species' && speciesCount !== null ? (
                <>
                  <span className="spacer" />
                  <span className="small muted">{speciesCount}</span>
                </>
              ) : null}
              {/*
                角标挂在「养护」：那才是「今天要处理几件事」的入口。
                只算「已过期 + 该做」—— 把远期任务也算进来就等于没有信号了。
              */}
              {item.key === 'care' && carePending > 0 ? (
                <>
                  <span className="spacer" />
                  <span className="nav-badge" title={`${carePending} 件事需要处理`}>
                    {carePending}
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </Panel>

        <Panel flat>
          <div className="small muted" style={{ lineHeight: 1.7 }}>
            数据全部保存在本机。
            <br />
            记得定期到「设置」里备份。
          </div>
        </Panel>
        <span className="spacer" />
        <Panel flat>
          {/*
            版本号从 app:info 读，不要写死。
            之前这里硬编码「v0.1.0 · 早期版本」，发版时必然忘记改，
            界面显示的版本会和真实版本不一致 —— 用户报 bug 时这很要命。
          */}
          <div className="small muted">
            {appVersion ? `v${appVersion}` : ''}
            {appVersion?.startsWith('0.') ? ' · 早期版本' : ''}
          </div>
        </Panel>
      </aside>

      <main className="main">
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

        <div className="content">
          <PageErrorBoundary resetKey={`${route.name}:${route.name === 'care' ? route.tab : ''}`}>
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
              onSaved={() => void refreshCounts()}
            />
          ) : null}

          {route.name === 'templates' ? (
            <TemplatesPage
              initialOwner={route.owner}
              onBack={() => setRoute(route.owner === 'plant' ? { name: 'garden' } : { name: 'species' })}
            />
          ) : null}
          {route.name === 'settings' ? <SettingsPage /> : null}

          {/*
            养护：今日 / 养护计划 / 养护日志 / 配方 收进一个分区，
            页内用 tab 切 —— 首页只留「养护」一个入口。
          */}
          {route.name === 'care' ? (
            <div className="care-hub">
              <div className="care-tabs">
                {CARE_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={cx('care-tab', route.tab === tab.key && 'on')}
                    onClick={() => setRoute({ name: 'care', tab: tab.key })}
                  >
                    {tab.icon} {tab.label}
                  </button>
                ))}
              </div>
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
            </div>
          ) : null}
          </PageErrorBoundary>
        </div>
      </main>
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
