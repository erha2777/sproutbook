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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 *
 * ## 为什么要自己实现一份（2026-10-18 的真实事故）
 *
 * Chromium 在 Windows 上把单实例锁实现成**符号链接**：
 * `userData\SingletonLock` → `"主机名-进程号"`。而创建符号链接需要
 * **管理员权限或开发者模式**。
 *
 * 2026-10-16 的 Windows 安全更新之后，这台机器上（非管理员用户、
 * 开发者模式未开）创建符号链接被拒，Chromium 报：
 *
 *     process_singleton_win.cc:457] Lock file can not be created! Error code: 5
 *
 * 于是 `requestSingleInstanceLock()` **恒返回 false** —— 应用每次启动都以为
 * 「已有另一个实例在运行」，然后自己退出。用户看到的就是「双击打不开」，
 * 而且日志里没有任何应用层错误，因为它在 JS 之前就失败了。
 *
 * 所以：**先试原生的**（它还能带给我们 second-instance 的「把已有窗口提到前台」），
 * **失败就降级到自建文件锁** —— 只用普通文件 + 进程存活检查，不需要任何特权。
 */
interface HeldLock {
  ok: boolean
  /** native = Electron 原生锁（可收到 second-instance）；file = 自建降级锁 */
  kind: 'native' | 'file'
  release: () => void
}

/** 进程是否还活着。EPERM 说明进程存在但没权限访问，也算活着。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 自建文件锁：`userData\.instance-lock` 里存 `进程号:时间戳`。
 *
 * 残留的锁文件（上个进程被强杀、没机会清理）靠**进程存活检查**判断：
 * 那个 pid 已经不在了就接管，不需要用户手动删文件。
 *
 * 为什么还要看时间戳：Windows 会复用进程号。如果只信「pid 还活着」，
 * 一个恰好复用到同号的无辜进程就会让我们误判「已有实例」，
 * 用户表现是「双击打不开」。超过 24 小时的锁一律当作残留。
 */
function acquireFileLock(dir: string): HeldLock {
  const lockFile = join(dir, '.instance-lock')
  const LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(lockFile)) {
      const [pidText, tsText] = readFileSync(lockFile, 'utf-8').trim().split(':')
      const pid = Number(pidText)
      const ts = Number(tsText)
      const stale = !Number.isFinite(ts) || Date.now() - ts > LOCK_MAX_AGE_MS
      if (!stale && isProcessAlive(pid) && pid !== process.pid) {
        return { ok: false, kind: 'file', release: () => {} }
      }
    }
    writeFileSync(lockFile, `${process.pid}:${Date.now()}`, 'utf-8')
    return {
      ok: true,
      kind: 'file',
      release: () => {
        try {
          rmSync(lockFile, { force: true })
        } catch {
          // 退出阶段，尽力而为
        }
      }
    }
  } catch (error) {
    // 连自建锁都写不进去：宁可启动，也别把用户拦在门外（多开由 SQLite 自己兜）
    logStartup('自建单实例锁失败（继续启动，可能允许多开）', { error: String(error) })
    return { ok: true, kind: 'file', release: () => {} }
  }
}

const instanceLock: HeldLock = isSmoke
  ? { ok: true, kind: 'native', release: () => {} }
  : ((): HeldLock => {
      let nativeOk = false
      try {
        nativeOk = app.requestSingleInstanceLock()
      } catch (error) {
        logStartup('原生单实例锁抛错，将降级为自建文件锁', { error: String(error) })
      }
      if (nativeOk) return { ok: true, kind: 'native', release: () => {} }
      logStartup('原生单实例锁不可用（Chromium 的 SingletonLock 符号链接被拒），改用自建文件锁', {
        userData: app.getPath('userData')
      })
      return acquireFileLock(app.getPath('userData'))
    })()

if (!instanceLock.ok) {
  // 记一笔：否则这次启动在用户眼里就是「闪退」，日志是唯一的线索
  logStartup('未取得单实例锁：已有另一个 Sproutbook 在运行，本实例退出', { kind: instanceLock.kind })
  app.quit()
} else {
  // 自建锁收不到 second-instance（那是 Chromium 的机制），退出时自己清理
  if (instanceLock.kind === 'file') {
    app.on('will-quit', () => instanceLock.release())
  }
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
    /*
     * 无边框 + 自制标题栏（渲染层 TitleBar）。
     * 原生标题栏是系统灰白样式，和像素风不搭；macOS 用 hiddenInset 保留
     * 红绿灯按钮，Windows / Linux 完全自己画。
     */
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
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

  // 界面自检：等页面渲染完再截图，然后退出。
  //
  // 支持用 --screenshot-click=<文字> 先点一个按钮再截图（仅开发模式），
  // 这样弹窗、二级页面也能被截到 —— 否则只能截到首屏，界面问题靠猜。
  const shot = screenshotPath()
  // 可以给多个 --screenshot-click，按顺序依次点击（例如先开弹窗、再点里面的按钮）
  const shotClicks = isDev ? process.argv.filter((a) => a.startsWith('--screenshot-click=')) : []
  const shotScroll = isDev ? process.argv.find((a) => a.startsWith('--screenshot-scroll=')) : undefined
  // 支持 --screenshot-type=<文字>：往当前聚焦的输入框里逐字输入。
  //
  // 加这个是因为「输入框打不进字」这类 bug 光看截图发现不了 ——
  // 之前 CarePage 的备注框每敲一个字符就被卸载重建、焦点丢失，
  // 截图完全看不出来，只有真的敲进去才能验证。
  const shotType = isDev ? process.argv.find((a) => a.startsWith('--screenshot-type=')) : undefined
  /*
   * 支持 --screenshot-wait=<毫秒>：多等一会儿再截。
   *
   * 加这个是因为页面上的**异步内容**（天气要联网取、列表要读库）常常在默认
   * 等待时间内还没渲染完，截出来是「正在查看…」—— 于是"验证"截了个寂寞。
   * 宁可多等，也别拍到半成品然后把它当成结果。
   */
  const shotWaitArg = isDev ? process.argv.find((a) => a.startsWith('--screenshot-wait=')) : undefined
  const shotWait = shotWaitArg ? Number(shotWaitArg.slice('--screenshot-wait='.length)) : 1800

  if (shot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            for (const flag of shotClicks) {
              const text = flag.slice('--screenshot-click='.length)
              // 在渲染层里找按钮并点击。用 JSON.stringify 转义，避免文字里的引号破坏脚本
              /*
               * `.cal-cell` 也进选择器：月历的整格是可点的（点某天看当天计划），
               * 它不是 button，不列进来的话「点日期」这条路在自检里根本点不到。
               *
               * **要轮询等待，不能只找一次**：did-finish-load 只代表 HTML 加载完，
               * React 还没把列表渲染出来。之前找了立刻返回 false，
               * 脚本照样报「已保存」—— 截出来的是上一屏，验证等于没做。
               */
              const clicked = await mainWindow?.webContents.executeJavaScript(
                `(async () => {
                   const target = ${JSON.stringify(text)};
                   const deadline = Date.now() + 8000;
                   while (Date.now() < deadline) {
                     const nodes = Array.from(document.querySelectorAll('button, .pixel-card, .nav-item, .cal-cell'));
                     const hit = nodes.find((n) => (n.textContent || '').includes(target));
                     if (hit) {
                       hit.click();
                       return true;
                     }
                     await new Promise((r) => setTimeout(r, 200));
                   }
                   return false;
                 })()`
              )
              logStartup('界面自检：点击元素', { text, clicked })
              // 等界面响应完再点下一个 / 截图
              await new Promise((resolve) => setTimeout(resolve, 900))
            }

            if (shotType) {
              const text = shotType.slice('--screenshot-type='.length)
              // 逐字输入，每字之间留一点时间：如果输入框在重渲染时被销毁重建，
              // 第二个字就会落空 —— 这正是要抓的现象
              const result = await mainWindow?.webContents.executeJavaScript(
                `(async () => {
                   const el = document.activeElement;
                   if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                     return { ok: false, reason: '没有聚焦的输入框', tag: el ? el.tagName : null };
                   }
                   const text = ${JSON.stringify(text)};
                   const setter = Object.getOwnPropertyDescriptor(
                     el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
                     'value'
                   ).set;
                   for (const ch of text) {
                     setter.call(el, (el.value || '') + ch);
                     el.dispatchEvent(new Event('input', { bubbles: true }));
                     await new Promise((r) => setTimeout(r, 120));
                   }
                   // 输入完再查一次：焦点还在不在、值对不对
                   const stillFocused = document.activeElement === el;
                   const sameNode = document.body.contains(el);
                   return { ok: true, value: el.value, stillFocused, sameNode, want: text };
                })()`
              )
              logStartup('界面自检：输入文字', result)
              await new Promise((resolve) => setTimeout(resolve, 300))
            }

            if (shotScroll) {
              const value = shotScroll.slice('--screenshot-scroll='.length)
              // 长页面（设置页、配方编辑弹窗）需要滚动才能截到下面的内容。
              // 弹窗打开时内容在 .modal-body 里，滚主内容区是没用的 —— 优先滚弹窗。
              const scrolled = await mainWindow?.webContents.executeJavaScript(
                `(() => {
                   const modal = document.querySelector('.modal-body');
                   /*
                    * 页面滚动现在发生在 .content-inner（这样工具条才能钉住），
                    * .content 本身不再滚 —— 两个都试，谁有高度滚谁。
                    */
                   const el = modal || document.querySelector('.content-inner') || document.querySelector('.content') || document.scrollingElement;
                   if (!el) return null;
                   el.scrollTop = ${JSON.stringify(value)} === 'bottom' ? el.scrollHeight : Number(${JSON.stringify(value)}) || 0;
                   return el.scrollTop;
                 })()`
              )
              logStartup('界面自检：滚动页面', { value, scrolled })
              await new Promise((resolve) => setTimeout(resolve, 350))
            }

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
      }, Number.isFinite(shotWait) && shotWait > 0 ? shotWait : 1800)
    })
  }
}

app.whenReady().then(async () => {
  if (isSmoke) {
    const code = await runSmoke(smokeOutPath())
    app.exit(code)
    return
  }

  // 没抢到单实例锁：直接退出，绝不碰数据库。
  // 否则会和已经运行的实例抢同一个 SQLite 文件，用户看到的是
  // 「unable to open database file」这种极具误导性的报错。
  if (!instanceLock.ok) {
    console.log(`[app] 已有另一个 Sproutbook 实例在运行，本实例退出。（锁类型：${instanceLock.kind}）`)
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
