/**
 * AI 客户端 —— 只实现「OpenAI 兼容」一种协议。
 *
 * 为什么只做一种：OpenAI 兼容格式已经成为事实标准，覆盖 OpenAI、DeepSeek、
 * Moonshot、智谱、OpenRouter、Ollama、LM Studio 以及各类网关。一套代码路径
 * 就能吃下绝大多数场景，维护面最小、出问题最好定位。
 *
 * 健壮性要求（缺一不可）：
 *  - 超时可控且**可取消**，不会让界面卡死
 *  - 只对可恢复错误重试（网络错误 / 429 / 5xx），4xx 立即失败并给出原文
 *  - 每次调用写 ai_runs 审计表，出问题能复盘「它当时到底收到了什么」
 *  - 错误信息与日志中的密钥一律脱敏
 */

import type { Db } from '../../db/connection'
import { redact } from '../secrets'

/**
 * 多段内容里的一段。
 *
 * 纯文本模型只认字符串；视觉模型要的是「文本 + 图片」的数组
 *（OpenAI 兼容格式）。所以 content 两种都要收。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  timeoutMs?: number
  maxRetries?: number
  jsonMode?: boolean
  /** 外部取消信号（用户点了「取消」） */
  signal?: AbortSignal
}

export interface ChatUsage {
  promptTokens: number | null
  completionTokens: number | null
}

export interface ChatOutcome {
  ok: boolean
  content: string
  model: string
  usage: ChatUsage
  error?: string
  durationMs: number
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return DEFAULT_BASE_URL
  return trimmed.replace(/\/+$/, '')
}

function endpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`
}

class HttpError extends Error {
  readonly status: number
  readonly retriable: boolean
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retriable = status === 429 || status >= 500
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发起一次对话补全。**永不抛异常** —— 所有失败都以 { ok: false, error } 返回，
 * 让上层可以统一展示，而不会因为一个未捕获的 Promise 让主进程崩掉。
 */
export async function chat(request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now()
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 60000, 5000), 300000)
  const maxRetries = Math.min(Math.max(request.maxRetries ?? 2, 0), 5)
  const model = request.model?.trim()

  if (!model) {
    return { ok: false, content: '', model: '', usage: emptyUsage(), error: '未配置模型名称', durationMs: 0 }
  }
  if (!request.apiKey) {
    return { ok: false, content: '', model, usage: emptyUsage(), error: '未配置 API Key', durationMs: 0 }
  }

  const body: Record<string, unknown> = {
    model,
    messages: request.messages,
    temperature: request.temperature ?? 0.3,
    stream: false
  }
  if (request.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  let lastError = '未知错误'

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (request.signal?.aborted) {
      return { ok: false, content: '', model, usage: emptyUsage(), error: '已取消', durationMs: Date.now() - started }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      const response = await fetch(endpoint(request.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!response.ok) {
        const text = await safeText(response)
        throw new HttpError(response.status, `HTTP ${response.status}：${redact(text).slice(0, 500)}`)
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        model?: string
      }

      const content = data.choices?.[0]?.message?.content ?? ''
      return {
        ok: true,
        content,
        model: data.model ?? model,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null
        },
        durationMs: Date.now() - started
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      if (isAbort && request.signal?.aborted) {
        return { ok: false, content: '', model, usage: emptyUsage(), error: '已取消', durationMs: Date.now() - started }
      }
      if (isAbort) {
        lastError = `请求超时（${Math.round(timeoutMs / 1000)} 秒）。可在设置中调大超时时间。`
      } else if (error instanceof HttpError) {
        lastError = error.message
        if (!error.retriable) {
          return { ok: false, content: '', model, usage: emptyUsage(), error: lastError, durationMs: Date.now() - started }
        }
      } else {
        lastError = `网络错误：${redact(error instanceof Error ? error.message : String(error))}`
      }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onExternalAbort)
    }

    if (attempt < maxRetries) {
      // 指数退避 + 抖动，避免多个请求同时重试打爆服务端
      await sleep(500 * 2 ** attempt + Math.random() * 250)
    }
  }

  return { ok: false, content: '', model, usage: emptyUsage(), error: lastError, durationMs: Date.now() - started }
}

function emptyUsage(): ChatUsage {
  return { promptTokens: null, completionTokens: null }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '(无法读取响应内容)'
  }
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

export interface AuditEntry {
  kind: string
  baseUrl: string
  model: string
  promptVersion: string | null
  input: unknown
  output: unknown
  status: 'ok' | 'error' | 'cancelled'
  error?: string | null
  usage?: ChatUsage
  durationMs?: number
}

export function recordAiRun(db: Db, entry: AuditEntry): void {
  try {
    db.run(
      `INSERT INTO ai_runs (kind, provider, model, base_url, prompt_version, input_json, output_json, status, error, prompt_tokens, completion_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.kind,
      'openai-compatible',
      entry.model,
      // 审计表里也要脱敏：base_url 有时会带 token 查询参数
      redact(entry.baseUrl),
      entry.promptVersion,
      truncate(JSON.stringify(entry.input ?? null), 20000),
      truncate(JSON.stringify(entry.output ?? null), 20000),
      entry.status,
      entry.error ? redact(entry.error).slice(0, 2000) : null,
      entry.usage?.promptTokens ?? null,
      entry.usage?.completionTokens ?? null,
      entry.durationMs ?? null
    )
  } catch {
    // 审计失败绝不能影响主流程
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[已截断]` : text
}

/** 探测可用模型列表（部分服务不支持该接口，失败不算致命）。 */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 15000
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    })
    if (!response.ok) {
      return { ok: false, models: [], error: `HTTP ${response.status}` }
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> }
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)
    return { ok: true, models }
  } catch (error) {
    return { ok: false, models: [], error: redact(error instanceof Error ? error.message : String(error)) }
  } finally {
    clearTimeout(timer)
  }
}
