// Per-unit engine voice. Nodes exist only while it is running.
// off -> starting -> idle <-> moving -> stopping -> off
import engineFile from '../presets/engines.json'
import { audio, noiseSource, type NoiseColor } from './core.ts'
import { measure } from './profiler.ts'
import { burst, rand, shaper, type Wave } from './synth.ts'
import { distanceGain, Spatial } from './spatial.ts'

export type Terrain = {
  label: string
  rumbleF: number
  rumbleG: number
  clank: number
  load: number
  grit: number
}

export type EngineProfile = {
  label: string
  game: string
  domain: 'land' | 'water' | 'air'
  starter: 'crank' | 'turbine'
  alt?: number
  core: {
    wave: Wave
    hz: [number, number]
    lp: [number, number]
    q: number
    drive?: number
    gain: number
    chug?: number
    chugRatio?: number
  }
  noise: {
    color: NoiseColor
    type: BiquadFilterType
    f: [number, number]
    q: number
    gain: [number, number]
    by?: 'rpm' | 'speed'
    swell?: number
  }
  tracks?: { rate: number; f: number; q: number; gain: number }
  rotor?: { rate: [number, number] }
  gears?: number
  accel: number
  decel: number
  startTime: number
  stopTime: number
}

export type EngineFile = {
  units: Record<string, EngineProfile>
  terrains: Record<string, Terrain>
}

export const enginePresets = engineFile as unknown as EngineFile

const NEUTRAL: Terrain = { label: 'Neutral', rumbleF: 1, rumbleG: 1, clank: 1, load: 0, grit: 0 }
const TICK = 0.04
const lerp = (a: number, b: number, x: number) => a + (b - a) * x
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

type Graph = {
  sources: AudioScheduledSourceNode[]
  spatial: Spatial
  bus: GainNode
  osc: OscillatorNode
  lp: BiquadFilterNode
  am: GainNode
  eng: GainNode
  lfo?: OscillatorNode
  nflt: BiquadFilterNode
  ngain: GainNode
  rotor?: OscillatorNode
}

const voices = new Set<EngineVoice>()
let timer: ReturnType<typeof setInterval> | null = null

function tickAll() {
  measure('engines tick', () => {
    const t = audio().currentTime
    for (const v of voices) v.tick(t)
  })
  if (voices.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

function pulseWave(c: AudioContext, duty = 0.12, n = 40) {
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  for (let k = 1; k < n; k++) real[k] = (2 * Math.sin(Math.PI * k * duty)) / (Math.PI * k)
  return c.createPeriodicWave(real, imag)
}

export class EngineVoice {
  readonly p: EngineProfile
  onChange: ((voice: EngineVoice) => void) | null = null
  state = 'off'
  target = 0
  speed = 0
  power = 0
  rpm = 0
  x = 0
  y = 0
  hover = 0
  terrainKey = 'grass'
  terrain: Terrain
  private placedAlt = Number.NaN
  private trackPhase = 0
  private gritPhase = 0
  private n: Graph | null = null

  constructor(profile: EngineProfile) {
    this.p = profile
    this.hover = profile.alt || 0
    this.terrain = profile.domain === 'land' ? enginePresets.terrains.grass : NEUTRAL
  }

  ignite(running = false) {
    if (this.state !== 'off' && this.state !== 'stopping') return
    if (!this.n) this.build()
    if (running) {
      this.power = 1
      this.set(this.target > 0.001 ? 'moving' : 'idle')
      return
    }
    this.set('starting')
    this.starterSound()
  }

  shutdown() {
    if (this.state === 'off' || this.state === 'stopping') return
    this.set('stopping')
  }

  /** Drop the voice immediately. Used when the editor switches units. */
  stop() {
    this.target = 0
    this.speed = 0
    this.power = 0
    this.rpm = 0
    this.set('off')
    this.teardown()
  }

  setSpeed(v: number, synced = false) {
    this.target = clamp01(v)
    if (!synced) return
    const pace = this.pace()
    this.speed = pace
    this.rpm = this.engineRpm(pace)
  }

  setTerrain(key: string) {
    this.terrainKey = key
    if (this.p.domain === 'land') this.terrain = enginePresets.terrains[key] ?? enginePresets.terrains.grass
  }

  setPosition(x: number, y: number, alt = this.hover) {
    this.x = x
    this.y = y
    this.hover = alt
    this.placedAlt = alt
    this.n?.spatial.set(x, y, alt)
  }

  private set(state: string) {
    if (this.state === state) return
    this.state = state
    this.onChange?.(this)
  }

  private build() {
    const c = audio()
    const { p } = this
    const core = p.core
    const nz = p.noise
    const sources: AudioScheduledSourceNode[] = []
    const osc = (type: OscillatorType) => {
      const o = c.createOscillator()
      o.type = type
      sources.push(o)
      return o
    }
    const gain = (v: number) => {
      const g = c.createGain()
      g.gain.value = v
      return g
    }

    const spatial = new Spatial(this.x, this.y, p.alt || 0)
    const bus = gain(1)
    bus.connect(spatial.input)

    const oscNode = osc(core.wave)
    const lp = c.createBiquadFilter()
    lp.Q.value = core.q
    const am = gain(1 - (core.chug || 0) / 2)
    const eng = gain(0)
    let a: AudioNode = oscNode
    if (core.drive) a = a.connect(shaper(core.drive))
    a.connect(lp).connect(am).connect(eng).connect(bus)
    let lfo: OscillatorNode | undefined
    if (core.chug) {
      lfo = osc('triangle')
      lfo.connect(gain(core.chug / 2)).connect(am.gain)
    }

    const src = noiseSource(nz.color)
    sources.push(src)
    const nflt = c.createBiquadFilter()
    nflt.type = nz.type
    nflt.Q.value = nz.q
    const ngain = gain(0)
    let b: AudioNode = src.connect(nflt)
    let rotor: OscillatorNode | undefined
    if (p.rotor) {
      const chop = gain(0.3)
      rotor = c.createOscillator()
      rotor.setPeriodicWave(pulseWave(c))
      sources.push(rotor)
      rotor.connect(gain(0.7)).connect(chop.gain)
      b = b.connect(chop)
    }
    b.connect(ngain).connect(bus)

    const t = c.currentTime
    for (const s of sources) s.start(t)
    this.n = { sources, spatial, bus, osc: oscNode, lp, am, eng, lfo, nflt, ngain, rotor }
    voices.add(this)
    timer ??= setInterval(tickAll, TICK * 1000)
    this.tick(t)
  }

  private teardown() {
    const n = this.n
    if (!n) return
    this.n = null
    voices.delete(this)
    const t = audio().currentTime
    n.bus.gain.setTargetAtTime(0, t, 0.03)
    for (const s of n.sources) s.stop(t + 0.2)
    setTimeout(() => {
      n.bus.disconnect()
      n.spatial.dispose()
    }, 400)
  }

  private pace() {
    return this.target * (1 - this.terrain.load * 0.5)
  }

  private engineRpm(speed: number) {
    const gears = this.p.gears
    let rpm = speed
    if (gears) {
      const x = speed * gears
      const gear = Math.min(Math.floor(x), gears - 1)
      rpm = gear === 0 ? x : 0.35 + 0.65 * (x - gear)
    }
    const running = this.state === 'idle' || this.state === 'moving'
    if (running && this.pace() > speed + 0.02) rpm += 0.15
    rpm += this.terrain.load * speed
    return clamp01(rpm)
  }

  private starterSound() {
    const t = audio().currentTime + 0.02
    const st = this.p.startTime
    const dest = this.n?.bus
    if (!dest) return
    if (this.p.starter === 'crank') {
      const count = Math.max(2, Math.floor((st * 0.5) / 0.11))
      for (let i = 0; i < count; i++)
        burst(t + i * 0.11, { color: 'pink', filter: 'lowpass', f0: 450, d: 0.07, gain: 0.2, drive: 2, dest })
    } else {
      burst(t, { color: 'pink', filter: 'bandpass', f0: 300, f1: 900, q: 1, a: st * 0.6, d: st * 0.4, gain: 0.15, dest })
    }
  }

  tick(now: number) {
    const { p, terrain: ter, n } = this
    if (!n) return
    const dt = TICK

    if (this.state === 'starting') {
      this.power = Math.min(1, this.power + dt / p.startTime)
      if (this.power >= 1) this.set('idle')
    } else if (this.state === 'stopping') {
      this.power = Math.max(0, this.power - dt / p.stopTime)
      if (this.power <= 0) {
        this.speed = 0
        this.rpm = 0
        this.set('off')
        this.teardown()
        return
      }
    }

    const running = this.state === 'idle' || this.state === 'moving'
    const tgt = running ? this.pace() : 0
    const diff = tgt - this.speed
    const rate = diff > 0 ? p.accel : p.decel
    this.speed += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt)

    if (this.state === 'idle' && this.target > 0.001) this.set('moving')
    if (this.state === 'moving' && this.target <= 0.001 && this.speed < 0.01) this.set('idle')

    this.rpm += (this.engineRpm(this.speed) - this.rpm) * 0.25

    const pw = this.power
    const r = this.rpm
    const sp = this.speed
    const core = p.core
    const nz = p.noise
    const set = (param: AudioParam, v: number, tc = 0.06) => param.setTargetAtTime(v, now, tc)
    const alt = this.hover
    if (alt !== this.placedAlt) {
      this.placedAlt = alt
      n.spatial.set(this.x, this.y, alt)
    }

    const f = lerp(core.hz[0], core.hz[1], r) * (0.35 + 0.65 * pw)
    set(n.osc.frequency, Math.max(1, f))
    if (n.lfo && core.chugRatio) set(n.lfo.frequency, Math.max(0.5, f * core.chugRatio))
    set(n.lp.frequency, Math.max(20, lerp(core.lp[0], core.lp[1], r)))
    set(n.lp.Q, Math.max(0.1, core.q))
    set(n.eng.gain, pw * core.gain * (0.7 + 0.3 * r))

    let ng = lerp(nz.gain[0], nz.gain[1], nz.by === 'rpm' ? r : sp) * ter.rumbleG
    if (nz.swell) ng *= 1 - nz.swell / 2 + (nz.swell / 2) * Math.sin(now * 1.9)
    set(n.ngain.gain, pw * ng)
    set(n.nflt.frequency, Math.max(20, lerp(nz.f[0], nz.f[1], r) * ter.rumbleF))
    set(n.nflt.Q, Math.max(0.1, nz.q))
    if (n.rotor && p.rotor) set(n.rotor.frequency, Math.max(0.5, lerp(p.rotor.rate[0], p.rotor.rate[1], r) * pw), 0.15)

    if (sp < 0.01 || distanceGain(this.x, this.y, alt) < 0.03) return
    if (p.tracks) {
      const tr = p.tracks
      this.trackPhase += tr.rate * sp * dt
      while (this.trackPhase >= 1) {
        this.trackPhase -= 1
        burst(now + 0.04 + rand(0, 0.02), {
          filter: 'bandpass',
          f0: tr.f * ter.clank * rand(0.85, 1.15),
          q: tr.q,
          d: rand(0.03, 0.05),
          gain: tr.gain * (0.5 + 0.5 * sp) * rand(0.6, 1),
          dest: n.bus,
        })
      }
    }
    if (ter.grit) {
      this.gritPhase += ter.grit * 30 * sp * dt
      while (this.gritPhase >= 1) {
        this.gritPhase -= 1
        burst(now + 0.04 + rand(0, 0.03), {
          filter: 'highpass',
          f0: rand(2500, 6000),
          d: rand(0.008, 0.02),
          gain: rand(0.02, 0.07) * (0.5 + sp),
          dest: n.bus,
        })
      }
    }
  }
}

export function createEngine(id: string) {
  const profile = enginePresets.units[id]
  if (!profile) throw new Error(`unknown engine ${id}`)
  return new EngineVoice(profile)
}
