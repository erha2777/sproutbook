/**
 * 自定义标题栏（无边框窗口）。
 *
 * 现在是**悬浮**的：不占布局高度，内容从窗口最顶上开始，
 * 右上角浮着两个像素风按钮（最小化 / 最大化·还原）。
 *
 * 为什么这样：用户希望顶部什么都不要，只留两个按钮；
 * 但无边框窗口没有拖拽区就动不了，所以保留一条透明的拖拽带
 * （仅顶部 28px，覆盖在内容上方），双击最大化。
 *
 * 关闭按钮按用户要求去掉了：关窗口用任务栏 / Alt+F4，或首页「退出」。
 */

import type { ReactNode } from 'react'

export function TitleBar(): ReactNode {
  return (
    <div
      className="titlebar"
      onDoubleClick={() => void window.api.win.toggleMaximize()}
      title="拖动窗口 · 双击最大化"
    >
      <div className="titlebar-buttons" onDoubleClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.api.win.minimize()}
        />
        <button
          type="button"
          className="titlebar-btn max"
          title="最大化 / 还原"
          aria-label="最大化 / 还原"
          onClick={() => void window.api.win.toggleMaximize()}
        />
      </div>
    </div>
  )
}
