/**
 * 界面音效：极轻的「咔哒 / 完成」提示音。
 *
 * 为什么不用音频文件：整个应用一个资源文件都没有（像素图也是现画的），
 * 这里用 WebAudio 合成两个方波音，体积为 0，也不会被 CSP 拦。
 *
 * 规则：
 *  - 默认开启，可在首页左下角喇叭图标关闭（存 localStorage）
 *  - 音量压得很低，只是「手感」，不是背景音乐
 */

type SoundKind = 'click' | 'success' | 'error'

const STORAGE_KEY = 'sproutbook.sfx'
const VOLUME = 0.045

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    // 没有音频设备 / 被策略拦：静默降级
    return null
  }
}

function beep(freq: number, duration: number, type: OscillatorType, delay = 0): void {
  const ac = audio()
  if (!ac) return
  const start = ac.currentTime + delay
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(VOLUME, start + 0.006)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

export function isSfxOn(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function setSfx(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    // 存不了就只在本次生效
  }
}

export function sfx(kind: SoundKind): void {
  if (!isSfxOn()) return
  if (kind === 'click') {
    beep(560, 0.055, 'square')
  } else if (kind === 'success') {
    // 完成：两个音的小上行，像游戏里的确认音
    beep(660, 0.09, 'square')
    beep(880, 0.12, 'square', 0.08)
  } else {
    beep(180, 0.16, 'sawtooth')
  }
}
