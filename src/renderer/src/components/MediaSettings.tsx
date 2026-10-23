/**
 * 设置页的「声音与背景」。
 *
 * 音乐和背景图都放在 <userData>/textures 下（见 main/services/media.ts），
 * 音乐目录可以改到任意文件夹（曲库可能放在项目目录 / 网盘里）。
 * 这里负责：选目录、上传（可按季节放进子文件夹）、选曲、删除。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { SEASON_LABELS, SEASON_ORDER } from '@core/music'
import type { MusicSeason } from '@core/music'
import { THEME_BACKDROP } from '@core/media'
import { Button, Notice, cx, useToast } from './ui'

interface Track {
  name: string
  file: string
  season: MusicSeason | null
  url: string
}

interface MediaPrefs {
  musicTrack: string | null
  backdrop: string | null
  musicMode: 'season-random' | 'season-rotate' | 'single'
  musicVolume: number
}

interface MusicDirState {
  custom: string | null
  upload: string
  dirs: string[]
}

/** 上传目标：'' = 直接放曲库根目录（不分季节） */
const UPLOAD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不分季节（曲库根目录）' },
  ...SEASON_ORDER.map((s) => ({ value: s, label: `${SEASON_LABELS[s]}季` }))
]

export function MediaSettings({ themePreview = null }: { themePreview?: string | null }): ReactNode {
  const toast = useToast()
  const [tracks, setTracks] = useState<Track[]>([])
  const [backdrops, setBackdrops] = useState<Array<{ name: string; url: string }>>([])
  const [prefs, setPrefs] = useState<MediaPrefs>({
    musicTrack: null,
    backdrop: null,
    musicMode: 'season-random',
    musicVolume: 0.3
  })
  const [dirState, setDirState] = useState<MusicDirState>({ custom: null, upload: '', dirs: [] })
  // 默认传到「其他（Other）」：和曲库现在的组织方式一致（四季各一个文件夹 + 其他）
  const [uploadSeason, setUploadSeason] = useState('other')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [t, b, p, d] = await Promise.all([
        window.api.app.music(),
        window.api.app.backdrops(),
        window.api.app.mediaPrefs(),
        window.api.app.musicDir()
      ])
      setTracks(t)
      setBackdrops(b)
      setPrefs(p)
      setDirState(d)
    } catch {
      // 读不到就显示空列表
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 改完通知 App 重跑（音乐立刻换、背景立刻换） */
  const notify = (): void => {
    window.dispatchEvent(new Event('sproutbook:media'))
  }

  const pickTrack = async (file: string | null): Promise<void> => {
    // 选具体某首 = 单曲循环；选「当季随机」= 清掉单曲并回到默认模式
    const next = await window.api.app.setMediaPrefs(
      file === null ? { musicTrack: null, musicMode: 'season-random' } : { musicTrack: file, musicMode: 'single' }
    )
    setPrefs(next)
    notify()
  }

  const pickBackdrop = async (name: string | null): Promise<void> => {
    const next = await window.api.app.setMediaPrefs({ backdrop: name })
    setPrefs(next)
    notify()
  }

  const pickMusicDir = async (): Promise<void> => {
    try {
      const r = await window.api.app.pickMusicDir()
      if (r.canceled) return
      setDirState({ custom: r.custom, upload: r.upload, dirs: r.dirs })
      await load()
      notify()
      toast.push('音乐目录已切换', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '切换失败', 'error')
    }
  }

  const resetMusicDir = async (): Promise<void> => {
    const r = await window.api.app.resetMusicDir()
    setDirState(r)
    await load()
    notify()
  }

  const importMusic = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.app.importMusic(uploadSeason || null)
      if (!r.canceled) {
        const where = uploadSeason ? `${SEASON_LABELS[uploadSeason as MusicSeason]}季的文件夹` : '曲库根目录'
        toast.push(`已添加，放到${where}`, 'success')
        await load()
        notify()
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '添加失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeMusic = async (track: Track): Promise<void> => {
    if (!window.confirm(`删除「${track.name}」？文件会一起删掉。`)) return
    const r = await window.api.app.removeMusic(track.file)
    setTracks(r)
    await load()
    notify()
  }

  const importBackdrops = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.app.importBackdrops()
      if (!r.canceled) {
        await load()
        notify()
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '添加失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeBackdrop = async (name: string): Promise<void> => {
    // 删掉的是用户自己传进来的文件，删了就得重新找 —— 先问一句
    if (!window.confirm(`删除背景图「${name}」？文件会一起删掉。`)) return
    const r = await window.api.app.removeBackdrop(name)
    setBackdrops(r)
    await load()
    notify()
  }

  /** 按季节分组渲染曲库（和 textures/music 的目录结构一致） */
  const groups: Array<{ key: string; label: string; items: Track[] }> = [
    ...SEASON_ORDER.map((season) => ({
      key: season,
      label: `${SEASON_LABELS[season]}季`,
      items: tracks.filter((t) => t.season === season)
    })),
    { key: 'none', label: '不分季节', items: tracks.filter((t) => t.season === null) }
  ].filter((g) => g.items.length > 0)

  return (
    <div className="media-settings">
      <div className="media-block">
        <div className="row tight" style={{ marginBottom: 6 }}>
          <b>背景音乐</b>
          <span className="spacer" />
          <Button size="small" onClick={() => void window.api.app.openMediaDir('music')} title="在资源管理器里打开音乐目录">
            打开目录
          </Button>
          <Button size="small" onClick={() => void pickMusicDir()}>
            选择目录
          </Button>
          {dirState.custom ? (
            <Button size="small" variant="ghost" onClick={() => void resetMusicDir()} title="回到默认的数据目录">
              恢复默认
            </Button>
          ) : null}
        </div>

        <div className="small" style={{ marginBottom: 4 }}>
          曲库目录：<span className="mono" style={{ wordBreak: 'break-all' }}>{dirState.upload || '（未设置）'}</span>
        </div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          结构参考：根目录下按「春季（Spring）」「夏季（Summer）」「秋季（Fall）」「冬季（Winter）」放子文件夹，
          顶层曲子算不分季节。当季模式下只放当前季节的曲子。
          {dirState.dirs.length > 1 ? ` 另外还会读：${dirState.dirs.slice(1).join('，')}` : ''}
        </div>

        <div className="row tight" style={{ marginBottom: 8 }}>
          <span className="small">上传到</span>
          <select
            className="pixel-select"
            value={uploadSeason}
            onChange={(e) => setUploadSeason(e.target.value)}
            aria-label="上传到哪个季节"
          >
            {UPLOAD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Button size="small" onClick={() => void importMusic()} disabled={busy}>
            上传音乐
          </Button>
        </div>

        {tracks.length === 0 ? (
          <div className="small muted">
            还没有音乐。上传 mp3 / ogg / wav 后会自动按当季播放；文件放在上面的曲库目录里。
          </div>
        ) : (
          <>
            <ul className="media-list">
              <li className={cx('media-row', prefs.musicMode !== 'single' && 'on')}>
                <span className="media-name">当季随机 / 轮播（默认）</span>
                <span className="spacer" />
                <Button
                  size="small"
                  variant={prefs.musicMode !== 'single' ? 'primary' : 'default'}
                  onClick={() => void pickTrack(null)}
                >
                  {prefs.musicMode !== 'single' ? '使用中' : '用这个'}
                </Button>
              </li>
            </ul>
            {groups.map((group) => (
              <div key={group.key} style={{ marginTop: 8 }}>
                <div className="small muted" style={{ marginBottom: 2 }}>
                  {group.label}（{group.items.length} 首）
                </div>
                <ul className="media-list">
                  {group.items.map((track) => {
                    const on = prefs.musicMode === 'single' && prefs.musicTrack === track.file
                    return (
                      <li key={track.file} className={cx('media-row', on && 'on')}>
                        <span className="media-name" title={track.file}>
                          {track.name}
                        </span>
                        <span className="spacer" />
                        <Button
                          size="small"
                          variant={on ? 'primary' : 'default'}
                          onClick={() => void pickTrack(track.file)}
                        >
                          {on ? '使用中' : '单曲循环'}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => void removeMusic(track)}>
                          删除
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="media-block">
        <div className="row tight" style={{ marginBottom: 6 }}>
          <b>背景图</b>
          <span className="spacer" />
          <Button size="small" onClick={() => void window.api.app.openMediaDir('backgrounds')} title="在资源管理器里打开背景图目录">
            打开目录
          </Button>
          <Button size="small" onClick={() => void importBackdrops()} disabled={busy}>
            上传背景
          </Button>
        </div>
        {/* 三个选项一直显示：主题背景 / 全部轮播 / 自己上传的 */}
        <div className="media-thumbs">
          {/*
            主题背景：用主题自带的第一张当预览图。
            以前这里只有文字，看着像"没图"；有图才看得出点它会变成什么样。
          */}
          <button
            type="button"
            className={cx('media-thumb', 'media-thumb-mode', prefs.backdrop === THEME_BACKDROP && 'on')}
            onClick={() => void pickBackdrop(THEME_BACKDROP)}
            title="只用主题自带的背景（不用上传的那些）"
          >
            {themePreview ? <img src={themePreview} alt="" /> : null}
            <span className="media-thumb-label">主题背景</span>
          </button>
          <button
            type="button"
            className={cx('media-thumb', 'media-thumb-all', prefs.backdrop === null && 'on')}
            onClick={() => void pickBackdrop(null)}
            title="主题自带的背景 + 自己上传的一起轮播"
          >
            全部轮播
          </button>
          {backdrops.map((item) => (
            <div key={item.name} className={cx('media-thumb', prefs.backdrop === item.name && 'on')}>
              <button
                type="button"
                className="media-thumb-pick"
                onClick={() => void pickBackdrop(item.name)}
                title={`用这张当背景：${item.name}`}
              >
                <img src={item.url} alt={item.name} />
              </button>
              <button
                type="button"
                className="media-thumb-del"
                title="删除这张"
                onClick={() => void removeBackdrop(item.name)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <Notice tone="info">
          「主题背景」= 只显示主题自带的那几张；「全部轮播」= 主题自带的和你上传的一起轮；点某一张就只用它一个。
          {backdrops.length === 0 ? ' 现在还没有上传的背景图，用「上传背景」加 png / jpg。' : ''}
        </Notice>
      </div>
    </div>
  )
}
