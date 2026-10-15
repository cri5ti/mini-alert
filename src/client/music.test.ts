import { afterEach, describe, expect, it, vi } from 'vitest'
import { BATTLE, Music } from './music.ts'

class FakeAudio {
  static made: FakeAudio[] = []
  volume = 1

  constructor() {
    FakeAudio.made.push(this)
  }

  addEventListener() {}
}

class FakeNode {
  output: unknown = null

  connect(output: unknown) {
    this.output = output
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 }
}

class FakeContext {
  destination = {}
  gains: FakeGain[] = []
  sources = new Map<unknown, FakeNode>()

  createGain() {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  createMediaElementSource(element: unknown) {
    const source = new FakeNode()
    this.sources.set(element, source)
    return source
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudio.made = []
})

describe('music', () => {
  it('rotates every track but the lobby ones through a match', () => {
    expect(BATTLE.map((url) => url.split('/').pop()).sort()).toEqual(['cymbal1.mp3', 'final-countdown.mp3', 'vroom-vroom-tancul.mp3'])
  })

  it('plays at the Music volume on the element until audio unlocks, then through a gain with the element at full volume', () => {
    vi.stubGlobal('Audio', FakeAudio)
    const music = new Music()
    const [element] = FakeAudio.made
    music.setVolume(0.25)
    expect(element.volume).toBe(0.25)
    const context = new FakeContext()
    music.connect(context as unknown as AudioContext)
    const [gain] = context.gains
    expect(context.sources.get(element)?.output).toBe(gain)
    expect(gain.output).toBe(context.destination)
    expect([gain.gain.value, element.volume]).toEqual([0.25, 1])
    music.setVolume(0.6)
    expect([gain.gain.value, element.volume]).toEqual([0.6, 1])
  })
})
