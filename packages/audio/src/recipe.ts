// Declarative one-shots. Numbers or [min, max] ranges. The editor writes these presets.
import { burst, fm, metal, tone, T, type FilterName, type Wave } from './synth.ts'
import type { NoiseColor } from './core.ts'

export type Num = number | [number, number]

export type BurstStep = {
  op: 'burst'
  at?: Num
  color?: NoiseColor
  filter?: FilterName
  f0?: Num
  f1?: Num
  q?: Num
  a?: Num
  hold?: Num
  d?: Num
  gain?: Num
  drive?: Num
  wet?: Num
  pan?: Num
}

export type ToneStep = {
  op: 'tone'
  at?: Num
  type?: Wave
  f0?: Num
  f1?: Num
  f1Mul?: Num
  glide?: Num
  detune?: Num
  a?: Num
  hold?: Num
  d?: Num
  gain?: Num
  filter?: FilterName
  fc?: Num
  fcEnd?: Num
  fdecay?: Num
  q?: Num
  drive?: Num
  vibrato?: Num
  vibratoRate?: Num
  wet?: Num
  pan?: Num
}

export type MetalStep = { op: 'metal'; at?: Num; f?: Num; d?: Num; gain?: Num; wet?: Num }
export type FmStep = {
  op: 'fm'
  at?: Num
  f?: Num
  ratio?: Num
  index?: Num
  indexEnd?: Num
  a?: Num
  hold?: Num
  d?: Num
  gain?: Num
  wet?: Num
  pan?: Num
}

export type Leaf = BurstStep | ToneStep | MetalStep | FmStep
export type ScatterStep = { op: 'scatter'; at?: Num; dur: Num; count: number; skew?: number; steps: Leaf[] }
export type RepeatStep = { op: 'repeat'; count: number; every: number; jitter?: number; steps: Step[] }
export type Step = Leaf | ScatterStep | RepeatStep

export type SoundGroup = 'weapon' | 'impact' | 'interface'

export type SoundPreset = {
  id: string
  group: SoundGroup
  label: string
  game: string
  spatial: boolean
  repeatMs?: number
  steps: Step[]
}

function num(v: Num | undefined, fallback: number) {
  if (v == null) return fallback
  if (Array.isArray(v)) {
    const lo = Math.min(v[0], v[1])
    const hi = Math.max(v[0], v[1])
    return lo + Math.random() * (hi - lo)
  }
  return v
}

function opt(v: Num | undefined): number | undefined {
  if (v == null) return undefined
  return num(v, 0)
}

export function playRecipe(steps: readonly Step[], t = T()) {
  for (const step of steps) playStep(step, t)
}

function playStep(step: Step, t0: number) {
  if (step.op === 'repeat') {
    const count = Math.max(1, Math.min(80, step.count))
    let t = t0
    for (let i = 0; i < count; i++) {
      for (const child of step.steps) playStep(child, t)
      const jitter = step.jitter ?? 0
      t += step.every * (1 + (Math.random() * 2 - 1) * jitter)
    }
    return
  }
  if (step.op === 'scatter') {
    const start = t0 + num(step.at, 0)
    const dur = Math.max(0, num(step.dur, 0))
    const skew = step.skew ?? 1
    const count = Math.max(1, Math.min(80, step.count))
    for (let i = 0; i < count; i++) {
      const tt = start + Math.pow(Math.random(), skew) * dur
      for (const child of step.steps) playStep(child, tt)
    }
    return
  }
  const t = t0 + num(step.at, 0)
  if (step.op === 'burst') {
    burst(t, {
      color: step.color,
      filter: step.filter,
      f0: opt(step.f0),
      f1: opt(step.f1),
      q: opt(step.q),
      a: opt(step.a),
      hold: opt(step.hold),
      d: opt(step.d),
      gain: opt(step.gain),
      drive: opt(step.drive),
      wet: opt(step.wet),
      pan: opt(step.pan),
    })
    return
  }
  if (step.op === 'tone') {
    const f0 = opt(step.f0)
    const mul = opt(step.f1Mul)
    const f1 = mul != null && f0 != null ? f0 * mul : opt(step.f1)
    tone(t, {
      type: step.type,
      f0,
      f1,
      glide: opt(step.glide),
      detune: opt(step.detune),
      a: opt(step.a),
      hold: opt(step.hold),
      d: opt(step.d),
      gain: opt(step.gain),
      filter: step.filter,
      fc: opt(step.fc),
      fcEnd: opt(step.fcEnd),
      fdecay: opt(step.fdecay),
      q: opt(step.q),
      drive: opt(step.drive),
      vibrato: opt(step.vibrato),
      vibratoRate: opt(step.vibratoRate),
      wet: opt(step.wet),
      pan: opt(step.pan),
    })
    return
  }
  if (step.op === 'metal') {
    metal(t, { f: opt(step.f), d: opt(step.d), gain: opt(step.gain), wet: opt(step.wet) })
    return
  }
  fm(t, {
    f: opt(step.f),
    ratio: opt(step.ratio),
    index: opt(step.index),
    indexEnd: opt(step.indexEnd),
    a: opt(step.a),
    hold: opt(step.hold),
    d: opt(step.d),
    gain: opt(step.gain),
    wet: opt(step.wet),
    pan: opt(step.pan),
  })
}
