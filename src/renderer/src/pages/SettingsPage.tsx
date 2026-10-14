/**
 * 设置页 —— AI 配置、数据目录与备份、关于。
 *
 * 关于 API Key 的两个原则：
 *  1. 密钥存系统钥匙串，界面只显示「是否已配置」，永不回显密钥本身。
 *  2. 钥匙串不可用时降级为明文，但会明确提示用户，而不是悄悄这么做。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiSettings, AppInfo } from '@core/types'
import type { AppPaths, BackupInfo } from '@shared/api'
import { formatBytes, formatDateTime } from '../lib/util'
import { Badge, Button, EmptyState, Field, Notice, Panel, SectionTitle, SelectInput, Sign, Spinner, TextInput, useToast } from '../components/ui'

const PRESETS: Array<{ label: string; baseUrl: string; chatModel: string; visionModel: string }> = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat', visionModel: '' },
  { label: 'Moonshot 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', chatModel: 'moonshot-v1-8k', visionModel: '' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModel: 'glm-4-flash', visionModel: 'glm-4v-flash' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', chatModel: '', visionModel: '' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', chatModel: 'qwen2.5:7b', visionModel: 'llava' },
  { label: '本地 LM Studio', baseUrl: 'http://localhost:1234/v1', chatModel: '', visionModel: '' }
]

export function SettingsPage(): ReactNode {
  const toast = useToast()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [keyWarning, setKeyWarning] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; models?: string[]; latencyMs?: number } | null>(null)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, p, i, b, w] = await Promise.all([
        window.api.ai.getSettings(),
        window.api.app.paths(),
        window.api.app.info(),
        window.api.app.backups(),
        window.api.ai.keyWarning()
      ])
      setSettings(s)
      setPaths(p)
      setInfo(i)
      setBackups(b)
      setKeyWarning(w)
    } catch (error) {
      toast.push(`加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (changes: Partial<AiSettings> & { apiKey?: string }): Promise<void> => {
    try {
      const next = await window.api.ai.setSettings(changes)
      setSettings(next)
      setKeyWarning(await window.api.ai.keyWarning())
    } catch (error) {
      toast.push(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.ai.test()
      setTestResult(result)
      if (result.ok) toast.push(result.message, 'success')
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!settings) {
    return (
      <Panel>
        <Spinner label="加载设置中…" />
      </Panel>
    )
  }

  return (
    <div className="content-inner">
      <Panel>
        <SectionTitle right={<Badge tone={settings.hasApiKey ? 'ok' : 'muted'}>{settings.hasApiKey ? '已配置密钥' : '未配置密钥'}</Badge>}>
          AI 配置
        </SectionTitle>

        <Notice tone="info">
          AI 是<b>可选增强</b>，不配置也能使用全部功能。所有调用都从本机直接发往你填写的服务地址，
          应用不经过任何中转服务器；每次调用都会记录在本地审计表里，便于排查。
        </Notice>

        {keyWarning ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">{keyWarning}</Notice>
          </div>
        ) : null}

        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="服务预设" help="选择后会自动填入接口地址与常见模型名，可再手动修改。">
            <SelectInput
              value=""
              onChange={(v) => {
                const preset = PRESETS.find((p) => p.label === v)
                if (!preset) return
                void patch({ baseUrl: preset.baseUrl, chatModel: preset.chatModel, visionModel: preset.visionModel })
                toast.push(`已套用 ${preset.label} 预设`, 'success')
              }}
              placeholder="选择预设…"
              options={PRESETS.map((p) => ({ value: p.label, label: p.label }))}
            />
          </Field>

          <Field
            label="接口地址（Base URL）"
            help="OpenAI 兼容格式，通常以 /v1 结尾。应用会访问 {地址}/chat/completions。"
            wide
          >
            <TextInput value={settings.baseUrl} onChange={(v) => void patch({ baseUrl: v })} placeholder="https://api.deepseek.com/v1" />
          </Field>

          <Field label="对话模型" required help="用于信息补全，如 deepseek-chat / gpt-4o-mini / qwen2.5:7b。">
            <TextInput value={settings.chatModel} onChange={(v) => void patch({ chatModel: v })} placeholder="deepseek-chat" />
          </Field>

          <Field label="视觉模型（预留）" help="识图功能将使用这个模型，v0.1 暂未启用。">
            <TextInput value={settings.visionModel} onChange={(v) => void patch({ visionModel: v })} placeholder="gpt-4o-mini" />
          </Field>

          <Field
            label="API Key"
            wide
            help="保存在操作系统钥匙串中，不会写进数据库、不会进 git、不会回显。留空则保持不变。"
          >
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <TextInput
                value={apiKeyDraft}
                onChange={setApiKeyDraft}
                type="password"
                placeholder={settings.hasApiKey ? '••••••••（已配置，留空不修改）' : 'sk-...'}
              />
              <Button
                onClick={() => {
                  void patch({ apiKey: apiKeyDraft })
                  setApiKeyDraft('')
                  toast.push(apiKeyDraft.trim() ? '密钥已保存' : '已清空密钥', 'success')
                }}
              >
                保存密钥
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void window.api.ai.clearApiKey().then(setSettings)
                  toast.push('密钥已清除', 'success')
                }}
              >
                清除
              </Button>
            </div>
          </Field>

          <Field label="超时（毫秒）" help="网络慢或本地模型首次加载时，可调大到 120000。">
            <TextInput
              value={String(settings.timeoutMs)}
              onChange={(v) => void patch({ timeoutMs: Math.min(Math.max(Number(v) || 60000, 5000), 300000) })}
            />
          </Field>

          <Field label="失败重试次数" help="只对网络错误、429、5xx 重试；4xx 会立即失败。">
            <TextInput
              value={String(settings.maxRetries)}
              onChange={(v) => void patch({ maxRetries: Math.min(Math.max(Number(v) || 0, 0), 5) })}
            />
          </Field>

          <Field label="随机性（temperature）" help="整理资料建议 0.2 ~ 0.4，太高容易编造。">
            <TextInput
              value={String(settings.temperature)}
              onChange={(v) => void patch({ temperature: Math.min(Math.max(Number(v) || 0, 0), 2) })}
            />
          </Field>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <Button variant="primary" onClick={() => void test()} disabled={testing || !settings.hasApiKey}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <span className="small muted">
            {!settings.hasApiKey ? '请先保存 API Key。' : '会先尝试列出模型；若服务不支持，则改用一次极短对话验证。'}
          </span>
        </div>

        {testResult ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone={testResult.ok ? 'info' : 'danger'}>
              {testResult.message}
              {testResult.latencyMs ? <span className="small muted">（{testResult.latencyMs} ms）</span> : null}
              {testResult.models && testResult.models.length > 0 ? (
                <details style={{ marginTop: 6 }}>
                  <summary className="small" style={{ cursor: 'pointer' }}>
                    查看可用模型（{testResult.models.length}）
                  </summary>
                  <div className="row tight" style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
                    {testResult.models.slice(0, 120).map((m) => (
                      <button
                        key={m}
                        className="pixel-tag"
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          void patch({ chatModel: m })
                          toast.push(`已选择模型 ${m}`, 'success')
                        }}
                        title="点击设为对话模型"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
            </Notice>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <SectionTitle>数据与备份</SectionTitle>
        {paths ? (
          <div className="content-inner">
            <div className="small">
              <div>
                <b>数据目录：</b>
                <span className="mono">{paths.data}</span>
              </div>
              <div>
                <b>图片目录：</b>
                <span className="mono">{paths.images}</span>
              </div>
              <div>
                <b>备份目录：</b>
                <span className="mono">{paths.backups}</span>
              </div>
              <div>
                <b>系统钥匙串：</b>
                {paths.encryptionAvailable ? '可用' : '不可用（密钥将明文保存）'}
              </div>
            </div>

            <div className="row">
              <Button onClick={() => void window.api.app.openDataDir()}>打开数据目录</Button>
              <Button onClick={() => void window.api.app.openImagesDir()}>打开图片目录</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const result = await window.api.app.backupNow()
                    setBackups(await window.api.app.backups())
                    toast.push(result ? '备份已创建' : '备份失败：数据库文件不存在', result ? 'success' : 'error')
                  } catch (error) {
                    toast.push(error instanceof Error ? error.message : '备份失败', 'error')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                立即备份
              </Button>
            </div>

            <Notice tone="info">
              应用会在每次启动、退出以及数据库结构升级前自动备份，滚动保留最近 5 份。
              备份文件是完整的 SQLite 数据库，可以直接复制到别处保存。
            </Notice>

            {backups.length === 0 ? (
              <EmptyState icon="💾" title="还没有备份" hint="点击「立即备份」创建第一份。" />
            ) : (
              <table className="pixel-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th style={{ width: 110 }}>大小</th>
                    <th>文件</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.slice(0, 10).map((b) => (
                    <tr key={b.path}>
                      <td className="small">{formatDateTime(b.createdAt)}</td>
                      <td className="small">{formatBytes(b.size)}</td>
                      <td className="small mono ellipsis" style={{ maxWidth: 340 }}>
                        {b.path}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <Spinner />
        )}
      </Panel>

      <Panel>
        <SectionTitle>关于</SectionTitle>
        {info ? (
          <div className="content-inner">
            <Sign>{info.name}</Sign>
            <div className="small">
              <div>版本：{info.version}</div>
              <div>
                Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
              </div>
              <div>SQLite {info.sqlite}（Node 内置 node:sqlite，无需任何原生编译）</div>
              <div>平台：{info.platform}</div>
            </div>
            <Notice tone="info">
              这是一个本地优先的应用：数据全部保存在你自己电脑上，没有账号、没有云端。
              因此<b>请定期备份</b>，或直接复制上面列出的数据目录。
            </Notice>
          </div>
        ) : (
          <Spinner />
        )}
      </Panel>
    </div>
  )
}
