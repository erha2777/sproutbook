/**
 * 页内顶部导航（取代原来的左侧栏）。
 *
 * 首页是标题画面、不套导航；进了分区以后用这一条横栏在
 * 我的花园 / 物种库 / 养护 / 设置 之间切换，左边永远能回首页。
 *
 * 为什么不做抽屉或图标栏：这几个入口一共就五个，
 * 摊平在顶部一眼能看全，比收起式导航少一次点击。
 */

import type { ReactNode } from 'react'
import { cx } from './ui'

export type TopNavKey = 'home' | 'garden' | 'species' | 'care' | 'settings'

const ITEMS: Array<{ key: TopNavKey; icon: string; label: string }> = [
  { key: 'home', icon: '🏠', label: '首页' },
  { key: 'garden', icon: '🪴', label: '我的花园' },
  { key: 'species', icon: '📖', label: '物种库' },
  { key: 'care', icon: '🌱', label: '养护' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

export function TopNav({
  active,
  carePending,
  speciesCount,
  version,
  onNavigate
}: {
  active: TopNavKey
  /** 养护角标：逾期 + 该做 */
  carePending: number
  speciesCount: number | null
  version: string | null
  onNavigate: (key: TopNavKey) => void
}): ReactNode {
  return (
    <nav className="topnav">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          className={cx('topnav-item', active === item.key && 'on')}
          onClick={() => onNavigate(item.key)}
        >
          <span>{item.icon}</span>
          <span>{item.label}</span>
          {item.key === 'species' && speciesCount !== null ? (
            <span className="topnav-count">{speciesCount}</span>
          ) : null}
          {item.key === 'care' && carePending > 0 ? (
            <span className="nav-badge" title={`${carePending} 件事需要处理`}>
              {carePending}
            </span>
          ) : null}
        </button>
      ))}
      <span className="spacer" />
      {version ? <span className="topnav-version">v{version}</span> : null}
    </nav>
  )
}
