import { readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Alarm, TAKES } from './alarm.ts'
import { ContactKind } from './render/radar.ts'

const HORN_S = 2
const LINE_S = 1.5

type FakeBuffer = { url: string; duration: number }

class FakeGain {
  gain = { value: 1 }
  output: unknown = null

  constructor(readonly context: FakeContext) {}

  connect(output: unknown) {
    this.output = output
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null
  output: unknown = null
  started = false
  stopped = false

  connect(output: unknown) {
    this.output = output
  }

  start() {
    this.started = true
  }

  stop() {
    this.stopped = true
  }
}

class FakeContext {
  currentTime = 0
  destination = {}
  gains: FakeGain[] = []
  sources: FakeSource[] = []

  decodeAudioData(data: FakeBuffer) {
    return Promise.resolve(data)
  }

  createGain() {
    const gain = new FakeGain(this)
    this.gains.push(gain)
    return gain
  }

  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }

  played() {
    return this.sources.filter((source) => source.started).map((source) => source.buffer?.url)
  }
}

async function fetchSample(url: string) {
  return { arrayBuffer: async () => ({ url, duration: TAKES.horns.includes(url) ? HORN_S : LINE_S }) }
}

function rolls(...values: number[]) {
  const random = vi.spyOn(Math, 'random')
  for (const value of values) random.mockReturnValueOnce(value)
}

async function connected(alarm = new Alarm()) {
  const context = new FakeContext()
  alarm.connect(context as unknown as AudioContext)
  await new Promise((resolve) => setTimeout(resolve))
  return { alarm, context }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSample)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('alarm', () => {
  it('plays one sample per contact: a horn, or the line for a base or a unit', async () => {
    const { alarm, context } = await connected()
    rolls(0, 0, 0.5, 0, 0.5, 0)
    alarm.sound(ContactKind.Base)
    context.currentTime = 10
    alarm.sound(ContactKind.Base)
    context.currentTime = 20
    alarm.sound(ContactKind.Unit)
    expect(context.played()).toEqual([
      TAKES.horns[0],
      TAKES.lines[ContactKind.Base][0],
      TAKES.lines[ContactKind.Unit][0],
    ])
  })

  it('draws the horn and the line for what was hit equally often, each from every one of its takes', async () => {
    const files = readdirSync(new URL('../../assets/alarm/', import.meta.url))
    const named = (name: string) => files.filter((file) => file.startsWith(`${name}-`))
    const { alarm, context } = await connected()
    const steps = 20
    for (const [kind, line] of [
      [ContactKind.Base, 'base'],
      [ContactKind.Unit, 'unit'],
    ] as const) {
      const from = context.sources.length
      for (let pool = 0; pool < steps; pool++) {
        for (let take = 0; take < steps; take++) {
          rolls(pool / steps, take / steps)
          alarm.sound(kind)
          context.currentTime += HORN_S
        }
      }
      const heard = context.played().slice(from).map((url) => url?.split('/').pop() ?? '')
      expect(heard.filter((file) => file.startsWith('horn-'))).toHaveLength((steps * steps) / 2)
      expect(heard.filter((file) => file.startsWith(`${line}-`))).toHaveLength((steps * steps) / 2)
      expect(new Set(heard)).toEqual(new Set([...named('horn'), ...named(line)]))
    }
    expect(named('horn').length + named('base').length + named('unit').length).toBe(files.length)
  })

  it('never starts over an alarm still sounding', async () => {
    const { alarm, context } = await connected()
    rolls(0.5, 0, 0, 0)
    alarm.sound(ContactKind.Base)
    context.currentTime = LINE_S - 0.1
    alarm.sound(ContactKind.Unit)
    expect(context.played()).toEqual([TAKES.lines[ContactKind.Base][0]])
    context.currentTime = LINE_S
    alarm.sound(ContactKind.Unit)
    expect(context.played()).toEqual([TAKES.lines[ContactKind.Base][0], TAKES.horns[0]])
    context.currentTime = LINE_S + HORN_S - 0.1
    alarm.sound(ContactKind.Unit)
    expect(context.played()).toEqual([TAKES.lines[ContactKind.Base][0], TAKES.horns[0]])
  })

  it('stops a sounding alarm when Sounds is turned off, and plays nothing until it is back on', async () => {
    const { alarm, context } = await connected()
    alarm.sound(ContactKind.Base)
    alarm.setOn(false)
    expect(context.sources.map((source) => source.stopped)).toEqual([true])
    alarm.sound(ContactKind.Unit)
    expect(context.sources).toHaveLength(1)
    alarm.setOn(true)
    alarm.sound(ContactKind.Unit)
    expect(context.sources).toHaveLength(2)
  })

  it('plays through a gain at the Sounds volume, set before audio starts or while an alarm sounds', async () => {
    const alarm = new Alarm()
    alarm.setVolume(0.3)
    const { context } = await connected(alarm)
    const [gain] = context.gains
    expect(gain.gain.value).toBe(0.3)
    expect(gain.output).toBe(context.destination)
    alarm.sound(ContactKind.Base)
    expect(context.sources[0].output).toBe(gain)
    alarm.setVolume(0.65)
    expect(gain.gain.value).toBe(0.65)
  })

  it('stays silent until audio unlocks', () => {
    expect(() => new Alarm().sound(ContactKind.Base)).not.toThrow()
  })
})
