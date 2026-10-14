import { Component, useCallback, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button, Notice, Panel, Sign, ToastProvider, cx, useToast } from './components/ui'
import { GardenPage } from './pages/GardenPage'
import { SpeciesPage } from './pages/SpeciesPage'
import { SpeciesEditor } from './pages/SpeciesEditor'
import { TemplatesPage } from './pages/TemplatesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ComingSoonPage } from './pages/ComingSoonPage'

type Route =
  | { name: 'garden' }
  | { name: 'species' }
  | { name: 'species-edit'; id: number | null }
  | { name: 'recipes' }
  | { name: 'plans' }
  | { name: 'templates' }
  | { name: 'settings' }

const NAV: Array<{ key: Route['name']; icon: string; label: string }> = [
  { key: 'garden', icon: '🪴', label: '我的花园' },
  { key: 'species', icon: '📖', label: '物种库' },
  { key: 'plans', icon: '📅', label: '养护计划' },
  { key: 'recipes', icon: '🧪', label: '配方' },
  { key: 'templates', icon: '🧩', label: '信息模板' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

const HASH_TO_ROUTE: Record<string, Route['name']> = {
  garden: 'garden',
  species: 'species',
  plans: 'plans',
  recipes: 'recipes',
  templates: 'templates',
  settings: 'settings'
}

/**
 * 从 URL hash 还原当前页面。
 * 这样刷新不会跳回首页，也让「界面自检」可以逐页截图。
 */
function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  const name = HASH_TO_ROUTE[raw]
  return name ? ({ name } as Route) : { name: 'garden' }
}

function hashForRoute(route: Route): string {
  const name = route.name === 'species-edit' ? 'species' : route.name
  return `#/${name}`
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

  const activeNav: Route['name'] = route.name === 'species-edit' ? 'species' : route.name

  return (
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
              onClick={() => setRoute({ name: item.key } as Route)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.key === 'species' && speciesCount !== null ? (
                <span className="spacer" />
              ) : null}
              {item.key === 'species' && speciesCount !== null ? (
                <span className="small muted">{speciesCount}</span>
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
          <PageErrorBoundary resetKey={route.name}>
          {route.name === 'garden' ? <GardenPage onGoSpecies={() => setRoute({ name: 'species' })} /> : null}

          {route.name === 'species' ? (
            <SpeciesPage
              onEdit={(id) => setRoute({ name: 'species-edit', id })}
              onCreate={() => setRoute({ name: 'species-edit', id: null })}
            />
          ) : null}

          {route.name === 'species-edit' ? (
            <SpeciesEditor
              speciesId={route.id}
              onBack={() => setRoute({ name: 'species' })}
              onSaved={() => void refreshCounts()}
            />
          ) : null}

          {route.name === 'templates' ? <TemplatesPage /> : null}
          {route.name === 'settings' ? <SettingsPage /> : null}

          {route.name === 'plans' ? (
            <ComingSoonPage
              icon="📅"
              title="养护计划"
              description="按时间轴告诉你这个月该做什么：施肥、修剪、翻盆、防冻。"
              schemaReady
              bullets={[
                '为每株植物生成全年养护日历，任务带时间窗（±3 天），而不是死板的某一天',
                '以「物种养护规则库 + 你的环境档案」生成，AI 只负责补规则和解释，不直接编日历',
                '完成情况可打勾、可写备注、可拍照，形成养护日志时间线',
                '接入天气数据后支持霜冻预警：明晚最低 -3℃，你有 4 盆不耐寒的植物在室外',
                '月历可导出成图片，贴在冰箱上'
              ]}
              onGoGarden={() => setRoute({ name: 'garden' })}
            />
          ) : null}

          {route.name === 'recipes' ? (
            <ComingSoonPage
              icon="🧪"
              title="配方"
              description="把配土、肥料、药剂的做法存下来，直接用在养护计划里。"
              schemaReady
              bullets={[
                '材料库：泥炭、珍珠岩、蛭石、缓释肥……统一管理单位与用途',
                '配方支持比例写法（泥炭:珍珠岩:蛭石 = 5:3:2）与绝对用量两种方式',
                '配方可被植株引用，记录「这盆用的是什么土」',
                '按配方自动算出「配 10 盆需要多少材料」',
                '养护计划里的施肥任务可以直接引用某个配方'
              ]}
              onGoGarden={() => setRoute({ name: 'garden' })}
            />
          ) : null}
          </PageErrorBoundary>
        </div>
      </main>
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
