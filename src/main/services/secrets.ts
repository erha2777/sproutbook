/**
 * 密钥存储。
 *
 * 铁律：API Key 绝不写入数据库、绝不进入 git、绝不出现在日志里。
 * 优先用操作系统钥匙串（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 若系统不支持加密，则降级为明文存储 —— 但会明确告知用户，而不是悄悄这么做。
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface SecretFile {
  version: 1
  /** encrypted = 是否由系统钥匙串加密 */
  apiKey: { encrypted: boolean; data: string } | null
  /**
   * 和风天气的 API Key。
   *
   * 和 AI 的 key 走同一条路：进操作系统钥匙串，绝不写数据库、绝不进 git。
   * API Host 不在这里 —— 那不是秘密，它本身就出现在请求 URL 里。
   */
  weatherKey?: { encrypted: boolean; data: string } | null
}

const EMPTY: SecretFile = { version: 1, apiKey: null, weatherKey: null }

function secretPath(): string {
  return join(app.getPath('userData'), 'secrets', 'credentials.json')
}

function readFile(): SecretFile {
  const file = secretPath()
  if (!existsSync(file)) return { ...EMPTY }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as SecretFile
    if (!parsed || typeof parsed !== 'object' || !('apiKey' in parsed)) return { ...EMPTY }
    return parsed
  } catch {
    // 文件损坏时不要删用户数据，只是当作没有密钥
    return { ...EMPTY }
  }
}

function writeFile(data: SecretFile): void {
  const file = secretPath()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function hasApiKey(): boolean {
  return readFile().apiKey !== null
}

export function isKeyPlaintext(): boolean {
  const key = readFile().apiKey
  return key !== null && key.encrypted === false
}

/** 读取明文密钥供请求使用。仅在主进程内使用，绝不通过 IPC 返回给渲染进程。 */
export function getApiKey(): string | null {
  const entry = readFile().apiKey
  if (!entry) return null
  if (!entry.encrypted) return entry.data
  try {
    return safeStorage.decryptString(Buffer.from(entry.data, 'base64'))
  } catch {
    // 换机器 / 换用户后旧密文无法解密，视为未配置，由用户重新填写
    return null
  }
}

export function setApiKey(key: string | null): { stored: boolean; plaintext: boolean; warning?: string } {
  if (!key || key.trim() === '') {
    writeFile({ ...readFile(), apiKey: null })
    return { stored: false, plaintext: false }
  }

  const trimmed = key.trim()
  if (isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(trimmed).toString('base64')
      writeFile({ ...readFile(), apiKey: { encrypted: true, data: encrypted } })
      return { stored: true, plaintext: false }
    } catch {
      // 加密失败则走降级分支
    }
  }

  writeFile({ ...readFile(), apiKey: { encrypted: false, data: trimmed } })
  return {
    stored: true,
    plaintext: true,
    warning: '系统钥匙串不可用，API Key 以明文保存在本机用户目录。请勿在共享电脑上使用。'
  }
}

export function clearApiKey(): void {
  writeFile({ ...readFile(), apiKey: null })
}

/** 用于日志与错误信息脱敏：任何疑似密钥的字符串都要被抹掉。 */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{8,}/gi, '$1***')
}

// ---------------------------------------------------------------------------
// 和风天气的 API Key —— 与 AI 的 key 同一套存储与加密
// ---------------------------------------------------------------------------

/**
 * 天气 key 用的是**同一个密钥文件、同一套 safeStorage 加解密**。
 * 另起一套存储只会多一个可能忘记加密的地方。
 */
export function hasWeatherKey(): boolean {
  return readFile().weatherKey != null
}

export function getWeatherKey(): string | null {
  const entry = readFile().weatherKey
  if (!entry) return null
  try {
    return entry.encrypted ? safeStorage.decryptString(Buffer.from(entry.data, 'base64')) : entry.data
  } catch {
    // 换了机器 / 系统密钥变了，解不开就当没有 —— 让用户重新填，而不是抛错
    return null
  }
}

export function setWeatherKey(key: string | null): { stored: boolean; plaintext: boolean } {
  const file = readFile()
  if (key === null || key.trim() === '') {
    file.weatherKey = null
    writeFile(file)
    return { stored: false, plaintext: false }
  }
  const available = isEncryptionAvailable()
  file.weatherKey = available
    ? { encrypted: true, data: safeStorage.encryptString(key.trim()).toString('base64') }
    : { encrypted: false, data: key.trim() }
  writeFile(file)
  return { stored: true, plaintext: !available }
}
