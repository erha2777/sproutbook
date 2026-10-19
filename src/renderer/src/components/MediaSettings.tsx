/**
 * 设置页的「声音与背景」。
 *
 * 音乐和背景图都放在 <userData>/textures 下（见 main/services/media.ts），
 * 这里负责：上传、选择、删除。选中的名字存进 settings（media.prefs），
 * 改完 dispatch 一个 window 事件，App 那边重跑加载 —— 不用把播放器状态提上来。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { THEME_BACKDROP } from '@core/media'
import { Button, Notice, cx, useToast } from './ui'

interface Track {
  name: string
  url: string
}

export function MediaSettings(): ReactNode {
  const toast = useToast()
  const [tracks, setTracks] = useState<Track[]>([])
  const [backdrops, setBackdrops] = useState<Track[]>([])
  const [prefs, setPrefs] = useState<{ musicTrack: string | null; backdrop: string | null }>({
    musicTrack: null,
    backdrop: null
  })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [t, b, p] = await Promise.all([
        window.api.app.music(),
        window.api.app.backdrops(),
        window.api.app.mediaPrefs()
      ])
      setTracks(t)
      setBackdrops(b)
      setPrefs(p)
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

  const pickTrack = async (name: string | null): Promise<void> => {
    const next = await window.api.app.setMediaPrefs({ musicTrack: name })
    setPrefs(next)
    notify()
  }

  const pickBackdrop = async (name: string | null): Promise<void> => {
    const next = await window.api.app.setMediaPrefs({ backdrop: name })
    setPrefs(next)
    notify()
  }

  const importMusic = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.app.importMusic()
      if (!r.canceled) {
        toast.push(`已添加 ${r.tracks.length} 首`, 'success')
        await load()
        notify()
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '添加失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeMusic = async (name: string): Promise<void> => {
    const r = await window.api.app.removeMusic(name)
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

  return (
    <div className="media-settings">
      <div className="media-block">
        <div className="row tight" style={{ marginBottom: 6 }}>
          <b>背景音乐</b>
          <span className="spacer" />
          <Button size="small" onClick={() => void importMusic()} disabled={busy}>
            上传音乐
          </Button>
        </div>
        {tracks.length === 0 ? (
          <div className="small muted">
            还没有音乐。上传 mp3 / ogg / wav 后会自动循环播放；文件放在 {`<数据目录>/textures/music`}。
          </div>
        ) : (
          <ul className="media-list">
            <li className={cx('media-row', prefs.musicTrack === null && 'on')}>
              <span className="media-name">按文件名顺序轮播第一首</span>
              <span className="spacer" />
              <Button size="small" variant={prefs.musicTrack === null ? 'primary' : 'default'} onClick={() => void pickTrack(null)}>
                {prefs.musicTrack === null ? '使用中' : '用这首'}
              </Button>
            </li>
            {tracks.map((track) => {
              const on = prefs.musicTrack === track.name
              return (
                <li key={track.name} className={cx('media-row', on && 'on')}>
                  <span className="media-name" title={track.name}>
                    {track.name}
                  </span>
                  <span className="spacer" />
                  <Button size="small" variant={on ? 'primary' : 'default'} onClick={() => void pickTrack(track.name)}>
                    {on ? '使用中' : '用这首'}
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => void removeMusic(track.name)}>
                    删除
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="media-block">
        <div className="row tight" style={{ marginBottom: 6 }}>
          <b>背景图</b>
          <span className="spacer" />
          <Button size="small" onClick={() => void importBackdrops()} disabled={busy}>
            上传背景
          </Button>
        </div>
        {/* 三个选项一直显示：主题背景 / 全部轮播 / 自己上传的 */}
        <div className="media-thumbs">
          <button
            type="button"
            className={cx('media-thumb', 'media-thumb-all', prefs.backdrop === THEME_BACKDROP && 'on')}
            onClick={() => void pickBackdrop(THEME_BACKDROP)}
            title="只用主题自带的背景（不用上传的那些）"
          >
            主题背景
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
