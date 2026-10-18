/**
 * 自定义标题栏（无边框窗口）。
 *
 * 按用户要求：顶部保持**空的**，只留最小化与最大化/还原两个按钮 ——
 * 不要标题文字，也不要关闭按钮（关窗口走任务栏 / Alt+F4）。
 *
 * 整条仍是窗口拖拽区（`-webkit-app-region: drag`），双击最大化 / 还原；
 * 按钮要标 `no-drag`，否则点不到。
 */

import type { ReactNode } from 'react'

export function TitleBar(): ReactNode {
  return (
    <div
      className="titlebar"
      onDoubleClick={() => void window.api.win.toggleMaximize()}
      title="拖动窗口 · 双击最大化"
    >
      <span className="spacer" />
      <div className="titlebar-buttons" onDoubleClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          onClick={() => void window.api.win.minimize()}
        >
          ─
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title="最大化 / 还原"
          onClick={() => void window.api.win.toggleMaximize()}
        >
          ▢
        </button>
      </div>
    </div>
  )
}
