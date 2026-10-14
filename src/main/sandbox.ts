/**
 * Chromium 沙箱兜底。
 *
 * ## 问题
 *
 * 在某些受限环境下 Chromium 的进程沙箱无法初始化，Electron 会在**原生启动阶段**
 * 直接崩溃，异常码 `0x80000003`（STATUS_BREAKPOINT）。表现为双击毫无反应：
 * 没有窗口、没有报错，连用户数据目录都不会被创建。
 *
 * 已知触发条件：
 *  - **低完整性级别（Low Integrity）进程** —— 沙箱需要创建受限令牌并派生中等完整性
 *    子进程，低完整性令牌做不到。沙箱化的执行环境（例如某些 AI 工具的命令沙箱）常见。
 *  - 受限的作业对象（job object）中的进程
 *  - 部分安全软件注入
 *
 * ## 为什么应用内无法自救（已实测确认）
 *
 * 曾经尝试过「应用启动时自行 `app.commandLine.appendSwitch('no-sandbox')`，
 * 配合一个标记文件，让用户双击普通 exe 就能用」。**这条路是死的**：
 * Chromium 的沙箱初始化早于主进程 JavaScript，`appendSwitch` 执行时已经来不及，
 * 进程照样崩溃。实测：带标记文件、不带命令行参数启动，仍然是 0x80000003。
 *
 * 因此 `--no-sandbox` **必须出现在命令行上**，只有两种落地方式：
 *   1. 启动器（`.cmd` / 脚本）显式传参
 *   2. **快捷方式（.lnk）把参数烘焙进去** —— 这就是本模块提供的方案：
 *      用户双击一个图标即可，无需记参数、无需管理员权限、无控制台窗口闪烁
 *
 * ## 安全立场
 *
 * 关闭沙箱会降低进程隔离强度，因此本模块**只创建额外的快捷方式**，
 * 绝不偷偷修改主程序的行为，也绝不自动降级。用户可以随时删掉快捷方式恢复原状。
 */

import { app, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface SandboxDecision {
  /** 当前进程是否已关闭沙箱 */
  disabled: boolean
  /** 命中原因，用于日志与「关于」页面展示 */
  reason: string | null
}

export interface ShortcutStatus {
  path: string
  /** desktop = 桌面；startMenu = 开始菜单 */
  scope: 'desktop' | 'startMenu'
  exists: boolean
}

export interface SandboxStatus {
  disabled: boolean
  reason: string | null
  integrityLevel: string | null
  /** 是否支持创建快捷方式（仅 Windows） */
  canCreateShortcut: boolean
  shortcuts: ShortcutStatus[]
}

/**
 * 快捷方式文件名。
 * 刻意用纯 ASCII：同一个名字也会出现在 NSIS 安装脚本（build/installer.nsh）里，
 * 而 NSIS 对脚本文件的编码很敏感，ASCII 最省事。
 */
export const COMPAT_SHORTCUT_NAME = 'Sproutbook (compat).lnk'

// ---------------------------------------------------------------------------
// 当前进程的沙箱策略
// ---------------------------------------------------------------------------

export function resolveSandboxDecision(): SandboxDecision {
  if (process.argv.includes('--no-sandbox')) {
    return { disabled: true, reason: '命令行参数 --no-sandbox' }
  }
  if (process.env.SPROUTBOOK_NO_SANDBOX === '1') {
    return { disabled: true, reason: '环境变量 SPROUTBOOK_NO_SANDBOX=1' }
  }
  return { disabled: false, reason: null }
}

let lastDecision: SandboxDecision = { disabled: false, reason: null }

/** 必须在 app ready **之前**调用，否则对子进程不生效。 */
export function applySandboxDecision(): SandboxDecision {
  const decision = resolveSandboxDecision()
  lastDecision = decision
  if (decision.disabled) {
    app.commandLine.appendSwitch('no-sandbox')
    // 用 console.warn 而不是 log：这是安全性相关的状态变化，值得显眼
    console.warn(`[sandbox] 已关闭 Chromium 沙箱，原因：${decision.reason}`)
  }
  return decision
}

export function getSandboxDecision(): SandboxDecision {
  return lastDecision
}

// ---------------------------------------------------------------------------
// 快捷方式
// ---------------------------------------------------------------------------

function shortcutCandidates(): ShortcutStatus[] {
  const out: ShortcutStatus[] = []
  const push = (path: string, scope: ShortcutStatus['scope']): void => {
    out.push({ path, scope, exists: existsSync(path) })
  }
  try {
    push(join(app.getPath('desktop'), COMPAT_SHORTCUT_NAME), 'desktop')
  } catch {
    /* 忽略 */
  }
  try {
    push(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', COMPAT_SHORTCUT_NAME), 'startMenu')
  } catch {
    /* 忽略 */
  }
  return out
}

/**
 * 创建「兼容模式」快捷方式：目标是当前 exe，参数固定为 `--no-sandbox`。
 * 用 Electron 内置的 shell.writeShortcutLink，不需要 COM 也不需要额外依赖。
 */
export function createCompatShortcut(scope: 'desktop' | 'startMenu'): ShortcutStatus {
  if (process.platform !== 'win32') {
    throw new Error('创建快捷方式仅支持 Windows')
  }

  const target = process.execPath
  const candidates = shortcutCandidates()
  const slot = candidates.find((c) => c.scope === scope)
  if (!slot) throw new Error('找不到可写入的快捷方式位置')

  const ok = shell.writeShortcutLink(slot.path, 'create', {
    target,
    args: '--no-sandbox',
    cwd: join(target, '..'),
    description: 'Sproutbook（兼容模式：启动时传入 --no-sandbox，用于 Chromium 沙箱无法初始化的机器）',
    icon: target,
    iconIndex: 0
  })

  if (!ok) throw new Error(`创建快捷方式失败：${slot.path}`)

  return { ...slot, exists: existsSync(slot.path) }
}

export function removeCompatShortcuts(): string[] {
  const removed: string[] = []
  for (const slot of shortcutCandidates()) {
    if (!slot.exists) continue
    try {
      // writeShortcutLink 只支持 create/update/replace，没有 delete，直接删文件
      unlinkSync(slot.path)
      removed.push(slot.path)
    } catch {
      // 删除失败（被占用、权限不足等）时跳过
    }
  }
  return removed
}

export function listCompatShortcuts(): ShortcutStatus[] {
  return shortcutCandidates()
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

let cachedIntegrity: string | null | undefined

/**
 * 读取当前进程的完整性级别。
 *
 * Node 没有直接暴露令牌完整性级别的接口，所以退一步调用 `whoami /groups`
 * 解析「Mandatory Label」那一行。仅 Windows 可用，失败一律返回 null ——
 * 这只是诊断信息，绝不能因为它影响启动。结果会缓存。
 */
export function detectIntegrityLevel(): string | null {
  if (cachedIntegrity !== undefined) return cachedIntegrity
  cachedIntegrity = null

  if (process.platform !== 'win32') return cachedIntegrity

  try {
    const output = execFileSync('whoami', ['/groups'], {
      encoding: 'utf-8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const line = output.split(/\r?\n/).find((l) => /Mandatory Label|强制标签/i.test(l))
    if (line) {
      const match = line.match(/(Low|Medium|High|System)\s+Mandatory\s+Level/i)
      cachedIntegrity = match ? match[1] : line.trim().split(/\s{2,}/)[0]
    }
  } catch {
    // 受限环境可能禁止派生进程，取不到就算了
    cachedIntegrity = null
  }

  return cachedIntegrity
}
