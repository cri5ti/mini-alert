import { describe, expect, it } from 'vitest'
import { TraceSlot } from '../shared/trace.ts'
import { traceBegin, traceClock, traceCommit, traceDrain, traceEnd, traceReset, traceTally } from './trace.ts'

describe('server tick trace', () => {
  it('keeps nested path time out of the parent and reports idle left in the budget', () => {
    let t = 0
    traceClock(() => t)
    traceReset()
    traceBegin(TraceSlot.Units)
    t = 4
    traceBegin(TraceSlot.Path)
    t = 16
    traceEnd()
    t = 18
    traceEnd()
    const report = traceCommit(20, 33.3, 1)
    traceClock(null)
    const ms = (slot: number) => report?.samples.find((sample) => sample.slot === slot)?.ms ?? 0
    expect(ms(TraceSlot.Path)).toBe(12)
    expect(ms(TraceSlot.Units)).toBe(6)
    expect(ms(TraceSlot.Other)).toBeCloseTo(2, 5)
    expect(ms(TraceSlot.Idle)).toBeCloseTo(13.3, 5)
  })

  it('logs the mean ms per tick of each system with time in it, largest first, and the idle share', () => {
    traceTally({
      samples: [
        { slot: TraceSlot.Ai, ms: 0 },
        { slot: TraceSlot.Units, ms: 5 },
        { slot: TraceSlot.Path, ms: 2 },
        { slot: TraceSlot.Net, ms: 0.004 },
        { slot: TraceSlot.Other, ms: 0.5 },
        { slot: TraceSlot.Idle, ms: 25 },
      ],
      budget: 40,
    })
    traceTally({
      samples: [
        { slot: TraceSlot.Ai, ms: 0 },
        { slot: TraceSlot.Units, ms: 3 },
        { slot: TraceSlot.Path, ms: 4 },
        { slot: TraceSlot.Net, ms: 0.004 },
        { slot: TraceSlot.Other, ms: 0.3 },
        { slot: TraceSlot.Idle, ms: 23 },
      ],
      budget: 40,
    })
    expect(traceDrain()).toBe('trace units 4.00 ms, path 3.00 ms, other 0.40 ms, idle 60.0%')
  })

  it('logs nothing without a trace report, as with TRACE off', () => {
    expect(traceDrain()).toBeNull()
  })
})
