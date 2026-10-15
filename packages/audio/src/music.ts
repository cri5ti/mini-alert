// Procedural mood music. Moods blend a parameter vector; songs fix key, timbre, and form.
// One bar is scheduled a little ahead of the playhead.
import musicFile from '../presets/music.json'
import { audio, out } from './core.ts'
import { KITS } from './drums.ts'
import { ARPS, BASSES, LEADS, PADS, mtof, type ToneOpts } from './instruments.ts'
import { measure, voicesCreated } from './profiler.ts'
import { burst, tone } from './synth.ts'

export type MoodName = 'calm' | 'inquisitive' | 'exciting' | 'anxious' | 'defeated'
export type Context = 'lobby' | 'battle' | 'defeat'

export type Mood = {
  tempo: number
  bright: number
  pad: number
  bass: number
  arp: number
  lead: number
  drums: number
  stacc: number
  tension: number
  pulse: number
  prog: number[][]
}

export type Section = {
  pad: number
  arp: number
  lead: number
  bass: number
  drums: number
  energy: number
  fade?: boolean
}

export type Groove = { kick: number[]; kickHi: number[]; snare: number[]; hat: number }

export type Song = {
  title: string
  roles: Context[]
  root: number
  tempoMul: number
  modeBias: number
  swing: number
  inst: { lead: string; arp: string; pad: string; bass: string; kit: string }
  leadOct: number
  arpStyle: 'updown' | 'up' | 'broken' | 'pedal'
  bassStyle: 'root' | 'pulse' | 'octave' | 'walking'
  groove: string
  hook: number[]
  bridge: number[]
  intro: number
  body: [string, number][]
  outro: number
  passes: number
}

export type MusicFile = {
  transition: number
  mixes: Record<Context, Partial<Record<MoodName, number>>>
  moods: Record<MoodName, Mood>
  sections: Record<string, Section>
  grooves: Record<string, Groove>
  songs: Song[]
}

export const musicPresets = musicFile as unknown as MusicFile

const MODES: [string, number[]][] = [
  ['phrygian', [0, 1, 3, 5, 7, 8, 10]],
  ['aeolian', [0, 2, 3, 5, 7, 8, 10]],
  ['dorian', [0, 2, 3, 5, 7, 9, 10]],
  ['mixolydian', [0, 2, 4, 5, 7, 9, 10]],
  ['ionian', [0, 2, 4, 5, 7, 9, 11]],
  ['lydian', [0, 2, 4, 6, 7, 9, 11]],
]
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const PARAMS = ['tempo', 'bright', 'pad', 'bass', 'arp', 'lead', 'drums', 'stacc', 'tension', 'pulse'] as const
export const CHANNELS = ['lead', 'arp', 'pad', 'bass', 'drums'] as const
export type Channel = (typeof CHANNELS)[number]

const mod = (a: number, n: number) => ((a % n) + n) % n
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

function blend(weights: Partial<Record<MoodName, number>>) {
  const names = Object.keys(musicPresets.moods) as MoodName[]
  let sum = names.reduce((s, k) => s + (weights[k] ?? 0), 0)
  const w = sum < 0.01 ? Object.fromEntries(names.map((k) => [k, 1])) as Record<MoodName, number> : weights
  if (sum < 0.01) sum = names.length
  const p = {} as Record<(typeof PARAMS)[number], number>
  for (const k of PARAMS) p[k] = names.reduce((s, n) => s + ((w[n] ?? 0) / sum) * musicPresets.moods[n][k], 0)
  return p
}

function seeded(str: string) {
  let a = 2166136261
  for (let i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(arr: readonly T[], r: () => number = Math.random) => arr[Math.floor(r() * arr.length)]

type MotifNote = { step: number; deg: number; gap?: number }

function makeMotif(r: () => number, density: number) {
  const notes: MotifNote[] = []
  let deg = pick([0, 2, 4], r)
  for (let s = 0; s < 32; s++) {
    const prob = s % 4 === 0 ? 0.55 : s % 2 === 0 ? 0.3 : 0.08
    if (r() > prob * (0.4 + density)) continue
    deg = Math.max(-2, Math.min(9, deg + pick([-2, -1, -1, 0, 1, 1, 2], r)))
    if (s % 8 === 0) deg = Math.round(deg / 2) * 2
    notes.push({ step: s, deg })
  }
  return withGaps(notes)
}

function mutate(motif: MotifNote[]) {
  const notes = motif
    .filter((_, i) => i === 0 || Math.random() > 0.1)
    .map((n) => ({ ...n, deg: Math.random() < 0.25 ? n.deg + pick([-1, 1]) : n.deg }))
  return withGaps(notes)
}

function withGaps(notes: MotifNote[]) {
  return notes.map((n, i) => ({ ...n, gap: (notes[i + 1]?.step ?? 32) - n.step }))
}

type PlanSlot = { section: string; bar: number; bars: number; pass: number }
type BarEvent = { ch: string; t: number; dur: number; midi: number }
export type MusicBar = {
  index: number
  start: number
  dur: number
  chord: string
  mode: string
  section: string
  pass: number
  song: string
  songIndex?: number
  planIndex?: number
  mood: string
  events: BarEvent[]
  params: Record<string, number>
}

export class MusicGen {
  target: Partial<Record<MoodName, number>> = {}
  weights: Partial<Record<MoodName, number>> = {}
  params = blend({})
  transition = musicPresets.transition
  context: Context = 'battle'
  muted: Partial<Record<Channel, boolean>> = {}
  playing = false
  bars: MusicBar[] = []
  barIndex = 0
  songIndex = 0
  loopSong = false
  queued: number | null = null
  plan: PlanSlot[] = []
  planPos = 0
  onSong: ((music: MusicGen) => void) | null = null
  lastBarVoices = 0
  private motifs: Record<string, MotifNote[]> = {}
  private bus: Partial<Record<Channel, GainNode>> | null = null
  private nextBar = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private scale: number[] = MODES[4][1]
  private prog: number[] = [0, 0, 0, 0]
  private progFrom = ''
  private motif: MotifNote[] = []

  constructor() {
    this.applyMix('battle', true)
    this.loadSong(this.pickSong())
  }

  get song() {
    return musicPresets.songs[this.songIndex]
  }

  setMood(name: MoodName, v: number) {
    this.target[name] = v
  }

  applyMix(name: Context, immediate = false) {
    const mix = musicPresets.mixes[name] ?? {}
    for (const k of Object.keys(musicPresets.moods) as MoodName[]) {
      this.target[k] = mix[k] ?? 0
      if (immediate) this.weights[k] = this.target[k]
    }
    if (immediate) this.params = blend(this.target)
  }

  setContext(name: Context) {
    this.context = name
    this.applyMix(name, !this.playing)
    if (this.playing && this.song && !this.allows(this.song)) this.queueSong(this.pickSong(this.songIndex))
    this.onSong?.(this)
  }

  allows(song: Song) {
    if (this.context === 'defeat') return true
    return song.roles.includes(this.context)
  }

  /** A track for this room. Skips the one playing when another one fits. */
  pickSong(avoid = -1) {
    const songs = musicPresets.songs
    const fitting: number[] = []
    const others: number[] = []
    for (let i = 0; i < songs.length; i++) {
      if (!this.allows(songs[i])) continue
      fitting.push(i)
      if (i !== avoid) others.push(i)
    }
    const pool = others.length > 0 ? others : fitting
    if (pool.length === 0) return 0
    return pool[Math.floor(Math.random() * pool.length)]
  }

  setMute(ch: Channel, muted: boolean) {
    this.muted[ch] = muted
    const bus = this.bus?.[ch]
    if (bus) bus.gain.setTargetAtTime(muted ? 0 : 1, audio().currentTime, 0.05)
  }

  start() {
    if (this.playing) return
    const c = audio()
    const bus: Partial<Record<Channel, GainNode>> = {}
    for (const ch of CHANNELS) {
      const g = c.createGain()
      g.gain.value = this.muted[ch] ? 0 : 1
      g.connect(out())
      bus[ch] = g
    }
    this.bus = bus
    this.playing = true
    this.nextBar = c.currentTime + 0.1
    if (!this.allows(this.song)) this.songIndex = this.pickSong()
    this.loadSong(this.songIndex)
    this.timer = setInterval(() => this.pump(), 50)
  }

  stop() {
    if (!this.playing) return
    this.playing = false
    this.queued = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const t = audio().currentTime
    const buses = this.bus
    if (!buses) return
    for (const g of Object.values(buses)) g?.gain.setTargetAtTime(0, t, 0.3)
    setTimeout(() => Object.values(buses).forEach((g) => g?.disconnect()), 3000)
  }

  loadSong(i: number) {
    this.songIndex = i
    const s = this.song
    if (!s) return
    this.motifs = {}
    this.plan = []
    const push = (section: string, bars: number, pass: number) => {
      for (let bar = 0; bar < bars; bar++) this.plan.push({ section, bar, bars, pass })
    }
    if (s.intro) push('intro', s.intro, 0)
    for (let pass = 0; pass < s.passes; pass++) for (const [sec, bars] of s.body) push(sec, bars, pass)
    push('outro', s.outro, 0)
    this.planPos = 0
    this.onSong?.(this)
  }

  queueSong(i: number) {
    if (!this.playing) {
      this.loadSong(i)
      return
    }
    this.queued = i
    if (this.plan[this.planPos]?.section !== 'outro') {
      this.plan = this.plan.slice(0, this.planPos)
      for (let bar = 0; bar < 2; bar++) this.plan.push({ section: 'outro', bar, bars: 2, pass: 0 })
    }
    this.onSong?.(this)
  }

  nextSongIndex() {
    if (this.queued != null) {
      const q = this.queued
      this.queued = null
      return q
    }
    if (this.loopSong) return this.songIndex
    return this.pickSong(this.songIndex)
  }

  status() {
    const bar = this.bars[this.bars.length - 1]
    if (!this.playing || !bar) return 'Stopped'
    return `${bar.song} · ${bar.section} · ${bar.chord} ${bar.mode} · ${Math.round(bar.params.tempo)} bpm`
  }

  private pump() {
    const t = audio().currentTime
    while (this.nextBar < t + 0.5) {
      const v0 = voicesCreated()
      measure('music bar gen', () => this.genBar(this.nextBar))
      this.lastBarVoices = voicesCreated() - v0
    }
    const cutoff = t - 30
    this.bars = this.bars.filter((b) => b.start + b.dur > cutoff)
  }

  private ease(dt: number) {
    const a = 1 - Math.exp(-dt / Math.max(0.1, this.transition))
    for (const k of Object.keys(musicPresets.moods) as MoodName[]) {
      const target = this.target[k] ?? 0
      this.weights[k] = (this.weights[k] ?? 0) + (target - (this.weights[k] ?? 0)) * a
    }
    const tgt = blend(this.target)
    for (const k of PARAMS) this.params[k] += (tgt[k] - this.params[k]) * a
  }

  private midi(deg: number, octave: number) {
    const song = this.song
    return song.root + 12 * (octave + Math.floor(deg / 7)) + this.scale[mod(deg, 7)]
  }

  private chordName(deg: number) {
    const sc = this.scale
    const iv = (k: number) => mod(sc[mod(deg + k, 7)] - sc[mod(deg, 7)], 12)
    const q = iv(2) === 4 ? '' : iv(4) === 6 ? 'dim' : 'm'
    return NOTE_NAMES[mod(this.song.root + sc[mod(deg, 7)], 12)] + q
  }

  private pickProg(slot: PlanSlot) {
    const s = this.song
    switch (slot.section) {
      case 'intro':
      case 'chorus':
        this.progFrom = 'hook'
        return s.hook
      case 'bridge':
        this.progFrom = 'bridge'
        return s.bridge
      case 'outro':
        this.progFrom = 'hook'
        return [s.hook[0], s.hook[3], 0, 0]
    }
    const names = Object.keys(musicPresets.moods) as MoodName[]
    const total = names.reduce((sum, k) => sum + (this.weights[k] ?? 0), 0) || 1
    let roll = Math.random() * total
    let mood: MoodName = names[0]
    for (const k of names) {
      roll -= this.weights[k] ?? 0
      if (roll <= 0) {
        mood = k
        break
      }
    }
    this.progFrom = mood
    return pick(musicPresets.moods[mood].prog)
  }

  private motifFor(slot: PlanSlot) {
    const key = slot.section
    const cached = this.motifs[key]
    if (!cached) return (this.motifs[key] = makeMotif(seeded(this.song.title + key), this.params.lead))
    if (slot.pass > 0 && key !== 'chorus') return (this.motifs[key] = mutate(cached))
    return cached
  }

  private genBar(t0: number) {
    const bus = this.bus
    const song = this.song
    if (!bus || !song) {
      this.nextBar = t0 + 1
      return
    }
    const p = this.params
    const tempo = p.tempo * song.tempoMul
    const barDur = 240 / tempo
    this.ease(barDur)

    if (this.planPos >= this.plan.length) {
      this.bars.push({
        index: this.barIndex++, start: t0, dur: barDur, chord: '—', mode: '', section: 'next song',
        pass: 0, song: song.title, mood: '', events: [], params: { ...p, tempo },
      })
      this.loadSong(this.nextSongIndex())
      this.nextBar = t0 + barDur
      return
    }

    const planIndex = this.planPos++
    const slot = this.plan[planIndex]
    const S = musicPresets.sections[slot.section]
    if (!S) {
      this.nextBar = t0 + barDur
      return
    }
    const step = barDur / 16
    const swing = (s: number) => (s % 4 === 2 ? song.swing * step : 0)
    const at = (s: number) => t0 + s * step + swing(s)

    const mode = MODES[Math.max(0, Math.min(MODES.length - 1, Math.round(p.bright * 5 + song.modeBias)))]
    this.scale = mode[1]
    if (slot.bar % 4 === 0) this.prog = this.pickProg(slot)
    if (slot.bar === 0) this.motif = this.motifFor(slot)
    const deg = this.prog[slot.bar % 4] ?? 0
    const lastBarOfSection = slot.bar === slot.bars - 1

    const events: BarEvent[] = []
    const bar: MusicBar = {
      index: this.barIndex++, start: t0, dur: barDur, chord: this.chordName(deg), mode: mode[0],
      section: slot.section, pass: slot.pass, song: song.title, songIndex: this.songIndex, planIndex,
      mood: this.progFrom, events, params: { ...p, tempo },
    }
    const ev = (ch: string, t: number, dur: number, midi: number) => events.push({ ch, t, dur, midi })

    const fade = S.fade ? 1 - (0.7 * (slot.bar + 1)) / slot.bars : 1
    const energy = S.energy + (slot.pass > 0 ? 0.15 : 0)
    const lvl: Record<Channel, number> = { lead: 0, arp: 0, pad: 0, bass: 0, drums: 0 }
    for (const ch of CHANNELS) {
      const sectionLevel = S[ch]
      lvl[ch] = sectionLevel > 0 ? clamp01((p[ch] * sectionLevel + energy * 0.3) * fade) : 0
    }

    const chord = [deg, deg + 2, deg + 4]
    if (p.tension > 0.5) chord.push(deg + 6)
    const I = song.inst
    const o: ToneOpts = { bright: p.bright }

    if (lvl.pad > 0.05) {
      const pad = PADS[I.pad]
      if (pad) for (const d of chord) {
        const m = this.midi(d, 1)
        pad(t0, m, barDur, lvl.pad, bus.pad!, o)
        ev('pad', t0, barDur, m)
      }
    }

    const pulse = S.pad > 0 ? clamp01(p.pulse * (0.6 + 0.4 * S.drums) * fade) : 0
    if (pulse > 0.1 && bus.pad) {
      for (let s = 0; s < 16; s += pulse > 0.5 ? 1 : 2) {
        const m = this.midi(deg, 0) + (s % 8 === 6 ? 12 : 0)
        const accent = s % 4 === 0
        tone(at(s), {
          type: 'sawtooth', f0: mtof(m), d: step * 0.6, gain: (accent ? 0.06 : 0.035) * pulse,
          filter: 'lowpass', fc: 900 + 1500 * pulse, q: 2, dest: bus.pad,
        })
        ev('pad', at(s), step * 0.6, m)
      }
    }

    if (lvl.bass > 0.05 && bus.bass) {
      const eighths = [0, 2, 4, 6, 8, 10, 12, 14]
      let notes: number[][]
      switch (song.bassStyle) {
        case 'pulse':
          notes = eighths.map((s) => [s, deg, 1.5])
          break
        case 'octave':
          notes = eighths.map((s, i) => [s, i % 2 ? deg + 7 : deg, 1.5])
          break
        case 'walking': {
          const next = this.prog[(slot.bar + 1) % 4] ?? deg
          notes = [[0, deg, 3.5], [4, deg + 2, 3.5], [8, deg + 4, 3.5], [12, next + (next > deg ? -1 : 1), 3.5]]
          break
        }
        default:
          notes = [[0, deg, 3.5], [6, deg, 1.5], [8, deg + 4, 3.5], [14, deg + 4, 1.5]]
      }
      if (lvl.bass < 0.4) notes = notes.filter(([s]) => s % 8 === 0).map(([s, d]) => [s, d, 7])
      const bass = BASSES[I.bass]
      if (bass) for (const [s, d, lenSteps] of notes) {
        const m = this.midi(d, -1)
        const len = lenSteps * step * (1 - 0.4 * p.stacc)
        bass(at(s), m, len, lvl.bass, bus.bass, o)
        ev('bass', at(s), len, m)
      }
    }

    if (lvl.arp > 0.05 && bus.arp) {
      const seq = [...chord, ...chord.map((d) => d + 7)]
      const patterns = {
        updown: [...seq, ...seq.slice(1, -1).reverse()],
        up: seq,
        broken: seq.flatMap((d, i) => (i + 2 < seq.length ? [d, seq[i + 2]] : [d])),
        pedal: chord.flatMap((d) => [deg + 7, d]),
      }
      const pattern = patterns[song.arpStyle]
      const every = lvl.arp > 0.75 ? 1 : 2
      const arp = ARPS[I.arp]
      let k = 0
      if (arp) for (let s = 0; s < 16; s += every) {
        if (Math.random() > 0.35 + 0.65 * lvl.arp) continue
        const m = this.midi(pattern[k++ % pattern.length], 1)
        const len = step * every * (2.5 - 2 * p.stacc)
        arp(at(s), m, len, lvl.arp, bus.arp, { ...o, pan: s % 4 < 2 ? -0.3 : 0.3 })
        ev('arp', at(s), len, m)
      }
    }

    if (lvl.lead > 0.05 && bus.lead) {
      const half = slot.bar % 2
      const harmony = slot.pass > 0 && slot.section === 'chorus'
      const lead = LEADS[I.lead]
      if (lead) for (const n of this.motif) {
        if (Math.floor(n.step / 16) !== half) continue
        const len = (n.gap ?? 1) * step * (1 - 0.7 * p.stacc) + 0.02
        const t = at(n.step % 16)
        const voices: [number, number][] = harmony ? [[n.deg, 1], [n.deg - 2, 0.5]] : [[n.deg, 1]]
        for (const [d, g] of voices) {
          const m = this.midi(deg + d, song.leadOct)
          lead(t, m, len, g * lvl.lead, bus.lead, o)
          ev('lead', t, len, m)
        }
      }
    }

    const d = lvl.drums
    const drums = bus.drums
    if (d > 0.05 && drums) {
      const gr = musicPresets.grooves[song.groove]
      const kit = KITS[I.kit]
      if (gr && kit) {
        const g = Math.sqrt(d)
        for (const s of d > 0.6 ? gr.kickHi : d > 0.15 ? gr.kick : [0]) {
          kit.kick(at(s), g, drums)
          ev('drums', at(s), step, 0)
        }
        if (d > 0.35) gr.snare.forEach((s, i) => {
          const acc = i === 0 || gr.snare.length < 3 ? 1 : 0.5
          kit.snare(at(s), g * acc, drums)
          ev('drums', at(s), step, 1)
        })
        if (d > 0.5 && (p.tension > 0.6 || d > 0.85)) for (const s of [7, 10, 15]) {
          kit.snare(at(s), g * 0.25, drums)
          ev('drums', at(s), step, 1)
        }
        if (d > 0.25) {
          const every = Math.max(1, d > 0.75 ? gr.hat / 2 : gr.hat)
          for (let s = 0; s < 16; s += every) {
            kit.hat(at(s), g, drums, s % 4 === 2)
            ev('drums', at(s), step, 2)
          }
        }
        if (slot.section === 'chorus' && slot.bar === 0 && d > 0.3) kit.crash(t0, g, drums)
        if (d > 0.55 && lastBarOfSection && slot.section !== 'outro') for (const s of [12, 13, 14, 15]) {
          kit.tom(at(s), g, drums, s - 12)
          ev('drums', at(s), step, 3)
        }
      }
    }
    if (p.drums < 0.2 && p.pad > 0.6 && slot.bar % 4 === 3 && drums)
      burst(t0, { color: 'brown', filter: 'lowpass', f0: 150, a: barDur * 0.8, d: 0.6, gain: 0.25 * fade, wet: 0.5, dest: drums })

    this.bars.push(bar)
    this.nextBar = t0 + barDur
  }
}

export const music = new MusicGen()
