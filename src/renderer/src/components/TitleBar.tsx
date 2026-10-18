/**
 * 自定义标题栏（无边框窗口）。
 *
 * 为什么要自己做：Windows 原生标题栏是灰白的系统样式，和像素风完全不搭。
 * `frame: false` 之后窗口就没有拖拽区和按钮了，这里补上：
 *  - 整条可拖动（`-webkit-app-region: drag`），双击最大化 / 还原
 *  - 右侧最小化 / 最大化 / 关闭（`no-drag`，否则点不到）
 *
 * 注意：窗口按钮必须调用主进程（`window.api.win.*`），渲染层不能直接控窗口。
 */

import type { ReactNode } from 'react'

export function TitleBar(): ReactNode {
  return (
    <div
      className="titlebar"
      onDoubleClick={() => void window.api.win.toggleMaximize()}
      // 拖拽区不能有交互元素，否则整条会吃掉点击
      title="拖动窗口 · 双击最大化"
    >
      <span className="titlebar-icon" aria-hidden>
        🌱
      </span>
      <span className="titlebar-title">Sproutbook</span>
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
        <button
          type="button"
          className="titlebar-btn close"
          title="关闭"
          onClick={() => void window.api.win.close()}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
