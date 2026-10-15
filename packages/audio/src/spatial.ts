// World (x, y) -> audio (x, z). Altitude -> audio y.
// Distances are game tiles. refDistance is where a source is still full volume.
import { audio, audioStarted, out, space, whenAudioReady } from './core.ts'
import { withDest } from './synth.ts'

export const listener = { x: 0, y: 0, h: space.listenerHeight, yaw: 0 }

const panners = new Set<PannerNode>()
let zoomGain = 1
let world: GainNode | null = null

function worldOut() {
  if (!world) {
    world = audio().createGain()
    world.gain.value = zoomGain
    world.connect(out())
  }
  return world
}

/** Zoom 1 keeps the current level. Closer is louder, farther is quieter. */
export function setZoom(zoom: number) {
  const z = zoom > 0 ? zoom : 1
  zoomGain = Math.min(1.8, Math.max(0.35, z ** 0.55))
  if (!world || !audioStarted()) return
  world.gain.setTargetAtTime(zoomGain, audio().currentTime, 0.08)
}

export function setPanningModel(m: PanningModelType) {
  space.panning = m
  for (const p of panners) p.panningModel = m
}

export function applySpace() {
  for (const p of panners) {
    p.refDistance = space.refDistance
    p.rolloffFactor = space.rolloff
    p.maxDistance = space.maxDistance
  }
}

function applyListener() {
  const c = audio()
  const l = c.listener
  const t = c.currentTime
  const yaw = listener.yaw
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  if (l.positionX) {
    l.positionX.setTargetAtTime(listener.x, t, 0.03)
    l.positionY.setTargetAtTime(listener.h, t, 0.03)
    l.positionZ.setTargetAtTime(listener.y, t, 0.03)
    l.forwardX.setTargetAtTime(fx, t, 0.05)
    l.forwardY.setTargetAtTime(0, t, 0.05)
    l.forwardZ.setTargetAtTime(fz, t, 0.05)
    l.upX.setTargetAtTime(0, t, 0.05)
    l.upY.setTargetAtTime(1, t, 0.05)
    l.upZ.setTargetAtTime(0, t, 0.05)
    return
  }
  l.setPosition(listener.x, listener.h, listener.y)
  l.setOrientation(fx, 0, fz, 0, 1, 0)
}

whenAudioReady(applyListener)

export function setListener(x: number, y: number, h: number, yaw = 0) {
  listener.x = x
  listener.y = y
  listener.h = h
  listener.yaw = yaw
  if (audioStarted()) applyListener()
}

export const distanceTo = (x: number, y: number, alt = 0) => Math.hypot(x - listener.x, y - listener.y, listener.h - alt)

export function distanceGain(x: number, y: number, alt = 0) {
  const ref = space.refDistance
  const d = Math.max(distanceTo(x, y, alt), ref)
  return ref / (ref + space.rolloff * (d - ref))
}

export const airCutoff = (x: number, y: number, alt = 0) =>
  Math.min(20000, Math.max(500, 22000 * Math.exp(-distanceTo(x, y, alt) / Math.max(1, space.airDistance))))

export class Spatial {
  readonly input: BiquadFilterNode
  readonly panner: PannerNode

  constructor(x: number, y: number, alt = 0) {
    const c = audio()
    this.input = c.createBiquadFilter()
    this.input.type = 'lowpass'
    const p = (this.panner = c.createPanner())
    p.panningModel = space.panning
    p.distanceModel = 'inverse'
    p.refDistance = space.refDistance
    p.rolloffFactor = space.rolloff
    p.maxDistance = space.maxDistance
    this.input.connect(p).connect(worldOut())
    panners.add(p)
    this.set(x, y, alt, true)
  }

  set(x: number, y: number, alt = 0, immediate = false) {
    const p = this.panner
    const cut = airCutoff(x, y, alt)
    if (immediate) {
      p.positionX.value = x
      p.positionY.value = alt
      p.positionZ.value = y
      this.input.frequency.value = cut
    } else {
      const t = audio().currentTime
      p.positionX.setTargetAtTime(x, t, 0.03)
      p.positionY.setTargetAtTime(alt, t, 0.03)
      p.positionZ.setTargetAtTime(y, t, 0.03)
      this.input.frequency.setTargetAtTime(cut, t, 0.1)
    }
  }

  dispose(delay = 0) {
    const panner = this.panner
    const input = this.input
    setTimeout(() => {
      input.disconnect()
      panner.disconnect()
      panners.delete(panner)
    }, delay * 1000)
  }
}

export function playAt(x: number, y: number, fn: (t: number) => void, { alt = 0, life = 16 } = {}) {
  const c = audio()
  const s = new Spatial(x, y, alt)
  withDest(s.input, 0.35 + 0.65 * distanceGain(x, y, alt), () => fn(c.currentTime + 0.02))
  s.dispose(life)
}
