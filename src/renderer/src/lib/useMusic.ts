/**
 * 背景音乐播放器（四季模式）。
 *
 * 三种模式：
 *  - season-random（默认）：**每次打开应用**从当季曲子里随机挑一首，一直循环
 *  - season-rotate：当季曲子按顺序轮播（放完一首换下一首）
 *  - single：从全部曲子里挑一首循环
 *
 * 挑曲、轮播这些容易出错的判断都在 `core/music` 里（纯函数、自检覆盖），
 * 这里只负责「拿数据 → 建 Audio → 跟着状态走」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nextIndex, normalizeMusicMode, randomIndex, seasonOfMonth, seasonTracks } from '@core/music'
import type { MusicMode, MusicSeason } from '@core/music'

export interface MusicTrackInfo {
  name: string
  file: string
  season: MusicSeason | null
  url: string
}

export interface MusicPlayer {
  tracks: MusicTrackInfo[]
  /** 当前季节（按系统月份算） */
  season: MusicSeason
  mode: MusicMode
  volume: number
  current: MusicTrackInfo | null
  playing: boolean
  /** 单曲循环选中的文件；null = 还没选过 */
  singleFile: string | null
  setMode: (mode: MusicMode) => void
  setVolume: (volume: number) => void
  chooseSingle: (file: string) => void
  toggle: () => void
  /** 轮播时手动下一首 */
  next: () => void
  ready: boolean
}

export function useMusic(enabled: boolean): MusicPlayer {
  const [tracks, setTracks] = useState<MusicTrackInfo[]>([])
  const [mode, setModeState] = useState<MusicMode>('season-random')
  const [volume, setVolumeState] = useState(0.3)
  const [singleFile, setSingleFile] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const season = seasonOfMonth(new Date().getMonth() + 1)

  /*
   * 当前模式的播放列表。
   * 单曲模式只放一首；另外两种都是「当季曲子」——
   * 当季一首都没有时 seasonTracks 会退回全部，不至于彻底没声。
   */
  const playlist = useMemo(() => {
    if (tracks.length === 0) return []
    if (mode === 'single') {
      const chosen = singleFile ? tracks.find((t) => t.file === singleFile) : null
      return [chosen ?? tracks[0]]
    }
    return seasonTracks(tracks, season)
  }, [tracks, mode, singleFile, season])

  /* 首次加载：曲库 + 偏好，并按模式随机挑一首当起点 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [list, prefs] = await Promise.all([window.api.app.music(), window.api.app.mediaPrefs()])
        if (!alive) return
        setTracks(list)
        const nextMode = normalizeMusicMode(prefs.musicMode)
        setModeState(nextMode)
        setSingleFile(prefs.musicTrack)
        setVolumeState(prefs.musicVolume)
        // 「每次打开应用随机」—— 只在启动时挑一次，切歌不该重新掷骰子
        if (nextMode !== 'season-rotate') {
          const pool = nextMode === 'single' ? list.length : seasonTracks(list, season).length
          setIndex(Math.max(0, randomIndex(pool)))
        } else {
          setIndex(Math.max(0, randomIndex(seasonTracks(list, season).length)))
        }
      } catch {
        // 没有音乐就安静地放着
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
    // season 在会话内不会变（跨零点也不会切换到别的季节）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 列表或模式变了：把下标收进合法范围，避免指向已不存在的曲子 */
  useEffect(() => {
    setIndex((i) => (playlist.length === 0 ? 0 : Math.min(Math.max(i, 0), playlist.length - 1)))
  }, [playlist])

  const current = playlist[index] ?? null

  /* 换曲 / 换音量 / 开关声音：重建或调整 Audio */
  useEffect(() => {
    const previous = audioRef.current
    previous?.pause()
    audioRef.current = null
    setPlaying(false)
    if (!current) return

    const audio = new Audio(current.url)
    // 只有轮播才需要「放完自动下一首」，另外两种模式靠 loop 一直放同一首
    audio.loop = mode !== 'season-rotate'
    audio.volume = volume
    audioRef.current = audio

    const onEnded = (): void => {
      if (mode === 'season-rotate') setIndex((i) => nextIndex(i, playlist.length))
    }
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', () => setPlaying(true))
    audio.addEventListener('pause', () => setPlaying(false))

    if (enabled) {
      void audio
        .play()
        .then(() => setPlaying(true))
        .catch(() => {
          // 自动播放被拒：等用户第一次点界面再放（Chromium 的策略）
          const resume = (): void => {
            if (enabled) void audio.play().then(() => setPlaying(true)).catch(() => undefined)
            window.removeEventListener('pointerdown', resume)
          }
          window.addEventListener('pointerdown', resume, { once: true })
        })
    }

    return () => {
      audio.removeEventListener('ended', onEnded)
      audio.pause()
      audioRef.current = null
    }
    // playlist.length 参与依赖：轮播到最后换下一首时下标会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.file, mode, enabled])

  /* 音量单独调，不重建 Audio（重建会把播放位置清零） */
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  const setMode = useCallback((next: MusicMode): void => {
    setModeState(next)
    // 换到单曲模式时，如果没选过就把当前这首记下来，避免列表来回跳
    void window.api.app.setMediaPrefs({ musicMode: next }).catch(() => undefined)
    setIndex(() => (next === 'single' ? 0 : Math.max(0, randomIndex(seasonTracks(tracks, season).length))))
  }, [tracks, season])

  const setVolume = useCallback((value: number): void => {
    const v = Math.min(Math.max(value, 0), 1)
    setVolumeState(v)
    void window.api.app.setMediaPrefs({ musicVolume: v }).catch(() => undefined)
  }, [])

  const chooseSingle = useCallback((file: string): void => {
    setSingleFile(file)
    setModeState('single')
    setIndex(0)
    void window.api.app.setMediaPrefs({ musicTrack: file, musicMode: 'single' }).catch(() => undefined)
  }, [])

  const toggle = useCallback((): void => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().then(() => setPlaying(true)).catch(() => undefined)
    else {
      audio.pause()
      setPlaying(false)
    }
  }, [])

  const next = useCallback((): void => {
    setIndex((i) => nextIndex(i, playlist.length))
  }, [playlist.length])

  return {
    tracks,
    season,
    mode,
    volume,
    current,
    playing,
    singleFile,
    setMode,
    setVolume,
    chooseSingle,
    toggle,
    next,
    ready
  }
}
