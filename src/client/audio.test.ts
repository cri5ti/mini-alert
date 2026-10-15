import { afterEach, describe, expect, it, vi } from 'vitest'
import { unlockAudio } from './audio.ts'

class FakeContext {
  static made: FakeContext[] = []
  state = 'suspended'
  resumes = 0

  constructor() {
    FakeContext.made.push(this)
  }

  resume() {
    this.resumes += 1
    this.state = 'running'
    return Promise.resolve()
  }
}

function gestures() {
  const listeners = new Map<string, () => void>()
  return {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    dispatch: (type: string) => listeners.get(type)?.(),
  }
}

function output() {
  const contexts: unknown[] = []
  return { contexts, connect: (context: unknown) => contexts.push(context) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeContext.made = []
})

describe('audio', () => {
  it('opens one context for every output on the release of a touch or on a key, and resumes it until it runs', () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const music = output()
    const alarm = output()
    const target = gestures()
    unlockAudio(target, [music, alarm])
    target.dispatch('pointerdown')
    expect(FakeContext.made).toHaveLength(0)
    target.dispatch('pointerup')
    const [context] = FakeContext.made
    expect(context.resumes).toBe(1)
    context.state = 'suspended'
    target.dispatch('keydown')
    target.dispatch('pointerup')
    expect(context.resumes).toBe(2)
    expect(FakeContext.made).toHaveLength(1)
    expect([music.contexts, alarm.contexts]).toEqual([[context], [context]])
  })

  it('stays shut without Web Audio', () => {
    const music = output()
    const target = gestures()
    unlockAudio(target, [music])
    expect(() => target.dispatch('pointerup')).not.toThrow()
    expect(music.contexts).toEqual([])
  })
})
