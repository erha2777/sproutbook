/**
 * 设置页 —— AI 配置、数据目录与备份、关于。
 *
 * 关于 API Key 的两个原则：
 *  1. 密钥存系统钥匙串，界面只显示「是否已配置」，永不回显密钥本身。
 *  2. 钥匙串不可用时降级为明文，但会明确提示用户，而不是悄悄这么做。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiSettings, AppInfo, SandboxStatus } from '@core/types'
import type { AppPaths, BackupInfo, WeatherConfigSnapshot } from '@shared/api'
import { formatBytes, formatDateTime } from '../lib/util'
import { Badge, Button, EmptyState, Field, Notice, Panel, SectionTitle, SelectInput, Sign, Spinner, TextInput, useToast } from '../components/ui'
import { EnvironmentManager } from '../components/EnvironmentManager'
import { TransferPanel } from '../components/TransferPanel'

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
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  /**
   * 天气数据源配置。
   * key 填了之后**不回显** —— 和 AI 那边同一个原则，只说配没配。
   */
  const [weatherConfig, setWeatherConfig] = useState<WeatherConfigSnapshot | null>(null)
  const [qweatherHostDraft, setQweatherHostDraft] = useState('')
  const [qweatherKeyDraft, setQweatherKeyDraft] = useState('')
  const [weatherTesting, setWeatherTesting] = useState(false)
  const [weatherTestResult, setWeatherTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  /**
   * 保存天气配置。
   *
   * key 只在**填了新值**时才提交 —— 只改 Host 的时候不能把已存的 key 抹掉，
   * 那是用户最容易踩的一步（改完 Host 点保存，key 没了）。
   */
  const patchWeather = async (patch: {
    provider?: 'open-meteo' | 'qweather'
    qweatherHost?: string
  }): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.weather.saveConfig({
        provider: patch.provider ?? weatherConfig?.provider,
        qweatherHost: patch.qweatherHost ?? qweatherHostDraft,
        qweatherKey: qweatherKeyDraft.trim() === '' ? undefined : qweatherKeyDraft.trim()
      })
      setWeatherConfig(next)
      setQweatherHostDraft(next.qweatherHost)
      setQweatherKeyDraft('')
      setWeatherTestResult(null)
      toast.push('天气数据源已保存', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const load = useCallback(async () => {
    try {
      {
        const wc = await window.api.weather.config()
        setWeatherConfig(wc)
        setQweatherHostDraft(wc.qweatherHost)
      }
      const [s, p, i, b, w, sb] = await Promise.all([
        window.api.ai.getSettings(),
        window.api.app.paths(),
        window.api.app.info(),
        window.api.app.backups(),
        window.api.ai.keyWarning(),
        window.api.sandbox.status()
      ])
      setSettings(s)
      setPaths(p)
      setInfo(i)
      setBackups(b)
      setKeyWarning(w)
      setSandbox(sb)
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

          <Field label="视觉模型（预留）" help="识图功能将使用这个模型，当前版本尚未启用。">
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

      <EnvironmentManager />

      <TransferPanel />

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
        <SectionTitle
          right={
            <Badge tone={sandbox?.disabled ? 'warn' : 'ok'}>
              {sandbox?.disabled ? '沙箱已关闭' : '沙箱已启用'}
            </Badge>
          }
        >
          启动兼容性
        </SectionTitle>

        <div className="content-inner">
          <div className="small">
            <div>
              进程完整性级别：<b>{sandbox?.integrityLevel ?? '未知'}</b>
            </div>
            {sandbox?.reason ? <div>关闭沙箱的原因：{sandbox.reason}</div> : null}
          </div>

          {sandbox?.disabled ? (
            <Notice tone="warn">
              当前进程已关闭 Chromium 沙箱。这会让应用能在这台机器上启动，但会降低进程隔离强度。
              本应用只加载本地文件、CSP 禁止一切远程资源、contextIsolation 开启且 nodeIntegration 关闭，
              因此实际风险有限。若能排查出根因（常见为低完整性环境或第三方安全软件），建议恢复沙箱。
            </Notice>
          ) : (
            <Notice tone="info">
              如果双击 <span className="mono">Sproutbook.exe</span> 没有任何反应（无窗口、无报错、
              事件查看器里是 <span className="mono">0x80000003</span>），
              通常是 Chromium 沙箱在受限环境下无法初始化。
              <br />
              这种崩溃发生在应用代码之前，<b>应用内无法自救</b>（实测确认：即使提前写标记文件，
              沙箱初始化仍然早于主进程 JavaScript），所以 <span className="mono">--no-sandbox</span>
              必须出现在命令行上。下面的按钮会创建一个<b>原生快捷方式</b>把这个参数烘焙进去 ——
              之后双击那个图标即可运行，不需要管理员权限，也没有控制台窗口。
            </Notice>
          )}

          {sandbox && sandbox.shortcuts.length > 0 ? (
            <table className="pixel-table">
              <thead>
                <tr>
                  <th>快捷方式</th>
                  <th style={{ width: 90 }}>位置</th>
                  <th style={{ width: 80 }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {sandbox.shortcuts.map((s) => (
                  <tr key={s.path}>
                    <td className="small mono" style={{ wordBreak: 'break-all' }}>
                      {s.path}
                    </td>
                    <td className="small">{s.scope === 'desktop' ? '桌面' : '开始菜单'}</td>
                    <td className="small">{s.exists ? <Badge tone="ok">已创建</Badge> : '未创建'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <div className="row">
            <Button
              variant="primary"
              disabled={busy || sandbox?.canCreateShortcut === false}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await window.api.sandbox.createShortcut('desktop')
                  setSandbox(await window.api.sandbox.status())
                  toast.push(`已创建桌面快捷方式：${result.created.path}`, 'success')
                } catch (error) {
                  toast.push(error instanceof Error ? error.message : '创建快捷方式失败', 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              在桌面创建兼容模式快捷方式
            </Button>
            <Button
              variant="ghost"
              disabled={busy || sandbox?.canCreateShortcut === false}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await window.api.sandbox.createShortcut('startMenu')
                  setSandbox(await window.api.sandbox.status())
                  toast.push(`已创建开始菜单快捷方式：${result.created.path}`, 'success')
                } catch (error) {
                  toast.push(error instanceof Error ? error.message : '创建快捷方式失败', 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              在开始菜单创建
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !sandbox?.shortcuts.some((s) => s.exists)}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await window.api.sandbox.removeShortcuts()
                  setSandbox(await window.api.sandbox.status())
                  toast.push(result.removed.length > 0 ? `已删除 ${result.removed.length} 个快捷方式` : '没有需要删除的快捷方式', 'success')
                } catch (error) {
                  toast.push(error instanceof Error ? error.message : '删除失败', 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              删除快捷方式
            </Button>
          </div>
        </div>
      </Panel>

      <Panel>
        <SectionTitle
          right={
            <Badge tone={weatherConfig?.qweatherReady ? 'ok' : 'muted'}>
              {weatherConfig?.activeLabel ?? '…'}
            </Badge>
          }
        >
          天气数据源
        </SectionTitle>
        <div className="small muted" style={{ marginBottom: 8 }}>
          霜冻预警要按你所在位置的天气判断。默认用 <b>Open-Meteo</b>：免费、不用注册。
          但它是全球模型，<b>认不出中国的区县</b> ——「湘阴县」查不到，而「华容县」却查得到，不可靠。
          想要区县级精度就配一个<b>和风天气</b>的 key。<b>不配也完全能用</b>，只是地名的精度停在市一级。
        </div>

        <Field label="数据源">
          <SelectInput
            value={weatherConfig?.provider ?? 'open-meteo'}
            onChange={(v) => void patchWeather({ provider: v as 'open-meteo' | 'qweather' })}
            options={[
              { value: 'open-meteo', label: 'Open-Meteo（免注册，精度到市）' },
              { value: 'qweather', label: '和风天气（需 API Key，可到区县）' }
            ]}
          />
        </Field>

        {weatherConfig?.provider === 'qweather' ? (
          <>
            <Field
              label="API Host"
              help="在 dev.qweather.com 控制台 → 设置 里查看。每个账号随机分配一个，形如 <你的ID>.xx.qweatherapi.com —— 中间那两位各人不同（有 xy、re 等），照抄自己的即可，不要照抄示例。只填域名，不要带 https:// 前缀。"
            >
              <TextInput
                value={qweatherHostDraft}
                onChange={setQweatherHostDraft}
                placeholder="<你的ID>.xx.qweatherapi.com"
              />
            </Field>
            <Field
              label="API Key"
              help={
                (weatherConfig.hasWeatherKey
                  ? '已配置。留空＝保持不变；填入新值会覆盖。'
                  : '在同一个控制台里创建。密钥存进系统钥匙串，不会写进数据库。') +
                '注意：和风的每个凭据要单独勾选能访问哪些 API —— 没勾 GeoAPI 的话，测试会报 403。'
              }
            >
              <TextInput
                value={qweatherKeyDraft}
                onChange={setQweatherKeyDraft}
                type="password"
                placeholder={weatherConfig.hasWeatherKey ? '••••••••（已配置）' : ''}
              />
            </Field>
            {/*
              额度提示。用户自己找来的公告：API KEY 自 2027-02-01 起限 1000 次/天，
              JWT 无限制；超额返回 403/429，继续猛发可能被封 IP。

              写成「你现在用多少、什么时候生效」，而不是只丢一个数字 ——
              不然看到「1000 次」反而会以为快用完了。
            */}
            <Notice tone="info">
              和风对 <b>API KEY</b> 限制 <b>1000 次/天</b>（<b>2027-02-01</b> 起生效），
              改用 JWT 认证则无限制。
              <br />
              按现在的用法：一个养护位置约 <b>8 次/天</b>（预报缓存 3 小时，地名只解析一次），用不到 1%。
              养护计划页底部会显示「今天已请求 N 次」，可以随时对照。
              <br />
              超额会返回 403 / 429；<b>那时先停下来</b> —— 公告里写明继续大量请求可能被封 IP 或冻结帐号。
            </Notice>

            <div className="row tight">
              <Button size="small" onClick={() => void patchWeather({})} disabled={busy}>
                保存
              </Button>
              <Button
                size="small"
                disabled={weatherTesting || !weatherConfig.qweatherReady}
                onClick={async () => {
                  setWeatherTesting(true)
                  setWeatherTestResult(null)
                  try {
                    // 拿「湘阴县」试 —— 那正是 Open-Meteo 认不出、用户真正需要的那个地名
                    const r = await window.api.weather.testLocation('湘阴县')
                    setWeatherTestResult(
                      r.ok
                        ? {
                            ok: true,
                            message: `定位到「${r.label}」，精度：${r.level === 'district' ? '区县级' : '市级'}`
                          }
                        : { ok: false, message: r.error ?? '测试失败' }
                    )
                  } finally {
                    setWeatherTesting(false)
                  }
                }}
              >
                {weatherTesting ? '测试中…' : '用「湘阴县」试一下'}
              </Button>
              <span className="small muted">{weatherConfig.qweatherReady ? '' : '填好 Host 和 Key 才能测'}</span>
            </div>
            {weatherTestResult ? (
              <Notice tone={weatherTestResult.ok ? 'info' : 'warn'}>{weatherTestResult.message}</Notice>
            ) : null}
          </>
        ) : null}
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
