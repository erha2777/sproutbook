/**
 * 主进程入口。
 *
 * 启动顺序很重要：
 *   1. 自定义协议必须在 app ready **之前**注册特权
 *   2. 单实例锁（避免两个进程同时写同一个 SQLite 文件）
 *   3. ready 之后再初始化数据库（需要 userData 路径）
 *   4. 最后才创建窗口 —— 保证界面出现时数据层已经就绪
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { closeDatabase, getLastReport, initDatabase } from './db'
import { registerIpc } from './ipc'
import { handleImageProtocol, registerImageScheme } from './services/images'
import { runSmoke } from './smoke'

const isSmoke = process.argv.includes('--smoke')
const isDev = !app.isPackaged

/**
 * `--data-dir=<目录>`：把数据目录指到别处（便携模式 / 多份数据 / 测试隔离）。
 * 必须在 app ready 之前设置，否则已经算好的路径不会更新。
 */
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='))
if (dataDirArg) {
  const target = resolve(dataDirArg.slice('--data-dir='.length))
  app.setPath('userData', target)
  app.setPath('sessionData', target)
}

function smokeOutPath(): string {
  const arg = process.argv.find((a) => a.startsWith('--smoke-out='))
  if (arg) return arg.slice('--smoke-out='.length)
  return join(app.getPath('userData'), 'smoke-report.txt')
}

/**
 * 界面自检：`--screenshot=<文件路径>` 会在窗口渲染完成后截图并退出。
 * 用于开发与 CI 检测「白屏 / 渲染崩溃」这类只在真实窗口里才暴露的问题。
 */
function screenshotPath(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--screenshot='))
  return arg ? arg.slice('--screenshot='.length) : null
}

// --- 自检模式：不碰用户真实数据，用临时目录跑完整链路后退出 ---
if (isSmoke) {
  const smokeDir = join(app.getPath('temp'), `sproutbook-smoke-userdata-${Date.now()}`)
  app.setPath('userData', smokeDir)
  app.disableHardwareAcceleration()
}

// 自定义协议特权注册必须早于 ready
registerImageScheme()

// 单实例：SQLite 是单写入者模型，两个进程同时写会互相锁死
if (!isSmoke) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#2a1c10',
    title: 'Sproutbook',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // 先渲染完再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接一律交给系统浏览器，绝不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file://')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const shotRoute = process.argv.find((a) => a.startsWith('--screenshot-route='))
  const hash = shotRoute ? `/${shotRoute.slice('--screenshot-route='.length)}` : undefined

  if (isDev && devUrl) {
    void mainWindow.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  } else {
    const indexPath = join(__dirname, '../renderer/index.html')
    if (hash) void mainWindow.loadFile(indexPath, { hash })
    else void mainWindow.loadFile(indexPath)
  }

  // 界面自检：等页面渲染完再截图，然后退出
  const shot = screenshotPath()
  if (shot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const image = await mainWindow?.webContents.capturePage()
            if (image && !image.isEmpty()) {
              writeFileSync(shot, image.toPNG())
              console.log(`[screenshot] 已保存：${shot}`)
              app.exit(0)
            } else {
              console.error('[screenshot] 截图为空，界面可能没有渲染')
              app.exit(2)
            }
          } catch (error) {
            console.error('[screenshot] 失败:', error)
            app.exit(3)
          }
        })()
      }, 1800)
    })
  }
}

app.whenReady().then(() => {
  if (isSmoke) {
    const code = runSmoke(smokeOutPath())
    app.exit(code)
    return
  }

  try {
    const result = initDatabase()
    if (result.report.applied.length > 0) {
      console.log(
        `[db] 迁移完成：${result.report.from} → ${result.report.to}（${result.report.applied.map((a) => a.name).join(', ')}）`
      )
    }
    if (result.seeded.fields > 0) {
      console.log(`[db] 首次启动，写入默认模板 ${result.seeded.fields} 个字段`)
    }
  } catch (error) {
    // 数据库起不来是致命错误，必须让用户看到明确原因
    const message = error instanceof Error ? error.message : String(error)
    console.error('[db] 初始化失败:', error)
    dialog.showErrorBox(
      '数据库初始化失败',
      `${message}\n\n你的数据保存在：\n${app.getPath('userData')}\n\n请备份该目录后反馈此问题，不要直接删除。`
    )
    app.exit(1)
    return
  }

  registerIpc()
  handleImageProtocol()

  if (!isDev) Menu.setApplicationMenu(null)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let cleanedUp = false
app.on('before-quit', () => {
  if (cleanedUp) return
  cleanedUp = true
  try {
    closeDatabase()
  } catch (error) {
    console.error('[db] 关闭数据库时出错:', error)
  }
})

// 兜底：任何未捕获异常都不应该让应用静默退出
process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝:', reason)
})

export { getLastReport }
