// Shared AudioContext, master chain, reverb send, and noise buffers.
import spaceFile from '../presets/space.json'
import { liveVoices } from './profiler.ts'

export type Space = {
  master: number
  reverb: number
  refDistance: number
  rolloff: number
  maxDistance: number
  airDistance: number
  listenerHeight: number
  panning: PanningModelType
}

export const space = spaceFile as Space

let ctx: AudioContext | null = null
let master: GainNode
let reverbIn: GainNode
let reverbOut: GainNode
let analyser: AnalyserNode
const noiseBuffers: Partial<Record<NoiseColor, AudioBuffer>> = {}
const readyHooks: (() => void)[] = []

export type NoiseColor = 'white' | 'pink' | 'brown'

export function whenAudioReady(fn: () => void) {
  readyHooks.push(fn)
  if (ctx) fn()
}

export function audio() {
  if (!ctx) init()
  if (ctx!.state === 'suspended') void ctx!.resume()
  return ctx!
}

export const now = () => audio().currentTime
export const out = () => (audio(), master)
export const send = () => (audio(), reverbIn)
export const getAnalyser = () => analyser
export const audioStarted = () => ctx !== null

export function setMasterVolume(v: number) {
  audio()
  master.gain.setTargetAtTime(v, ctx!.currentTime, 0.02)
}

export function setReverb(v: number) {
  audio()
  reverbOut.gain.setTargetAtTime(v, ctx!.currentTime, 0.02)
}

export function audioLoadText() {
  if (!ctx) return 'Audio idle'
  return `${liveVoices(ctx.currentTime)} voices`
}

function init() {
  ctx = new AudioContext({ latencyHint: 'interactive' })

  master = ctx.createGain()
  master.gain.value = space.master

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -10
  comp.knee.value = 6
  comp.ratio.value = 6
  comp.attack.value = 0.003
  comp.release.value = 0.25

  analyser = ctx.createAnalyser()
  analyser.fftSize = 2048

  master.connect(comp)
  comp.connect(analyser)
  analyser.connect(ctx.destination)

  const conv = ctx.createConvolver()
  conv.buffer = impulse(3.5, 3)
  const dark = ctx.createBiquadFilter()
  dark.type = 'lowpass'
  dark.frequency.value = 3500
  reverbIn = ctx.createGain()
  reverbOut = ctx.createGain()
  reverbOut.gain.value = space.reverb
  reverbIn.connect(conv)
  conv.connect(dark)
  dark.connect(reverbOut)
  reverbOut.connect(master)

  for (const color of ['white', 'pink', 'brown'] as const) noiseBuffers[color] = makeNoise(color)
  for (const fn of readyHooks) fn()
}

function impulse(seconds: number, decay: number) {
  const len = Math.floor(ctx!.sampleRate * seconds)
  const buf = ctx!.createBuffer(2, len, ctx!.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  return buf
}

function makeNoise(color: NoiseColor, seconds = 2) {
  const len = Math.floor(ctx!.sampleRate * seconds)
  const buf = ctx!.createBuffer(1, len, ctx!.sampleRate)
  const d = buf.getChannelData(0)
  if (color === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  } else if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
  } else {
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      d[i] = last * 3.5
    }
  }
  return buf
}

export function noiseSource(color: NoiseColor = 'white') {
  const src = audio().createBufferSource()
  src.buffer = noiseBuffers[color]!
  src.loop = true
  return src
}
