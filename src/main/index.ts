/**
 * 主进程入口。
 *
 * 启动顺序很重要（顺序错了就会出问题）：
 *   0. 解析 --data-dir 并决定沙箱策略 —— 两者都必须早于 app ready
 *   1. 自定义协议必须在 app ready **之前**注册特权
 *   2. 单实例锁（避免两个进程同时写同一个 SQLite 文件）
 *   3. ready 之后再初始化数据库（需要 userData 路径）
 *   4. 最后才创建窗口 —— 保证界面出现时数据层已经就绪
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { closeDatabase, dataDir, dbFilePath, getLastReport, imagesDir, initDatabase } from './db'
import { registerIpc } from './ipc'
import { handleImageProtocol, registerImageScheme } from './services/images'
import { runSmoke } from './smoke'
import { applySandboxDecision, enableGpuFallback, isGpuFallbackActive, shouldDisableGpu } from './sandbox'
import type { SandboxDecision } from './sandbox'
import { logStartup, logWritability, startupLogPath } from './startupLog'

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

/**
 * 沙箱策略必须在**最早期**决定：受限环境（低完整性进程等）下 Chromium 沙箱
 * 无法初始化，进程会在执行任何应用代码之前就崩溃。详见 src/main/sandbox.ts。
 */
let sandboxDecision: SandboxDecision = { disabled: false, reason: null }
try {
  sandboxDecision = applySandboxDecision()
} catch (error) {
  console.error('[sandbox] 处理沙箱策略时出错（继续按默认沙箱启动）:', error)
}

logStartup('应用启动', {
  version: app.getVersion(),
  electron: process.versions.electron,
  packaged: app.isPackaged,
  argv: process.argv.slice(1),
  sandboxDisabled: sandboxDecision.disabled,
  sandboxReason: sandboxDecision.reason
})

/**
 * 软件渲染兜底。
 *
 * 与沙箱不同，这一项能在应用内自救：`disableHardwareAcceleration()` 只要在 ready
 * 之前调用就有效（GPU 进程是 ready 之后才启动的）。
 *
 * 典型场景：应用起来了、数据库也正常，但窗口始终画不出来 —— 机器上 GPU/DirectX
 * 栈对普通（非管理员）进程不工作时就会这样。看门狗检测到后会写入标记并自动重启。
 */
const gpuFallbackWasActive = isGpuFallbackActive()
try {
  const gpu = shouldDisableGpu()
  if (gpu.disabled) {
    app.disableHardwareAcceleration()
    logStartup('已禁用硬件加速（改用软件渲染）', gpu.reason)
  }
} catch (error) {
  logStartup('处理软件渲染策略时出错（继续使用默认设置）', error)
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

/**
 * 单实例锁。
 *
 * SQLite 是单写入者模型，两个进程同时操作同一个库会互相锁死。
 *
 * ⚠️ 关键：拿不到锁时**必须让后续所有初始化都停下来**。
 * 只调用 `app.quit()` 是不够的 —— 它是异步的，`app.whenReady()` 依然会触发，
 * 于是第二个实例照样去打开同一个数据库文件，用户看到的就是
 * 「数据库初始化失败：unable to open database file」。
 */
const hasSingleInstanceLock = isSmoke ? true : app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  // 记一笔：否则这次启动在用户眼里就是「闪退」，日志是唯一的线索
  logStartup('未取得单实例锁：已有另一个 Sproutbook 在运行，本实例退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      // 关键：窗口可能从未被显示过（见 createWindow 里的说明），
      // 光 focus() 对隐藏窗口是没用的，必须先 show()。
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
      win.moveTop()
      logStartup('收到第二个实例的启动请求，已尝试把已有窗口带到前台')
    }
  })
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

  /**
   * 窗口显示策略。
   *
   * ⚠️ 这里曾经有个会导致「应用隐身」的 bug：
   * 窗口以 show:false 创建，然后**只**依赖 ready-to-show 事件来显示。
   * 一旦该事件不触发（渲染层加载失败、GPU 异常等），窗口就永远隐藏 ——
   * 进程在后台跑着，用户却什么都看不到；而且后续每次启动都抢不到单实例锁
   * 从而静默退出，表现出来就是「双击一闪而过」。
   *
   * 所以现在有三重保障：正常事件、超时兜底、加载失败兜底。任一路径都会显示窗口。
   */
  let windowShown = false
  const showWindow = (reason: string): void => {
    if (windowShown) return
    windowShown = true
    mainWindow?.show()
    logStartup('窗口已显示', reason)
  }

  mainWindow.once('ready-to-show', () => showWindow('ready-to-show 事件'))

  const showFallbackTimer = setTimeout(() => {
    if (!windowShown) {
      logStartup('ready-to-show 未在 6 秒内触发，强制显示窗口（界面可能不完整）')
      showWindow('超时兜底')
    }
  }, 6000)

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logStartup('渲染层加载失败', { errorCode, errorDescription, validatedURL })
    // 即使加载失败也要把窗口显示出来，让用户看到界面而不是完全没反应
    showWindow('加载失败兜底')
  })

  mainWindow.on('closed', () => {
    clearTimeout(showFallbackTimer)
    windowShown = false
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

  // 没抢到单实例锁：直接退出，绝不碰数据库。
  // 否则会和已经运行的实例抢同一个 SQLite 文件，用户看到的是
  // 「unable to open database file」这种极具误导性的报错。
  if (!hasSingleInstanceLock) {
    console.log('[app] 已有另一个 Sproutbook 实例在运行，本实例退出。')
    app.exit(0)
    return
  }

  try {
    logStartup('开始初始化数据库', {
      userData: app.getPath('userData'),
      dataDir: dataDir(),
      dbFile: dbFilePath()
    })
    // 把每个关键目录的可写性记下来 —— 数据库打不开时，这一行通常直接给出答案
    logWritability('用户数据目录', app.getPath('userData'))
    logWritability('数据目录', dataDir())
    logWritability('图片目录', imagesDir())

    const result = initDatabase()
    if (result.report.applied.length > 0) {
      console.log(
        `[db] 迁移完成：${result.report.from} → ${result.report.to}（${result.report.applied.map((a) => a.name).join(', ')}）`
      )
    }
    if (result.seeded.fields > 0) {
      console.log(`[db] 首次启动，写入默认模板 ${result.seeded.fields} 个字段`)
    }
    logStartup('数据库初始化成功', {
      from: result.report.from,
      to: result.report.to,
      seededFields: result.seeded.fields
    })
  } catch (error) {
    // 数据库起不来是致命错误，必须让用户看到**可操作**的原因，而不是一句 SQLite 原文
    const message = error instanceof Error ? error.message : String(error)
    const dataDirPath = app.getPath('userData')
    console.error('[db] 初始化失败:', error)
    logStartup('数据库初始化失败', error)
    logWritability('失败后复查用户数据目录', dataDirPath)

    const logPath = startupLogPath()
    dialog.showErrorBox(
      '数据库初始化失败',
      [
        `错误信息：${message}`,
        '',
        `数据目录：${dataDirPath}`,
        logPath ? `启动日志：${logPath}` : '',
        '',
        '请按顺序尝试：',
        '',
        '1) 结束所有 Sproutbook 进程后重试（最常见）',
        '   任务管理器 →「详细信息」标签页 → 找到 Sproutbook.exe → 结束任务。',
        '   如果有窗口看不见的残留进程，必须在这一页里找。',
        '',
        '2) 检查数据目录是否被占用或权限异常',
        '   上面的启动日志会写明每个目录是否可写，把日志发来即可定位。',
        '',
        '3) 备份后重建数据目录',
        '   备份文件在 backups 子目录里，每个都是完整可用的 SQLite 数据库，',
        '   可以用 DB Browser 之类的工具直接打开，不会丢数据。',
        '',
        '如果以上都无效，请把这份错误信息和启动日志一起反馈。'
      ]
        .filter((line) => line !== '')
        .join('\n')
    )
    app.exit(1)
    return
  }

  // ---- 界面初始化 ----
  //
  // ⚠️ 这一段以前**没有** try/catch。其中任何一步抛错，异常都会逃逸成未处理的
  // Promise 拒绝，而全局处理器只是打一行日志 —— 进程继续活着、窗口却永远不会创建。
  // 用户看到的是「双击没反应」，之后每次启动还会因为抢不到单实例锁而闪退，
  // 而且这种隐身进程会一直占着数据库文件。
  //
  // 现在任何失败都会明确记录并弹窗告知，绝不留下隐身进程。
  try {
    registerIpc()
    handleImageProtocol()

    if (!isDev) Menu.setApplicationMenu(null)

    createWindow()
  } catch (error) {
    logStartup('界面初始化失败', error)
    const logPath = startupLogPath()
    dialog.showErrorBox(
      '界面初始化失败',
      [
        `错误信息：${error instanceof Error ? error.message : String(error)}`,
        '',
        logPath ? `启动日志：${logPath}` : '',
        '',
        '这通常意味着程序文件不完整或权限异常。',
        '请重新解压 / 重新安装一份完整的程序目录后再试。'
      ]
        .filter((line) => line !== '')
        .join('\n')
    )
    app.exit(1)
    return
  }

  /**
   * 看门狗：界面初始化走完后，若始终没有可见窗口，说明前面某一步悄悄失败了。
   * 宁可明确报错，也绝不留下一个用户看不见的进程。
   *
   * 处理顺序（尽量自救，而不是直接甩错误给用户）：
   *   1. 窗口存在但没显示 → 强制显示
   *   2. 还没试过软件渲染 → 写入标记并**自动重启**（下次启动即用软件渲染）
   *   3. 已经用软件渲染还是不行 → 只能弹窗报错
   */
  const windowWatchdog = setTimeout(() => {
    const windows = BrowserWindow.getAllWindows()
    const visible = windows.filter((w) => w.isVisible())
    if (visible.length > 0) return

    logStartup('看门狗：启动 10 秒后仍无可见窗口', {
      windowCount: windows.length,
      gpuFallbackAlreadyActive: gpuFallbackWasActive
    })

    if (windows.length > 0) {
      for (const win of windows) {
        win.show()
        win.focus()
      }
      logStartup('看门狗：已强制显示已存在的窗口')
      return
    }

    // 还没试过软件渲染：写上标记后自动重启一次
    if (!gpuFallbackWasActive) {
      try {
        const marker = enableGpuFallback()
        logStartup('看门狗：疑似图形栈问题，已写入软件渲染标记并自动重启', { marker })
        app.relaunch()
        app.exit(0)
        return
      } catch (error) {
        logStartup('看门狗：写入软件渲染标记失败', error)
      }
    }

    dialog.showErrorBox(
      '窗口未能创建',
      [
        '应用已启动，但始终没有出现窗口。',
        '',
        `启动日志：${startupLogPath() ?? '(无法写入)'}`,
        '',
        '请把启动日志反馈给我们，它会指出卡在哪一步。'
      ].join('\n')
    )
    app.exit(1)
  }, 10000)
  app.once('before-quit', () => clearTimeout(windowWatchdog))

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
