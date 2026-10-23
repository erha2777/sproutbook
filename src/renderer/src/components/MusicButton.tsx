/**
 * 左上角**唯一**那颗声音按钮：喇叭（静音）+ 音乐，合在一处。
 *
 * 以前是「喇叭」和「音乐」两颗并排 —— 用户看着像两个开关管一件事。
 * 现在只有一颗：点开面板，里面既有声音开关，也有播放/暂停、模式、音量、曲单。
 * 正在放歌时按钮右下角闪一个小音符，不开面板也知道有声音。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { MUSIC_MODE_HINTS, MUSIC_MODE_LABELS, SEASON_LABELS, SEASON_ORDER } from '@core/music'
import type { MusicMode } from '@core/music'
import type { MusicPlayer } from '../lib/useMusic'
import { Button } from './ui'
import { PixelIcon } from './PixelIcon'

const MODES: MusicMode[] = ['season-random', 'season-rotate', 'single']

export function MusicButton({
  music,
  soundOn,
  onToggleSound
}: {
  music: MusicPlayer
  soundOn: boolean
  onToggleSound: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const label = music.current ? music.current.name : '没有音乐'
  return (
    <>
      <button
        type="button"
        className={`home-gear global-sound sound-ctl${music.playing && soundOn ? ' playing' : ''}${soundOn ? '' : ' muted'}`}
        title={
          `${soundOn ? '声音：开' : '声音：关'}  音乐：${label}${music.playing ? '' : '（未播放）'}\n点击打开声音 / 音乐设置`
        }
        aria-label="声音与音乐"
        onClick={() => setOpen((v) => !v)}
      >
        <PixelIcon name={soundOn ? 'sound' : 'mute'} size={24} />
        {music.playing && soundOn ? <i className="sound-note" aria-hidden>♪</i> : null}
        <span className="sr-only">声音与音乐</span>
      </button>

      {open ? (
        <div className="music-panel" role="dialog" aria-label="背景音乐设置">
          <div className="music-panel-head">
            <span className="small muted">
              当季：{SEASON_LABELS[music.season]} · 共 {music.tracks.length} 首
            </span>
            <span className="row tight">
              <Button size="small" onClick={onToggleSound} title="音效和背景音乐一起关 / 开">
                {soundOn ? '🔊 声音开' : '🔇 已静音'}
              </Button>
              <button type="button" className="music-panel-close" onClick={() => setOpen(false)} title="收起">
                ×
              </button>
            </span>
          </div>

          <div className="music-now">
            <span className="music-now-name" title={label}>
              {label}
            </span>
            <span className="row tight">
              <Button size="small" onClick={() => music.toggle()} title="播放 / 暂停">
                {music.playing ? '暂停' : '播放'}
              </Button>
              {music.mode === 'season-rotate' ? (
                <Button size="small" onClick={() => music.next()} title="下一首">
                  下一首
                </Button>
              ) : null}
            </span>
          </div>

          <div className="music-modes">
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`music-mode${music.mode === mode ? ' on' : ''}`}
                onClick={() => music.setMode(mode)}
                title={MUSIC_MODE_HINTS[mode]}
              >
                {MUSIC_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {MUSIC_MODE_HINTS[music.mode]}
          </div>

          <div className="row tight" style={{ marginBottom: 8 }}>
            <span className="small">音量</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(music.volume * 100)}
              onChange={(e) => music.setVolume(Number(e.target.value) / 100)}
              className="music-volume"
              aria-label="音乐音量"
            />
            <span className="small muted">{Math.round(music.volume * 100)}</span>
          </div>

          {music.mode === 'single' ? (
            <div className="music-list">
              {SEASON_ORDER.map((season) => {
                const list = music.tracks.filter((t) => t.season === season)
                if (list.length === 0) return null
                return (
                  <div key={season}>
                    <div className="music-list-head">{SEASON_LABELS[season]}</div>
                    {list.map((track) => (
                      <button
                        key={track.file}
                        type="button"
                        className={`music-track${music.current?.file === track.file ? ' on' : ''}`}
                        onClick={() => music.chooseSingle(track.file)}
                        title={track.name}
                      >
                        {track.name}
                      </button>
                    ))}
                  </div>
                )
              })}
              {music.tracks.some((t) => t.season === null) ? (
                <div>
                  <div className="music-list-head">其他（不分季节）</div>
                  {music.tracks
                    .filter((t) => t.season === null)
                    .map((track) => (
                      <button
                        key={track.file}
                        type="button"
                        className={`music-track${music.current?.file === track.file ? ' on' : ''}`}
                        onClick={() => music.chooseSingle(track.file)}
                        title={track.name}
                      >
                        {track.name}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="small muted" style={{ marginTop: 8 }}>
            曲子放在 <span className="mono">textures/music</span>，按「春季（Spring）」这类文件夹分季。
          </div>
        </div>
      ) : null}
    </>
  )
}
