// Voice lines. One OpenAI voice, several takes for the lines that repeat.
import voiceFile from '../presets/voice.json'
import { audio, out } from './core.ts'
import { createPitchShift } from './pitch-shift.ts'
import { burst, shaper, tone } from './synth.ts'

export type VoicePhrase = {
  id: string
  game: string
  lines: string[]
}

export type VoiceFile = {
  rate: number
  pitch: number
  voice: string
  radio: {
    enabled: boolean
    highpass: number
    lowpass: number
    drive: number
    gain: number
    squelchGain: number
    squelchF: number
    squelchTone: number
    squelchToneGain: number
    squelchLead: number
  }
  phrases: VoicePhrase[]
}

export const voicePresets = voiceFile as VoiceFile

let voiceBase = '/voices'
let clipLookup: ((voice: string, file: string) => string | undefined) | null = null

export function setVoiceBase(url: string) {
  voiceBase = url.replace(/\/$/, '')
  buffers.clear()
}

/** Vite asset map. Keys are paths ending in `/<voice>/<file>.mp3`. */
export function useVoiceClips(files: Record<string, string>) {
  clipLookup = (voice, file) => {
    const suffix = `/${voice}/${file}`
    for (const [key, url] of Object.entries(files)) {
      if (key.endsWith(suffix)) return url
    }
    return undefined
  }
  buffers.clear()
}

export function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function clipFile(text: string) {
  return `${slug(text)}.mp3`
}

const buffers = new Map<string, Promise<AudioBuffer>>()
const lastLine = new Map<string, string>()

export function pickLine(phrase: VoicePhrase): string {
  const lines = phrase.lines
  const only = lines[0]
  if (!only) throw new Error(`empty phrase ${phrase.id}`)
  if (lines.length === 1) return only
  const prev = lastLine.get(phrase.id)
  const pool = prev ? lines.filter((line) => line !== prev) : lines
  const line = pool[Math.floor(Math.random() * pool.length)] ?? only
  lastLine.set(phrase.id, line)
  return line
}

async function clip(voice: string, text: string) {
  const file = clipFile(text)
  const url = clipLookup ? clipLookup(voice, file) : `${voiceBase}/${voice}/${file}`
  if (!url) throw new Error(`missing clip ${voice}/${file}`)
  let pending = buffers.get(url)
  if (!pending) {
    pending = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`)
      return r.arrayBuffer()
    }).then((b) => audio().decodeAudioData(b))
    buffers.set(url, pending)
    pending.catch(() => buffers.delete(url))
  }
  return pending
}

function squelch(t: number, dest: AudioNode = out()) {
  const radio = voicePresets.radio
  burst(t, { filter: 'bandpass', f0: radio.squelchF, q: 0.8, d: 0.09, gain: radio.squelchGain, dest })
  tone(t, { type: 'square', f0: radio.squelchTone, d: 0.02, gain: radio.squelchToneGain, filter: 'lowpass', fc: 3000, dest })
}

function radioChain(dest: AudioNode) {
  const c = audio()
  const radio = voicePresets.radio
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = radio.highpass
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = radio.lowpass
  const g = c.createGain()
  g.gain.value = radio.gain
  hp.connect(lp)
  const shaped = radio.drive > 0.05 ? lp.connect(shaper(radio.drive)) : lp
  shaped.connect(g).connect(dest)
  return hp
}

export async function playClip(
  voice: string,
  text: string,
  { radio = voicePresets.radio.enabled, rate = voicePresets.rate, pitch = voicePresets.pitch, dest = out() } = {},
) {
  const buf = await clip(voice, text)
  const ratio = Math.min(2, Math.max(0.5, pitch / rate))
  const shifter = Math.abs(ratio - 1) > 0.01 ? await createPitchShift(ratio) : null
  const c = audio()
  const t = c.currentTime + 0.02
  const src = c.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = rate
  const chain = radio ? radioChain(dest) : dest
  if (shifter) src.connect(shifter).connect(chain)
  else src.connect(chain)
  const lead = radio ? voicePresets.radio.squelchLead : 0
  const end = t + lead + buf.duration / rate
  if (radio) {
    squelch(t, dest)
    squelch(end, dest)
  }
  src.start(t + lead)
  if (shifter) src.onended = () => setTimeout(shifter.release, 200)
}

export async function speak(phraseId: string, opts?: { rate?: number; pitch?: number; radio?: boolean }) {
  const phrase = voicePresets.phrases.find((p) => p.id === phraseId)
  if (!phrase) throw new Error(`unknown phrase ${phraseId}`)
  const radio = opts?.radio ?? voicePresets.radio.enabled
  const rate = opts?.rate ?? voicePresets.rate
  const pitch = opts?.pitch ?? voicePresets.pitch
  const first = pickLine(phrase)
  const order = [first, ...phrase.lines.filter((line) => line !== first)]
  for (const line of order) {
    try {
      await playClip(voicePresets.voice, line, { radio, rate, pitch })
      lastLine.set(phrase.id, line)
      return
    } catch {
      // Skip a take that has not been generated yet.
    }
  }
}
