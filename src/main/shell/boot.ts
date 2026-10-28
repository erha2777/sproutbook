/**
 * 启动握手。
 *
 * `ready-to-show` 只代表 **Chromium 画出第一帧**，那时 React 可能刚挂载：
 * 皮肤（CSS 变量 + 图片）、背景图、图标都还在异步加载，窗口会先闪一下默认外观，
 * 再"跳"成有皮肤的样子 —— 用户看到的就是开屏闪动。
 *
 * 所以渲染层在把这些都套上、并且画完两帧之后调 `app:rendererReady`，
 * 主进程收到后才 show()。
 */

let ready = false
const waiters: Array<() => void> = []

export function notifyRendererReady(): void {
  if (ready) return
  ready = true
  for (const waiter of waiters.splice(0)) {
    try {
      waiter()
    } catch {
      // 单个回调出错不影响其它
    }
  }
}

export function isRendererReady(): boolean {
  return ready
}

export function onRendererReady(cb: () => void): void {
  if (ready) {
    cb()
    return
  }
  waiters.push(cb)
}

/** 应用退出再进（同一进程内换 data-dir 之类）时重置，正常流程用不到 */
export function resetRendererReady(): void {
  ready = false
}
