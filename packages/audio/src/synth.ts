// One-shot synthesis primitives. All take an absolute start time `t` (AudioContext seconds).
import { audio, noiseSource, out, send, type NoiseColor } from './core.ts'
import { countVoice } from './profiler.ts'

export const rand = (a: number, b: number) => a + Math.random() * (b - a)
export const vary = (v: number, amt = 0.08) => v * (1 + (Math.random() * 2 - 1) * amt)
export const T = () => audio().currentTime + 0.02

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle'
export type FilterName = 'lowpass' | 'highpass' | 'bandpass' | 'notch'

type Route = { dest?: AudioNode; pan?: number; wet?: number }

export function envelope(param: AudioParam, t: number, { a = 0.002, hold = 0, d = 0.2, peak = 1 } = {}) {
  a = Math.max(a, 0.001)
  d = Math.max(d, 0.001)
  const p = Math.max(peak, 0.0001)
  param.setValueAtTime(0.0001, t)
  param.exponentialRampToValueAtTime(p, t + a)
  param.setValueAtTime(p, t + a + hold)
  param.exponentialRampToValueAtTime(0.0001, t + a + hold + d)
  return t + a + hold + d
}

const curves = new Map<number, Float32Array>()
export function shaper(k: number) {
  const ws = audio().createWaveShaper()
  if (!curves.has(k)) {
    const n = 1024
    const cur = new Float32Array(n)
    const norm = Math.tanh(k)
    for (let i = 0; i < n; i++) cur[i] = Math.tanh(k * (i / (n - 1) * 2 - 1)) / norm
    curves.set(k, cur)
  }
  ws.curve = curves.get(k)! as Float32Array<ArrayBuffer>
  ws.oversample = '2x'
  return ws
}

let ctxDest: AudioNode | null = null
let ctxWet = 1
export function withDest(dest: AudioNode, wetScale: number, fn: () => void) {
  const pd = ctxDest
  const pw = ctxWet
  ctxDest = dest
  ctxWet = wetScale
  try {
    fn()
  } finally {
    ctxDest = pd
    ctxWet = pw
  }
}

function route(node: AudioNode, { dest, pan = 0, wet = 0 }: Route) {
  wet *= ctxWet
  const c = audio()
  let n = node
  if (pan) {
    const p = c.createStereoPanner()
    p.pan.value = pan
    n.connect(p)
    n = p
  }
  n.connect(dest || ctxDest || out())
  if (wet > 0) {
    const g = c.createGain()
    g.gain.value = wet
    n.connect(g)
    g.connect(send())
  }
}

export type BurstOpts = Route & {
  color?: NoiseColor
  filter?: FilterName
  f0?: number
  f1?: number
  q?: number
  a?: number
  hold?: number
  d?: number
  gain?: number
  drive?: number
}

export function burst(t: number, o: BurstOpts = {}) {
  const c = audio()
  const { color = 'white', filter = 'lowpass', f0 = 1000, f1 = f0, q = 0.7, a = 0.002, hold = 0, d = 0.2, gain = 0.5, drive = 0 } = o
  const attack = Math.max(a, 0.001)
  const decay = Math.max(d, 0.001)
  const end = t + attack + hold + decay
  const src = noiseSource(color)
  const flt = c.createBiquadFilter()
  flt.type = filter
  flt.Q.value = q
  const startF = Math.max(1, f0)
  flt.frequency.setValueAtTime(startF, t)
  if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), end)
  const g = c.createGain()
  envelope(g.gain, t, { a: attack, hold, d: decay, peak: gain })
  let n: AudioNode = src.connect(flt)
  if (drive) n = n.connect(shaper(drive))
  n.connect(g)
  route(g, o)
  src.start(t, Math.random() * 1.5)
  src.stop(end + 0.05)
  countVoice(end)
  return end
}

export type ToneOpts = Route & {
  type?: Wave
  f0?: number
  f1?: number
  glide?: number
  detune?: number
  a?: number
  hold?: number
  d?: number
  gain?: number
  filter?: FilterName
  fc?: number
  fcEnd?: number
  fdecay?: number
  q?: number
  drive?: number
  vibrato?: number
  vibratoRate?: number
}

export function tone(t: number, o: ToneOpts = {}) {
  const c = audio()
  const {
    type = 'sine', f0 = 440, f1 = f0, a = 0.002, hold = 0, d = 0.2, gain = 0.3,
    filter, fc = 1000, q = 1, drive = 0, vibrato = 0, vibratoRate = 6,
  } = o
  const attack = Math.max(a, 0.001)
  const decay = Math.max(d, 0.001)
  const end = t + attack + hold + decay
  const glide = o.glide ?? end - t
  const osc = c.createOscillator()
  osc.type = type
  if (o.detune) osc.detune.value = o.detune
  const startF = Math.max(1, f0)
  osc.frequency.setValueAtTime(startF, t)
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + glide)
  if (vibrato) {
    const lfo = c.createOscillator()
    const lg = c.createGain()
    lfo.frequency.value = vibratoRate
    lg.gain.value = vibrato
    lfo.connect(lg).connect(osc.frequency)
    lfo.start(t)
    lfo.stop(end + 0.05)
  }
  let n: AudioNode = osc
  if (filter) {
    const flt = c.createBiquadFilter()
    flt.type = filter
    flt.frequency.setValueAtTime(Math.max(1, fc), t)
    if (o.fcEnd) flt.frequency.exponentialRampToValueAtTime(Math.max(1, o.fcEnd), t + (o.fdecay ?? end - t))
    flt.Q.value = q
    n = n.connect(flt)
  }
  if (drive) n = n.connect(shaper(drive))
  const g = c.createGain()
  envelope(g.gain, t, { a: attack, hold, d: decay, peak: gain })
  n.connect(g)
  route(g, o)
  osc.start(t)
  osc.stop(end + 0.05)
  countVoice(end)
  return end
}

export function scatter(t: number, dur: number, count: number, skew: number, fn: (time: number, i: number) => void) {
  for (let i = 0; i < count; i++) fn(t + Math.pow(Math.random(), skew) * dur, i)
}

export function metal(t: number, { f = 400, d = 1, gain = 0.15, wet = 0.3, dest }: { f?: number; d?: number; gain?: number; wet?: number; dest?: AudioNode } = {}) {
  const ratios = [1, 2.32, 4.25, 6.63, 9.38]
  ratios.forEach((ratio, i) =>
    tone(t, { f0: vary(f * ratio, 0.02), d: d / (1 + i * 0.6), gain: gain / (1 + i), wet, dest }))
  burst(t, { filter: 'bandpass', f0: f * 3, q: 2, d: 0.03, gain: gain * 1.5, dest })
}

export type FmOpts = Route & {
  f?: number
  ratio?: number
  index?: number
  indexEnd?: number
  a?: number
  hold?: number
  d?: number
  gain?: number
}

export function fm(t: number, o: FmOpts = {}) {
  const c = audio()
  const { f = 440, ratio = 2, index = 2, indexEnd = 0.2, a = 0.002, hold = 0, d = 0.5, gain = 0.2 } = o
  const attack = Math.max(a, 0.001)
  const decay = Math.max(d, 0.001)
  const end = t + attack + hold + decay
  const freq = Math.max(1, f)
  const car = c.createOscillator()
  car.frequency.value = freq
  const mod = c.createOscillator()
  mod.frequency.value = freq * ratio
  const mg = c.createGain()
  mg.gain.setValueAtTime(Math.max(0.01, freq * index), t)
  mg.gain.exponentialRampToValueAtTime(Math.max(0.01, freq * indexEnd), end)
  mod.connect(mg).connect(car.frequency)
  const g = c.createGain()
  envelope(g.gain, t, { a: attack, hold, d: decay, peak: gain })
  car.connect(g)
  route(g, o)
  for (const s of [car, mod]) {
    s.start(t)
    s.stop(end + 0.05)
  }
  countVoice(end)
  return end
}
